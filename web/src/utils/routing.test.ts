// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  absoluteUrlForHash,
  messageIdFromHash,
  messageIndexFromHash,
  parseHash,
  resolveSessionIdFromRoute,
  sessionHash,
  sessionMessageHash,
  scrollToMessageIndex,
  navigateToSession,
  navigateHome,
  navigateToMostRecentSession,
  questIdFromHash,
  withQuestIdInHash,
  withoutQuestIdInHash,
  playgroundSectionIdFromHash,
  withPlaygroundSectionInHash,
  withoutPlaygroundSectionInHash,
} from "./routing.js";
import { useStore } from "../store.js";

describe("parseHash", () => {
  it("returns home for empty string", () => {
    expect(parseHash("")).toEqual({ page: "home" });
  });

  it("returns home for bare hash", () => {
    expect(parseHash("#/")).toEqual({ page: "home" });
  });

  it("returns home for unknown routes", () => {
    expect(parseHash("#/unknown")).toEqual({ page: "home" });
  });

  it("parses settings route", () => {
    expect(parseHash("#/settings")).toEqual({ page: "settings" });
  });

  it("parses logs route", () => {
    // The dedicated log viewer lives at its own top-level route so settings deep-links stay stable.
    expect(parseHash("#/logs")).toEqual({ page: "logs" });
  });

  it("parses terminal route", () => {
    expect(parseHash("#/terminal")).toEqual({ page: "terminal" });
  });

  it("parses environments route", () => {
    expect(parseHash("#/environments")).toEqual({ page: "environments" });
  });

  it("parses scheduled route", () => {
    expect(parseHash("#/scheduled")).toEqual({ page: "scheduled" });
  });

  it("parses playground route", () => {
    expect(parseHash("#/playground")).toEqual({ page: "playground" });
  });

  it("parses questmaster route with query params", () => {
    expect(parseHash("#/questmaster?quest=q-67")).toEqual({ page: "questmaster" });
  });

  it("parses session route with UUID", () => {
    expect(parseHash("#/session/a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toEqual({
      page: "session",
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  it("parses session route with short ID", () => {
    expect(parseHash("#/session/abc123")).toEqual({
      page: "session",
      sessionId: "abc123",
    });
  });

  it("parses session route with query params", () => {
    expect(parseHash("#/session/abc123?quest=q-42")).toEqual({
      page: "session",
      sessionId: "abc123",
    });
  });

  it("parses session route with a stable message ID in the path", () => {
    expect(parseHash("#/session/123/msg/asst-42")).toEqual({
      page: "session",
      sessionId: "123",
      messageId: "asst-42",
    });
  });

  it("parses session route with a readable message index in the path", () => {
    expect(parseHash("#/session/123/msg/42")).toEqual({
      page: "session",
      sessionId: "123",
      messageIndex: 42,
    });
  });

  it("returns home for session route with empty ID", () => {
    // #/session/ with no ID should be treated as home
    expect(parseHash("#/session/")).toEqual({ page: "home" });
  });
});

describe("quest hash helpers", () => {
  it("extracts quest ID from any route query", () => {
    expect(questIdFromHash("#/session/s1?quest=q-42")).toBe("q-42");
    expect(questIdFromHash("#/questmaster?quest=q-8")).toBe("q-8");
    expect(questIdFromHash("#/session/s1?quest=oops")).toBeNull();
  });

  it("adds quest query while preserving existing route and params", () => {
    expect(withQuestIdInHash("#/session/s1", "q-12")).toBe("#/session/s1?quest=q-12");
    expect(withQuestIdInHash("#/session/s1?foo=1", "q-12")).toBe("#/session/s1?foo=1&quest=q-12");
  });

  it("removes quest query while preserving other params", () => {
    expect(withoutQuestIdInHash("#/session/s1?foo=1&quest=q-12&bar=2")).toBe("#/session/s1?foo=1&bar=2");
    expect(withoutQuestIdInHash("#/session/s1?quest=q-12")).toBe("#/session/s1");
  });
});

describe("playground hash helpers", () => {
  it("extracts the playground section from the route query", () => {
    expect(playgroundSectionIdFromHash("#/playground?section=states-timer-messages")).toBe("states-timer-messages");
    expect(playgroundSectionIdFromHash("#/playground?section=interactive-composer&foo=1")).toBe("interactive-composer");
    expect(playgroundSectionIdFromHash("#/session/s1?section=states-timer-messages")).toBeNull();
  });

  it("adds the playground section query while preserving the route and existing params", () => {
    expect(withPlaygroundSectionInHash("#/playground", "states-timer-messages")).toBe(
      "#/playground?section=states-timer-messages",
    );
    expect(withPlaygroundSectionInHash("#/playground?foo=1", "interactive-composer")).toBe(
      "#/playground?foo=1&section=interactive-composer",
    );
  });

  it("removes the playground section query while preserving other params", () => {
    expect(withoutPlaygroundSectionInHash("#/playground?foo=1&section=states-timer-messages&bar=2")).toBe(
      "#/playground?foo=1&bar=2",
    );
    expect(withoutPlaygroundSectionInHash("#/playground?section=states-timer-messages")).toBe("#/playground");
  });
});

describe("sessionHash", () => {
  it("builds hash for a session ID", () => {
    expect(sessionHash("abc123")).toBe("#/session/abc123");
  });

  it("builds hash for a UUID session ID", () => {
    expect(sessionHash("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("#/session/a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("builds hash for a session number", () => {
    expect(sessionHash(123)).toBe("#/session/123");
  });
});

describe("sessionMessageHash", () => {
  it("builds a readable message-index path under the session route", () => {
    expect(sessionMessageHash(123, 42)).toBe("#/session/123/msg/42");
  });
});

describe("messageIdFromHash", () => {
  it("reads the stable message ID from the session path", () => {
    expect(messageIdFromHash("#/session/123/msg/asst-42")).toBe("asst-42");
    expect(messageIdFromHash("#/session/123/msg/42")).toBeNull();
    expect(messageIdFromHash("#/session/123?msg=42")).toBeNull();
  });
});

describe("messageIndexFromHash", () => {
  it("reads the readable message index from the session path", () => {
    expect(messageIndexFromHash("#/session/123/msg/42")).toBe(42);
  });

  it("falls back to the legacy query parameter", () => {
    expect(messageIndexFromHash("#/session/123?msg=42")).toBe(42);
  });

  it("ignores opaque message IDs", () => {
    expect(messageIndexFromHash("#/session/123/msg/asst-42")).toBeNull();
  });
});

describe("scrollToMessageIndex", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("resolves readable indexes against raw messageHistory indexes before rendered array positions", () => {
    // Rendered position 1 corresponds to raw messageHistory index 2 when
    // messageHistory[1] was a non-rendered tool_result_preview.
    useStore.getState().setMessages("s1", [
      { id: "u0", role: "user", content: "Prompt", timestamp: 100, historyIndex: 0 },
      { id: "a2", role: "assistant", content: "Answer", timestamp: 200, historyIndex: 2 },
    ]);

    scrollToMessageIndex("s1", 2);

    expect(useStore.getState().scrollToMessageId.get("s1")).toBe("a2");
    expect(useStore.getState().expandAllInTurn.get("s1")).toBe("a2");
  });
});

describe("resolveSessionIdFromRoute", () => {
  it("passes through UUID-style session IDs", () => {
    expect(resolveSessionIdFromRoute("session-abc", [])).toBe("session-abc");
  });

  it("resolves numeric session routes through sdk session numbers", () => {
    expect(
      resolveSessionIdFromRoute("123", [
        { sessionId: "session-abc", createdAt: 1, state: "connected", cwd: "/repo", sessionNum: 123 },
      ]),
    ).toBe("session-abc");
  });

  it("returns null when a numeric session route cannot be resolved", () => {
    expect(resolveSessionIdFromRoute("123", [])).toBeNull();
  });
});

describe("absoluteUrlForHash", () => {
  it("preserves the current server origin and pathname while swapping the hash", () => {
    history.replaceState(null, "", "/takode?foo=1#/session/s1");
    expect(absoluteUrlForHash("#/session/123/msg/asst-42")).toBe(
      "http://localhost:3000/takode?foo=1#/session/123/msg/asst-42",
    );
  });
});

describe("navigateToSession", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("sets hash to session route", () => {
    navigateToSession("test-id");
    expect(window.location.hash).toBe("#/session/test-id");
  });

  it("uses replaceState when replace=true", () => {
    const spy = vi.spyOn(history, "replaceState");
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    navigateToSession("test-id", true);
    expect(spy).toHaveBeenCalledWith(null, "", "#/session/test-id");
    // Should dispatch hashchange since replaceState doesn't trigger it natively
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(HashChangeEvent));
    spy.mockRestore();
    dispatchSpy.mockRestore();
  });
});

describe("navigateHome", () => {
  beforeEach(() => {
    window.location.hash = "#/session/test";
  });

  it("clears the hash", () => {
    navigateHome();
    // After clearing, hash is empty string (browser may keep "#" or "")
    expect(window.location.hash === "" || window.location.hash === "#").toBe(true);
  });

  it("uses replaceState when replace=true", () => {
    const spy = vi.spyOn(history, "replaceState");
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    navigateHome(true);
    expect(spy).toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(HashChangeEvent));
    spy.mockRestore();
    dispatchSpy.mockRestore();
  });
});

describe("navigateToMostRecentSession", () => {
  beforeEach(() => {
    window.location.hash = "";
    useStore.setState({ sdkSessions: [] });
  });

  it("navigates to the most recent non-archived session", () => {
    useStore.setState({
      sdkSessions: [
        { sessionId: "old", createdAt: 1000, archived: false } as any,
        { sessionId: "new", createdAt: 2000, archived: false } as any,
      ],
    });

    const result = navigateToMostRecentSession();

    expect(result).toBe(true);
    expect(window.location.hash).toBe("#/session/new");
  });

  it("skips archived sessions", () => {
    useStore.setState({
      sdkSessions: [
        { sessionId: "active", createdAt: 1000, archived: false } as any,
        { sessionId: "archived", createdAt: 2000, archived: true } as any,
      ],
    });

    const result = navigateToMostRecentSession();

    expect(result).toBe(true);
    expect(window.location.hash).toBe("#/session/active");
  });

  it("skips cron job sessions", () => {
    useStore.setState({
      sdkSessions: [
        { sessionId: "regular", createdAt: 1000, archived: false } as any,
        { sessionId: "cron", createdAt: 2000, archived: false, cronJobId: "cron-1" } as any,
      ],
    });

    const result = navigateToMostRecentSession();

    expect(result).toBe(true);
    expect(window.location.hash).toBe("#/session/regular");
  });

  it("excludes the specified session ID", () => {
    useStore.setState({
      sdkSessions: [
        { sessionId: "keep", createdAt: 1000, archived: false } as any,
        { sessionId: "exclude", createdAt: 2000, archived: false } as any,
      ],
    });

    const result = navigateToMostRecentSession({ excludeId: "exclude" });

    expect(result).toBe(true);
    expect(window.location.hash).toBe("#/session/keep");
  });

  it("falls back to home when no sessions exist", () => {
    useStore.setState({ sdkSessions: [] });

    const result = navigateToMostRecentSession();

    expect(result).toBe(false);
    expect(window.location.hash === "" || window.location.hash === "#").toBe(true);
  });

  it("falls back to home when all sessions are archived", () => {
    useStore.setState({
      sdkSessions: [{ sessionId: "a", createdAt: 1000, archived: true } as any],
    });

    const result = navigateToMostRecentSession();

    expect(result).toBe(false);
  });
});
