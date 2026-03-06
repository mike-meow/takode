import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { SessionStore } from "../session-store.js";
import type { WorktreeTracker } from "../worktree-tracker.js";
import type { TerminalManager } from "../terminal-manager.js";
import type { PerfTracer } from "../perf-tracer.js";

export type ResolvedSession = NonNullable<ReturnType<CliLauncher["getSession"]>>;

export type RequiredAuthResult =
  | { callerId: string; caller: ResolvedSession }
  | { response: Response };

export type OptionalAuthResult =
  | { callerId: string; caller: ResolvedSession }
  | { response: Response }
  | null;

export type UiMode = "plan" | "agent";

export interface InitialModeState {
  permissionMode: string;
  askPermission: boolean;
  uiMode: UiMode;
}

export interface RouteContext {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  sessionStore: SessionStore;
  worktreeTracker: WorktreeTracker;
  terminalManager: TerminalManager;
  prPoller?: import("../pr-poller.js").PRPoller;
  recorder?: import("../recorder.js").RecorderManager;
  cronScheduler?: import("../cron-scheduler.js").CronScheduler;
  imageStore?: import("../image-store.js").ImageStore;
  pushoverNotifier?: import("../pushover.js").PushoverNotifier;
  options?: { requestRestart?: () => void };
  perfTracer?: PerfTracer;

  resolveId: (raw: string) => string | null;
  authenticateTakodeCaller: (
    c: import("hono").Context,
    options?: { requireOrchestrator?: boolean },
  ) => RequiredAuthResult;
  authenticateCompanionCallerOptional: (c: import("hono").Context) => OptionalAuthResult;

  execAsync: (command: string, cwd: string) => Promise<string>;
  execCaptureStdoutAsync: (command: string, cwd: string) => Promise<string>;
  pathExists: (path: string) => Promise<boolean>;

  ROUTES_DIR: string;
  WEB_DIR: string;
  buildOrchestratorSystemPrompt: (
    backend: "claude" | "codex" | "claude-sdk",
  ) => string;
  resolveInitialModeState: (
    backend: "claude" | "codex" | "claude-sdk",
    requestedPermissionMode: unknown,
    askPermissionRequested: boolean,
  ) => InitialModeState;
}
