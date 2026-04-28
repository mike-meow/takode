import { Hono } from "hono";
import { access as accessAsync } from "node:fs/promises";
import * as questStore from "../quest-store.js";
import * as sessionNames from "../session-names.js";
import type { HerdSessionsResponse } from "../../shared/herd-types.js";
import {
  canonicalizeQuestJourneyLifecycleMode,
  FREE_WORKER_WAIT_FOR_TOKEN,
  getQuestJourneyPhase,
  getQuestJourneyCurrentPhaseIndex,
  getQuestJourneyPhaseForState,
  getQuestJourneyPhaseIndices,
  getInvalidQuestJourneyPhaseIds,
  isValidQuestId,
  isValidWaitForRef,
  normalizeQuestJourneyPhaseIds,
  rebaseQuestJourneyPhaseNotes,
  type QuestJourneyLifecycleMode,
  type QuestJourneyPhaseId,
  type QuestJourneyPhaseNoteRebaseWarning,
  type QuestJourneyPlanState,
} from "../../shared/quest-journey.js";
import {
  buildPeekResponse,
  buildPeekDefault,
  buildPeekRange,
  buildReadResponse,
  findTurnBoundaries,
  buildPeekTurnScan,
  grepMessageHistory,
  exportSessionAsText,
} from "../takode-messages.js";
import { buildLeaderContextResume } from "../takode-leader-context-resume.js";
import {
  getHerdDiagnostics as getHerdDiagnosticsController,
  markAllNotificationsDone as markAllNotificationsDoneController,
  markNotificationDone as markNotificationDoneController,
  notifyUser as notifyUserController,
  summarizePendingPermissions,
} from "../bridge/session-registry-controller.js";
import {
  advanceBoardRow as advanceBoardRowController,
  getBoard as getBoardController,
  getBoardQueueWarnings as getBoardQueueWarningsController,
  getBoardWorkerSlotUsage as getBoardWorkerSlotUsageController,
  getCompletedBoard as getCompletedBoardController,
  removeBoardRows as removeBoardRowsController,
  upsertBoardRow as upsertBoardRowController,
} from "../bridge/board-watchdog-controller.js";
import {
  refreshGitInfoPublic as refreshGitInfoPublicController,
  setDiffBaseBranch as setDiffBaseBranchController,
} from "../bridge/session-git-state.js";
import { buildBoardRowSessionStatuses as buildBoardRowSessionStatusesController } from "../board-row-session-status.js";
import { getSettings } from "../settings-manager.js";
import { QUEST_JOURNEY_STATES, type BrowserOutgoingMessage } from "../session-types.js";
import { isSessionIdleRuntime } from "../herd-event-dispatcher.js";
import type { RouteContext } from "./context.js";

interface PhaseNoteEdit {
  index: number;
  note?: string;
}

function normalizeJourneyMode(value: unknown): QuestJourneyLifecycleMode | undefined {
  if (typeof value !== "string") return undefined;
  return canonicalizeQuestJourneyLifecycleMode(value) ?? undefined;
}

function normalizePhaseNoteEdits(value: unknown): PhaseNoteEdit[] | null {
  if (!Array.isArray(value)) return null;
  const edits: PhaseNoteEdit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const index = (entry as { index?: unknown }).index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
    const rawNote = (entry as { note?: unknown }).note;
    if (rawNote === null) {
      edits.push({ index });
      continue;
    }
    if (typeof rawNote !== "string") return null;
    const note = rawNote.trim();
    edits.push(note ? { index, note } : { index });
  }
  return edits;
}

function applyPhaseNoteEdits(
  existingNotes: Record<string, string> | undefined,
  edits: readonly PhaseNoteEdit[],
  phaseCount: number,
): Record<string, string> | undefined {
  const nextNotes = new Map<string, string>(Object.entries(existingNotes ?? {}));
  for (const edit of edits) {
    if (edit.index >= phaseCount) {
      throw new Error(`Phase note index ${edit.index + 1} is out of range for the current Journey.`);
    }
    const key = String(edit.index);
    if (edit.note) nextNotes.set(key, edit.note);
    else nextNotes.delete(key);
  }
  return nextNotes.size > 0
    ? Object.fromEntries([...nextNotes.entries()].sort((a, b) => Number(a[0]) - Number(b[0])))
    : undefined;
}

function findPreservedPhaseIndex(
  phaseIds: readonly QuestJourneyPhaseId[],
  currentPhaseId: QuestJourneyPhaseId,
  previousIndex: number | undefined,
): number | undefined {
  const matches = phaseIds
    .map((phaseId, index) => ({ phaseId, index }))
    .filter((entry) => entry.phaseId === currentPhaseId)
    .map((entry) => entry.index);
  if (matches.length === 0) return undefined;
  if (previousIndex === undefined) return matches.length === 1 ? matches[0] : undefined;
  return matches.find((index) => index >= previousIndex) ?? matches[matches.length - 1];
}

export function createTakodeRoutes(ctx: RouteContext) {
  const api = new Hono();
  const bridgeAny = ctx.wsBridge as any;
  const { launcher, wsBridge, authenticateTakodeCaller, resolveId, timerManager, pushoverNotifier } = ctx;
  type BridgeSession = NonNullable<ReturnType<typeof wsBridge.getSession>>;
  type LeaderAnswerTarget =
    | {
        kind: "permission";
        request_id: string;
        tool_name: string;
        timestamp: number;
        msg_index?: number;
        input: Record<string, unknown>;
        questions?: unknown;
        plan?: unknown;
        allowedPrompts?: unknown;
      }
    | {
        kind: "notification";
        notification_id: string;
        tool_name: "takode.notify";
        timestamp: number;
        msg_index?: number;
        summary?: string;
        messageId: string | null;
      };
  type LeaderAnswerTargetSelection =
    | { kind: "oldest" }
    | { kind: "msg_index"; msg_index: number }
    | { kind: "target_id"; target_id: string };
  type LeaderPermissionResponse = Extract<BrowserOutgoingMessage, { type: "permission_response" }>;

  const resolveReportedPermissionMode = (
    launcherMode: string | undefined,
    bridgeMode: string | null | undefined,
  ): string | null => {
    if (typeof bridgeMode === "string" && bridgeMode.trim() && bridgeMode !== "default") {
      return bridgeMode;
    }
    if (typeof launcherMode === "string" && launcherMode.trim()) {
      return launcherMode;
    }
    return bridgeMode || null;
  };
  const isBridgeSessionBusy = (session: BridgeSession | null | undefined): boolean =>
    !!session && (session.isGenerating || session.pendingPermissions.size > 0);
  const routeLeaderPermissionResponse = async (
    sessionId: string,
    session: BridgeSession,
    msg: LeaderPermissionResponse,
    actorSessionId: string,
  ): Promise<boolean> => {
    if (typeof bridgeAny.routeExternalPermissionResponse === "function") {
      await bridgeAny.routeExternalPermissionResponse(session, msg, actorSessionId);
      return true;
    }
    if (typeof bridgeAny.handleBrowserMessage === "function") {
      await bridgeAny.handleBrowserMessage(
        { data: { kind: "browser", sessionId }, send: () => {}, close: () => {}, readyState: 1 },
        JSON.stringify({ ...msg, actorSessionId }),
      );
      return true;
    }
    if (typeof bridgeAny.routeBrowserMessage === "function") {
      await bridgeAny.routeBrowserMessage(session, {
        ...msg,
        actorSessionId,
      });
      return true;
    }
    return false;
  };
  const notificationRouteDeps = {
    isHerdedWorkerSession: (session: BridgeSession) => !!launcher.getSession(session.id)?.herdedBy,
    broadcastToBrowsers: (session: BridgeSession, msg: unknown) => wsBridge.broadcastToSession(session.id, msg as any),
    persistSession: (session: BridgeSession) => wsBridge.persistSessionById(session.id),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      wsBridge.emitTakodeEvent(sessionId, type as any, data as any),
    scheduleNotification: (
      sessionId: string,
      category: "question" | "completed",
      detail: string,
      options?: { skipReadCheck?: boolean },
    ) => pushoverNotifier?.scheduleNotification(sessionId, category, detail, undefined, options),
  };
  const notificationPersistDeps = {
    broadcastToBrowsers: (session: BridgeSession, msg: unknown) => wsBridge.broadcastToSession(session.id, msg as any),
    broadcastBoard: (
      session: BridgeSession,
      board: import("../session-types.js").BoardRow[],
      completedBoard: import("../session-types.js").BoardRow[],
    ) => broadcastBoardUpdate(session, board, completedBoard),
    persistSession: (session: BridgeSession) => wsBridge.persistSessionById(session.id),
  };
  const boardWatchdogDeps = {
    getLauncherSessionInfo: (sessionId: string) => launcher.getSession(sessionId),
    getSession: (sessionId: string) => wsBridge.getSession(sessionId),
    listSessions: () => launcher.listSessions(),
    resolveSessionId: (ref: string) => launcher.resolveSessionId(ref) ?? undefined,
    timerCount: (sessionId: string) => timerManager?.listTimers(sessionId).length ?? 0,
    backendConnected: (session: BridgeSession) => wsBridge.isBackendConnected(session.id),
    getBoard: (sessionId: string) => {
      const session = wsBridge.getSession(sessionId);
      return session ? getBoardController(session) : [];
    },
    notifyUser: (sessionId: string, category: "needs-input" | "review", summary: string) => {
      const session = wsBridge.getSession(sessionId);
      return session
        ? notifyUserController(session, category, summary, notificationRouteDeps)
        : { ok: false as const, error: "Session not found" };
    },
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      wsBridge.emitTakodeEvent(sessionId, type as any, data as any),
    markNotificationDone: (sessionId: string, notifId: string, done: boolean) => {
      const session = wsBridge.getSession(sessionId);
      return session ? markNotificationDoneController(session, notifId, done, notificationPersistDeps) : false;
    },
    isSessionIdle: (sessionId: string) => isSessionIdleRuntime(wsBridge.getSession(sessionId) as any),
  };
  const workBoardStateDeps = {
    getBoardDispatchableSignature: (session: BridgeSession, questId: string) =>
      wsBridge.getBoardDispatchableSignature(session.id, questId),
    markNotificationDone: boardWatchdogDeps.markNotificationDone,
    broadcastBoard: (
      session: BridgeSession,
      board: import("../session-types.js").BoardRow[],
      completedBoard: import("../session-types.js").BoardRow[],
    ) => broadcastBoardUpdate(session, board, completedBoard),
    persistSession: (session: BridgeSession) => wsBridge.persistSessionById(session.id),
    notifyReview: (sessionId: string, summary: string) => {
      const session = wsBridge.getSession(sessionId);
      if (session) notifyUserController(session, "review", summary, notificationRouteDeps);
    },
  };
  const getSessionGitDeps = () => bridgeAny.getSessionGitStateDeps?.();
  const setDiffBaseBranch = (sessionId: string, branch: string): boolean => {
    const session = wsBridge.getSession(sessionId);
    const deps = getSessionGitDeps();
    if (session && deps) {
      setDiffBaseBranchController(session as any, branch, deps);
      return true;
    }
    return bridgeAny.setDiffBaseBranch?.(sessionId, branch) ?? false;
  };
  const refreshGitInfoPublic = async (
    sessionId: string,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean } = {},
  ): Promise<boolean> => {
    const session = wsBridge.getSession(sessionId);
    const deps = getSessionGitDeps();
    if (session && deps) {
      await refreshGitInfoPublicController(session as any, deps, options);
      return true;
    }
    return (await bridgeAny.refreshGitInfoPublic?.(sessionId, options)) ?? false;
  };

  const buildEnrichedSessions = async (filterFn?: (s: ReturnType<typeof launcher.listSessions>[number]) => boolean) => {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const pool = filterFn ? sessions.filter(filterFn) : sessions;
    const heavyRepoModeEnabled = getSettings().heavyRepoModeEnabled;
    return Promise.all(
      pool.map(async (s) => {
        const pendingTimerCount = timerManager?.listTimers(s.sessionId).length ?? 0;
        try {
          const { sessionAuthToken: _token, ...safeSession } = s;
          const bridgeSession = wsBridge.getSession(s.sessionId);
          if (bridgeSession?.state?.is_worktree && !safeSession.archived && !heavyRepoModeEnabled) {
            await wsBridge.refreshWorktreeGitStateForSnapshot(s.sessionId, {
              broadcastUpdate: true,
              notifyPoller: true,
            });
          }
          const currentBridgeSession = wsBridge.getSession(s.sessionId) ?? bridgeSession;
          const bridge = currentBridgeSession?.state;
          const attention = currentBridgeSession
            ? {
                lastReadAt: currentBridgeSession.lastReadAt,
                attentionReason: currentBridgeSession.attentionReason,
                pendingPermissionSummary: summarizePendingPermissions(currentBridgeSession),
              }
            : null;
          const cliConnected = wsBridge.isBackendConnected(s.sessionId);
          const effectiveState = cliConnected && currentBridgeSession?.isGenerating ? "running" : safeSession.state;
          return {
            ...safeSession,
            state: effectiveState,
            sessionNum: launcher.getSessionNum(s.sessionId) ?? null,
            name: names[s.sessionId] ?? s.name,
            pendingTimerCount,
            gitBranch: bridge?.git_branch || "",
            gitDefaultBranch: bridge?.git_default_branch || "",
            diffBaseBranch: bridge?.diff_base_branch || "",
            gitAhead: bridge?.git_ahead || 0,
            gitBehind: bridge?.git_behind || 0,
            totalLinesAdded: bridge?.total_lines_added || 0,
            totalLinesRemoved: bridge?.total_lines_removed || 0,
            lastMessagePreview: currentBridgeSession?.lastUserMessage || "",
            cliConnected,
            taskHistory: currentBridgeSession?.taskHistory ?? [],
            keywords: currentBridgeSession?.keywords ?? [],
            claimedQuestId: bridge?.claimedQuestId ?? null,
            claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
            ...(attention ?? {}),
            ...(s.isWorktree && s.archived
              ? await (async () => {
                  let exists = false;
                  try {
                    await accessAsync(s.cwd);
                    exists = true;
                  } catch {
                    /* not found */
                  }
                  return { worktreeExists: exists };
                })()
              : {}),
          };
        } catch (e) {
          console.warn(`[routes] Failed to enrich session ${s.sessionId}:`, e);
          return { ...s, name: names[s.sessionId] ?? s.name, pendingTimerCount };
        }
      }),
    );
  };
  type EnrichedSession = Awaited<ReturnType<typeof buildEnrichedSessions>>[number];

  const findMessageIndexById = (session: BridgeSession, messageId: string | null | undefined): number | undefined => {
    if (!messageId) return undefined;
    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      const entry = session.messageHistory[i];
      if (entry.type === "assistant" && entry.message?.id === messageId) return i;
    }
    return undefined;
  };

  const parseNotificationNumericId = (notificationId: string): number | null => {
    const match = /^n-(\d+)$/.exec(notificationId);
    return match ? Number.parseInt(match[1], 10) : null;
  };

  const normalizeNeedsInputNotificationId = (value: unknown): string | null => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return `n-${value}`;
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numericId = Number.parseInt(trimmed, 10);
      return numericId > 0 ? `n-${numericId}` : null;
    }
    const numericId = parseNotificationNumericId(trimmed.toLowerCase());
    return numericId !== null ? `n-${numericId}` : null;
  };

  const buildSelfNeedsInputNotifications = (session: BridgeSession) => {
    const unresolved: Array<{
      notificationId: number;
      rawNotificationId: string;
      summary?: string;
      timestamp: number;
      messageId: string | null;
    }> = [];
    let resolvedCount = 0;

    for (const notification of session.notifications ?? []) {
      if (notification.category !== "needs-input") continue;
      const numericId = parseNotificationNumericId(notification.id);
      if (numericId === null) continue;
      if (notification.done) {
        resolvedCount += 1;
        continue;
      }
      unresolved.push({
        notificationId: numericId,
        rawNotificationId: notification.id,
        summary: notification.summary,
        timestamp: notification.timestamp,
        messageId: notification.messageId,
      });
    }

    unresolved.sort((a, b) => a.notificationId - b.notificationId);
    return { notifications: unresolved, resolvedCount };
  };

  const getBoardStatusSessions = () =>
    launcher.listSessions().map((session) => {
      const bridgeSession = wsBridge.getSession(session.sessionId);
      const cliConnected = wsBridge.isBackendConnected(session.sessionId);
      return {
        sessionId: session.sessionId,
        sessionNum: launcher.getSessionNum(session.sessionId) ?? null,
        reviewerOf: session.reviewerOf,
        archived: session.archived,
        state: cliConnected && bridgeSession?.isGenerating ? "running" : session.state,
        cliConnected,
        name: sessionNames.getName(session.sessionId) ?? session.name,
      };
    });

  const buildBoardRowSessionStatuses = async (rows: import("../session-types.js").BoardRow[]) => {
    if (rows.length === 0) return {};
    return buildBoardRowSessionStatusesController(rows, getBoardStatusSessions());
  };

  const broadcastBoardUpdate = (
    session: BridgeSession,
    board: import("../session-types.js").BoardRow[],
    completedBoard: import("../session-types.js").BoardRow[],
  ) =>
    wsBridge.broadcastToSession(session.id, {
      type: "board_updated",
      board,
      completedBoard,
      rowSessionStatuses: buildBoardRowSessionStatusesController(
        [...board, ...completedBoard],
        getBoardStatusSessions(),
      ),
    } as any);

  api.get("/takode/me", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    return c.json({
      sessionId: auth.callerId,
      sessionNum: launcher.getSessionNum(auth.callerId) ?? null,
      isOrchestrator: auth.caller.isOrchestrator === true,
      state: auth.caller.state,
      backendType: auth.caller.backendType || "claude",
    });
  });

  api.get("/takode/sessions", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    const enriched = await buildEnrichedSessions();
    return c.json(enriched);
  });

  // ─── Takode: Session Info ──────────────────────────────────

  api.get("/sessions/:id/info", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const bridgeSession = wsBridge.getSession(sessionId);
    if (bridgeSession?.state?.is_worktree && !session.archived) {
      await wsBridge.refreshWorktreeGitStateForSnapshot(sessionId, {
        broadcastUpdate: true,
        notifyPoller: true,
      });
    }
    const currentBridgeSession = wsBridge.getSession(sessionId) ?? bridgeSession;
    const bridge = currentBridgeSession?.state;
    const names = sessionNames.getAllNames();
    const { sessionAuthToken: _token, ...safeSession } = session;

    // Compute actual turn count from message history (bridge?.num_turns is the CLI's
    // internal counter which resets on compaction and doesn't reflect true turn count)
    const infoHistory = currentBridgeSession?.messageHistory ?? null;
    const actualNumTurns =
      infoHistory && infoHistory.length > 0 ? findTurnBoundaries(infoHistory).length : bridge?.num_turns || 0;
    const attention = currentBridgeSession
      ? {
          lastReadAt: currentBridgeSession.lastReadAt,
          attentionReason: currentBridgeSession.attentionReason,
          pendingPermissionSummary: summarizePendingPermissions(currentBridgeSession),
        }
      : null;

    return c.json({
      ...safeSession,
      sessionNum: launcher.getSessionNum(sessionId) ?? null,
      name: names[sessionId] ?? session.name ?? null,
      cliConnected: wsBridge.isBackendConnected(sessionId),
      isGenerating: isBridgeSessionBusy(currentBridgeSession),
      // Bridge-derived state
      gitBranch: bridge?.git_branch || null,
      gitHeadSha: bridge?.git_head_sha || null,
      gitDefaultBranch: bridge?.git_default_branch || null,
      diffBaseBranch: bridge?.diff_base_branch || null,
      gitAhead: bridge?.git_ahead || 0,
      gitBehind: bridge?.git_behind || 0,
      totalLinesAdded: bridge?.total_lines_added || 0,
      totalLinesRemoved: bridge?.total_lines_removed || 0,
      totalCostUsd: bridge?.total_cost_usd || 0,
      numTurns: actualNumTurns,
      contextUsedPercent: bridge?.context_used_percent || 0,
      isCompacting: bridge?.is_compacting || false,
      permissionMode: resolveReportedPermissionMode(session.permissionMode, bridge?.permissionMode),
      tools: bridge?.tools || [],
      mcpServers: bridge?.mcp_servers || [],
      claudeCodeVersion: bridge?.claude_code_version || null,
      claimedQuestId: bridge?.claimedQuestId ?? null,
      claimedQuestTitle: bridge?.claimedQuestTitle ?? null,
      claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
      uiMode: bridge?.uiMode ?? null,
      pendingTimerCount: timerManager?.listTimers(sessionId).length ?? 0,
      ...(attention ?? {}),
      taskHistory: currentBridgeSession?.taskHistory ?? [],
      keywords: currentBridgeSession?.keywords ?? [],
    });
  });

  api.get("/sessions/:id/leader-context-resume", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const launcherSession = launcher.getSession(sessionId);
    const bridgeSession = wsBridge.getSession(sessionId);
    if (!launcherSession || !bridgeSession) return c.json({ error: "Session not found" }, 404);

    const isLeaderSession = launcherSession.isOrchestrator === true || bridgeSession.state?.isOrchestrator === true;
    if (!isLeaderSession) {
      return c.json(
        {
          error:
            "Session is not recognized as a leader/orchestrator session; takode leader-context-resume only supports leader sessions.",
        },
        409,
      );
    }

    const board = getBoardController(bridgeSession);
    const rowSessionStatuses = await buildBoardRowSessionStatuses(board);
    const participantIds = new Set<string>();
    for (const row of board) {
      if (row.worker) participantIds.add(row.worker);
      const status = rowSessionStatuses[row.questId];
      if (status?.worker?.sessionId) participantIds.add(status.worker.sessionId);
      if (status?.reviewer?.sessionId) participantIds.add(status.reviewer.sessionId);
    }

    const participants = new Map<string, import("../takode-leader-context-resume.js").LeaderContextResumeParticipant>();
    for (const participantId of participantIds) {
      const participantLauncher = launcher.getSession(participantId);
      if (!participantLauncher) continue;
      const participantBridge = wsBridge.getSession(participantId);
      const participantStatus = participantBridge
        ? wsBridge.isBackendConnected(participantId)
          ? participantBridge.isGenerating
            ? "running"
            : "idle"
          : "disconnected"
        : participantLauncher.archived
          ? "archived"
          : "missing";
      const participantSessionNum = launcher.getSessionNum(participantId) ?? null;
      const participantState =
        (participantBridge?.state as
          | { claimedQuestId?: string | null; claimedQuestStatus?: string | null }
          | undefined) ?? {};
      const role = participantLauncher.reviewerOf != null ? "reviewer" : "worker";
      participants.set(participantId, {
        sessionId: participantId,
        sessionNum: participantSessionNum,
        name: sessionNames.getName(participantId) ?? participantLauncher.name ?? null,
        role,
        status: participantStatus,
        claimedQuestId: participantState.claimedQuestId ?? null,
        claimedQuestStatus: participantState.claimedQuestStatus ?? null,
        messageHistory: participantBridge?.messageHistory ?? [],
      });
    }

    const model = await buildLeaderContextResume({
      leader: {
        sessionId,
        sessionNum: launcher.getSessionNum(sessionId) ?? null,
        name: sessionNames.getName(sessionId) ?? launcherSession.name ?? null,
        isOrchestrator: true,
        messageHistory: bridgeSession.messageHistory ?? [],
        notifications: bridgeSession.notifications ?? [],
        board,
      },
      rowSessionStatuses,
      participants,
      loadQuest: (questId: string) => questStore.getQuest(questId),
    });

    return c.json(model);
  });

  // ─── Takode: Message Peek & Read ────────────────────────────

  api.get("/sessions/:id/messages", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const history = wsBridge.getSession(sessionId)?.messageHistory ?? null;
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const sessionNum = launcher.getSessionNum(sessionId) ?? -1;
    const sessionName = sessionNames.getName(sessionId) || sessionId.slice(0, 8);
    const cliConnected = wsBridge.isBackendConnected(sessionId);

    // Derive status: check bridge session for generation state
    const bridgeSession = wsBridge.getSession(sessionId);
    let status: "idle" | "running" | "disconnected" = "disconnected";
    if (cliConnected) {
      status = bridgeSession?.isGenerating ? "running" : "idle";
    }

    // Quest info from the bridge session state (set via quest claiming)
    const sessionState = bridgeSession?.state;
    const quest = sessionState?.claimedQuestId
      ? {
          id: sessionState.claimedQuestId,
          title: sessionState.claimedQuestTitle || "",
          status: sessionState.claimedQuestStatus || "",
        }
      : null;

    const base = {
      sid: sessionId,
      sn: sessionNum,
      name: sessionName,
      status,
      quest,
      pendingTimerCount: timerManager?.listTimers(sessionId).length ?? 0,
    };

    // ── Mode detection ──
    const fromParam = c.req.query("from");
    const untilParam = c.req.query("until");
    const detail = c.req.query("detail") === "true";
    const turnParam = c.req.query("turn");
    const scanMode = c.req.query("scan");

    // Turn scan mode: paginated collapsed turn summaries (used by `takode scan`)
    if (scanMode === "turns") {
      const fromTurn = parseInt(c.req.query("fromTurn") ?? "0", 10);
      const turnCount = parseInt(c.req.query("turnCount") ?? "50", 10);
      return c.json({ ...base, ...buildPeekTurnScan(history, { fromTurn, turnCount }, sessionId) });
    }

    // Turn mode: resolve turn number to message range, then use range mode
    if (turnParam !== undefined) {
      const turnNum = parseInt(turnParam, 10);
      if (isNaN(turnNum) || turnNum < 0) return c.json({ error: "turn must be a non-negative integer" }, 400);

      const allTurns = findTurnBoundaries(history);
      if (turnNum >= allTurns.length) {
        return c.json(
          { error: `Turn ${turnNum} not found. Session has ${allTurns.length} turns (0-${allTurns.length - 1}).` },
          404,
        );
      }

      const turn = allTurns[turnNum];
      const endIdx = turn.endIdx >= 0 ? turn.endIdx : history.length - 1;
      const count = endIdx - turn.startIdx + 1;
      const showTools = c.req.query("showTools") === "true";
      return c.json({ ...base, ...buildPeekRange(history, { from: turn.startIdx, count, showTools }, sessionId) });
    }

    if (fromParam !== undefined || untilParam !== undefined) {
      // Range browsing mode: page forward from `from`, backward from `until`,
      // or browse an explicit inclusive range when both are present.
      const from = fromParam !== undefined ? parseInt(fromParam, 10) : undefined;
      const until = untilParam !== undefined ? parseInt(untilParam, 10) : undefined;
      const count = parseInt(c.req.query("count") ?? "60", 10);
      const showTools = c.req.query("showTools") === "true";
      return c.json({ ...base, ...buildPeekRange(history, { from, until, count, showTools }, sessionId) });
    }

    if (detail) {
      // Detail mode: legacy full-detail behavior
      const turns = parseInt(c.req.query("turns") ?? "1", 10);
      const since = parseInt(c.req.query("since") ?? "0", 10);
      const full = c.req.query("full") === "true";
      return c.json({
        ...base,
        ...{ mode: "detail" as const, turns: buildPeekResponse(history, { turns, since, full }, sessionId) },
      });
    }

    // Default mode: smart overview (collapsed recent turns + expanded last turn)
    const collapsedCount = parseInt(c.req.query("collapsed") ?? "5", 10);
    const expandLimit = parseInt(c.req.query("expand") ?? "10", 10);
    return c.json({ ...base, ...buildPeekDefault(history, { collapsedCount, expandLimit }, sessionId) });
  });

  api.get("/sessions/:id/messages/:idx", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const idx = parseInt(c.req.param("idx"), 10);
    if (isNaN(idx)) return c.json({ error: "Invalid message index" }, 400);

    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = parseInt(c.req.query("limit") ?? "200", 10);

    const history = wsBridge.getSession(sessionId)?.messageHistory ?? null;
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const result = buildReadResponse(
      history,
      idx,
      {
        offset,
        limit,
        getToolResult: (toolUseId) => wsBridge.getToolResult(sessionId, toolUseId),
      },
      sessionId,
    );
    if (!result) {
      return c.json({ error: `Message index ${idx} out of range (0-${history.length - 1})` }, 404);
    }

    return c.json(result);
  });

  // ─── Takode: Grep (within-session search) ────────────────────

  api.get("/sessions/:id/grep", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const history = wsBridge.getSession(sessionId)?.messageHistory ?? null;
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const query = (c.req.query("q") || "").trim();
    if (!query) return c.json({ error: "Query parameter 'q' is required" }, 400);

    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const type = c.req.query("type") || undefined;
    const results = grepMessageHistory(history, query, { limit, type }, sessionId);

    return c.json({ sessionId, sessionNum: launcher.getSessionNum(sessionId) ?? -1, query, ...results });
  });

  // ─── Takode: Export (dump session to text) ───────────────────

  api.get("/sessions/:id/export", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const history = wsBridge.getSession(sessionId)?.messageHistory ?? null;
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const text = exportSessionAsText(history, sessionId);
    const totalTurns = findTurnBoundaries(history).length;

    return c.json({ sessionId, totalMessages: history.length, totalTurns, text });
  });

  // ─── Cross-session messaging ───────────────────────────────────────

  api.post("/sessions/:id/message", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.archived) {
      return c.json({ error: "Cannot send to archived session" }, 409);
    }
    // Allow exited/disconnected sessions (including idle-killed ones) —
    // injectUserMessage will queue the message, clear killedByIdleManager,
    // and trigger a relaunch, matching the browser chat UI behavior.
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    // Validate optional agentSource label from callers.
    let sessionLabel: string | undefined;
    if (body.agentSource && typeof body.agentSource === "object") {
      if (typeof body.agentSource.sessionId === "string" && body.agentSource.sessionId.trim()) {
        const claimed = resolveId(body.agentSource.sessionId.trim());
        if (!claimed || claimed !== auth.callerId) {
          return c.json({ error: "agentSource.sessionId does not match authenticated caller" }, 403);
        }
      }
      if (typeof body.agentSource.sessionLabel === "string" && body.agentSource.sessionLabel.trim()) {
        sessionLabel = body.agentSource.sessionLabel;
      }
    }
    const agentSource = { sessionId: auth.callerId, ...(sessionLabel ? { sessionLabel } : {}) };

    // Herd guard: if the target session is herded, only its leader can send messages.
    if (session.herdedBy) {
      if (auth.callerId !== session.herdedBy) {
        return c.json({ error: "Session is herded — only its leader can send messages" }, 403);
      }
    }
    const delivery = wsBridge.injectUserMessage(id, body.content, agentSource);
    if (delivery === "no_session") return c.json({ error: "Session not found in bridge" }, 404);
    return c.json({ ok: true, sessionId: id, delivery });
  });

  // ─── Cat herding (orchestrator→worker relationships) ──────────────

  api.post("/sessions/:id/herd", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const orch = launcher.getSession(orchId);
    if (!orch) return c.json({ error: "Orchestrator session not found" }, 404);

    // Server-side role check: only orchestrators can herd
    if (!orch.isOrchestrator) {
      return c.json({ error: "Session is not an orchestrator" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    if (!Array.isArray(body.workerIds) || body.workerIds.length === 0) {
      return c.json({ error: "workerIds array is required" }, 400);
    }
    if (body.force !== undefined && typeof body.force !== "boolean") {
      return c.json({ error: "force must be a boolean" }, 400);
    }
    // Resolve each worker ref (supports #N, UUID, prefix)
    const resolved: string[] = [];
    const notFound: string[] = [];
    for (const ref of body.workerIds) {
      const wid = resolveId(String(ref));
      if (wid) {
        resolved.push(wid);
      } else {
        notFound.push(String(ref));
      }
    }
    const result =
      body.force === true
        ? launcher.herdSessions(orchId, resolved, { force: true })
        : launcher.herdSessions(orchId, resolved);
    return c.json({
      herded: result.herded,
      notFound: [...notFound, ...result.notFound],
      conflicts: result.conflicts,
      reassigned: result.reassigned,
      leaders: result.leaders,
    } satisfies HerdSessionsResponse);
  });

  api.delete("/sessions/:id/herd/:workerId", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const workerId = resolveId(c.req.param("workerId"));
    if (!workerId) return c.json({ error: "Worker session not found" }, 404);
    const removed = launcher.unherdSession(orchId, workerId);
    return c.json({ ok: true, removed });
  });

  api.get("/sessions/:id/herd", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const herded = launcher.getHerdedSessions(orchId);
    return c.json(
      herded.map((s) => ({
        sessionId: s.sessionId,
        sessionNum: s.sessionNum,
        name: sessionNames.getName(s.sessionId),
        state: s.state,
        cwd: s.cwd,
        backendType: s.backendType,
        cliConnected: wsBridge.isBackendConnected(s.sessionId),
        isOrchestrator: s.isOrchestrator,
        herdedBy: s.herdedBy,
      })),
    );
  });

  // ─── Leader answer (resolve AskUserQuestion / ExitPlanMode) ─────────

  /** Answerable tool names — tool permissions (can_use_tool) are human-only */
  const ANSWERABLE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

  const buildLeaderAnswerTargets = (session: BridgeSession): LeaderAnswerTarget[] => {
    const targets: LeaderAnswerTarget[] = [];

    for (const [, perm] of session.pendingPermissions) {
      if (!ANSWERABLE_TOOLS.has(perm.tool_name)) continue;
      let msg_index: number | undefined;
      for (let i = session.messageHistory.length - 1; i >= 0; i--) {
        const entry = session.messageHistory[i] as { type?: string; request?: { request_id?: string } };
        if (entry.type === "permission_request" && entry.request?.request_id === perm.request_id) {
          msg_index = i;
          break;
        }
      }
      targets.push({
        kind: "permission",
        request_id: perm.request_id,
        tool_name: perm.tool_name,
        timestamp: perm.timestamp,
        input: perm.input,
        ...(msg_index !== undefined ? { msg_index } : {}),
        ...(perm.tool_name === "AskUserQuestion" ? { questions: perm.input.questions } : {}),
        ...(perm.tool_name === "ExitPlanMode"
          ? { plan: perm.input.plan, allowedPrompts: perm.input.allowedPrompts }
          : {}),
      });
    }

    for (const notif of session.notifications) {
      if (notif.done || notif.category !== "needs-input") continue;
      const msg_index = findMessageIndexById(session, notif.messageId);
      targets.push({
        kind: "notification",
        notification_id: notif.id,
        tool_name: "takode.notify",
        timestamp: notif.timestamp,
        ...(msg_index !== undefined ? { msg_index } : {}),
        ...(notif.summary ? { summary: notif.summary } : {}),
        messageId: notif.messageId,
      });
    }

    return targets.sort((a, b) => a.timestamp - b.timestamp);
  };

  const matchLeaderAnswerTarget = (
    target: LeaderAnswerTarget,
    selection: Exclude<LeaderAnswerTargetSelection, { kind: "oldest" }>,
  ): boolean => {
    if (selection.kind === "msg_index") return target.msg_index === selection.msg_index;
    return target.kind === "permission"
      ? target.request_id === selection.target_id
      : target.notification_id === selection.target_id;
  };

  const selectLeaderAnswerTarget = (
    targets: LeaderAnswerTarget[],
    selection: LeaderAnswerTargetSelection,
  ): { ok: true; target: LeaderAnswerTarget } | { ok: false; status: 404 | 409; error: string } => {
    if (targets.length === 0) return { ok: false, status: 404, error: "No pending question or plan to answer" };

    if (selection.kind === "oldest") {
      if (targets.length > 1) {
        return {
          ok: false,
          status: 409,
          error: "Multiple pending prompts; choose one with msgIndex/--message or targetId/--target",
        };
      }
      return { ok: true, target: targets[0] };
    }

    const matches = targets.filter((target) => matchLeaderAnswerTarget(target, selection));
    if (matches.length === 0) {
      return { ok: false, status: 404, error: "Targeted pending prompt not found" };
    }
    if (matches.length > 1) {
      return { ok: false, status: 409, error: "Target selector matched multiple pending prompts" };
    }
    return { ok: true, target: matches[0] };
  };

  api.get("/sessions/:id/pending", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (workerInfo.herdedBy !== auth.callerId) {
      return c.json({ error: "Only the leader who herded this session can view pending prompts" }, 403);
    }
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    return c.json({ pending: buildLeaderAnswerTargets(session) });
  });

  api.post("/sessions/:id/answer", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const response = typeof body.response === "string" ? body.response : "";
    if (!response.trim()) {
      return c.json({ error: "response is required" }, 400);
    }
    const rawTargetId =
      typeof body.targetId === "string"
        ? body.targetId.trim()
        : typeof body.target_id === "string"
          ? body.target_id.trim()
          : "";
    const rawMsgIndex =
      typeof body.msgIndex === "number"
        ? body.msgIndex
        : typeof body.msg_index === "number"
          ? body.msg_index
          : undefined;
    if (rawMsgIndex !== undefined && !Number.isInteger(rawMsgIndex)) {
      return c.json({ error: "msgIndex must be an integer" }, 400);
    }
    if (
      typeof body.callerSessionId === "string" &&
      body.callerSessionId.trim() &&
      body.callerSessionId.trim() !== auth.callerId
    ) {
      return c.json({ error: "callerSessionId does not match authenticated caller" }, 403);
    }
    const callerSessionId = auth.callerId;

    // Herd guard: only the leader can answer
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (!callerSessionId || workerInfo.herdedBy !== callerSessionId) {
      return c.json({ error: "Only the leader who herded this session can answer" }, 403);
    }

    const targets = buildLeaderAnswerTargets(session);
    const selection: LeaderAnswerTargetSelection =
      rawMsgIndex !== undefined
        ? { kind: "msg_index", msg_index: rawMsgIndex }
        : rawTargetId
          ? { kind: "target_id", target_id: rawTargetId }
          : { kind: "oldest" };
    const selected = selectLeaderAnswerTarget(targets, selection);
    if (!selected.ok) return c.json({ error: selected.error }, selected.status);
    const target = selected.target;

    if (target.kind === "notification") {
      const callerInfo = launcher.getSession(auth.callerId);
      const sessionLabel = callerInfo?.sessionNum !== undefined ? `#${callerInfo.sessionNum}` : undefined;
      const delivery = wsBridge.injectUserMessage(id, response, {
        sessionId: auth.callerId,
        ...(sessionLabel ? { sessionLabel } : {}),
      });
      if (delivery === "no_session") return c.json({ error: "Session not found in bridge" }, 404);
      markNotificationDoneController(session, target.notification_id, true, notificationPersistDeps);
      return c.json({
        ok: true,
        kind: "notification",
        tool_name: target.tool_name,
        action: "answered",
        answer: response,
        delivery,
      });
    }

    // Build the permission_response based on tool type
    if (target.tool_name === "AskUserQuestion") {
      // Parse response: number = pick option, otherwise free text
      const questions = target.input.questions as Array<{ options?: Array<{ label: string }> }> | undefined;
      const optIdx = parseInt(response, 10);
      let answerValue: string;
      if (!isNaN(optIdx) && questions?.[0]?.options && optIdx >= 1 && optIdx <= questions[0].options.length) {
        answerValue = questions[0].options[optIdx - 1].label; // 1-indexed
      } else {
        answerValue = response; // free text
      }
      const answers: Record<string, string> = {};
      for (let i = 0; i < Math.max(1, questions?.length ?? 0); i++) {
        answers[String(i)] = answerValue;
      }

      const routed = await routeLeaderPermissionResponse(
        id,
        session,
        {
          type: "permission_response",
          request_id: target.request_id,
          behavior: "allow",
          updated_input: { ...target.input, answers },
        },
        auth.callerId,
      );
      if (!routed) return c.json({ error: "Permission response routing unavailable" }, 500);
      return c.json({ ok: true, kind: "permission", tool_name: target.tool_name, answer: answerValue });
    }

    if (target.tool_name === "ExitPlanMode") {
      const isApprove = response.toLowerCase().startsWith("approve");
      if (isApprove) {
        const routed = await routeLeaderPermissionResponse(
          id,
          session,
          {
            type: "permission_response",
            request_id: target.request_id,
            behavior: "allow",
            updated_input: target.input,
          },
          auth.callerId,
        );
        if (!routed) return c.json({ error: "Permission response routing unavailable" }, 500);
        return c.json({ ok: true, kind: "permission", tool_name: target.tool_name, action: "approved" });
      } else {
        // "reject" or "reject: feedback text"
        const feedback = response.replace(/^reject:?\s*/i, "").trim() || "Rejected by leader";
        const routed = await routeLeaderPermissionResponse(
          id,
          session,
          {
            type: "permission_response",
            request_id: target.request_id,
            behavior: "deny",
            message: feedback,
          },
          auth.callerId,
        );
        if (!routed) return c.json({ error: "Permission response routing unavailable" }, 500);
        return c.json({ ok: true, kind: "permission", tool_name: target.tool_name, action: "rejected", feedback });
      }
    }

    return c.json({ error: "Unsupported tool type" }, 400);
  });

  // ─── Herd diagnostics ────────────────────────────────────────────────

  api.get("/sessions/:id/herd-diagnostics", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    const bridgeDiag = session
      ? getHerdDiagnosticsController(new Map([[id, session]]), id, Date.now(), {
          getHerdDispatcherDiagnostics: (targetSessionId) =>
            (wsBridge as any).herdEventDispatcher?.getDiagnostics?.(targetSessionId) ?? {},
        })
      : null;
    const herded = info.isOrchestrator ? launcher.getHerdedSessions(id) : [];

    return c.json({
      sessionId: id,
      sessionNum: info.sessionNum,
      isOrchestrator: info.isOrchestrator || false,
      herdedBy: info.herdedBy,
      herdedWorkers: herded.map((s) => ({
        sessionId: s.sessionId,
        sessionNum: s.sessionNum,
        name: sessionNames.getName(s.sessionId),
        state: s.state,
        cliConnected: wsBridge.isBackendConnected(s.sessionId),
      })),
      ...(bridgeDiag || {}),
    });
  });

  // ─── Branch management ─────────────────────────────────────────────

  /**
   * Trigger a git info refresh for the caller's own session.
   * Agents call this after git checkout / branch / rebase so the server
   * picks up the new HEAD and recomputes ahead/behind stats.
   */
  api.post("/sessions/:id/refresh-branch", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    await refreshGitInfoPublic(id, { broadcastUpdate: true, notifyPoller: true, force: true });

    const state = wsBridge.getSession(id)?.state;
    return c.json({
      ok: true,
      gitBranch: state?.git_branch || null,
      gitDefaultBranch: state?.git_default_branch || null,
      diffBaseBranch: state?.diff_base_branch || null,
      gitAhead: state?.git_ahead || 0,
      gitBehind: state?.git_behind || 0,
    });
  });

  /**
   * Get branch info for the caller's session.
   * Returns current branch, base branch, default branch, HEAD SHA, and ahead/behind counts.
   */
  api.get("/sessions/:id/branch/status", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const state = session.state;
    return c.json({
      ok: true,
      gitBranch: state.git_branch || null,
      diffBaseBranch: state.diff_base_branch || null,
      gitDefaultBranch: state.git_default_branch || null,
      gitHeadSha: state.git_head_sha || null,
      gitAhead: state.git_ahead || 0,
      gitBehind: state.git_behind || 0,
      totalLinesAdded: state.total_lines_added || 0,
      totalLinesRemoved: state.total_lines_removed || 0,
      isWorktree: state.is_worktree || false,
    });
  });

  /**
   * Set the diff base branch for the caller's session.
   * This is the same operation as changing it in the DiffPanel UI.
   */
  api.post("/sessions/:id/branch/set-base", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const body = await c.req.json<{ branch?: string }>().catch(() => ({}) as { branch?: string });
    const branch = body.branch?.trim();
    if (!branch) return c.json({ error: "Missing 'branch' parameter" }, 400);
    if (branch.length > 255) return c.json({ error: "Branch name too long (max 255)" }, 400);

    const success = setDiffBaseBranch(id, branch);
    if (!success) return c.json({ error: "Failed to set base branch" }, 500);

    const state = wsBridge.getSession(id)?.state;
    return c.json({
      ok: true,
      diffBaseBranch: state?.diff_base_branch || null,
      gitBranch: state?.git_branch || null,
      gitAhead: state?.git_ahead || 0,
      gitBehind: state?.git_behind || 0,
    });
  });

  // ─── User notifications ──────────────────────────────────────────────

  api.post("/sessions/:id/notify", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    // The caller can only notify for their own session
    if (id !== auth.callerId) {
      return c.json({ error: "Can only notify from your own session" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const category = body.category;
    if (category !== "needs-input" && category !== "review") {
      return c.json({ error: 'category must be "needs-input" or "review"' }, 400);
    }
    const rawSummary = typeof body.summary === "string" ? body.summary.trim() : "";
    if (!rawSummary) {
      return c.json({ error: "summary is required" }, 400);
    }
    const summary = rawSummary;

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const result = notifyUserController(session, category, summary, notificationRouteDeps);
    return c.json({
      ok: true,
      category,
      anchoredMessageId: result.anchoredMessageId,
      notificationId: parseNotificationNumericId(result.notificationId),
      rawNotificationId: result.notificationId,
    });
  });

  api.get("/sessions/:id/notifications/needs-input/self", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only inspect notifications for your own session" }, 403);
    }

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(buildSelfNeedsInputNotifications(session));
  });

  api.post("/sessions/:id/notifications/needs-input/:notificationId/resolve", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only resolve notifications for your own session" }, 403);
    }

    const numericId = Number.parseInt(c.req.param("notificationId"), 10);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return c.json({ error: "notificationId must be a positive integer" }, 400);
    }

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const rawNotificationId = `n-${numericId}`;
    const notification = session.notifications.find(
      (entry) => entry.id === rawNotificationId && entry.category === "needs-input",
    );
    if (!notification) return c.json({ error: "Notification not found" }, 404);
    if (notification.done) {
      return c.json({ ok: true, notificationId: numericId, rawNotificationId, changed: false });
    }

    markNotificationDoneController(session, rawNotificationId, true, notificationPersistDeps);
    return c.json({ ok: true, notificationId: numericId, rawNotificationId, changed: true });
  });

  // ─── Notification Inbox ─────────────────────────────────────────────

  api.post("/sessions/:id/notifications/:notifId/done", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const notifId = c.req.param("notifId");
    const body = await c.req.json().catch(() => ({}));
    const done = body.done !== false;
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const ok = markNotificationDoneController(session, notifId, done, notificationPersistDeps);
    if (!ok) return c.json({ error: "Notification not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/notifications/done-all", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const done = body.done !== false;
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const count = markAllNotificationsDoneController(session, done, notificationPersistDeps);
    return c.json({ ok: true, count });
  });

  api.get("/sessions/:id/notifications", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    return c.json(wsBridge.getSession(id)?.notifications ?? []);
  });

  // ─── Work Board ──────────────────────────────────────────────────────

  /** Resolve which #N session deps on the board are currently idle. */
  function resolveSessionDeps(board: import("../session-types.js").BoardRow[]): string[] {
    const sessionRefs = new Set<string>();
    for (const row of board) {
      for (const dep of row.waitFor ?? []) {
        if (dep.startsWith("#")) sessionRefs.add(dep);
      }
    }
    if (sessionRefs.size === 0) return [];
    const resolved: string[] = [];
    for (const ref of sessionRefs) {
      const num = ref.slice(1); // strip '#'
      const sessionId = launcher.resolveSessionId(num);
      if (sessionId && isSessionIdleRuntime(wsBridge.getSession(sessionId) as any)) {
        resolved.push(ref);
      }
    }
    return resolved;
  }

  api.get("/sessions/:id/board", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    // Only the session owner can read their own board
    if (id !== auth.callerId) {
      return c.json({ error: "Can only read your own board" }, 403);
    }

    const bridgeSession = wsBridge.getSession(id);
    const board = bridgeSession ? getBoardController(bridgeSession) : [];
    const resolve = c.req.query("resolve") === "true";
    const includeCompleted = c.req.query("include_completed") === "true";
    const completedBoard = includeCompleted && bridgeSession ? getCompletedBoardController(bridgeSession) : [];
    const rowSessionStatuses = await buildBoardRowSessionStatuses([...board, ...completedBoard]);

    return c.json({
      board,
      completedCount: bridgeSession?.completedBoard.size ?? 0,
      rowSessionStatuses,
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      ...(includeCompleted ? { completedBoard } : {}),
      ...(resolve ? { resolvedSessionDeps: resolveSessionDeps(board) } : {}),
    });
  });

  api.post("/sessions/:id/board", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const questId = typeof body.questId === "string" ? body.questId.trim() : "";
    if (!questId) return c.json({ error: "questId is required" }, 400);
    if (!isValidQuestId(questId)) {
      return c.json({ error: `Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)` }, 400);
    }
    if (typeof body.noCode === "boolean") {
      return c.json(
        {
          error:
            "Board no-code markers were removed. Model zero-tracked-change work with explicit phases that omit `port` instead.",
        },
        400,
      );
    }

    // Auto-populate title from quest store if not explicitly provided
    let title: string | undefined = typeof body.title === "string" ? body.title : undefined;
    if (title === undefined) {
      try {
        const quest = await questStore.getQuest(questId);
        if (quest) title = quest.title;
      } catch (e) {
        console.warn(`[routes] Failed to fetch quest title for ${questId}:`, e);
      }
    }

    // Validate and normalize waitFor entries
    let waitFor: string[] | undefined;
    if (Array.isArray(body.waitFor)) {
      const parsed = body.waitFor
        .filter((s: unknown) => typeof s === "string" && s.trim())
        .map((s: string) => s.trim());
      const invalid = parsed.filter((ref: string) => !isValidWaitForRef(ref));
      if (invalid.length > 0) {
        return c.json(
          {
            error: `Invalid wait-for value(s): ${invalid.join(", ")} -- use q-N for quests, #N for sessions, or ${FREE_WORKER_WAIT_FOR_TOKEN}`,
          },
          400,
        );
      }
      waitFor = parsed;
    }
    if (body.waitFor !== undefined && !Array.isArray(body.waitFor)) {
      return c.json({ error: "waitFor must be an array when provided" }, 400);
    }

    let waitForInput: string[] | undefined;
    const clearWaitForInput = body.clearWaitForInput === true;
    if (clearWaitForInput && body.waitForInput !== undefined) {
      return c.json({ error: "Use either waitForInput or clearWaitForInput, not both" }, 400);
    }
    if (Array.isArray(body.waitForInput)) {
      const parsed: Array<{ value: unknown; normalized: string | null }> = body.waitForInput
        .map((value: unknown) => ({ value, normalized: normalizeNeedsInputNotificationId(value) }))
        .filter((entry: { value: unknown; normalized: string | null }) => entry.value !== undefined);
      const invalid = parsed.filter((entry) => entry.normalized === null).map((entry) => String(entry.value).trim());
      if (invalid.length > 0) {
        return c.json(
          {
            error: `Invalid wait-for-input value(s): ${invalid.join(", ")} -- use same-session needs-input notification IDs like 3 or n-3`,
          },
          400,
        );
      }
      const normalizedIds = parsed
        .map((entry) => entry.normalized)
        .filter((notificationId): notificationId is string => typeof notificationId === "string");
      waitForInput = [...new Set(normalizedIds)].sort(
        (a: string, b: string) => Number.parseInt(a.slice(2), 10) - Number.parseInt(b.slice(2), 10),
      );
    } else if (body.waitForInput !== undefined) {
      return c.json({ error: "waitForInput must be an array when provided" }, 400);
    }
    if (clearWaitForInput) waitForInput = [];

    const bridgeSession = wsBridge.getSession(id);
    const existingRow = bridgeSession?.board.get(questId) ?? null;
    if (waitForInput && waitForInput.length > 0) {
      if (!bridgeSession) return c.json({ error: "Session not found in bridge" }, 404);
      const missing = waitForInput.filter(
        (notificationId) =>
          !bridgeSession.notifications.some(
            (notification) =>
              notification.id === notificationId &&
              notification.category === "needs-input" &&
              notification.done !== true,
          ),
      );
      if (missing.length > 0) {
        return c.json(
          {
            error: `Unknown or already-resolved same-session needs-input notification ID(s): ${missing.join(", ")}`,
          },
          400,
        );
      }
    }
    let journey: QuestJourneyPlanState | undefined;
    let firstPlannedPhaseState: string | undefined;
    const explicitStatus = typeof body.status === "string" ? body.status.trim() || undefined : undefined;
    const explicitStatusUpper = explicitStatus?.toUpperCase();
    const explicitStatusPhase = getQuestJourneyPhaseForState(explicitStatus ?? null)?.id;
    const requestedMode = normalizeJourneyMode(body.journeyMode);
    if (body.journeyMode !== undefined && !requestedMode) {
      return c.json({ error: "journeyMode must be `active` or `proposed` when provided" }, 400);
    }
    const existingJourney = existingRow?.journey;
    const existingMode: QuestJourneyLifecycleMode =
      normalizeJourneyMode(existingJourney?.mode) ??
      ((existingRow?.status || "").trim().toUpperCase() === "PROPOSED" ? "proposed" : "active");
    const targetMode = requestedMode ?? (explicitStatusUpper === "PROPOSED" ? "proposed" : (existingMode ?? "active"));
    const revisionReason =
      typeof body.revisionReason === "string" && body.revisionReason.trim() ? body.revisionReason.trim() : undefined;
    if (typeof body.revisionReason === "string" && !revisionReason) {
      return c.json({ error: "Journey revision reason must not be empty" }, 400);
    }
    if (revisionReason && !Array.isArray(body.phases)) {
      return c.json({ error: "Journey revision reason requires --phases / phases so the revision is explicit" }, 400);
    }
    const phaseNoteEdits = normalizePhaseNoteEdits(body.phaseNoteEdits);
    if (body.phaseNoteEdits !== undefined && phaseNoteEdits === null) {
      return c.json({ error: "phaseNoteEdits must be an array of { index, note } edits when provided" }, 400);
    }
    const explicitActivePhaseIndex =
      typeof body.activePhaseIndex === "number" && Number.isInteger(body.activePhaseIndex)
        ? body.activePhaseIndex
        : null;
    if (body.activePhaseIndex !== undefined && (explicitActivePhaseIndex === null || explicitActivePhaseIndex < 0)) {
      return c.json({ error: "activePhaseIndex must be a non-negative integer when provided" }, 400);
    }
    if (targetMode === "proposed" && explicitStatus && explicitStatusUpper !== "PROPOSED") {
      return c.json({ error: "Proposed Journey rows must use status PROPOSED." }, 400);
    }
    if (targetMode === "active" && explicitStatusUpper === "PROPOSED") {
      return c.json({ error: "Status PROPOSED is only valid for proposed Journey rows." }, 400);
    }

    let typedPhaseIds: QuestJourneyPhaseId[] | undefined;
    const existingPhaseIds = normalizeQuestJourneyPhaseIds(existingJourney?.phaseIds ?? []);
    if (Array.isArray(body.phases)) {
      const phaseIds = body.phases
        .filter((s: unknown) => typeof s === "string" && s.trim())
        .map((s: string) => s.trim());
      if (phaseIds.length === 0) {
        return c.json({ error: "Quest Journey phases require at least one phase ID" }, 400);
      }
      const invalid = getInvalidQuestJourneyPhaseIds(phaseIds);
      if (invalid.length > 0) {
        return c.json({ error: `Invalid Quest Journey phase(s): ${invalid.join(", ")}` }, 400);
      }
      typedPhaseIds = normalizeQuestJourneyPhaseIds(phaseIds) as QuestJourneyPhaseId[];
      firstPlannedPhaseState = getQuestJourneyPhase(typedPhaseIds[0])?.boardState;
      const phasesChanged =
        typedPhaseIds.length !== existingPhaseIds.length ||
        typedPhaseIds.some((phaseId, index) => phaseId !== existingPhaseIds[index]);
      if (existingRow && phasesChanged && !revisionReason) {
        return c.json(
          {
            error:
              "Updating an existing Quest Journey requires a revision reason. Re-run with --revise-reason / revisionReason.",
          },
          400,
        );
      }
      const existingCurrentPhaseId = getQuestJourneyPhase(existingJourney?.currentPhaseId)?.id;
      if (
        targetMode === "active" &&
        existingCurrentPhaseId &&
        !typedPhaseIds.includes(existingCurrentPhaseId) &&
        !explicitStatus
      ) {
        return c.json(
          {
            error:
              "Revised phases must include the current phase unless you also set an explicit status for the new active boundary.",
          },
          400,
        );
      }
      if (explicitStatusPhase && !typedPhaseIds.includes(explicitStatusPhase)) {
        return c.json(
          {
            error: `Status ${body.status} does not match the revised phase plan. Include its phase in --phases or change --status.`,
          },
          400,
        );
      }
    }

    const resolvedPhaseIds = typedPhaseIds ?? existingPhaseIds;
    if (phaseNoteEdits && resolvedPhaseIds.length === 0) {
      return c.json(
        { error: "Phase notes require an existing Journey row or explicit --phases for the target row." },
        400,
      );
    }
    if (targetMode === "proposed" && explicitActivePhaseIndex !== null) {
      return c.json({ error: "Proposed Journey rows cannot set an activePhaseIndex." }, 400);
    }
    if (targetMode === "active" && explicitActivePhaseIndex !== null && resolvedPhaseIds.length === 0) {
      return c.json({ error: "activePhaseIndex requires an existing Journey row or explicit --phases." }, 400);
    }
    if (
      targetMode === "active" &&
      explicitActivePhaseIndex !== null &&
      explicitActivePhaseIndex >= resolvedPhaseIds.length
    ) {
      return c.json(
        {
          error: `activePhaseIndex ${explicitActivePhaseIndex} is out of range for the current Journey.`,
        },
        400,
      );
    }
    const explicitActivePhaseId =
      explicitActivePhaseIndex !== null && explicitActivePhaseIndex < resolvedPhaseIds.length
        ? resolvedPhaseIds[explicitActivePhaseIndex]
        : undefined;
    if (explicitStatusPhase && explicitActivePhaseId && explicitStatusPhase !== explicitActivePhaseId) {
      return c.json(
        {
          error: `activePhaseIndex ${explicitActivePhaseIndex} points to ${explicitActivePhaseId}, which does not match status ${body.status}.`,
        },
        400,
      );
    }

    let phaseNoteRebaseWarnings: QuestJourneyPhaseNoteRebaseWarning[] = [];
    let phaseNotes = existingJourney?.phaseNotes;
    if (typedPhaseIds && existingJourney) {
      const rebaseResult = rebaseQuestJourneyPhaseNotes(existingJourney.phaseNotes, existingPhaseIds, typedPhaseIds);
      phaseNotes = rebaseResult.phaseNotes;
      phaseNoteRebaseWarnings = rebaseResult.warnings;
    }
    if (phaseNoteEdits) {
      try {
        phaseNotes = applyPhaseNoteEdits(phaseNotes, phaseNoteEdits, resolvedPhaseIds.length);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Invalid phase note update." }, 400);
      }
    }

    let activePhaseIndex: number | undefined;
    if (targetMode === "active" && resolvedPhaseIds.length > 0) {
      const existingCurrentPhaseId = getQuestJourneyPhase(existingJourney?.currentPhaseId)?.id;
      const existingCurrentPhaseIndex = getQuestJourneyCurrentPhaseIndex(existingJourney, existingRow?.status);
      if (explicitActivePhaseIndex !== null) {
        activePhaseIndex = explicitActivePhaseIndex;
      } else if (explicitStatusPhase) {
        activePhaseIndex = findPreservedPhaseIndex(resolvedPhaseIds, explicitStatusPhase, existingCurrentPhaseIndex);
      } else if (typedPhaseIds && existingMode === "active" && existingCurrentPhaseId) {
        activePhaseIndex = findPreservedPhaseIndex(resolvedPhaseIds, existingCurrentPhaseId, existingCurrentPhaseIndex);
        if (
          activePhaseIndex === undefined &&
          getQuestJourneyPhaseIndices(resolvedPhaseIds, existingCurrentPhaseId).length > 1
        ) {
          return c.json(
            {
              error:
                "The current Journey phase is repeated but the active occurrence is ambiguous. Re-run with activePhaseIndex (CLI: --active-phase-position).",
            },
            400,
          );
        }
      } else if ((requestedMode === "active" && existingMode === "proposed") || !existingRow?.status) {
        activePhaseIndex = 0;
      }
      if (
        explicitStatusPhase &&
        explicitActivePhaseIndex === null &&
        activePhaseIndex === undefined &&
        getQuestJourneyPhaseIndices(resolvedPhaseIds, explicitStatusPhase).length > 1
      ) {
        return c.json(
          {
            error:
              "Status points to a repeated Journey phase but the active occurrence is ambiguous. Re-run with activePhaseIndex (CLI: --active-phase-position).",
          },
          400,
        );
      }
    }

    if (typedPhaseIds || phaseNoteEdits || revisionReason || requestedMode || explicitActivePhaseIndex !== null) {
      journey = {
        phaseIds: resolvedPhaseIds.length > 0 ? resolvedPhaseIds : [],
        presetId:
          typedPhaseIds && typeof body.presetId === "string" && body.presetId.trim()
            ? body.presetId.trim()
            : (existingJourney?.presetId ?? (typedPhaseIds ? "custom" : undefined)),
        mode: targetMode,
        ...(targetMode === "active" && activePhaseIndex !== undefined ? { activePhaseIndex } : {}),
        ...(phaseNotes ? { phaseNotes } : {}),
        ...(revisionReason ? { revisionReason } : {}),
      };
    }

    const implicitQueuedStatus =
      !explicitStatus &&
      explicitActivePhaseIndex === null &&
      targetMode === "active" &&
      typeof body.worker !== "string" &&
      waitFor !== undefined &&
      !existingRow?.status
        ? "QUEUED"
        : undefined;
    const explicitActiveStatus =
      explicitActivePhaseId !== undefined ? getQuestJourneyPhase(explicitActivePhaseId)?.boardState : undefined;
    const defaultActiveStatus =
      explicitActiveStatus ??
      firstPlannedPhaseState ??
      (resolvedPhaseIds.length > 0 ? getQuestJourneyPhase(resolvedPhaseIds[0])?.boardState : undefined);
    const mergedStatus =
      explicitStatus ??
      (targetMode === "proposed"
        ? "PROPOSED"
        : (implicitQueuedStatus ??
          ((existingRow?.status || "").trim().toUpperCase() === "PROPOSED"
            ? defaultActiveStatus
            : (existingRow?.status?.trim() ?? defaultActiveStatus))));
    const mergedStatusUpper = (mergedStatus || "").trim().toUpperCase();
    const mergedWaitFor =
      targetMode === "proposed" ? undefined : waitFor !== undefined ? waitFor : existingRow?.waitFor;
    const mergedWaitForInput = waitForInput !== undefined ? waitForInput : existingRow?.waitForInput;
    const mergedIsQueued = mergedStatusUpper === "QUEUED";
    if (targetMode === "proposed" && typeof body.worker === "string" && body.worker.trim()) {
      return c.json({ error: "Proposed Journey rows cannot be assigned to a worker yet." }, 400);
    }
    if (targetMode === "proposed" && waitFor && waitFor.length > 0) {
      return c.json(
        {
          error:
            "Proposed Journey rows do not use queue wait-for dependencies. Use wait-for-input to hold for approval.",
        },
        400,
      );
    }
    if (mergedIsQueued && mergedWaitForInput && mergedWaitForInput.length > 0) {
      return c.json(
        {
          error: "wait-for-input is only valid on active board rows; clear it before moving a row to QUEUED.",
        },
        400,
      );
    }
    if (waitFor && waitFor.length > 0 && waitForInput && waitForInput.length > 0) {
      return c.json(
        {
          error:
            "wait-for and wait-for-input cannot both be set on the same row. Use wait-for for QUEUED rows or wait-for-input for active rows.",
        },
        400,
      );
    }
    if (!mergedIsQueued && waitFor && waitFor.length > 0) {
      return c.json(
        {
          error: "wait-for is only valid on QUEUED board rows; clear it before moving a row active.",
        },
        400,
      );
    }
    if (targetMode === "active" && mergedStatusUpper === "PROPOSED") {
      return c.json({ error: "Active Journey rows cannot keep status PROPOSED." }, 400);
    }
    if (mergedIsQueued && (!mergedWaitFor || mergedWaitFor.length === 0)) {
      return c.json(
        {
          error: `Queued rows require an explicit wait-for reason -- use q-N, #N, or ${FREE_WORKER_WAIT_FOR_TOKEN}`,
        },
        400,
      );
    }

    const statusForUpsert = mergedStatus;
    const workerForUpsert = targetMode === "proposed" ? "" : typeof body.worker === "string" ? body.worker : undefined;
    const workerNumForUpsert =
      targetMode === "proposed" ? undefined : typeof body.workerNum === "number" ? body.workerNum : undefined;

    const board = bridgeSession
      ? upsertBoardRowController(
          bridgeSession,
          {
            questId,
            title,
            worker: workerForUpsert,
            workerNum: workerNumForUpsert,
            journey,
            status: statusForUpsert,
            waitFor: targetMode === "proposed" ? [] : waitFor,
            waitForInput,
          },
          workBoardStateDeps,
        )
      : null;
    if (!board) return c.json({ error: "Session not found in bridge" }, 404);
    return c.json({
      board,
      rowSessionStatuses: await buildBoardRowSessionStatuses(board),
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(board),
      ...(phaseNoteRebaseWarnings.length > 0 ? { phaseNoteRebaseWarnings } : {}),
    });
  });

  api.delete("/sessions/:id/board/:questId", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const questIds = c.req
      .param("questId")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (questIds.length === 0) return c.json({ error: "questId is required" }, 400);
    const invalid = questIds.filter((qid) => !isValidQuestId(qid));
    if (invalid.length > 0) {
      return c.json(
        { error: `Invalid quest ID(s): ${invalid.join(", ")} -- must match q-NNN format (e.g., q-1, q-42)` },
        400,
      );
    }

    const bridgeSession = wsBridge.getSession(id);
    const board = bridgeSession ? removeBoardRowsController(bridgeSession, questIds, workBoardStateDeps) : null;
    if (!board) return c.json({ error: "Session not found in bridge" }, 404);
    return c.json({
      board,
      completedCount: bridgeSession?.completedBoard.size ?? 0,
      rowSessionStatuses: await buildBoardRowSessionStatuses(board),
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(board),
    });
  });

  api.post("/sessions/:id/board/:questId/advance", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const questId = c.req.param("questId").trim();
    if (!questId) return c.json({ error: "questId is required" }, 400);
    if (!isValidQuestId(questId)) {
      return c.json({ error: `Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)` }, 400);
    }

    const bridgeSession = wsBridge.getSession(id);
    const result = bridgeSession
      ? advanceBoardRowController(bridgeSession, questId, QUEST_JOURNEY_STATES, workBoardStateDeps)
      : null;
    if (!result) return c.json({ error: "Quest not found on board" }, 404);
    if ("error" in result) return c.json({ error: result.error }, 409);
    return c.json({
      ...result,
      completedCount: bridgeSession?.completedBoard.size ?? 0,
      rowSessionStatuses: await buildBoardRowSessionStatuses(result.board),
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(result.board),
    });
  });

  return api;
}
