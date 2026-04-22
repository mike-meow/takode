import { create } from "zustand";
import type {
  SessionState,
  PermissionRequest,
  ChatMessage,
  SdkSessionInfo,
  TaskItem,
  McpServerDetail,
  ToolResultPreview,
  SessionTaskEntry,
  HistoryWindowState,
  PendingCodexInput,
  PendingUserUpload,
  QuestmasterTask,
  VsCodeSelectionState,
} from "./types.js";
import { api, type PRStatusResponse, type CreationProgressEvent, type CreateSessionOpts } from "./api.js";
import type { BoardRowData } from "./components/BoardTable.js";
import {
  reconcileQuestList,
  sdkSessionListEqual,
  sessionTaskHistoryEqual,
  stringArrayEqual,
} from "./store-equality.js";
import {
  computeSessionSearchMatches,
  DEFAULT_SEARCH_STATE,
  getSessionSearchState,
  type SearchMatch,
  type SessionSearchCategory,
  type SessionSearchState,
} from "./store-session-search.js";
import {
  getInitialCollapsedSet,
  getInitialColorTheme,
  getInitialDarkMode,
  getInitialNotificationDesktop,
  getInitialNotificationSound,
  getInitialSessionId,
  getInitialSessionNames,
  getInitialZoomLevel,
} from "./store-initial.js";
import type { AppState, PendingSession } from "./store-types.js";
import { isDesktopShellLayout } from "./utils/layout.js";

// ─── Color Themes ───────────────────────────────────────────────────────────

/** Available color themes. All non-"light" themes are dark variants. */
export type ColorTheme = "light" | "dark" | "vscode-dark";

export const COLOR_THEMES: { id: ColorTheme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "vscode-dark", label: "VS Code" },
];

export function isDarkTheme(theme: ColorTheme): boolean {
  return theme !== "light";
}

// ─── Pending Session (client-only, pre-creation) ────────────────────────────

import { scopedGetItem, scopedSetItem, scopedRemoveItem } from "./utils/scoped-storage.js";

export { reconcileQuestList, getSessionSearchState, computeSessionSearchMatches };
export type { SearchMatch, SessionSearchCategory, SessionSearchState };
export type { PendingSession };

const TOOL_PROGRESS_OUTPUT_LIMIT = 12_000;

function shouldPauseQuestBackgroundRefresh(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

const QUEST_BACKGROUND_REFRESH_MIN_INTERVAL_MS = 2_000;
let pendingQuestBackgroundRefresh: Promise<void> | null = null;
let lastQuestBackgroundRefreshAt = 0;

export function resetQuestRefreshStateForTests(): void {
  pendingQuestBackgroundRefresh = null;
  lastQuestBackgroundRefreshAt = 0;
}

export const useStore = create<AppState>((set) => ({
  sessions: new Map(),
  sdkSessions: [],
  currentSessionId: getInitialSessionId(),
  messages: new Map(),
  messageFrozenCounts: new Map(),
  messageFrozenHashes: new Map(),
  messageFrozenRevisions: new Map(),
  historyLoading: new Map(),
  historyWindows: new Map(),
  streaming: new Map(),
  streamingByParentToolUseId: new Map(),
  streamingThinking: new Map(),
  streamingThinkingByParentToolUseId: new Map(),
  streamingStartedAt: new Map(),
  streamingOutputTokens: new Map(),
  streamingPausedDuration: new Map(),
  streamingPauseStartedAt: new Map(),
  pendingPermissions: new Map(),
  connectionStatus: new Map(),
  cliConnected: new Map(),
  cliEverConnected: new Map(),
  cliDisconnectReason: new Map(),
  sessionStatus: new Map(),
  sessionStuck: new Map(),
  previousPermissionMode: new Map(),
  askPermission: new Map(),
  sessionTasks: new Map(),
  sessionTimers: new Map(),
  setSessionTimers: (sessionId, timers) =>
    set((s) => {
      const next = new Map(s.sessionTimers);
      if (timers.length === 0) next.delete(sessionId);
      else next.set(sessionId, timers);
      return { sessionTimers: next };
    }),
  sessionNotifications: new Map(),
  setSessionNotifications: (sessionId, notifications) =>
    set((s) => {
      const next = new Map(s.sessionNotifications);
      if (notifications.length === 0) next.delete(sessionId);
      else next.set(sessionId, notifications);
      return { sessionNotifications: next };
    }),
  changedFiles: new Map(),
  diffFileStats: new Map(),
  sessionNames: getInitialSessionNames(),
  recentlyRenamed: new Set(),
  questNamedSessions: new Set(),
  sessionPreviews: new Map(),
  sessionPreviewUpdatedAt: new Map(),
  sessionTaskHistory: new Map(),
  pendingCodexInputs: new Map(),
  sessionKeywords: new Map(),
  sessionSearch: new Map(),
  scrollToTurnId: new Map(),
  scrollToMessageId: new Map(),
  expandAllInTurn: new Map(),
  pendingScrollToMessageIndex: new Map(),
  bottomAlignNextUserMessage: new Set(),
  activeTaskTurnId: new Map(),
  sessionTaskPreview: new Map(),
  prStatus: new Map(),
  mcpServers: new Map(),
  toolProgress: new Map(),
  toolResults: new Map(),
  latestBoardToolUseId: new Map(),
  setLatestBoardToolUseId: (sessionId, toolUseId) =>
    set((s) => {
      const next = new Map(s.latestBoardToolUseId);
      next.set(sessionId, toolUseId);
      return { latestBoardToolUseId: next };
    }),
  sessionBoards: new Map(),
  setSessionBoard: (sessionId, board) =>
    set((s) => {
      const next = new Map(s.sessionBoards);
      next.set(sessionId, board);
      return { sessionBoards: next };
    }),
  sessionCompletedBoards: new Map(),
  setSessionCompletedBoard: (sessionId, board) =>
    set((s) => {
      const next = new Map(s.sessionCompletedBoards);
      next.set(sessionId, board);
      return { sessionCompletedBoards: next };
    }),
  backgroundAgentNotifs: new Map(),
  toolStartTimestamps: new Map(),
  sessionAttention: new Map(),
  treeGroups: [],
  treeAssignments: new Map(),
  treeNodeOrder: new Map(),
  collapsedTreeGroups: getInitialCollapsedSet("cc-collapsed-tree-groups"),
  collapsedTreeNodes: getInitialCollapsedSet("cc-collapsed-tree-nodes"),
  expandedHerdNodes: getInitialCollapsedSet("cc-expanded-herd-nodes"),
  quests: [],
  questsLoading: false,
  setQuests: (quests) =>
    set((state) => {
      const nextQuests = reconcileQuestList(state.quests, quests);
      return nextQuests === state.quests ? {} : { quests: nextQuests };
    }),
  replaceQuest: (updated) => {
    set((state) => {
      const quests = state.quests
        .map((q) => (q.questId === updated.questId ? updated : q))
        .sort((a, b) => b.createdAt - a.createdAt);
      const nextQuests = reconcileQuestList(state.quests, quests);
      return nextQuests === state.quests ? {} : { quests: nextQuests };
    });
  },
  refreshQuests: async (opts) => {
    if (opts?.background) {
      if (shouldPauseQuestBackgroundRefresh()) return;
      if (!opts.force && pendingQuestBackgroundRefresh) return pendingQuestBackgroundRefresh;
      if (!opts.force && Date.now() - lastQuestBackgroundRefreshAt < QUEST_BACKGROUND_REFRESH_MIN_INTERVAL_MS) return;
      lastQuestBackgroundRefreshAt = Date.now();
      const refreshPromise = (async () => {
        try {
          const quests = await api.listQuests();
          set((state) => {
            const nextQuests = reconcileQuestList(state.quests, quests);
            return nextQuests === state.quests ? {} : { quests: nextQuests };
          });
        } catch {
          // Ignore background refresh failures and keep the current quest snapshot.
        }
      })();
      const trackedRefresh = refreshPromise.finally(() => {
        if (pendingQuestBackgroundRefresh === trackedRefresh) {
          pendingQuestBackgroundRefresh = null;
        }
      });
      pendingQuestBackgroundRefresh = trackedRefresh;
      return trackedRefresh;
    }

    if (!opts?.background) set({ questsLoading: true });
    try {
      const quests = await api.listQuests();
      set((state) => {
        const nextQuests = reconcileQuestList(state.quests, quests);
        if (nextQuests === state.quests && !state.questsLoading) return {};
        return { quests: nextQuests, questsLoading: false };
      });
    } catch {
      set({ questsLoading: false });
    }
  },
  pendingSessions: new Map(),
  serverName: "",
  setServerName: (name) => set({ serverName: name }),
  serverReachable: true,
  setServerReachable: (reachable) => set({ serverReachable: reachable }),
  serverRestarting: false,
  setServerRestarting: (v) => set({ serverRestarting: v }),
  colorTheme: getInitialColorTheme(),
  darkMode: getInitialDarkMode(),
  zoomLevel: getInitialZoomLevel(),
  notificationSound: getInitialNotificationSound(),
  notificationDesktop: getInitialNotificationDesktop(),
  showUsageBars: typeof window !== "undefined" ? scopedGetItem("cc-show-usage") !== "false" : true,
  sidebarOpen: typeof window !== "undefined" ? isDesktopShellLayout(getInitialZoomLevel()) : true,
  sessionInfoOpenSessionId: null,
  reorderMode: false,
  sessionSortMode:
    typeof window !== "undefined" && localStorage.getItem("cc-session-sort-mode") === "activity"
      ? "activity"
      : "created",
  taskPanelOpen: false,
  newSessionModalState: null,
  questOverlayId: null,
  questOverlaySearchHighlight: null,
  activeTab: "chat",
  diffPanelSelectedFile: new Map(),
  vscodeSelectionContext: null,
  dismissedVsCodeSelectionKey: null,
  feedScrollPosition: new Map(),
  composerDrafts: new Map(),
  pendingUserUploads: new Map(),
  replyContexts: new Map(),
  focusComposerTrigger: 0,
  turnActivityOverrides: new Map(),
  autoExpandedTurnIds: new Map(),
  collapsibleTurnIds: new Map(),
  terminalOpen: false,
  terminalCwd: null,
  terminalId: null,

  addPendingSession: (session) =>
    set((state) => {
      const next = new Map(state.pendingSessions);
      next.set(session.id, session);
      return { pendingSessions: next };
    }),
  updatePendingSession: (id, updates) =>
    set((state) => {
      const existing = state.pendingSessions.get(id);
      if (!existing) return {};
      const next = new Map(state.pendingSessions);
      next.set(id, { ...existing, ...updates });
      return { pendingSessions: next };
    }),
  addPendingProgress: (id, step) =>
    set((state) => {
      const existing = state.pendingSessions.get(id);
      if (!existing) return {};
      const progress = [...existing.progress];
      const idx = progress.findIndex((s) => s.step === step.step);
      if (idx >= 0) {
        progress[idx] = step;
      } else {
        progress.push(step);
      }
      const next = new Map(state.pendingSessions);
      next.set(id, { ...existing, progress });
      return { pendingSessions: next };
    }),
  removePendingSession: (id) =>
    set((state) => {
      const next = new Map(state.pendingSessions);
      next.delete(id);
      return { pendingSessions: next };
    }),

  setColorTheme: (theme) => {
    localStorage.setItem("cc-color-theme", theme);
    localStorage.setItem("cc-dark-mode", String(isDarkTheme(theme)));
    set({ colorTheme: theme, darkMode: isDarkTheme(theme) });
  },
  setDarkMode: (v) => {
    const theme = v ? "dark" : "light";
    localStorage.setItem("cc-color-theme", theme);
    localStorage.setItem("cc-dark-mode", String(v));
    set({ colorTheme: theme, darkMode: v });
  },
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      const theme: ColorTheme = next ? "dark" : "light";
      localStorage.setItem("cc-color-theme", theme);
      localStorage.setItem("cc-dark-mode", String(next));
      return { colorTheme: theme, darkMode: next };
    }),
  setZoomLevel: (v) => {
    const clamped = Math.round(Math.max(0.2, Math.min(4.0, v)) * 100) / 100;
    localStorage.setItem("cc-zoom-level", String(clamped));
    set({ zoomLevel: clamped });
  },
  setNotificationSound: (v) => {
    localStorage.setItem("cc-notification-sound", String(v));
    set({ notificationSound: v });
  },
  toggleNotificationSound: () =>
    set((s) => {
      const next = !s.notificationSound;
      localStorage.setItem("cc-notification-sound", String(next));
      return { notificationSound: next };
    }),
  setNotificationDesktop: (v) => {
    localStorage.setItem("cc-notification-desktop", String(v));
    set({ notificationDesktop: v });
  },
  toggleNotificationDesktop: () =>
    set((s) => {
      const next = !s.notificationDesktop;
      localStorage.setItem("cc-notification-desktop", String(next));
      return { notificationDesktop: next };
    }),
  setShowUsageBars: (v) => {
    scopedSetItem("cc-show-usage", String(v));
    set({ showUsageBars: v });
  },
  toggleShowUsageBars: () =>
    set((s) => {
      const next = !s.showUsageBars;
      scopedSetItem("cc-show-usage", String(next));
      return { showUsageBars: next };
    }),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setSessionInfoOpenSessionId: (sessionId) => set({ sessionInfoOpenSessionId: sessionId }),
  setReorderMode: (v) => set({ reorderMode: v }),
  setSessionSortMode: (mode) => {
    localStorage.setItem("cc-session-sort-mode", mode);
    set({ sessionSortMode: mode });
  },
  setTaskPanelOpen: (open) => set({ taskPanelOpen: open }),
  openNewSessionModal: (opts) => set({ newSessionModalState: opts ?? {} }),
  closeNewSessionModal: () => set({ newSessionModalState: null }),
  openQuestOverlay: (questId, searchHighlight) =>
    set({ questOverlayId: questId, questOverlaySearchHighlight: searchHighlight ?? null }),
  closeQuestOverlay: () => set({ questOverlayId: null, questOverlaySearchHighlight: null }),
  setVsCodeSelectionContext: (context) => set({ vscodeSelectionContext: context }),
  dismissVsCodeSelection: (key) => set({ dismissedVsCodeSelectionKey: key }),
  newSession: () => {
    scopedRemoveItem("cc-current-session");
    set({ currentSessionId: null });
  },

  setCurrentSession: (id) => {
    // Don't persist pending session IDs to localStorage — they're in-memory only
    // and would cause "Session not found" on page refresh
    if (id && !id.startsWith("pending-")) {
      scopedSetItem("cc-current-session", id);
    } else if (!id) {
      scopedRemoveItem("cc-current-session");
    }
    set({ currentSessionId: id, questOverlayId: null, questOverlaySearchHighlight: null });
  },

  addSession: (session) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(session.session_id, session);
      const messages = new Map(s.messages);
      if (!messages.has(session.session_id)) messages.set(session.session_id, []);
      const messageFrozenCounts = new Map(s.messageFrozenCounts);
      if (!messageFrozenCounts.has(session.session_id)) messageFrozenCounts.set(session.session_id, 0);
      const messageFrozenHashes = new Map(s.messageFrozenHashes);
      const messageFrozenRevisions = new Map(s.messageFrozenRevisions);
      if (!messageFrozenRevisions.has(session.session_id)) messageFrozenRevisions.set(session.session_id, 0);
      return { sessions, messages, messageFrozenCounts, messageFrozenHashes, messageFrozenRevisions };
    }),

  updateSession: (sessionId, updates) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      const existing = sessions.get(sessionId);
      if (existing) sessions.set(sessionId, { ...existing, ...updates });
      return { sessions };
    }),

  removeSession: (sessionId) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.delete(sessionId);
      const messages = new Map(s.messages);
      messages.delete(sessionId);
      const messageFrozenCounts = new Map(s.messageFrozenCounts);
      messageFrozenCounts.delete(sessionId);
      const messageFrozenHashes = new Map(s.messageFrozenHashes);
      messageFrozenHashes.delete(sessionId);
      const messageFrozenRevisions = new Map(s.messageFrozenRevisions);
      messageFrozenRevisions.delete(sessionId);
      const historyLoading = new Map(s.historyLoading);
      historyLoading.delete(sessionId);
      const historyWindows = new Map(s.historyWindows);
      historyWindows.delete(sessionId);
      const streaming = new Map(s.streaming);
      streaming.delete(sessionId);
      const streamingByParentToolUseId = new Map(s.streamingByParentToolUseId);
      streamingByParentToolUseId.delete(sessionId);
      const streamingThinking = new Map(s.streamingThinking);
      streamingThinking.delete(sessionId);
      const streamingThinkingByParentToolUseId = new Map(s.streamingThinkingByParentToolUseId);
      streamingThinkingByParentToolUseId.delete(sessionId);
      const streamingStartedAt = new Map(s.streamingStartedAt);
      streamingStartedAt.delete(sessionId);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      streamingOutputTokens.delete(sessionId);
      const streamingPausedDuration = new Map(s.streamingPausedDuration);
      streamingPausedDuration.delete(sessionId);
      const streamingPauseStartedAt = new Map(s.streamingPauseStartedAt);
      streamingPauseStartedAt.delete(sessionId);
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.delete(sessionId);
      const cliConnected = new Map(s.cliConnected);
      cliConnected.delete(sessionId);
      const cliEverConnected = new Map(s.cliEverConnected);
      cliEverConnected.delete(sessionId);
      const cliDisconnectReason = new Map(s.cliDisconnectReason);
      cliDisconnectReason.delete(sessionId);
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.delete(sessionId);
      const sessionStuck = new Map(s.sessionStuck);
      sessionStuck.delete(sessionId);
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.delete(sessionId);
      const askPermission = new Map(s.askPermission);
      askPermission.delete(sessionId);
      const pendingPermissions = new Map(s.pendingPermissions);
      pendingPermissions.delete(sessionId);
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.delete(sessionId);
      const sessionTimers = new Map(s.sessionTimers);
      sessionTimers.delete(sessionId);
      const sessionNotifications = new Map(s.sessionNotifications);
      sessionNotifications.delete(sessionId);
      const changedFiles = new Map(s.changedFiles);
      changedFiles.delete(sessionId);
      const diffFileStats = new Map(s.diffFileStats);
      diffFileStats.delete(sessionId);
      const sessionNames = new Map(s.sessionNames);
      sessionNames.delete(sessionId);
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.delete(sessionId);
      const sessionPreviews = new Map(s.sessionPreviews);
      sessionPreviews.delete(sessionId);
      const sessionTaskHistory = new Map(s.sessionTaskHistory);
      sessionTaskHistory.delete(sessionId);
      const pendingCodexInputs = new Map(s.pendingCodexInputs);
      pendingCodexInputs.delete(sessionId);
      const sessionKeywords = new Map(s.sessionKeywords);
      sessionKeywords.delete(sessionId);
      const scrollToTurnId = new Map(s.scrollToTurnId);
      scrollToTurnId.delete(sessionId);
      const diffPanelSelectedFile = new Map(s.diffPanelSelectedFile);
      diffPanelSelectedFile.delete(sessionId);
      const mcpServers = new Map(s.mcpServers);
      mcpServers.delete(sessionId);
      const toolProgress = new Map(s.toolProgress);
      toolProgress.delete(sessionId);
      const toolResults = new Map(s.toolResults);
      toolResults.delete(sessionId);
      const backgroundAgentNotifs = new Map(s.backgroundAgentNotifs);
      backgroundAgentNotifs.delete(sessionId);
      const toolStartTimestamps = new Map(s.toolStartTimestamps);
      toolStartTimestamps.delete(sessionId);
      const prStatus = new Map(s.prStatus);
      prStatus.delete(sessionId);
      const feedScrollPosition = new Map(s.feedScrollPosition);
      feedScrollPosition.delete(sessionId);
      const composerDrafts = new Map(s.composerDrafts);
      composerDrafts.delete(sessionId);
      const replyContexts = new Map(s.replyContexts);
      replyContexts.delete(sessionId);
      const turnActivityOverrides = new Map(s.turnActivityOverrides);
      turnActivityOverrides.delete(sessionId);
      const autoExpandedTurnIds = new Map(s.autoExpandedTurnIds);
      autoExpandedTurnIds.delete(sessionId);
      const collapsibleTurnIds = new Map(s.collapsibleTurnIds);
      collapsibleTurnIds.delete(sessionId);
      const sessionAttention = new Map(s.sessionAttention);
      sessionAttention.delete(sessionId);
      const sessionInfoOpenSessionId = s.sessionInfoOpenSessionId === sessionId ? null : s.sessionInfoOpenSessionId;
      scopedSetItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      if (s.currentSessionId === sessionId) {
        scopedRemoveItem("cc-current-session");
      }
      return {
        sessions,
        messages,
        messageFrozenCounts,
        messageFrozenHashes,
        messageFrozenRevisions,
        historyLoading,
        historyWindows,
        streaming,
        streamingByParentToolUseId,
        streamingThinking,
        streamingThinkingByParentToolUseId,
        streamingStartedAt,
        streamingOutputTokens,
        streamingPausedDuration,
        streamingPauseStartedAt,
        connectionStatus,
        cliConnected,
        cliEverConnected,
        cliDisconnectReason,
        sessionStatus,
        sessionStuck,
        previousPermissionMode,
        askPermission,
        pendingPermissions,
        sessionTasks,
        sessionTimers,
        sessionNotifications,
        changedFiles,
        diffFileStats,
        sessionNames,
        recentlyRenamed,
        sessionPreviews,
        sessionTaskHistory,
        pendingCodexInputs,
        sessionKeywords,
        scrollToTurnId,
        diffPanelSelectedFile,
        mcpServers,
        toolProgress,
        toolResults,
        backgroundAgentNotifs,
        toolStartTimestamps,
        prStatus,
        feedScrollPosition,
        composerDrafts,
        replyContexts,
        turnActivityOverrides,
        autoExpandedTurnIds,
        collapsibleTurnIds,
        sessionAttention,
        sessionInfoOpenSessionId,
        sdkSessions: s.sdkSessions.filter((sdk) => sdk.sessionId !== sessionId),
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      };
    }),

  setSdkSessions: (sessions) =>
    set((s) => {
      const currentSessionId = s.currentSessionId;
      const sdkSessionsChanged = !sdkSessionListEqual(s.sdkSessions, sessions);
      let cliConnected = s.cliConnected;
      let cliEverConnected = s.cliEverConnected;
      let cliDisconnectReason = s.cliDisconnectReason;
      let sessionStatus = s.sessionStatus;
      let cliConnectedChanged = false;
      let cliEverConnectedChanged = false;
      let cliDisconnectReasonChanged = false;
      let sessionStatusChanged = false;

      for (const session of sessions) {
        const { sessionId } = session;
        if (typeof session.cliConnected === "boolean") {
          const prevCliConnected = cliConnected.get(sessionId);
          if (prevCliConnected !== session.cliConnected) {
            if (!cliConnectedChanged) cliConnected = new Map(cliConnected);
            cliConnected.set(sessionId, session.cliConnected);
            cliConnectedChanged = true;
          }
          if (session.cliConnected) {
            if (cliDisconnectReason.get(sessionId) !== null) {
              if (!cliDisconnectReasonChanged) cliDisconnectReason = new Map(cliDisconnectReason);
              cliDisconnectReason.set(sessionId, null);
              cliDisconnectReasonChanged = true;
            }
            if (!cliEverConnected.get(sessionId)) {
              if (!cliEverConnectedChanged) cliEverConnected = new Map(cliEverConnected);
              cliEverConnected.set(sessionId, true);
              cliEverConnectedChanged = true;
            }
          }
        }

        // Non-current sessions no longer keep a live chat socket open, so their
        // sidebar chip status must be refreshed from the server-authoritative
        // /api/sessions poll. Preserve the current session's live WebSocket
        // status so we don't clobber richer states like compacting/reverting.
        if (sessionId === currentSessionId) continue;
        const nextStatus = session.state === "running" ? "running" : null;
        const prevStatus = sessionStatus.get(sessionId) ?? null;
        if (prevStatus === nextStatus) continue;
        if (!sessionStatusChanged) sessionStatus = new Map(sessionStatus);
        if (nextStatus === null) {
          sessionStatus.delete(sessionId);
        } else {
          sessionStatus.set(sessionId, nextStatus);
        }
        sessionStatusChanged = true;
      }

      if (
        !sdkSessionsChanged &&
        !cliConnectedChanged &&
        !cliEverConnectedChanged &&
        !cliDisconnectReasonChanged &&
        !sessionStatusChanged
      ) {
        return s;
      }

      return {
        ...(sdkSessionsChanged ? { sdkSessions: sessions } : {}),
        ...(cliConnectedChanged ? { cliConnected } : {}),
        ...(cliEverConnectedChanged ? { cliEverConnected } : {}),
        ...(cliDisconnectReasonChanged ? { cliDisconnectReason } : {}),
        ...(sessionStatusChanged ? { sessionStatus } : {}),
      };
    }),

  appendMessage: (sessionId, msg) =>
    set((s) => {
      const existing = s.messages.get(sessionId) || [];
      // Deduplicate: skip if a message with same ID already exists
      if (msg.id && existing.some((m) => m.id === msg.id)) {
        return s;
      }
      const messages = new Map(s.messages);
      messages.set(sessionId, [...existing, msg]);
      return { messages };
    }),

  setMessages: (sessionId, msgs, options) =>
    set((s) => {
      // Deduplicate by message ID (server may send duplicates on CLI reconnect)
      const seen = new Set<string>();
      const deduped = msgs.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      const messages = new Map(s.messages);
      messages.set(sessionId, deduped);
      const messageFrozenCounts = new Map(s.messageFrozenCounts);
      const frozenCount = Math.max(0, Math.min(options?.frozenCount ?? 0, deduped.length));
      messageFrozenCounts.set(sessionId, frozenCount);
      const messageFrozenHashes = new Map(s.messageFrozenHashes);
      if (options?.frozenHash) {
        messageFrozenHashes.set(sessionId, options.frozenHash);
      } else {
        messageFrozenHashes.delete(sessionId);
      }
      const messageFrozenRevisions = new Map(s.messageFrozenRevisions);
      messageFrozenRevisions.set(sessionId, 0);
      return { messages, messageFrozenCounts, messageFrozenHashes, messageFrozenRevisions };
    }),

  setHistoryLoading: (sessionId, loading) =>
    set((s) => {
      const historyLoading = new Map(s.historyLoading);
      if (loading) {
        historyLoading.set(sessionId, true);
      } else {
        historyLoading.delete(sessionId);
      }
      return { historyLoading };
    }),

  setHistoryWindow: (sessionId, window) =>
    set((s) => {
      const historyWindows = new Map(s.historyWindows);
      if (window) {
        historyWindows.set(sessionId, window);
      } else {
        historyWindows.delete(sessionId);
      }
      return { historyWindows };
    }),

  setPendingCodexInputs: (sessionId, inputs) =>
    set((s) => {
      const pendingCodexInputs = new Map(s.pendingCodexInputs);
      if (inputs.length === 0) {
        pendingCodexInputs.delete(sessionId);
      } else {
        pendingCodexInputs.set(sessionId, inputs);
      }
      return { pendingCodexInputs };
    }),

  updateMessage: (sessionId, msgId, updates) =>
    set((s) => {
      const messages = new Map(s.messages);
      const list = messages.get(sessionId);
      if (!list) return s;
      let updatedFrozen = false;
      const frozenCount = s.messageFrozenCounts.get(sessionId) ?? 0;
      const updated = list.map((m, index) => {
        if (m.id !== msgId) return m;
        if (index < frozenCount) updatedFrozen = true;
        return { ...m, ...updates };
      });
      messages.set(sessionId, updated);
      if (!updatedFrozen) return { messages };
      const messageFrozenRevisions = new Map(s.messageFrozenRevisions);
      messageFrozenRevisions.set(sessionId, (messageFrozenRevisions.get(sessionId) ?? 0) + 1);
      return { messages, messageFrozenRevisions };
    }),

  updateQuestTitleInMessages: (sessionId, questId, newTitle) =>
    set((s) => {
      const list = s.messages.get(sessionId);
      if (!list) return s;
      let changed = false;
      const updated = list.map((m) => {
        if (m.metadata?.quest?.questId === questId && m.metadata.quest.title !== newTitle) {
          changed = true;
          const label = m.variant === "quest_submitted" ? "Quest submitted" : "Quest Claimed";
          return {
            ...m,
            content: `${label}: ${newTitle}`,
            metadata: { ...m.metadata, quest: { ...m.metadata.quest, title: newTitle } },
          };
        }
        return m;
      });
      if (!changed) return s;
      const messages = new Map(s.messages);
      messages.set(sessionId, updated);
      const frozenCount = s.messageFrozenCounts.get(sessionId) ?? 0;
      const changedFrozen = updated.some((m, index) => index < frozenCount && m !== list[index]);
      if (!changedFrozen) return { messages };
      const messageFrozenRevisions = new Map(s.messageFrozenRevisions);
      messageFrozenRevisions.set(sessionId, (messageFrozenRevisions.get(sessionId) ?? 0) + 1);
      return { messages, messageFrozenRevisions };
    }),

  updateLastAssistantMessage: (sessionId, updater) =>
    set((s) => {
      const messages = new Map(s.messages);
      const list = [...(messages.get(sessionId) || [])];
      let updatedIndex = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].role === "assistant") {
          list[i] = updater(list[i]);
          updatedIndex = i;
          break;
        }
      }
      messages.set(sessionId, list);
      if (updatedIndex < 0 || updatedIndex >= (s.messageFrozenCounts.get(sessionId) ?? 0)) return { messages };
      const messageFrozenRevisions = new Map(s.messageFrozenRevisions);
      messageFrozenRevisions.set(sessionId, (messageFrozenRevisions.get(sessionId) ?? 0) + 1);
      return { messages, messageFrozenRevisions };
    }),

  commitMessagesAsFrozen: (sessionId) =>
    set((s) => {
      const list = s.messages.get(sessionId);
      if (!list) return s;
      const nextFrozenCount = list.length;
      const prevFrozenCount = s.messageFrozenCounts.get(sessionId) ?? 0;
      if (prevFrozenCount === nextFrozenCount) return s;
      const messageFrozenCounts = new Map(s.messageFrozenCounts);
      messageFrozenCounts.set(sessionId, nextFrozenCount);
      return { messageFrozenCounts };
    }),

  setStreaming: (sessionId, text, parentToolUseId) =>
    set((s) => {
      if (parentToolUseId) {
        const streamingByParentToolUseId = new Map(s.streamingByParentToolUseId);
        const sessionStreaming = new Map(streamingByParentToolUseId.get(sessionId) || []);
        if (text === null) {
          sessionStreaming.delete(parentToolUseId);
        } else {
          sessionStreaming.set(parentToolUseId, text);
        }
        if (sessionStreaming.size === 0) {
          streamingByParentToolUseId.delete(sessionId);
        } else {
          streamingByParentToolUseId.set(sessionId, sessionStreaming);
        }
        return { streamingByParentToolUseId };
      }
      const streaming = new Map(s.streaming);
      if (text === null) {
        streaming.delete(sessionId);
      } else {
        streaming.set(sessionId, text);
      }
      return { streaming };
    }),

  setStreamingThinking: (sessionId, text, parentToolUseId) =>
    set((s) => {
      if (parentToolUseId) {
        const streamingThinkingByParentToolUseId = new Map(s.streamingThinkingByParentToolUseId);
        const sessionStreaming = new Map(streamingThinkingByParentToolUseId.get(sessionId) || []);
        if (text === null) {
          sessionStreaming.delete(parentToolUseId);
        } else {
          sessionStreaming.set(parentToolUseId, text);
        }
        if (sessionStreaming.size === 0) {
          streamingThinkingByParentToolUseId.delete(sessionId);
        } else {
          streamingThinkingByParentToolUseId.set(sessionId, sessionStreaming);
        }
        return { streamingThinkingByParentToolUseId };
      }
      const streamingThinking = new Map(s.streamingThinking);
      if (text === null) {
        streamingThinking.delete(sessionId);
      } else {
        streamingThinking.set(sessionId, text);
      }
      return { streamingThinking };
    }),

  setStreamingStats: (sessionId, stats) =>
    set((s) => {
      const streamingStartedAt = new Map(s.streamingStartedAt);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      if (stats === null) {
        streamingStartedAt.delete(sessionId);
        streamingOutputTokens.delete(sessionId);
        // Also clear pause tracking when generation ends
        const streamingPausedDuration = new Map(s.streamingPausedDuration);
        const streamingPauseStartedAt = new Map(s.streamingPauseStartedAt);
        streamingPausedDuration.delete(sessionId);
        streamingPauseStartedAt.delete(sessionId);
        return { streamingStartedAt, streamingOutputTokens, streamingPausedDuration, streamingPauseStartedAt };
      } else {
        if (stats.startedAt !== undefined) streamingStartedAt.set(sessionId, stats.startedAt);
        if (stats.outputTokens !== undefined) streamingOutputTokens.set(sessionId, stats.outputTokens);
      }
      return { streamingStartedAt, streamingOutputTokens };
    }),

  clearStreamingState: (sessionId) =>
    set((s) => {
      const streaming = new Map(s.streaming);
      streaming.delete(sessionId);
      const streamingByParentToolUseId = new Map(s.streamingByParentToolUseId);
      streamingByParentToolUseId.delete(sessionId);
      const streamingThinking = new Map(s.streamingThinking);
      streamingThinking.delete(sessionId);
      const streamingThinkingByParentToolUseId = new Map(s.streamingThinkingByParentToolUseId);
      streamingThinkingByParentToolUseId.delete(sessionId);
      const streamingStartedAt = new Map(s.streamingStartedAt);
      streamingStartedAt.delete(sessionId);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      streamingOutputTokens.delete(sessionId);
      const streamingPausedDuration = new Map(s.streamingPausedDuration);
      streamingPausedDuration.delete(sessionId);
      const streamingPauseStartedAt = new Map(s.streamingPauseStartedAt);
      streamingPauseStartedAt.delete(sessionId);
      return {
        streaming,
        streamingByParentToolUseId,
        streamingThinking,
        streamingThinkingByParentToolUseId,
        streamingStartedAt,
        streamingOutputTokens,
        streamingPausedDuration,
        streamingPauseStartedAt,
      };
    }),

  resetSessionForAuthoritativeHistory: (sessionId, options) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      pendingPermissions.delete(sessionId);
      const autoExpandedTurnIds = new Map(s.autoExpandedTurnIds);
      autoExpandedTurnIds.delete(sessionId);
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.set(sessionId, []);
      const sessionTaskPreview = new Map(s.sessionTaskPreview);
      sessionTaskPreview.delete(sessionId);
      const pendingCodexInputs = new Map(s.pendingCodexInputs);
      pendingCodexInputs.delete(sessionId);
      const historyWindows = new Map(s.historyWindows);
      historyWindows.delete(sessionId);
      const streaming = new Map(s.streaming);
      streaming.delete(sessionId);
      const streamingByParentToolUseId = new Map(s.streamingByParentToolUseId);
      streamingByParentToolUseId.delete(sessionId);
      const streamingThinking = new Map(s.streamingThinking);
      streamingThinking.delete(sessionId);
      const streamingThinkingByParentToolUseId = new Map(s.streamingThinkingByParentToolUseId);
      streamingThinkingByParentToolUseId.delete(sessionId);
      const streamingStartedAt = new Map(s.streamingStartedAt);
      streamingStartedAt.delete(sessionId);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      streamingOutputTokens.delete(sessionId);
      const streamingPausedDuration = new Map(s.streamingPausedDuration);
      streamingPausedDuration.delete(sessionId);
      const streamingPauseStartedAt = new Map(s.streamingPauseStartedAt);
      streamingPauseStartedAt.delete(sessionId);
      const toolProgress = new Map(s.toolProgress);
      toolProgress.delete(sessionId);
      const toolResults = new Map(s.toolResults);
      const backgroundAgentNotifs = new Map(s.backgroundAgentNotifs);
      const toolStartTimestamps = new Map(s.toolStartTimestamps);
      const preservedIds = options?.preserveToolStateIds ? new Set(options.preserveToolStateIds) : null;
      if (preservedIds && preservedIds.size > 0) {
        const sessionResults = s.toolResults.get(sessionId);
        if (sessionResults) {
          const filtered = new Map([...sessionResults].filter(([toolUseId]) => preservedIds.has(toolUseId)));
          if (filtered.size > 0) toolResults.set(sessionId, filtered);
          else toolResults.delete(sessionId);
        } else {
          toolResults.delete(sessionId);
        }
        const sessionNotifs = s.backgroundAgentNotifs.get(sessionId);
        if (sessionNotifs) {
          const filtered = new Map([...sessionNotifs].filter(([toolUseId]) => preservedIds.has(toolUseId)));
          if (filtered.size > 0) backgroundAgentNotifs.set(sessionId, filtered);
          else backgroundAgentNotifs.delete(sessionId);
        } else {
          backgroundAgentNotifs.delete(sessionId);
        }
        const sessionTimestamps = s.toolStartTimestamps.get(sessionId);
        if (sessionTimestamps) {
          const filtered = new Map([...sessionTimestamps].filter(([toolUseId]) => preservedIds.has(toolUseId)));
          if (filtered.size > 0) toolStartTimestamps.set(sessionId, filtered);
          else toolStartTimestamps.delete(sessionId);
        } else {
          toolStartTimestamps.delete(sessionId);
        }
      } else {
        toolResults.delete(sessionId);
        backgroundAgentNotifs.delete(sessionId);
        toolStartTimestamps.delete(sessionId);
      }
      return {
        pendingPermissions,
        autoExpandedTurnIds,
        sessionTasks,
        sessionTaskPreview,
        pendingCodexInputs,
        historyWindows,
        streaming,
        streamingByParentToolUseId,
        streamingThinking,
        streamingThinkingByParentToolUseId,
        streamingStartedAt,
        streamingOutputTokens,
        streamingPausedDuration,
        streamingPauseStartedAt,
        toolProgress,
        toolResults,
        backgroundAgentNotifs,
        toolStartTimestamps,
      };
    }),

  addPermission: (sessionId, perm) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = new Map(pendingPermissions.get(sessionId) || []);
      sessionPerms.set(perm.request_id, perm);
      pendingPermissions.set(sessionId, sessionPerms);
      return { pendingPermissions };
    }),

  removePermission: (sessionId, requestId) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = pendingPermissions.get(sessionId);
      if (sessionPerms) {
        const updated = new Map(sessionPerms);
        updated.delete(requestId);
        pendingPermissions.set(sessionId, updated);

        if (updated.size === 0) {
          // Clear "action" attention when all permissions are resolved — the user
          // no longer needs to act on this session for permission approvals.
          const result: Record<string, unknown> = { pendingPermissions };
          if (s.sessionAttention.get(sessionId) === "action") {
            const sessionAttention = new Map(s.sessionAttention);
            sessionAttention.set(sessionId, null);
            result.sessionAttention = sessionAttention;
          }

          // Resume streaming timer when no more pending permissions
          if (s.streamingPauseStartedAt.has(sessionId)) {
            const pauseStart = s.streamingPauseStartedAt.get(sessionId)!;
            const streamingPauseStartedAt = new Map(s.streamingPauseStartedAt);
            const streamingPausedDuration = new Map(s.streamingPausedDuration);
            streamingPauseStartedAt.delete(sessionId);
            const prev = streamingPausedDuration.get(sessionId) || 0;
            streamingPausedDuration.set(sessionId, prev + (Date.now() - pauseStart));
            result.streamingPauseStartedAt = streamingPauseStartedAt;
            result.streamingPausedDuration = streamingPausedDuration;
          }

          return result;
        }
      }
      return { pendingPermissions };
    }),

  updatePermissionEvaluating: (sessionId, requestId, evaluating) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = pendingPermissions.get(sessionId);
      if (sessionPerms) {
        const perm = sessionPerms.get(requestId);
        if (perm) {
          const updated = new Map(sessionPerms);
          updated.set(requestId, { ...perm, evaluating });
          pendingPermissions.set(sessionId, updated);
        }
      }
      return { pendingPermissions };
    }),

  updatePermissionDeferralReason: (sessionId, requestId, deferralReason) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = pendingPermissions.get(sessionId);
      if (sessionPerms) {
        const perm = sessionPerms.get(requestId);
        if (perm) {
          const updated = new Map(sessionPerms);
          updated.set(requestId, { ...perm, deferralReason });
          pendingPermissions.set(sessionId, updated);
        }
      }
      return { pendingPermissions };
    }),

  markPermissionAutoApproved: (sessionId, requestId, reason) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = pendingPermissions.get(sessionId);
      if (sessionPerms) {
        const perm = sessionPerms.get(requestId);
        if (perm) {
          const updated = new Map(sessionPerms);
          updated.set(requestId, { ...perm, evaluating: undefined, autoApproved: reason });
          pendingPermissions.set(sessionId, updated);
        }
      }
      return { pendingPermissions };
    }),

  clearPermissions: (sessionId) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      pendingPermissions.delete(sessionId);
      const result: Record<string, unknown> = { pendingPermissions };
      // Clear "action" attention when all permissions are cleared
      if (s.sessionAttention.get(sessionId) === "action") {
        const sessionAttention = new Map(s.sessionAttention);
        sessionAttention.set(sessionId, null);
        result.sessionAttention = sessionAttention;
      }
      // Also resume streaming timer if paused
      if (s.streamingPauseStartedAt.has(sessionId)) {
        const pauseStart = s.streamingPauseStartedAt.get(sessionId)!;
        const streamingPauseStartedAt = new Map(s.streamingPauseStartedAt);
        const streamingPausedDuration = new Map(s.streamingPausedDuration);
        streamingPauseStartedAt.delete(sessionId);
        const prev = streamingPausedDuration.get(sessionId) || 0;
        streamingPausedDuration.set(sessionId, prev + (Date.now() - pauseStart));
        result.streamingPauseStartedAt = streamingPauseStartedAt;
        result.streamingPausedDuration = streamingPausedDuration;
      }
      return result;
    }),

  pauseStreamingTimer: (sessionId) =>
    set((s) => {
      // Only pause if timer is running and not already paused
      if (!s.streamingStartedAt.has(sessionId) || s.streamingPauseStartedAt.has(sessionId)) return s;
      const streamingPauseStartedAt = new Map(s.streamingPauseStartedAt);
      streamingPauseStartedAt.set(sessionId, Date.now());
      return { streamingPauseStartedAt };
    }),

  resumeStreamingTimer: (sessionId) =>
    set((s) => {
      const pauseStart = s.streamingPauseStartedAt.get(sessionId);
      if (!pauseStart) return s; // not paused
      const streamingPauseStartedAt = new Map(s.streamingPauseStartedAt);
      const streamingPausedDuration = new Map(s.streamingPausedDuration);
      streamingPauseStartedAt.delete(sessionId);
      const prev = streamingPausedDuration.get(sessionId) || 0;
      streamingPausedDuration.set(sessionId, prev + (Date.now() - pauseStart));
      return { streamingPauseStartedAt, streamingPausedDuration };
    }),

  addTask: (sessionId, task) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = [...(sessionTasks.get(sessionId) || []), task];
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  setTasks: (sessionId, tasks) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  updateTask: (sessionId, taskId, updates) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = sessionTasks.get(sessionId);
      if (tasks) {
        sessionTasks.set(
          sessionId,
          tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
        );
      }
      return { sessionTasks };
    }),

  addChangedFile: (sessionId, filePath) =>
    set((s) => {
      const changedFiles = new Map(s.changedFiles);
      const files = new Set(changedFiles.get(sessionId) || []);
      files.add(filePath);
      changedFiles.set(sessionId, files);
      return { changedFiles };
    }),

  clearChangedFiles: (sessionId) =>
    set((s) => {
      const changedFiles = new Map(s.changedFiles);
      changedFiles.delete(sessionId);
      return { changedFiles };
    }),

  setDiffFileStats: (sessionId, stats) =>
    set((s) => {
      const diffFileStats = new Map(s.diffFileStats);
      diffFileStats.set(sessionId, stats);
      return { diffFileStats };
    }),

  setSessionName: (sessionId, name) =>
    set((s) => {
      const sessionNames = new Map(s.sessionNames);
      sessionNames.set(sessionId, name);
      scopedSetItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      return { sessionNames };
    }),

  markRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.add(sessionId);
      return { recentlyRenamed };
    }),

  clearRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.delete(sessionId);
      return { recentlyRenamed };
    }),

  markQuestNamed: (sessionId) =>
    set((s) => {
      if (s.questNamedSessions.has(sessionId)) return s;
      const questNamedSessions = new Set(s.questNamedSessions);
      questNamedSessions.add(sessionId);
      return { questNamedSessions };
    }),

  clearQuestNamed: (sessionId) =>
    set((s) => {
      if (!s.questNamedSessions.has(sessionId)) return s;
      const questNamedSessions = new Set(s.questNamedSessions);
      questNamedSessions.delete(sessionId);
      return { questNamedSessions };
    }),

  setSessionPreview: (sessionId, preview) =>
    set((s) => {
      const sessionPreviews = new Map(s.sessionPreviews);
      sessionPreviews.set(sessionId, preview.slice(0, 80));
      const sessionPreviewUpdatedAt = new Map(s.sessionPreviewUpdatedAt);
      sessionPreviewUpdatedAt.set(sessionId, Date.now());
      return { sessionPreviews, sessionPreviewUpdatedAt };
    }),

  setSessionTaskPreview: (sessionId, text) =>
    set((s) => {
      const sessionTaskPreview = new Map(s.sessionTaskPreview);
      if (text) {
        sessionTaskPreview.set(sessionId, { text: text.slice(0, 80), updatedAt: Date.now() });
      } else {
        sessionTaskPreview.delete(sessionId);
      }
      return { sessionTaskPreview };
    }),

  setSessionTaskHistory: (sessionId, tasks) =>
    set((s) => {
      const current = s.sessionTaskHistory.get(sessionId);
      if (sessionTaskHistoryEqual(current, tasks)) return s;
      const sessionTaskHistory = new Map(s.sessionTaskHistory);
      sessionTaskHistory.set(sessionId, tasks);
      return { sessionTaskHistory };
    }),

  setSessionKeywords: (sessionId, keywords) =>
    set((s) => {
      const current = s.sessionKeywords.get(sessionId);
      if (stringArrayEqual(current, keywords)) return s;
      const sessionKeywords = new Map(s.sessionKeywords);
      sessionKeywords.set(sessionId, keywords);
      return { sessionKeywords };
    }),

  requestScrollToTurn: (sessionId, turnId) =>
    set((s) => {
      const scrollToTurnId = new Map(s.scrollToTurnId);
      scrollToTurnId.set(sessionId, turnId);
      return { scrollToTurnId };
    }),

  clearScrollToTurn: (sessionId) =>
    set((s) => {
      const scrollToTurnId = new Map(s.scrollToTurnId);
      scrollToTurnId.delete(sessionId);
      return { scrollToTurnId };
    }),

  requestScrollToMessage: (sessionId, messageId) =>
    set((s) => {
      const scrollToMessageId = new Map(s.scrollToMessageId);
      scrollToMessageId.set(sessionId, messageId);
      return { scrollToMessageId };
    }),

  clearScrollToMessage: (sessionId) =>
    set((s) => {
      const scrollToMessageId = new Map(s.scrollToMessageId);
      scrollToMessageId.delete(sessionId);
      return { scrollToMessageId };
    }),

  setExpandAllInTurn: (sessionId, messageId) =>
    set((s) => {
      const expandAllInTurn = new Map(s.expandAllInTurn);
      expandAllInTurn.set(sessionId, messageId);
      return { expandAllInTurn };
    }),

  clearExpandAllInTurn: (sessionId) =>
    set((s) => {
      const expandAllInTurn = new Map(s.expandAllInTurn);
      expandAllInTurn.delete(sessionId);
      return { expandAllInTurn };
    }),

  setPendingScrollToMessageIndex: (sessionId, messageIndex) =>
    set((s) => {
      const pendingScrollToMessageIndex = new Map(s.pendingScrollToMessageIndex);
      pendingScrollToMessageIndex.set(sessionId, messageIndex);
      return { pendingScrollToMessageIndex };
    }),

  clearPendingScrollToMessageIndex: (sessionId) =>
    set((s) => {
      const pendingScrollToMessageIndex = new Map(s.pendingScrollToMessageIndex);
      pendingScrollToMessageIndex.delete(sessionId);
      return { pendingScrollToMessageIndex };
    }),

  // ─── Within-session search actions ──────────────────────────────────────────

  openSessionSearch: (sessionId) =>
    set((s) => {
      const sessionSearch = new Map(s.sessionSearch);
      const prev = sessionSearch.get(sessionId) ?? DEFAULT_SEARCH_STATE;
      sessionSearch.set(sessionId, { ...prev, isOpen: true });
      return { sessionSearch };
    }),

  closeSessionSearch: (sessionId) =>
    set((s) => {
      const sessionSearch = new Map(s.sessionSearch);
      sessionSearch.set(sessionId, { ...DEFAULT_SEARCH_STATE });
      return { sessionSearch };
    }),

  setSessionSearchQuery: (sessionId, query) =>
    set((s) => {
      const sessionSearch = new Map(s.sessionSearch);
      const prev = sessionSearch.get(sessionId) ?? DEFAULT_SEARCH_STATE;
      sessionSearch.set(sessionId, { ...prev, query });
      return { sessionSearch };
    }),

  setSessionSearchResults: (sessionId, matches) =>
    set((s) => {
      const sessionSearch = new Map(s.sessionSearch);
      const prev = sessionSearch.get(sessionId) ?? DEFAULT_SEARCH_STATE;
      // Preserve currentMatchIndex if valid, otherwise reset to first match
      const idx =
        prev.currentMatchIndex >= 0 && prev.currentMatchIndex < matches.length
          ? prev.currentMatchIndex
          : matches.length > 0
            ? 0
            : -1;
      sessionSearch.set(sessionId, { ...prev, matches, currentMatchIndex: idx });
      return { sessionSearch };
    }),

  setSessionSearchMode: (sessionId, mode) =>
    set((s) => {
      const sessionSearch = new Map(s.sessionSearch);
      const prev = sessionSearch.get(sessionId) ?? DEFAULT_SEARCH_STATE;
      sessionSearch.set(sessionId, { ...prev, mode });
      return { sessionSearch };
    }),

  setSessionSearchCategory: (sessionId, category) =>
    set((s) => {
      const sessionSearch = new Map(s.sessionSearch);
      const prev = sessionSearch.get(sessionId) ?? DEFAULT_SEARCH_STATE;
      const messages = s.messages.get(sessionId) ?? [];
      const matches = computeSessionSearchMatches(messages, prev.query, prev.mode, category);
      sessionSearch.set(sessionId, {
        ...prev,
        category,
        matches,
        currentMatchIndex: matches.length > 0 ? 0 : -1,
      });
      return { sessionSearch };
    }),

  navigateSessionSearch: (sessionId, direction) => {
    const s = useStore.getState();
    const prev = s.sessionSearch.get(sessionId) ?? DEFAULT_SEARCH_STATE;
    if (prev.matches.length === 0) return;
    const len = prev.matches.length;
    const newIdx = direction === "next" ? (prev.currentMatchIndex + 1) % len : (prev.currentMatchIndex - 1 + len) % len;
    const sessionSearch = new Map(s.sessionSearch);
    sessionSearch.set(sessionId, { ...prev, currentMatchIndex: newIdx });
    set({ sessionSearch });
    // Scroll to the matched message
    const match = prev.matches[newIdx];
    if (match) {
      s.requestScrollToMessage(sessionId, match.messageId);
    }
  },

  requestBottomAlignOnNextUserMessage: (sessionId) =>
    set((s) => {
      if (s.bottomAlignNextUserMessage.has(sessionId)) return s;
      const bottomAlignNextUserMessage = new Set(s.bottomAlignNextUserMessage);
      bottomAlignNextUserMessage.add(sessionId);
      return { bottomAlignNextUserMessage };
    }),

  clearBottomAlignOnNextUserMessage: (sessionId) =>
    set((s) => {
      if (!s.bottomAlignNextUserMessage.has(sessionId)) return s;
      const bottomAlignNextUserMessage = new Set(s.bottomAlignNextUserMessage);
      bottomAlignNextUserMessage.delete(sessionId);
      return { bottomAlignNextUserMessage };
    }),

  setActiveTaskTurnId: (sessionId, turnId) =>
    set((s) => {
      const prev = s.activeTaskTurnId.get(sessionId);
      if (prev === turnId) return s;
      const activeTaskTurnId = new Map(s.activeTaskTurnId);
      if (turnId === null) activeTaskTurnId.delete(sessionId);
      else activeTaskTurnId.set(sessionId, turnId);
      return { activeTaskTurnId };
    }),

  setPRStatus: (sessionId, status) =>
    set((s) => {
      const prStatus = new Map(s.prStatus);
      prStatus.set(sessionId, status);
      return { prStatus };
    }),

  setMcpServers: (sessionId, servers) =>
    set((s) => {
      const mcpServers = new Map(s.mcpServers);
      mcpServers.set(sessionId, servers);
      return { mcpServers };
    }),

  setToolProgress: (sessionId, toolUseId, data) =>
    set((s) => {
      const toolProgress = new Map(s.toolProgress);
      const sessionProgress = new Map(toolProgress.get(sessionId) || []);
      const existing = sessionProgress.get(toolUseId);
      let output = existing?.output;
      let outputTruncated = existing?.outputTruncated ?? false;
      if (typeof data.outputDelta === "string" && data.outputDelta.length > 0) {
        const merged = (output || "") + data.outputDelta;
        if (merged.length > TOOL_PROGRESS_OUTPUT_LIMIT) {
          output = merged.slice(-TOOL_PROGRESS_OUTPUT_LIMIT);
          outputTruncated = true;
        } else {
          output = merged;
        }
      }
      sessionProgress.set(toolUseId, {
        toolName: data.toolName,
        elapsedSeconds: data.elapsedSeconds,
        ...(output ? { output } : {}),
        ...(outputTruncated ? { outputTruncated: true } : {}),
      });
      toolProgress.set(sessionId, sessionProgress);
      return { toolProgress };
    }),

  clearToolProgress: (sessionId, toolUseId) =>
    set((s) => {
      const toolProgress = new Map(s.toolProgress);
      if (toolUseId) {
        const sessionProgress = toolProgress.get(sessionId);
        if (sessionProgress) {
          const updated = new Map(sessionProgress);
          updated.delete(toolUseId);
          toolProgress.set(sessionId, updated);
        }
      } else {
        toolProgress.delete(sessionId);
      }
      return { toolProgress };
    }),

  setToolResult: (sessionId, toolUseId, preview) =>
    set((s) => {
      const toolResults = new Map(s.toolResults);
      const sessionResults = new Map(toolResults.get(sessionId) || []);
      sessionResults.set(toolUseId, preview);
      toolResults.set(sessionId, sessionResults);
      return { toolResults };
    }),

  setBackgroundAgentNotif: (sessionId, toolUseId, notif) =>
    set((s) => {
      const backgroundAgentNotifs = new Map(s.backgroundAgentNotifs);
      const session = new Map(backgroundAgentNotifs.get(sessionId) || new Map());
      session.set(toolUseId, notif);
      backgroundAgentNotifs.set(sessionId, session);
      return { backgroundAgentNotifs };
    }),

  setToolStartTimestamps: (sessionId, timestamps) =>
    set((s) => {
      const toolStartTimestamps = new Map(s.toolStartTimestamps);
      const sessionTimestamps = new Map(toolStartTimestamps.get(sessionId) || []);
      for (const [toolUseId, ts] of Object.entries(timestamps)) {
        sessionTimestamps.set(toolUseId, ts);
      }
      toolStartTimestamps.set(sessionId, sessionTimestamps);
      return { toolStartTimestamps };
    }),

  markSessionViewed: (sessionId) =>
    set((s) => {
      const sessionAttention = new Map(s.sessionAttention);
      sessionAttention.set(sessionId, null);
      return { sessionAttention };
    }),

  markSessionUnread: (sessionId) =>
    set((s) => {
      const sessionAttention = new Map(s.sessionAttention);
      sessionAttention.set(sessionId, "review");
      api.markSessionUnread(sessionId).catch(() => {});
      return { sessionAttention };
    }),

  markAllSessionsViewed: () =>
    set((s) => {
      const sessionAttention = new Map(s.sessionAttention);
      for (const sdk of s.sdkSessions) {
        sessionAttention.set(sdk.sessionId, null);
      }
      api.markAllSessionsRead().catch(() => {});
      return { sessionAttention };
    }),

  clearSessionAttention: (sessionId) =>
    set((s) => {
      const sessionAttention = new Map(s.sessionAttention);
      sessionAttention.set(sessionId, null);
      return { sessionAttention };
    }),

  setTreeGroups: (groups, assignments, nodeOrder) =>
    set(() => ({
      treeGroups: groups,
      treeAssignments: new Map(Object.entries(assignments)),
      treeNodeOrder: new Map(Object.entries(nodeOrder)),
    })),

  toggleTreeGroupCollapse: (groupId) =>
    set((s) => {
      const collapsedTreeGroups = new Set(s.collapsedTreeGroups);
      if (collapsedTreeGroups.has(groupId)) {
        collapsedTreeGroups.delete(groupId);
      } else {
        collapsedTreeGroups.add(groupId);
      }
      scopedSetItem("cc-collapsed-tree-groups", JSON.stringify(Array.from(collapsedTreeGroups)));
      return { collapsedTreeGroups };
    }),

  toggleTreeNodeCollapse: (sessionId) =>
    set((s) => {
      const collapsedTreeNodes = new Set(s.collapsedTreeNodes);
      if (collapsedTreeNodes.has(sessionId)) {
        collapsedTreeNodes.delete(sessionId);
      } else {
        collapsedTreeNodes.add(sessionId);
      }
      scopedSetItem("cc-collapsed-tree-nodes", JSON.stringify(Array.from(collapsedTreeNodes)));
      return { collapsedTreeNodes };
    }),

  toggleHerdNodeExpand: (sessionId) =>
    set((s) => {
      const expandedHerdNodes = new Set(s.expandedHerdNodes);
      if (expandedHerdNodes.has(sessionId)) {
        expandedHerdNodes.delete(sessionId);
      } else {
        expandedHerdNodes.add(sessionId);
      }
      scopedSetItem("cc-expanded-herd-nodes", JSON.stringify(Array.from(expandedHerdNodes)));
      return { expandedHerdNodes };
    }),

  setPreviousPermissionMode: (sessionId, mode) =>
    set((s) => {
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.set(sessionId, mode);
      return { previousPermissionMode };
    }),

  setAskPermission: (sessionId, value) =>
    set((s) => {
      const askPermission = new Map(s.askPermission);
      askPermission.set(sessionId, value);
      return { askPermission };
    }),

  setConnectionStatus: (sessionId, status) =>
    set((s) => {
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.set(sessionId, status);
      return { connectionStatus };
    }),

  setCliConnected: (sessionId, connected) =>
    set((s) => {
      const cliConnected = new Map(s.cliConnected);
      cliConnected.set(sessionId, connected);
      if (connected) {
        const cliEverConnected = new Map(s.cliEverConnected);
        cliEverConnected.set(sessionId, true);
        // Clear disconnect reason when CLI reconnects
        const cliDisconnectReason = new Map(s.cliDisconnectReason);
        cliDisconnectReason.set(sessionId, null);
        return { cliConnected, cliEverConnected, cliDisconnectReason };
      }
      return { cliConnected };
    }),

  setCliEverConnected: (sessionId) =>
    set((s) => {
      const cliEverConnected = new Map(s.cliEverConnected);
      cliEverConnected.set(sessionId, true);
      return { cliEverConnected };
    }),

  setCliDisconnectReason: (sessionId, reason) =>
    set((s) => {
      const cliDisconnectReason = new Map(s.cliDisconnectReason);
      cliDisconnectReason.set(sessionId, reason);
      return { cliDisconnectReason };
    }),

  setSessionStatus: (sessionId, status) =>
    set((s) => {
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.set(sessionId, status);
      return { sessionStatus };
    }),

  setSessionStuck: (sessionId, stuck) =>
    set((s) => {
      const sessionStuck = new Map(s.sessionStuck);
      if (stuck) {
        sessionStuck.set(sessionId, true);
      } else {
        sessionStuck.delete(sessionId);
      }
      return { sessionStuck };
    }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setDiffPanelSelectedFile: (sessionId, filePath) =>
    set((s) => {
      const diffPanelSelectedFile = new Map(s.diffPanelSelectedFile);
      if (filePath) {
        diffPanelSelectedFile.set(sessionId, filePath);
      } else {
        diffPanelSelectedFile.delete(sessionId);
      }
      return { diffPanelSelectedFile };
    }),

  setFeedScrollPosition: (sessionId, pos) =>
    set((s) => {
      const feedScrollPosition = new Map(s.feedScrollPosition);
      feedScrollPosition.set(sessionId, pos);
      return { feedScrollPosition };
    }),

  setComposerDraft: (sessionId, draft) =>
    set((s) => {
      const composerDrafts = new Map(s.composerDrafts);
      composerDrafts.set(sessionId, draft);
      return { composerDrafts };
    }),

  clearComposerDraft: (sessionId) =>
    set((s) => {
      const composerDrafts = new Map(s.composerDrafts);
      composerDrafts.delete(sessionId);
      return { composerDrafts };
    }),

  addPendingUserUpload: (sessionId, upload) =>
    set((s) => {
      const pendingUserUploads = new Map(s.pendingUserUploads);
      const existing = pendingUserUploads.get(sessionId) ?? [];
      pendingUserUploads.set(sessionId, [...existing, upload]);
      return { pendingUserUploads };
    }),

  updatePendingUserUpload: (sessionId, uploadId, updater) =>
    set((s) => {
      const existing = s.pendingUserUploads.get(sessionId);
      if (!existing?.length) return s;
      const nextItems = existing.map((upload) => (upload.id === uploadId ? updater(upload) : upload));
      if (nextItems === existing) return s;
      const pendingUserUploads = new Map(s.pendingUserUploads);
      pendingUserUploads.set(sessionId, nextItems);
      return { pendingUserUploads };
    }),

  removePendingUserUpload: (sessionId, uploadId) =>
    set((s) => {
      const existing = s.pendingUserUploads.get(sessionId);
      if (!existing?.length) return s;
      const nextItems = existing.filter((upload) => upload.id !== uploadId);
      const pendingUserUploads = new Map(s.pendingUserUploads);
      if (nextItems.length > 0) {
        pendingUserUploads.set(sessionId, nextItems);
      } else {
        pendingUserUploads.delete(sessionId);
      }
      return { pendingUserUploads };
    }),

  consumePendingUserUpload: (sessionId, uploadId) => {
    let consumed: PendingUserUpload | null = null;
    set((s) => {
      const existing = s.pendingUserUploads.get(sessionId);
      if (!existing?.length) return s;
      const nextItems = existing.filter((upload) => {
        if (upload.id !== uploadId) return true;
        consumed = upload;
        return false;
      });
      if (!consumed) return s;
      const pendingUserUploads = new Map(s.pendingUserUploads);
      if (nextItems.length > 0) {
        pendingUserUploads.set(sessionId, nextItems);
      } else {
        pendingUserUploads.delete(sessionId);
      }
      return { pendingUserUploads };
    });
    return consumed;
  },

  setReplyContext: (sessionId, context) =>
    set((s) => {
      const replyContexts = new Map(s.replyContexts);
      if (context) {
        replyContexts.set(sessionId, context);
      } else {
        replyContexts.delete(sessionId);
      }
      return { replyContexts };
    }),

  focusComposer: () => set((s) => ({ focusComposerTrigger: s.focusComposerTrigger + 1 })),

  toggleTurnActivity: (sessionId, turnId, defaultExpanded) =>
    set((s) => {
      const overrides = new Map(s.turnActivityOverrides);
      const session = new Map(overrides.get(sessionId) || []);
      if (session.has(turnId)) {
        // Has override → remove it (revert to default)
        session.delete(turnId);
      } else {
        // No override → set opposite of this turn's computed default.
        session.set(turnId, !defaultExpanded);
      }
      overrides.set(sessionId, session);
      return { turnActivityOverrides: overrides };
    }),

  collapseAllTurnActivity: (sessionId, turnIds) =>
    set((s) => {
      const overrides = new Map(s.turnActivityOverrides);
      const session = new Map<string, boolean>();
      for (const id of turnIds) session.set(id, false);
      overrides.set(sessionId, session);
      return { turnActivityOverrides: overrides };
    }),

  focusTurn: (sessionId, targetTurnId) =>
    set((s) => {
      const overrides = new Map(s.turnActivityOverrides);
      // Replace all overrides with just the target expanded.
      // All other turns revert to defaults (last = expanded, rest = collapsed).
      const session = new Map<string, boolean>();
      session.set(targetTurnId, true);
      overrides.set(sessionId, session);
      return { turnActivityOverrides: overrides };
    }),

  keepTurnExpanded: (sessionId, turnId) =>
    set((s) => {
      const overrides = new Map(s.turnActivityOverrides);
      const session = new Map(overrides.get(sessionId) || []);
      session.set(turnId, true);
      overrides.set(sessionId, session);
      return { turnActivityOverrides: overrides };
    }),

  keepTurnAutoExpanded: (sessionId, turnId) =>
    set((s) => {
      const autoExpandedTurnIds = new Map(s.autoExpandedTurnIds);
      const session = new Set(autoExpandedTurnIds.get(sessionId) || []);
      session.add(turnId);
      autoExpandedTurnIds.set(sessionId, session);
      return { autoExpandedTurnIds };
    }),

  clearAutoExpandedTurns: (sessionId) =>
    set((s) => {
      if (!s.autoExpandedTurnIds.has(sessionId)) return s;
      const autoExpandedTurnIds = new Map(s.autoExpandedTurnIds);
      autoExpandedTurnIds.delete(sessionId);
      return { autoExpandedTurnIds };
    }),

  setCollapsibleTurnIds: (sessionId, turnIds) =>
    set((s) => {
      const collapsibleTurnIds = new Map(s.collapsibleTurnIds);
      collapsibleTurnIds.set(sessionId, turnIds);
      return { collapsibleTurnIds };
    }),

  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setTerminalCwd: (cwd) => set({ terminalCwd: cwd }),
  setTerminalId: (id) => set({ terminalId: id }),
  openTerminal: (cwd) => set({ terminalOpen: true, terminalCwd: cwd }),
  closeTerminal: () => set({ terminalOpen: false, terminalCwd: null, terminalId: null }),

  reset: () => {
    resetQuestRefreshStateForTests();
    set({
      sessions: new Map(),
      sdkSessions: [],
      currentSessionId: null,
      messages: new Map(),
      messageFrozenCounts: new Map(),
      messageFrozenRevisions: new Map(),
      historyLoading: new Map(),
      historyWindows: new Map(),
      streaming: new Map(),
      streamingByParentToolUseId: new Map(),
      streamingThinking: new Map(),
      streamingThinkingByParentToolUseId: new Map(),
      streamingStartedAt: new Map(),
      streamingOutputTokens: new Map(),
      streamingPausedDuration: new Map(),
      streamingPauseStartedAt: new Map(),
      pendingPermissions: new Map(),
      connectionStatus: new Map(),
      cliConnected: new Map(),
      cliEverConnected: new Map(),
      cliDisconnectReason: new Map(),
      sessionStatus: new Map(),
      previousPermissionMode: new Map(),
      askPermission: new Map(),
      sessionTasks: new Map(),
      changedFiles: new Map(),
      diffFileStats: new Map(),
      sessionNames: new Map(),
      recentlyRenamed: new Set(),
      sessionPreviews: new Map(),
      sessionPreviewUpdatedAt: new Map(),
      sessionTaskHistory: new Map(),
      pendingCodexInputs: new Map(),
      sessionKeywords: new Map(),
      sessionSearch: new Map(),
      scrollToTurnId: new Map(),
      scrollToMessageId: new Map(),
      expandAllInTurn: new Map(),
      pendingScrollToMessageIndex: new Map(),
      bottomAlignNextUserMessage: new Set(),
      activeTaskTurnId: new Map(),
      sessionTaskPreview: new Map(),
      mcpServers: new Map(),
      toolProgress: new Map(),
      toolResults: new Map(),
      latestBoardToolUseId: new Map(),
      sessionBoards: new Map(),
      sessionCompletedBoards: new Map(),
      backgroundAgentNotifs: new Map(),
      toolStartTimestamps: new Map(),
      prStatus: new Map(),
      sessionAttention: new Map(),
      treeGroups: [],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      sessionInfoOpenSessionId: null,
      activeTab: "chat" as const,
      diffPanelSelectedFile: new Map(),
      feedScrollPosition: new Map(),
      composerDrafts: new Map(),
      pendingUserUploads: new Map(),
      replyContexts: new Map(),
      focusComposerTrigger: 0,
      turnActivityOverrides: new Map(),
      autoExpandedTurnIds: new Map(),
      collapsibleTurnIds: new Map(),
      quests: [],
      terminalOpen: false,
      terminalCwd: null,
      terminalId: null,
    });
  },
}));

/** Count permissions that need user attention (excludes those being LLM-evaluated, queued, or auto-approved). */
export function countUserPermissions(perms: Map<string, unknown> | undefined): number {
  if (!perms) return 0;
  let count = 0;
  for (const p of perms.values()) {
    const perm = p as { evaluating?: string; autoApproved?: string };
    if (!perm?.evaluating && !perm?.autoApproved) count++;
  }
  return count;
}
