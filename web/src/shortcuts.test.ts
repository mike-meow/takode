// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SHORTCUT_SETTINGS,
  formatShortcut,
  getMatchingShortcutAction,
  getShortcutHint,
  isAppGlobalShortcutAction,
  performShortcutAction,
  resolveShortcutNewSessionContext,
  shouldBlurVimEscape,
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

    expect(action).toBe("open_terminal");
    expect(formatShortcut("Ctrl+`", "MacIntel")).toBe("Ctrl+`");
  });

  it("opens terminal from a thread and returns to the thread from terminal", () => {
    const openTerminal = vi.fn();
    const navigateTo = vi.fn();
    const navigateToSession = vi.fn();
    const navigateToMostRecentSession = vi.fn().mockReturnValue(true);
    const setActiveTab = vi.fn();
    const focusGlobalSearch = vi.fn();
    const toggleSidebar = vi.fn();

    const opened = performShortcutAction("open_terminal", {
      route: { page: "session", sessionId: "s1" },
      currentSessionId: "s1",
      currentSessionCwd: "/repo",
      terminalCwd: null,
      activeTab: "chat",
      isSearchOpen: false,
      sessions: [{ sessionId: "s1", createdAt: 1 }],
      focusGlobalSearch,
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      lastNewSessionContext: null,
      openNewSessionModal: vi.fn(),
      openTerminal,
      toggleSidebar,
      setActiveTab,
      navigateTo,
      navigateToSession,
      navigateToMostRecentSession,
    });

    expect(opened).toBe(true);
    expect(openTerminal).toHaveBeenCalledWith("/repo", "s1");
    expect(navigateTo).toHaveBeenCalledWith("/terminal");

    const returned = performShortcutAction("open_terminal", {
      route: { page: "terminal" },
      currentSessionId: "s1",
      currentSessionCwd: "/repo",
      terminalCwd: "/repo",
      activeTab: "chat",
      isSearchOpen: false,
      sessions: [{ sessionId: "s1", createdAt: 1 }],
      focusGlobalSearch,
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      lastNewSessionContext: null,
      openNewSessionModal: vi.fn(),
      openTerminal,
      toggleSidebar,
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
        { sessionId: "s1", createdAt: 3, orderIndex: 0 },
        { sessionId: "s2", createdAt: 2, orderIndex: 1 },
        { sessionId: "s3", createdAt: 1, archived: true },
      ],
      focusGlobalSearch: vi.fn(),
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      lastNewSessionContext: null,
      openNewSessionModal: vi.fn(),
      openTerminal: vi.fn(),
      toggleSidebar: vi.fn(),
      setActiveTab: vi.fn(),
      navigateTo: vi.fn(),
      navigateToSession,
      navigateToMostRecentSession: vi.fn().mockReturnValue(true),
    });

    expect(handled).toBe(true);
    expect(navigateToSession).toHaveBeenCalledWith("s1");
  });

  it("follows sidebar order instead of createdAt order for previous and next session shortcuts", () => {
    const navigateToSession = vi.fn();
    const sessions = [
      { sessionId: "s-created-latest", createdAt: 300, orderIndex: 2 },
      { sessionId: "s-current", createdAt: 200, orderIndex: 0 },
      { sessionId: "s-middle", createdAt: 100, orderIndex: 1 },
    ];

    performShortcutAction("next_session", {
      route: { page: "session", sessionId: "s-current" },
      currentSessionId: "s-current",
      currentSessionCwd: "/repo",
      terminalCwd: null,
      activeTab: "chat",
      isSearchOpen: false,
      sessions,
      focusGlobalSearch: vi.fn(),
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      lastNewSessionContext: null,
      openNewSessionModal: vi.fn(),
      openTerminal: vi.fn(),
      toggleSidebar: vi.fn(),
      setActiveTab: vi.fn(),
      navigateTo: vi.fn(),
      navigateToSession,
      navigateToMostRecentSession: vi.fn().mockReturnValue(true),
    });

    expect(navigateToSession).toHaveBeenCalledWith("s-middle");
  });

  it("skips reviewer sessions when following sidebar order", () => {
    const navigateToSession = vi.fn();
    const sessions = [
      { sessionId: "leader", createdAt: 300, orderIndex: 0 },
      { sessionId: "reviewer-chip", createdAt: 250, orderIndex: null },
      { sessionId: "worker", createdAt: 200, orderIndex: 1 },
    ];

    performShortcutAction("next_session", {
      route: { page: "session", sessionId: "leader" },
      currentSessionId: "leader",
      currentSessionCwd: "/repo",
      terminalCwd: null,
      activeTab: "chat",
      isSearchOpen: false,
      sessions,
      focusGlobalSearch: vi.fn(),
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      lastNewSessionContext: null,
      openNewSessionModal: vi.fn(),
      openTerminal: vi.fn(),
      toggleSidebar: vi.fn(),
      setActiveTab: vi.fn(),
      navigateTo: vi.fn(),
      navigateToSession,
      navigateToMostRecentSession: vi.fn().mockReturnValue(true),
    });

    expect(navigateToSession).toHaveBeenCalledWith("worker");
    expect(navigateToSession).not.toHaveBeenCalledWith("reviewer-chip");
  });

  it("wraps next_session from the last visible non-reviewer to the first visible non-reviewer", () => {
    const navigateToSession = vi.fn();
    const sessions = [
      { sessionId: "leader", createdAt: 300, orderIndex: 0 },
      { sessionId: "reviewer-chip", createdAt: 250, orderIndex: null },
      { sessionId: "worker", createdAt: 200, orderIndex: 1 },
    ];

    performShortcutAction("next_session", {
      route: { page: "session", sessionId: "worker" },
      currentSessionId: "worker",
      currentSessionCwd: "/repo",
      terminalCwd: null,
      activeTab: "chat",
      isSearchOpen: false,
      sessions,
      focusGlobalSearch: vi.fn(),
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      lastNewSessionContext: null,
      openNewSessionModal: vi.fn(),
      openTerminal: vi.fn(),
      toggleSidebar: vi.fn(),
      setActiveTab: vi.fn(),
      navigateTo: vi.fn(),
      navigateToSession,
      navigateToMostRecentSession: vi.fn().mockReturnValue(true),
    });

    expect(navigateToSession).toHaveBeenCalledWith("leader");
    expect(navigateToSession).not.toHaveBeenCalledWith("reviewer-chip");
  });

  it("wraps previous_session from the first visible non-reviewer to the last visible non-reviewer", () => {
    const navigateToSession = vi.fn();
    const sessions = [
      { sessionId: "leader", createdAt: 300, orderIndex: 0 },
      { sessionId: "reviewer-chip", createdAt: 250, orderIndex: null },
      { sessionId: "worker", createdAt: 200, orderIndex: 1 },
    ];

    performShortcutAction("previous_session", {
      route: { page: "session", sessionId: "leader" },
      currentSessionId: "leader",
      currentSessionCwd: "/repo",
      terminalCwd: null,
      activeTab: "chat",
      isSearchOpen: false,
      sessions,
      focusGlobalSearch: vi.fn(),
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      lastNewSessionContext: null,
      openNewSessionModal: vi.fn(),
      openTerminal: vi.fn(),
      toggleSidebar: vi.fn(),
      setActiveTab: vi.fn(),
      navigateTo: vi.fn(),
      navigateToSession,
      navigateToMostRecentSession: vi.fn().mockReturnValue(true),
    });

    expect(navigateToSession).toHaveBeenCalledWith("worker");
    expect(navigateToSession).not.toHaveBeenCalledWith("reviewer-chip");
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

  it("runs the global search and sidebar toggle actions", () => {
    const focusGlobalSearch = vi.fn();
    const toggleSidebar = vi.fn();

    const searchHandled = performShortcutAction("global_search", {
      route: { page: "session", sessionId: "s1" },
      currentSessionId: "s1",
      currentSessionCwd: "/repo",
      terminalCwd: null,
      activeTab: "chat",
      isSearchOpen: false,
      sessions: [{ sessionId: "s1", createdAt: 1 }],
      focusGlobalSearch,
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      lastNewSessionContext: null,
      openNewSessionModal: vi.fn(),
      openTerminal: vi.fn(),
      toggleSidebar,
      setActiveTab: vi.fn(),
      navigateTo: vi.fn(),
      navigateToSession: vi.fn(),
      navigateToMostRecentSession: vi.fn().mockReturnValue(true),
    });
    const sidebarHandled = performShortcutAction("toggle_sidebar", {
      route: { page: "session", sessionId: "s1" },
      currentSessionId: "s1",
      currentSessionCwd: "/repo",
      terminalCwd: null,
      activeTab: "chat",
      isSearchOpen: false,
      sessions: [{ sessionId: "s1", createdAt: 1 }],
      focusGlobalSearch,
      openSearch: vi.fn(),
      closeSearch: vi.fn(),
      lastNewSessionContext: null,
      openNewSessionModal: vi.fn(),
      openTerminal: vi.fn(),
      toggleSidebar,
      setActiveTab: vi.fn(),
      navigateTo: vi.fn(),
      navigateToSession: vi.fn(),
      navigateToMostRecentSession: vi.fn().mockReturnValue(true),
    });

    expect(searchHandled).toBe(true);
    expect(sidebarHandled).toBe(true);
    expect(focusGlobalSearch).toHaveBeenCalledTimes(1);
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("marks global search and session switching as app-global shortcuts", () => {
    expect(isAppGlobalShortcutAction("global_search")).toBe(true);
    expect(isAppGlobalShortcutAction("previous_session")).toBe(true);
    expect(isAppGlobalShortcutAction("next_session")).toBe(true);
    expect(isAppGlobalShortcutAction("search_session")).toBe(false);
    expect(isAppGlobalShortcutAction("open_terminal")).toBe(false);
  });

  it("prefers the current session cwd when opening a new session", () => {
    expect(
      resolveShortcutNewSessionContext("/repo/current", {
        cwd: "/repo/old",
        treeGroupId: "frontend",
        newSessionDefaultsKey: "tree-group:frontend",
      }),
    ).toEqual({
      cwd: "/repo/current",
      treeGroupId: "frontend",
      newSessionDefaultsKey: "tree-group:frontend",
    });
  });

  it("only blurs editable targets on Escape in vim mode", () => {
    const input = document.createElement("input");
    expect(shouldBlurVimEscape({ enabled: true, preset: "vim-light", overrides: {} }, { key: "Escape" }, input)).toBe(
      true,
    );
    expect(shouldBlurVimEscape({ enabled: true, preset: "standard", overrides: {} }, { key: "Escape" }, input)).toBe(
      false,
    );
  });
});
