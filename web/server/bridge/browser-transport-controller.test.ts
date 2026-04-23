/**
 * Regression tests for tree_groups_update replay-buffer exclusion (q-599).
 *
 * tree_groups_update is a global snapshot event. Buffering it per-session
 * causes replay-buffer bloat on restart and stale-snapshot overwrites on
 * reconnect (the fresh-on-open snapshot at handleBrowserOpen is clobbered
 * by an older buffered copy during event_replay).
 */

import { describe, it, expect, vi } from "vitest";
import { broadcastToBrowsers, type BrowserTransportSessionLike } from "./browser-transport-controller.js";
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
