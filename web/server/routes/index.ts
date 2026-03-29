import { Hono, type Context } from "hono";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { access as accessAsync } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { SessionStore } from "../session-store.js";
import type { WorktreeTracker } from "../worktree-tracker.js";
import type { TerminalManager } from "../terminal-manager.js";
import type { PerfTracer } from "../perf-tracer.js";
import { GIT_CMD_TIMEOUT } from "../constants.js";
import { validateCompanionAuth } from "./auth.js";
import { createSessionsRoutes } from "./sessions.js";
import { createGitRoutes } from "./git.js";
import { createFilesystemRoutes } from "./filesystem.js";
import { createSettingsRoutes } from "./settings.js";
import { createTranscriptionRoutes } from "./transcription.js";
import { createTakodeRoutes } from "./takode.js";
import { createQuestRoutes } from "./quests.js";
import { createRecordingsRoutes } from "./recordings.js";
import { createSystemRoutes } from "./system.js";
import type { InitialModeState, RouteContext } from "./context.js";

// Keep legacy semantics after moving from server/routes.ts to server/routes/index.ts
const ROUTES_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = dirname(ROUTES_DIR);

const execPromise = promisify(execCb);

async function pathExists(path: string): Promise<boolean> {
  try {
    await accessAsync(path);
    return true;
  } catch {
    return false;
  }
}

/** Initial user message injected into leader/orchestrator sessions on startup.
 *  Kept minimal -- the heavy orchestration instructions live in the system prompt
 *  (built by cli-launcher.ts). This message just sets the startup behavior. */
export function buildOrchestratorSystemPrompt(backend: "claude" | "codex" | "claude-sdk"): string {
  const isCodexLeader = backend === "codex";

  return (
    `[System] You are a leader session. Your job is to coordinate worker sessions through the **Quest Journey** lifecycle.\n\n` +
    (isCodexLeader
      ? `**Role**: Keep your own work to triage, coordination, and short spot checks. Delegate non-trivial implementation, investigation, and verification to worker sessions. ` +
        `Use the orchestration instructions already loaded in this session as your source of truth. Do not assume Claude-specific tools or files exist.\n\n`
      : `**Role**: Keep your own work lightweight and stay responsive to herd events. Delegate larger work to worker sessions. ` +
        `Read your project's instruction files for full orchestration documentation and workflow guidelines.\n\n`) +
    `**Quest Journey**: Use \`takode board show\` to track each quest's state (PLANNED -> DISPATCHED -> PLAN_APPROVED -> SKEPTIC_REVIEWED -> GROOM_SENT -> GROOMED -> PORT_REQUESTED -> removed). ` +
    `Use \`takode board advance <quest-id>\` to transition quests through the lifecycle.\n\n` +
    `**On startup**: Load the \`takode-orchestration\` and \`quest\` skills for full CLI references. Then acknowledge you're ready and wait for the user's instructions. Do NOT automatically herd sessions or run commands until the user tells you what to do.`
  );
}

/** Non-blocking exec — runs a shell command without stalling the event loop. */
async function execAsync(command: string, cwd: string): Promise<string> {
  const { stdout } = await execPromise(command, { cwd, timeout: GIT_CMD_TIMEOUT });
  return stdout.trim();
}

/** Non-blocking version of execCaptureStdout — always returns stdout even on non-zero exit. */
async function execCaptureStdoutAsync(command: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execPromise(command, { cwd, timeout: GIT_CMD_TIMEOUT });
    return stdout.trim();
  } catch (err: unknown) {
    const maybe = err as { stdout?: string };
    if (typeof maybe.stdout === "string") return maybe.stdout.trim();
    throw err;
  }
}

function resolveInitialModeState(
  backend: "claude" | "codex" | "claude-sdk",
  requestedPermissionMode: unknown,
  askPermissionRequested: boolean,
): InitialModeState {
  if (backend !== "codex") {
    const requested = typeof requestedPermissionMode === "string" ? requestedPermissionMode.trim() : "";
    if (requested === "acceptEdits") {
      return { permissionMode: "acceptEdits", askPermission: true, uiMode: "agent" };
    }
    if (requested === "bypassPermissions") {
      return { permissionMode: "bypassPermissions", askPermission: false, uiMode: "agent" };
    }
    if (requested === "plan") {
      return { permissionMode: "plan", askPermission: askPermissionRequested, uiMode: "plan" };
    }
    const permissionMode = askPermissionRequested ? "plan" : "bypassPermissions";
    return {
      permissionMode,
      askPermission: askPermissionRequested,
      uiMode: permissionMode === "plan" ? "plan" : "agent",
    };
  }

  const requested = typeof requestedPermissionMode === "string" ? requestedPermissionMode.trim() : "";

  switch (requested) {
    case "plan":
      return {
        permissionMode: "plan",
        askPermission: askPermissionRequested,
        uiMode: "plan",
      };
    case "bypassPermissions":
      return {
        permissionMode: "bypassPermissions",
        askPermission: false,
        uiMode: "agent",
      };
    case "suggest":
      return {
        permissionMode: "suggest",
        askPermission: true,
        uiMode: "agent",
      };
    case "acceptEdits":
    case "default":
      return {
        permissionMode: "suggest",
        askPermission: true,
        uiMode: "agent",
      };
    case "agent":
    case "":
    default:
      return {
        permissionMode: askPermissionRequested ? "suggest" : "bypassPermissions",
        askPermission: askPermissionRequested,
        uiMode: "agent",
      };
  }
}

export function createRoutes(
  launcher: CliLauncher,
  wsBridge: WsBridge,
  sessionStore: SessionStore,
  worktreeTracker: WorktreeTracker,
  terminalManager: TerminalManager,
  prPoller?: import("../pr-poller.js").PRPoller,
  recorder?: import("../recorder.js").RecorderManager,
  cronScheduler?: import("../cron-scheduler.js").CronScheduler,
  imageStore?: import("../image-store.js").ImageStore,
  pushoverNotifier?: import("../pushover.js").PushoverNotifier,
  options?: { requestRestart?: () => void },
  perfTracer?: PerfTracer,
  sleepInhibitor?: import("../sleep-inhibitor.js").SleepInhibitor,
) {
  const api = new Hono();

  const resolveId = (raw: string): string | null => launcher.resolveSessionId(raw);

  const authenticateTakodeCaller = (c: Context, opts?: { requireOrchestrator?: boolean }) => {
    const result = validateCompanionAuth(c, launcher, resolveId, {
      required: true,
      requireOrchestrator: opts?.requireOrchestrator,
      headerLabel: "Takode",
    });
    if (result === null) {
      return { response: c.json({ error: "Missing Takode auth headers" }, 403) };
    }
    return result;
  };

  const authenticateCompanionCallerOptional = (c: Context) =>
    validateCompanionAuth(c, launcher, resolveId, {
      required: false,
      headerLabel: "Companion",
    });

  if (perfTracer) {
    api.use("/*", async (c, next) => {
      const start = performance.now();
      await next();
      const ms = performance.now() - start;
      if (ms > perfTracer.httpSlowThresholdMs) {
        perfTracer.recordSlowRequest(c.req.method, c.req.path, ms);
      }
    });
  }

  const ctx: RouteContext = {
    launcher,
    wsBridge,
    sessionStore,
    worktreeTracker,
    terminalManager,
    prPoller,
    recorder,
    cronScheduler,
    imageStore,
    pushoverNotifier,
    sleepInhibitor,
    options,
    perfTracer,
    resolveId,
    authenticateTakodeCaller,
    authenticateCompanionCallerOptional,
    execAsync,
    execCaptureStdoutAsync,
    pathExists,
    ROUTES_DIR,
    WEB_DIR,
    buildOrchestratorSystemPrompt,
    resolveInitialModeState,
  };

  api.route("/", createSystemRoutes(ctx));
  api.route("/", createSessionsRoutes(ctx));
  api.route("/", createTakodeRoutes(ctx));
  api.route("/", createRecordingsRoutes(ctx));
  api.route("/", createFilesystemRoutes(ctx));
  api.route("/", createSettingsRoutes(ctx));
  api.route("/", createTranscriptionRoutes(ctx));
  api.route("/", createGitRoutes(ctx));
  api.route("/", createQuestRoutes(ctx));

  return api;
}
