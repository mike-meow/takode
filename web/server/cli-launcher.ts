import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  realpathSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
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

  /** Persist launcher state to disk. */
  private persistState(): void {
    if (!this.store) return;
    const data = Array.from(this.sessions.values());
    this.store.saveLauncher(data);
  }

  /**
   * Restore sessions from disk and check which PIDs are still alive.
   * Returns the number of recovered sessions.
   */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const data = this.store.loadLauncher<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let recovered = 0;
    for (const info of data) {
      if (this.sessions.has(info.sessionId)) continue;

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
    return recovered;
  }

  /**
   * Merge launcher data from disk into existing in-memory sessions.
   * Used after import to pick up cliSessionId and rewritten paths
   * without clobbering active session state (connected sockets, PIDs, etc.).
   */
  mergeFromDisk(): number {
    if (!this.store) return 0;
    const data = this.store.loadLauncher<SdkSessionInfo[]>();
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
  launch(options: LaunchOptions = {}): SdkSessionInfo {
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

    // Pre-set cliSessionId for resume so subsequent relaunches also use --resume
    if (options.resumeCliSessionId) {
      info.cliSessionId = options.resumeCliSessionId;
    }

    this.sessions.set(sessionId, info);

    // Always inject COMPANION_SESSION_ID so agents can identify themselves
    const envWithSessionId = { ...options.env, COMPANION_SESSION_ID: sessionId };
    this.sessionEnvs.set(sessionId, envWithSessionId);
    options = { ...options, env: envWithSessionId };

    if (backendType === "codex") {
      this.spawnCodex(sessionId, info, options);
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

      // Validate the CLI binary exists inside the container
      const binary = info.backendType === "codex" ? "codex" : "claude";
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

    const runtimeEnv = this.sessionEnvs.get(sessionId);
    const binSettings = this.settingsGetter?.() ?? { claudeBinary: "", codexBinary: "" };

    if (info.backendType === "codex") {
      this.spawnCodex(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        codexBinary: binSettings.codexBinary || undefined,
        codexSandbox: info.codexSandbox,
        codexInternetAccess: info.codexInternetAccess,
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

    // Inject CLAUDE.md guardrails for worktree sessions
    if (info.isWorktree && info.branch) {
      this.injectWorktreeGuardrails(
        info.cwd,
        info.actualBranch || info.branch,
        info.repoRoot || "",
        info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
      );
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

    const proc = Bun.spawn(spawnCmd, {
      cwd: spawnCwd,
      env: spawnEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

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
  private prepareCodexHome(codexHome: string): void {
    mkdirSync(codexHome, { recursive: true });

    const legacyHome = getLegacyCodexHome();
    if (resolve(legacyHome) === resolve(codexHome) || !existsSync(legacyHome)) {
      return;
    }

    // Bootstrap only the user-level artifacts Codex needs (auth/config/skills),
    // while intentionally skipping sessions/sqlite to avoid stale rollout indexes.
    const fileSeeds = ["auth.json", "config.toml", "models_cache.json", "version.json"];
    for (const name of fileSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!existsSync(dest) && existsSync(src)) {
          copyFileSync(src, dest);
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
        if (!existsSync(dest) && existsSync(src)) {
          cpSync(src, dest, { recursive: true });
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name}/ from legacy home:`, e);
      }
    }
  }

  private spawnCodex(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
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
    const codexHome = resolveCompanionCodexSessionHome(
      sessionId,
      options.codexHome,
    );
    if (!isContainerized) {
      this.prepareCodexHome(codexHome);
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
      const enrichedPath = getEnrichedPath();
      const spawnPath = [binaryDir, ...enrichedPath.split(":")].filter(Boolean).join(":");

      if (existsSync(siblingNode)) {
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

    const proc = Bun.spawn(spawnCmd, {
      cwd: spawnCwd,
      env: spawnEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

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
   * Inject a CLAUDE.md file into the worktree with branch guardrails.
   * Only injects into actual worktree directories, never the main repo.
   */
  private injectWorktreeGuardrails(worktreePath: string, branch: string, repoRoot: string, parentBranch?: string): void {
    // Safety: never inject guardrails into the main repository itself
    if (worktreePath === repoRoot) {
      console.warn(`[cli-launcher] Skipping guardrails injection: worktree path is the main repo (${repoRoot})`);
      return;
    }

    // Safety: only inject if the worktree directory actually exists (created by git worktree add)
    if (!existsSync(worktreePath)) {
      console.warn(`[cli-launcher] Skipping guardrails injection: worktree path does not exist (${worktreePath})`);
      return;
    }

    const branchLabel = parentBranch
      ? `\`${branch}\` (created from \`${parentBranch}\`)`
      : `\`${branch}\``;

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

1. **Check the main repo first.** Pull remote changes first: \`git -C ${repoRoot} fetch origin <branch> && git -C ${repoRoot} pull --rebase origin <branch>\` (development may happen on multiple machines). Then run \`git -C ${repoRoot} status\` — if there are uncommitted changes, **stop and tell the user** — another agent may have work in progress. Never run \`git reset --hard\`, \`git checkout .\`, or \`git clean\` on the main repo without explicit user approval. Read any new commits briefly to understand what changed since your branch diverged.
2. **Rebase in the worktree.** Rebase your worktree branch onto the main repo's local branch. Since all worktrees share the same git object store, the main repo's local branch is directly visible as a ref — no fetch needed. Use \`git rebase <main-repo-branch>\` (the local branch name, not \`origin/...\`). Resolve all merge conflicts here in the worktree — this is the safe place to do it without affecting other agents.
3. **Cherry-pick clean commits to main.** Once the worktree branch is cleanly rebased with your new commits on top, cherry-pick only your new commits into the main repo using \`git -C ${repoRoot} cherry-pick <commit-hash>\`. Cherry-pick one at a time in chronological order.
4. **Handle unexpected conflicts.** If cherry-pick still conflicts (it shouldn't after a clean rebase), tell the user the conflicting files and ask how to proceed. Do not force-resolve or abort without asking.
5. **Verify and push.** Run \`git -C ${repoRoot} log --oneline -5\` to confirm the commits landed correctly, then \`git -C ${repoRoot} push origin <branch>\` to push to the remote.
6. **Reset worktree to stay in sync.** After porting is complete, reset this worktree branch to match the main repo's branch: \`git reset --hard <main-repo-branch>\`. This keeps the worktree in sync and avoids divergence for future work.
7. **Run tests post-merge.** After resetting, run the project's unit tests in the worktree to verify nothing broke from merging with main. If tests fail: (a) if the fix is straightforward, fix it in the worktree, commit, and re-sync following steps 1–6 above; (b) otherwise, explain the failures to the user and ask how to proceed.

### Completion Checklist

Do NOT report the sync as complete until ALL of the following are true:
- [ ] Main repo log shows the cherry-picked commits
- [ ] Worktree has been reset to match the main repo branch
- [ ] Tests have been run **after the reset** AND passed (or failures reported to user)
- [ ] Changes have been pushed to the remote
${MARKER_END}`;

    const claudeDir = join(worktreePath, ".claude");
    const claudeMdPath = join(claudeDir, "CLAUDE.md");

    try {
      mkdirSync(claudeDir, { recursive: true });

      if (existsSync(claudeMdPath)) {
        const existing = readFileSync(claudeMdPath, "utf-8");
        // Replace existing guardrails section or append
        if (existing.includes(MARKER_START)) {
          const before = existing.substring(0, existing.indexOf(MARKER_START));
          const afterIdx = existing.indexOf(MARKER_END);
          const after = afterIdx >= 0 ? existing.substring(afterIdx + MARKER_END.length) : "";
          writeFileSync(claudeMdPath, before + guardrails + after, "utf-8");
        } else {
          writeFileSync(claudeMdPath, existing + "\n\n" + guardrails, "utf-8");
        }
      } else {
        writeFileSync(claudeMdPath, guardrails, "utf-8");
      }
      console.log(`[cli-launcher] Injected worktree guardrails for branch ${branch}`);

      // Add .claude/CLAUDE.md to the worktree-local git exclude so it doesn't
      // show as untracked and is protected from `git clean -fd`.
      // Worktrees store their git metadata at the path inside .git (a file, not dir).
      this.addWorktreeGitExclude(worktreePath, ".claude/CLAUDE.md");

      // Mark the file as skip-worktree so git ignores local modifications to this
      // tracked file. Without this, `git status` always shows .claude/CLAUDE.md as
      // modified, which prevents automatic worktree cleanup on archive.
      try {
        execSync("git update-index --skip-worktree .claude/CLAUDE.md", {
          cwd: worktreePath, stdio: "pipe", timeout: 5000,
        });
      } catch { /* file may not be tracked in this repo — ignore */ }

      // Symlink project settings files so all worktrees for the same repo share
      // the same permission rules. Without this, rules written with
      // destination:"projectSettings" go to the worktree's local copy and aren't
      // visible to other sessions.
      this.symlinkProjectSettings(worktreePath, repoRoot);
    } catch (e) {
      console.warn(`[cli-launcher] Failed to inject worktree guardrails:`, e);
    }
  }

  /**
   * Add an entry to the worktree-local .git/info/exclude file.
   * This is a local-only gitignore that doesn't modify the repo's .gitignore.
   */
  private addWorktreeGitExclude(worktreePath: string, pattern: string): void {
    try {
      const dotGitPath = join(worktreePath, ".git");
      let gitDir: string;

      if (existsSync(dotGitPath)) {
        const stat = readFileSync(dotGitPath, "utf-8").trim();
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

      mkdirSync(excludeDir, { recursive: true });

      if (existsSync(excludePath)) {
        const existing = readFileSync(excludePath, "utf-8");
        if (existing.includes(pattern)) return; // already present
      }

      writeFileSync(excludePath, (existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "") + `\n${pattern}\n`, "utf-8");
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
   * Only creates symlinks for files that don't already exist in the worktree
   * (i.e., not tracked by git or previously created).
   */
  private symlinkProjectSettings(worktreePath: string, repoRoot: string): void {
    if (!repoRoot) return;

    const SETTINGS_FILES = ["settings.json", "settings.local.json"];
    const worktreeClaudeDir = join(worktreePath, ".claude");
    const repoClaudeDir = join(repoRoot, ".claude");

    // Ensure the main repo's .claude/ directory exists so the CLI can create
    // the settings file at the symlink target.
    try {
      mkdirSync(repoClaudeDir, { recursive: true });
    } catch {
      return; // can't create target directory — skip
    }

    for (const filename of SETTINGS_FILES) {
      const worktreeFile = join(worktreeClaudeDir, filename);
      const repoFile = join(repoClaudeDir, filename);

      try {
        // Use lstatSync (doesn't follow symlinks) to detect dangling symlinks.
        // existsSync follows symlinks — returns false for dangling ones, causing
        // symlinkSync to fail with EEXIST on relaunch.
        try {
          const stat = lstatSync(worktreeFile);
          if (!stat.isSymbolicLink()) continue; // real file — don't replace
          continue; // already a symlink (from previous run) — leave it
        } catch {
          // file doesn't exist at all — create symlink below
        }

        symlinkSync(repoFile, worktreeFile);
        console.log(`[cli-launcher] Symlinked ${worktreeFile} → ${repoFile}`);

        // Add to git exclude so symlink doesn't show as untracked
        this.addWorktreeGitExclude(worktreePath, `.claude/${filename}`);
      } catch (e) {
        console.warn(`[cli-launcher] Failed to symlink .claude/${filename}:`, e);
      }
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
      this.persistState();
    }
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
