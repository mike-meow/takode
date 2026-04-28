import { sessionTag } from "../session-tag.js";
import type { PersistedSession } from "../session-store.js";
import type { BoardRow, ContentBlock, SessionTaskEntry, SessionNotification } from "../session-types.js";
import { detectQuestEvent } from "./quest-detector.js";
import type {
  BrowserIncomingMessage,
  CLIResultMessage,
  CLISystemCompactBoundaryMessage,
  SessionState,
  ToolResultPreview,
} from "../session-types.js";

type SessionLike = any;

export interface SessionRegistryDeps {
  makeDefaultState: (sessionId: string, backendType: string) => unknown;
  pruneToolResultsForCurrentHistory: (session: SessionLike) => void;
  broadcastToSession: (sessionId: string, msg: BrowserIncomingMessage) => void;
  recomputeAndBroadcastHistoryBytes: (session: SessionLike) => void;
  persistSession: (session: SessionLike) => void;
  persistSessionSync: (sessionId: string) => void;
  broadcastToBrowsers?: (session: SessionLike, msg: BrowserIncomingMessage) => void;
  broadcastBoard?: (session: SessionLike, board: BoardRow[], completedBoard: BoardRow[]) => void;
  broadcastSessionUpdate?: (session: SessionLike, update: Record<string, unknown>) => void;
  requestCliRelaunch?: (sessionId: string) => void;
  emitTakodeEvent?: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  attached?: (session: SessionLike) => boolean;
  getLauncherSessionInfo?: (sessionId: string) => any;
  recoveryTimeoutMs?: number;
  getHerdedSessionIds?: (leaderId: string) => string[];
  getSessionNum?: (sessionId: string) => number | undefined;
  getSessionName?: (sessionId: string) => string | undefined;
  deriveSessionStatus?: (session: SessionLike & { isGenerating: boolean }) => string | null;
  clearAttentionAndMarkRead?: (session: SessionLike & { isGenerating: boolean }) => void;
  setAttentionReview?: (session: SessionLike & { isGenerating: boolean }) => void;
  broadcastLeaderGroupIdle?: (
    session: SessionLike & { isGenerating: boolean },
    payload: Record<string, unknown>,
  ) => void;
  recordServerEvent?: (
    sessionId: string,
    reason: string,
    payload: Record<string, unknown>,
    backendType: string,
    cwd: string,
  ) => void;
  delayMs?: number;
  isHerdedWorkerSession?: (session: SessionLike) => boolean;
  scheduleNotification?: (
    sessionId: string,
    category: "question" | "completed",
    detail: string,
    options?: { skipReadCheck?: boolean },
  ) => void;
  scheduleCompletedNotification?: (sessionId: string, detail: string) => void;
  scheduleResultCompletedNotification?: (sessionId: string) => void;
  scheduleErrorNotification?: (sessionId: string, detail: string) => void;
  resolveQuestTitle?: (questId: string) => Promise<string | undefined>;
  broadcastTaskHistory?: (session: SessionLike) => void;
  onSessionNamedByQuest?: (sessionId: string, title: string) => void;
  finalizeCodexRecoveringTurn?: (session: SessionLike, reason: "recovery_timeout" | "recovery_failed") => void;
}

type SessionRuntimeOptions = {
  pendingPermissions?: Map<string, any>;
  messageHistory?: BrowserIncomingMessage[];
  frozenCount?: number;
  pendingMessages?: string[];
  forceCompactPending?: boolean;
  pendingCodexTurns?: any[];
  pendingCodexInputs?: any[];
  pendingCodexRollback?: { numTurns: number; truncateIdx: number; clearCodexState: boolean } | null;
  pendingCodexRollbackError?: string | null;
  codexFreshTurnRequiredUntilTurnId?: string | null;
  nextEventSeq?: number;
  eventBuffer?: any[];
  lastAckSeq?: number;
  processedClientMessageIds?: string[];
  toolResults?: Map<any, any>;
  taskHistory?: SessionTaskEntry[];
  keywords?: string[];
  board?: Map<any, any>;
  completedBoard?: Map<any, any>;
  notifications?: SessionNotification[];
  notificationCounter?: number;
  lastReadAt?: number;
  attentionReason?: "action" | "error" | "review" | null;
};

function createSessionRuntime(
  sessionId: string,
  backendType: string,
  state: any,
  options: SessionRuntimeOptions = {},
): SessionLike {
  const processedClientMessageIds = options.processedClientMessageIds ?? [];
  return {
    id: sessionId,
    backendType,
    backendSocket: null,
    codexAdapter: null,
    claudeSdkAdapter: null,
    browserSockets: new Set(),
    state,
    pendingPermissions: options.pendingPermissions ?? new Map(),
    pendingControlRequests: new Map(),
    messageHistory: options.messageHistory ?? [],
    frozenCount: options.frozenCount ?? 0,
    pendingMessages: options.pendingMessages ?? [],
    forceCompactPending: options.forceCompactPending ?? false,
    pendingCodexTurns: options.pendingCodexTurns ?? [],
    pendingCodexInputs: options.pendingCodexInputs ?? [],
    pendingCodexRollback: options.pendingCodexRollback ?? null,
    pendingCodexRollbackError: options.pendingCodexRollbackError ?? null,
    codexFreshTurnRequiredUntilTurnId: options.codexFreshTurnRequiredUntilTurnId ?? null,
    pendingCodexRollbackWaiter: null,
    nextEventSeq: options.nextEventSeq ?? 1,
    eventBuffer: options.eventBuffer ?? [],
    lastAckSeq: options.lastAckSeq ?? 0,
    processedClientMessageIds,
    processedClientMessageIdSet: new Set(processedClientMessageIds),
    toolResults: options.toolResults ?? new Map(),
    toolProgressOutput: new Map(),
    pendingQuestCommands: new Map(),
    assistantAccumulator: new Map(),
    toolStartTimes: new Map(),
    worktreeStateFingerprint: "",
    codexToolResultWatchdogs: new Map(),
    isGenerating: false,
    generationStartedAt: null,
    questStatusAtTurnStart: null,
    messageCountAtTurnStart: 0,
    interruptedDuringTurn: false,
    interruptSourceDuringTurn: null,
    compactedDuringTurn: false,
    consecutiveAdapterFailures: 0,
    lastAdapterFailureAt: null,
    intentionalCodexRelaunchUntil: null,
    intentionalCodexRelaunchReason: null,
    userMessageIdsThisTurn: [],
    queuedTurnStarts: 0,
    queuedTurnReasons: [],
    queuedTurnUserMessageIds: [],
    queuedTurnInterruptSources: [],
    cliInitReceived: false,
    lastCliMessageAt: 0,
    lastCliPingAt: 0,
    lastToolProgressAt: 0,
    optimisticRunningTimer: null,
    lastOutboundUserNdjson: null,
    stuckNotifiedAt: null,
    lastReadAt: options.lastReadAt ?? 0,
    lastUserMessageDateTag: "",
    attentionReason: options.attentionReason ?? null,
    codexDisconnectGraceTimer: null,
    disconnectGraceTimer: null,
    disconnectWasGenerating: false,
    seamlessReconnect: false,
    relaunchPending: false,
    taskHistory: options.taskHistory ?? [],
    keywords: options.keywords ?? [],
    board: options.board ?? new Map(),
    completedBoard: options.completedBoard ?? new Map(),
    boardStallStates: new Map(),
    boardDispatchStates: new Map(),
    notifications: options.notifications ?? [],
    notificationCounter: options.notificationCounter ?? 0,
    diffStatsDirty: true,
    searchDataOnly: false,
    searchExcerpts: [],
    evaluatingAborts: new Map(),
    cliInitializeSent: false,
    cliResuming: false,
    cliResumingClearTimer: null,
    dropReplayHistoryAfterRevert: false,
    claudeCompactBoundarySeen: false,
  };
}

export function getOrCreateSession(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  backendType: string | undefined,
  deps: Pick<SessionRegistryDeps, "makeDefaultState">,
): SessionLike {
  let session = sessions.get(sessionId);
  if (!session) {
    const type = backendType || "claude";
    session = createSessionRuntime(sessionId, type, deps.makeDefaultState(sessionId, type));
    sessions.set(sessionId, session);
  } else if (backendType) {
    session.backendType = backendType;
    session.state.backend_type = backendType;
  }
  return session;
}

export function applyInitialSessionState(
  session: SessionLike,
  options: {
    containerizedHostCwd?: string;
    cwd?: string;
    treeGroupId?: string;
    askPermission?: boolean;
    uiMode?: "plan" | "agent";
    resumedFromExternal?: boolean;
    worktree?: {
      repoRoot: string;
      defaultBranch?: string;
      diffBaseBranch?: string;
    };
  },
  deps: { persistSession: (session: SessionLike) => void; prefillSlashCommands: (session: SessionLike) => void },
): void {
  let shouldPersist = false;

  if (options.containerizedHostCwd) {
    session.state.is_containerized = true;
    session.state.cwd = options.containerizedHostCwd;
  }
  if (options.cwd && !session.state.cwd) {
    session.state.cwd = options.cwd;
  }
  if (typeof options.treeGroupId === "string") {
    const normalizedTreeGroupId = options.treeGroupId.trim() || "default";
    if (session.state.treeGroupId !== normalizedTreeGroupId) {
      session.state.treeGroupId = normalizedTreeGroupId;
      shouldPersist = true;
    }
  }
  if (options.worktree) {
    session.state.is_worktree = true;
    session.state.repo_root = options.worktree.repoRoot;
    session.state.cwd = options.cwd ?? session.state.cwd;
    if (options.worktree.defaultBranch) {
      session.state.git_default_branch = options.worktree.defaultBranch;
    }
    const diffBase = options.worktree.diffBaseBranch || options.worktree.defaultBranch;
    if (diffBase && !session.state.diff_base_branch_explicit && !session.state.diff_base_branch) {
      session.state.diff_base_branch = diffBase;
    }
  }
  if (options.askPermission !== undefined) {
    session.state.askPermission = options.askPermission;
    session.state.uiMode = options.uiMode ?? "plan";
    shouldPersist = true;
  }
  if (options.resumedFromExternal) {
    session.resumedFromExternal = true;
  }
  if (shouldPersist) {
    deps.persistSession(session);
  }
  deps.prefillSlashCommands(session);
}

export function prepareSessionForRevert(
  session: SessionLike,
  truncateIdx: number,
  deps: Pick<SessionRegistryDeps, "pruneToolResultsForCurrentHistory" | "broadcastToSession">,
  options?: { clearCodexState?: boolean },
): SessionLike {
  session.messageHistory = session.messageHistory.slice(0, truncateIdx);
  session.frozenCount = Math.min(session.frozenCount, session.messageHistory.length);
  deps.pruneToolResultsForCurrentHistory(session);
  session.assistantAccumulator?.clear?.();
  session.pendingMessages = [];
  session.lastOutboundUserNdjson = null;
  session.userMessageIdsThisTurn = [];
  session.queuedTurnStarts = 0;
  session.queuedTurnReasons = [];
  session.queuedTurnUserMessageIds = [];
  session.queuedTurnInterruptSources = [];
  session.interruptedDuringTurn = false;
  session.interruptSourceDuringTurn = null;
  session.isGenerating = false;
  session.generationStartedAt = null;
  session.disconnectWasGenerating = false;
  session.seamlessReconnect = false;
  session.toolStartTimes?.clear?.();
  session.toolProgressOutput?.clear?.();
  session.dropReplayHistoryAfterRevert = session.backendType === "claude" || session.backendType === "claude-sdk";

  const lastUser = [...session.messageHistory]
    .reverse()
    .find((msg) => msg.type === "user_message" && typeof msg.content === "string");
  session.lastUserMessage =
    lastUser && typeof lastUser.content === "string" ? lastUser.content.slice(0, 80) : undefined;

  if (session.taskHistory?.length) {
    const remainingUserMsgIds = new Set(
      session.messageHistory
        .filter((msg: any) => msg.type === "user_message")
        .map((msg: any) => msg.id)
        .filter((id: unknown): id is string => typeof id === "string"),
    );
    const prevCount = session.taskHistory.length;
    session.taskHistory = session.taskHistory.filter((task: any) => remainingUserMsgIds.has(task.triggerMessageId));
    if (session.taskHistory.length !== prevCount) {
      deps.broadcastToSession(session.id, {
        type: "session_task_history",
        tasks: session.taskHistory,
      } as BrowserIncomingMessage);
    }
  }

  session.pendingPermissions.clear();
  deps.broadcastToSession(session.id, { type: "permissions_cleared" } as BrowserIncomingMessage);

  session.eventBuffer = [];
  session.awaitingCompactSummary = false;
  session.claudeCompactBoundarySeen = false;
  session.compactedDuringTurn = false;
  session.forceCompactPending = false;
  if (session.state) session.state.is_compacting = false;

  if (options?.clearCodexState) {
    session.pendingCodexTurns = [];
    session.pendingCodexInputs = [];
    session.pendingCodexRollback = null;
    session.pendingCodexRollbackError = null;
    if (session.optimisticRunningTimer) {
      clearTimeout(session.optimisticRunningTimer);
      session.optimisticRunningTimer = null;
    }
    deps.broadcastToSession(session.id, { type: "codex_pending_inputs", inputs: [] } as BrowserIncomingMessage);
  }

  return session;
}

export function finalizeCodexRollback(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "recomputeAndBroadcastHistoryBytes" | "persistSessionSync" | "broadcastToSession">,
  revertedSession: SessionLike | null,
): void {
  const waiter = session.pendingCodexRollbackWaiter;
  session.pendingCodexRollback = null;
  session.pendingCodexRollbackError = null;
  waiter?.resolve();
  session.pendingCodexRollbackWaiter = null;
  if (!revertedSession) return;
  deps.recomputeAndBroadcastHistoryBytes(session);
  deps.persistSessionSync(session.id);
  deps.broadcastToSession(session.id, {
    type: "message_history",
    messages: revertedSession.messageHistory,
  } as BrowserIncomingMessage);
  deps.broadcastToSession(session.id, { type: "status_change", status: "idle" } as BrowserIncomingMessage);
}

export function beginCodexRollback(
  session: SessionLike,
  plan: { numTurns: number; truncateIdx: number; clearCodexState: boolean },
  deps: Pick<SessionRegistryDeps, "persistSession">,
  onFinalize: () => void,
): { promise: Promise<void>; requiresRelaunch: boolean } {
  if (!Number.isInteger(plan.numTurns) || plan.numTurns < 1) {
    return {
      promise: Promise.reject(new Error(`Invalid rollback turn count: ${plan.numTurns}`)),
      requiresRelaunch: false,
    };
  }
  if (!Number.isInteger(plan.truncateIdx) || plan.truncateIdx < 0) {
    return {
      promise: Promise.reject(new Error(`Invalid rollback truncate index: ${plan.truncateIdx}`)),
      requiresRelaunch: false,
    };
  }

  session.pendingCodexRollback = plan;
  session.pendingCodexRollbackError = null;
  deps.persistSession(session);

  const liveAdapter = session.codexAdapter;
  if (liveAdapter?.isConnected()) {
    return {
      promise: liveAdapter
        .rollbackTurns(plan.numTurns)
        .then(() => {
          onFinalize();
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          session.pendingCodexRollback = null;
          session.pendingCodexRollbackError = message;
          session.pendingCodexRollbackWaiter?.reject(new Error(message));
          session.pendingCodexRollbackWaiter = null;
          deps.persistSession(session);
          throw err;
        }),
      requiresRelaunch: false,
    };
  }

  const promise = new Promise<void>((resolve, reject) => {
    session.pendingCodexRollbackWaiter = { resolve, reject };
    deps.persistSession(session);
  });
  return { promise, requiresRelaunch: true };
}

function normalizePersistedCodexTurn(turn: any, now = Date.now()): any {
  return {
    ...turn,
    pendingInputIds:
      Array.isArray(turn.pendingInputIds) && turn.pendingInputIds.length > 0
        ? turn.pendingInputIds
        : [turn.userMessageId],
    historyIndex: turn.historyIndex ?? -1,
    status: turn.status ?? "queued",
    dispatchCount: turn.dispatchCount ?? 0,
    createdAt: turn.createdAt ?? now,
    updatedAt: turn.updatedAt ?? now,
    acknowledgedAt: turn.acknowledgedAt ?? null,
    turnTarget: null,
    lastError: turn.lastError ?? null,
  };
}

export async function restorePersistedSessions(
  sessions: Map<string, SessionLike>,
  persisted: any[],
  deps: {
    recoverToolStartTimesFromHistory: (session: SessionLike) => void;
    finalizeRecoveredDisconnectedTerminalTools: (session: SessionLike, reason: string) => void;
    scheduleCodexToolResultWatchdogs: (session: SessionLike, reason: string) => void;
    reconcileRestoredBoardState: (session: SessionLike) => Promise<void>;
  },
): Promise<number> {
  let count = 0;
  for (const p of persisted) {
    if (sessions.has(p.id)) continue;

    // Archived sessions loaded with search-data-only: skip heavyweight restore
    if (p._searchDataOnly) {
      const session = createSessionRuntime(p.id, p.state.backend_type || "claude", p.state, {
        pendingPermissions: new Map(),
        messageHistory: [],
        frozenCount: 0,
        pendingMessages: [],
        forceCompactPending: false,
        pendingCodexTurns: [],
        pendingCodexInputs: [],
        pendingCodexRollback: null,
        pendingCodexRollbackError: null,
        codexFreshTurnRequiredUntilTurnId: null,
        nextEventSeq: 1,
        eventBuffer: [],
        lastAckSeq: 0,
        processedClientMessageIds: [],
        toolResults: new Map(),
        lastReadAt: typeof p.lastReadAt === "number" ? p.lastReadAt : 0,
        attentionReason: p.attentionReason ?? null,
        taskHistory: Array.isArray(p.taskHistory) ? p.taskHistory : [],
        keywords: Array.isArray(p.keywords) ? p.keywords : [],
        board: new Map(Array.isArray(p.board) ? p.board.map((row: any) => [row.questId, row]) : []),
        completedBoard: new Map(
          Array.isArray(p.completedBoard) ? p.completedBoard.map((row: any) => [row.questId, row]) : [],
        ),
        notifications: Array.isArray(p.notifications) ? p.notifications : [],
        notificationCounter: Array.isArray(p.notifications)
          ? p.notifications.reduce((max: number, n: SessionNotification) => {
              const num = parseInt(n.id.replace("n-", ""), 10);
              return Number.isFinite(num) && num > max ? num : max;
            }, 0)
          : 0,
      });
      session.state.backend_type = session.backendType;
      session.state.backend_state = session.state.backend_state ?? "disconnected";
      session.state.backend_error = session.state.backend_error ?? null;
      session.searchDataOnly = true;
      session.searchExcerpts = p._searchExcerpts ?? [];
      sessions.set(p.id, session);
      count += 1;
      continue;
    }

    const restoredCodexTurns = Array.isArray(p.pendingCodexTurns)
      ? p.pendingCodexTurns.map((turn: any) => normalizePersistedCodexTurn(turn))
      : [];
    const session = createSessionRuntime(p.id, p.state.backend_type || "claude", p.state, {
      pendingPermissions: new Map(p.pendingPermissions || []),
      messageHistory: p.messageHistory || [],
      frozenCount:
        typeof p._frozenCount === "number" ? Math.max(0, Math.min(p._frozenCount, (p.messageHistory || []).length)) : 0,
      pendingMessages: p.pendingMessages || [],
      forceCompactPending:
        typeof (p as { forceCompactPending?: unknown }).forceCompactPending === "boolean"
          ? ((p as { forceCompactPending: boolean }).forceCompactPending ?? false)
          : false,
      pendingCodexTurns: restoredCodexTurns,
      pendingCodexInputs: Array.isArray(p.pendingCodexInputs) ? p.pendingCodexInputs : [],
      pendingCodexRollback:
        p.pendingCodexRollback &&
        typeof p.pendingCodexRollback === "object" &&
        Number.isInteger((p.pendingCodexRollback as { numTurns?: number }).numTurns) &&
        Number.isInteger((p.pendingCodexRollback as { truncateIdx?: number }).truncateIdx) &&
        typeof (p.pendingCodexRollback as { clearCodexState?: unknown }).clearCodexState === "boolean" &&
        (p.pendingCodexRollback as { numTurns: number }).numTurns > 0 &&
        (p.pendingCodexRollback as { truncateIdx: number }).truncateIdx >= 0
          ? {
              numTurns: (p.pendingCodexRollback as { numTurns: number }).numTurns,
              truncateIdx: (p.pendingCodexRollback as { truncateIdx: number }).truncateIdx,
              clearCodexState: (p.pendingCodexRollback as { clearCodexState: boolean }).clearCodexState,
            }
          : null,
      pendingCodexRollbackError: typeof p.pendingCodexRollbackError === "string" ? p.pendingCodexRollbackError : null,
      codexFreshTurnRequiredUntilTurnId:
        typeof p.codexFreshTurnRequiredUntilTurnId === "string" ? p.codexFreshTurnRequiredUntilTurnId : null,
      nextEventSeq: p.nextEventSeq && p.nextEventSeq > 0 ? p.nextEventSeq : 1,
      eventBuffer: Array.isArray(p.eventBuffer) ? p.eventBuffer : [],
      lastAckSeq: typeof p.lastAckSeq === "number" ? p.lastAckSeq : 0,
      processedClientMessageIds: Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
      toolResults: new Map(Array.isArray(p.toolResults) ? p.toolResults : []),
      lastReadAt: typeof p.lastReadAt === "number" ? p.lastReadAt : 0,
      attentionReason: p.attentionReason ?? null,
      taskHistory: Array.isArray(p.taskHistory) ? p.taskHistory : [],
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      board: new Map(Array.isArray(p.board) ? p.board.map((row: any) => [row.questId, row]) : []),
      completedBoard: new Map(
        Array.isArray(p.completedBoard) ? p.completedBoard.map((row: any) => [row.questId, row]) : [],
      ),
      notifications: Array.isArray(p.notifications) ? p.notifications : [],
      notificationCounter: Array.isArray(p.notifications)
        ? p.notifications.reduce((max: number, n: SessionNotification) => {
            const num = parseInt(n.id.replace("n-", ""), 10);
            return Number.isFinite(num) && num > max ? num : max;
          }, 0)
        : 0,
    });
    session.state.backend_type = session.backendType;
    session.state.backend_state = session.state.backend_state ?? "disconnected";
    session.state.backend_error = session.state.backend_error ?? null;

    for (const perm of session.pendingPermissions.values()) {
      if (perm.evaluating) perm.evaluating = undefined;
    }

    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      const m = session.messageHistory[i];
      if (m.type === "user_message" && m.content) {
        session.lastUserMessage = m.content.slice(0, 80);
        break;
      }
    }

    deps.recoverToolStartTimesFromHistory(session);
    deps.finalizeRecoveredDisconnectedTerminalTools(session, "restore_from_disk");
    deps.scheduleCodexToolResultWatchdogs(session, "restore_from_disk");
    await deps.reconcileRestoredBoardState(session);

    sessions.set(p.id, session);
    count += 1;
  }
  if (count > 0) {
    console.log(`[ws-bridge] Restored ${count} session(s) from disk`);
  }
  return count;
}

export function removeSession(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: {
    clearOptimisticRunningTimer: (session: SessionLike, reason: string) => void;
    clearAllCodexToolResultWatchdogs: (session: SessionLike, reason: string) => void;
    cleanupBranchState: (sessionId: string) => void;
    removeStoredSession?: (sessionId: string) => void;
    removeImages?: (sessionId: string) => void;
  },
): void {
  const session = sessions.get(sessionId);
  if (session) {
    deps.clearOptimisticRunningTimer(session, "remove_session");
    deps.clearAllCodexToolResultWatchdogs(session, "remove_session");
  }
  sessions.delete(sessionId);
  deps.cleanupBranchState(sessionId);
  deps.removeStoredSession?.(sessionId);
  deps.removeImages?.(sessionId);
}

export function closeSession(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: {
    clearOptimisticRunningTimer: (session: SessionLike, reason: string) => void;
    clearAllCodexToolResultWatchdogs: (session: SessionLike, reason: string) => void;
    cleanupBranchState: (sessionId: string) => void;
    removeStoredSession?: (sessionId: string) => void;
    removeImages?: (sessionId: string) => void;
  },
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  deps.clearOptimisticRunningTimer(session, "close_session");
  deps.clearAllCodexToolResultWatchdogs(session, "close_session");

  if (session.backendSocket) {
    try {
      session.backendSocket.close();
    } catch {}
    session.backendSocket = null;
  }
  if (session.codexAdapter) {
    session.codexAdapter.disconnect().catch(() => {});
    session.codexAdapter = null;
  }
  for (const ws of session.browserSockets) {
    try {
      ws.close();
    } catch {}
  }
  session.browserSockets.clear();

  sessions.delete(sessionId);
  deps.cleanupBranchState(sessionId);
  deps.removeStoredSession?.(sessionId);
  deps.removeImages?.(sessionId);
}

export function buildPersistedSessionPayload(session: SessionLike): PersistedSession {
  return {
    id: session.id,
    state: session.state,
    messageHistory: session.messageHistory,
    pendingMessages: session.pendingMessages,
    forceCompactPending: session.forceCompactPending,
    pendingCodexTurns: session.pendingCodexTurns,
    pendingCodexInputs: session.pendingCodexInputs,
    pendingCodexRollback: session.pendingCodexRollback,
    pendingCodexRollbackError: session.pendingCodexRollbackError,
    codexFreshTurnRequiredUntilTurnId: session.codexFreshTurnRequiredUntilTurnId,
    pendingPermissions: Array.from(session.pendingPermissions.entries()),
    eventBuffer: session.eventBuffer,
    nextEventSeq: session.nextEventSeq,
    lastAckSeq: session.lastAckSeq,
    processedClientMessageIds: session.processedClientMessageIds,
    toolResults: Array.from(session.toolResults.entries()),
    lastReadAt: session.lastReadAt,
    attentionReason: session.attentionReason,
    taskHistory: session.taskHistory,
    keywords: session.keywords,
    board: Array.from(session.board.values()),
    completedBoard: Array.from(session.completedBoard.values()),
    notifications: session.notifications,
  };
}

export function backendConnected(session: SessionLike): boolean {
  switch (session.backendType) {
    case "claude":
      return !!session.backendSocket;
    case "codex":
      return !!session.codexAdapter?.isConnected();
    case "claude-sdk":
      return !!session.claudeSdkAdapter?.isConnected();
    default:
      return false;
  }
}

export function backendAttached(session: SessionLike): boolean {
  return !!(session.backendSocket || session.codexAdapter || session.claudeSdkAdapter);
}

export function deriveBackendState(session: SessionLike): NonNullable<SessionState["backend_state"]> {
  if (session.state.backend_state === "broken") return "broken";
  if (backendConnected(session)) return "connected";
  if (
    session.state.backend_state === "initializing" ||
    session.state.backend_state === "resuming" ||
    session.state.backend_state === "recovering"
  ) {
    return session.state.backend_state;
  }
  return "disconnected";
}

export function setBackendState(
  session: SessionLike,
  backendState: NonNullable<SessionState["backend_state"]>,
  backendError: string | null,
  deps: Pick<SessionRegistryDeps, "broadcastSessionUpdate">,
): void {
  const changed = session.state.backend_state !== backendState || session.state.backend_error !== backendError;
  session.state.backend_state = backendState;
  session.state.backend_error = backendError;
  if (!changed) return;
  deps.broadcastSessionUpdate?.(session, {
    backend_state: backendState,
    backend_error: backendError,
  });
}

export function requestCodexAutoRecovery(
  session: SessionLike,
  reason: string,
  deps: Pick<
    SessionRegistryDeps,
    | "requestCliRelaunch"
    | "persistSession"
    | "emitTakodeEvent"
    | "attached"
    | "getLauncherSessionInfo"
    | "broadcastSessionUpdate"
    | "recoveryTimeoutMs"
    | "finalizeCodexRecoveringTurn"
  >,
): boolean {
  const launcherInfo = deps.getLauncherSessionInfo?.(session.id);
  if (!deps.requestCliRelaunch) return false;
  if (launcherInfo?.archived || launcherInfo?.killedByIdleManager) return false;
  if (session.state.backend_state === "broken") return false;
  setBackendState(session, "recovering", null, deps);
  deps.persistSession(session);
  console.log(`[ws-bridge] Requesting Codex auto-recovery for session ${sessionTag(session.id)} (${reason})`);
  deps.requestCliRelaunch(session.id);
  setTimeout(() => {
    if (session.state.backend_state !== "recovering") return;
    if (deps.attached?.(session)) return;
    console.warn(
      `[ws-bridge] Codex auto-recovery timeout for session ${sessionTag(session.id)} (${reason}) -- resetting to disconnected`,
    );
    setBackendState(session, "disconnected", null, deps);
    deps.emitTakodeEvent?.(session.id, "session_disconnected", {
      wasGenerating: session.isGenerating,
      reason: "recovery_timeout",
    });
    deps.finalizeCodexRecoveringTurn?.(session, "recovery_timeout");
    deps.persistSession(session);
  }, deps.recoveryTimeoutMs ?? 30000);
  return true;
}

export function markCodexAutoRecoveryFailed(
  session: SessionLike,
  deps: Pick<
    SessionRegistryDeps,
    "attached" | "emitTakodeEvent" | "persistSession" | "broadcastSessionUpdate" | "finalizeCodexRecoveringTurn"
  >,
): void {
  if (session.backendType !== "codex") return;
  if (session.state.backend_state !== "recovering") return;
  if (deps.attached?.(session)) return;
  setBackendState(session, "disconnected", null, deps);
  deps.emitTakodeEvent?.(session.id, "session_disconnected", {
    wasGenerating: session.isGenerating,
    reason: "recovery_failed",
  });
  deps.finalizeCodexRecoveringTurn?.(session, "recovery_failed");
  deps.persistSession(session);
}

export function hasAssistantReplay(session: SessionLike, messageId: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (message): message is BrowserIncomingMessage & { type: "assistant"; message: { id?: string } } =>
      message.type === "assistant" && (message as { message?: { id?: string } }).message?.id === messageId,
  );
}

export function hasUserPromptReplay(session: SessionLike, cliUuid: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (message): message is BrowserIncomingMessage & { type: "user_message"; cliUuid?: string } =>
      message.type === "user_message" && (message as { cliUuid?: string }).cliUuid === cliUuid,
  );
}

export function hasResultReplay(session: SessionLike, resultUuid: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (message): message is BrowserIncomingMessage & { type: "result"; data?: { uuid?: string } } =>
      message.type === "result" && (message as { data?: { uuid?: string } }).data?.uuid === resultUuid,
  );
}

export function hasToolResultPreviewReplay(session: SessionLike, toolUseId: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (message): message is BrowserIncomingMessage & { type: "tool_result_preview"; previews?: ToolResultPreview[] } =>
      message.type === "tool_result_preview" &&
      Array.isArray((message as { previews?: ToolResultPreview[] }).previews) &&
      ((message as { previews?: ToolResultPreview[] }).previews || []).some(
        (preview) => preview.tool_use_id === toolUseId,
      ),
  );
}

export function hasTaskNotificationReplay(session: SessionLike, taskId: string, toolUseId: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (
      message,
    ): message is BrowserIncomingMessage & { type: "task_notification"; task_id: string; tool_use_id: string } =>
      message.type === "task_notification" &&
      (message as { task_id?: string }).task_id === taskId &&
      (message as { tool_use_id?: string }).tool_use_id === toolUseId,
  );
}

export function hasCompactBoundaryReplay(
  session: SessionLike,
  cliUuid: string | undefined,
  meta: CLISystemCompactBoundaryMessage["compact_metadata"],
): boolean {
  if (cliUuid) {
    const matchedUuid = findHistoryReplayEntry(
      session,
      (message): message is BrowserIncomingMessage & { type: "compact_marker"; cliUuid?: string } =>
        message.type === "compact_marker" && (message as { cliUuid?: string }).cliUuid === cliUuid,
    );
    if (matchedUuid) return true;
  }

  const last = session.messageHistory[session.messageHistory.length - 1] as
    | { type?: string; trigger?: string; preTokens?: number; summary?: string }
    | undefined;
  return (
    last?.type === "compact_marker" &&
    !last.summary &&
    (last.trigger ?? null) === (meta?.trigger ?? null) &&
    (last.preTokens ?? null) === (meta?.pre_tokens ?? null)
  );
}

function findHistoryReplayEntry<T extends BrowserIncomingMessage>(
  session: SessionLike,
  predicate: (message: BrowserIncomingMessage) => message is T,
): T | undefined {
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    const entry = session.messageHistory[i];
    if (predicate(entry)) return entry;
  }
  return undefined;
}

type AttentionReason = "action" | "error" | "review";
type TurnTriggerSource = "user" | "leader" | "system" | "unknown";

type IdleState = {
  timer: ReturnType<typeof setTimeout> | null;
  idleSince: number | null;
  notifiedWhileIdle: boolean;
  leaderUnreadSetByGroupIdle: boolean;
};

export interface LeaderIdleStateLike {
  leaderGroupIdleStates: Map<string, IdleState>;
  sessions: Map<string, SessionLike & { isGenerating: boolean }>;
}

type LeaderIdleDeps = {
  getLauncherSessionInfo: NonNullable<SessionRegistryDeps["getLauncherSessionInfo"]>;
  getHerdedSessionIds: NonNullable<SessionRegistryDeps["getHerdedSessionIds"]>;
  getSessionNum: NonNullable<SessionRegistryDeps["getSessionNum"]>;
  getSessionName: NonNullable<SessionRegistryDeps["getSessionName"]>;
  deriveSessionStatus: NonNullable<SessionRegistryDeps["deriveSessionStatus"]>;
  clearAttentionAndMarkRead: NonNullable<SessionRegistryDeps["clearAttentionAndMarkRead"]>;
  setAttentionReview: NonNullable<SessionRegistryDeps["setAttentionReview"]>;
  scheduleCompletedNotification: NonNullable<SessionRegistryDeps["scheduleCompletedNotification"]>;
  broadcastLeaderGroupIdle: NonNullable<SessionRegistryDeps["broadcastLeaderGroupIdle"]>;
  recordServerEvent: NonNullable<SessionRegistryDeps["recordServerEvent"]>;
  delayMs: NonNullable<SessionRegistryDeps["delayMs"]>;
};

export function setAttention(
  session: SessionLike,
  reason: AttentionReason,
  deps: Pick<SessionRegistryDeps, "isHerdedWorkerSession" | "broadcastToBrowsers" | "persistSession">,
  options?: { allowHerdedWorker?: boolean },
): void {
  if (deps.isHerdedWorkerSession?.(session) && !options?.allowHerdedWorker) return;
  const current = session.attentionReason as AttentionReason | null;
  const pri = { action: 3, error: 2, review: 1 } as const;
  if (current && pri[current] >= pri[reason]) return;
  session.attentionReason = reason;
  deps.broadcastToBrowsers?.(session, {
    type: "session_update",
    session: { attentionReason: session.attentionReason },
  } as BrowserIncomingMessage);
  deps.persistSession(session);
}

export function clearAttentionAndMarkRead(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  if (session.attentionReason === null) return;
  session.attentionReason = null;
  session.lastReadAt = Date.now();
  deps.broadcastToBrowsers?.(session, {
    type: "session_update",
    session: { attentionReason: null, lastReadAt: session.lastReadAt },
  } as BrowserIncomingMessage);
  deps.persistSession(session);
}

export function notifyUser(
  session: SessionLike,
  category: "needs-input" | "review",
  summary: string,
  deps: Pick<
    SessionRegistryDeps,
    "isHerdedWorkerSession" | "broadcastToBrowsers" | "persistSession" | "emitTakodeEvent" | "scheduleNotification"
  >,
  options: { suggestedAnswers?: string[] } = {},
): { ok: true; anchoredMessageId: string | null; notificationId: string } {
  const lastAssistantIndex = findLastAssistantMessageIndex(session);
  const lastAssistant =
    lastAssistantIndex !== undefined
      ? (session.messageHistory[lastAssistantIndex] as
          | (BrowserIncomingMessage & { type: "assistant"; message: { id: string } })
          | undefined)
      : undefined;
  const lastTopLevelAssistant =
    lastAssistant?.type === "assistant" && lastAssistant.parent_tool_use_id == null ? lastAssistant : undefined;
  const anchoredAssistant =
    lastTopLevelAssistant ??
    (session.messageHistory.findLast(
      (message: any) => message.type === "assistant" && message.parent_tool_use_id == null,
    ) as (BrowserIncomingMessage & { type: "assistant"; message: { id: string } }) | undefined);
  const anchoredAssistantIndex =
    lastTopLevelAssistant && lastAssistantIndex !== undefined
      ? lastAssistantIndex
      : (() => {
          if (!anchoredAssistant) return undefined;
          for (let i = session.messageHistory.length - 1; i >= 0; i--) {
            const entry = session.messageHistory[i];
            if (entry.type === "assistant" && entry.message?.id === anchoredAssistant.message.id) return i;
          }
          return undefined;
        })();

  const anchoredMessageId = anchoredAssistant?.message.id ?? null;
  const timestamp = Date.now();
  const suggestedAnswers =
    category === "needs-input" && options.suggestedAnswers?.length ? options.suggestedAnswers : undefined;
  const anchoredNotification = {
    category,
    timestamp,
    summary,
    ...(suggestedAnswers ? { suggestedAnswers } : {}),
  } as const;

  const nextNotificationCounter = Number.isInteger(session.notificationCounter) ? session.notificationCounter + 1 : 1;
  session.notificationCounter = nextNotificationCounter;

  const notif: SessionNotification = {
    id: `n-${nextNotificationCounter}`,
    category,
    summary,
    ...(suggestedAnswers ? { suggestedAnswers } : {}),
    timestamp,
    messageId: anchoredMessageId,
    done: false,
  };
  session.notifications.push(notif);

  if (deps.isHerdedWorkerSession?.(session)) {
    if (category === "needs-input") {
      deps.emitTakodeEvent?.(session.id, "notification_needs_input", {
        summary,
        notificationId: notif.id,
        messageId: anchoredMessageId,
        ...(suggestedAnswers ? { suggestedAnswers } : {}),
        ...(anchoredAssistantIndex !== undefined ? { msg_index: anchoredAssistantIndex } : {}),
      });
    }
    deps.persistSession(session);
    return { ok: true, anchoredMessageId, notificationId: notif.id };
  }

  if (anchoredAssistant) {
    (anchoredAssistant as Record<string, unknown>).notification = anchoredNotification;
  }

  deps.broadcastToBrowsers?.(session, {
    type: "notification_update",
    notifications: session.notifications,
  } as BrowserIncomingMessage);

  const reason = category === "needs-input" ? "action" : "review";
  setAttention(session, reason, deps);

  deps.scheduleNotification?.(session.id, category === "needs-input" ? "question" : "completed", summary, {
    skipReadCheck: true,
  });

  if (lastAssistant) {
    deps.broadcastToBrowsers?.(session, {
      type: "notification_anchored",
      messageId: anchoredMessageId,
      notification: anchoredNotification,
    } as BrowserIncomingMessage);
  }

  deps.persistSession(session);
  return { ok: true, anchoredMessageId, notificationId: notif.id };
}

export function notifyUserBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  category: "needs-input" | "review",
  summary: string,
  deps: Pick<
    SessionRegistryDeps,
    "isHerdedWorkerSession" | "broadcastToBrowsers" | "persistSession" | "emitTakodeEvent" | "scheduleNotification"
  >,
  options: { suggestedAnswers?: string[] } = {},
): { ok: true; anchoredMessageId: string | null; notificationId: string } | { ok: false; error: string } {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: "Session not found" };
  return notifyUser(session, category, summary, deps, options);
}

function getSortedBoardRows(session: SessionLike): BoardRow[] {
  if (!session.board?.values) return [];
  return Array.from(session.board.values() as Iterable<BoardRow>).sort((a, b) => a.createdAt - b.createdAt);
}

function getSortedCompletedBoardRows(session: SessionLike): BoardRow[] {
  if (!session.completedBoard?.values) return [];
  return Array.from(session.completedBoard.values() as Iterable<BoardRow>).sort(
    (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0),
  );
}

function removeNotificationLinksFromBoardRows(session: SessionLike, notifId: string): boolean {
  const normalizedNotificationId = notifId.trim().toLowerCase();
  if (!/^n-\d+$/.test(normalizedNotificationId)) return false;

  let changed = false;
  const boardMaps = [session.board, session.completedBoard].filter(
    (boardMap): boardMap is Map<string, BoardRow> => !!boardMap?.values,
  );
  for (const boardMap of boardMaps) {
    for (const row of boardMap.values()) {
      if (!Array.isArray(row.waitForInput) || row.waitForInput.length === 0) continue;
      const currentIds = [
        ...new Set(row.waitForInput.map((notificationId: string) => notificationId.trim().toLowerCase())),
      ]
        .filter((notificationId) => /^n-\d+$/.test(notificationId))
        .sort((a, b) => Number.parseInt(a.slice(2), 10) - Number.parseInt(b.slice(2), 10));
      if (!currentIds.includes(normalizedNotificationId)) continue;

      const nextIds = currentIds.filter((notificationId) => notificationId !== normalizedNotificationId);
      row.waitForInput = nextIds.length > 0 ? nextIds : undefined;
      boardMap.set(row.questId, row);
      changed = true;
    }
  }

  return changed;
}

export function markNotificationDone(
  session: SessionLike,
  notifId: string,
  done: boolean,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession" | "broadcastBoard">,
): boolean {
  const notif = session.notifications.find((entry: SessionNotification) => entry.id === notifId);
  if (!notif) return false;
  notif.done = done;
  const clearedBoardWaits =
    done && notif.category === "needs-input" ? removeNotificationLinksFromBoardRows(session, notifId) : false;
  deps.broadcastToBrowsers?.(session, {
    type: "notification_update",
    notifications: session.notifications,
  } as BrowserIncomingMessage);
  if (clearedBoardWaits) {
    deps.broadcastBoard?.(session, getSortedBoardRows(session), getSortedCompletedBoardRows(session));
  }
  if (done) clearActionAttentionIfNoNotifications(session, deps);
  deps.persistSession(session);
  return true;
}

export function markNotificationDoneBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  notifId: string,
  done: boolean,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession" | "broadcastBoard">,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return markNotificationDone(session, notifId, done, deps);
}

export function markAllNotificationsDone(
  session: SessionLike,
  done: boolean,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession" | "broadcastBoard">,
): number {
  let count = 0;
  let clearedBoardWaits = false;
  for (const notif of session.notifications) {
    if (notif.done === done) continue;
    notif.done = done;
    if (done && notif.category === "needs-input") {
      clearedBoardWaits = removeNotificationLinksFromBoardRows(session, notif.id) || clearedBoardWaits;
    }
    count += 1;
  }
  if (count > 0) {
    deps.broadcastToBrowsers?.(session, {
      type: "notification_update",
      notifications: session.notifications,
    } as BrowserIncomingMessage);
    if (clearedBoardWaits) {
      deps.broadcastBoard?.(session, getSortedBoardRows(session), getSortedCompletedBoardRows(session));
    }
    if (done) clearActionAttentionIfNoNotifications(session, deps);
    deps.persistSession(session);
  }
  return count;
}

export function markAllNotificationsDoneBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  done: boolean,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession" | "broadcastBoard">,
): number {
  const session = sessions.get(sessionId);
  if (!session) return -1;
  return markAllNotificationsDone(session, done, deps);
}

export function clearActionAttentionIfNoNotifications(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers">,
): void {
  if (session.pendingPermissions.size > 0) return;
  const hasOpenNeedsInput = session.notifications.some(
    (notif: SessionNotification) => !notif.done && notif.category === "needs-input",
  );
  if (!hasOpenNeedsInput && session.attentionReason === "action") {
    session.attentionReason = null;
    deps.broadcastToBrowsers?.(session, {
      type: "session_update",
      session: { attentionReason: null },
    } as BrowserIncomingMessage);
  }
}

export function markSessionUnread(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "isHerdedWorkerSession" | "broadcastToBrowsers" | "persistSession">,
): boolean {
  if (deps.isHerdedWorkerSession?.(session)) return true;
  session.attentionReason = "review";
  deps.broadcastToBrowsers?.(session, {
    type: "session_update",
    session: { attentionReason: "review" },
  } as BrowserIncomingMessage);
  deps.persistSession(session);
  return true;
}

export function markSessionUnreadBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: Pick<SessionRegistryDeps, "isHerdedWorkerSession" | "broadcastToBrowsers" | "persistSession">,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return markSessionUnread(session, deps);
}

export function getSessionAttentionState(session: SessionLike): {
  lastReadAt: number;
  attentionReason: AttentionReason | null;
} {
  return {
    lastReadAt: session.lastReadAt,
    attentionReason: session.attentionReason,
  };
}

export function getAllSessionStates(sessions: Map<string, SessionLike>): SessionState[] {
  return Array.from(sessions.values()).map((session) => session.state);
}

export function isSessionBusy(sessions: Map<string, SessionLike>, sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return session.isGenerating || session.pendingPermissions.size > 0;
}

export async function killSession(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: { killLauncher: (sessionId: string) => Promise<boolean> },
): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (session?.claudeSdkAdapter) {
    try {
      await session.claudeSdkAdapter.disconnect();
    } catch {}
  }
  return deps.killLauncher(sessionId);
}

export function getLastUserMessage(sessions: Map<string, SessionLike>, sessionId: string): string | undefined {
  return sessions.get(sessionId)?.lastUserMessage;
}

export function getMessageHistory(
  sessions: Map<string, SessionLike>,
  sessionId: string,
): BrowserIncomingMessage[] | null {
  const session = sessions.get(sessionId);
  return session ? session.messageHistory : null;
}

export function getSessionMessages(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  from: number,
  to: number,
): BrowserIncomingMessage[] | null {
  const history = getMessageHistory(sessions, sessionId);
  if (!history) return null;
  const clampedFrom = Math.max(0, from);
  const clampedTo = Math.min(history.length - 1, to);
  if (clampedFrom > clampedTo) return [];
  return history.slice(clampedFrom, clampedTo + 1);
}

export function getSessionActivityPreview(sessions: Map<string, SessionLike>, sessionId: string): string | undefined {
  return sessions.get(sessionId)?.lastActivityPreview;
}

export function getSessionKeywords(sessions: Map<string, SessionLike>, sessionId: string): string[] {
  return sessions.get(sessionId)?.keywords ?? [];
}

export function getSessionTaskHistory(sessions: Map<string, SessionLike>, sessionId: string): SessionTaskEntry[] {
  return sessions.get(sessionId)?.taskHistory ?? [];
}

export function getHerdDiagnostics(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  now = Date.now(),
  deps?: { getHerdDispatcherDiagnostics?: (sessionId: string) => Record<string, unknown> },
): Record<string, unknown> | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const generationElapsedMs =
    session.isGenerating && session.generationStartedAt ? now - session.generationStartedAt : null;
  let oldestToolAgeMs: number | null = null;
  for (const startedAt of session.toolStartTimes.values()) {
    const age = now - startedAt;
    if (oldestToolAgeMs === null || age > oldestToolAgeMs) oldestToolAgeMs = age;
  }
  return {
    isGenerating: session.isGenerating,
    generationStartedAt: session.generationStartedAt,
    generationElapsedMs,
    queuedTurnStarts: session.queuedTurnStarts,
    queuedTurnReasons: session.queuedTurnReasons,
    cliConnected: backendConnected(session),
    cliInitReceived: session.cliInitReceived,
    pendingMessagesCount: session.pendingMessages.length,
    pendingPermissionsCount: session.pendingPermissions.size,
    disconnectGraceActive: session.disconnectGraceTimer !== null,
    disconnectWasGenerating: session.disconnectWasGenerating,
    seamlessReconnect: session.seamlessReconnect,
    stuckNotifiedAt: session.stuckNotifiedAt,
    toolStartTimesCount: session.toolStartTimes.size,
    oldestToolAgeMs,
    ...(deps?.getHerdDispatcherDiagnostics ? { herdDispatcher: deps.getHerdDispatcherDiagnostics(sessionId) } : {}),
  };
}

export function broadcastNameUpdate(
  session: SessionLike,
  name: string,
  source: "quest" | undefined,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers">,
): void {
  console.log(
    `[ws-bridge] broadcastNameUpdate: "${name}" source=${source ?? "none"} browsers=${session.browserSockets.size} session=${sessionTag(session.id)}`,
  );
  deps.broadcastToBrowsers?.(session, {
    type: "session_name_update",
    name,
    ...(source && { source }),
  } as BrowserIncomingMessage);
}

export function setSessionClaimedQuest(
  session: SessionLike,
  quest: { id: string; title: string; status?: string } | null,
  deps: Pick<
    SessionRegistryDeps,
    "broadcastToBrowsers" | "persistSession" | "getLauncherSessionInfo" | "onSessionNamedByQuest"
  >,
): void {
  console.log(
    `[ws-bridge] setSessionClaimedQuest: quest=${quest?.id ?? "null"} title="${quest?.title ?? ""}" status=${quest?.status ?? "null"} browsers=${session.browserSockets.size} session=${session.id}`,
  );
  const prevId = session.state.claimedQuestId ?? null;
  const prevTitle = session.state.claimedQuestTitle ?? null;
  const prevStatus = session.state.claimedQuestStatus ?? null;
  const nextId = quest?.id ?? null;
  const nextTitle = quest?.title ?? null;
  const nextStatus = quest?.status ?? null;
  if (prevId === nextId && prevTitle === nextTitle && prevStatus === nextStatus) {
    return;
  }
  session.state.claimedQuestId = quest?.id;
  session.state.claimedQuestTitle = quest?.title;
  session.state.claimedQuestStatus = quest?.status;
  const isQuestActive = !!quest?.title && (quest?.status === "in_progress" || quest?.status === "needs_verification");
  const isOrchestrator = deps.getLauncherSessionInfo?.(session.id)?.isOrchestrator === true;
  if (isQuestActive && !isOrchestrator && deps.onSessionNamedByQuest) {
    deps.onSessionNamedByQuest(session.id, quest.title);
  }
  deps.broadcastToBrowsers?.(session, {
    type: "session_quest_claimed",
    quest,
  } as BrowserIncomingMessage);
  if (isQuestActive && !isOrchestrator) {
    broadcastNameUpdate(session, quest.title, "quest", deps);
  }
  deps.persistSession(session);
}

export function setSessionClaimedQuestBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  quest: { id: string; title: string; status?: string } | null,
  deps: Pick<
    SessionRegistryDeps,
    "broadcastToBrowsers" | "persistSession" | "getLauncherSessionInfo" | "onSessionNamedByQuest"
  >,
): void {
  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`[ws-bridge] setSessionClaimedQuest: session ${sessionId} not found`);
    return;
  }
  setSessionClaimedQuest(session, quest, deps);
}

export function broadcastNameUpdateBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  name: string,
  source: "quest" | undefined,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers">,
): void {
  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`[ws-bridge] broadcastNameUpdate: session ${sessionTag(sessionId)} not found in sessions map`);
    return;
  }
  broadcastNameUpdate(session, name, source, deps);
}

export function getNotifications(sessions: Map<string, SessionLike>, sessionId: string): SessionNotification[] {
  return sessions.get(sessionId)?.notifications ?? [];
}

export function summarizePendingPermissions(session: SessionLike): string | null {
  if (session.pendingPermissions.size === 0) return null;
  const tools = new Set<string>();
  for (const perm of session.pendingPermissions.values()) {
    tools.add(perm.tool_name);
  }
  if (tools.has("ExitPlanMode")) return "pending plan";
  if (tools.has("AskUserQuestion")) return "pending question";
  if (tools.size === 1) return `pending ${[...tools][0]}`;
  return `${session.pendingPermissions.size} pending permissions`;
}

export function countPendingUserPermissions(session: SessionLike): number {
  let count = 0;
  for (const perm of session.pendingPermissions.values()) {
    if (!perm?.evaluating && !perm?.autoApproved) count++;
  }
  return count;
}

export function getSessionActivitySnapshot(session: SessionLike): {
  attentionReason: AttentionReason | null;
  lastReadAt?: number;
  pendingPermissionCount: number;
  pendingPermissionSummary: string | null;
} {
  return {
    attentionReason: (session.attentionReason as AttentionReason | null) ?? null,
    ...(typeof session.lastReadAt === "number" ? { lastReadAt: session.lastReadAt } : {}),
    pendingPermissionCount: countPendingUserPermissions(session),
    pendingPermissionSummary: summarizePendingPermissions(session),
  };
}

export function getSessionAttentionStateWithSummary(
  sessions: Map<string, SessionLike>,
  sessionId: string,
): {
  lastReadAt: number;
  attentionReason: AttentionReason | null;
  pendingPermissionSummary: string | null;
} | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const base = getSessionAttentionState(session);
  return {
    ...base,
    pendingPermissionSummary: summarizePendingPermissions(session),
  };
}

export function getCurrentTurnTriggerSource(
  session: SessionLike,
  deps: { isSystemSourceTag: (agentSource: { sessionId: string; sessionLabel?: string } | undefined) => boolean },
): TurnTriggerSource {
  for (const historyIndex of session.userMessageIdsThisTurn) {
    const entry = session.messageHistory[historyIndex] as
      | Extract<BrowserIncomingMessage, { type: "user_message" }>
      | undefined;
    if (!entry || entry.type !== "user_message") continue;
    if (!entry.agentSource) return "user";
    if (deps.isSystemSourceTag(entry.agentSource)) return "system";
    return "leader";
  }
  return "unknown";
}

export function shouldNotifyHumanOnResult(
  session: SessionLike,
  turnTriggerSource: TurnTriggerSource,
  deps: {
    isHerdedWorkerSession: (session: SessionLike) => boolean;
    isLeaderSession: (session: SessionLike) => boolean;
  },
): boolean {
  if (deps.isHerdedWorkerSession(session)) {
    return turnTriggerSource === "user";
  }
  if (deps.isLeaderSession(session)) return false;
  return true;
}

export function handleResultAttentionAndNotifications(
  session: SessionLike,
  resultMsg: CLIResultMessage,
  turnTriggerSource: TurnTriggerSource,
  deps: Pick<
    SessionRegistryDeps,
    | "isHerdedWorkerSession"
    | "getLauncherSessionInfo"
    | "broadcastToBrowsers"
    | "persistSession"
    | "emitTakodeEvent"
    | "scheduleResultCompletedNotification"
    | "scheduleErrorNotification"
  >,
): void {
  const isHerdedWorker = deps.isHerdedWorkerSession?.(session) ?? false;
  const shouldNotifyHuman = shouldNotifyHumanOnResult(session, turnTriggerSource, {
    isHerdedWorkerSession: () => isHerdedWorker,
    isLeaderSession: (targetSession) => deps.getLauncherSessionInfo?.(targetSession.id)?.isOrchestrator === true,
  });

  if (shouldNotifyHuman) {
    setAttention(session, resultMsg.is_error ? "error" : "review", deps, {
      allowHerdedWorker: isHerdedWorker && turnTriggerSource === "user",
    });
  }

  if (resultMsg.is_error) {
    const message = typeof resultMsg.result === "string" ? resultMsg.result.slice(0, 200) : "Unknown error";
    deps.emitTakodeEvent?.(session.id, "session_error", { error: message });
  }

  if (!shouldNotifyHuman) return;
  if (resultMsg.is_error) {
    deps.scheduleErrorNotification?.(
      session.id,
      typeof resultMsg.result === "string" ? resultMsg.result.slice(0, 100) : "Error",
    );
    return;
  }
  deps.scheduleResultCompletedNotification?.(session.id);
}

export function markSessionRead(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession">,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  clearAttentionAndMarkRead(session, deps);
  return true;
}

export function markAllSessionsRead(
  sessions: Map<string, SessionLike>,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  for (const session of sessions.values()) {
    clearAttentionAndMarkRead(session, deps);
  }
}

export function clearActionAttentionIfNoPermissions(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  if (session.pendingPermissions.size !== 0 || session.attentionReason !== "action") return;
  session.attentionReason = null;
  deps.broadcastToBrowsers?.(session, {
    type: "session_update",
    session: { attentionReason: null },
  } as BrowserIncomingMessage);
  deps.persistSession?.(session);
}

export function onSessionActivityStateChanged(
  state: LeaderIdleStateLike,
  sessionId: string,
  reason: string,
  deps: LeaderIdleDeps,
): void {
  const info = deps.getLauncherSessionInfo(sessionId);
  if (!info) return;
  if (info.isOrchestrator) {
    updateLeaderGroupIdleState(state, sessionId, `${reason}:leader`, deps);
  }
  if (info.herdedBy) {
    updateLeaderGroupIdleState(state, info.herdedBy, `${reason}:worker`, deps);
  }
}

export function updateLeaderGroupIdleState(
  state: LeaderIdleStateLike,
  leaderId: string,
  reason: string,
  deps: LeaderIdleDeps,
): void {
  const leaderInfo = deps.getLauncherSessionInfo(leaderId);
  if (!leaderInfo?.isOrchestrator) {
    const stale = state.leaderGroupIdleStates.get(leaderId);
    if (stale) {
      clearLeaderGroupIdleTimer(stale);
      state.leaderGroupIdleStates.delete(leaderId);
    }
    return;
  }
  const members = [leaderId, ...deps.getHerdedSessionIds(leaderId)];
  const allIdle = members.every((memberId) => {
    const session = state.sessions.get(memberId);
    if (!session) return false;
    return deps.deriveSessionStatus(session) === "idle" && session.pendingPermissions.size === 0;
  });
  const idleState = getOrCreateLeaderGroupIdleState(state, leaderId);
  if (!allIdle) {
    clearLeaderGroupIdleTimer(idleState);
    idleState.idleSince = null;
    idleState.notifiedWhileIdle = false;
    if (idleState.leaderUnreadSetByGroupIdle) {
      const leaderSession = state.sessions.get(leaderId);
      if (leaderSession?.attentionReason === "review") deps.clearAttentionAndMarkRead(leaderSession);
      idleState.leaderUnreadSetByGroupIdle = false;
    }
    return;
  }
  if (idleState.notifiedWhileIdle || idleState.timer) return;
  idleState.idleSince = Date.now();
  const leaderNum = deps.getSessionNum(leaderId);
  const leaderTag = leaderNum !== undefined ? `#${leaderNum}` : leaderId.slice(0, 8);
  idleState.timer = setTimeout(() => {
    idleState.timer = null;
    if (idleState.notifiedWhileIdle) return;
    const leaderSession = state.sessions.get(leaderId);
    if (!leaderSession) return;
    const now = Date.now();
    const idleForMs = idleState.idleSince ? Math.max(0, now - idleState.idleSince) : deps.delayMs;
    const name = deps.getSessionName(leaderId);
    const leaderLabel =
      leaderNum !== undefined && name
        ? `#${leaderNum} ${name}`
        : leaderNum !== undefined
          ? `#${leaderNum}`
          : name || leaderId.slice(0, 8);
    const detail = `${leaderLabel} is idle and waiting for attention`;
    const priorAttention = leaderSession.attentionReason;
    deps.setAttentionReview(leaderSession);
    deps.scheduleCompletedNotification(leaderId, detail);
    deps.broadcastLeaderGroupIdle(leaderSession, {
      type: "leader_group_idle",
      leader_session_id: leaderId,
      leader_label: leaderLabel,
      member_count: members.length,
      idle_for_ms: idleForMs,
      timestamp: now,
    });
    idleState.leaderUnreadSetByGroupIdle = priorAttention === null && leaderSession.attentionReason === "review";
    idleState.notifiedWhileIdle = true;
  }, deps.delayMs);
  deps.recordServerEvent(
    leaderId,
    "leader_group_idle_timer_started",
    { reason, members: members.length },
    leaderInfo.backendType ?? "claude",
    leaderInfo.cwd,
  );
  console.log(`[ws-bridge] Group idle timer started for ${leaderTag} (reason: ${reason}, members: ${members.length})`);
}

export function trackCodexQuestCommands(session: SessionLike, content: ContentBlock[]): void {
  for (const block of content) {
    if (block.type !== "tool_use" || block.name !== "Bash") continue;
    const command = typeof block.input.command === "string" ? block.input.command : "";
    if (!command) continue;
    const parsed = detectQuestEvent({ kind: "command", text: command });
    if (!parsed?.questId) continue;
    session.pendingQuestCommands.set(block.id, {
      questId: parsed.questId,
      targetStatus: parsed.targetStatus,
    });
  }
}

export async function reconcileCodexQuestToolResult(
  session: SessionLike,
  toolResult: Extract<ContentBlock, { type: "tool_result" }>,
  deps: Pick<
    SessionRegistryDeps,
    | "resolveQuestTitle"
    | "broadcastTaskHistory"
    | "persistSession"
    | "broadcastToBrowsers"
    | "getLauncherSessionInfo"
    | "onSessionNamedByQuest"
  >,
): Promise<void> {
  const pending = session.pendingQuestCommands.get(toolResult.tool_use_id);
  if (!pending) return;
  session.pendingQuestCommands.delete(toolResult.tool_use_id);
  if (toolResult.is_error) return;
  const raw = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
  const parsedResult = detectQuestEvent({ kind: "result", text: raw });
  if (!parsedResult) return;
  const questId = parsedResult?.questId || pending.questId;
  const status = parsedResult?.status || pending.targetStatus;
  if (!questId || !status) return;
  const title = await resolveQuestLifecycleTitle(session, questId, parsedResult?.title, deps);
  if (status === "done") {
    if (session.state.claimedQuestId === questId) {
      setSessionClaimedQuest(session, null, deps);
    }
    return;
  }
  setSessionClaimedQuest(session, { id: questId, title, status }, deps);
  if (status !== "in_progress") return;
  const alreadyTracked = session.taskHistory.some(
    (entry: SessionTaskEntry) => entry.source === "quest" && entry.questId === questId,
  );
  if (alreadyTracked) return;
  let triggerMsgId = `quest-${questId}`;
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    const msg = session.messageHistory[i];
    if (msg.type === "user_message" && msg.id) {
      triggerMsgId = msg.id;
      break;
    }
  }
  addTaskEntry(
    session,
    {
      title,
      action: "new",
      timestamp: Date.now(),
      triggerMessageId: triggerMsgId,
      source: "quest",
      questId,
    },
    deps,
  );
}

export function addTaskEntry(
  session: SessionLike,
  entry: SessionTaskEntry,
  deps: Pick<SessionRegistryDeps, "broadcastTaskHistory" | "persistSession">,
): void {
  if (entry.action === "revise") {
    const last = session.taskHistory[session.taskHistory.length - 1];
    if (last) last.title = entry.title;
  } else {
    const last = session.taskHistory[session.taskHistory.length - 1];
    if (isConsecutiveDuplicateTaskEntry(last, entry)) return;
    session.taskHistory.push(entry);
  }
  deps.broadcastTaskHistory?.(session);
  deps.persistSession(session);
}

function isConsecutiveDuplicateTaskEntry(previous: SessionTaskEntry | undefined, next: SessionTaskEntry): boolean {
  if (!previous) return false;
  return (
    previous.action === next.action &&
    previous.title === next.title &&
    previous.triggerMessageId === next.triggerMessageId &&
    previous.source === next.source &&
    previous.questId === next.questId
  );
}

export function updateQuestTaskEntries(
  session: SessionLike,
  questId: string,
  newTitle: string,
  deps: Pick<SessionRegistryDeps, "broadcastTaskHistory" | "persistSession">,
): void {
  let changed = false;
  for (const entry of session.taskHistory) {
    if (entry.source === "quest" && entry.questId === questId && entry.title !== newTitle) {
      entry.title = newTitle;
      changed = true;
    }
  }
  if (changed) {
    deps.broadcastTaskHistory?.(session);
    deps.persistSession(session);
  }
}

export function mergeKeywords(
  session: SessionLike,
  newKeywords: string[],
  deps: Pick<SessionRegistryDeps, "persistSession">,
): void {
  if (newKeywords.length === 0) return;
  const existing = new Set(session.keywords);
  for (const keyword of newKeywords) existing.add(keyword);
  session.keywords = [...existing].slice(0, 30);
  deps.persistSession(session);
}

async function resolveQuestLifecycleTitle(
  session: SessionLike,
  questId: string,
  parsedTitle: string | undefined,
  deps: Pick<SessionRegistryDeps, "resolveQuestTitle">,
): Promise<string> {
  const candidateTitle = parsedTitle?.trim();
  if (candidateTitle && !isBareQuestIdTitle(candidateTitle, questId)) return candidateTitle;
  const currentTitle =
    session.state.claimedQuestId === questId && typeof session.state.claimedQuestTitle === "string"
      ? session.state.claimedQuestTitle.trim()
      : "";
  if (currentTitle && !isBareQuestIdTitle(currentTitle, questId)) return currentTitle;
  if (deps.resolveQuestTitle) {
    try {
      const resolvedTitle = (await deps.resolveQuestTitle(questId))?.trim();
      if (resolvedTitle && !isBareQuestIdTitle(resolvedTitle, questId)) return resolvedTitle;
    } catch {}
  }
  return currentTitle || candidateTitle || questId;
}

function isBareQuestIdTitle(title: string | null | undefined, questId?: string): boolean {
  if (!title) return false;
  const normalized = title.trim().toLowerCase();
  if (!/^q-\d+$/.test(normalized)) return false;
  return questId ? normalized === questId.toLowerCase() : true;
}

function findLastAssistantMessageIndex(session: SessionLike): number | undefined {
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    if (session.messageHistory[i]?.type === "assistant") return i;
  }
  return undefined;
}

function clearLeaderGroupIdleTimer(state: IdleState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function getOrCreateLeaderGroupIdleState(state: LeaderIdleStateLike, leaderId: string): IdleState {
  let current = state.leaderGroupIdleStates.get(leaderId);
  if (!current) {
    current = { timer: null, idleSince: null, notifiedWhileIdle: false, leaderUnreadSetByGroupIdle: false };
    state.leaderGroupIdleStates.set(leaderId, current);
  }
  return current;
}
