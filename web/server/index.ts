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
import { getSettings, getServerName, initWithPort } from "./settings-manager.js";
import { PushoverNotifier } from "./pushover.js";
import { PRPoller } from "./pr-poller.js";
import { RecorderManager } from "./recorder.js";
import { CronScheduler } from "./cron-scheduler.js";
import { ImageStore } from "./image-store.js";
import { IdleManager } from "./idle-manager.js";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__COMPANION_PACKAGE_ROOT || resolve(__dirname, "..");

import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "./constants.js";

const defaultPort = process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
const port = Number(process.env.PORT) || defaultPort;
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

// Continuous session auto-naming via Claude Haiku (triggered on each user message)
wsBridge.onUserMessageCallback(async (sessionId, history, cwd) => {
  const currentName = sessionNames.getName(sessionId);
  const isRandomName = currentName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(currentName);
  const isFirstEvaluation = !autoNamingEvaluated.has(sessionId);

  if (isFirstEvaluation) {
    // First user message: generate initial name
    autoNamingEvaluated.add(sessionId);
    console.log(`[session-namer] Generating initial name for session ${sessionId}...`);
    const result = await generateFirstName(sessionId, history, cwd);
    if (!result || result.action !== "name") return;
    // Don't overwrite if user renamed while we were generating
    const freshName = sessionNames.getName(sessionId);
    if (freshName && !isRandomName) return;
    sessionNames.setName(sessionId, result.title);
    nameSetAtHistoryIndex.set(sessionId, history.length);
    wsBridge.broadcastNameUpdate(sessionId, result.title);
    console.log(`[session-namer] Named session ${sessionId}: "${result.title}"`);
  } else {
    // Subsequent messages: evaluate whether to rename.
    // Only show events since the name was last set (the model already knows the title).
    if (!currentName || isRandomName) return; // no real name yet, skip
    const startIndex = nameSetAtHistoryIndex.get(sessionId) ?? 0;
    const relevantHistory = history.slice(startIndex);
    console.log(`[session-namer] Evaluating session ${sessionId} (current: "${currentName}", history: ${relevantHistory.length}/${history.length} msgs)...`);
    const result = await evaluateSessionName(sessionId, currentName, relevantHistory, cwd);
    if (!result) return;

    switch (result.action) {
      case "no_change":
        break;
      case "revise": {
        const freshName = sessionNames.getName(sessionId);
        if (freshName !== currentName) return; // name changed while we were evaluating
        sessionNames.setName(sessionId, result.title);
        nameSetAtHistoryIndex.set(sessionId, history.length);
        wsBridge.broadcastNameUpdate(sessionId, result.title);
        console.log(`[session-namer] Revised session ${sessionId}: "${currentName}" → "${result.title}"`);
        break;
      }
      case "new": {
        const freshName = sessionNames.getName(sessionId);
        if (freshName !== currentName) return;
        sessionNames.setName(sessionId, result.title);
        nameSetAtHistoryIndex.set(sessionId, history.length);
        wsBridge.broadcastNameUpdate(sessionId, result.title);
        console.log(`[session-namer] New task in session ${sessionId}: "${currentName}" → "${result.title}"`);
        break;
      }
    }
  }
});

console.log(`[server] Session persistence: ${sessionStore.directory}`);
if (recorder.isGloballyEnabled()) {
  console.log(`[server] Recording enabled (dir: ${recorder.getRecordingsDir()}, max: ${recorder.getMaxLines()} lines)`);
}

const app = new Hono();

app.use("/api/*", cors());
app.route("/api", createRoutes(launcher, wsBridge, sessionStore, worktreeTracker, terminalManager, prPoller, recorder, cronScheduler, imageStore, pushoverNotifier));

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

const server = Bun.serve<SocketData>({
  hostname: process.env.COMPANION_HOST || "0.0.0.0",
  port,
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

console.log(`Server running on http://localhost:${server.port}`);
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: frontend at http://localhost:5174");
}

// ── Cron scheduler ──────────────────────────────────────────────────────────
cronScheduler.startAll();

// ── Idle session manager — enforce maxKeepAlive ─────────────────────────────
const idleManager = new IdleManager(launcher, wsBridge, getSettings);
idleManager.start();

// ── Graceful shutdown — persist container state ──────────────────────────────
function gracefulShutdown() {
  console.log("[server] Persisting container state before shutdown...");
  idleManager.stop();
  containerManager.persistState(CONTAINER_STATE_PATH);
  pushoverNotifier.destroy();
  process.exit(0);
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
