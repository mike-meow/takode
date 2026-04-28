import { describe, expect, it, vi } from "vitest";
import {
  buildPersistedSessionPayload,
  markNotificationDone,
  notifyUser,
  restorePersistedSessions,
} from "./session-registry-controller.js";

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    state: { backend_type: "claude" },
    pendingPermissions: new Map(),
    messageHistory: [],
    pendingMessages: [],
    eventBuffer: [],
    nextEventSeq: 1,
    lastAckSeq: 0,
    processedClientMessageIds: [],
    toolResults: new Map(),
    board: new Map(),
    completedBoard: new Map(),
    notifications: [],
    notificationCounter: 0,
    taskHistory: [],
    keywords: [],
    lastReadAt: 0,
    attentionReason: null,
    ...overrides,
  } as any;
}

function makeDeps() {
  return {
    isHerdedWorkerSession: () => false,
    broadcastToBrowsers: vi.fn(),
    persistSession: vi.fn(),
    scheduleNotification: vi.fn(),
    emitTakodeEvent: vi.fn(),
    broadcastBoard: vi.fn(),
  };
}

describe("session notification status metadata", () => {
  it("increments metadata and includes it in notification updates", () => {
    const session = makeSession();
    const deps = makeDeps();

    notifyUser(session, "needs-input", "Need input", deps);

    expect(session.notificationStatusVersion).toBe(1);
    expect(typeof session.notificationStatusUpdatedAt).toBe("number");
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "notification_update",
        notificationStatusVersion: 1,
        notificationStatusUpdatedAt: session.notificationStatusUpdatedAt,
      }),
    );

    markNotificationDone(session, "n-1", true, deps);
    expect(session.notificationStatusVersion).toBe(2);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "notification_update",
        notificationStatusVersion: 2,
      }),
    );
  });

  it("persists and restores notification status metadata", async () => {
    const persisted = buildPersistedSessionPayload(
      makeSession({
        notifications: [{ id: "n-1", category: "needs-input", timestamp: 1000, messageId: null, done: false }],
        notificationStatusVersion: 9,
        notificationStatusUpdatedAt: 9000,
      }),
    );
    expect(persisted).toMatchObject({
      notificationStatusVersion: 9,
      notificationStatusUpdatedAt: 9000,
    });

    const sessions = new Map<string, any>();
    await restorePersistedSessions(sessions, [persisted], {
      recoverToolStartTimesFromHistory: vi.fn(),
      finalizeRecoveredDisconnectedTerminalTools: vi.fn(),
      scheduleCodexToolResultWatchdogs: vi.fn(),
      reconcileRestoredBoardState: vi.fn(async () => {}),
    });

    expect(sessions.get("s1")).toMatchObject({
      notificationStatusVersion: 9,
      notificationStatusUpdatedAt: 9000,
    });
  });
});
