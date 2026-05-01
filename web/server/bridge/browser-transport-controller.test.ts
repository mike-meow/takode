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
  injectUserMessage,
  sendLeaderProjectionSnapshot,
  type BrowserTransportSessionLike,
} from "./browser-transport-controller.js";
import type { BrowserIncomingMessage } from "../session-types.js";

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
