// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseHash,
  sessionHash,
  navigateToSession,
  navigateHome,
  navigateToMostRecentSession,
  questIdFromHash,
  withQuestIdInHash,
  withoutQuestIdInHash,
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

describe("sessionHash", () => {
  it("builds hash for a session ID", () => {
    expect(sessionHash("abc123")).toBe("#/session/abc123");
  });

  it("builds hash for a UUID session ID", () => {
    expect(sessionHash("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("#/session/a1b2c3d4-e5f6-7890-abcd-ef1234567890");
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
