import { describe, expect, it, vi } from "vitest";
import { buildEnrichedSessionsSnapshot } from "./session-list-snapshot.js";

function makeLauncherSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    name: "Session 1",
    cwd: "/tmp/project",
    createdAt: 100,
    state: "idle",
    model: "default",
    backendType: "claude",
    archived: false,
    isWorktree: false,
    lastUserMessageAt: 900,
    ...overrides,
  };
}

function makeBridgeSession(messageHistory: unknown[]) {
  return {
    id: "s1",
    state: {},
    messageHistory,
    pendingPermissions: new Map(),
    notifications: [],
    lastReadAt: 0,
    attentionReason: null,
    isGenerating: false,
    lastUserMessage: "",
    taskHistory: [],
    keywords: [],
  };
}

function makeDeps(launcherSession: ReturnType<typeof makeLauncherSession>, bridgeSession: unknown) {
  return {
    launcher: {
      listSessions: vi.fn(() => [launcherSession]),
      getSession: vi.fn(() => launcherSession),
      getSessionNum: vi.fn(() => 1),
      setWorktreeCleanupState: vi.fn(),
    },
    wsBridge: {
      getSession: vi.fn(() => bridgeSession),
      isBackendConnected: vi.fn(() => false),
      refreshWorktreeGitStateForSnapshot: vi.fn(),
    },
    pendingWorktreeCleanups: new Map(),
  } as never;
}

describe("buildEnrichedSessionsSnapshot", () => {
  it("derives lastUserMessageAt from human message history when bridge history is available", async () => {
    const launcherSession = makeLauncherSession({ lastUserMessageAt: 900 });
    const bridgeSession = makeBridgeSession([
      { type: "user_message", timestamp: 200, content: "Human request" },
      {
        type: "user_message",
        timestamp: 900,
        content: "Leader injection",
        agentSource: { sessionId: "leader-1", sessionLabel: "#1 Leader" },
      },
    ]);

    const snapshot = await buildEnrichedSessionsSnapshot(makeDeps(launcherSession, bridgeSession));

    expect(snapshot[0].lastUserMessageAt).toBe(200);
  });

  it("clears polluted lastUserMessageAt when bridge history has no human user messages", async () => {
    const launcherSession = makeLauncherSession({ lastUserMessageAt: 900 });
    const bridgeSession = makeBridgeSession([
      {
        type: "user_message",
        timestamp: 900,
        content: "Timer injection",
        agentSource: { sessionId: "timer", sessionLabel: "Timer" },
      },
      { type: "assistant", timestamp: 950, content: "Assistant work" },
    ]);

    const snapshot = await buildEnrichedSessionsSnapshot(makeDeps(launcherSession, bridgeSession));

    expect(snapshot[0].lastUserMessageAt).toBeUndefined();
  });
});
