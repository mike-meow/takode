import { describe, expect, it, beforeEach, vi } from "vitest";
import type { PendingSession } from "../store.js";

const mockCreateSessionStream = vi.hoisted(() => vi.fn());
const mockAssignSessionToTreeGroup = vi.hoisted(() => vi.fn());
const mockConnectSession = vi.hoisted(() => vi.fn());
const mockNavigateToSession = vi.hoisted(() => vi.fn());
const mockNavigateToMostRecentSession = vi.hoisted(() => vi.fn());
const mockAddRecentDir = vi.hoisted(() => vi.fn());

type TestStore = {
  pendingSessions: Map<string, PendingSession>;
  currentSessionId: string | null;
  addPendingSession: (session: PendingSession) => void;
  updatePendingSession: (id: string, updates: Partial<PendingSession>) => void;
  addPendingProgress: (id: string, step: unknown) => void;
  removePendingSession: (id: string) => void;
};

const testStore = vi.hoisted(
  (): TestStore => ({
    pendingSessions: new Map(),
    currentSessionId: null,
    addPendingSession: vi.fn((session: PendingSession) => {
      testStore.pendingSessions.set(session.id, session);
    }),
    updatePendingSession: vi.fn((id: string, updates: Partial<PendingSession>) => {
      const current = testStore.pendingSessions.get(id);
      if (current) testStore.pendingSessions.set(id, { ...current, ...updates });
    }),
    addPendingProgress: vi.fn(),
    removePendingSession: vi.fn((id: string) => {
      testStore.pendingSessions.delete(id);
    }),
  }),
);

vi.mock("../api.js", () => ({
  createSessionStream: (...args: unknown[]) => mockCreateSessionStream(...args),
  api: {
    assignSessionToTreeGroup: (...args: unknown[]) => mockAssignSessionToTreeGroup(...args),
  },
}));

vi.mock("../ws.js", () => ({
  connectSession: (...args: unknown[]) => mockConnectSession(...args),
}));

vi.mock("./routing.js", () => ({
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
  navigateToMostRecentSession: (...args: unknown[]) => mockNavigateToMostRecentSession(...args),
}));

vi.mock("./recent-dirs.js", () => ({
  addRecentDir: (...args: unknown[]) => mockAddRecentDir(...args),
}));

vi.mock("../store.js", () => ({
  useStore: {
    getState: () => testStore,
  },
}));

import { queuePendingSession } from "./pending-creation.js";

async function waitForCreationToSettle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("pending creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testStore.pendingSessions.clear();
    testStore.currentSessionId = null;
    mockCreateSessionStream.mockResolvedValue({
      sessionId: "remote-session",
      state: "starting",
      cwd: "/repo",
    });
    mockAssignSessionToTreeGroup.mockResolvedValue({ ok: true });
  });

  it("does not write a stale source group id after the server resolves a portable Session Space", async () => {
    mockCreateSessionStream.mockResolvedValueOnce({
      sessionId: "remote-session",
      state: "starting",
      cwd: "/repo",
      treeGroupId: "remote-local-test-group",
      memorySessionSpaceSlug: "test",
    });

    queuePendingSession({
      backend: "claude",
      createOpts: {
        cwd: "/repo",
        treeGroupId: "home-local-test-group",
        memorySessionSpaceSlug: "test",
      },
      cwd: "/repo",
      treeGroupId: "home-local-test-group",
    });
    await waitForCreationToSettle();

    expect(mockAssignSessionToTreeGroup).not.toHaveBeenCalled();
    expect(mockConnectSession).toHaveBeenCalledWith("remote-session");
  });

  it("keeps the legacy follow-up assignment when create-stream omits group metadata", async () => {
    queuePendingSession({
      backend: "claude",
      createOpts: { cwd: "/repo", treeGroupId: "team-alpha" },
      cwd: "/repo",
      treeGroupId: "team-alpha",
    });
    await waitForCreationToSettle();

    expect(mockAssignSessionToTreeGroup).toHaveBeenCalledWith("remote-session", "team-alpha");
  });
});
