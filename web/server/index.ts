process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

// Increase libuv threadpool size BEFORE any I/O operations.
// Default of 4 threads is too small for NFS — concurrent async I/O operations
// (session saves, git info, recordings) saturate the pool, stalling the event loop
// and causing CLI WebSocket ping/pong timeouts (10s budget). Must be set before
// the first libuv I/O call — Node/Bun reads this value once at initialization.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "64";
}

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
import { COMPANION_CLIENT_IP_HEADER } from "./routes/auth.js";
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
import { bootstrapQuestStore, getActiveQuestForSession, getQuest } from "./quest-store.js";
import { getServerId, getSettings, getServerName, initWithPort } from "./settings-manager.js";
import { PushoverNotifier } from "./pushover.js";
import { PRPoller } from "./pr-poller.js";
import { RecorderManager } from "./recorder.js";
import { CronScheduler } from "./cron-scheduler.js";
import { TimerManager } from "./timer-manager.js";
import { ResourceLeaseManager } from "./resource-lease-manager.js";
import { ResourceLeaseStore } from "./resource-lease-store.js";
import { ImageStore } from "./image-store.js";
import { IdleManager } from "./idle-manager.js";
import { SleepInhibitor } from "./sleep-inhibitor.js";
import { HerdEventDispatcher } from "./herd-event-dispatcher.js";
import { createLauncherHerdChangeHandler } from "./herd-change-handler.js";
import { resumeRestartContinuations } from "./restart-continuation-store.js";
import { runStartupRecovery } from "./startup-recovery.js";
import { markCodexIntentionalRelaunch, markSessionRelaunchPending } from "./bridge/codex-recovery-orchestrator.js";
import {
  addTaskEntry as addTaskEntryController,
  mergeKeywords as mergeKeywordsController,
  markNotificationDoneBySessionId as markNotificationDoneBySessionIdController,
} from "./bridge/session-registry-controller.js";
import * as envManager from "./env-manager.js";
import { ensureQuestmasterIntegration } from "./quest-integration.js";
import { ensureTakodeIntegration } from "./takode-integration.js";
import { ensureBuiltInQuestJourneyPhaseData } from "./quest-journey-phases.js";
import { ensureSkillSymlinks } from "./skill-symlink.js";
import { recreateWorktreeIfMissing } from "./migration.js";
import { access } from "node:fs/promises";
import { RelaunchQueue } from "./relaunch-queue.js";
import {
  shouldAllowUserMessageOverrideOnNameMismatch,
  type NamerMutationRecord,
  type NamerTriggerSource,
} from "./session-namer-arbitration.js";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__COMPANION_PACKAGE_ROOT || resolve(__dirname, "..");

import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD, RESTART_EXIT_CODE } from "./constants.js";
import { createLogger, flushServerLogger, initServerLogger } from "./server-logger.js";
import { initTreeGroupStoreForServer, reconcileSessionTreeGroups } from "./tree-group-store.js";
import { initNewSessionDefaultsStoreForServer } from "./new-session-defaults-store.js";

const defaultPort = process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
const port = Number(process.env.PORT) || defaultPort;

// Initialize file-based logging before anything else logs
initServerLogger(port);
const serverLog = createLogger("server");

await initWithPort(port);
await bootstrapQuestStore({
  log: (message) => serverLog.info(message),
});
const serverId = getServerId();
initTreeGroupStoreForServer({ serverId, port });
initNewSessionDefaultsStoreForServer({ serverId });
const sessionStore = new SessionStore(undefined, port);
const wsBridge = new WsBridge();
const launcher = new CliLauncher(port, { serverId });
const worktreeTracker = new WorktreeTracker();
const CONTAINER_STATE_PATH = join(homedir(), ".companion", "containers.json");
const terminalManager = new TerminalManager();
const prPoller = new PRPoller(wsBridge);
const recorder = new RecorderManager();
const imageStore = new ImageStore();
const cronScheduler = new CronScheduler(launcher, wsBridge);
const timerManager = new TimerManager(wsBridge);
const resourceLeaseManager = new ResourceLeaseManager(wsBridge, new ResourceLeaseStore(serverId));

// ── Performance tracer — event loop lag + slow request/message tracking ──
import { PerfTracer } from "./perf-tracer.js";
const perfTracer = new PerfTracer();
perfTracer.startLagMonitor();
perfTracer.startSummaryLogging();
wsBridge.perfTracer = perfTracer;
serverLog.info(`UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE || "4 (default)"}`);

const pushoverNotifier = new PushoverNotifier({
  getSettings: () => {
    const s = getSettings();
    return {
      pushoverUserKey: s.pushoverUserKey,
      pushoverApiToken: s.pushoverApiToken,
      pushoverDelaySeconds: s.pushoverDelaySeconds,
      pushoverEnabled: s.pushoverEnabled,
      pushoverEventFilters: s.pushoverEventFilters,
    };
  },
  getBaseUrl: () => getSettings().pushoverBaseUrl || `http://localhost:${port}`,
  getServerName: () => getServerName() || "Companion",
  getSessionName: (id) => sessionNames.getName(id),
  getSessionActivity: (id) => wsBridge.getSession(id)?.lastActivityPreview,
  getLastReadAt: (id) => wsBridge.getSession(id)?.lastReadAt ?? 0,
});

function persistSessionTaskHistory(sessionId: string): void {
  const session = wsBridge.getSession(sessionId);
  if (!session) return;
  wsBridge.broadcastToSession(sessionId, { type: "session_task_history", tasks: session.taskHistory } as any);
  wsBridge.persistSessionById(sessionId);
}

function addTaskHistoryEntry(sessionId: string, entry: import("./session-types.js").SessionTaskEntry): void {
  const session = wsBridge.getSession(sessionId);
  if (!session) return;
  addTaskEntryController(session, entry, {
    broadcastTaskHistory: () => persistSessionTaskHistory(sessionId),
    persistSession: () => wsBridge.persistSessionById(sessionId),
  });
}

function mergeSessionKeywords(sessionId: string, keywords: string[]): void {
  const session = wsBridge.getSession(sessionId);
  if (!session) return;
  mergeKeywordsController(session, keywords, {
    persistSession: () => wsBridge.persistSessionById(sessionId),
  });
}

// ── Wire settings getter so relaunch picks up custom binary settings ────────
launcher.setSettingsGetter(getSettings);

// ── Restore persisted sessions from disk ────────────────────────────────────
wsBridge.store = sessionStore;
wsBridge.recorder = recorder;
wsBridge.imageStore = imageStore;
wsBridge.timerManager = timerManager;
wsBridge.pushoverNotifier = pushoverNotifier;
wsBridge.launcher = launcher;
const bridgeAny = wsBridge as any;
wsBridge.sessionNameGetter = (sessionId) => sessionNames.getName(sessionId) || sessionId.slice(0, 8);
wsBridge.resolveQuestTitle = async (questId) => (await getQuest(questId))?.title ?? null;
wsBridge.resolveQuestStatus = async (questId) => (await getQuest(questId))?.status ?? null;
launcher.setStore(sessionStore);
launcher.setRecorder(recorder);
launcher.setEnvResolver(async (slug) => {
  const env = await envManager.getEnv(slug);
  return env?.variables ?? null;
});
await launcher.restoreFromDisk();
await wsBridge.restoreFromDisk();
{
  const restoredSessions = (
    Array.from(bridgeAny.sessions.values()) as Array<{
      id: string;
      state: { treeGroupId?: string };
    }>
  ).map((session) => ({
    sessionId: session.id,
    treeGroupId: session.state.treeGroupId,
  }));
  const reconciliation = await reconcileSessionTreeGroups(restoredSessions);
  for (const update of reconciliation.sessionMetadataUpdates) {
    const session = wsBridge.getSession(update.sessionId);
    if (session) {
      session.state.treeGroupId = update.treeGroupId;
    }
    const persisted = await sessionStore.load(update.sessionId);
    if (!persisted) continue;
    persisted.state.treeGroupId = update.treeGroupId;
    sessionStore.saveSync(persisted);
  }
  if (reconciliation.changed || reconciliation.sessionMetadataUpdates.length > 0) {
    serverLog.info(
      `Reconciled session tree groups for ${restoredSessions.length} session(s): ` +
        `metadataUpdates=${reconciliation.sessionMetadataUpdates.length}, ` +
        `legacyAssignments=${reconciliation.importedLegacyAssignments.length}, ` +
        `legacyGroups=${reconciliation.importedLegacyGroups.length}`,
    );
  }
}
containerManager.restoreState(CONTAINER_STATE_PATH);

// Push-based herd event delivery: wire dispatcher after bridge + launcher are ready
const herdEventDispatcher = new HerdEventDispatcher(wsBridge, launcher, {
  requestCliRelaunch: (sessionId) => wsBridge.onCLIRelaunchNeeded?.(sessionId),
  getSessionNum: (sessionId) => launcher.getSessionNum(sessionId),
  getSessionName: (sessionId) => sessionNames.getName(sessionId),
  getSessions: () => bridgeAny.sessions,
  getLeaderIdleDeps: () => bridgeAny.getSessionRegistryDeps(),
  markNotificationDone: (sessionId, notifId, done) => {
    const notificationDeps = bridgeAny.getSessionNotificationDeps();
    return markNotificationDoneBySessionIdController(bridgeAny.sessions, sessionId, notifId, done, notificationDeps);
  },
});
wsBridge.herdEventDispatcher = herdEventDispatcher;
launcher.onHerdChange = createLauncherHerdChangeHandler({
  dispatcher: herdEventDispatcher,
  wsBridge,
  launcher,
  getSessionName: (sessionId) => sessionNames.getName(sessionId),
});
// Bootstrap for existing orchestrators (server restart recovery)
for (const s of launcher.listSessions()) {
  if (s.isOrchestrator && !s.archived && launcher.getHerdedSessions(s.sessionId).length > 0) {
    herdEventDispatcher.onHerdChanged(s.sessionId);
  }
}

// When the CLI reports its internal session_id, store it for --resume on relaunch
wsBridge.onCLISessionId = (sessionId, cliSessionId) => {
  launcher.setCLISessionId(sessionId, cliSessionId);
};

// When a Codex adapter is created, attach it to the WsBridge
launcher.onCodexAdapterCreated((sessionId, adapter) => {
  wsBridge.attachCodexAdapter(sessionId, adapter);
});

launcher.onClaudeSdkAdapterCreated((sessionId, adapter) => {
  wsBridge.attachClaudeSdkAdapter(sessionId, adapter);
});

// Mark upcoming adapter disconnects as intentional before relaunch kills
// the old process — prevents the disconnect handler from requesting a
// redundant auto-relaunch that races with the in-progress one.
launcher.onBeforeRelaunchCallback((sessionId, backendType) => {
  const bridgeSession = wsBridge.getSession(sessionId);
  if (backendType === "codex") {
    if (bridgeSession) {
      markCodexIntentionalRelaunch(bridgeSession as any, "relaunch", 15_000);
    }
  }
  // Claude SDK sessions use a different intentional-disconnect mechanism
  // (the adapter.disconnect() call in attachClaudeSdkAdapter sets
  // session.codexAdapter = adapter before the old one's callback fires).

  // For all backends: prevent handleCLIOpen from treating the new CLI
  // connection as a seamless reconnect (token refresh). Without this,
  // the system.init handler skips force-clearing stale isGenerating state,
  // leaving phantom queued turns stuck as "running" across relaunches.
  if (bridgeSession) {
    markSessionRelaunchPending(bridgeSession as any);
  }
});

// Start watching PRs when git info is resolved for a session
wsBridge.onGitInfoReady = (sessionId, cwd, branch) => {
  prPoller.watch(sessionId, cwd, branch);
};

const relaunchQueue = new RelaunchQueue(async (sessionId) => {
  const info = launcher.getSession(sessionId);
  if (!info || info.archived) return;
  // Don't auto-relaunch sessions killed by the idle manager — they were
  // intentionally stopped to enforce maxKeepAlive.
  if (info.killedByIdleManager) return;

  // If cwd doesn't exist, try to recreate worktree (e.g. after migration)
  try {
    await access(info.cwd);
  } catch {
    if (info.isWorktree && info.repoRoot && info.branch) {
      try {
        const wtResult = await recreateWorktreeIfMissing(sessionId, info, { launcher, worktreeTracker, wsBridge });
        if (wtResult.error) {
          wsBridge.markCodexAutoRecoveryFailed(sessionId);
          wsBridge.broadcastToSession(sessionId, { type: "error", message: wtResult.error });
          return;
        }
        if (wtResult.recreated) {
          console.log(`[server] Recreated worktree for session ${sessionId} before relaunch`);
        }
      } catch (e) {
        wsBridge.markCodexAutoRecoveryFailed(sessionId);
        wsBridge.broadcastToSession(sessionId, {
          type: "error",
          message: `Failed to recreate worktree: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
    } else {
      wsBridge.markCodexAutoRecoveryFailed(sessionId);
      wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: `Working directory not found: ${info.cwd}`,
      });
      return;
    }
  }

  console.log(`[server] Relaunching session ${sessionId}`);
  const result = await launcher.relaunch(sessionId);
  if (!result.ok) {
    wsBridge.markCodexAutoRecoveryFailed(sessionId);
    if (result.error) {
      wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
    }
  }
});

// Auto-relaunch CLI when a browser connects to a session with no CLI
wsBridge.onCLIRelaunchNeeded = (sessionId) => {
  const info = launcher.getSession(sessionId);
  if (!info || info.archived || info.killedByIdleManager) return;
  // Only suppress relaunch for sessions that are mid-startup AND have an
  // attached backend. After server restart, restored sessions show state
  // "starting" but the old process is orphaned (connected to the dead
  // server's WebSocket) -- relaunching is safe and necessary (q-385).
  if (info.state === "starting" && wsBridge.isBackendAttached(sessionId)) return;
  console.log(`[server] Auto-relaunch requested for session ${sessionId}`);
  relaunchQueue.request(sessionId);
};

// Restart CLI when ask permission mode changes (updates launcher state + relaunches)
wsBridge.onPermissionModeChanged = (sessionId, newMode) => {
  const info = launcher.getSession(sessionId);
  if (!info || info.archived) return;
  // Update the launcher's stored permission mode before relaunching
  info.permissionMode = newMode;
  console.log(`[server] Relaunch requested for session ${sessionId} with permission mode: ${newMode}`);
  relaunchQueue.request(sessionId);
};

// Relaunch backend when runtime setting changes require process restart (Codex).
wsBridge.onSessionRelaunchRequested = (sessionId) => {
  const info = launcher.getSession(sessionId);
  if (!info || info.archived) return;
  console.log(`[server] Relaunch requested for session ${sessionId} after settings update`);
  relaunchQueue.request(sessionId);
};

// Track which sessions have had at least one auto-naming evaluation
const autoNamingEvaluated = new Set<string>();
// Track the history index at which the current name was derived, so subsequent
// evaluations only show the model events that happened *since* the name was set.
const nameSetAtHistoryIndex = new Map<string, number>();
// ─── Namer cancellation ─────────────────────────────────────────────────────
// Each new namer invocation for the same trigger source cancels any in-flight
// one (kills the `claude -p` subprocess) to avoid stale duplicate work.
const inFlightNamer = new Map<string, AbortController>();

/** Record the last naming mutation applied by the auto-namer for race handling. */
const lastAppliedNamerMutation = new Map<string, NamerMutationRecord>();

function getNamerKey(sessionId: string, source: NamerTriggerSource): string {
  return `${sessionId}:${source}`;
}

/** Cancel any in-flight namer for this session/trigger and return a fresh controller. */
function beginNamerCall(sessionId: string, source: NamerTriggerSource): AbortController {
  const key = getNamerKey(sessionId, source);
  inFlightNamer.get(key)?.abort();
  const controller = new AbortController();
  inFlightNamer.set(key, controller);
  return controller;
}

/** Clean up AbortController after a namer call completes (only if still current). */
function endNamerCall(sessionId: string, source: NamerTriggerSource, controller: AbortController): void {
  const key = getNamerKey(sessionId, source);
  if (inFlightNamer.get(key) === controller) inFlightNamer.delete(key);
}

/** Cancel ALL in-flight namer calls for a session (all trigger sources). */
function cancelAllNamersForSession(sessionId: string): void {
  for (const source of ["user_message", "turn_completed", "agent_paused"] as const) {
    const key = getNamerKey(sessionId, source);
    const ctrl = inFlightNamer.get(key);
    if (ctrl) {
      ctrl.abort();
      inFlightNamer.delete(key);
    }
  }
}

function recordNamerMutation(
  sessionId: string,
  source: NamerTriggerSource,
  action: "name" | "revise" | "new",
  nextName: string,
): void {
  lastAppliedNamerMutation.set(sessionId, {
    source,
    action,
    nextName,
    timestamp: Date.now(),
  });
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
async function getClaimedQuestForNamer(sessionId: string): Promise<{ id: string; title: string } | null> {
  const quest = await getActiveQuestForSession(sessionId);
  if (!quest) return null;
  return { id: quest.questId, title: quest.title };
}

/** Check whether a quest owns the session name (suppresses auto-namer).
 *  Checks both the quest store (in_progress quests) AND the session's claimedQuestId
 *  (which persists through review handoff until final done/cancelled). */
async function isQuestOwningSessionName(sessionId: string): Promise<boolean> {
  if (await getActiveQuestForSession(sessionId)) return true;
  const state = wsBridge.getSession(sessionId)?.state;
  return (
    !!state?.claimedQuestId &&
    (state?.claimedQuestStatus === "in_progress" ||
      state?.claimedQuestStatus === "needs_verification" ||
      (state?.claimedQuestStatus === "done" && state.claimedQuestVerificationInboxUnread !== undefined))
  );
}

/** Apply a naming result: set name, broadcast, add task entry. Shared by all triggers. */
async function applyNamingResult(
  sessionId: string,
  previousName: string,
  result: import("./session-namer.js").NamingResult,
  history: import("./session-types.js").BrowserIncomingMessage[],
  source: NamerTriggerSource,
): Promise<void> {
  // Re-check: quest may have been claimed while the namer was in-flight
  if (await isQuestOwningSessionName(sessionId)) {
    console.log(`[session-namer] Discarding namer result for ${sessionId} (quest owns session name)`);
    return;
  }
  // Merge keywords regardless of naming action
  if (result.keywords?.length) {
    mergeSessionKeywords(sessionId, result.keywords);
  }

  switch (result.action) {
    case "no_change":
      break;
    case "revise": {
      const freshName = sessionNames.getName(sessionId);
      if (freshName !== previousName) {
        const allowUserOverride =
          source === "user_message" &&
          shouldAllowUserMessageOverrideOnNameMismatch(freshName, lastAppliedNamerMutation.get(sessionId));
        if (!allowUserOverride) return; // name changed while we were evaluating
      }
      sessionNames.setName(sessionId, result.title);
      nameSetAtHistoryIndex.set(sessionId, findLastUserMessageIndex(history));

      wsBridge.broadcastToSession(sessionId, { type: "session_name_update", name: result.title } as any);
      addTaskHistoryEntry(sessionId, {
        title: result.title,
        action: "revise",
        timestamp: Date.now(),
        triggerMessageId: findLastUserMessageId(history),
      });
      recordNamerMutation(sessionId, source, "revise", result.title);
      console.log(`[session-namer] Revised session ${sessionId}: "${previousName}" → "${result.title}"`);
      break;
    }
    case "new": {
      const freshName = sessionNames.getName(sessionId);
      if (freshName !== previousName) {
        const allowUserOverride =
          source === "user_message" &&
          shouldAllowUserMessageOverrideOnNameMismatch(freshName, lastAppliedNamerMutation.get(sessionId));
        if (!allowUserOverride) return;
      }
      sessionNames.setName(sessionId, result.title);
      nameSetAtHistoryIndex.set(sessionId, findLastUserMessageIndex(history));

      wsBridge.broadcastToSession(sessionId, { type: "session_name_update", name: result.title } as any);
      addTaskHistoryEntry(sessionId, {
        title: result.title,
        action: "new",
        timestamp: Date.now(),
        triggerMessageId: findLastUserMessageId(history),
      });
      recordNamerMutation(sessionId, source, "new", result.title);
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
  source: NamerTriggerSource,
  triggerLabel: string,
): Promise<void> {
  const currentName = sessionNames.getName(sessionId);
  const isRandomName = isRandomSessionName(currentName);
  const claimedQuest = await getClaimedQuestForNamer(sessionId);
  const startIndex = nameSetAtHistoryIndex.get(sessionId) ?? 0;
  const relevantHistory = isRandomName ? history : history.slice(startIndex);
  const taskHistory = wsBridge.getSession(sessionId)?.taskHistory ?? [];

  console.log(
    `[session-namer] ${triggerLabel} — evaluating session ${sessionId} (current: ${isRandomName ? "(unnamed)" : `"${currentName}"`}, history: ${relevantHistory.length}/${history.length} msgs, generating: ${isGenerating})...`,
  );

  const result = await evaluateSessionName(
    sessionId,
    currentName ?? "",
    relevantHistory,
    cwd,
    {
      signal,
      isGenerating,
      claimedQuest,
      isUnnamed: isRandomName || !currentName,
      source,
      allowNewTask: source === "user_message",
    },
    taskHistory,
  );
  if (signal.aborted) return;
  if (!result) return;
  await applyNamingResult(sessionId, currentName ?? "", result, history, source);
}

// When a quest claims a session, abort all in-flight namer calls so no stale
// result can overwrite the quest-derived title.
wsBridge.onSessionNamedByQuest = (sessionId, title) => {
  cancelAllNamersForSession(sessionId);
  // Persist the quest title in the name store so it survives server restarts
  // and so subsequent namer checks see a non-random name.
  sessionNames.setName(sessionId, title);
  console.log(`[session-namer] Cancelled all in-flight namer calls for ${sessionId} (quest name takeover: "${title}")`);
};

// Continuous session auto-naming via Claude Haiku (triggered on each user message)
wsBridge.onUserMessage = async (sessionId, history, cwd, wasGenerating) => {
  // Suppress auto-namer when disabled in settings
  if (!getSettings().autoNamerEnabled) return;
  // Suppress auto-namer for sessions with noAutoName flag (e.g. temporary reviewer sessions)
  if (launcher.getSession(sessionId)?.noAutoName) return;
  // Suppress auto-namer while a quest owns the session name
  if (await isQuestOwningSessionName(sessionId)) {
    console.log(`[session-namer] Skipping user-message namer for ${sessionId} (quest owns session name)`);
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
  const controller = beginNamerCall(sessionId, "user_message");
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
      const claimedQuest = await getClaimedQuestForNamer(sessionId);
      console.log(`[session-namer] Generating initial name for session ${sessionId}...`);
      const result = await generateFirstName(sessionId, history, cwd, { signal, isGenerating, claimedQuest });
      if (signal.aborted) return;
      if (!result || result.action !== "name") return;
      // Re-check: quest may have been claimed while we were generating
      if (await isQuestOwningSessionName(sessionId)) {
        console.log(`[session-namer] Discarding first-name result for ${sessionId} (quest owns session name)`);
        return;
      }
      // Don't overwrite if user renamed while we were generating
      const freshName = sessionNames.getName(sessionId);
      if (freshName && !isRandomSessionName(freshName)) return;
      sessionNames.setName(sessionId, result.title);
      nameSetAtHistoryIndex.set(sessionId, findLastUserMessageIndex(history));

      wsBridge.broadcastToSession(sessionId, { type: "session_name_update", name: result.title } as any);
      addTaskHistoryEntry(sessionId, {
        title: result.title,
        action: "name",
        timestamp: Date.now(),
        triggerMessageId: findLastUserMessageId(history),
      });
      recordNamerMutation(sessionId, "user_message", "name", result.title);
      if (result.keywords?.length) {
        mergeSessionKeywords(sessionId, result.keywords);
      }
      console.log(`[session-namer] Named session ${sessionId}: "${result.title}"`);
    } else if (currentName) {
      // Subsequent user messages: evaluate whether to rename.
      // If name is still random (initial attempt failed), the evaluate prompt
      // tells the model the name is unknown so it generates one from context.
      await evaluateAndApply(sessionId, history, cwd, signal, isGenerating, "user_message", "User message");
    }
  } finally {
    endNamerCall(sessionId, "user_message", controller);
  }
};

// Re-evaluate session name when agent pauses for plan approval (ExitPlanMode).
// The agent has done meaningful research/work to produce the plan, providing
// rich context for naming — and it's a natural breakpoint before execution.
wsBridge.onAgentPaused = async (sessionId, history, cwd) => {
  if (!getSettings().autoNamerEnabled) return;
  if (launcher.getSession(sessionId)?.noAutoName) return;
  if (await isQuestOwningSessionName(sessionId)) {
    console.log(`[session-namer] Skipping agent-paused namer for ${sessionId} (quest owns session name)`);
    return;
  }
  const currentName = sessionNames.getName(sessionId);
  if (!currentName) return;

  const controller = beginNamerCall(sessionId, "agent_paused");
  const { signal } = controller;

  try {
    await evaluateAndApply(sessionId, history, cwd, signal, true, "agent_paused", "Agent paused");
  } finally {
    endNamerCall(sessionId, "agent_paused", controller);
  }
};

// Re-evaluate session name after agent completes a turn.
// This lets Haiku refine the title based on what the agent actually did,
// and improves the initial name after the first turn.
//
// The turn-completed namer runs independently from user-message naming.
// User-message outcomes are preferred when both produce competing revisions.
wsBridge.onTurnCompleted = async (sessionId, history, cwd) => {
  if (!getSettings().autoNamerEnabled) return;
  if (launcher.getSession(sessionId)?.noAutoName) return;
  if (await isQuestOwningSessionName(sessionId)) {
    console.log(`[session-namer] Skipping turn-completed namer for ${sessionId} (quest owns session name)`);
    return;
  }
  const currentName = sessionNames.getName(sessionId);
  if (!currentName) return;

  // Cancel only stale in-flight turn-completed namers; do not cancel user-message
  // namers, so user-message updates can win in revise/revise races.
  const controller = beginNamerCall(sessionId, "turn_completed");
  const { signal } = controller;

  try {
    await evaluateAndApply(sessionId, history, cwd, signal, false, "turn_completed", "Turn completed");
  } finally {
    endNamerCall(sessionId, "turn_completed", controller);
  }
};

console.log(`[server] Session persistence: ${sessionStore.directory}`);
if (recorder.isGloballyEnabled()) {
  console.log(`[server] Recording enabled (dir: ${recorder.getRecordingsDir()}, max: ${recorder.getMaxLines()} lines)`);
}

// ── Sleep inhibitor — prevent macOS sleep during generation ──────────────────
const sleepInhibitor = new SleepInhibitor({ wsBridge, launcher, getSettings });

const app = new Hono();

app.use("/api/*", cors());
app.route(
  "/api",
  createRoutes(
    launcher,
    wsBridge,
    sessionStore,
    worktreeTracker,
    terminalManager,
    prPoller,
    recorder,
    cronScheduler,
    timerManager,
    imageStore,
    pushoverNotifier,
    { requestRestart },
    perfTracer,
    sleepInhibitor,
    resourceLeaseManager,
  ),
);

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

    // Hono handles the rest. Tag requests with the resolved client IP so
    // routes can distinguish loopback browser access from network clients.
    const requestIp = typeof server.requestIP === "function" ? server.requestIP(req) : null;
    const headers = new Headers(req.headers);
    if (requestIp?.address) {
      headers.set(COMPANION_CLIENT_IP_HEADER, requestIp.address);
    }
    const decoratedRequest = new Request(req, { headers });
    return app.fetch(decoratedRequest, server);
  },
  websocket: {
    idleTimeout: 0, // Disable Bun's idle timeout; we manage liveness via ws.ping heartbeats
    maxPayloadLength: 64 * 1024 * 1024, // 64MB -- generous limit for large history syncs
    perMessageDeflate: true, // Compress large payloads (history_sync can be multi-MB JSON)
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      } else if (data.kind === "terminal") {
        terminalManager.addBrowserSocket(data.terminalId, ws);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      } else if (data.kind === "terminal") {
        terminalManager.handleBrowserMessage(data.terminalId, ws, msg);
      }
    },
    close(ws: ServerWebSocket<SocketData>, code: number, reason: string) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws, code, reason);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws, code, reason);
      } else if (data.kind === "terminal") {
        terminalManager.removeBrowserSocket(data.terminalId, ws);
      }
    },
  },
});

// Start server→browser heartbeat to prevent idle timeout disconnections
wsBridge.startHeartbeat();

// Start watchdog to detect sessions stuck in "generating" state
wsBridge.startStuckSessionWatchdog();

// ── Event loop lag monitor ──────────────────────────────────────────────────
// The Claude Code CLI (Node.js) sends WebSocket ping frames every 10s and
// considers the connection dead if no pong arrives before the next ping.
// On slow NFS, Bun's event loop can block for seconds during file I/O,
// preventing it from responding to pings. This monitor detects those stalls
// so we can identify what operations are causing CLI disconnections.
{
  const LAG_WARN_MS = 500; // warn at 500ms
  const LAG_ALERT_MS = 5_000; // alert at 5s (CLI timeout is 10s)
  const CHECK_INTERVAL_MS = 2_000;
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - CHECK_INTERVAL_MS;
    lastTick = now;
    if (lag > LAG_ALERT_MS) {
      console.error(
        `[event-loop] ⚠️  CRITICAL LAG: ${lag.toFixed(0)}ms — Bun event loop was blocked! CLI ping/pong timeout is 10s, this stall may cause CLI disconnections.`,
      );
    } else if (lag > LAG_WARN_MS) {
      console.warn(`[event-loop] Lag detected: ${lag.toFixed(0)}ms`);
    }
  }, CHECK_INTERVAL_MS);
}

console.log(`Server running on http://localhost:${server.port}`);
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: frontend at http://localhost:5174");
}

if (!process.env.COMPANION_SUPERVISED) {
  serverLog.warn("Not started via 'make dev' or 'make serve' — the Restart Server button will not work.");
  serverLog.warn("Use 'make dev' (dev) or 'make serve' (prod) for restart support.");
}

// ── Cron scheduler ──────────────────────────────────────────────────────────
await cronScheduler.startAll();

// ── Session timers ─────────────────────────────────────────────────────────
await timerManager.startAll();

// ── Global resource leases ─────────────────────────────────────────────────
await resourceLeaseManager.startAll();

// ── Questmaster CLI integration ─────────────────────────────────────────────
await ensureQuestmasterIntegration(port, packageRoot);
await ensureTakodeIntegration(packageRoot);
await ensureBuiltInQuestJourneyPhaseData({ packageRoot });
await ensureSkillSymlinks([
  "takode-orchestration",
  "leader-dispatch",
  "confirm",
  "self-groom",
  "reviewer-groom",
  "skeptic-review",
  "worktree-rules",
  "playwright-e2e-tester",
  "random-memory-ideas",
]);

const startupInjectedRelaunchSessionIds = new Set<string>();
async function captureStartupInjectedRelaunches<T>(operation: () => Promise<T>): Promise<T> {
  const original = wsBridge.onCLIRelaunchNeeded;
  wsBridge.onCLIRelaunchNeeded = (sessionId) => {
    startupInjectedRelaunchSessionIds.add(sessionId);
    original?.(sessionId);
  };
  try {
    return await operation();
  } finally {
    wsBridge.onCLIRelaunchNeeded = original;
  }
}

const restartContinuationSessionIds: string[] = [];
await captureStartupInjectedRelaunches(async () => {
  const resumed = await resumeRestartContinuations(sessionStore.directory, wsBridge);
  if (resumed.plan) {
    restartContinuationSessionIds.push(...resumed.plan.sessions.map((session) => session.sessionId));
    serverLog.info("Resumed restart-interrupted sessions", {
      operationId: resumed.plan.operationId,
      sessions: resumed.plan.sessions.length,
      sent: resumed.sent,
      queued: resumed.queued,
      dropped: resumed.dropped,
      noSession: resumed.noSession,
    });
  }
});

await captureStartupInjectedRelaunches(async () => {
  const recovery = await runStartupRecovery({
    listLauncherSessions: () => launcher.listSessions(),
    getSession: (sessionId) => wsBridge.getSession(sessionId),
    isBackendConnected: (sessionId) => wsBridge.isBackendConnected(sessionId),
    requestCliRelaunch: (sessionId) => wsBridge.onCLIRelaunchNeeded?.(sessionId),
    timerManager,
    restartContinuationSessionIds,
    alreadyRequestedRelaunchSessionIds: startupInjectedRelaunchSessionIds,
    log: (message, data) => serverLog.info(message, data),
  });
  if (recovery.recovered.length > 0) {
    serverLog.info("Startup recovery requested backend relaunch for server-owned work", {
      sessions: recovery.recovered.map((session) => ({
        sessionId: session.sessionId,
        reasons: session.reasons,
        requestedRelaunch: session.requestedRelaunch,
        clearedIdleKilled: session.clearedIdleKilled,
        skippedReason: session.skippedReason,
      })),
    });
  }
});

// ── Idle session manager — enforce maxKeepAlive ─────────────────────────────
const idleManager = new IdleManager(launcher, wsBridge, getSettings);
idleManager.start();

// ── Sleep inhibitor — start polling ──────────────────────────────────────────
sleepInhibitor.start();

// ── Shutdown helpers ─────────────────────────────────────────────────────────
async function performShutdown() {
  serverLog.info("Persisting state before shutdown...");
  idleManager.stop();
  sleepInhibitor.stop();
  await sessionStore.flushAll();
  containerManager.persistState(CONTAINER_STATE_PATH);
  pushoverNotifier.destroy();
  timerManager.destroy();
  resourceLeaseManager.destroy();
  cronScheduler.destroy();
  await flushServerLogger();
}

function gracefulShutdown() {
  performShutdown().finally(() => process.exit(0));
}

function requestRestart() {
  // Delay exit so the HTTP response can flush to the browser
  setTimeout(() => {
    serverLog.info("Restart requested, exiting with code 42...");
    performShutdown().finally(() => process.exit(RESTART_EXIT_CODE));
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
  serverLog.info(`Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
  setTimeout(async () => {
    const stale = launcher.getStartingSessions();
    for (const info of stale) {
      if (info.archived) continue;
      serverLog.warn("CLI did not reconnect, relaunching session", { sessionId: info.sessionId });
      try {
        const result = await launcher.relaunch(info.sessionId);
        if (!result.ok && result.error) {
          serverLog.error("Relaunch failed after reconnect grace period", {
            sessionId: info.sessionId,
            error: result.error,
          });
        }
      } catch (err) {
        serverLog.error("Relaunch threw after reconnect grace period", { sessionId: info.sessionId, error: err });
      }
    }
  }, RECONNECT_GRACE_MS);
}
