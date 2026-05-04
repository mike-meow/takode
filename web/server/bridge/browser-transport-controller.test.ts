/**
 * Regression tests for tree_groups_update replay-buffer exclusion (q-599).
 *
 * tree_groups_update is a global snapshot event. Buffering it per-session
 * causes replay-buffer bloat on restart and stale-snapshot overwrites on
 * reconnect (the fresh-on-open snapshot at handleBrowserOpen is clobbered
 * by an older buffered copy during event_replay).
 */

import { describe, it, expect, vi } from "vitest";
import {
  broadcastToBrowsers,
  handleBrowserProtocolMessage,
  injectUserMessage,
  sendLeaderProjectionSnapshot,
  sendHistoryWindowSync,
  sendThreadWindowSync,
  type BrowserTransportSessionLike,
} from "./browser-transport-controller.js";
import type { BrowserIncomingMessage } from "../session-types.js";
import { FEED_WINDOW_SYNC_VERSION } from "../../shared/feed-window-sync.js";

function makeSession(overrides?: Partial<BrowserTransportSessionLike>): BrowserTransportSessionLike {
  const mockSocket = { send: vi.fn() };
  return {
    id: "test-session",
    backendType: "claude",
    browserSockets: new Set([mockSocket]),
    messageHistory: [],
    frozenCount: 0,
    state: { permissionMode: "default" } as any,
    nextEventSeq: 1,
    lastAckSeq: 0,
    pendingPermissions: new Map(),
    pendingCodexInputs: [],
    pendingCodexTurns: [],
    taskHistory: [],
    eventBuffer: [],
    lastReadAt: Date.now(),
    attentionReason: null,
    generationStartedAt: null,
    notifications: [],
    attentionRecords: [],
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
    ...overrides,
  };
}

function makeDeps() {
  return {
    eventBufferLimit: 100,
    persistSession: vi.fn(),
    recordOutgoingRaw: vi.fn(),
  };
}

function makeInjectDeps(overrides: Record<string, unknown> = {}) {
  return {
    ...makeDeps(),
    refreshGitInfoThenRecomputeDiff: vi.fn(),
    prefillSlashCommands: vi.fn(),
    getTreeGroupState: vi.fn(async () => ({ groups: [], assignments: {}, nodeOrder: {} })),
    getVsCodeSelectionState: vi.fn(() => null),
    getLauncherSessionInfo: vi.fn(() => ({ isOrchestrator: true, state: "connected", backendType: "codex" })),
    backendAttached: vi.fn(() => true),
    backendConnected: vi.fn(() => true),
    requestCodexAutoRecovery: vi.fn(() => false),
    getRouteChain: vi.fn(() => undefined),
    setRouteChain: vi.fn(),
    clearRouteChain: vi.fn(),
    routeBrowserMessage: vi.fn(),
    abortAutoApproval: vi.fn(),
    broadcastToBrowsers: vi.fn(),
    setAttentionAction: vi.fn(),
    touchActivity: vi.fn(),
    notifyImageSendFailure: vi.fn(),
    broadcastError: vi.fn(),
    queueCodexPendingStartBatch: vi.fn(),
    deriveBackendState: vi.fn(() => "connected"),
    getBoard: vi.fn(() => []),
    getCompletedBoard: vi.fn(() => []),
    getBoardRowSessionStatuses: vi.fn(() => ({})),
    recoverToolStartTimesFromHistory: vi.fn(),
    finalizeRecoveredDisconnectedTerminalTools: vi.fn(),
    scheduleCodexToolResultWatchdogs: vi.fn(),
    recomputeAndBroadcastHistoryBytes: vi.fn(),
    listTimers: vi.fn(() => []),
    browserTransportState: {
      vscodeSelectionState: null,
      vscodeWindows: new Map(),
      vscodeOpenFileQueues: new Map(),
      pendingVsCodeOpenResults: new Map(),
    },
    idempotentMessageTypes: new Set<string>(),
    processedClientMsgIdLimit: 100,
    getSessions: vi.fn(() => []),
    windowStaleMs: 1000,
    openFileTimeoutMs: 1000,
    ...overrides,
  } as any;
}

describe("tree_groups_update replay-buffer exclusion", () => {
  it("should NOT buffer tree_groups_update in eventBuffer", () => {
    const session = makeSession();
    const deps = makeDeps();

    broadcastToBrowsers(
      session,
      {
        type: "tree_groups_update",
        treeGroups: [{ id: "g1", name: "Group 1" }],
        treeAssignments: {},
        treeNodeOrder: {},
      } as BrowserIncomingMessage,
      deps,
    );

    expect(session.eventBuffer).toHaveLength(0);
    expect(deps.persistSession).not.toHaveBeenCalled();
  });

  it("should still send tree_groups_update to connected browsers (live fanout)", () => {
    const sendFn = vi.fn();
    const mockSocket = { send: sendFn };
    const session = makeSession({ browserSockets: new Set([mockSocket]) });
    const deps = makeDeps();

    broadcastToBrowsers(
      session,
      {
        type: "tree_groups_update",
        treeGroups: [],
        treeAssignments: {},
        treeNodeOrder: {},
      } as BrowserIncomingMessage,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(sendFn.mock.calls[0][0]);
    expect(sent.type).toBe("tree_groups_update");
    expect(sent.seq).toBeDefined();
  });

  it("should still buffer normal session events like session_update", () => {
    const session = makeSession();
    const deps = makeDeps();

    broadcastToBrowsers(session, { type: "session_update", session: { name: "test" } } as BrowserIncomingMessage, deps);

    expect(session.eventBuffer).toHaveLength(1);
    expect(session.eventBuffer[0].message.type).toBe("session_update");
  });

  it("should respect skipBuffer option for any message type", () => {
    const session = makeSession();
    const deps = makeDeps();

    broadcastToBrowsers(
      session,
      { type: "session_update", session: { name: "test" } } as BrowserIncomingMessage,
      deps,
      { skipBuffer: true },
    );

    expect(session.eventBuffer).toHaveLength(0);
  });

  it("should not buffer or persist across multiple sessions receiving tree_groups_update", () => {
    // broadcastGlobal() iterates sessions calling broadcastToBrowsers with { skipBuffer: true }.
    // We test both defenses here: the type exclusion alone prevents buffering, and skipBuffer
    // (verified by the "should respect skipBuffer option" test) provides belt-and-suspenders.
    const sessions = [makeSession({ id: "s1" }), makeSession({ id: "s2" }), makeSession({ id: "s3" })];
    const deps = makeDeps();
    const msg = {
      type: "tree_groups_update",
      treeGroups: [],
      treeAssignments: {},
      treeNodeOrder: {},
    } as BrowserIncomingMessage;

    for (const session of sessions) {
      broadcastToBrowsers(session, msg, deps);
    }

    for (const session of sessions) {
      expect(session.eventBuffer).toHaveLength(0);
    }
    expect(deps.persistSession).not.toHaveBeenCalled();
  });
});

describe("quest_list_updated replay-buffer exclusion", () => {
  it("does not buffer quest_list_updated invalidations while preserving live fanout", () => {
    const sendFn = vi.fn();
    const session = makeSession({ browserSockets: new Set([{ send: sendFn }]) });
    const deps = makeDeps();

    broadcastToBrowsers(session, { type: "quest_list_updated" } as BrowserIncomingMessage, deps);

    expect(sendFn).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(sendFn.mock.calls[0][0]);
    expect(sent.type).toBe("quest_list_updated");
    expect(sent.seq).toBeDefined();
    expect(session.eventBuffer).toHaveLength(0);
    expect(deps.persistSession).not.toHaveBeenCalled();
  });
});

describe("leader_thread_tabs_update", () => {
  it("persists and broadcasts authoritative leader tab updates", () => {
    const session = makeSession({
      state: {
        permissionMode: "default",
        isOrchestrator: true,
        leaderOpenThreadTabs: {
          version: 1,
          orderedOpenThreadKeys: ["q-1"],
          closedThreadTombstones: [],
          updatedAt: 1,
        },
      } as any,
    });
    const deps = makeInjectDeps();

    const handled = handleBrowserProtocolMessage(
      session,
      {
        type: "leader_thread_tabs_update",
        operation: { type: "open", threadKey: "q-2", placement: "first", source: "user" },
        client_msg_id: "tabs-1",
      },
      undefined,
      deps,
    );

    expect(handled).toBe(true);
    expect(session.state.leaderOpenThreadTabs?.orderedOpenThreadKeys).toEqual(["q-2", "q-1"]);
    expect(deps.persistSession).toHaveBeenCalledWith(session);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "session_update",
      session: { leaderOpenThreadTabs: session.state.leaderOpenThreadTabs },
    });
  });

  it("keeps migrated browser localStorage from overriding existing server state", () => {
    const serverState = {
      version: 1 as const,
      orderedOpenThreadKeys: ["q-server"],
      closedThreadTombstones: [],
      updatedAt: 1,
    };
    const session = makeSession({
      state: {
        permissionMode: "default",
        isOrchestrator: true,
        leaderOpenThreadTabs: serverState,
      } as any,
    });
    const deps = makeInjectDeps();

    const handled = handleBrowserProtocolMessage(
      session,
      {
        type: "leader_thread_tabs_update",
        operation: { type: "migrate", orderedOpenThreadKeys: ["q-local"], migratedAt: 100 },
      },
      undefined,
      deps,
    );

    expect(handled).toBe(true);
    expect(session.state.leaderOpenThreadTabs).toEqual(serverState);
    expect(deps.persistSession).not.toHaveBeenCalled();
    expect(deps.broadcastToBrowsers).not.toHaveBeenCalled();
  });

  it("deduplicates repeated tab update client messages", () => {
    const session = makeSession({
      state: { permissionMode: "default", isOrchestrator: true } as any,
    });
    const deps = makeInjectDeps();
    const msg = {
      type: "leader_thread_tabs_update" as const,
      operation: { type: "open" as const, threadKey: "q-1", placement: "first" as const, source: "user" as const },
      client_msg_id: "tabs-1",
    };

    expect(handleBrowserProtocolMessage(session, msg, undefined, deps)).toBe(true);
    expect(handleBrowserProtocolMessage(session, msg, undefined, deps)).toBe(true);

    expect(session.state.leaderOpenThreadTabs?.orderedOpenThreadKeys).toEqual(["q-1"]);
    expect(deps.persistSession).toHaveBeenCalledTimes(2);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledTimes(1);
  });

  it("persists reordered tabs while preserving server-open keys omitted by stale clients", () => {
    const session = makeSession({
      state: {
        permissionMode: "default",
        isOrchestrator: true,
        leaderOpenThreadTabs: {
          version: 1,
          orderedOpenThreadKeys: ["q-1", "q-2", "q-3"],
          closedThreadTombstones: [],
          updatedAt: 1,
        },
      } as any,
    });
    const deps = makeInjectDeps();

    const handled = handleBrowserProtocolMessage(
      session,
      {
        type: "leader_thread_tabs_update",
        operation: { type: "reorder", orderedOpenThreadKeys: ["q-3", "q-1"] },
        client_msg_id: "tabs-reorder-1",
      },
      undefined,
      deps,
    );

    expect(handled).toBe(true);
    expect(session.state.leaderOpenThreadTabs?.orderedOpenThreadKeys).toEqual(["q-3", "q-1", "q-2"]);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "session_update",
      session: { leaderOpenThreadTabs: session.state.leaderOpenThreadTabs },
    });
  });

  it("ignores stale or unsupported tab operations without mutating server state", () => {
    const serverState = {
      version: 1 as const,
      orderedOpenThreadKeys: ["q-1", "q-2"],
      closedThreadTombstones: [],
      updatedAt: 1,
    };
    const session = makeSession({
      state: {
        permissionMode: "default",
        isOrchestrator: true,
        leaderOpenThreadTabs: serverState,
      } as any,
    });
    const deps = makeInjectDeps();

    for (const operation of [
      { type: "auto_close", threadKeys: ["q-1"] },
      { type: "unknown_operation", threadKeys: ["q-2"] },
    ]) {
      const handled = handleBrowserProtocolMessage(
        session,
        {
          type: "leader_thread_tabs_update",
          operation,
          client_msg_id: `tabs-${operation.type}`,
        } as any,
        undefined,
        deps,
      );

      expect(handled).toBe(true);
    }

    expect(session.state.leaderOpenThreadTabs).toEqual(serverState);
    expect(deps.persistSession).not.toHaveBeenCalled();
    expect(deps.broadcastToBrowsers).not.toHaveBeenCalled();
  });
});

describe("leader text stream replay-buffer exclusion", () => {
  it("sends top-level leader text deltas live without storing them for reconnect replay", () => {
    const sendFn = vi.fn();
    const session = makeSession({
      browserSockets: new Set([{ send: sendFn }]),
      state: { permissionMode: "default", isOrchestrator: true } as any,
    });
    const deps = makeDeps();

    broadcastToBrowsers(
      session,
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "[thread:q-1] " } },
      },
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(sendFn.mock.calls[0][0]);
    expect(sent.type).toBe("stream_event");
    expect(sent.seq).toBeDefined();
    expect(session.eventBuffer).toHaveLength(0);
    expect(deps.persistSession).not.toHaveBeenCalled();
  });

  it("keeps worker top-level text deltas and nested leader text deltas in the replay buffer", () => {
    const leaderSession = makeSession({ state: { permissionMode: "default", isOrchestrator: true } as any });
    const workerSession = makeSession({ id: "worker-session" });
    const deps = makeDeps();

    broadcastToBrowsers(
      workerSession,
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "worker" } },
      },
      deps,
    );
    broadcastToBrowsers(
      leaderSession,
      {
        type: "stream_event",
        parent_tool_use_id: "agent-1",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "nested" } },
      },
      deps,
    );

    expect(workerSession.eventBuffer).toHaveLength(1);
    expect(leaderSession.eventBuffer).toHaveLength(1);
  });
});

describe("leader projection snapshots", () => {
  it("does not buffer leader projection snapshots because they are replaceable snapshots", () => {
    const sendFn = vi.fn();
    const session = makeSession({ browserSockets: new Set([{ send: sendFn }]) });
    const deps = makeDeps();

    broadcastToBrowsers(
      session,
      {
        type: "leader_projection_snapshot",
        projection: {
          schemaVersion: 1,
          revision: 1,
          sourceHistoryLength: 0,
          generatedAt: 1,
          threadSummaries: [],
          threadRows: [],
          workBoardThreadRows: [],
          messageAttentionRecords: [],
          attentionRecords: [],
          rawTurnBoundaries: [],
        },
      } as BrowserIncomingMessage,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendFn.mock.calls[0][0]).type).toBe("leader_projection_snapshot");
    expect(session.eventBuffer).toHaveLength(0);
    expect(deps.persistSession).not.toHaveBeenCalled();
  });

  it("sends a leader projection snapshot before the raw history window can be consumed", () => {
    const send = vi.fn();
    const session = makeSession({
      state: { permissionMode: "default", isOrchestrator: true } as any,
      messageHistory: [
        {
          type: "user_message",
          id: "u1",
          content: "[thread:q-1039]\nPlease implement the projection slice.",
          timestamp: 1,
          threadKey: "q-1039",
          questId: "q-1039",
        } as BrowserIncomingMessage,
      ],
    });
    const deps = makeInjectDeps({
      getBoard: vi.fn(() => [{ questId: "q-1039", title: "Projection summaries", status: "IMPLEMENT", updatedAt: 2 }]),
    });

    sendLeaderProjectionSnapshot(session, { send }, deps);

    const snapshot = JSON.parse(send.mock.calls[0][0]);
    expect(snapshot.type).toBe("leader_projection_snapshot");
    expect(snapshot.projection.sourceHistoryLength).toBe(1);
    expect(snapshot.projection.threadSummaries).toEqual([
      expect.objectContaining({ threadKey: "q-1039", messageCount: 1 }),
    ]);
    expect(snapshot.projection.threadRows).toEqual([
      expect.objectContaining({ threadKey: "q-1039", title: "Projection summaries", messageCount: 1 }),
    ]);
  });
});

describe("history window tool results", () => {
  it("includes resolved previews for visible Codex tools even when the preview is outside the window slice", () => {
    const send = vi.fn();
    const session = makeSession({
      backendType: "codex",
      messageHistory: [
        {
          type: "user_message",
          id: "u1",
          content: "Check status",
          timestamp: 1,
        } as BrowserIncomingMessage,
        {
          type: "assistant",
          message: {
            id: "a1",
            type: "message",
            role: "assistant",
            model: "gpt-5.5",
            content: [
              {
                type: "tool_use",
                id: "call-orphaned",
                name: "Bash",
                input: { command: "git status --short" },
              },
            ],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2,
          tool_start_times: { "call-orphaned": 2 },
        } as BrowserIncomingMessage,
        {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "Done",
            duration_ms: 1000,
            duration_api_ms: 900,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: "end_turn",
            session_id: "test-session",
          },
        } as BrowserIncomingMessage,
        {
          type: "tool_result_preview",
          previews: [
            {
              tool_use_id: "call-orphaned",
              content: "Terminal command did not deliver a final result after a later tool completed.",
              is_error: false,
              total_size: 77,
              is_truncated: false,
              duration_seconds: 121.7,
              synthetic_reason: "superseded_by_later_completed_tool",
              retained_output: false,
            },
          ],
        } as BrowserIncomingMessage,
      ],
    });

    sendHistoryWindowSync(
      session,
      { send },
      { fromTurn: 0, turnCount: 1, sectionTurnCount: 1, visibleSectionCount: 1 },
    );

    const payload = JSON.parse(send.mock.calls[0][0]);
    expect(payload.type).toBe("history_window_sync");
    expect(payload.messages.map((msg: BrowserIncomingMessage) => msg.type)).toEqual([
      "user_message",
      "assistant",
      "result",
      "tool_result_preview",
    ]);
    expect(payload.messages.at(-1).previews[0]).toMatchObject({
      tool_use_id: "call-orphaned",
      synthetic_reason: "superseded_by_later_completed_tool",
      retained_output: false,
    });
  });

  it("omits history payload when the browser proves its cached window still matches", () => {
    const send = vi.fn();
    const session = makeSession({
      messageHistory: [
        { type: "user_message", id: "u1", content: "turn 1", timestamp: 1000 } as BrowserIncomingMessage,
        {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            session_id: "test-session",
          },
        } as BrowserIncomingMessage,
        { type: "user_message", id: "u2", content: "turn 2", timestamp: 2000 } as BrowserIncomingMessage,
      ],
    });

    sendHistoryWindowSync(
      session,
      { send },
      { fromTurn: 0, turnCount: 1, sectionTurnCount: 1, visibleSectionCount: 1 },
    );
    const firstPayload = JSON.parse(send.mock.calls[0][0]);
    send.mockClear();

    sendHistoryWindowSync(
      session,
      { send },
      {
        fromTurn: 0,
        turnCount: 1,
        sectionTurnCount: 1,
        visibleSectionCount: 1,
        cachedWindowHash: firstPayload.window.window_hash,
      },
    );

    const payload = JSON.parse(send.mock.calls[0][0]);
    expect(payload.type).toBe("history_window_sync");
    expect(payload.window).toMatchObject({ has_older_items: false, has_newer_items: true });
    expect(payload.cache_hit).toBe(true);
    expect(payload.messages).toEqual([]);
    expect(payload.window.window_hash).toBe(firstPayload.window.window_hash);
  });

  it("treats negative history window fromTurn as the latest bounded window", () => {
    const send = vi.fn();
    const session = makeSession({
      messageHistory: [
        { type: "user_message", id: "u1", content: "turn 1", timestamp: 1000 } as BrowserIncomingMessage,
        {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            session_id: "test-session",
          },
        } as BrowserIncomingMessage,
        { type: "user_message", id: "u2", content: "turn 2", timestamp: 2000 } as BrowserIncomingMessage,
        {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            session_id: "test-session",
          },
        } as BrowserIncomingMessage,
        { type: "user_message", id: "u3", content: "turn 3", timestamp: 3000 } as BrowserIncomingMessage,
      ],
    });

    sendHistoryWindowSync(
      session,
      { send },
      { fromTurn: -1, turnCount: 2, sectionTurnCount: 1, visibleSectionCount: 2 },
    );

    const payload = JSON.parse(send.mock.calls[0][0]);
    expect(payload.type).toBe("history_window_sync");
    expect(payload.window.from_turn).toBe(1);
    expect(payload.window.turn_count).toBe(2);
    expect(payload.window).toMatchObject({ has_older_items: true, has_newer_items: false });
    expect(payload.messages.map((message: BrowserIncomingMessage) => (message as { id?: string }).id)).toEqual([
      "u2",
      undefined,
      "u3",
    ]);
  });

  it("sends additive feed_window_sync only when the browser advertises v1 support", () => {
    const send = vi.fn();
    const session = makeSession({
      messageHistory: [
        { type: "user_message", id: "u1", content: "turn 1", timestamp: 1000 } as BrowserIncomingMessage,
        {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            session_id: "test-session",
          },
        } as BrowserIncomingMessage,
      ],
    });

    sendHistoryWindowSync(
      session,
      { send },
      { fromTurn: 0, turnCount: 1, sectionTurnCount: 1, visibleSectionCount: 1 },
    );
    expect(send).toHaveBeenCalledTimes(1);

    send.mockClear();
    sendHistoryWindowSync(
      session,
      { send },
      {
        fromTurn: 0,
        turnCount: 1,
        sectionTurnCount: 1,
        visibleSectionCount: 1,
        feedWindowSyncVersion: FEED_WINDOW_SYNC_VERSION,
      },
    );

    expect(send).toHaveBeenCalledTimes(2);
    const legacy = JSON.parse(send.mock.calls[0][0]);
    const sidecar = JSON.parse(send.mock.calls[1][0]);
    expect(legacy.type).toBe("history_window_sync");
    expect(sidecar).toMatchObject({
      type: "feed_window_sync",
      sync: {
        version: FEED_WINDOW_SYNC_VERSION,
        source: "history_window",
        threadKey: "main",
        bounds: { from: 0, count: 1, total: 1, hasOlderItems: false, hasNewerItems: false },
      },
    });
    expect(sidecar.sync.windowHash).toBe(legacy.window.window_hash);
    expect(sidecar.sync.items.map((item: any) => item.messageId)).toEqual(["u1", "result:1"]);
  });
});

describe("selected feed thread windows", () => {
  it("sends bounded thread_window_sync entries without using the raw history window protocol", () => {
    const send = vi.fn();
    const history: BrowserIncomingMessage[] = [];
    for (let index = 0; index < 1_000; index++) {
      const threadKey = index % 100 === 0 ? "q-1040" : "q-noise";
      history.push({
        type: "user_message",
        id: `u-${index}`,
        content: `message ${index}`,
        timestamp: index,
        threadKey,
        questId: threadKey,
        threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }],
      } as BrowserIncomingMessage);
    }
    const session = makeSession({ messageHistory: history });

    sendThreadWindowSync(
      session,
      { send },
      {
        threadKey: "q-1040",
        fromItem: -1,
        itemCount: 3,
        sectionItemCount: 3,
        visibleItemCount: 1,
      },
    );

    const sync = JSON.parse(send.mock.calls[0][0]);
    expect(sync.type).toBe("thread_window_sync");
    expect(sync.thread_key).toBe("q-1040");
    expect(sync.window.source_history_length).toBe(1_000);
    expect(sync.window.total_items).toBe(10);
    expect(sync.window).toMatchObject({ has_older_items: true, has_newer_items: false });
    expect(sync.entries).toHaveLength(3);
    expect(sync.entries.map((entry: any) => entry.history_index)).toEqual([700, 800, 900]);
    expect(sync.entries.map((entry: any) => entry.message.id)).toEqual(["u-700", "u-800", "u-900"]);
  });

  it("omits selected-thread payload when the cached thread window hash still matches", () => {
    const send = vi.fn();
    const session = makeSession({
      messageHistory: [
        {
          type: "user_message",
          id: "u-thread",
          content: "thread message",
          timestamp: 1,
          threadKey: "q-1040",
          questId: "q-1040",
          threadRefs: [{ threadKey: "q-1040", questId: "q-1040", source: "explicit" }],
        } as BrowserIncomingMessage,
      ],
    });

    sendThreadWindowSync(
      session,
      { send },
      {
        threadKey: "q-1040",
        fromItem: 0,
        itemCount: 1,
        sectionItemCount: 1,
        visibleItemCount: 1,
      },
    );
    const firstPayload = JSON.parse(send.mock.calls[0][0]);
    send.mockClear();

    sendThreadWindowSync(
      session,
      { send },
      {
        threadKey: "q-1040",
        fromItem: 0,
        itemCount: 1,
        sectionItemCount: 1,
        visibleItemCount: 1,
        cachedWindowHash: firstPayload.window.window_hash,
      },
    );

    const payload = JSON.parse(send.mock.calls[0][0]);
    expect(payload.type).toBe("thread_window_sync");
    expect(payload.cache_hit).toBe(true);
    expect(payload.entries).toEqual([]);
    expect(payload.window.window_hash).toBe(firstPayload.window.window_hash);
  });

  it("sends additive selected-thread feed_window_sync while keeping cache-hit fallback explicit", () => {
    const send = vi.fn();
    const session = makeSession({
      messageHistory: [
        {
          type: "user_message",
          id: "u-thread",
          content: "thread message",
          timestamp: 1,
          threadKey: "q-1040",
          questId: "q-1040",
          threadRefs: [{ threadKey: "q-1040", questId: "q-1040", source: "explicit" }],
        } as BrowserIncomingMessage,
      ],
    });

    sendThreadWindowSync(
      session,
      { send },
      {
        threadKey: "q-1040",
        fromItem: 0,
        itemCount: 1,
        sectionItemCount: 1,
        visibleItemCount: 1,
        feedWindowSyncVersion: FEED_WINDOW_SYNC_VERSION,
      },
    );
    const firstWindow = JSON.parse(send.mock.calls[0][0]).window;
    send.mockClear();

    sendThreadWindowSync(
      session,
      { send },
      {
        threadKey: "q-1040",
        fromItem: 0,
        itemCount: 1,
        sectionItemCount: 1,
        visibleItemCount: 1,
        cachedWindowHash: firstWindow.window_hash,
        feedWindowSyncVersion: FEED_WINDOW_SYNC_VERSION,
      },
    );

    expect(send).toHaveBeenCalledTimes(2);
    const legacy = JSON.parse(send.mock.calls[0][0]);
    const sidecar = JSON.parse(send.mock.calls[1][0]);
    expect(legacy).toMatchObject({
      type: "thread_window_sync",
      cache_hit: true,
      entries: [],
    });
    expect(sidecar).toMatchObject({
      type: "feed_window_sync",
      sync: {
        version: FEED_WINDOW_SYNC_VERSION,
        source: "thread_window",
        threadKey: "q-1040",
        windowHash: firstWindow.window_hash,
        bounds: {
          from: 0,
          count: 1,
          total: 1,
          hasOlderItems: false,
          hasNewerItems: false,
          sourceHistoryLength: 1,
        },
      },
    });
    expect(sidecar.sync.items).toEqual([
      expect.objectContaining({ messageId: "u-thread", historyIndex: 0, messageType: "user_message" }),
    ]);
  });
});

describe("Codex herd event injection", () => {
  it("reports a live Codex pending herd input as queued until retry accepts it", () => {
    const agentSource = { sessionId: "herd-events", sessionLabel: "Herd Events" };
    const session = makeSession({
      backendType: "codex",
      state: { permissionMode: "default", backend_state: "connected", cwd: "/repo" } as any,
    });
    const routeBrowserMessage = vi.fn((target: BrowserTransportSessionLike, msg: any) => {
      const id = `pending-${target.pendingCodexInputs.length + 1}`;
      target.pendingCodexInputs.push({
        id,
        content: msg.content,
        timestamp: Date.now(),
        cancelable: true,
        agentSource: msg.agentSource,
        threadKey: msg.threadKey,
      });
      target.pendingCodexTurns.push({
        userMessageId: id,
        pendingInputIds: [id],
        adapterMsg: { type: "codex_start_pending", inputIds: [id] } as any,
        status: "queued",
        turnTarget: "current",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        dispatchCount: 0,
      } as any);
    });
    const queueCodexPendingStartBatch = vi.fn((target: BrowserTransportSessionLike) => {
      target.pendingCodexTurns[0]!.status = "dispatched";
    });
    const deps = makeInjectDeps({ routeBrowserMessage, queueCodexPendingStartBatch });
    const threadRoute = { threadKey: "q-975", questId: "q-975" } as any;

    const first = injectUserMessage(
      session,
      "1 event from 1 session\n\n#1270 | board_stalled | q-975 | EXPLORING | worker disconnected | stalled 571m | 16m ago",
      agentSource,
      undefined,
      deps,
      threadRoute,
    );
    expect(first).toBe("queued");
    expect(session.pendingCodexInputs).toHaveLength(1);

    const retry = injectUserMessage(
      session,
      "1 event from 1 session\n\n#1270 | board_stalled | q-975 | EXPLORING | worker disconnected | stalled 571m | 17m ago",
      agentSource,
      undefined,
      deps,
      threadRoute,
    );
    expect(retry).toBe("sent");
    expect(routeBrowserMessage).toHaveBeenCalledTimes(1);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(queueCodexPendingStartBatch).toHaveBeenCalledWith(session, "inject_herd_event_retry");
  });

  it("reports Codex herd injections as queued while a browser route is already in flight", async () => {
    const agentSource = { sessionId: "herd-events", sessionLabel: "Herd Events" };
    const session = makeSession({
      backendType: "codex",
      state: { permissionMode: "default", backend_state: "connected", cwd: "/repo" } as any,
    });
    const routeBrowserMessage = vi.fn();
    let releaseInFlight!: () => void;
    const inFlightRoute = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    let currentRoute: Promise<void> | undefined = inFlightRoute;
    const deps = makeInjectDeps({
      routeBrowserMessage,
      getRouteChain: vi.fn(() => currentRoute),
      setRouteChain: vi.fn((_sessionId: string, route: Promise<void>) => {
        currentRoute = route;
      }),
      clearRouteChain: vi.fn((_sessionId: string, route: Promise<void>) => {
        if (currentRoute === route) currentRoute = undefined;
      }),
    });

    const delivery = injectUserMessage(
      session,
      "1 event from 1 session\n\n#1270 | turn_end | worker finished | 1m ago",
      agentSource,
      undefined,
      deps,
      { threadKey: "main" } as any,
    );

    expect(delivery).toBe("queued");
    expect(routeBrowserMessage).not.toHaveBeenCalled();

    releaseInFlight();
    await currentRoute;

    expect(routeBrowserMessage).toHaveBeenCalledTimes(1);
  });

  it("dedupes Codex herd retries while a browser route is still in flight", async () => {
    const agentSource = { sessionId: "herd-events", sessionLabel: "Herd Events" };
    const session = makeSession({
      backendType: "codex",
      state: { permissionMode: "default", backend_state: "connected", cwd: "/repo" } as any,
    });
    const routeBrowserMessage = vi.fn();
    let releaseInFlight!: () => void;
    const inFlightRoute = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    let currentRoute: Promise<void> | undefined = inFlightRoute;
    const deps = makeInjectDeps({
      routeBrowserMessage,
      getRouteChain: vi.fn(() => currentRoute),
      setRouteChain: vi.fn((_sessionId: string, route: Promise<void>) => {
        currentRoute = route;
      }),
      clearRouteChain: vi.fn((_sessionId: string, route: Promise<void>) => {
        if (currentRoute === route) currentRoute = undefined;
      }),
    });

    const first = injectUserMessage(
      session,
      "1 event from 1 session\n\n#1270 | turn_end | worker finished | 1m ago",
      agentSource,
      undefined,
      deps,
      { threadKey: "main" } as any,
    );
    const retry = injectUserMessage(
      session,
      "1 event from 1 session\n\n#1270 | turn_end | worker finished | 2m ago",
      agentSource,
      undefined,
      deps,
      { threadKey: "main" } as any,
    );

    expect(first).toBe("queued");
    expect(retry).toBe("queued");
    expect(deps.setRouteChain).toHaveBeenCalledTimes(1);
    expect(routeBrowserMessage).not.toHaveBeenCalled();

    releaseInFlight();
    await currentRoute;

    expect(routeBrowserMessage).toHaveBeenCalledTimes(1);
  });
});
