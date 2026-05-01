import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { computeHistoryMessagesSyncHash, computeHistoryPrefixSyncHash } from "../../shared/history-sync-hash.js";
import { getHistoryWindowTurnCount } from "../../shared/history-window.js";
import { buildLeaderProjectionSnapshot } from "../../shared/leader-projection.js";
import { sessionTag } from "../session-tag.js";
import { findTurnBoundaries } from "../takode-messages.js";
import { getTrafficMessageType, trafficStats } from "../traffic-stats.js";
import { shouldBufferForReplay } from "./replay-buffer-policy.js";
import { routeFromHistoryEntry } from "../thread-routing-metadata.js";
import type { ThreadRouteMetadata } from "../thread-routing-metadata.js";
import type {
  ActiveTurnRoute,
  BoardRow,
  BoardRowSessionStatus,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BufferedBrowserEvent,
  CodexOutboundTurn,
  PendingCodexInput,
  PermissionRequest,
  ReplayableBrowserIncomingMessage,
  SessionAttentionRecord,
  SessionNotification,
  SessionTaskEntry,
  SessionState,
  TakodeHerdBatchSnapshot,
  VsCodeOpenFileCommand,
  VsCodeSelectionState,
  VsCodeWindowState,
} from "../session-types.js";

type AgentSource = { sessionId: string; sessionLabel?: string };

export interface BrowserTransportSocketLike {
  data?: unknown;
  send(data: string): void;
}

export interface BrowserTransportSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  browserSockets: Set<unknown>;
  messageHistory: BrowserIncomingMessage[];
  frozenCount: number;
  state: SessionState;
  nextEventSeq: number;
  lastAckSeq: number;
  pendingPermissions: Map<string, PermissionRequest>;
  pendingCodexInputs: PendingCodexInput[];
  pendingCodexTurns: CodexOutboundTurn[];
  claudeSdkAdapter?: unknown | null;
  taskHistory: SessionTaskEntry[];
  eventBuffer: BufferedBrowserEvent[];
  lastReadAt: number;
  attentionReason: "action" | "error" | "review" | null;
  generationStartedAt: number | null;
  isGenerating?: boolean;
  userMessageIdsThisTurn?: number[];
  activeTurnRoute?: ActiveTurnRoute | null;
  notifications: unknown[];
  attentionRecords: unknown[];
  notificationStatusVersion?: number;
  notificationStatusUpdatedAt?: number;
  processedClientMessageIds: string[];
  processedClientMessageIdSet: Set<string>;
}

interface CachedLeaderProjection {
  key: string;
  projection: NonNullable<Extract<BrowserIncomingMessage, { type: "leader_projection_snapshot" }>["projection"]>;
}

const leaderProjectionCache = new WeakMap<BrowserTransportSessionLike, CachedLeaderProjection>();

export interface BrowserTransportStateLike {
  vscodeSelectionState: VsCodeSelectionState | null;
  vscodeWindows: Map<string, VsCodeWindowState>;
  vscodeOpenFileQueues: Map<string, VsCodeOpenFileCommand[]>;
  pendingVsCodeOpenResults: Map<
    string,
    {
      resolve: () => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
}

export interface BrowserTransportLauncherInfo {
  isOrchestrator?: boolean;
  state?: string;
  backendType?: "claude" | "codex" | "claude-sdk";
  killedByIdleManager?: boolean;
}

export interface BrowserTransportTreeGroupState {
  groups: unknown[];
  assignments: Record<string, unknown>;
  nodeOrder: Record<string, string[]>;
}

export interface BrowserTransportDeps {
  refreshGitInfoThenRecomputeDiff: (session: BrowserTransportSessionLike, options: { notifyPoller: boolean }) => void;
  prefillSlashCommands: (session: BrowserTransportSessionLike) => void;
  getTreeGroupState: () => Promise<BrowserTransportTreeGroupState>;
  getVsCodeSelectionState: () => unknown;
  getLauncherSessionInfo: (sessionId: string) => BrowserTransportLauncherInfo | null | undefined;
  backendAttached: (session: BrowserTransportSessionLike) => boolean;
  backendConnected: (session: BrowserTransportSessionLike) => boolean;
  requestCodexAutoRecovery: (session: BrowserTransportSessionLike, reason: string) => boolean;
  requestCliRelaunch?: (sessionId: string) => void;
  getRouteChain: (sessionId: string) => Promise<void> | undefined;
  setRouteChain: (sessionId: string, task: Promise<void>) => void;
  clearRouteChain: (sessionId: string, task: Promise<void>) => void;
  routeBrowserMessage: (
    session: BrowserTransportSessionLike,
    msg: BrowserOutgoingMessage,
    ws?: BrowserTransportSocketLike,
  ) => Promise<void> | void;
  abortAutoApproval: (session: BrowserTransportSessionLike, requestId: string) => void;
  broadcastToBrowsers: (session: BrowserTransportSessionLike, msg: BrowserIncomingMessage) => void;
  setAttentionAction: (session: BrowserTransportSessionLike) => void;
  touchActivity?: (sessionId: string) => void;
  notifyImageSendFailure: (session: BrowserTransportSessionLike, err?: unknown) => void;
  broadcastError: (session: BrowserTransportSessionLike, message: string) => void;
  queueCodexPendingStartBatch: (session: BrowserTransportSessionLike, reason: string) => void;
  deriveBackendState: (session: BrowserTransportSessionLike) => NonNullable<SessionState["backend_state"]>;
  getBoard: (sessionId: string) => unknown[];
  getCompletedBoard: (sessionId: string) => unknown[];
  getBoardRowSessionStatuses: (
    sessionId: string,
    board: unknown[],
    completedBoard: unknown[],
  ) => Record<string, BoardRowSessionStatus>;
  recoverToolStartTimesFromHistory: (session: BrowserTransportSessionLike) => void;
  finalizeRecoveredDisconnectedTerminalTools: (session: BrowserTransportSessionLike, reason: string) => void;
  scheduleCodexToolResultWatchdogs: (session: BrowserTransportSessionLike, reason: string) => void;
  recomputeAndBroadcastHistoryBytes: (session: BrowserTransportSessionLike) => void;
  listTimers: (sessionId: string) => unknown[];
  persistSession: (session: BrowserTransportSessionLike) => void;
  recordIncomingRaw?: (sessionId: string, json: string, backendType: string, cwd: string) => void;
  recordOutgoingRaw: (sessionId: string, json: string, backendType: string, cwd: string) => void;
  eventBufferLimit: number;
  browserTransportState: BrowserTransportStateLike;
  idempotentMessageTypes: ReadonlySet<string>;
  processedClientMsgIdLimit: number;
  getSessions: () => Iterable<{ browserSockets: Set<unknown> }>;
  windowStaleMs: number;
  openFileTimeoutMs: number;
  lazyLoadFullHistory?: (session: BrowserTransportSessionLike) => Promise<void>;
}

const BROWSER_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "set_codex_reasoning_effort",
]);

const queuedCodexHerdRouteKeys = new WeakMap<BrowserTransportSessionLike, Set<string>>();

export function handleBrowserOpen(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  deps: BrowserTransportDeps,
): void {
  const data = (ws.data ??= {}) as {
    sessionId?: string;
    subscribed?: boolean;
    lastAckSeq?: number;
  };
  data.subscribed = false;
  data.lastAckSeq = 0;
  session.browserSockets.add(ws);
  console.log(
    `[ws-bridge] Browser connected for session ${sessionTag(session.id)} (${session.browserSockets.size} browsers)`,
  );

  deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
  deps.prefillSlashCommands(session);

  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  sendToBrowser(ws, {
    type: "session_init",
    session: {
      ...session.state,
      isOrchestrator: launcherInfo?.isOrchestrator === true,
    },
    nextEventSeq: session.nextEventSeq,
  } as BrowserIncomingMessage);
  sendToBrowser(ws, {
    type: "codex_pending_inputs",
    inputs: session.pendingCodexInputs,
  } as BrowserIncomingMessage);
  void deps
    .getTreeGroupState()
    .then((treeGroups) => {
      sendToBrowser(ws, {
        type: "tree_groups_update",
        treeGroups: treeGroups.groups,
        treeAssignments: treeGroups.assignments,
        treeNodeOrder: treeGroups.nodeOrder,
      } as BrowserIncomingMessage);
    })
    .catch((err) => {
      console.warn("[ws-bridge] failed to send tree group state on connect:", err);
    });
  sendToBrowser(ws, {
    type: "vscode_selection_state",
    state: deps.getVsCodeSelectionState(),
  } as BrowserIncomingMessage);

  const hasBackendAttached = deps.backendAttached(session);
  if (!hasBackendAttached) {
    if (launcherInfo?.state === "starting") {
      if (launcherInfo.backendType === "claude-sdk") {
        sendToBrowser(ws, { type: "backend_connected" } as BrowserIncomingMessage);
      } else {
        sendToBrowser(ws, { type: "backend_disconnected" } as BrowserIncomingMessage);
      }
      return;
    }

    const idleKilled = launcherInfo?.killedByIdleManager;
    sendToBrowser(ws, {
      type: "backend_disconnected",
      ...(idleKilled ? { reason: "idle_limit" } : {}),
    } as BrowserIncomingMessage);
    if (session.backendType === "codex") {
      console.log(
        `[ws-bridge] Browser connected but backend is dead for session ${sessionTag(session.id)}, requesting relaunch`,
      );
      deps.requestCodexAutoRecovery(session, "browser_open_dead_backend");
    } else if (deps.requestCliRelaunch) {
      console.log(
        `[ws-bridge] Browser connected but backend is dead for session ${sessionTag(session.id)}, requesting relaunch`,
      );
      deps.requestCliRelaunch(session.id);
    }
    return;
  }

  if (deps.backendConnected(session)) {
    sendToBrowser(ws, { type: "backend_connected" } as BrowserIncomingMessage);
    return;
  }

  sendToBrowser(ws, {
    type: "backend_disconnected",
    ...(session.state.backend_state === "broken" ? { reason: "broken" } : {}),
  } as BrowserIncomingMessage);
}

export function handleBrowserClose(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  deps: Pick<BrowserTransportDeps, "backendConnected">,
  code?: number,
  reason?: string,
): void {
  session.browserSockets.delete(ws);
  const hasBackend = deps.backendConnected(session);
  console.log(
    `[ws-bridge] Browser disconnected for session ${sessionTag(session.id)} (${session.browserSockets.size} remaining, backend=${hasBackend ? "alive" : "dead"}) | code=${code ?? "?"} reason=${JSON.stringify(reason || "")}`,
  );
}

export async function handleBrowserIngressMessage(
  session: BrowserTransportSessionLike,
  msg: BrowserOutgoingMessage,
  ws: BrowserTransportSocketLike | undefined,
  deps: BrowserTransportDeps,
): Promise<void> {
  const routeTask = async () => {
    const maybeProtocolHandled = handleBrowserProtocolMessage(session, msg, ws, deps);
    const protocolHandled = maybeProtocolHandled instanceof Promise ? await maybeProtocolHandled : maybeProtocolHandled;
    if (protocolHandled) return;
    return deps.routeBrowserMessage(session, msg, ws);
  };
  const routePromise =
    shouldSerializeBrowserMessage(msg) || hasSessionRouteInFlight(session.id, deps)
      ? enqueueSessionRoute(session.id, routeTask, deps)
      : Promise.resolve(routeTask());

  try {
    await routePromise;
  } catch (err) {
    if (msg.type === "user_message" && msg.imageRefs?.length) {
      deps.notifyImageSendFailure(session, err);
      return;
    }
    console.error(`[ws-bridge] Failed to route browser message for session ${sessionTag(session.id)}:`, err);
    deps.broadcastError(session, "Failed to process message. Please retry.");
  }
}

export function handleBrowserMessage(
  session: BrowserTransportSessionLike,
  data: string,
  ws: BrowserTransportSocketLike | undefined,
  deps: BrowserTransportDeps,
): { messageType: string; completion: Promise<void> | null } {
  deps.recordIncomingRaw?.(session.id, data, session.backendType, session.state.cwd);

  let msg: BrowserOutgoingMessage;
  try {
    msg = JSON.parse(data);
  } catch {
    trafficStats.record({
      sessionId: session.id,
      channel: "browser",
      direction: "in",
      messageType: "invalid_json",
      payloadBytes: Buffer.byteLength(data, "utf-8"),
    });
    console.warn(`[ws-bridge] Failed to parse browser message: ${data.substring(0, 200)}`);
    return { messageType: "invalid_json", completion: null };
  }

  trafficStats.record({
    sessionId: session.id,
    channel: "browser",
    direction: "in",
    messageType: getTrafficMessageType(msg),
    payloadBytes: Buffer.byteLength(data, "utf-8"),
  });

  return {
    messageType: msg.type,
    completion: handleBrowserIngressMessage(session, msg, ws, deps),
  };
}

export function handleBrowserProtocolMessage(
  session: BrowserTransportSessionLike,
  msg: BrowserOutgoingMessage,
  ws: BrowserTransportSocketLike | undefined,
  deps: BrowserTransportDeps,
): boolean | Promise<boolean> {
  if (msg.type === "session_subscribe") {
    return handleSessionSubscribe(
      session,
      ws,
      msg.last_seq,
      msg.known_frozen_count ?? 0,
      msg.known_frozen_hash,
      msg.history_window_section_turn_count,
      msg.history_window_visible_section_count,
      deps,
    ).then(() => true);
  }

  if (msg.type === "history_window_request") {
    if (!ws) return true;
    sendHistoryWindowSync(session, ws, {
      fromTurn: msg.from_turn,
      turnCount: msg.turn_count,
      sectionTurnCount: msg.section_turn_count,
      visibleSectionCount: msg.visible_section_count,
    });
    return true;
  }

  if (msg.type === "session_ack") {
    handleSessionAck(session, ws, msg.last_seq, deps);
    return true;
  }

  if (msg.type === "history_sync_mismatch") {
    console.warn(
      `[history-sync] Browser reported hash mismatch for session ${sessionTag(session.id)} ` +
        `(frozenCount=${msg.frozen_count}) ` +
        `frozen expected=${msg.expected_frozen_hash} actual=${msg.actual_frozen_hash}; ` +
        `full expected=${msg.expected_full_hash} actual=${msg.actual_full_hash}`,
    );
    return true;
  }

  if (msg.type === "permission_user_viewing") {
    const requestId = msg.request_id;
    const perm = session.pendingPermissions.get(requestId);
    if (perm?.evaluating) {
      deps.abortAutoApproval(session, requestId);
      perm.evaluating = undefined;
      deps.broadcastToBrowsers(session, {
        type: "permission_needs_attention",
        request_id: requestId,
        timestamp: Date.now(),
      });
      deps.setAttentionAction(session);
      console.log(
        `[ws-bridge] Auto-approval cancelled for ${perm.tool_name} in session ${sessionTag(session.id)} — user opened dialog`,
      );
      deps.persistSession(session);
    }
    return true;
  }

  if (deps.idempotentMessageTypes.has(msg.type) && "client_msg_id" in msg && msg.client_msg_id) {
    if (session.processedClientMessageIdSet.has(msg.client_msg_id)) return true;
    session.processedClientMessageIds.push(msg.client_msg_id);
    session.processedClientMessageIdSet.add(msg.client_msg_id);
    if (session.processedClientMessageIds.length > deps.processedClientMsgIdLimit) {
      const overflow = session.processedClientMessageIds.length - deps.processedClientMsgIdLimit;
      const removed = session.processedClientMessageIds.splice(0, overflow);
      for (const id of removed) {
        session.processedClientMessageIdSet.delete(id);
      }
    }
    deps.persistSession(session);
  }

  if (BROWSER_ACTIVITY_TYPES.has(msg.type)) {
    deps.touchActivity?.(session.id);
  }

  if (msg.type === "vscode_selection_update") {
    handleVsCodeSelectionUpdate(deps.browserTransportState, msg, deps);
    return true;
  }

  if ((msg as { type: string }).type === "ping") return true;
  return false;
}

export function injectUserMessage(
  session: BrowserTransportSessionLike,
  content: string,
  agentSource: AgentSource | undefined,
  takodeHerdBatch: TakodeHerdBatchSnapshot | undefined,
  deps: BrowserTransportDeps,
  threadRoute?: ThreadRouteMetadata,
): "sent" | "queued" {
  const backendLive = deps.backendConnected(session);
  if (isHerdEventSource(agentSource) && session.backendType === "codex") {
    const existing = findMatchingPendingCodexInput(session, content, agentSource, threadRoute);
    if (existing) {
      if (existing.cancelable) {
        deps.queueCodexPendingStartBatch(session, "inject_herd_event_retry");
      }
      return getPendingCodexInputDeliveryState(session, existing.id);
    }
  }

  const sdkAdapterMissingBeforeRoute = session.backendType === "claude-sdk" && !session.claudeSdkAdapter;
  const pendingCodexCountBefore = session.pendingCodexInputs.length;
  const hadRouteInFlight = hasSessionRouteInFlight(session.id, deps);
  const browserMessage: BrowserOutgoingMessage = {
    type: "user_message",
    content,
    ...(agentSource ? { agentSource } : {}),
    ...(takodeHerdBatch ? { takodeHerdBatch } : {}),
    ...(threadRoute ? { threadKey: threadRoute.threadKey } : {}),
    ...(threadRoute?.questId ? { questId: threadRoute.questId } : {}),
    ...(threadRoute?.threadRefs?.length ? { threadRefs: threadRoute.threadRefs } : {}),
  };

  if (hadRouteInFlight) {
    if (isHerdEventSource(agentSource) && session.backendType === "codex") {
      const queuedKey = getCodexHerdRouteQueueKey(content, agentSource, threadRoute);
      const queuedKeys = getQueuedCodexHerdRouteKeys(session);
      if (queuedKeys.has(queuedKey)) {
        return "queued";
      }
      queuedKeys.add(queuedKey);
      void enqueueSessionRoute(session.id, () => deps.routeBrowserMessage(session, browserMessage), deps)
        .finally(() => {
          queuedKeys.delete(queuedKey);
          if (queuedKeys.size === 0) {
            queuedCodexHerdRouteKeys.delete(session);
          }
        })
        .catch(() => {});
      return "queued";
    }
    void enqueueSessionRoute(session.id, () => deps.routeBrowserMessage(session, browserMessage), deps);
  } else {
    void deps.routeBrowserMessage(session, browserMessage);
    if (isHerdEventSource(agentSource) && session.backendType === "codex") {
      const pending = session.pendingCodexInputs
        .slice(pendingCodexCountBefore)
        .find(
          (input) =>
            input.content === content &&
            sameAgentSource(input.agentSource, agentSource) &&
            samePendingThreadRoute(input, threadRoute),
        );
      if (pending) {
        return getPendingCodexInputDeliveryState(session, pending.id);
      }
    }
  }

  if (!backendLive && deps.requestCliRelaunch) {
    const launcherInfo = deps.getLauncherSessionInfo(session.id);
    if (
      session.backendType !== "codex" &&
      launcherInfo &&
      launcherInfo.state === "exited" &&
      session.state.backend_state !== "broken"
    ) {
      // Claude SDK's missing-adapter route already queues the message and
      // requests relaunch. The post-route fallback remains needed when an SDK
      // adapter object exists but is disconnected and queues internally.
      if (sdkAdapterMissingBeforeRoute) {
        return "queued";
      }
      if (launcherInfo.killedByIdleManager) {
        launcherInfo.killedByIdleManager = false;
        console.log(`[ws-bridge] Clearing idle-killed flag for session ${sessionTag(session.id)} (message inject)`);
      }
      console.log(
        `[ws-bridge] Injected message queued for exited session ${sessionTag(session.id)}, requesting relaunch`,
      );
      deps.requestCliRelaunch(session.id);
    }
  }

  return backendLive ? "sent" : "queued";
}

export function isHerdEventSource(agentSource: AgentSource | undefined): boolean {
  return agentSource?.sessionId === "herd-events";
}

export function sameAgentSource(left: AgentSource | undefined, right: AgentSource | undefined): boolean {
  return (
    (left?.sessionId ?? "") === (right?.sessionId ?? "") && (left?.sessionLabel ?? "") === (right?.sessionLabel ?? "")
  );
}

export function normalizePendingCodexDedupContent(content: string, agentSource?: AgentSource): string {
  if (!isHerdEventSource(agentSource)) return content;
  return content.replace(/ \| \d+[smhd] ago(?=$|\n)/g, "");
}

export function findMatchingPendingCodexInput(
  session: BrowserTransportSessionLike,
  content: string,
  agentSource?: AgentSource,
  threadRoute?: ThreadRouteMetadata,
): PendingCodexInput | null {
  const normalizedContent = normalizePendingCodexDedupContent(content, agentSource);
  for (let i = session.pendingCodexInputs.length - 1; i >= 0; i--) {
    const pending = session.pendingCodexInputs[i];
    if (normalizePendingCodexDedupContent(pending.content, pending.agentSource) !== normalizedContent) continue;
    if (!sameAgentSource(pending.agentSource, agentSource)) continue;
    if (!samePendingThreadRoute(pending, threadRoute)) continue;
    return pending;
  }
  return null;
}

function samePendingThreadRoute(pending: PendingCodexInput, threadRoute?: ThreadRouteMetadata): boolean {
  return (pending.threadKey ?? "main").toLowerCase() === (threadRoute?.threadKey ?? "main").toLowerCase();
}

export function getPendingCodexInputDeliveryState(
  session: BrowserTransportSessionLike,
  inputId: string,
): "sent" | "queued" {
  const pending = session.pendingCodexInputs.find((input) => input.id === inputId);
  if (!pending) return "sent";
  const turn = session.pendingCodexTurns.find((candidate) =>
    (candidate.pendingInputIds ?? [candidate.userMessageId]).includes(inputId),
  );
  if (!turn) return pending.cancelable ? "queued" : "sent";
  if (turn.status === "dispatched" || turn.status === "backend_acknowledged") return "sent";
  return "queued";
}

function getQueuedCodexHerdRouteKeys(session: BrowserTransportSessionLike): Set<string> {
  let keys = queuedCodexHerdRouteKeys.get(session);
  if (!keys) {
    keys = new Set<string>();
    queuedCodexHerdRouteKeys.set(session, keys);
  }
  return keys;
}

function getCodexHerdRouteQueueKey(
  content: string,
  agentSource: AgentSource | undefined,
  threadRoute?: ThreadRouteMetadata,
): string {
  return JSON.stringify({
    content: normalizePendingCodexDedupContent(content, agentSource),
    sessionId: agentSource?.sessionId ?? "",
    sessionLabel: agentSource?.sessionLabel ?? "",
    threadKey: (threadRoute?.threadKey ?? "main").toLowerCase(),
  });
}

export function deriveSessionStatus(
  session: BrowserTransportSessionLike,
  deps: Pick<BrowserTransportDeps, "backendConnected">,
): string | null {
  if (session.state.is_compacting) return "compacting";
  if (!deps.backendConnected(session)) return null;
  if ((session as any).isGenerating) return "running";
  return "idle";
}

export function deriveActiveTurnRoute(session: BrowserTransportSessionLike): ActiveTurnRoute | null {
  if (!session.isGenerating) return null;
  const userMessageIdsThisTurn = session.userMessageIdsThisTurn ?? [];
  for (let i = userMessageIdsThisTurn.length - 1; i >= 0; i--) {
    const historyIndex = userMessageIdsThisTurn[i];
    const route = routeFromHistoryEntry(session.messageHistory[historyIndex]);
    if (!route || route.threadKey === "main") return { threadKey: "main" };
    return {
      threadKey: route.threadKey,
      ...(route.questId ? { questId: route.questId } : {}),
    };
  }
  if (session.activeTurnRoute) {
    return session.activeTurnRoute;
  }
  return { threadKey: "main" };
}

export function isLeaderSession(
  session: BrowserTransportSessionLike,
  deps: Pick<BrowserTransportDeps, "getLauncherSessionInfo">,
): boolean {
  if ((session.state as { isOrchestrator?: boolean }).isOrchestrator === true) return true;
  return deps.getLauncherSessionInfo(session.id)?.isOrchestrator === true;
}

export function buildLeaderProjectionSnapshotForSession(
  session: BrowserTransportSessionLike,
  deps: Pick<BrowserTransportDeps, "getBoard" | "getCompletedBoard" | "getBoardRowSessionStatuses">,
): CachedLeaderProjection["projection"] {
  const board = deps.getBoard(session.id) as BoardRow[];
  const completedBoard = deps.getCompletedBoard(session.id) as BoardRow[];
  const rowSessionStatuses = deps.getBoardRowSessionStatuses(session.id, board, completedBoard);
  const key = leaderProjectionCacheKey(session, board, completedBoard, rowSessionStatuses);
  const cached = leaderProjectionCache.get(session);
  if (cached?.key === key) return cached.projection;

  const projection = buildLeaderProjectionSnapshot({
    leaderSessionId: session.id,
    messageHistory: session.messageHistory,
    activeBoard: board,
    completedBoard,
    rowSessionStatuses,
    notifications: session.notifications as SessionNotification[],
    attentionRecords: session.attentionRecords as SessionAttentionRecord[],
  });
  leaderProjectionCache.set(session, { key, projection });
  return projection;
}

export function sendLeaderProjectionSnapshot(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  deps: Pick<
    BrowserTransportDeps,
    "getLauncherSessionInfo" | "getBoard" | "getCompletedBoard" | "getBoardRowSessionStatuses"
  >,
): void {
  if (!isLeaderSession(session, deps)) return;
  sendToBrowser(ws, {
    type: "leader_projection_snapshot",
    projection: buildLeaderProjectionSnapshotForSession(session, deps),
  } as BrowserIncomingMessage);
}

function leaderProjectionCacheKey(
  session: BrowserTransportSessionLike,
  board: BoardRow[],
  completedBoard: BoardRow[],
  rowSessionStatuses: Record<string, BoardRowSessionStatus>,
): string {
  const lastHistoryEntry = session.messageHistory[session.messageHistory.length - 1] as
    | (BrowserIncomingMessage & { id?: string; message?: { id?: string } })
    | undefined;
  return JSON.stringify({
    historyLength: session.messageHistory.length,
    lastHistoryId: lastHistoryEntry?.id ?? lastHistoryEntry?.message?.id ?? null,
    board: board.map(boardRowProjectionKey),
    completedBoard: completedBoard.map(boardRowProjectionKey),
    rowSessionStatuses,
    notificationStatusVersion: session.notificationStatusVersion ?? 0,
    notifications: (session.notifications as SessionNotification[]).map((notification) => [
      notification.id,
      notification.done,
      notification.timestamp,
      notification.threadKey,
      notification.questId,
      notification.summary,
    ]),
    attentionRecords: (session.attentionRecords as SessionAttentionRecord[]).map((record) => [
      record.id,
      record.updatedAt,
      record.state,
      record.threadKey,
      record.questId,
    ]),
  });
}

function boardRowProjectionKey(row: BoardRow): unknown[] {
  return [
    row.questId,
    row.title,
    row.status,
    row.createdAt,
    row.updatedAt,
    row.completedAt,
    row.waitForInput?.join(",") ?? "",
    row.worker,
    row.workerNum,
  ];
}

export function sendStateSnapshot(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  deps: BrowserTransportDeps,
): void {
  const board = deps.getBoard(session.id);
  const completedBoard = deps.getCompletedBoard(session.id);
  sendToBrowser(ws, {
    type: "state_snapshot",
    sessionStatus: deriveSessionStatus(session, deps),
    permissionMode: session.state.permissionMode,
    backendConnected: deps.backendConnected(session),
    backendState: deps.deriveBackendState(session),
    backendError: session.state.backend_error ?? null,
    uiMode: session.state.uiMode ?? null,
    askPermission: session.state.askPermission ?? true,
    lastReadAt: session.lastReadAt,
    attentionReason: session.attentionReason,
    generationStartedAt: session.generationStartedAt ?? null,
    activeTurnRoute: deriveActiveTurnRoute(session),
    board,
    completedBoard,
    rowSessionStatuses: deps.getBoardRowSessionStatuses(session.id, board, completedBoard),
    notifications: session.notifications,
    attentionRecords: session.attentionRecords,
    notificationStatusVersion: session.notificationStatusVersion,
    notificationStatusUpdatedAt: session.notificationStatusUpdatedAt,
  } as BrowserIncomingMessage);
}

/** Yield so large history hashing does not monopolize the event loop. */
async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

export function normalizeKnownFrozenCount(knownFrozenCount: number | undefined): number {
  if (!Number.isFinite(knownFrozenCount)) return 0;
  return Math.max(0, Math.floor(knownFrozenCount ?? 0));
}

export function clampFrozenCount(session: BrowserTransportSessionLike): void {
  session.frozenCount = Math.max(0, Math.min(session.frozenCount, session.messageHistory.length));
}

export function freezeHistoryThroughCurrentTail(session: BrowserTransportSessionLike): void {
  session.frozenCount = session.messageHistory.length;
}

export async function sendHistorySync(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  knownFrozenCount: number,
  knownFrozenHash: string | undefined,
): Promise<void> {
  const synced = await sendHistorySyncAttempt(session, ws, knownFrozenCount, knownFrozenHash);
  if (!synced && knownFrozenCount > 0) {
    console.warn(
      `[history-sync] Falling back to full history sync for session ${sessionTag(session.id)} ` +
        `(knownFrozenCount=${normalizeKnownFrozenCount(knownFrozenCount)}, ` +
        `serverHistoryLength=${session.messageHistory.length}, frozenCount=${session.frozenCount})`,
    );
    await sendHistorySyncAttempt(session, ws, 0, undefined);
  }
}

async function sendHistorySyncAttempt(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  knownFrozenCount: number,
  knownFrozenHash: string | undefined,
): Promise<boolean> {
  const normalizedKnownFrozenCount = normalizeKnownFrozenCount(knownFrozenCount);
  clampFrozenCount(session);
  const frozenCount = session.frozenCount;
  const frozenHistory = session.messageHistory.slice(0, frozenCount);
  const frozenPrefix = computeHistoryMessagesSyncHash(frozenHistory);
  if (normalizedKnownFrozenCount > frozenPrefix.renderedCount) {
    console.warn(
      `[history-sync] Invalid known_frozen_count=${normalizedKnownFrozenCount} ` +
        `for session ${sessionTag(session.id)} authoritativeFrozen=${frozenPrefix.renderedCount} ` +
        `serverHistoryLength=${session.messageHistory.length} frozenCount=${frozenCount}; refusing incremental sync`,
    );
    return false;
  }
  if (session.messageHistory.length === 0) return true;
  if (normalizedKnownFrozenCount > 0 && typeof knownFrozenHash === "string") {
    const expectedPrefix = computeHistoryPrefixSyncHash(frozenHistory, normalizedKnownFrozenCount);
    if (expectedPrefix.hash !== knownFrozenHash) {
      console.warn(
        `[history-sync] Frozen prefix hash mismatch for session ${sessionTag(session.id)} ` +
          `(count=${normalizedKnownFrozenCount}, authoritativeFrozen=${frozenPrefix.renderedCount}, ` +
          `serverHistoryLength=${session.messageHistory.length}, frozenCount=${frozenCount}) ` +
          `expected=${expectedPrefix.hash} actual=${knownFrozenHash}; refusing incremental sync`,
      );
      return false;
    }
  }

  const historySnapshot = session.messageHistory.slice();
  const isLargeHistory = historySnapshot.length > 500;
  if (isLargeHistory) await yieldToEventLoop();
  const fullHistory = computeHistoryMessagesSyncHash(historySnapshot);
  const frozenDelta = historySnapshot.slice(normalizedKnownFrozenCount, frozenCount);
  const hotMessages = historySnapshot.slice(frozenCount);
  if (isLargeHistory) await yieldToEventLoop();

  const frozenDeltaJson = JSON.stringify(frozenDelta);
  const hotMessagesJson = JSON.stringify(hotMessages);
  trafficStats.recordHistorySyncBreakdown({
    sessionId: session.id,
    frozenDeltaBytes: Buffer.byteLength(frozenDeltaJson, "utf-8"),
    hotMessagesBytes: Buffer.byteLength(hotMessagesJson, "utf-8"),
    frozenDeltaMessages: frozenDelta.length,
    hotMessagesCount: hotMessages.length,
  });

  const payloadJson =
    `{"type":"history_sync"` +
    `,"frozen_base_count":${normalizedKnownFrozenCount}` +
    `,"frozen_delta":${frozenDeltaJson}` +
    `,"hot_messages":${hotMessagesJson}` +
    `,"frozen_count":${frozenCount}` +
    `,"expected_frozen_hash":${JSON.stringify(frozenPrefix.hash)}` +
    `,"expected_full_hash":${JSON.stringify(fullHistory.hash)}}`;
  sendToBrowserRaw(ws, payloadJson, "history_sync");
  return true;
}

export function sendHistoryWindowSync(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  options: {
    fromTurn: number;
    turnCount: number;
    sectionTurnCount: number;
    visibleSectionCount: number;
  },
): void {
  const normalizedSectionTurnCount = Math.max(1, Math.floor(options.sectionTurnCount));
  const normalizedVisibleSectionCount = Math.max(1, Math.floor(options.visibleSectionCount));
  const normalizedTurnCount = Math.max(
    1,
    Math.floor(
      options.turnCount || getHistoryWindowTurnCount(normalizedVisibleSectionCount, normalizedSectionTurnCount),
    ),
  );
  const turns = findTurnBoundaries(session.messageHistory);
  const totalTurns = turns.length;
  let fromTurn = 0;
  let turnCount = 0;
  let startIdx = 0;
  let messages: BrowserIncomingMessage[] = session.messageHistory.slice();

  if (totalTurns > 0) {
    fromTurn = Math.max(0, Math.min(Math.floor(options.fromTurn), totalTurns - 1));
    const endTurnExclusive = Math.min(totalTurns, fromTurn + normalizedTurnCount);
    turnCount = Math.max(0, endTurnExclusive - fromTurn);
    startIdx = turns[fromTurn]?.startIdx ?? 0;
    const lastTurn = turns[endTurnExclusive - 1];
    const endIdx = lastTurn && lastTurn.endIdx >= 0 ? lastTurn.endIdx : Math.max(0, session.messageHistory.length - 1);
    messages = session.messageHistory.slice(startIdx, endIdx + 1);
  }

  sendToBrowser(ws, {
    type: "history_window_sync",
    messages,
    window: {
      from_turn: fromTurn,
      turn_count: totalTurns === 0 ? 0 : turnCount,
      total_turns: totalTurns,
      start_index: startIdx,
      section_turn_count: normalizedSectionTurnCount,
      visible_section_count: normalizedVisibleSectionCount,
    },
  } as BrowserIncomingMessage);
}

export async function handleSessionSubscribe(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike | undefined,
  lastSeq: number,
  knownFrozenCount: number | undefined,
  knownFrozenHash: string | undefined,
  historyWindowSectionTurnCount: number | undefined,
  historyWindowVisibleSectionCount: number | undefined,
  deps: BrowserTransportDeps,
): Promise<void> {
  if (!ws) return;
  const data = (ws.data ??= {}) as { subscribed?: boolean; lastAckSeq?: number };
  data.subscribed = true;
  const lastAckSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  data.lastAckSeq = lastAckSeq;

  // Lazy-load full history for search-data-only archived sessions
  if ((session as unknown as Record<string, unknown>).searchDataOnly && deps.lazyLoadFullHistory) {
    await deps.lazyLoadFullHistory(session);
  }

  deps.recoverToolStartTimesFromHistory(session);
  deps.finalizeRecoveredDisconnectedTerminalTools(session, "session_subscribe");
  deps.scheduleCodexToolResultWatchdogs(session, "session_subscribe");

  const resolvedIds = new Set<string>();
  for (const msg of session.messageHistory) {
    if (msg.type !== "permission_approved" && msg.type !== "permission_denied") continue;
    const record = msg as Record<string, unknown>;
    const requestId = record.request_id as string | undefined;
    if (requestId) {
      resolvedIds.add(requestId);
      continue;
    }
    if (typeof record.id === "string") {
      const match = record.id.match(/^(?:approval|denial)-(.+)$/);
      if (match) resolvedIds.add(match[1]);
    }
  }

  let cleanedStale = false;
  for (const requestId of session.pendingPermissions.keys()) {
    if (!resolvedIds.has(requestId)) continue;
    session.pendingPermissions.delete(requestId);
    cleanedStale = true;
  }
  if (cleanedStale) deps.persistSession(session);

  if (lastAckSeq === 0) {
    sendLeaderProjectionSnapshot(session, ws, deps);
    if (session.messageHistory.length > 0) {
      if (
        typeof historyWindowSectionTurnCount === "number" &&
        historyWindowSectionTurnCount > 0 &&
        typeof historyWindowVisibleSectionCount === "number" &&
        historyWindowVisibleSectionCount > 0
      ) {
        sendHistoryWindowSync(session, ws, {
          fromTurn: Math.max(
            0,
            findTurnBoundaries(session.messageHistory).length -
              getHistoryWindowTurnCount(historyWindowVisibleSectionCount, historyWindowSectionTurnCount),
          ),
          turnCount: getHistoryWindowTurnCount(historyWindowVisibleSectionCount, historyWindowSectionTurnCount),
          sectionTurnCount: historyWindowSectionTurnCount,
          visibleSectionCount: historyWindowVisibleSectionCount,
        });
      } else {
        await sendHistorySync(session, ws, knownFrozenCount ?? 0, knownFrozenHash);
      }
    }
    if (deriveSessionStatus(session, deps) === "running" && session.eventBuffer.length > 0) {
      const transient = session.eventBuffer.filter(
        (evt) => !isHistoryBackedEvent(evt.message as ReplayableBrowserIncomingMessage),
      );
      if (transient.length > 0) {
        sendToBrowser(ws, { type: "event_replay", events: transient } as BrowserIncomingMessage);
      }
    }
  } else if (lastAckSeq < session.nextEventSeq - 1) {
    const earliest = session.eventBuffer[0]?.seq ?? session.nextEventSeq;
    const hasGap = session.eventBuffer.length === 0 || lastAckSeq < earliest - 1;
    const missedEvents = session.eventBuffer.filter((evt) => evt.seq > lastAckSeq);
    const hasMissedHistoryBacked = missedEvents.some((evt) =>
      isHistoryBackedEvent(evt.message as ReplayableBrowserIncomingMessage),
    );
    if (hasGap || hasMissedHistoryBacked) {
      if (session.messageHistory.length > 0) {
        await sendHistorySync(session, ws, knownFrozenCount ?? 0, knownFrozenHash);
      }
      const transientMissed = missedEvents.filter(
        (evt) => !isHistoryBackedEvent(evt.message as ReplayableBrowserIncomingMessage),
      );
      if (transientMissed.length > 0) {
        sendToBrowser(ws, { type: "event_replay", events: transientMissed } as BrowserIncomingMessage);
      }
    } else if (missedEvents.length > 0) {
      sendToBrowser(ws, { type: "event_replay", events: missedEvents } as BrowserIncomingMessage);
    }
  }

  if (session.pendingPermissions.size > 0) {
    for (const perm of session.pendingPermissions.values()) {
      sendToBrowser(ws, { type: "permission_request", request: perm } as BrowserIncomingMessage);
    }
  }
  if (session.taskHistory.length > 0) {
    sendToBrowser(ws, { type: "session_task_history", tasks: session.taskHistory } as BrowserIncomingMessage);
  }

  const timers = deps.listTimers(session.id);
  if (timers.length > 0) {
    sendToBrowser(ws, { type: "timer_update", timers } as BrowserIncomingMessage);
  }

  deps.recomputeAndBroadcastHistoryBytes(session);
  sendStateSnapshot(session, ws, deps);
}

export function handleSessionAck(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike | undefined,
  lastSeq: number,
  deps: Pick<BrowserTransportDeps, "persistSession">,
): void {
  const normalized = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  if (ws) {
    const data = (ws.data ??= {}) as { subscribed?: boolean; lastAckSeq?: number };
    const prior = typeof data.lastAckSeq === "number" ? data.lastAckSeq : 0;
    data.lastAckSeq = Math.max(prior, normalized);
  }
  if (normalized > session.lastAckSeq) {
    session.lastAckSeq = normalized;
    deps.persistSession(session);
  }
}

export function isHistoryBackedEvent(msg: ReplayableBrowserIncomingMessage): boolean {
  return (
    msg.type === "assistant" ||
    msg.type === "result" ||
    msg.type === "user_message" ||
    msg.type === "error" ||
    msg.type === "tool_result_preview" ||
    msg.type === "permission_request" ||
    msg.type === "permission_denied" ||
    msg.type === "permission_approved" ||
    msg.type === "compact_boundary" ||
    msg.type === "compact_summary" ||
    msg.type === "compact_marker"
  );
}

export function broadcastToBrowsers(
  session: BrowserTransportSessionLike,
  msg: BrowserIncomingMessage,
  deps: Pick<BrowserTransportDeps, "eventBufferLimit" | "persistSession" | "recordOutgoingRaw">,
  options?: { skipBuffer?: boolean },
): void {
  if (session.browserSockets.size === 0 && msg.type === "result") {
    console.log(
      `[ws-bridge] ⚠ Broadcasting result to 0 browsers for session ${sessionTag(session.id)} (stored in history: true)`,
    );
  }
  const serStart = performance.now();
  const json = JSON.stringify(sequenceEvent(session, msg, deps, options));
  const serMs = performance.now() - serStart;
  if (serMs > 50) {
    console.warn(
      `[ws-bridge] Slow JSON.stringify in broadcastToBrowsers: ${serMs.toFixed(1)}ms, type=${msg.type}, len=${json.length}, session=${sessionTag(session.id)}`,
    );
  }

  deps.recordOutgoingRaw(session.id, json, session.backendType, session.state.cwd);

  let successfulFanout = 0;
  for (const ws of session.browserSockets) {
    const socket = ws as BrowserTransportSocketLike;
    try {
      socket.send(json);
      successfulFanout++;
    } catch {
      session.browserSockets.delete(ws);
    }
  }
  deferBrowserTrafficStats(json, session.id, msg.type, successfulFanout);
}

export function sendToBrowser(ws: BrowserTransportSocketLike, msg: BrowserIncomingMessage): void {
  try {
    const json = JSON.stringify(msg);
    ws.send(json);
    deferBrowserTrafficStats(
      json,
      (ws.data as { sessionId?: string } | undefined)?.sessionId ?? "unknown",
      msg.type,
      1,
    );
  } catch {
    // socket cleanup handled elsewhere
  }
}

export function sendToBrowserRaw(ws: BrowserTransportSocketLike, json: string, messageType: string): void {
  try {
    ws.send(json);
    deferBrowserTrafficStats(
      json,
      (ws.data as { sessionId?: string } | undefined)?.sessionId ?? "unknown",
      messageType,
      1,
    );
  } catch {
    // socket cleanup handled elsewhere
  }
}

function shouldSerializeBrowserMessage(msg: BrowserOutgoingMessage): boolean {
  return msg.type === "user_message" && !!msg.imageRefs?.length;
}

function hasSessionRouteInFlight(sessionId: string, deps: BrowserTransportDeps): boolean {
  return deps.getRouteChain(sessionId) !== undefined;
}

function enqueueSessionRoute(
  sessionId: string,
  task: () => Promise<void> | void,
  deps: BrowserTransportDeps,
): Promise<void> {
  const prior = deps.getRouteChain(sessionId);
  let next: Promise<void>;
  if (prior) {
    next = prior.catch(() => {}).then(() => task());
  } else {
    try {
      next = Promise.resolve(task());
    } catch (err) {
      next = Promise.reject(err);
    }
  }
  const tracked = next.finally(() => {
    deps.clearRouteChain(sessionId, tracked);
  });
  deps.setRouteChain(sessionId, tracked);
  return tracked;
}

function sequenceEvent(
  session: BrowserTransportSessionLike,
  msg: BrowserIncomingMessage,
  deps: Pick<BrowserTransportDeps, "eventBufferLimit" | "persistSession">,
  options?: { skipBuffer?: boolean },
): BrowserIncomingMessage {
  const seq = session.nextEventSeq++;
  const sequenced = { ...msg, seq };
  if (!options?.skipBuffer && shouldBufferForReplay(msg)) {
    session.eventBuffer.push({ seq, message: msg });
    if (session.eventBuffer.length > deps.eventBufferLimit) {
      session.eventBuffer.splice(0, session.eventBuffer.length - deps.eventBufferLimit);
    }
    deps.persistSession(session);
  }
  return sequenced;
}

function deferBrowserTrafficStats(json: string, sessionId: string, messageType: string, fanout: number): void {
  queueMicrotask(() => {
    trafficStats.record({
      sessionId,
      channel: "browser",
      direction: "out",
      messageType,
      payloadBytes: Buffer.byteLength(json, "utf-8"),
      fanout,
    });
  });
}

export function handleVsCodeSelectionUpdate(
  state: BrowserTransportStateLike,
  msg: Extract<BrowserOutgoingMessage, { type: "vscode_selection_update" }>,
  deps: BrowserTransportDeps,
): boolean {
  const nextState: VsCodeSelectionState = {
    selection: msg.selection
      ? {
          absolutePath: msg.selection.absolutePath,
          startLine: msg.selection.startLine,
          endLine: msg.selection.endLine,
          lineCount: msg.selection.lineCount,
        }
      : null,
    updatedAt: msg.updatedAt,
    sourceId: msg.sourceId,
    sourceType: msg.sourceType,
    ...(msg.sourceLabel ? { sourceLabel: msg.sourceLabel } : {}),
  };

  return updateVsCodeSelectionState(state, nextState, deps);
}

export function getVsCodeSelectionState(state: BrowserTransportStateLike): VsCodeSelectionState | null {
  return state.vscodeSelectionState
    ? {
        ...state.vscodeSelectionState,
        selection: state.vscodeSelectionState.selection ? { ...state.vscodeSelectionState.selection } : null,
      }
    : null;
}

export function updateVsCodeSelectionState(
  state: BrowserTransportStateLike,
  nextState: VsCodeSelectionState,
  deps: BrowserTransportDeps,
): boolean {
  if (!shouldAcceptVsCodeSelectionUpdate(state.vscodeSelectionState, nextState)) {
    return false;
  }

  state.vscodeSelectionState = {
    ...nextState,
    selection: nextState.selection ? { ...nextState.selection } : null,
  };
  if (nextState.sourceType === "vscode-window") {
    const currentWindow = state.vscodeWindows.get(nextState.sourceId);
    if (currentWindow) {
      currentWindow.lastSeenAt = Date.now();
      currentWindow.lastActivityAt = Math.max(currentWindow.lastActivityAt, nextState.updatedAt);
      currentWindow.updatedAt = Math.max(currentWindow.updatedAt, nextState.updatedAt);
    }
  }
  broadcastVsCodeSelectionState(state, deps);
  return true;
}

export function getVsCodeWindowStates(
  state: BrowserTransportStateLike,
  deps: BrowserTransportDeps,
): VsCodeWindowState[] {
  return getActiveVsCodeWindows(state, deps.windowStaleMs)
    .map((window) => cloneVsCodeWindowState(window))
    .sort((a, b) => {
      if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.sourceId.localeCompare(b.sourceId);
    });
}

export function upsertVsCodeWindowState(
  state: BrowserTransportStateLike,
  nextState: Omit<VsCodeWindowState, "lastSeenAt">,
): VsCodeWindowState {
  const current = state.vscodeWindows.get(nextState.sourceId);
  if (current && nextState.updatedAt < current.updatedAt) {
    return cloneVsCodeWindowState(current);
  }

  const now = Date.now();
  const normalized: VsCodeWindowState = {
    sourceId: nextState.sourceId,
    sourceType: "vscode-window",
    workspaceRoots: [
      ...new Set(
        nextState.workspaceRoots
          .filter((root) => typeof root === "string" && root.trim().length > 0)
          .map((root) => {
            const normalizedRoot = resolve(root).replace(/\\/g, "/");
            return normalizedRoot === "/" ? normalizedRoot : normalizedRoot.replace(/\/+$/, "");
          }),
      ),
    ],
    updatedAt: nextState.updatedAt,
    lastActivityAt: nextState.lastActivityAt,
    lastSeenAt: now,
    ...(nextState.sourceLabel ? { sourceLabel: nextState.sourceLabel } : {}),
  };
  state.vscodeWindows.set(normalized.sourceId, normalized);
  return cloneVsCodeWindowState(normalized);
}

export function touchVsCodeWindow(state: BrowserTransportStateLike, sourceId: string): VsCodeWindowState | null {
  const current = state.vscodeWindows.get(sourceId);
  if (!current) return null;
  current.lastSeenAt = Date.now();
  return cloneVsCodeWindowState(current);
}

export function pollVsCodeOpenFileCommands(
  state: BrowserTransportStateLike,
  sourceId: string,
  limit = 1,
): VsCodeOpenFileCommand[] {
  touchVsCodeWindow(state, sourceId);
  const queue = state.vscodeOpenFileQueues.get(sourceId);
  if (!queue || queue.length === 0) return [];
  return queue.splice(0, Math.max(1, limit)).map((command) => ({
    ...command,
    target: { ...command.target },
  }));
}

export function resolveVsCodeOpenFileResult(
  state: BrowserTransportStateLike,
  sourceId: string,
  commandId: string,
  result: { ok: boolean; error?: string },
): boolean {
  const pending = state.pendingVsCodeOpenResults.get(commandId);
  if (!pending) return false;
  state.pendingVsCodeOpenResults.delete(commandId);
  clearTimeout(pending.timeout);
  touchVsCodeWindow(state, sourceId);
  if (result.ok) {
    pending.resolve();
  } else {
    pending.reject(new Error(result.error?.trim() || "VS Code failed to open the requested file."));
  }
  return true;
}

export async function requestVsCodeOpenFile(
  state: BrowserTransportStateLike,
  target: {
    absolutePath: string;
    line?: number;
    column?: number;
    endLine?: number;
    targetKind?: "file" | "directory";
  },
  deps: BrowserTransportDeps,
  options?: { timeoutMs?: number },
): Promise<{ sourceId: string; commandId: string }> {
  const sourceWindow = selectVsCodeWindowForFile(state, target.absolutePath, deps.windowStaleMs);
  if (!sourceWindow) {
    throw new Error("No running VS Code was detected on this machine.");
  }

  const command: VsCodeOpenFileCommand = {
    commandId: randomUUID(),
    sourceId: sourceWindow.sourceId,
    target: {
      absolutePath: target.absolutePath,
      ...(target.targetKind === "directory"
        ? { targetKind: "directory" as const }
        : {
            line: Math.max(1, target.line ?? 1),
            column: Math.max(1, target.column ?? 1),
            ...(Number.isFinite(target.endLine)
              ? { endLine: Math.max(Math.max(1, target.line ?? 1), Number(target.endLine)) }
              : {}),
          }),
    },
    createdAt: Date.now(),
  };
  let queue = state.vscodeOpenFileQueues.get(sourceWindow.sourceId);
  if (!queue) {
    queue = [];
    state.vscodeOpenFileQueues.set(sourceWindow.sourceId, queue);
  }
  queue.push(command);

  const timeoutMs = options?.timeoutMs ?? deps.openFileTimeoutMs;
  const completion = new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      state.pendingVsCodeOpenResults.delete(command.commandId);
      rejectPromise(new Error("Timed out waiting for VSCode on this machine to open the file."));
    }, timeoutMs);
    state.pendingVsCodeOpenResults.set(command.commandId, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout,
    });
  });

  await completion;
  return {
    sourceId: sourceWindow.sourceId,
    commandId: command.commandId,
  };
}

function shouldAcceptVsCodeSelectionUpdate(current: VsCodeSelectionState | null, next: VsCodeSelectionState): boolean {
  if (!current) return true;
  if (next.updatedAt !== current.updatedAt) {
    return next.updatedAt > current.updatedAt;
  }
  if (next.sourceId !== current.sourceId) {
    return next.sourceId > current.sourceId;
  }
  return true;
}

function broadcastVsCodeSelectionState(state: BrowserTransportStateLike, deps: BrowserTransportDeps): void {
  const msg: Extract<BrowserIncomingMessage, { type: "vscode_selection_state" }> = {
    type: "vscode_selection_state",
    state: state.vscodeSelectionState,
  };
  for (const session of deps.getSessions()) {
    for (const ws of session.browserSockets) {
      sendToBrowser(ws as BrowserTransportSocketLike, msg);
    }
  }
}

function cloneVsCodeWindowState(window: VsCodeWindowState): VsCodeWindowState {
  return {
    ...window,
    workspaceRoots: [...window.workspaceRoots],
  };
}

function normalizePathForVsCodeMatch(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function getVsCodeWindowRootMatchLength(window: VsCodeWindowState, absolutePath: string): number {
  const normalizedPath = normalizePathForVsCodeMatch(absolutePath);
  let best = -1;
  for (const root of window.workspaceRoots) {
    const normalizedRoot = normalizePathForVsCodeMatch(root);
    if (!normalizedRoot) continue;
    if (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)) {
      best = Math.max(best, normalizedRoot.length);
    }
  }
  return best;
}

function getActiveVsCodeWindows(
  state: BrowserTransportStateLike,
  windowStaleMs: number,
  now = Date.now(),
): VsCodeWindowState[] {
  const active: VsCodeWindowState[] = [];
  for (const window of state.vscodeWindows.values()) {
    if (now - window.lastSeenAt <= windowStaleMs) {
      active.push(window);
    }
  }
  return active;
}

function selectVsCodeWindowForFile(
  state: BrowserTransportStateLike,
  absolutePath: string,
  windowStaleMs: number,
): VsCodeWindowState | null {
  const candidates = getActiveVsCodeWindows(state, windowStaleMs);
  if (candidates.length === 0) return null;

  const ranked = candidates.map((window) => ({
    window,
    rootMatchLength: getVsCodeWindowRootMatchLength(window, absolutePath),
  }));

  ranked.sort((a, b) => {
    const aContains = a.rootMatchLength >= 0 ? 1 : 0;
    const bContains = b.rootMatchLength >= 0 ? 1 : 0;
    if (aContains !== bContains) return bContains - aContains;
    if (a.rootMatchLength !== b.rootMatchLength) return b.rootMatchLength - a.rootMatchLength;
    if (a.window.lastActivityAt !== b.window.lastActivityAt) {
      return b.window.lastActivityAt - a.window.lastActivityAt;
    }
    if (a.window.updatedAt !== b.window.updatedAt) {
      return b.window.updatedAt - a.window.updatedAt;
    }
    return a.window.sourceId.localeCompare(b.window.sourceId);
  });

  return ranked[0]?.window ?? null;
}
