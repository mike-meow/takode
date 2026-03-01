import { randomUUID } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  realpathSync,
} from "node:fs";
import {
  mkdir,
  access,
  copyFile,
  cp,
  readFile,
  writeFile,
  unlink,
  symlink,
  lstat,
} from "node:fs/promises";

const execPromise = promisify(execCb);
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Subprocess } from "bun";
import type { SessionStore } from "./session-store.js";
import type { BackendType } from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import { CodexAdapter } from "./codex-adapter.js";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";
import { containerManager } from "./container-manager.js";
import {
  getLegacyCodexHome,
  resolveCompanionCodexSessionHome,
} from "./codex-home.js";
import { sessionTag } from "./session-tag.js";

/** Check if a file exists (async equivalent of existsSync). */
async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function sanitizeSpawnArgsForLog(args: string[]): string {
  const secretKeyPattern = /(token|key|secret|password)/i;
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "-e" && i + 1 < out.length) {
      const envPair = out[i + 1];
      const eqIdx = envPair.indexOf("=");
      if (eqIdx > 0) {
        const k = envPair.slice(0, eqIdx);
        if (secretKeyPattern.test(k)) {
          out[i + 1] = `${k}=***`;
        }
      }
    }
  }
  return out.join(" ");
}

export interface SdkSessionInfo {
  sessionId: string;
  /** Monotonic integer ID assigned at runtime (not persisted — regenerated on restart) */
  sessionNum?: number;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  /** Epoch ms of last user or CLI activity (used by idle manager) */
  lastActivityAt?: number;
  /** The CLI's internal session ID (from system.init), used for --resume */
  cliSessionId?: string;
  archived?: boolean;
  /** Epoch ms when this session was archived */
  archivedAt?: number;
  /** User-facing session name */
  name?: string;
  /** Which backend this session uses */
  backendType?: BackendType;
  /** Git branch from bridge state (enriched by REST API) */
  gitBranch?: string;
  /** Git ahead count (enriched by REST API) */
  gitAhead?: number;
  /** Git behind count (enriched by REST API) */
  gitBehind?: number;
  /** Total lines added (enriched by REST API) */
  totalLinesAdded?: number;
  /** Total lines removed (enriched by REST API) */
  totalLinesRemoved?: number;
  /** Whether internet/web search is enabled for Codex sessions */
  codexInternetAccess?: boolean;
  /** Sandbox mode selected for Codex sessions */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Reasoning effort selected for Codex sessions (e.g. low/medium/high). */
  codexReasoningEffort?: string;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** Set by idle manager before killing — lets the UI show a less alarming indicator */
  killedByIdleManager?: boolean;
  /** Whether --resume has already been retried once after a fast exit */
  resumeRetried?: boolean;

  // Worktree fields
  /** Whether this session uses a git worktree */
  isWorktree?: boolean;
  /** The original repo root path */
  repoRoot?: string;
  /** Conceptual branch this session is working on (what user selected) */
  branch?: string;
  /** Actual git branch in the worktree (may differ for -wt-N branches) */
  actualBranch?: string;

  /** Whether this is an assistant-mode session */
  isAssistant?: boolean;
  /** Whether this is an orchestrator session (has takode CLI access) */
  isOrchestrator?: boolean;
  /** Session UUID of the leader that has herded this worker (single leader per session) */
  herdedBy?: string;
  /** Env profile slug used at creation, for re-resolving env vars on relaunch */
  envSlug?: string;
  /** One-shot: resume-session-at UUID for revert (cleared after use) */
  resumeAt?: string;

  // Container fields
  /** Docker container ID when session runs inside a container */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
}

export interface LaunchOptions {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  backendType?: BackendType;
  /** Codex sandbox mode. */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Whether Codex internet/web search should be enabled for this session. */
  codexInternetAccess?: boolean;
  /** Codex reasoning effort (e.g. low/medium/high). */
  codexReasoningEffort?: string;
  /** Optional override for CODEX_HOME used by Codex sessions. */
  codexHome?: string;
  /** Docker container ID — when set, CLI runs inside container via docker exec */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
  /** Pre-resolved worktree info from the session creation flow */
  worktreeInfo?: {
    isWorktree: boolean;
    repoRoot: string;
    branch: string;
    actualBranch: string;
    worktreePath: string;
  };
  /** CLI session ID to resume (from an external CLI session, e.g. VS Code or terminal) */
  resumeCliSessionId?: string;
}

/**
 * Manages CLI backend processes (Claude Code via --sdk-url WebSocket,
 * or Codex via app-server stdio).
 */
export class CliLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, Subprocess>();
  /** Runtime-only env vars per session (kept out of persisted launcher state). */
  private sessionEnvs = new Map<string, Record<string, string>>();
  private port: number;
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  private onCodexAdapter: ((sessionId: string, adapter: CodexAdapter) => void) | null = null;
  private exitHandlers: ((sessionId: string, exitCode: number | null) => void)[] = [];
  private settingsGetter: (() => { claudeBinary: string; codexBinary: string }) | null = null;
  /** Callback to resolve env profile variables by slug (set by server bootstrap). */
  private envResolver: ((slug: string) => Promise<Record<string, string> | null>) | null = null;

  /** Callback when herd relationships change (set by server bootstrap). */
  onHerdChanged: ((orchId: string) => void) | null = null;

  // ─── Integer session ID tracking ───────────────────────────────────────────
  private nextSessionNum = 0;
  /** UUID → integer session number */
  private sessionNumMap = new Map<string, number>();
  /** Integer session number → UUID */
  private sessionByNum = new Map<number, string>();

  constructor(port: number) {
    this.port = port;
  }

  /** Get the server port number. */
  getPort(): number {
    return this.port;
  }

  /** Register a callback for when a CodexAdapter is created (WsBridge needs to attach it). */
  onCodexAdapterCreated(cb: (sessionId: string, adapter: CodexAdapter) => void): void {
    this.onCodexAdapter = cb;
  }

  /** Register a callback for when a CLI/Codex process exits. */
  onSessionExited(cb: (sessionId: string, exitCode: number | null) => void): void {
    this.exitHandlers.push(cb);
  }

  /** Attach a persistent store for surviving server restarts. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  /** Attach a settings getter so relaunch() can read current binary settings. */
  setSettingsGetter(fn: () => { claudeBinary: string; codexBinary: string }): void {
    this.settingsGetter = fn;
  }

  /** Attach an env resolver so relaunch() can re-resolve env profiles after restart. */
  setEnvResolver(fn: (slug: string) => Promise<Record<string, string> | null>): void {
    this.envResolver = fn;
  }

  // ─── Integer session ID management ─────────────────────────────────────────

  /** Assign a monotonic integer ID to a session. */
  private assignSessionNum(sessionId: string): number {
    const existing = this.sessionNumMap.get(sessionId);
    if (existing !== undefined) return existing;
    const num = this.nextSessionNum++;
    this.sessionNumMap.set(sessionId, num);
    this.sessionByNum.set(num, sessionId);
    return num;
  }

  /**
   * Resolve a session identifier to a full UUID.
   * Accepts: integer session number, full UUID, or UUID prefix (min 4 chars).
   * Returns null if no match found.
   */
  resolveSessionId(idOrNum: string): string | null {
    // Try integer lookup first
    const num = parseInt(idOrNum, 10);
    if (!isNaN(num) && String(num) === idOrNum) {
      return this.sessionByNum.get(num) ?? null;
    }
    // Exact UUID match
    if (this.sessions.has(idOrNum)) return idOrNum;
    // Prefix match (min 4 chars to avoid ambiguity)
    if (idOrNum.length >= 4) {
      const lower = idOrNum.toLowerCase();
      let match: string | null = null;
      for (const uuid of this.sessions.keys()) {
        if (uuid.toLowerCase().startsWith(lower)) {
          if (match !== null) return null; // ambiguous — multiple matches
          match = uuid;
        }
      }
      return match;
    }
    return null;
  }

  /** Get the integer session number for a UUID. */
  getSessionNum(sessionId: string): number | undefined {
    return this.sessionNumMap.get(sessionId);
  }

  /** Persist launcher state to disk (debounced).
   *  Coalesces rapid calls into a single write. On NFS, each writeFile takes
   *  100-500ms and saturates the libuv threadpool, causing event loop stalls
   *  that break CLI ping/pong (10s timeout). */
  private persistState(): void {
    if (!this.store) return;
    if (this.persistTimer) return; // already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const data = Array.from(this.sessions.values());
      this.store!.saveLauncher(data);
    }, 150);
  }
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Restore sessions from disk and check which PIDs are still alive.
   * Returns the number of recovered sessions.
   */
  async restoreFromDisk(): Promise<number> {
    if (!this.store) return 0;
    const data = await this.store.loadLauncher<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let recovered = 0;
    for (const info of data) {
      if (this.sessions.has(info.sessionId)) continue;

      // Migrate legacy herdedBy array → string (pre-single-leader refactor)
      if (Array.isArray(info.herdedBy)) {
        info.herdedBy = (info.herdedBy as unknown as string[])[0] ?? undefined;
      }

      // Check if the process is still alive
      if (info.pid && info.state !== "exited") {
        try {
          process.kill(info.pid, 0); // signal 0 = just check if alive
          info.state = "starting"; // WS not yet re-established, wait for CLI to reconnect
          this.sessions.set(info.sessionId, info);
          recovered++;
        } catch {
          // Process is dead
          info.state = "exited";
          info.exitCode = -1;
          this.sessions.set(info.sessionId, info);
        }
      } else {
        // Already exited or no PID
        this.sessions.set(info.sessionId, info);
      }
    }
    if (recovered > 0) {
      console.log(`[cli-launcher] Recovered ${recovered} live session(s) from disk`);
    }

    // Restore persisted session numbers, then assign new ones for legacy sessions without them.
    // This ensures integer IDs are stable across restarts — once assigned, they never change.
    const allSessions = Array.from(this.sessions.values());

    // Phase 1: Restore persisted sessionNums and find the max to set nextSessionNum
    let maxNum = -1;
    for (const info of allSessions) {
      if (info.sessionNum !== undefined && info.sessionNum !== null) {
        this.sessionNumMap.set(info.sessionId, info.sessionNum);
        this.sessionByNum.set(info.sessionNum, info.sessionId);
        if (info.sessionNum > maxNum) maxNum = info.sessionNum;
      }
    }
    this.nextSessionNum = maxNum + 1;

    // Phase 2: Assign new numbers to sessions that don't have one yet (legacy/pre-migration)
    const sorted = allSessions
      .filter(s => s.sessionNum === undefined || s.sessionNum === null)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const info of sorted) {
      info.sessionNum = this.assignSessionNum(info.sessionId);
    }
    if (sorted.length > 0) {
      // Persist the newly assigned numbers so they're stable on next restart
      this.persistState();
    }
    console.log(`[cli-launcher] Session numbers: ${allSessions.length} total, ${sorted.length} newly assigned, next=#${this.nextSessionNum}`);

    return recovered;
  }

  /**
   * Merge launcher data from disk into existing in-memory sessions.
   * Used after import to pick up cliSessionId and rewritten paths
   * without clobbering active session state (connected sockets, PIDs, etc.).
   */
  async mergeFromDisk(): Promise<number> {
    if (!this.store) return 0;
    const data = await this.store.loadLauncher<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let merged = 0;
    for (const info of data) {
      const existing = this.sessions.get(info.sessionId);
      if (!existing) continue; // handled by restoreFromDisk

      let changed = false;
      // Merge cliSessionId (critical for --resume after import)
      if (info.cliSessionId && !existing.cliSessionId) {
        existing.cliSessionId = info.cliSessionId;
        changed = true;
      }
      // Merge rewritten cwd (import rewrites paths for new machine)
      if (info.cwd && info.cwd !== existing.cwd) {
        existing.cwd = info.cwd;
        changed = true;
      }
      // Merge rewritten repoRoot
      if (info.repoRoot && info.repoRoot !== existing.repoRoot) {
        existing.repoRoot = info.repoRoot;
        changed = true;
      }
      if (changed) merged++;
    }
    if (merged > 0) {
      this.persistState();
      console.log(`[cli-launcher] Merged ${merged} session(s) from import`);
    }
    return merged;
  }

  /**
   * Launch a new CLI session (Claude Code or Codex).
   */
  async launch(options: LaunchOptions = {}): Promise<SdkSessionInfo> {
    const sessionId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const backendType = options.backendType || "claude";

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      permissionMode: options.permissionMode,
      cwd,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      backendType,
    };

    if (backendType === "codex") {
      info.codexInternetAccess = options.codexInternetAccess === true;
      info.codexSandbox = options.codexSandbox;
      info.codexReasoningEffort = options.codexReasoningEffort;
    }

    // Store container metadata if provided
    if (options.containerId) {
      info.containerId = options.containerId;
      info.containerName = options.containerName;
      info.containerImage = options.containerImage;
    }

    // Store worktree metadata if provided
    if (options.worktreeInfo) {
      info.isWorktree = options.worktreeInfo.isWorktree;
      info.repoRoot = options.worktreeInfo.repoRoot;
      info.branch = options.worktreeInfo.branch;
      info.actualBranch = options.worktreeInfo.actualBranch;
    }

    // Inject backend-specific worktree guardrails.
    if (info.isWorktree && info.branch) {
      await this.injectWorktreeGuardrails(
        info.cwd,
        info.actualBranch || info.branch,
        info.repoRoot || "",
        backendType,
        info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
      );
    }

    // Pre-set cliSessionId for resume so subsequent relaunches also use --resume
    if (options.resumeCliSessionId) {
      info.cliSessionId = options.resumeCliSessionId;
    }

    this.sessions.set(sessionId, info);

    // Assign monotonic integer session number
    info.sessionNum = this.assignSessionNum(sessionId);

    // Always inject COMPANION_SESSION_ID so agents can identify themselves
    const envWithSessionId = { ...options.env, COMPANION_SESSION_ID: sessionId };
    this.sessionEnvs.set(sessionId, envWithSessionId);
    options = { ...options, env: envWithSessionId };

    if (backendType === "codex") {
      this.spawnCodex(sessionId, info, options).catch((err) => {
        console.error(`[cli-launcher] Codex spawn failed for ${sessionTag(sessionId)}:`, err);
      });
    } else {
      this.spawnCLI(sessionId, info, {
        ...options,
        ...(options.resumeCliSessionId ? { resumeSessionId: options.resumeCliSessionId } : {}),
      });
    }
    return info;
  }

  /**
   * Relaunch a CLI process for an existing session.
   * Kills the old process if still alive, then spawns a fresh CLI
   * that connects back to the same session in the WsBridge.
   */
  async relaunch(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };
    const binSettings = this.settingsGetter?.() ?? { claudeBinary: "", codexBinary: "" };

    // Kill old process if still alive
    const oldProc = this.processes.get(sessionId);
    if (oldProc) {
      try {
        oldProc.kill("SIGTERM");
        await Promise.race([
          oldProc.exited,
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}
      this.processes.delete(sessionId);
    } else if (info.pid) {
      // Process from a previous server instance — kill by PID
      try { process.kill(info.pid, "SIGTERM"); } catch {}
    }

    // Pre-flight validation for containerized sessions
    if (info.containerId) {
      const containerLabel = info.containerName || info.containerId.slice(0, 12);
      const containerState = containerManager.isContainerAlive(info.containerId);

      if (containerState === "missing") {
        console.error(`[cli-launcher] Container ${containerLabel} no longer exists for session ${sessionTag(sessionId)}`);
        info.state = "exited";
        info.exitCode = 1;
        this.persistState();
        return {
          ok: false,
          error: `Container "${containerLabel}" was removed externally. Please create a new session.`,
        };
      }

      if (containerState === "stopped") {
        try {
          containerManager.startContainer(info.containerId);
          console.log(`[cli-launcher] Restarted stopped container ${containerLabel} for session ${sessionTag(sessionId)}`);
        } catch (e) {
          info.state = "exited";
          info.exitCode = 1;
          this.persistState();
          return {
            ok: false,
            error: `Container "${containerLabel}" is stopped and could not be restarted: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }

      // Validate the configured CLI binary exists inside the container.
      const configuredBinary = (info.backendType === "codex"
        ? binSettings.codexBinary
        : binSettings.claudeBinary).trim();
      const binary = (configuredBinary || (info.backendType === "codex" ? "codex" : "claude"))
        .split(/\s+/)[0];

      if (!containerManager.hasBinaryInContainer(info.containerId, binary)) {
        console.error(`[cli-launcher] "${binary}" not found in container ${containerLabel} for session ${sessionTag(sessionId)}`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return {
          ok: false,
          error: `"${binary}" command not found inside container "${containerLabel}". The container image may need to be rebuilt.`,
        };
      }
    }

    info.state = "starting";
    info.killedByIdleManager = false;

    console.log(`[cli-launcher] Relaunching session ${sessionTag(sessionId)} (cliSessionId: ${info.cliSessionId || "none"}, state: ${info.state}, backendType: ${info.backendType || "claude"})`);
    this.recorder?.recordServerEvent(sessionId, "cli_relaunch", {
      cliSessionId: info.cliSessionId || null,
      hasResume: !!info.cliSessionId,
      backendType: info.backendType || "claude",
    }, info.backendType || "claude", info.cwd);

    let runtimeEnv = this.sessionEnvs.get(sessionId);

    // After server restart, sessionEnvs is empty (not persisted to disk).
    // Reconstruct essential env vars from persisted SdkSessionInfo fields
    // and re-resolve the env profile if one was used at creation time.
    if (!runtimeEnv) {
      const reconstructed: Record<string, string> = {
        COMPANION_SESSION_ID: sessionId,
        COMPANION_PORT: String(this.port),
      };
      if (info.isOrchestrator) {
        reconstructed.TAKODE_ROLE = "orchestrator";
        reconstructed.TAKODE_API_PORT = String(this.port);
      }
      if (info.envSlug && this.envResolver) {
        const profileVars = await this.envResolver(info.envSlug);
        if (profileVars) Object.assign(reconstructed, profileVars);
      }
      this.sessionEnvs.set(sessionId, reconstructed);
      runtimeEnv = reconstructed;
    }

    try {
      if (info.backendType === "codex") {
        await this.spawnCodex(sessionId, info, {
          model: info.model,
          permissionMode: info.permissionMode,
          cwd: info.cwd,
          codexBinary: binSettings.codexBinary || undefined,
          codexSandbox: info.codexSandbox,
          codexInternetAccess: info.codexInternetAccess,
          codexReasoningEffort: info.codexReasoningEffort,
          containerId: info.containerId,
          containerName: info.containerName,
          containerImage: info.containerImage,
          env: runtimeEnv,
        });
      } else {
        this.spawnCLI(sessionId, info, {
          model: info.model,
          permissionMode: info.permissionMode,
          cwd: info.cwd,
          claudeBinary: binSettings.claudeBinary || undefined,
          resumeSessionId: info.cliSessionId,
          containerId: info.containerId,
          containerName: info.containerName,
          containerImage: info.containerImage,
          env: runtimeEnv,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cli-launcher] Spawn failed during relaunch for session ${sessionTag(sessionId)}: ${msg}`);
      info.state = "exited";
      info.exitCode = 1;
      this.persistState();
      return { ok: false, error: `Failed to spawn process: ${msg}` };
    }

    // spawnCLI may fail silently (marks state="exited" and returns).
    // Re-read state since spawnCLI mutates info as a side effect.
    if ((info.state as string) === "exited") {
      return { ok: false, error: "Failed to spawn process (binary not found)" };
    }
    return { ok: true };
  }

  /**
   * Relaunch a CLI process, truncating conversation history to a specific
   * assistant message UUID via --resume-session-at.
   */
  async relaunchWithResumeAt(sessionId: string, resumeAt: string): Promise<{ ok: boolean; error?: string }> {
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };
    info.resumeAt = resumeAt;
    const result = await this.relaunch(sessionId);
    delete info.resumeAt;
    return result;
  }

  /**
   * Get all sessions in "starting" state (awaiting CLI WebSocket connection).
   */
  getStartingSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "starting");
  }

  private spawnCLI(sessionId: string, info: SdkSessionInfo, options: LaunchOptions & { resumeSessionId?: string }): void {
    const isContainerized = !!options.containerId;

    // For containerized sessions, the CLI binary lives inside the container.
    // For host sessions, resolve the binary on the host.
    let binary = options.claudeBinary || "claude";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    // Allow overriding the host alias used by containerized Claude sessions.
    // Useful when host.docker.internal is unavailable in a given Docker setup.
    const containerSdkHost = (process.env.COMPANION_CONTAINER_SDK_HOST || "host.docker.internal").trim()
      || "host.docker.internal";

    // When running inside a container, the SDK URL should target the host alias
    // so the CLI can connect back to the Hono server running on the host.
    const sdkUrl = isContainerized
      ? `ws://${containerSdkHost}:${this.port}/ws/cli/${sessionId}`
      : `ws://localhost:${this.port}/ws/cli/${sessionId}`;

    // Claude Code rejects bypassPermissions when running with root/sudo. Most
    // container images run as root by default, so downgrade to acceptEdits unless
    // explicitly forced.
    let effectivePermissionMode = options.permissionMode;
    if (
      isContainerized
      && options.permissionMode === "bypassPermissions"
      && process.env.COMPANION_FORCE_BYPASS_IN_CONTAINER !== "1"
    ) {
      console.warn(
        `[cli-launcher] Session ${sessionId}: downgrading container permission mode ` +
        `from bypassPermissions to acceptEdits (set COMPANION_FORCE_BYPASS_IN_CONTAINER=1 to force bypass).`,
      );
      effectivePermissionMode = "acceptEdits";
      info.permissionMode = "acceptEdits";
    }

    const args: string[] = [
      "--sdk-url", sdkUrl,
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (effectivePermissionMode) {
      args.push("--permission-mode", effectivePermissionMode);
    }
    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    // Always pass -p "" for headless mode. When relaunching, also pass --resume
    // to restore the CLI's conversation context.
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
      console.log(`[cli-launcher] Passing --resume ${options.resumeSessionId}`);
    } else {
      console.warn(`[cli-launcher] No cliSessionId — starting fresh session`);
    }
    if (info.resumeAt) {
      args.push("--resume-session-at", info.resumeAt);
    }
    args.push("-p", "");

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run CLI inside the container via docker exec -i.
      // Keeping stdin open avoids premature EOF-driven exits in SDK mode.
      // Environment variables are passed via -e flags to docker exec.
      const dockerArgs = ["docker", "exec", "-i"];

      // Pass env vars via -e flags
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      // Ensure CLAUDECODE is unset inside container
      dockerArgs.push("-e", "CLAUDECODE=");

      dockerArgs.push(options.containerId!);
      // Use a login shell so ~/.bashrc is sourced and nvm/bun/deno/etc are on PATH
      const innerCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      // Host env for the docker CLI itself
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined; // cwd is set inside the container via -w at creation
    } else {
      // Host-based spawn (original behavior)
      spawnCmd = [binary, ...args];
      spawnEnv = {
        ...process.env,
        CLAUDECODE: undefined,
        ...options.env,
        PATH: getEnrichedPath(),
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning session ${sessionTag(sessionId)}${isContainerized ? " (container)" : ""}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(spawnCmd, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cli-launcher] Failed to spawn CLI for session ${sessionTag(sessionId)}: ${msg}`);
      info.state = "exited";
      info.exitCode = 1;
      this.persistState();
      return;
    }

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Stream stdout/stderr for debugging
    this.pipeOutput(sessionId, proc);

    // Monitor process exit
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      const uptime = Date.now() - spawnedAt;
      console.log(`[cli-launcher] Session ${sessionTag(sessionId)} exited (code=${exitCode}, uptime=${uptime}ms)`);
      this.recorder?.recordServerEvent(sessionId, "cli_exit", {
        exitCode, uptime, hadResume: !!options.resumeSessionId,
      }, info.backendType || "claude", info.cwd);

      // Guard against stale exits: if a new process was already spawned
      // (e.g. relaunch timeout), this exit belongs to the old process.
      if (this.processes.get(sessionId) !== proc) {
        console.log(`[cli-launcher] Ignoring stale exit for session ${sessionTag(sessionId)}`);
        return;
      }

      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;

        // If the process exited almost immediately with --resume, the resume likely failed.
        if (uptime < 5000 && options.resumeSessionId) {
          if (!session.resumeRetried) {
            // First failure: retry once (the CLI might have been killed mid-write)
            console.warn(`[cli-launcher] --resume failed (${uptime}ms), retrying once...`);
            session.resumeRetried = true;
            // Don't clear cliSessionId — relaunch will retry with --resume
          } else {
            // Second failure: give up and start fresh
            console.error(`[cli-launcher] --resume failed twice. Clearing cliSessionId for fresh start.`);
            session.cliSessionId = undefined;
            session.resumeRetried = false;
          }
        }
      }
      this.processes.delete(sessionId);
      this.persistState();
      for (const handler of this.exitHandlers) {
        try { handler(sessionId, exitCode); } catch {}
      }
    });

    this.persistState();
  }

  /**
   * Spawn a Codex app-server subprocess for a session.
   * Unlike Claude Code (which connects back via WebSocket), Codex uses stdio.
   */
  /** Check if a path exists (async). */
  private async pathExists(p: string): Promise<boolean> {
    try { await access(p); return true; } catch { return false; }
  }

  /**
   * Prepare the Codex home directory with user-level artifacts.
   * Uses async fs operations to avoid blocking the event loop on NFS.
   */
  private async prepareCodexHome(codexHome: string): Promise<void> {
    await mkdir(codexHome, { recursive: true });

    const legacyHome = getLegacyCodexHome();
    if (resolve(legacyHome) === resolve(codexHome) || !(await this.pathExists(legacyHome))) {
      return;
    }

    // Bootstrap only the user-level artifacts Codex needs (auth/config/skills),
    // while intentionally skipping sessions/sqlite to avoid stale rollout indexes.
    const fileSeeds = ["auth.json", "config.toml", "models_cache.json", "version.json"];
    for (const name of fileSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!(await this.pathExists(dest)) && await this.pathExists(src)) {
          await copyFile(src, dest);
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name} from legacy home:`, e);
      }
    }

    const dirSeeds = ["skills", "vendor_imports", "prompts", "rules"];
    for (const name of dirSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!(await this.pathExists(dest)) && await this.pathExists(src)) {
          await cp(src, dest, { recursive: true });
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name}/ from legacy home:`, e);
      }
    }
  }

  private async spawnCodex(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): Promise<void> {
    const isContainerized = !!options.containerId;

    let binary = options.codexBinary || "codex";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    const args: string[] = ["app-server"];
    const internetEnabled = options.codexInternetAccess === true;
    args.push("-c", `tools.webSearch=${internetEnabled ? "true" : "false"}`);
    if (options.codexReasoningEffort) {
      args.push("-c", `model_reasoning_effort=${options.codexReasoningEffort}`);
    }
    const codexHome = resolveCompanionCodexSessionHome(
      sessionId,
      options.codexHome,
    );
    if (!isContainerized) {
      await this.prepareCodexHome(codexHome);
    }

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run Codex inside the container via docker exec -i (stdin required for JSON-RPC)
      const dockerArgs = ["docker", "exec", "-i"];
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      dockerArgs.push("-e", "CLAUDECODE=");
      // Point Codex at /root/.codex where container-manager seeded auth/config
      dockerArgs.push("-e", "CODEX_HOME=/root/.codex");
      dockerArgs.push(options.containerId!);
      // Use a login shell so ~/.bashrc is sourced and nvm/bun/deno/etc are on PATH
      const innerCmd = [binary, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined;
    } else {
      // Host-based spawn — resolve node/shebang issues
      // The codex binary is a Node.js script with `#!/usr/bin/env node` shebang.
      // When Bun.spawn executes it, the kernel resolves `node` via /usr/bin/env
      // which may find the system Node (e.g. v12) instead of the nvm-managed one.
      // To guarantee the correct Node version, we resolve the `node` binary that
      // lives alongside `codex` and spawn `node <codex.js>` directly.
      const binaryDir = resolve(binary, "..");
      const siblingNode = join(binaryDir, "node");
      const companionBinDir = join(homedir(), ".companion", "bin");
      const bunBinDir = join(homedir(), ".bun", "bin");
      const enrichedPath = getEnrichedPath();
      const spawnPath = [binaryDir, companionBinDir, bunBinDir, ...enrichedPath.split(":")].filter(Boolean).join(":");

      if (existsSync(siblingNode)) { // sync-ok: session launch, not called during message handling
        let codexScript: string;
        try {
          codexScript = realpathSync(binary);
        } catch {
          codexScript = binary;
        }
        spawnCmd = [siblingNode, codexScript, ...args];
      } else {
        spawnCmd = [binary, ...args];
      }

      spawnEnv = {
        ...process.env,
        CLAUDECODE: undefined,
        ...options.env,
        CODEX_HOME: codexHome,
        PATH: spawnPath,
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning Codex session ${sessionTag(sessionId)}${isContainerized ? " (container)" : ""}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(spawnCmd, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cli-launcher] Failed to spawn Codex for session ${sessionTag(sessionId)}: ${msg}`);
      info.state = "exited";
      info.exitCode = 1;
      this.persistState();
      throw err;
    }

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stderr for debugging (stdout is used for JSON-RPC)
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    // Create the CodexAdapter which handles JSON-RPC and message translation
    // Pass the raw permission mode — the adapter maps it to Codex's approval policy
    const adapter = new CodexAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      approvalMode: options.permissionMode,
      threadId: info.cliSessionId,
      sandbox: options.codexSandbox,
      reasoningEffort: options.codexReasoningEffort,
      recorder: this.recorder ?? undefined,
    });

    // Handle init errors — mark session as exited so UI shows failure.
    // Also clear cliSessionId so the next relaunch starts a fresh thread
    // instead of trying to resume one whose rollout may be missing.
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex session ${sessionTag(sessionId)} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    if (this.onCodexAdapter) {
      this.onCodexAdapter(sessionId, adapter);
    }

    // Mark as connected immediately (no WS handshake needed for stdio)
    info.state = "connected";

    // Monitor process exit
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Codex session ${sessionTag(sessionId)} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
      for (const handler of this.exitHandlers) {
        try { handler(sessionId, exitCode); } catch {}
      }
    });

    this.persistState();
  }

  /**
   * Inject worktree branch guardrails into backend-appropriate instruction files.
   * Claude: .claude/CLAUDE.md
   * Codex: AGENTS.md (worktree root)
   *
   * Only injects into actual worktree directories, never the main repo.
   */
  private async injectWorktreeGuardrails(
    worktreePath: string,
    branch: string,
    repoRoot: string,
    backendType: BackendType,
    parentBranch?: string,
  ): Promise<void> {
    // Safety: never inject guardrails into the main repository itself
    if (worktreePath === repoRoot) {
      console.warn(`[cli-launcher] Skipping guardrails injection: worktree path is the main repo (${repoRoot})`);
      return;
    }

    // Safety: only inject if the worktree directory actually exists (created by git worktree add)
    if (!(await fileExists(worktreePath))) {
      console.warn(`[cli-launcher] Skipping guardrails injection: worktree path does not exist (${worktreePath})`);
      return;
    }

    const branchLabel = parentBranch
      ? `\`${branch}\` (created from \`${parentBranch}\`)`
      : `\`${branch}\``;
    const syncBaseBranch = parentBranch || branch;

    const MARKER_START = "<!-- WORKTREE_GUARDRAILS_START -->";
    const MARKER_END = "<!-- WORKTREE_GUARDRAILS_END -->";
    const guardrails = `${MARKER_START}
# Worktree Session — Branch Guardrails

You are working on branch: ${branchLabel}
This is a git worktree. The main repository is at: \`${repoRoot}\`

**Rules:**
1. DO NOT run \`git checkout\`, \`git switch\`, or any command that changes the current branch
2. All your work MUST stay on the \`${branch}\` branch
3. When committing, commit to \`${branch}\` only
4. If you need to reference code from another branch, use \`git show other-branch:path/to/file\`

## Porting Commits to the Main Repo

When asked to port/sync commits from this worktree to the main repository at \`${repoRoot}\`, follow this workflow **exactly**:

### Sync Context (Critical)

Use this context for "sync to main repo" requests in this session:
- Base repo checkout: \`${repoRoot}\`
- Base branch: \`${syncBaseBranch}\`

By default, "sync to main repo" means syncing to the base branch above.
Only sync to a different remote branch if the user explicitly names it (for example: \`origin/main\`).

1. **Check the main repo first.** Pull remote changes first: \`git -C ${repoRoot} fetch origin ${syncBaseBranch} && git -C ${repoRoot} pull --rebase origin ${syncBaseBranch}\` (development may happen on multiple machines). Then run \`git -C ${repoRoot} status\` — if there are uncommitted changes, **stop and tell the user** — another agent may have work in progress. Never run \`git reset --hard\`, \`git checkout .\`, or \`git clean\` on the main repo without explicit user approval. Read any new commits briefly to understand what changed since your branch diverged.
2. **Rebase in the worktree.** Rebase your worktree branch onto the main repo's local base branch. Since all worktrees share the same git object store, the main repo's local branch is directly visible as a ref — no fetch needed. Use \`git rebase ${syncBaseBranch}\`. Resolve all merge conflicts here in the worktree — this is the safe place to do it without affecting other agents.
3. **Cherry-pick clean commits to main.** Once the worktree branch is cleanly rebased with your new commits on top, cherry-pick only your new commits into the main repo using \`git -C ${repoRoot} cherry-pick <commit-hash>\`. Cherry-pick one at a time in chronological order.
4. **Handle unexpected conflicts.** If cherry-pick still conflicts (it shouldn't after a clean rebase), tell the user the conflicting files and ask how to proceed. Do not force-resolve or abort without asking.
5. **Verify and push.** Run \`git -C ${repoRoot} log --oneline -5\` to confirm the commits landed correctly, then \`git -C ${repoRoot} push origin ${syncBaseBranch}\` to push to the remote.
6. **Sync both worktree and local main branch.**
   - Reset this worktree branch to match local base branch: \`git reset --hard ${syncBaseBranch}\`.
   - Also fast-forward local base branch in the main repo checkout: \`git -C ${repoRoot} checkout ${syncBaseBranch} && git -C ${repoRoot} merge --ff-only origin/${syncBaseBranch}\`.
7. **Run tests post-merge.** After resetting, run the project's unit tests in the worktree to verify nothing broke from merging with main. If tests fail: (a) if the fix is straightforward, fix it in the worktree, commit, and re-sync following steps 1–6 above; (b) otherwise, explain the failures to the user and ask how to proceed.

### Completion Checklist

Do NOT report the sync as complete until ALL of the following are true:
- [ ] Main repo log shows the cherry-picked commits
- [ ] Worktree has been reset to match the main repo branch
- [ ] Tests have been run **after the reset** AND passed (or failures reported to user)
- [ ] Changes have been pushed to the remote
${MARKER_END}`;

    if (backendType === "claude") {
      const claudeDir = join(worktreePath, ".claude");
      const claudeMdPath = join(claudeDir, "CLAUDE.md");

      try {
        await mkdir(claudeDir, { recursive: true });

        if (await fileExists(claudeMdPath)) {
          const existing = await readFile(claudeMdPath, "utf-8");
          // Replace existing guardrails section or append
          if (existing.includes(MARKER_START)) {
            const before = existing.substring(0, existing.indexOf(MARKER_START));
            const afterIdx = existing.indexOf(MARKER_END);
            const after = afterIdx >= 0 ? existing.substring(afterIdx + MARKER_END.length) : "";
            await writeFile(claudeMdPath, before + guardrails + after, "utf-8");
          } else {
            await writeFile(claudeMdPath, existing + "\n\n" + guardrails, "utf-8");
          }
        } else {
          await writeFile(claudeMdPath, guardrails, "utf-8");
        }
        console.log(`[cli-launcher] Injected worktree guardrails into .claude/CLAUDE.md for branch ${branch}`);

        // Add .claude/CLAUDE.md to the worktree-local git exclude so it doesn't
        // show as untracked and is protected from `git clean -fd`.
        // Worktrees store their git metadata at the path inside .git (a file, not dir).
        await this.addWorktreeGitExclude(worktreePath, ".claude/CLAUDE.md");

        // Mark the file as skip-worktree so git ignores local modifications to this
        // tracked file. Without this, `git status` always shows .claude/CLAUDE.md as
        // modified, which prevents automatic worktree cleanup on archive.
        try {
          await execPromise("git --no-optional-locks update-index --skip-worktree .claude/CLAUDE.md", {
            cwd: worktreePath, timeout: 5000,
          });
        } catch { /* file may not be tracked in this repo — ignore */ }

        // Symlink project settings files so all worktrees for the same repo share
        // the same permission rules. Without this, rules written with
        // destination:"projectSettings" go to the worktree's local copy and aren't
        // visible to other sessions.
        await this.symlinkProjectSettings(worktreePath, repoRoot);
      } catch (e) {
        console.warn(`[cli-launcher] Failed to inject .claude/CLAUDE.md guardrails:`, e);
      }
    }

    if (backendType === "codex") {
      // Codex auto-discovers AGENTS.md by walking from git root to cwd.
      // If AGENTS.md is a symlink (commonly to CLAUDE.md), materialize a real
      // worktree-local AGENTS.md so Codex-specific instructions live in AGENTS.md.
      const agentsMdPath = join(worktreePath, "AGENTS.md");
      try {
        let existing = "";
        if (await fileExists(agentsMdPath)) {
          const stat = await lstat(agentsMdPath);
          if (stat.isSymbolicLink()) {
            // Read through the symlink first, then replace it with a regular file.
            existing = await readFile(agentsMdPath, "utf-8");
            await unlink(agentsMdPath);
            console.log("[cli-launcher] Replaced symlinked AGENTS.md with worktree-local file");
          } else {
            existing = await readFile(agentsMdPath, "utf-8");
          }
        }
        if (existing.includes(MARKER_START)) {
          const before = existing.substring(0, existing.indexOf(MARKER_START));
          const afterIdx = existing.indexOf(MARKER_END);
          const after = afterIdx >= 0 ? existing.substring(afterIdx + MARKER_END.length) : "";
          await writeFile(agentsMdPath, before + guardrails + after, "utf-8");
        } else {
          await writeFile(agentsMdPath, existing ? (existing + "\n\n" + guardrails) : guardrails, "utf-8");
        }
        console.log(`[cli-launcher] Injected worktree guardrails into AGENTS.md for branch ${branch}`);

        await this.addWorktreeGitExclude(worktreePath, "AGENTS.md");
        try {
          await execPromise("git --no-optional-locks update-index --skip-worktree AGENTS.md", {
            cwd: worktreePath, timeout: 5000,
          });
        } catch { /* file may not be tracked in this repo — ignore */ }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to inject AGENTS.md guardrails:`, e);
      }
    }
  }

  /**
   * Inject orchestrator identity and instructions into .claude/CLAUDE.md.
   * Uses marker-based injection (same pattern as worktree guardrails).
   * Called before CLI launch when body.role === "orchestrator".
   */
  async injectOrchestratorGuardrails(cwd: string, port: number): Promise<void> {
    const ORCH_START = "<!-- ORCHESTRATOR_GUARDRAILS_START -->";
    const ORCH_END = "<!-- ORCHESTRATOR_GUARDRAILS_END -->";

    const guardrails = `${ORCH_START}
# Takode — Cross-Session Orchestration

You are an **orchestrator agent**. You coordinate multiple worker sessions, monitor their progress, and decide when to intervene, send follow-up instructions, or notify the human.

## Environment

- \`TAKODE_ROLE=orchestrator\` — confirms you have orchestration privileges
- \`TAKODE_API_PORT=\${port}\` — the Companion server port (used automatically by the CLI)
- \`COMPANION_SESSION_ID\` — your own session ID
- The \`takode\` command is available at \`~/.companion/bin/takode\` (or on PATH)
- Works with both **Claude Code** and **Codex** sessions — the CLI talks to the Companion server, not to any backend directly

## Commands

### \`takode list [--active] [--all] [--json]\`

List sessions. For leaders, the default view shows only herded sessions (your flock). Use \`--active\` to see all unarchived sessions (for discovery/triage), or \`--all\` to include archived.

\`\`\`bash
# Show herded sessions only (leader default)
takode list

# Show all unarchived sessions (discover sessions to herd)
takode list --active

# Show all sessions including archived
takode list --all
\`\`\`

Output format for each session:
- \`#N\` — session number (use in all other commands)
- Status icon: \`●\` running, \`○\` idle, \`✗\` disconnected, \`⊘\` archived, \`⚠\` needs attention
- Session name and role labels: \`[leader]\` for orchestrators, \`[herd]\` for herded workers
- \`📋 q-N status\` — claimed quest ID and status (if any)
- Branch name with \`N↑\` commits ahead / \`N↓\` commits behind the base branch
- \`wt\` — worktree session indicator
- Last activity timestamp and message preview

### \`takode search <query> [--all] [--json]\`

Search sessions by name, keyword, task title, branch, message, or path.

\`\`\`bash
# Search for sessions related to "auth"
takode search auth

# Search including archived sessions
takode search jwt --all
\`\`\`

Searches across: session name, task history titles, auto-extracted keywords, git branch, last message preview, working directory, and repo root.

### \`takode watch --sessions <ids> [--timeout <secs>] [--since <cursor>] [--all-events] [--json]\`

Block and wait for actionable events from specific sessions. Returns when events arrive or timeout (default 120s).

By default, only actionable events are shown (things a human would be notified about). Use \`--all-events\` to include intermediate events.

\`\`\`bash
# Watch sessions #1 and #2 (actionable events only)
takode watch --sessions 1,2

# Watch with longer timeout
takode watch --sessions 1,2,3 --timeout 300

# Resume from last event cursor
takode watch --sessions 1,2 --since 42

# Include ALL events (turn_start, permission_resolved, etc.)
takode watch --sessions 1,2 --all-events
\`\`\`

**Drain-then-block behavior**: If events arrived since your last \`watch\`, they're returned immediately as a batch. Otherwise, blocks until the next event or timeout.

**Default actionable events**:
| Event | Meaning |
|---|---|
| \`turn_end\` | Worker finished generating. Shows tools used and result preview. |
| \`permission_request\` | Worker needs human approval (only fires after auto-approval defers). |
| \`quest_update\` | A quest was updated (any session). |
| \`session_disconnected\` | Worker CLI disconnected. |
| \`session_error\` | Worker turn ended with an error. |
| \`user_message\` | New user message arrived in a watched session. |

**\`--sessions\` is required.** Always specify which sessions you're watching. Use \`takode list\` first to discover session numbers.

### \`takode tasks <session> [--json]\`

Show the task outline (table of contents) for a session's conversation history. Tasks are automatically detected by the session auto-namer and quest system.

\`\`\`bash
takode tasks 1
\`\`\`

Output shows each task with its title, start time, and message ID range:
\`\`\`
  #  Started   Task                                              Msg Range
  ──────────────────────────────────────────────────────────────────────────────
   1  07:13     Explore existing CLI for session interaction       [0]-[36]
   2  07:36     Design cross-session orchestration system          [37]-[98]
   3  08:23     Refine design with user feedback                   [99]-[420]
\`\`\`

Use the message ranges with \`takode peek <session> --from <msg-id>\` to browse a specific task, or use \`takode peek <session> --task <n>\` as a shortcut.

**Tip:** Run \`takode tasks\` first when investigating an unfamiliar session — it gives you a high-level map of what the agent has been working on, organized by task boundaries.

### \`takode peek <session> [--from N] [--count N] [--detail --turns N] [--json]\`

View session activity with progressive detail. Three modes:

**Default mode** (smart overview):
\`\`\`bash
takode peek 1
\`\`\`
Shows a smart overview: recent completed turns as collapsed one-liners (with stats and result preview), plus the last turn expanded with up to 10 messages. This is your primary monitoring command — covers broad context with minimal tokens.

Output includes:
- **Total turn/message count** and message ID range
- **Collapsed turns** — one line each: turn number, time range, tool count, success indicator, result preview
- **Expanded last turn** — full messages with \`[N]\` IDs, timestamps, tool tree, result
- **Omission counts** when earlier turns or messages are hidden

**Range browsing** (paged history):
\`\`\`bash
# Browse messages starting at index 500
takode peek 1 --from 500

# Browse 50 messages from index 500
takode peek 1 --from 500 --count 50
\`\`\`
Shows ~30 messages around the given index with full detail and turn boundaries. Output includes prev/next hints for continued browsing. Use this to navigate backwards through a session's history.

**Detail mode** (legacy full detail):
\`\`\`bash
# Full detail on last 3 turns
takode peek 1 --detail --turns 3
\`\`\`

#### Navigation workflow

\`\`\`
1. takode tasks 1              → Table of contents: tasks with msg ranges
2. takode peek 1               → Overview: collapsed turns + expanded last turn
3. takode peek 1 --task 3      → Browse task 3's messages
4. takode peek 1 --from 800    → Browse messages [800]-[830] in detail
5. takode read 1 815           → Full content of message 815
\`\`\`

### \`takode read <session> <msg-id> [--offset N] [--limit N] [--json]\`

Read full content of a specific message, with line numbers and pagination.

\`\`\`bash
# Read message #42 from session #1
takode read 1 42

# Paginate through a long message
takode read 1 42 --offset 0 --limit 50
takode read 1 42 --offset 50 --limit 50
\`\`\`

This works exactly like the Read tool for files — line numbers on the left, offset/limit for pagination. Use this when \`peek\` shows a truncated message you need to see in full.

### \`takode send <session> <message>\`

Send a message to a **herded** worker session (injected as a user message).
**Requires herding first** — run \`takode herd <session>\` before you can send.

\`\`\`bash
# First, herd the session
takode herd 2

# Then send instructions
takode send 2 "Please also add tests for the edge cases"
\`\`\`

The worker will receive this as if the human typed it. It triggers a new turn.

## Orchestration Workflow — Push-Based Event Delivery

### How events work

You do NOT need to call \`takode watch\`. The server automatically delivers events from your herded sessions.

When workers in your herd have noteworthy events (finished a turn, need permission, hit an error, disconnected), the events accumulate while you're busy. When you finish your current turn and go idle, all accumulated events arrive as a single user message.

### Message sources

Every user message you receive has a source tag:
- **\`[User HH:MM]\`** — a message from the human operator
- **\`[Herd HH:MM]\`** — an automatic event summary from your herded sessions
- **\`[Agent #N name HH:MM]\`** — a message sent by another agent session (via \`takode send\`)

### Reacting to herd events

When you receive a \`[Herd]\` message, it contains a compact event table:

\`\`\`
3 events from 2 sessions

#5 auth-module | turn_end | ✓ 12.3s | tools: Edit(3), Bash(2) | [4700]-[4750] | q-42: in_progress → needs_verification | "Added JWT validation middleware"
#5 auth-module | permission_request | Bash: rm -rf /tmp/old-cache
#7 api-tests   | user_message [User] | "Please also add integration tests"
\`\`\`

**Event format details:**
- **turn_end** includes: success/error/interrupted indicator, duration, tool counts, message range \`[from]-[to]\` (use with \`takode peek <session> --from <N>\`), quest status changes, and result preview
- **user_message** includes: sender source tag — \`[User]\` (human), \`[Agent #N name]\` (another agent), or \`[Herd]\` (herd event echo)
- **permission_request** includes: tool name and description (only fires when auto-approval defers to human)

For each event, decide what to do:

- **\`turn_end\` (✓ success)**: Peek at the output (\`takode peek <session> --from <range-start>\`), then send follow-up work or mark as done
- **\`turn_end\` (✗ error)**: Peek at recent turns, diagnose, send recovery instructions
- **\`turn_end\` (⊘ interrupted)**: The user stopped this agent — check if it needs to be restarted with different instructions
- **\`permission_request\`**: If it's an \`AskUserQuestion\` or \`ExitPlanMode\`, you can answer it with \`takode answer\` (see below). Tool permissions (\`Bash\`, \`Edit\`, etc.) are human-only — leave those for the UI.
- **\`permission_resolved\`**: A pending permission was approved or denied — the worker is unblocked and running again
- **\`session_error\`**: The worker hit a fatal error — investigate and decide whether to retry
- **\`user_message [User]\`**: A human sent a message to a worker — may indicate new instructions or priority changes

### Progressive information reveal

To protect your context window during long orchestration:

1. **Start with \`peek\`** — see the compact summary first
2. **Drill into specific messages with \`read\`** — only when the summary isn't enough
3. **Paginate long messages** — use \`--offset\`/\`--limit\` just like reading files

### Answering worker questions and plans

When a worker asks a question (\`AskUserQuestion\`) or submits a plan (\`ExitPlanMode\`), you can answer directly:

\`\`\`bash
# See what's pending
takode pending <session>

# Answer a question (pick option by number or provide free text)
takode answer <session> 1           # pick option 1
takode answer <session> "custom answer"

# Approve or reject a plan
takode answer <session> approve
takode answer <session> reject "please add error handling"
\`\`\`

**Important**: Only answer when you have high confidence and enough context. For complex decisions, tell the human to review in the browser UI. Tool permission requests (\`Bash\`, \`Edit\`, etc.) cannot be answered — those are human-only.

### Stopping workers

You can gracefully stop a herded worker session:

\`\`\`bash
takode stop <session>
\`\`\`

This sends SIGTERM to the worker's CLI process. Only works for sessions you've herded. Use this for task reassignment or when a worker is stuck.

### Coordinate with quests

Use the \`quest\` CLI alongside \`takode\` for task tracking:

\`\`\`bash
# Check what quests are in progress
quest list --status in_progress

# After a worker finishes, transition the quest
quest transition q-42 --status needs_verification

# Leave feedback on a quest
quest feedback q-42 --text "Auth implementation looks good, but needs rate limiting"
\`\`\`

## Session Identification

Commands accept multiple formats for session IDs:
- **Integer number**: \`1\`, \`3\`, \`5\` — the short form from \`takode list\`
- **UUID prefix**: \`abc123\` — first chars of the full UUID
- **Full UUID**: \`550e8400-e29b-41d4-a716-446655440000\`

Prefer integer numbers — they're stable within a server session and easy to type.

## Worker Capabilities

Herded worker sessions have the same tools and skills you do — including the \`quest\` CLI, project CLAUDE.md/AGENTS.md, and any configured skills (e.g. playwright-e2e-tester). **Don't duplicate their work by fetching quest details yourself and pasting them into messages.** Instead, give workers the quest ID and a brief description of what to do — they can run \`quest show q-XX\` themselves to get full details, verification items, feedback, and images.

Good: \`"Work on q-70. Address the unaddressed human feedback — rename the dismiss button to Later and add an Inbox button."\`
Bad: \`"Here are the full quest details: [300 lines of quest JSON pasted in]..."\`

## Tips

- **Coordinate, don't implement.** Never do non-trivial work yourself (anything requiring more than a few reads/edits). Delegate larger work to a herded worker session via \`takode send\`, or spin up a sub-agent for smaller tasks. This protects your context window and keeps you responsive to herd events and user requests. Your job is coordination, not implementation.
- **One task at a time per worker.** Never send an unrelated new task to a worker that is currently busy. When you have a new task for a busy worker, add it to your own todo list and wait for the worker's \`turn_end\` event. Only after the worker finishes and goes idle should you send the next task from your queue. It IS okay to send mid-work messages that steer the *current* task — e.g., refining scope, adding a requirement, or correcting a misunderstanding. Urgent interventions ("stop, critical bug found") are also fine. The rule is: don't send *unrelated* new tasks to a busy worker. This prevents workers from being distracted, dropping current tasks, or burning context window on queued instructions they might forget.
- **Always use async sub-agents.** When spinning up sub-agents via the Task tool, always use \`run_in_background: true\`. Synchronous sub-agents block your turn and prevent you from receiving and reacting to herd events or user messages until they complete.
- **Keep your watch loop tight.** Process each event, decide quickly, and go back to watching. Don't do heavy computation between events.
- **Use \`--json\` for programmatic decisions.** When you need to branch on event data, parse JSON output instead of text.
- **Don't micro-manage workers.** Send clear instructions and let them work. Only intervene on errors or when they finish a major step.
- **Batch related messages.** If you need to send context + instructions to a worker, send it as one message rather than multiple.
- **Don't worry about worker context windows.** Workers auto-compact their context when it gets large — you can't see or control this. Don't avoid assigning work to a session just because it has many turns. Prefer \`peek\` (truncated) over \`read\` (full) to protect your *own* context window.
- **Track event cursors.** When using \`watch --since\`, pass the last event ID to avoid re-processing events.
- **Mixed backends work seamlessly.** You can orchestrate both Claude Code and Codex sessions from either backend. The \`takode\` CLI talks to the Companion server, so the worker's backend is transparent to you.
- **Events are push-based.** You don't need to poll or call \`watch\`. Herd events arrive automatically as user messages when you go idle. Just react to them.
- **\`takode watch\` still exists** for advanced use cases (debugging, manual monitoring outside the herd system), but you should not need it for normal orchestration.
${ORCH_END}`;

    const claudeDir = join(cwd, ".claude");
    const claudeMdPath = join(claudeDir, "CLAUDE.md");

    await mkdir(claudeDir, { recursive: true });

    try {
      const existing = await readFile(claudeMdPath, "utf-8");
      // Replace existing orchestrator guardrails or append
      const startIdx = existing.indexOf(ORCH_START);
      const endIdx = existing.indexOf(ORCH_END);
      if (startIdx >= 0 && endIdx >= 0) {
        const before = existing.slice(0, startIdx);
        const after = existing.slice(endIdx + ORCH_END.length);
        await writeFile(claudeMdPath, before.trimEnd() + "\n\n" + guardrails + "\n" + after.trimStart());
      } else {
        await writeFile(claudeMdPath, existing.trimEnd() + "\n\n" + guardrails + "\n");
      }
    } catch {
      // File doesn't exist — create with just guardrails
      await writeFile(claudeMdPath, guardrails + "\n");
    }

    console.log(`[cli-launcher] Injected orchestrator guardrails into ${claudeMdPath}`);
  }

  /**
   * Add an entry to the worktree-local .git/info/exclude file.
   * This is a local-only gitignore that doesn't modify the repo's .gitignore.
   */
  private async addWorktreeGitExclude(worktreePath: string, pattern: string): Promise<void> {
    try {
      const dotGitPath = join(worktreePath, ".git");
      let gitDir: string;

      if (await fileExists(dotGitPath)) {
        const stat = (await readFile(dotGitPath, "utf-8")).trim();
        // Worktrees have a .git file with "gitdir: <path>"
        if (stat.startsWith("gitdir: ")) {
          gitDir = stat.slice("gitdir: ".length);
        } else {
          return; // unexpected format
        }
      } else {
        return; // no .git entry
      }

      const excludeDir = join(gitDir, "info");
      const excludePath = join(excludeDir, "exclude");

      await mkdir(excludeDir, { recursive: true });

      if (await fileExists(excludePath)) {
        const existing = await readFile(excludePath, "utf-8");
        if (existing.includes(pattern)) return; // already present
      }

      const existingContent = await fileExists(excludePath) ? await readFile(excludePath, "utf-8") : "";
      await writeFile(excludePath, existingContent + `\n${pattern}\n`, "utf-8");
      console.log(`[cli-launcher] Added "${pattern}" to worktree git exclude`);
    } catch (e) {
      console.warn(`[cli-launcher] Failed to add git exclude entry:`, e);
    }
  }

  /**
   * Symlink .claude/settings.json and .claude/settings.local.json in a worktree
   * to the main repo's copies. This ensures all worktrees for the same repo share
   * the same project-level permission rules.
   *
   * On every launch:
   * - If the worktree file doesn't exist → create symlink to main repo file
   * - If the worktree file is already a symlink → leave it (previous run)
   * - If the worktree file is a real file → merge its contents into the main
   *   repo file, replace with symlink. This handles the case where Claude Code's
   *   atomic write (write-to-temp-then-rename) broke a previous symlink.
   */
  private async symlinkProjectSettings(worktreePath: string, repoRoot: string): Promise<void> {
    if (!repoRoot) return;

    const SETTINGS_FILES = ["settings.json", "settings.local.json"];
    const worktreeClaudeDir = join(worktreePath, ".claude");
    const repoClaudeDir = join(repoRoot, ".claude");

    // Ensure the main repo's .claude/ directory exists so the CLI can create
    // the settings file at the symlink target.
    try {
      await mkdir(repoClaudeDir, { recursive: true });
    } catch {
      return; // can't create target directory — skip
    }

    for (const filename of SETTINGS_FILES) {
      const worktreeFile = join(worktreeClaudeDir, filename);
      const repoFile = join(repoClaudeDir, filename);

      try {
        // Seed the target file if it doesn't exist, so the symlink is never
        // dangling. A dangling symlink gets replaced by a real file when the
        // CLI does an atomic write (write-temp-then-rename).
        if (!(await fileExists(repoFile))) {
          await writeFile(repoFile, "{}\n", "utf-8");
          console.log(`[cli-launcher] Seeded ${repoFile} for symlink target`);
        }

        // Use lstat (doesn't follow symlinks) to detect dangling symlinks
        // and real files that replaced a previous symlink.
        let worktreeFileStat: import("node:fs").Stats | null = null;
        try {
          worktreeFileStat = await lstat(worktreeFile);
        } catch {
          // file doesn't exist — create symlink below
        }

        if (worktreeFileStat) {
          if (worktreeFileStat.isSymbolicLink()) {
            continue; // already a symlink (from previous run) — leave it
          }

          // Real file exists — Claude Code's atomic write broke a previous
          // symlink. Merge its contents into the main repo file, then replace.
          await this.mergeSettingsIntoRepo(worktreeFile, repoFile);
          await unlink(worktreeFile);
          console.log(`[cli-launcher] Merged and removed real ${worktreeFile} (was broken symlink)`);
        }

        await symlink(repoFile, worktreeFile);
        console.log(`[cli-launcher] Symlinked ${worktreeFile} → ${repoFile}`);

        // Add to git exclude so symlink doesn't show as untracked
        await this.addWorktreeGitExclude(worktreePath, `.claude/${filename}`);
      } catch (e) {
        console.warn(`[cli-launcher] Failed to symlink .claude/${filename}:`, e);
      }
    }
  }

  /**
   * Merge permission rules from a worktree's settings file into the main
   * repo's settings file. Deduplicates rules so merging is idempotent.
   */
  private async mergeSettingsIntoRepo(worktreeFile: string, repoFile: string): Promise<void> {
    try {
      const wtRaw = await readFile(worktreeFile, "utf-8");
      const wtData = JSON.parse(wtRaw) as Record<string, unknown>;

      let repoData: Record<string, unknown> = {};
      try {
        const repoRaw = await readFile(repoFile, "utf-8");
        repoData = JSON.parse(repoRaw) as Record<string, unknown>;
      } catch { /* empty or corrupt — start fresh */ }

      // Merge permissions.allow and permissions.deny arrays
      const wtPerms = (wtData.permissions ?? {}) as Record<string, unknown>;
      const repoPerms = (repoData.permissions ?? {}) as Record<string, unknown>;

      for (const key of ["allow", "deny"] as const) {
        const wtRules = Array.isArray(wtPerms[key]) ? wtPerms[key] as string[] : [];
        const repoRules = Array.isArray(repoPerms[key]) ? repoPerms[key] as string[] : [];
        const merged = [...new Set([...repoRules, ...wtRules])];
        if (merged.length > 0) {
          repoPerms[key] = merged;
        }
      }

      if (Object.keys(repoPerms).length > 0) {
        repoData.permissions = repoPerms;
      }

      await writeFile(repoFile, JSON.stringify(repoData, null, 2) + "\n", "utf-8");
    } catch (e) {
      console.warn(`[cli-launcher] Failed to merge settings into repo:`, e);
    }
  }

  /**
   * Mark a session as connected (called when CLI establishes WS connection).
   */
  markConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && (session.state === "starting" || session.state === "connected")) {
      session.state = "connected";
      console.log(`[cli-launcher] Session ${sessionTag(sessionId)} connected via WebSocket`);
      this.persistState();
    }
  }

  /**
   * Store the CLI's internal session ID (from system.init message).
   * This is needed for --resume on relaunch.
   */
  setCLISessionId(sessionId: string, cliSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cliSessionId = cliSessionId;
      this.persistState();
    }
  }

  /**
   * Kill a session's CLI process.
   */
  async kill(sessionId: string): Promise<boolean> {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;

    proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit, then force kill
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!exited) {
      console.log(`[cli-launcher] Force-killing session ${sessionTag(sessionId)}`);
      proc.kill("SIGKILL");
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      session.exitCode = -1;
    }
    this.processes.delete(sessionId);
    this.persistState();
    return true;
  }

  /**
   * List all sessions (active + recently exited).
   */
  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists and is alive (not exited).
   */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /**
   * Update the last activity timestamp for a session.
   */
  touchActivity(sessionId: string): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.lastActivityAt = Date.now();
      this.persistState();
    }
  }

  /**
   * Update worktree-related fields on a session (e.g. after recreating a
   * worktree for an unarchived session).
   */
  updateWorktree(sessionId: string, updates: { cwd: string; actualBranch: string }): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.cwd = updates.cwd;
      info.actualBranch = updates.actualBranch;
      this.persistState();
    }
  }

  /**
   * Set the archived flag on a session.
   */
  setArchived(sessionId: string, archived: boolean): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.archived = archived;
      info.archivedAt = archived ? Date.now() : undefined;
      // Clean up herd relationships when a leader is archived
      if (archived && info.isOrchestrator) {
        for (const worker of this.sessions.values()) {
          if (worker.herdedBy === sessionId) {
            worker.herdedBy = undefined;
          }
        }
        this.onHerdChanged?.(sessionId);
      }
      this.persistState();
    }
  }

  // ─── Cat herding (orchestrator→worker relationships) ─────────────────────

  /**
   * Herd worker sessions under an orchestrator. Each session can only have
   * one leader — if already herded by someone else, it's reported as a conflict.
   * Re-herding by the same orchestrator is idempotent.
   */
  herdSessions(orchId: string, workerIds: string[]): { herded: string[]; notFound: string[]; conflicts: Array<{ id: string; herder: string }> } {
    const herded: string[] = [];
    const notFound: string[] = [];
    const conflicts: Array<{ id: string; herder: string }> = [];
    for (const wid of workerIds) {
      const worker = this.sessions.get(wid);
      if (!worker) { notFound.push(wid); continue; }
      if (worker.herdedBy && worker.herdedBy !== orchId) {
        conflicts.push({ id: wid, herder: worker.herdedBy });
        continue;
      }
      worker.herdedBy = orchId;
      herded.push(wid);
    }
    if (herded.length > 0) {
      this.persistState();
      this.onHerdChanged?.(orchId);
    }
    return { herded, notFound, conflicts };
  }

  /**
   * Remove an orchestrator's herding claim from a worker session.
   * Returns true if the relationship existed and was removed.
   */
  unherdSession(orchId: string, workerId: string): boolean {
    const worker = this.sessions.get(workerId);
    if (!worker?.herdedBy || worker.herdedBy !== orchId) return false;
    worker.herdedBy = undefined;
    this.persistState();
    this.onHerdChanged?.(orchId);
    return true;
  }

  /**
   * Get all sessions herded by a specific orchestrator.
   */
  getHerdedSessions(orchId: string): SdkSessionInfo[] {
    const result: SdkSessionInfo[] = [];
    for (const s of this.sessions.values()) {
      if (s.herdedBy === orchId) result.push(s);
    }
    return result;
  }

  /**
   * Remove a session from the internal map (after kill or cleanup).
   */
  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
    this.sessionEnvs.delete(sessionId);
    this.persistState();
  }

  /**
   * Remove exited sessions from the list.
   */
  pruneExited(): number {
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === "exited") {
        this.sessions.delete(id);
        this.sessionEnvs.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Kill all sessions.
   */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const log = label === "stdout" ? console.log : console.error;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.trim()) {
          log(`[session:${sessionId}:${label}] ${text.trimEnd()}`);
        }
      }
    } catch {
      // stream closed
    }
  }

  private pipeOutput(sessionId: string, proc: Subprocess): void {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (stdout && typeof stdout !== "number") {
      this.pipeStream(sessionId, stdout, "stdout");
    }
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }
  }
}
