import { buildHerdGroupBadgeThemes, getHerdGroupLeaderId } from "./herd-group-theme.js";
import type { SessionItem } from "./project-grouping.js";

function makeSession(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: "session-1",
    model: "gpt-5-codex",
    cwd: "/repo",
    gitBranch: "main",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    status: "idle",
    sdkState: "connected",
    createdAt: 0,
    archived: false,
    backendType: "codex",
    repoRoot: "/repo",
    permCount: 0,
    ...overrides,
  };
}

describe("herd group theme helpers", () => {
  it("resolves leaders and workers to the leader session id", () => {
    expect(getHerdGroupLeaderId(makeSession({ id: "leader-1", isOrchestrator: true }))).toBe("leader-1");
    expect(getHerdGroupLeaderId(makeSession({ id: "worker-1", herdedBy: "leader-1" }))).toBe("leader-1");
    expect(getHerdGroupLeaderId(makeSession({ id: "solo-1" }))).toBeNull();
  });

  it("assigns consistent group themes independent of input order", () => {
    const sessions = [
      makeSession({ id: "leader-a", isOrchestrator: true, sessionNum: 4, createdAt: 4 }),
      makeSession({ id: "worker-a", herdedBy: "leader-a", sessionNum: 5, createdAt: 5 }),
      makeSession({ id: "leader-b", isOrchestrator: true, sessionNum: 10, createdAt: 10 }),
      makeSession({ id: "worker-b", herdedBy: "leader-b", sessionNum: 11, createdAt: 11 }),
      makeSession({ id: "leader-c", isOrchestrator: true, sessionNum: 12, createdAt: 12 }),
    ];

    const forward = buildHerdGroupBadgeThemes(sessions);
    const reversed = buildHerdGroupBadgeThemes([...sessions].reverse());

    expect(forward.get("leader-a")?.token).toBe(reversed.get("leader-a")?.token);
    expect(forward.get("leader-b")?.token).toBe(reversed.get("leader-b")?.token);
    expect(forward.get("leader-c")?.token).toBe(reversed.get("leader-c")?.token);
  });

  it("prefers distinct palette tokens across visible leader groups", () => {
    const themeMap = buildHerdGroupBadgeThemes([
      makeSession({ id: "leader-a", isOrchestrator: true, sessionNum: 1, createdAt: 1 }),
      makeSession({ id: "worker-a", herdedBy: "leader-a", sessionNum: 2, createdAt: 2 }),
      makeSession({ id: "leader-b", isOrchestrator: true, sessionNum: 3, createdAt: 3 }),
      makeSession({ id: "worker-b", herdedBy: "leader-b", sessionNum: 4, createdAt: 4 }),
      makeSession({ id: "leader-c", isOrchestrator: true, sessionNum: 5, createdAt: 5 }),
    ]);

    const tokens = ["leader-a", "leader-b", "leader-c"]
      .map((leaderId) => themeMap.get(leaderId)?.token)
      .filter((token): token is string => !!token);

    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
