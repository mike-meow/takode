import { randomUUID, createHash } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access, readFile, writeFile } from "node:fs/promises";

const execPromise = promisify(execCb);
import type { Subprocess } from "bun";
import type { SessionStore } from "./session-store.js";
import type {
  BackendType,
  CodexLeaderRecycleEvent,
  CodexLeaderRecycleLineage,
  CodexLeaderRecycleTokenSnapshot,
  CodexLeaderRecycleTrigger,
} from "./session-types.js";
import { assertNever } from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import { CodexAdapter } from "./codex-adapter.js";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";
import { containerManager } from "./container-manager.js";
import {
  buildCompanionInstructions,
  getClaudeSdkDebugLogPath,
  getOrchestratorGuardrails as renderOrchestratorGuardrails,
} from "./cli-launcher-instructions.js";
import { MissingCodexBinaryError, prepareCodexSpawn } from "./cli-launcher-codex.js";
import { stripInheritedTelemetryEnv, withNonInteractiveGitEditorEnv } from "./cli-launcher-env.js";
import { prepareWorktreeSessionArtifacts } from "./cli-launcher-worktree.js";
import { ensureQuestJourneyPhaseDataForCwd } from "./quest-journey-phases.js";
import { isRecoverableCodexInitError } from "./codex-adapter-utils.js";
import { type CodexTokenRefreshNoiseState } from "./cli-stream-log-classifier.js";
import { formatStreamTailForError, pipeLauncherStream } from "./cli-launcher-streams.js";
import { sessionTag } from "./session-tag.js";
import type { HerdChangeEvent, HerdSessionsResponse } from "../shared/herd-types.js";
import { getSessionAuthDir, getSessionAuthPath } from "../shared/session-auth.js";

function appendUniqueCliSessionId(
  lineage: CodexLeaderRecycleLineage | undefined,
  cliSessionId: string,
): CodexLeaderRecycleLineage {
  const current = lineage ?? { cliSessionIds: [], recycleEvents: [] };
  if (!cliSessionId) return current;
  if (current.cliSessionIds.includes(cliSessionId)) return current;
  return {
    ...current,
    cliSessionIds: [...current.cliSessionIds, cliSessionId],
  };
}

/** Check if a file exists (async equivalent of existsSync). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

async function readProcessCmdline(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return raw.replace(/\0/g, " ").trim() || null;
  } catch {
    return null;
  }
}

async function captureProcessSnapshot(pid: number): Promise<string[]> {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const cmd =
    `PARENT_PID="$(ps -o ppid= -p ${pid} 2>/dev/null | tr -d ' ')"; ` +
    `CHILD_PIDS="$(pgrep -P ${pid} 2>/dev/null | tr '\\n' ' ')"; ` +
    `IDS="${pid}"; ` +
    `[ -n "$PARENT_PID" ] && IDS="$IDS $PARENT_PID"; ` +
    `[ -n "$CHILD_PIDS" ] && IDS="$IDS $CHILD_PIDS"; ` +
    `ps -o pid=,ppid=,pgid=,stat=,etime=,command= -p $IDS 2>/dev/null`;
  try {
    const { stdout } = await execPromise(cmd, { timeout: 3000, maxBuffer: 64 * 1024 });
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
  } catch {
    return [];
  }
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
  /** Whether permission prompts are enabled (shared UI state; backend-specific mapping). */
  askPermission?: boolean;
  cwd: string;
  createdAt: number;
  /** Epoch ms of last user or CLI activity (used by idle manager) */
  lastActivityAt?: number;
  /** Epoch ms of last user message (used for sidebar activity sort) */
  lastUserMessageAt?: number;
  /** The CLI's internal session ID (from system.init), used for --resume */
  cliSessionId?: string;
  /** Codex leader recycle lineage across fresh-thread swaps within one Takode session. */
  codexLeaderRecycleLineage?: CodexLeaderRecycleLineage;
  /** Pending Codex leader recycle awaiting a fresh replacement thread and recovery prompt. */
  codexLeaderRecyclePending?: {
    eventIndex: number;
    trigger: CodexLeaderRecycleTrigger;
    requestedAt: number;
  } | null;
  archived?: boolean;
  /** Epoch ms when this session was archived */
  archivedAt?: number;
  /** Async cleanup state for archived worktree sessions. */
  worktreeCleanupStatus?: "pending" | "done" | "failed";
  /** Last background cleanup error, if any. */
  worktreeCleanupError?: string;
  /** Epoch ms when background cleanup started. */
  worktreeCleanupStartedAt?: number;
  /** Epoch ms when background cleanup finished (success or failure). */
  worktreeCleanupFinishedAt?: number;
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
  /** Epoch ms for the last server git metadata refresh attempt. */
  gitStatusRefreshedAt?: number;
  /** Last git refresh error, if any. */
  gitStatusRefreshError?: string | null;
  /** Whether internet/web search is enabled for Codex sessions */
  codexInternetAccess?: boolean;
  /** Sandbox mode selected for Codex sessions */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Reasoning effort selected for Codex sessions (e.g. low/medium/high). */
  codexReasoningEffort?: string;
  /** Optional per-session Codex home override, reused across relaunches. */
  codexHome?: string;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** Number of active timers currently waiting on this session. */
  pendingTimerCount?: number;
  /** Highest active Takode notification urgency restored from the session inbox. */
  notificationUrgency?: "needs-input" | "review" | null;
  /** Number of unresolved Takode notifications for sidebar snapshots. */
  activeNotificationCount?: number;
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
  /** Whether this is an orchestrator session (has herd/orchestration privileges) */
  isOrchestrator?: boolean;
  /** Session UUID of the leader that has herded this worker (single leader per session) */
  herdedBy?: string;
  /** Env profile slug used at creation, for re-resolving env vars on relaunch */
  envSlug?: string;
  /** When true, the session auto-namer is suppressed (e.g. temporary reviewer sessions) */
  noAutoName?: boolean;
  /** Session number of the parent session this reviewer is reviewing (reviewer lifecycle) */
  reviewerOf?: number;
  /** Server-issued secret used to authenticate privileged REST calls from this session. */
  sessionAuthToken?: string;
  /** One-shot: resume-session-at UUID for revert (cleared after use) */
  resumeAt?: string;
  /** The Companion-injected system prompt constructed at launch time (for debugging in Session Info). */
  injectedSystemPrompt?: string;
  /** Stable per-session Claude SDK debug log path for transport/process debugging. */
  sdkDebugLogPath?: string;

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
  /** Whether permission prompts are enabled (shared UI state; backend-specific mapping). */
  askPermission?: boolean;
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
  /** Codex leader-only effective context window override for session-local config. */
  codexLeaderContextWindowOverrideTokens?: number;
  /** Codex non-leader auto-compact threshold as a percent of effective model context. */
  codexNonLeaderAutoCompactThresholdPercent?: number;
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
  /** Plugin directories to load for SDK sessions (maps to --plugin-dir CLI flags). */
  pluginDirs?: string[];
  /** Extra instructions appended to the system prompt (e.g., orchestrator guardrails). */
  extraInstructions?: string;
}

/**
 * Manages CLI backend processes (Claude Code via --sdk-url WebSocket,
 * or Codex via app-server stdio).
 */
const knownSessionNums = new Map<string, number>();

export function getKnownSessionNum(sessionId: string): number | undefined {
  return knownSessionNums.get(sessionId);
}

export class CliLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, Subprocess>();
  /** Runtime-only env vars per session (kept out of persisted launcher state). */
  private sessionEnvs = new Map<string, Record<string, string>>();
  private codexTokenRefreshNoiseBySession = new Map<string, CodexTokenRefreshNoiseState>();
  private port: number;
  private serverId: string;
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  private onCodexAdapter: ((sessionId: string, adapter: CodexAdapter) => void) | null = null;
  private onClaudeSdkAdapter:
    | ((sessionId: string, adapter: import("./claude-sdk-adapter.js").ClaudeSdkAdapter) => void)
    | null = null;
  private onBeforeRelaunch: ((sessionId: string, backendType: BackendType) => void) | null = null;
  private exitHandlers: ((sessionId: string, exitCode: number | null) => void)[] = [];
  private settingsGetter:
    | (() => {
        claudeBinary: string;
        codexBinary: string;
        codexLeaderContextWindowOverrideTokens?: number;
        codexNonLeaderAutoCompactThresholdPercent?: number;
      })
    | null = null;
  /** Callback to resolve env profile variables by slug (set by server bootstrap). */
  private envResolver: ((slug: string) => Promise<Record<string, string> | null>) | null = null;

  /** Callback for herd relationship changes (set by server bootstrap). */
  onHerdChange: ((event: HerdChangeEvent) => void) | null = null;

  // ─── Integer session ID tracking ───────────────────────────────────────────
  private nextSessionNum = 0;
  /** UUID → integer session number */
  private sessionNumMap = new Map<string, number>();
  /** Integer session number → UUID */
  private sessionByNum = new Map<number, string>();

  constructor(port: number, options?: { serverId?: string }) {
    this.port = port;
    this.serverId = options?.serverId?.trim() || "unknown-server";
  }

  /** Get the server port number. */
  getPort(): number {
    return this.port;
  }

  /** Register a callback for when a CodexAdapter is created (WsBridge needs to attach it). */
  onCodexAdapterCreated(cb: (sessionId: string, adapter: CodexAdapter) => void): void {
    this.onCodexAdapter = cb;
  }

  /** Register a callback for when a ClaudeSdkAdapter is created (WsBridge needs to attach it). */
  onClaudeSdkAdapterCreated(
    cb: (sessionId: string, adapter: import("./claude-sdk-adapter.js").ClaudeSdkAdapter) => void,
  ): void {
    this.onClaudeSdkAdapter = cb;
  }

  /** Register a callback for when a CLI/Codex process exits. */
  onSessionExited(cb: (sessionId: string, exitCode: number | null) => void): void {
    this.exitHandlers.push(cb);
  }

  /** Register a callback invoked just before relaunch kills the old process.
   *  Lets ws-bridge mark the disconnect as intentional to prevent redundant
   *  auto-relaunch requests from the adapter disconnect handler. */
  onBeforeRelaunchCallback(cb: (sessionId: string, backendType: BackendType) => void): void {
    this.onBeforeRelaunch = cb;
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
  setSettingsGetter(
    fn: () => {
      claudeBinary: string;
      codexBinary: string;
      codexLeaderContextWindowOverrideTokens?: number;
      codexNonLeaderAutoCompactThresholdPercent?: number;
    },
  ): void {
    this.settingsGetter = fn;
  }

  /** Attach an env resolver so relaunch() can re-resolve env profiles after restart. */
  setEnvResolver(fn: (slug: string) => Promise<Record<string, string> | null>): void {
    this.envResolver = fn;
  }

  private async terminateKnownProcess(
    sessionId: string,
    pid: number | undefined,
    proc?: Subprocess,
    reason?: string,
  ): Promise<void> {
    if (!pid) return;

    try {
      if (proc) {
        proc.kill("SIGTERM");
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {}

    const exitedGracefully = proc
      ? await Promise.race([
          proc.exited.then(() => true).catch(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
        ])
      : await waitForProcessExit(pid, 2000);
    if (exitedGracefully) return;

    console.warn(
      `[cli-launcher] Process ${pid} for session ${sessionTag(sessionId)} did not exit after SIGTERM` +
        `${reason ? ` (${reason})` : ""}; escalating to SIGKILL`,
    );
    if (!proc) {
      const cmdline = await readProcessCmdline(pid);
      console.warn(
        `[cli-launcher] Refusing SIGKILL for untracked persisted pid ${pid} on session ${sessionTag(sessionId)}` +
          `${cmdline ? ` (still running: ${cmdline})` : ""}`,
      );
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await waitForProcessExit(pid, 1000);
  }

  // ─── Integer session ID management ─────────────────────────────────────────

  /** Assign a monotonic integer ID to a session. */
  private assignSessionNum(sessionId: string): number {
    const existing = this.sessionNumMap.get(sessionId);
    if (existing !== undefined) {
      knownSessionNums.set(sessionId, existing);
      return existing;
    }
    const num = this.nextSessionNum++;
    this.sessionNumMap.set(sessionId, num);
    this.sessionByNum.set(num, sessionId);
    knownSessionNums.set(sessionId, num);
    return num;
  }

  /**
   * Resolve a session identifier to a full UUID.
   * Accepts: integer session number, #N session number, full UUID, or UUID prefix (min 4 chars).
   * Returns null if no match found.
   */
  resolveSessionId(idOrNum: string): string | null {
    const normalized = idOrNum.trim();
    const numericRef = /^#\d+$/.test(normalized) ? normalized.slice(1) : normalized;
    // Try integer lookup first
    const num = parseInt(numericRef, 10);
    if (!isNaN(num) && String(num) === numericRef) {
      return this.sessionByNum.get(num) ?? null;
    }
    // Exact UUID match
    if (this.sessions.has(normalized)) return normalized;
    // Prefix match (min 4 chars to avoid ambiguity)
    if (normalized.length >= 4) {
      const lower = normalized.toLowerCase();
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

  /** Ensure a session has an auth token and return it. */
  private ensureSessionAuthToken(info: SdkSessionInfo): string {
    if (!info.sessionAuthToken) {
      info.sessionAuthToken = randomUUID();
      this.persistState();
    }
    return info.sessionAuthToken;
  }

  /** Get the auth token for a session, generating one for legacy sessions if missing. */
  getSessionAuthToken(sessionId: string): string | undefined {
    const info = this.sessions.get(sessionId);
    if (!info) return undefined;
    return this.ensureSessionAuthToken(info);
  }

  /** Verify a session auth token for privileged API operations. */
  verifySessionAuthToken(sessionId: string, token: string): boolean {
    if (!token) return false;
    const expected = this.getSessionAuthToken(sessionId);
    return !!expected && token === expected;
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
      } else if (info.backendType === "claude-sdk" && info.state !== "exited") {
        // SDK sessions have no PID — the in-memory adapter is gone after server
        // restart.  Mark them as "exited" so handleBrowserOpen() will trigger
        // relaunch instead of optimistically assuming the adapter is alive.
        info.state = "exited";
        info.exitCode = -1;
        this.sessions.set(info.sessionId, info);
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
        knownSessionNums.set(info.sessionId, info.sessionNum);
        if (info.sessionNum > maxNum) maxNum = info.sessionNum;
      }
    }
    this.nextSessionNum = maxNum + 1;

    // Phase 2: Assign new numbers to sessions that don't have one yet (legacy/pre-migration)
    const sorted = allSessions
      .filter((s) => s.sessionNum === undefined || s.sessionNum === null)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const info of sorted) {
      info.sessionNum = this.assignSessionNum(info.sessionId);
    }
    if (sorted.length > 0) {
      // Persist the newly assigned numbers so they're stable on next restart
      this.persistState();
    }
    console.log(
      `[cli-launcher] Session numbers: ${allSessions.length} total, ${sorted.length} newly assigned, next=#${this.nextSessionNum}`,
    );

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
      askPermission: options.askPermission,
      cwd,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      backendType,
    };

    if (backendType === "codex") {
      info.codexInternetAccess = options.codexInternetAccess === true;
      info.codexSandbox = options.codexSandbox;
      info.codexReasoningEffort = options.codexReasoningEffort;
      info.codexHome = options.codexHome;
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

    // Phase briefs are global runtime files, but reviewers often share an unported
    // worker worktree. Refresh from the session CWD before launch so the assignee
    // path leaders provide matches the worktree version being reviewed.
    try {
      const refreshedPhaseBriefs = await ensureQuestJourneyPhaseDataForCwd(info.cwd);
      if (refreshedPhaseBriefs) {
        console.log(`[cli-launcher] Refreshed Quest Journey phase briefs from session cwd (${info.cwd})`);
      }
    } catch (error) {
      console.warn(`[cli-launcher] Failed to refresh Quest Journey phase briefs from session cwd:`, error);
    }

    // Inject backend-specific worktree guardrails.
    if (info.isWorktree && info.branch) {
      await prepareWorktreeSessionArtifacts({
        worktreePath: info.cwd,
        branch: info.actualBranch || info.branch,
        repoRoot: info.repoRoot || "",
        backendType,
      });
    }

    // Pre-set cliSessionId for resume so subsequent relaunches also use --resume
    if (options.resumeCliSessionId) {
      info.cliSessionId = options.resumeCliSessionId;
    }

    this.sessions.set(sessionId, info);

    // Assign monotonic integer session number
    info.sessionNum = this.assignSessionNum(sessionId);

    // Server-issued token for authenticating privileged REST requests.
    const sessionAuthToken = this.ensureSessionAuthToken(info);

    // Always inject companion identity/auth vars so agents can identify and authenticate themselves.
    const envWithSessionId = {
      ...options.env,
      COMPANION_SERVER_ID: this.serverId,
      COMPANION_SESSION_ID: sessionId,
      COMPANION_SESSION_NUMBER: String(info.sessionNum),
      COMPANION_AUTH_TOKEN: sessionAuthToken,
    };
    this.sessionEnvs.set(sessionId, envWithSessionId);
    options = { ...options, env: envWithSessionId };

    // Write session-auth file so takode/quest CLIs can authenticate when env vars are missing
    // (e.g., after CLI relaunch). Fire-and-forget — non-blocking.
    this.writeSessionAuthFile(cwd, sessionId, sessionAuthToken, this.port).catch(() => {});

    switch (backendType) {
      case "codex":
        this.spawnCodex(sessionId, info, options).catch((err) => {
          console.error(`[cli-launcher] Codex spawn failed for ${sessionTag(sessionId)}:`, err);
        });
        break;
      case "claude-sdk":
        // Await SDK spawn so the adapter is attached before launch() returns.
        // This ensures the browser sees backend_connected in the state_snapshot.
        await this.spawnClaudeSdk(sessionId, info, options);
        break;
      case "claude":
        this.spawnCLI(sessionId, info, {
          ...options,
          ...(options.resumeCliSessionId ? { resumeSessionId: options.resumeCliSessionId } : {}),
        });
        break;
      default:
        assertNever(backendType);
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
    // Notify ws-bridge before killing so it can mark the upcoming adapter
    // disconnect as intentional — prevents the disconnect handler from
    // requesting a redundant auto-relaunch that races with this one.
    const bt = info.backendType ?? "claude";
    if (oldProc || info.pid) {
      this.onBeforeRelaunch?.(sessionId, bt);
    }
    if (oldProc) {
      await this.terminateKnownProcess(sessionId, oldProc.pid, oldProc, "relaunch");
      this.processes.delete(sessionId);
    } else if (info.pid) {
      // Process from a previous server instance — kill by PID
      await this.terminateKnownProcess(sessionId, info.pid, undefined, "relaunch");
    }

    // Pre-flight validation for containerized sessions
    if (info.containerId) {
      const containerLabel = info.containerName || info.containerId.slice(0, 12);
      const containerState = containerManager.isContainerAlive(info.containerId);

      if (containerState === "missing") {
        console.error(
          `[cli-launcher] Container ${containerLabel} no longer exists for session ${sessionTag(sessionId)}`,
        );
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
          console.log(
            `[cli-launcher] Restarted stopped container ${containerLabel} for session ${sessionTag(sessionId)}`,
          );
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
      const configuredBinary = (
        info.backendType === "codex" ? binSettings.codexBinary : binSettings.claudeBinary
      ).trim();
      const binary = (configuredBinary || (info.backendType === "codex" ? "codex" : "claude")).split(/\s+/)[0];

      if (!containerManager.hasBinaryInContainer(info.containerId, binary)) {
        console.error(
          `[cli-launcher] "${binary}" not found in container ${containerLabel} for session ${sessionTag(sessionId)}`,
        );
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

    console.log(
      `[cli-launcher] Relaunching session ${sessionTag(sessionId)} (cliSessionId: ${info.cliSessionId || "none"}, state: ${info.state}, backendType: ${info.backendType || "claude"})`,
    );
    this.recorder?.recordServerEvent(
      sessionId,
      "cli_relaunch",
      {
        cliSessionId: info.cliSessionId || null,
        hasResume: !!info.cliSessionId,
        backendType: info.backendType || "claude",
      },
      info.backendType || "claude",
      info.cwd,
    );

    let runtimeEnv = this.sessionEnvs.get(sessionId);
    const sessionAuthToken = this.ensureSessionAuthToken(info);

    // Ensure runtime env always carries the auth token (covers legacy in-memory maps).
    if (runtimeEnv && runtimeEnv.COMPANION_AUTH_TOKEN !== sessionAuthToken) {
      runtimeEnv = { ...runtimeEnv, COMPANION_AUTH_TOKEN: sessionAuthToken };
      this.sessionEnvs.set(sessionId, runtimeEnv);
    }

    // After server restart, sessionEnvs is empty (not persisted to disk).
    // Reconstruct essential env vars from persisted SdkSessionInfo fields
    // and re-resolve the env profile if one was used at creation time.
    if (!runtimeEnv) {
      const sessionNum = this.getSessionNum(sessionId);
      const reconstructed: Record<string, string> = {
        COMPANION_SERVER_ID: this.serverId,
        COMPANION_SESSION_ID: sessionId,
        COMPANION_SESSION_NUMBER: sessionNum !== undefined ? String(sessionNum) : "",
        COMPANION_AUTH_TOKEN: sessionAuthToken,
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
      const bt = info.backendType ?? "claude";

      // Re-derive orchestrator guardrails for relaunched sessions.
      // extraInstructions is not persisted; regenerate from the isOrchestrator flag
      // so relaunched leaders retain the full orchestration system prompt.
      const extraInstructions = info.isOrchestrator ? this.getOrchestratorGuardrails(bt) : undefined;

      switch (bt) {
        case "codex":
          await this.spawnCodex(sessionId, info, {
            model: info.model,
            permissionMode: info.permissionMode,
            askPermission: info.askPermission,
            cwd: info.cwd,
            codexBinary: binSettings.codexBinary || undefined,
            codexSandbox: info.codexSandbox,
            codexInternetAccess: info.codexInternetAccess,
            codexReasoningEffort: info.codexReasoningEffort,
            codexHome: info.codexHome,
            codexLeaderContextWindowOverrideTokens: binSettings.codexLeaderContextWindowOverrideTokens,
            codexNonLeaderAutoCompactThresholdPercent: binSettings.codexNonLeaderAutoCompactThresholdPercent,
            containerId: info.containerId,
            containerName: info.containerName,
            containerImage: info.containerImage,
            env: runtimeEnv,
            extraInstructions,
          });
          break;
        case "claude-sdk":
          await this.spawnClaudeSdk(sessionId, info, {
            model: info.model,
            permissionMode: info.permissionMode,
            cwd: info.cwd,
            claudeBinary: binSettings.claudeBinary || undefined,
            env: runtimeEnv,
            extraInstructions,
          });
          break;
        case "claude":
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
            extraInstructions,
          });
          break;
        default:
          assertNever(bt);
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
    console.log(
      `[revert] relaunchWithResumeAt: session=${sessionId.slice(0, 8)} resumeAt=${resumeAt} cliSessionId=${info.cliSessionId}`,
    );
    info.resumeAt = resumeAt;
    const result = await this.relaunch(sessionId);
    console.log(
      `[revert] relaunchWithResumeAt result: ok=${result.ok}${result.error ? ` error=${result.error}` : ""} (resumeAt was ${info.resumeAt ? "still set" : "already cleared"})`,
    );
    delete info.resumeAt;
    return result;
  }

  /**
   * Get all sessions in "starting" state (awaiting CLI WebSocket connection).
   */
  getStartingSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "starting");
  }

  private spawnCLI(
    sessionId: string,
    info: SdkSessionInfo,
    options: LaunchOptions & { resumeSessionId?: string },
  ): void {
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
    const containerSdkHost =
      (process.env.COMPANION_CONTAINER_SDK_HOST || "host.docker.internal").trim() || "host.docker.internal";

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
      isContainerized &&
      options.permissionMode === "bypassPermissions" &&
      process.env.COMPANION_FORCE_BYPASS_IN_CONTAINER !== "1"
    ) {
      console.warn(
        `[cli-launcher] Session ${sessionId}: downgrading container permission mode ` +
          `from bypassPermissions to acceptEdits (set COMPANION_FORCE_BYPASS_IN_CONTAINER=1 to force bypass).`,
      );
      effectivePermissionMode = "acceptEdits";
      info.permissionMode = "acceptEdits";
    }

    const args: string[] = [
      "--sdk-url",
      sdkUrl,
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
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
      console.log(
        `[revert] spawnCLI: passing --resume-session-at ${info.resumeAt} (with --resume ${options.resumeSessionId})`,
      );
    }
    args.push("-p", "");

    // Inject Companion-specific instructions via system prompt (link syntax,
    // worktree branch guardrails, orchestrator guardrails, sync workflow).
    // This replaces the old approach of writing files into the user's repo.
    const companionInstructions = buildCompanionInstructions({
      sessionNum: info.sessionNum,
      ...(info.isWorktree && info.branch
        ? {
            worktree: {
              branch: info.actualBranch || info.branch,
              repoRoot: info.repoRoot || "",
              parentBranch: info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
            },
          }
        : {}),
      extraInstructions: options.extraInstructions,
      backend: "claude",
    });
    if (companionInstructions) {
      args.push("--append-system-prompt", companionInstructions);
      info.injectedSystemPrompt = companionInstructions;
    }

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run CLI inside the container via docker exec -i.
      // Keeping stdin open avoids premature EOF-driven exits in SDK mode.
      // Environment variables are passed via -e flags to docker exec.
      const dockerArgs = ["docker", "exec", "-i"];
      const containerEnv = withNonInteractiveGitEditorEnv(options.env ?? {});

      // Pass env vars via -e flags
      for (const [k, v] of Object.entries(containerEnv)) {
        dockerArgs.push("-e", `${k}=${v}`);
      }
      // Ensure CLAUDECODE is unset inside container
      dockerArgs.push("-e", "CLAUDECODE=");

      dockerArgs.push(options.containerId!);
      // Use a login shell so ~/.bashrc is sourced and nvm/bun/deno/etc are on PATH
      const innerCmd = [binary, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      // Host env for the docker CLI itself
      spawnEnv = { ...process.env, PATH: getEnrichedPath({ serverId: this.serverId }) };
      spawnCwd = undefined; // cwd is set inside the container via -w at creation
    } else {
      // Host-based spawn (original behavior)
      spawnCmd = [binary, ...args];
      spawnEnv = withNonInteractiveGitEditorEnv({
        ...stripInheritedTelemetryEnv(process.env),
        CLAUDECODE: undefined,
        ...options.env,
        PATH: getEnrichedPath({ serverId: this.serverId }),
      });
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
      this.recorder?.recordServerEvent(
        sessionId,
        "cli_exit",
        {
          exitCode,
          uptime,
          hadResume: !!options.resumeSessionId,
        },
        info.backendType || "claude",
        info.cwd,
      );

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
        try {
          handler(sessionId, exitCode);
        } catch {}
      }
    });

    this.persistState();
  }

  /**
   * Spawn a Codex app-server subprocess for a session.
   * Unlike Claude Code (which connects back via WebSocket), Codex uses stdio.
   */

  /**
   * Spawn a Claude Code session using the Agent SDK (stdio transport).
   * No WebSocket — the SDK manages the process and communicates via stdin/stdout.
   * Eliminates 5-minute disconnect cycles and all associated reliability issues.
   */
  private async spawnClaudeSdk(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): Promise<void> {
    const { ClaudeSdkAdapter } = await import("./claude-sdk-adapter.js");
    const sdkInstructions = buildCompanionInstructions({
      sessionNum: info.sessionNum,
      ...(info.isWorktree && info.branch
        ? {
            worktree: {
              branch: info.actualBranch || info.branch,
              repoRoot: info.repoRoot || "",
              parentBranch: info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
            },
          }
        : {}),
      extraInstructions: options.extraInstructions,
      backend: "claude",
    });
    if (sdkInstructions) info.injectedSystemPrompt = sdkInstructions;
    info.sdkDebugLogPath ||= getClaudeSdkDebugLogPath(this.port, sessionId);
    const adapter = new ClaudeSdkAdapter(sessionId, {
      model: options.model,
      cwd: info.cwd,
      permissionMode: options.permissionMode,
      cliSessionId: info.cliSessionId,
      env: options.env as Record<string, string | undefined>,
      claudeBinary: options.claudeBinary,
      recorder: this.recorder,
      pluginDirs: options.pluginDirs,
      instructions: sdkInstructions || undefined,
      debugFile: info.sdkDebugLogPath,
    });

    if (this.onClaudeSdkAdapter) {
      this.onClaudeSdkAdapter(sessionId, adapter);
    }

    info.state = "connected";
    this.persistState();
    console.log(`[cli-launcher] Claude SDK session ${sessionTag(sessionId)} started`);
  }

  private async spawnCodex(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): Promise<void> {
    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;
    let sandboxMode: "workspace-write" | "danger-full-access";
    try {
      const spawnSpec = await prepareCodexSpawn(
        sessionId,
        {
          cwd: info.cwd,
          cliSessionId: info.cliSessionId,
          isOrchestrator: info.isOrchestrator,
        },
        options,
      );
      spawnCmd = spawnSpec.spawnCmd;
      spawnEnv = spawnSpec.spawnEnv;
      spawnCwd = spawnSpec.spawnCwd;
      sandboxMode = spawnSpec.sandboxMode;
    } catch (err) {
      if (err instanceof MissingCodexBinaryError) {
        console.error(`[cli-launcher] ${err.message}`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
      throw err;
    }

    const isContainerized = !!options.containerId;

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
    void this.logCodexProcessSnapshot(sessionId, proc.pid, "spawn");

    // Pipe stderr for debugging (stdout is used for JSON-RPC)
    const stderr = proc.stderr;
    const stderrTail: string[] = [];

    // Create the CodexAdapter which handles JSON-RPC and message translation
    // Pass the raw permission mode — the adapter maps it to Codex's approval policy
    const codexInstructions = buildCompanionInstructions({
      sessionNum: info.sessionNum,
      ...(info.isWorktree && info.branch
        ? {
            worktree: {
              branch: info.actualBranch || info.branch,
              repoRoot: info.repoRoot || "",
              parentBranch: info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
            },
          }
        : {}),
      extraInstructions: options.extraInstructions,
      backend: "codex",
    });
    if (codexInstructions) info.injectedSystemPrompt = codexInstructions;
    const adapter = new CodexAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      approvalMode: options.permissionMode,
      askPermission: options.askPermission,
      threadId: info.cliSessionId,
      sandbox: sandboxMode,
      reasoningEffort: options.codexReasoningEffort,
      recorder: this.recorder ?? undefined,
      instructions: codexInstructions || undefined,
      failureContextProvider: () => formatStreamTailForError(stderrTail),
    });
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr", stderrTail, (text) => adapter.handleProcessStderr(text));
    }

    // Handle init errors — mark session as exited so recovery can relaunch.
    // Preserve cliSessionId for transient startup failures so automatic retry
    // has the same resume target that a later manual Relaunch would use.
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex session ${sessionTag(sessionId)} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        if (!isRecoverableCodexInitError(error)) {
          session.cliSessionId = undefined;
        }
      }
      if (this.processes.get(sessionId) === proc) {
        this.processes.delete(sessionId);
      }
      void this.terminateKnownProcess(sessionId, proc.pid, proc, "codex_init_error").catch((err) => {
        console.error(
          `[cli-launcher] Failed to terminate broken Codex process for session ${sessionTag(sessionId)}:`,
          err,
        );
      });
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

      // Guard against stale exits: if a new process was already spawned
      // (e.g. during relaunch), this exit belongs to the old process.
      // Without this guard, the stale handler stomps state to "exited" and
      // deletes the new process entry — causing zombie sessions where the
      // adapter is alive but the launcher thinks the session is dead.
      if (this.processes.get(sessionId) !== proc) {
        console.log(`[cli-launcher] Ignoring stale Codex exit for session ${sessionTag(sessionId)}`);
        return;
      }

      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
      for (const handler of this.exitHandlers) {
        try {
          handler(sessionId, exitCode);
        } catch {}
      }
    });

    this.persistState();
  }

  /**
   * Return orchestrator identity and instructions for system prompt injection.
   */
  getOrchestratorGuardrails(backend: BackendType = "claude"): string {
    return renderOrchestratorGuardrails(backend);
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
      session.codexLeaderRecycleLineage = appendUniqueCliSessionId(session.codexLeaderRecycleLineage, cliSessionId);
      const pendingRecycle = session.codexLeaderRecyclePending;
      if (pendingRecycle) {
        const recycleEvents = session.codexLeaderRecycleLineage?.recycleEvents ?? [];
        const recycleEvent = recycleEvents[pendingRecycle.eventIndex];
        if (recycleEvent && !recycleEvent.nextCliSessionId) {
          recycleEvent.nextCliSessionId = cliSessionId;
        }
      }
      this.persistState();
    }
  }

  prepareCodexLeaderRecycle(
    sessionId: string,
    options: { trigger: CodexLeaderRecycleTrigger; tokenUsage?: CodexLeaderRecycleTokenSnapshot },
  ): { ok: boolean; error?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };
    if (session.backendType !== "codex") return { ok: false, error: "Session is not a Codex session" };
    if (!session.isOrchestrator) return { ok: false, error: "Session is not a Codex leader" };
    if (session.codexLeaderRecyclePending) return { ok: true };

    const previousCliSessionId = session.cliSessionId;
    const recycleEvent: CodexLeaderRecycleEvent = {
      trigger: options.trigger,
      requestedAt: Date.now(),
      previousCliSessionId,
      ...(options.tokenUsage ? { tokenUsage: options.tokenUsage } : {}),
    };
    const normalizedLineage = appendUniqueCliSessionId(session.codexLeaderRecycleLineage, previousCliSessionId || "");
    normalizedLineage.recycleEvents.push(recycleEvent);
    session.codexLeaderRecycleLineage = normalizedLineage;
    session.codexLeaderRecyclePending = {
      eventIndex: normalizedLineage.recycleEvents.length - 1,
      trigger: options.trigger,
      requestedAt: recycleEvent.requestedAt,
    };
    session.cliSessionId = undefined;
    this.persistState();
    return { ok: true };
  }

  completeCodexLeaderRecycle(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.codexLeaderRecyclePending) return;
    session.codexLeaderRecyclePending = null;
    this.persistState();
  }

  /**
   * Kill a session's CLI process.
   * For subprocess-based sessions (claude, codex): sends SIGTERM/SIGKILL.
   * For SDK sessions: marks the session as exited so the bridge will
   * disconnect the adapter on its next check. Returns true if the session
   * was found and marked for termination.
   */
  async kill(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const proc = this.processes.get(sessionId);
    if (proc) {
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

      this.processes.delete(sessionId);
    }

    // Mark session as exited regardless of whether a subprocess existed.
    // SDK sessions don't have a subprocess — they use an in-process adapter
    // that the bridge will disconnect when it sees state === "exited".
    session.state = "exited";
    session.exitCode = -1;
    this.persistState();
    return true;
  }

  /**
   * Upgrade a WebSocket ("claude") session to SDK ("claude-sdk") transport.
   *
   * This kills the CLI WebSocket process, changes the backendType to "claude-sdk",
   * and relaunches using the Agent SDK with the same cliSessionId. The SDK calls
   * unstable_v2_resumeSession() to resume the conversation, preserving full
   * history and context from the original WebSocket session.
   *
   * Returns { ok, sessionId, cliSessionId, previousBackend } on success.
   */
  async upgradeToSdk(
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string; sessionId?: string; cliSessionId?: string; previousBackend?: string }> {
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };
    if (info.backendType === "claude-sdk") return { ok: false, error: "Session is already using SDK transport" };
    if (info.backendType === "codex") return { ok: false, error: "Cannot upgrade Codex sessions to SDK" };
    if (!info.cliSessionId) return { ok: false, error: "Session has no cliSessionId — cannot resume via SDK" };

    const previousBackend = info.backendType || "claude";
    const cliSessionId = info.cliSessionId;
    console.log(
      `[cli-launcher] Upgrading session ${sessionTag(sessionId)} from ${previousBackend} to claude-sdk (cliSessionId: ${cliSessionId})`,
    );

    // Kill the WebSocket CLI process if running
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill("SIGTERM");
      await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]).then((exited) => {
        if (!exited) proc.kill("SIGKILL");
      });
      this.processes.delete(sessionId);
    }

    // Switch backend type and mark as exited so relaunch() will spawn fresh
    info.backendType = "claude-sdk";
    info.state = "exited";
    this.persistState();

    // Relaunch with new backend — relaunch() reads info.backendType and
    // routes to spawnClaudeSdk(), which passes info.cliSessionId to the
    // SDK adapter for resumption via unstable_v2_resumeSession().
    const result = await this.relaunch(sessionId);
    if (!result.ok) {
      // Revert on failure
      info.backendType = previousBackend as "claude";
      this.persistState();
      return { ok: false, error: result.error || "Relaunch failed after transport upgrade" };
    }

    return { ok: true, sessionId, cliSessionId, previousBackend };
  }

  /**
   * Downgrade an SDK ("claude-sdk") session to WebSocket ("claude") transport.
   *
   * Disconnects the SDK adapter, changes backendType to "claude", and relaunches
   * using the WebSocket CLI with --resume and the same cliSessionId. Symmetric
   * to upgradeToSdk().
   */
  async downgradeToWebSocket(
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string; sessionId?: string; cliSessionId?: string; previousBackend?: string }> {
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };
    if (info.backendType === "claude") return { ok: false, error: "Session is already using WebSocket transport" };
    if (info.backendType === "codex") return { ok: false, error: "Cannot downgrade Codex sessions to WebSocket" };
    if (!info.cliSessionId) return { ok: false, error: "Session has no cliSessionId — cannot resume via WebSocket" };

    const previousBackend = info.backendType;
    const cliSessionId = info.cliSessionId;
    console.log(
      `[cli-launcher] Downgrading session ${sessionTag(sessionId)} from ${previousBackend} to claude (cliSessionId: ${cliSessionId})`,
    );

    // Switch backend type and mark as exited so relaunch() will spawn WebSocket CLI.
    // The SDK adapter will be disconnected by the bridge when it detects the state change.
    info.backendType = "claude";
    info.state = "exited";
    this.persistState();

    // Relaunch with WebSocket backend — relaunch() reads info.backendType and
    // routes to spawnCLI(), which passes --resume with the cliSessionId.
    const result = await this.relaunch(sessionId);
    if (!result.ok) {
      // Revert on failure
      info.backendType = previousBackend as "claude-sdk";
      this.persistState();
      return { ok: false, error: result.error || "Relaunch failed after transport downgrade" };
    }

    return { ok: true, sessionId, cliSessionId, previousBackend };
  }
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
   * Update the last human user message timestamp for a session.
   * Only called for direct human input, not programmatic agent/system/herd messages.
   */
  touchUserMessage(sessionId: string, timestamp = Date.now()): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      const normalizedTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
      const nextTimestamp = Math.max(info.lastUserMessageAt ?? 0, normalizedTimestamp);
      if (info.lastUserMessageAt === nextTimestamp) return;
      info.lastUserMessageAt = nextTimestamp;
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
      if (!archived) {
        info.worktreeCleanupStatus = undefined;
        info.worktreeCleanupError = undefined;
        info.worktreeCleanupStartedAt = undefined;
        info.worktreeCleanupFinishedAt = undefined;
      }
      // Clean up herd relationships when a leader is archived
      if (archived && info.isOrchestrator) {
        for (const worker of this.sessions.values()) {
          if (worker.herdedBy === sessionId) {
            worker.herdedBy = undefined;
          }
        }
        this.onHerdChange?.({ type: "membership_changed", leaderId: sessionId });
      }
      // Clean up herd relationship when a worker is archived
      if (archived && info.herdedBy) {
        const leaderId = info.herdedBy;
        info.herdedBy = undefined;
        // Also detach any reviewers attached to this worker (mirrors unherdSession)
        if (info.sessionNum !== undefined) {
          for (const reviewer of this.sessions.values()) {
            if (!reviewer.archived && reviewer.reviewerOf === info.sessionNum && reviewer.herdedBy === leaderId) {
              reviewer.herdedBy = undefined;
            }
          }
        }
        this.onHerdChange?.({ type: "membership_changed", leaderId });
      }
      this.persistState();
    }
  }

  setWorktreeCleanupState(
    sessionId: string,
    updates: {
      status?: "pending" | "done" | "failed";
      error?: string;
      startedAt?: number;
      finishedAt?: number;
    },
  ): void {
    const info = this.sessions.get(sessionId);
    if (!info) return;
    info.worktreeCleanupStatus = updates.status;
    info.worktreeCleanupError = updates.error;
    info.worktreeCleanupStartedAt = updates.startedAt;
    info.worktreeCleanupFinishedAt = updates.finishedAt;
    this.persistState();
  }

  // ─── Cat herding (orchestrator→worker relationships) ─────────────────────

  /**
   * Herd worker sessions under an orchestrator. Each session can only have
   * one leader — if already herded by someone else, it's reported as a conflict.
   * Re-herding by the same orchestrator is idempotent.
   */
  herdSessions(orchId: string, workerIds: string[], options?: { force?: boolean }): HerdSessionsResponse {
    const herded: string[] = [];
    const notFound: string[] = [];
    const conflicts: Array<{ id: string; herder: string }> = [];
    const reassigned: Array<{ id: string; fromLeader: string }> = [];
    const leaders: string[] = [];
    const changedLeaders = new Set<string>();
    const force = options?.force === true;
    for (const wid of workerIds) {
      const worker = this.sessions.get(wid);
      if (!worker) {
        notFound.push(wid);
        continue;
      }
      // Leaders/orchestrators cannot be herded — they are not workers
      if (worker.isOrchestrator) {
        leaders.push(wid);
        continue;
      }
      const attachedReviewers =
        worker.sessionNum === undefined
          ? []
          : Array.from(this.sessions.values()).filter(
              (session) => !session.archived && session.reviewerOf === worker.sessionNum,
            );

      if (worker.herdedBy && worker.herdedBy !== orchId) {
        if (!force) {
          conflicts.push({ id: wid, herder: worker.herdedBy });
          continue;
        }
        this.onHerdChange?.({
          type: "reassigned",
          workerId: wid,
          fromLeaderId: worker.herdedBy,
          toLeaderId: orchId,
          reviewerCount: attachedReviewers.length,
        });
        reassigned.push({ id: wid, fromLeader: worker.herdedBy });
        changedLeaders.add(worker.herdedBy);
      }

      worker.herdedBy = orchId;
      changedLeaders.add(orchId);
      // Reviewers are operationally attached to their parent worker. If the
      // worker changes herd ownership, keep reviewer access aligned so the
      // new leader can actually message/reuse the nested reviewer sessions.
      for (const reviewer of attachedReviewers) {
        if (reviewer.herdedBy && reviewer.herdedBy !== orchId) {
          changedLeaders.add(reviewer.herdedBy);
        }
        reviewer.herdedBy = orchId;
      }
      herded.push(wid);
    }
    if (herded.length > 0) {
      this.persistState();
      for (const leaderId of changedLeaders) {
        this.onHerdChange?.({ type: "membership_changed", leaderId });
      }
    }
    return { herded, notFound, conflicts, reassigned, leaders };
  }

  /**
   * Remove an orchestrator's herding claim from a worker session.
   * Returns true if the relationship existed and was removed.
   */
  unherdSession(orchId: string, workerId: string): boolean {
    const worker = this.sessions.get(workerId);
    if (!worker?.herdedBy || worker.herdedBy !== orchId) return false;
    const attachedReviewers =
      worker.sessionNum === undefined
        ? []
        : Array.from(this.sessions.values()).filter(
            (session) => !session.archived && session.reviewerOf === worker.sessionNum && session.herdedBy === orchId,
          );
    worker.herdedBy = undefined;
    for (const reviewer of attachedReviewers) {
      reviewer.herdedBy = undefined;
    }
    this.persistState();
    this.onHerdChange?.({ type: "membership_changed", leaderId: orchId });
    return true;
  }

  /**
   * Get all sessions herded by a specific orchestrator.
   */
  getHerdedSessions(orchId: string): SdkSessionInfo[] {
    const result: SdkSessionInfo[] = [];
    for (const s of this.sessions.values()) {
      if (s.herdedBy === orchId && !s.archived) result.push(s);
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
    knownSessionNums.delete(sessionId);
    this.persistState();
  }

  /**
   * Write a session-auth file to ~/.companion/session-auth/.
   * Keyed by cwd hash + server id so multiple Companion instances sharing
   * the same repo/worktree do not overwrite each other's auth context.
   */
  private async writeSessionAuthFile(cwd: string, sessionId: string, authToken: string, port: number): Promise<void> {
    const authFilePath = getSessionAuthPath(cwd, this.serverId);
    try {
      await mkdir(getSessionAuthDir(), { recursive: true });
      const data = JSON.stringify({ sessionId, authToken, port, serverId: this.serverId }, null, 2);
      await writeFile(authFilePath, data, { mode: 0o600 });
    } catch (err) {
      console.warn(`[cli-launcher] Failed to write session-auth file to ${authFilePath}:`, err);
    }
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

  logCodexProcessSnapshotForSession(sessionId: string, reason: string): void {
    const info = this.sessions.get(sessionId);
    if (!info || info.backendType !== "codex" || !info.pid) return;
    void this.logCodexProcessSnapshot(sessionId, info.pid, reason);
  }

  private async logCodexProcessSnapshot(sessionId: string, pid: number, reason: string): Promise<void> {
    const lines = await captureProcessSnapshot(pid);
    if (lines.length === 0) {
      console.log(
        `[cli-launcher] Codex process snapshot unavailable for session ${sessionTag(sessionId)} (reason=${reason}, pid=${pid})`,
      );
      return;
    }
    console.log(`[cli-launcher] Codex process snapshot for session ${sessionTag(sessionId)} (${reason}, pid=${pid}):`);
    for (const line of lines) {
      console.log(`[cli-launcher]   ${line}`);
    }
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
    tailLines?: string[],
    onText?: (text: string) => void,
  ): Promise<void> {
    await pipeLauncherStream({
      sessionId,
      stream,
      label,
      tailLines,
      onText,
      getSessionNum: (id) => this.getSessionNum(id),
      codexTokenRefreshNoiseBySession: this.codexTokenRefreshNoiseBySession,
    });
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
