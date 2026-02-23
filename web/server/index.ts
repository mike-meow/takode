process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

// Enrich process PATH at startup so binary resolution and `which` calls can find
// binaries installed via version managers (nvm, volta, fnm, etc.).
// Critical when running as a launchd/systemd service with a restricted PATH.
import { getEnrichedPath } from "./path-resolver.js";
process.env.PATH = getEnrichedPath();

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { WorktreeTracker } from "./worktree-tracker.js";
import { containerManager } from "./container-manager.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { TerminalManager } from "./terminal-manager.js";
import { generateFirstName, evaluateSessionName } from "./session-namer.js";
import * as sessionNames from "./session-names.js";
import { getActiveQuestForSession } from "./quest-store.js";
import { getSettings, getServerName, initWithPort } from "./settings-manager.js";
import { PushoverNotifier } from "./pushover.js";
import { PRPoller } from "./pr-poller.js";
import { RecorderManager } from "./recorder.js";
import { CronScheduler } from "./cron-scheduler.js";
import { ImageStore } from "./image-store.js";
import { IdleManager } from "./idle-manager.js";
import { ensureQuestmasterIntegration } from "./quest-integration.js";
import { recreateWorktreeIfMissing } from "./migration.js";
import { existsSync } from "node:fs";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__COMPANION_PACKAGE_ROOT || resolve(__dirname, "..");

import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD, RESTART_EXIT_CODE } from "./constants.js";
import { initServerLogger } from "./server-logger.js";

const defaultPort = process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
const port = Number(process.env.PORT) || defaultPort;

// Initialize file-based logging before anything else logs
initServerLogger(port);

initWithPort(port);
const sessionStore = new SessionStore(undefined, port);
const wsBridge = new WsBridge();
const launcher = new CliLauncher(port);
const worktreeTracker = new WorktreeTracker();
const CONTAINER_STATE_PATH = join(homedir(), ".companion", "containers.json");
const terminalManager = new TerminalManager();
const prPoller = new PRPoller(wsBridge);
const recorder = new RecorderManager();
const imageStore = new ImageStore();
const cronScheduler = new CronScheduler(launcher, wsBridge);
const pushoverNotifier = new PushoverNotifier({
  getSettings: () => {
    const s = getSettings();
    return {
      pushoverUserKey: s.pushoverUserKey,
      pushoverApiToken: s.pushoverApiToken,
      pushoverDelaySeconds: s.pushoverDelaySeconds,
      pushoverEnabled: s.pushoverEnabled,
    };
  },
  getBaseUrl: () => getSettings().pushoverBaseUrl || `http://localhost:${port}`,
  getServerName: () => getServerName() || "Companion",
  getSessionName: (id) => sessionNames.getName(id),
  getSessionActivity: (id) => wsBridge.getSessionActivityPreview(id),
  getLastReadAt: (id) => wsBridge.getSessionAttentionState(id)?.lastReadAt ?? 0,
});

// ── Wire settings getter so relaunch picks up custom binary settings ────────
launcher.setSettingsGetter(getSettings);

// ── Restore persisted sessions from disk ────────────────────────────────────
wsBridge.setStore(sessionStore);
wsBridge.setRecorder(recorder);
wsBridge.setImageStore(imageStore);
wsBridge.setPushoverNotifier(pushoverNotifier);
wsBridge.setLauncher(launcher);
launcher.setStore(sessionStore);
launcher.setRecorder(recorder);
launcher.restoreFromDisk();
wsBridge.restoreFromDisk();
containerManager.restoreState(CONTAINER_STATE_PATH);

// When the CLI reports its internal session_id, store it for --resume on relaunch
wsBridge.onCLISessionIdReceived((sessionId, cliSessionId) => {
  launcher.setCLISessionId(sessionId, cliSessionId);
});

// When a Codex adapter is created, attach it to the WsBridge
launcher.onCodexAdapterCreated((sessionId, adapter) => {
  wsBridge.attachCodexAdapter(sessionId, adapter);
});

// Start watching PRs when git info is resolved for a session
wsBridge.onSessionGitInfoReadyCallback((sessionId, cwd, branch) => {
  prPoller.watch(sessionId, cwd, branch);
});

// Auto-relaunch CLI when a browser connects to a session with no CLI
const relaunchingSet = new Set<string>();
wsBridge.onCLIRelaunchNeededCallback(async (sessionId) => {
  if (relaunchingSet.has(sessionId)) return;
  const info = launcher.getSession(sessionId);
  if (info?.archived) return;
  if (info && info.state !== "starting") {
    relaunchingSet.add(sessionId);

    // If cwd doesn't exist, try to recreate worktree (e.g. after migration)
    if (!existsSync(info.cwd)) {
      if (info.isWorktree && info.repoRoot && info.branch) {
        try {
          const wtResult = recreateWorktreeIfMissing(sessionId, info, { launcher, worktreeTracker, wsBridge });
          if (wtResult.error) {
            wsBridge.broadcastToSession(sessionId, { type: "error", message: wtResult.error });
            relaunchingSet.delete(sessionId);
            return;
          }
          if (wtResult.recreated) {
            console.log(`[server] Recreated worktree for session ${sessionId} before relaunch`);
          }
        } catch (e) {
          wsBridge.broadcastToSession(sessionId, {
            type: "error",
            message: `Failed to recreate worktree: ${e instanceof Error ? e.message : String(e)}`,
          });
          relaunchingSet.delete(sessionId);
          return;
        }
      } else {
        wsBridge.broadcastToSession(sessionId, {
          type: "error",
          message: `Working directory not found: ${info.cwd}`,
        });
        relaunchingSet.delete(sessionId);
        return;
      }
    }

    console.log(`[server] Auto-relaunching CLI for session ${sessionId}`);
    try {
      const result = await launcher.relaunch(sessionId);
      if (!result.ok && result.error) {
        wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
      }
    } finally {
      setTimeout(() => relaunchingSet.delete(sessionId), 5000);
    }
  }
});

// Restart CLI when ask permission mode changes (updates launcher state + relaunches)
wsBridge.onPermissionModeChangedCallback(async (sessionId, newMode) => {
  if (relaunchingSet.has(sessionId)) return;
  const info = launcher.getSession(sessionId);
  if (!info || info.archived) return;
  // Update the launcher's stored permission mode before relaunching
  info.permissionMode = newMode;
  relaunchingSet.add(sessionId);
  console.log(`[server] Relaunching CLI for session ${sessionId} with permission mode: ${newMode}`);
  try {
    const result = await launcher.relaunch(sessionId);
    if (!result.ok && result.error) {
      wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
    }
  } finally {
    setTimeout(() => relaunchingSet.delete(sessionId), 5000);
  }
});

// Track which sessions have had at least one auto-naming evaluation
const autoNamingEvaluated = new Set<string>();
// Track the history index at which the current name was derived, so subsequent
// evaluations only show the model events that happened *since* the name was set.
const nameSetAtHistoryIndex = new Map<string, number>();
// Track when a name was last applied, to prevent rapid successive evaluations
// (e.g. user-message namer + turn-completed namer both firing within the same turn).
const nameLastAppliedAt = new Map<string, number>();

// ─── Namer cancellation ─────────────────────────────────────────────────────
// Each new namer invocation for a session cancels any in-flight one (kills the
// `claude -p` subprocess) to avoid races and wasted work.
const inFlightNamer = new Map<string, AbortController>();

/** Cancel any in-flight namer for this session and return a fresh AbortController. */
function beginNamerCall(sessionId: string): AbortController {
  inFlightNamer.get(sessionId)?.abort();
  const controller = new AbortController();
  inFlightNamer.set(sessionId, controller);
  return controller;
}

/** Clean up AbortController after a namer call completes (only if it's still the current one). */
function endNamerCall(sessionId: string, controller: AbortController): void {
  if (inFlightNamer.get(sessionId) === controller) inFlightNamer.delete(sessionId);
}

/** Find the ID of the last user_message in a history array (for task entry tracking). */
function findLastUserMessageId(history: import("./session-types.js").BrowserIncomingMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.type === "user_message" && msg.id) return msg.id;
  }
  return `unknown-${Date.now()}`;
}

/** Find the index of the last user_message in history.
 *  Used to set nameSetAtHistoryIndex so subsequent evaluations include
 *  the triggering user message (buildConversationBlock needs a user_message
 *  to start a turn — without it, agent activity would be orphaned). */
function findLastUserMessageIndex(history: import("./session-types.js").BrowserIncomingMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].type === "user_message") return i;
  }
  return 0;
}

/** Check if a session name is a random two-word placeholder (e.g. "Deep Reef"). */
function isRandomSessionName(name: string | null | undefined): boolean {
  return !!name && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(name);
}

/** Look up the active quest for a session and map to the namer's expected shape. */
function getClaimedQuestForNamer(sessionId: string): { id: string; title: string } | null {
  const quest = getActiveQuestForSession(sessionId);
  if (!quest) return null;
  return { id: quest.questId, title: quest.title };
}

/** Apply a naming result: set name, broadcast, add task entry. Shared by all triggers. */
function applyNamingResult(
  sessionId: string,
  previousName: string,
  result: import("./session-namer.js").NamingResult,
  history: import("./session-types.js").BrowserIncomingMessage[],
): void {
  // Merge keywords regardless of naming action
  if (result.keywords?.length) {
    wsBridge.mergeKeywords(sessionId, result.keywords);
  }

  switch (result.action) {
    case "no_change":
      break;
    case "revise": {
      const freshName = sessionNames.getName(sessionId);
      if (freshName !== previousName) return; // name changed while we were evaluating
      sessionNames.setName(sessionId, result.title);
      nameSetAtHistoryIndex.set(sessionId, findLastUserMessageIndex(history));
      nameLastAppliedAt.set(sessionId, Date.now());
      wsBridge.broadcastNameUpdate(sessionId, result.title);
      wsBridge.addTaskEntry(sessionId, {
        title: result.title,
        action: "revise",
        timestamp: Date.now(),
        triggerMessageId: findLastUserMessageId(history),
      });
      console.log(`[session-namer] Revised session ${sessionId}: "${previousName}" → "${result.title}"`);
      break;
    }
    case "new": {
      const freshName = sessionNames.getName(sessionId);
      if (freshName !== previousName) return;
      sessionNames.setName(sessionId, result.title);
      nameSetAtHistoryIndex.set(sessionId, findLastUserMessageIndex(history));
      nameLastAppliedAt.set(sessionId, Date.now());
      wsBridge.broadcastNameUpdate(sessionId, result.title);
      wsBridge.addTaskEntry(sessionId, {
        title: result.title,
        action: "new",
        timestamp: Date.now(),
        triggerMessageId: findLastUserMessageId(history),
      });
      console.log(`[session-namer] New task in session ${sessionId}: "${previousName}" → "${result.title}"`);
      break;
    }
  }
}

// ─── Shared helper: evaluate and apply naming for a session ─────────────────
// Used by all three callbacks. Handles both named and unnamed sessions.
async function evaluateAndApply(
  sessionId: string,
  history: import("./session-types.js").BrowserIncomingMessage[],
  cwd: string,
  signal: AbortSignal,
  isGenerating: boolean,
  trigger: string,
): Promise<void> {
  const currentName = sessionNames.getName(sessionId);
  const isRandomName = isRandomSessionName(currentName);
  const claimedQuest = getClaimedQuestForNamer(sessionId);
  const startIndex = nameSetAtHistoryIndex.get(sessionId) ?? 0;
  const relevantHistory = isRandomName ? history : history.slice(startIndex);
  const taskHistory = wsBridge.getSessionTaskHistory(sessionId);

  console.log(`[session-namer] ${trigger} — evaluating session ${sessionId} (current: ${isRandomName ? "(unnamed)" : `"${currentName}"`}, history: ${relevantHistory.length}/${history.length} msgs, generating: ${isGenerating})...`);

  const result = await evaluateSessionName(
    sessionId,
    currentName ?? "",
    relevantHistory,
    cwd,
    { signal, isGenerating, claimedQuest, isUnnamed: isRandomName || !currentName },
    taskHistory,
  );
  if (signal.aborted) return;
  if (!result) return;
  applyNamingResult(sessionId, currentName ?? "", result, history);
}

// Continuous session auto-naming via Claude Haiku (triggered on each user message)
wsBridge.onUserMessageCallback(async (sessionId, history, cwd, wasGenerating) => {
  // Suppress auto-namer while a quest is active — quest title IS the session name
  if (getActiveQuestForSession(sessionId)) {
    console.log(`[session-namer] Skipping user-message namer for ${sessionId} (active quest)`);
    return;
  }
  const currentName = sessionNames.getName(sessionId);
  const isRandomName = isRandomSessionName(currentName);
  const isFirstEvaluation = !autoNamingEvaluated.has(sessionId);
  // wasGenerating reflects whether the agent was already generating BEFORE
  // this user message was sent (the callback fires after setGenerating(true),
  // so reading session.isGenerating here would always be true).
  const isGenerating = wasGenerating;

  // Cancel any in-flight namer for this session
  const controller = beginNamerCall(sessionId);
  const { signal } = controller;

  try {
    if (isFirstEvaluation) {
      autoNamingEvaluated.add(sessionId);
    }

    if (isFirstEvaluation && (!currentName || isRandomName)) {
      // First user message with no real name: generate initial name (one attempt only).
      // If this fails (e.g. Haiku can't generate from a brief prompt), we give up.
      // Subsequent triggers (turn completed, agent paused, next user message) will
      // use the evaluate flow with isUnnamed=true to try again with richer context.
      const claimedQuest = getClaimedQuestForNamer(sessionId);
      console.log(`[session-namer] Generating initial name for session ${sessionId}...`);
      const result = await generateFirstName(sessionId, history, cwd, { signal, isGenerating, claimedQuest });
      if (signal.aborted) return;
      if (!result || result.action !== "name") return;
      // Don't overwrite if user renamed while we were generating
      const freshName = sessionNames.getName(sessionId);
      if (freshName && !isRandomSessionName(freshName)) return;
      sessionNames.setName(sessionId, result.title);
      nameSetAtHistoryIndex.set(sessionId, findLastUserMessageIndex(history));
      nameLastAppliedAt.set(sessionId, Date.now());
      wsBridge.broadcastNameUpdate(sessionId, result.title);
      wsBridge.addTaskEntry(sessionId, {
        title: result.title,
        action: "name",
        timestamp: Date.now(),
        triggerMessageId: findLastUserMessageId(history),
      });
      if (result.keywords?.length) {
        wsBridge.mergeKeywords(sessionId, result.keywords);
      }
      console.log(`[session-namer] Named session ${sessionId}: "${result.title}"`);
    } else if (currentName) {
      // Subsequent user messages: evaluate whether to rename.
      // If name is still random (initial attempt failed), the evaluate prompt
      // tells the model the name is unknown so it generates one from context.
      await evaluateAndApply(sessionId, history, cwd, signal, isGenerating, "User message");
    }
  } finally {
    endNamerCall(sessionId, controller);
  }
});

// Re-evaluate session name when agent pauses for plan approval (ExitPlanMode).
// The agent has done meaningful research/work to produce the plan, providing
// rich context for naming — and it's a natural breakpoint before execution.
wsBridge.onAgentPausedCallback(async (sessionId, history, cwd) => {
  if (getActiveQuestForSession(sessionId)) {
    console.log(`[session-namer] Skipping agent-paused namer for ${sessionId} (active quest)`);
    return;
  }
  const currentName = sessionNames.getName(sessionId);
  if (!currentName) return;

  const controller = beginNamerCall(sessionId);
  const { signal } = controller;

  try {
    await evaluateAndApply(sessionId, history, cwd, signal, true, "Agent paused");
  } finally {
    endNamerCall(sessionId, controller);
  }
});

// Re-evaluate session name after agent completes a turn.
// This lets Haiku refine the title based on what the agent actually did,
// and improves the initial name after the first turn.
//
// Cooldown: if a name was applied within the last 30s (e.g. by the user-message
// namer for the same turn), skip re-evaluation to prevent duplicate task entries.
const NAMER_COOLDOWN_MS = 30_000;

wsBridge.onTurnCompletedCallback(async (sessionId, history, cwd) => {
  if (getActiveQuestForSession(sessionId)) {
    console.log(`[session-namer] Skipping turn-completed namer for ${sessionId} (active quest)`);
    return;
  }
  const currentName = sessionNames.getName(sessionId);
  if (!currentName) return;

  // Skip if a name was just applied (prevents rapid first-name → immediate-revise)
  const lastApplied = nameLastAppliedAt.get(sessionId) ?? 0;
  if (Date.now() - lastApplied < NAMER_COOLDOWN_MS) {
    console.log(`[session-namer] Turn completed — skipping evaluation for ${sessionId} (name was applied ${Date.now() - lastApplied}ms ago)`);
    return;
  }

  // Cancel any in-flight namer (e.g. from a user message that triggered just before completion)
  const controller = beginNamerCall(sessionId);
  const { signal } = controller;

  try {
    await evaluateAndApply(sessionId, history, cwd, signal, false, "Turn completed");
  } finally {
    endNamerCall(sessionId, controller);
  }
});

console.log(`[server] Session persistence: ${sessionStore.directory}`);
if (recorder.isGloballyEnabled()) {
  console.log(`[server] Recording enabled (dir: ${recorder.getRecordingsDir()}, max: ${recorder.getMaxLines()} lines)`);
}

const app = new Hono();

app.use("/api/*", cors());
app.route("/api", createRoutes(launcher, wsBridge, sessionStore, worktreeTracker, terminalManager, prPoller, recorder, cronScheduler, imageStore, pushoverNotifier, { requestRestart }));

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

const server = Bun.serve<SocketData>({
  hostname: process.env.COMPANION_HOST || "0.0.0.0",
  port,
  maxRequestBodySize: 1024 * 1024 * 1024, // 1 GB — needed for migration import
  async fetch(req, server) {
    const url = new URL(req.url);

    // ── CLI WebSocket — Claude Code CLI connects here via --sdk-url ────
    const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const sessionId = cliMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "cli" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Browser WebSocket — connects to a specific session ─────────────
    const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      const sessionId = browserMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "browser" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Terminal WebSocket — embedded terminal PTY connection ─────────
    const termMatch = url.pathname.match(/^\/ws\/terminal\/([a-f0-9-]+)$/);
    if (termMatch) {
      const terminalId = termMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "terminal" as const, terminalId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    idleTimeout: 0, // Disable Bun's idle timeout; we manage liveness via ws.ping heartbeats
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      } else if (data.kind === "terminal") {
        terminalManager.addBrowserSocket(ws);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      } else if (data.kind === "terminal") {
        terminalManager.handleBrowserMessage(ws, msg);
      }
    },
    close(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws);
      } else if (data.kind === "terminal") {
        terminalManager.removeBrowserSocket(ws);
      }
    },
  },
});

// Start server→browser heartbeat to prevent idle timeout disconnections
wsBridge.startHeartbeat();

// Start watchdog to detect sessions stuck in "generating" state
wsBridge.startStuckSessionWatchdog();

console.log(`Server running on http://localhost:${server.port}`);
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: frontend at http://localhost:5174");
}

if (!process.env.COMPANION_SUPERVISED) {
  console.warn("[server] WARNING: Not started via 'make dev' or 'make serve' — the Restart Server button will not work.");
  console.warn("[server]          Use 'make dev' (dev) or 'make serve' (prod) for restart support.");
}

// ── Cron scheduler ──────────────────────────────────────────────────────────
cronScheduler.startAll();

// ── Questmaster CLI integration ─────────────────────────────────────────────
ensureQuestmasterIntegration(port, packageRoot);

// ── Idle session manager — enforce maxKeepAlive ─────────────────────────────
const idleManager = new IdleManager(launcher, wsBridge, getSettings);
idleManager.start();

// ── Shutdown helpers ─────────────────────────────────────────────────────────
function performShutdown() {
  console.log("[server] Persisting state before shutdown...");
  idleManager.stop();
  sessionStore.flushAll();
  containerManager.persistState(CONTAINER_STATE_PATH);
  pushoverNotifier.destroy();
}

function gracefulShutdown() {
  performShutdown();
  process.exit(0);
}

function requestRestart() {
  // Delay exit so the HTTP response can flush to the browser
  setTimeout(() => {
    console.log("[server] Restart requested, exiting with code 42...");
    performShutdown();
    process.exit(RESTART_EXIT_CODE);
  }, 500);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ── Reconnection watchdog ────────────────────────────────────────────────────
// After a server restart, restored CLI processes may not reconnect their
// WebSocket. Give them a grace period, then kill + relaunch any that are
// still in "starting" state (alive but no WS connection).
const RECONNECT_GRACE_MS = Number(process.env.COMPANION_RECONNECT_GRACE_MS || "30000");
const starting = launcher.getStartingSessions();
if (starting.length > 0) {
  console.log(`[server] Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
  setTimeout(async () => {
    const stale = launcher.getStartingSessions();
    for (const info of stale) {
      if (info.archived) continue;
      console.log(`[server] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
      await launcher.relaunch(info.sessionId);
    }
  }, RECONNECT_GRACE_MS);
}
