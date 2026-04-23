// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SHORTCUT_SETTINGS,
  formatShortcut,
  getMatchingShortcutAction,
  getShortcutHint,
  performShortcutAction,
} from "./shortcuts.js";

describe("shortcuts", () => {
  it("stays disabled by default", () => {
    expect(getMatchingShortcutAction(DEFAULT_SHORTCUT_SETTINGS, { key: "f", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(getShortcutHint(DEFAULT_SHORTCUT_SETTINGS, "search_session", "MacIntel")).toBeNull();
  });

  it("matches preset bindings when enabled", () => {
    const action = getMatchingShortcutAction(
      { enabled: true, preset: "vscode-light", overrides: {} },
      { key: "`", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
    );

    expect(action).toBe("toggle_terminal");
    expect(formatShortcut("Ctrl+`", "MacIntel")).toBe("Ctrl+`");
  });

  it("opens terminal and returns from terminal with the same action", () => {
    const openTerminal = vi.fn();
    const navigateTo = vi.fn();
    const navigateToSession = vi.fn();
    const navigateToMostRecentSession = vi.fn().mockReturnValue(true);
    const setActiveTab = vi.fn();

    const opened = performShortcutAction("toggle_terminal", {
      route: { page: "session", sessionId: "s1" },
      currentSessionId: "s1",
      currentSessionCwd: "/repo",
      terminalCwd: null,
      activeTab: "chat",
      isSearchOpen: false,
      sessions: [{ sessionId: "s1", createdAt: 1 }],
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      openNewSessionModal: vi.fn(),
      openTerminal,
      setActiveTab,
      navigateTo,
      navigateToSession,
      navigateToMostRecentSession,
    });

    expect(opened).toBe(true);
    expect(openTerminal).toHaveBeenCalledWith("/repo");
    expect(navigateTo).toHaveBeenCalledWith("/terminal");

    const returned = performShortcutAction("toggle_terminal", {
      route: { page: "terminal" },
      currentSessionId: "s1",
      currentSessionCwd: "/repo",
      terminalCwd: "/repo",
      activeTab: "chat",
      isSearchOpen: false,
      sessions: [{ sessionId: "s1", createdAt: 1 }],
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      openNewSessionModal: vi.fn(),
      openTerminal,
      setActiveTab,
      navigateTo,
      navigateToSession,
      navigateToMostRecentSession,
    });

    expect(returned).toBe(true);
    expect(navigateToSession).toHaveBeenCalledWith("s1");
    expect(setActiveTab).toHaveBeenCalledWith("chat");
  });

  it("wraps between active sessions", () => {
    const navigateToSession = vi.fn();

    const handled = performShortcutAction("next_session", {
      route: { page: "session", sessionId: "s2" },
      currentSessionId: "s2",
      currentSessionCwd: "/repo",
      terminalCwd: null,
      activeTab: "chat",
      isSearchOpen: false,
      sessions: [
        { sessionId: "s1", createdAt: 3 },
        { sessionId: "s2", createdAt: 2 },
        { sessionId: "s3", createdAt: 1, archived: true },
      ],
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      openNewSessionModal: vi.fn(),
      openTerminal: vi.fn(),
      setActiveTab: vi.fn(),
      navigateTo: vi.fn(),
      navigateToSession,
      navigateToMostRecentSession: vi.fn().mockReturnValue(true),
    });

    expect(handled).toBe(true);
    expect(navigateToSession).toHaveBeenCalledWith("s1");
  });

  it("matches the standard preset shifted bracket session navigation bindings", () => {
    const previousAction = getMatchingShortcutAction(
      { enabled: true, preset: "standard", overrides: {} },
      { key: "{", code: "BracketLeft", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
    );
    const nextAction = getMatchingShortcutAction(
      { enabled: true, preset: "standard", overrides: {} },
      { key: "}", code: "BracketRight", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
    );

    expect(previousAction).toBe("previous_session");
    expect(nextAction).toBe("next_session");
  });
});
