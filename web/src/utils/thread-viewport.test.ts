// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  getFeedViewportKey,
  persistLeaderSelectedThreadKey,
  persistLeaderViewportPosition,
  readLeaderSelectedThreadKey,
  readLeaderViewportPosition,
} from "./thread-viewport.js";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
});

describe("leader session viewport storage", () => {
  it("persists selected thread state in server-scoped browser storage", () => {
    persistLeaderSelectedThreadKey("s1", "Q-941");

    expect(readLeaderSelectedThreadKey("s1")).toBe("q-941");
    expect(localStorage.getItem("test-server:cc-leader-session-view:s1")).toContain('"selectedThreadKey":"q-941"');
  });

  it("persists stable viewport anchors separately for Main, All Threads, and quest threads", () => {
    persistLeaderViewportPosition("s1", "main", {
      scrollTop: 100,
      scrollHeight: 800,
      isAtBottom: false,
      anchorTurnId: "turn-main",
      anchorOffsetTop: 12,
      lastSeenContentBottom: 760,
    });
    persistLeaderViewportPosition("s1", "all", {
      scrollTop: 200,
      scrollHeight: 900,
      isAtBottom: false,
      anchorTurnId: "turn-all",
      anchorOffsetTop: 24,
    });
    persistLeaderViewportPosition("s1", "q-941", {
      scrollTop: 300,
      scrollHeight: 1000,
      isAtBottom: true,
      anchorTurnId: "turn-quest",
      anchorOffsetTop: 36,
    });

    expect(readLeaderViewportPosition("s1", "main")?.anchorTurnId).toBe("turn-main");
    expect(readLeaderViewportPosition("s1", "all")?.anchorTurnId).toBe("turn-all");
    expect(readLeaderViewportPosition("s1", "q-941")?.anchorTurnId).toBe("turn-quest");
    expect(localStorage.getItem("test-server:cc-leader-session-view:s1")).toContain(getFeedViewportKey("s1", "all"));
  });

  it("ignores invalid selected thread keys instead of restoring stale arbitrary tabs", () => {
    persistLeaderSelectedThreadKey("s1", "not-a-thread");

    expect(readLeaderSelectedThreadKey("s1")).toBeNull();
    expect(localStorage.getItem("test-server:cc-leader-session-view:s1")).toBeNull();
  });
});
