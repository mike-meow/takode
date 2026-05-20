import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { api, type MessageSearchResponse, type MessageSearchResult, type MessageSearchScopeKind } from "../api.js";
import type { ChatMessage, QuestmasterTask, SdkSessionInfo } from "../types.js";
import { getQuestLeaderSessionId, getQuestOwnerSessionId } from "../utils/quest-helpers.js";
import { getHighlightParts } from "../utils/highlight.js";
import { writeClipboardText } from "../utils/copy-utils.js";
import { navigateToSession, navigateToSessionThread } from "../utils/routing.js";
import { scopedGetItem, scopedSetItem } from "../utils/scoped-storage.js";
import { compareSearchRanks, rankSearchFields, type SearchRank } from "../../shared/search-utils.js";
import { QuestInlineLink } from "./QuestInlineLink.js";
import { SessionInlineLink } from "./SessionInlineLink.js";

export type UniversalSearchMode = "quests" | "sessions" | "messages";

type MessageFilter = "user" | "assistant" | "event";
type MessageSearchSettings = {
  scope: MessageSearchScopeKind;
  filters: Record<MessageFilter, boolean>;
};

type UniversalSearchResult =
  | { kind: "quest"; id: string; quest: QuestmasterTask }
  | { kind: "session"; id: string; session: SdkSessionInfo; rank: SearchRank | null }
  | { kind: "message"; id: string; message: MessageSearchResult };

type QuestResultAction =
  | { id: "copy"; label: string }
  | { id: "leader" | "worker"; label: string; sessionId: string; sessionNum: number | null };

export interface UniversalSearchOverlayProps {
  open: boolean;
  currentSessionId: string | null;
  currentThreadKey?: string | null;
  sessions: SdkSessionInfo[];
  messages: ChatMessage[];
  leaderSessionId?: string;
  messageSearchPreviewResponse?: MessageSearchResponse;
  presentation?: "fixed" | "inline";
  initialMode?: UniversalSearchMode;
  initialQuery?: string;
  onClose: () => void;
  onOpenQuest: (questId: string, query: string) => void;
  onOpenMessage: (sessionId: string, messageId: string, threadKey?: string | null) => void;
}

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 300;
const LAST_MODE_STORAGE_KEY = "cc-universal-search-mode";
const LAST_QUERY_STORAGE_KEY = "cc-universal-search-query";
const MESSAGE_SETTINGS_STORAGE_KEY = "cc-universal-search-message-settings";
const MODE_OPTIONS: Array<{ id: UniversalSearchMode; label: string }> = [
  { id: "quests", label: "Quests" },
  { id: "sessions", label: "Sessions" },
  { id: "messages", label: "Messages" },
];

const MESSAGE_FILTERS: Array<{ id: MessageFilter; label: string }> = [
  { id: "user", label: "User" },
  { id: "assistant", label: "Assistant" },
  { id: "event", label: "Events" },
];

const DEFAULT_MESSAGE_SEARCH_SETTINGS: MessageSearchSettings = {
  scope: "current_thread",
  filters: {
    user: true,
    assistant: false,
    event: false,
  },
};

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debounced;
}

function isUniversalSearchMode(value: string | null): value is UniversalSearchMode {
  return value === "quests" || value === "sessions" || value === "messages";
}

function readLastMode(): UniversalSearchMode | null {
  if (typeof window === "undefined") return null;
  const stored = scopedGetItem(LAST_MODE_STORAGE_KEY);
  return isUniversalSearchMode(stored) ? stored : null;
}

function writeLastMode(mode: UniversalSearchMode): void {
  if (typeof window === "undefined") return;
  scopedSetItem(LAST_MODE_STORAGE_KEY, mode);
}

function readLastQuery(): string {
  if (typeof window === "undefined") return "";
  return scopedGetItem(LAST_QUERY_STORAGE_KEY) ?? "";
}

function writeLastQuery(query: string): void {
  if (typeof window === "undefined") return;
  scopedSetItem(LAST_QUERY_STORAGE_KEY, query);
}

function readMessageSearchSettings(): MessageSearchSettings {
  if (typeof window === "undefined") return DEFAULT_MESSAGE_SEARCH_SETTINGS;
  const stored = scopedGetItem(MESSAGE_SETTINGS_STORAGE_KEY);
  if (!stored) return DEFAULT_MESSAGE_SEARCH_SETTINGS;
  try {
    const parsed = JSON.parse(stored) as Partial<MessageSearchSettings>;
    return normalizeStoredMessageSearchSettings(parsed);
  } catch {
    return DEFAULT_MESSAGE_SEARCH_SETTINGS;
  }
}

function writeMessageSearchSettings(settings: MessageSearchSettings): void {
  if (typeof window === "undefined") return;
  scopedSetItem(MESSAGE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function normalizeStoredMessageSearchSettings(settings: Partial<MessageSearchSettings>): MessageSearchSettings {
  const scope =
    settings.scope === "session" || settings.scope === "current_thread" || settings.scope === "leader_all_tabs"
      ? settings.scope
      : DEFAULT_MESSAGE_SEARCH_SETTINGS.scope;
  return {
    scope,
    filters: {
      user:
        typeof settings.filters?.user === "boolean"
          ? settings.filters.user
          : DEFAULT_MESSAGE_SEARCH_SETTINGS.filters.user,
      assistant:
        typeof settings.filters?.assistant === "boolean"
          ? settings.filters.assistant
          : DEFAULT_MESSAGE_SEARCH_SETTINGS.filters.assistant,
      event:
        typeof settings.filters?.event === "boolean"
          ? settings.filters.event
          : DEFAULT_MESSAGE_SEARCH_SETTINGS.filters.event,
    },
  };
}

function getInitialMode(currentSessionId: string | null, messageModeAvailable: boolean): UniversalSearchMode {
  const stored = readLastMode();
  if (stored && (stored !== "messages" || messageModeAvailable)) return stored;
  return currentSessionId && messageModeAvailable ? "messages" : "quests";
}

function normalizeInitialModeOverride(
  mode: UniversalSearchMode | undefined,
  currentSessionId: string | null,
  messageModeAvailable: boolean,
): UniversalSearchMode {
  if (mode && (mode !== "messages" || messageModeAvailable)) return mode;
  return getInitialMode(currentSessionId, messageModeAvailable);
}

function normalizeMessageSearchScope(input: {
  preferredScope: MessageSearchScopeKind;
  isLeaderSession: boolean;
  currentThreadKey?: string | null;
}): MessageSearchScopeKind {
  if (!input.isLeaderSession) return "session";
  if (input.preferredScope === "leader_all_tabs") return "leader_all_tabs";
  return input.currentThreadKey ? "current_thread" : "leader_all_tabs";
}

function localMessageScopeLabel(
  sessionNum: number | null,
  scope: MessageSearchScopeKind,
  currentThreadKey?: string | null,
): string {
  const sessionLabel = typeof sessionNum === "number" ? `#${sessionNum}` : "current session";
  if (scope === "session") {
    return typeof sessionNum === "number" ? `Searching in session ${sessionLabel}` : "Searching in current session";
  }
  if (scope === "leader_all_tabs") return `Searching in ${sessionLabel} across tabs`;
  const threadLabel = currentThreadKey && currentThreadKey !== "main" ? `thread ${currentThreadKey}` : "Main";
  return `Searching in ${sessionLabel} ${threadLabel}`;
}

function questRecency(quest: QuestmasterTask): number {
  return Math.max(quest.createdAt ?? 0, quest.updatedAt ?? 0, quest.statusChangedAt ?? 0);
}

function formatRelativeTime(ts: number | undefined): string {
  if (!ts) return "";
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getAvailableModes(messageModeAvailable: boolean): UniversalSearchMode[] {
  return messageModeAvailable ? ["quests", "sessions", "messages"] : ["quests", "sessions"];
}

function nextMode(current: UniversalSearchMode, direction: 1 | -1, messageModeAvailable: boolean): UniversalSearchMode {
  const modes = getAvailableModes(messageModeAvailable);
  const currentIndex = Math.max(0, modes.indexOf(current));
  return modes[(currentIndex + direction + modes.length) % modes.length]!;
}

function isComposingEnter(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229);
}

function sessionNumForId(sessions: SdkSessionInfo[], sessionId: string | null): number | null {
  if (!sessionId) return null;
  return sessions.find((session) => session.sessionId === sessionId)?.sessionNum ?? null;
}

function getQuestResultActions(quest: QuestmasterTask, sessions: SdkSessionInfo[]): QuestResultAction[] {
  const leaderSessionId = getQuestLeaderSessionId(quest);
  const workerSessionId = getQuestOwnerSessionId(quest);
  const leaderSessionNum = sessionNumForId(sessions, leaderSessionId);
  const workerSessionNum = sessionNumForId(sessions, workerSessionId);
  const actions: QuestResultAction[] = [{ id: "copy", label: "Copy quest number" }];

  if (leaderSessionId) {
    actions.push({
      id: "leader",
      label: `Go to leader session${leaderSessionNum != null ? ` #${leaderSessionNum}` : ""}`,
      sessionId: leaderSessionId,
      sessionNum: leaderSessionNum,
    });
  }
  if (workerSessionId) {
    actions.push({
      id: "worker",
      label: `Go to worker session${workerSessionNum != null ? ` #${workerSessionNum}` : ""}`,
      sessionId: workerSessionId,
      sessionNum: workerSessionNum,
    });
  }
  return actions;
}

function sessionDisplayName(session: SdkSessionInfo): string {
  return (
    session.name?.trim() || (typeof session.sessionNum === "number" ? `#${session.sessionNum}` : session.sessionId)
  );
}

function sessionSearchFields(session: SdkSessionInfo) {
  return [
    { rank: 0, text: sessionDisplayName(session) },
    { rank: 1, text: typeof session.sessionNum === "number" ? `#${session.sessionNum}` : undefined },
    { rank: 2, text: session.gitBranch },
    { rank: 3, text: session.cwd },
    { rank: 4, text: session.repoRoot },
    { rank: 5, text: session.keywords?.join(" ") },
  ];
}

function sessionRecency(session: SdkSessionInfo): number {
  return session.lastActivityAt ?? session.lastUserMessageAt ?? session.createdAt;
}

function searchSessionsForOverlay(
  sessions: SdkSessionInfo[],
  query: string,
): Array<{ session: SdkSessionInfo; rank: SearchRank | null }> {
  const trimmed = query.trim();
  const candidates = sessions.filter((session) => !session.archived);
  if (!trimmed) {
    return candidates
      .map((session) => ({ session, rank: null }))
      .sort((a, b) => sessionRecency(b.session) - sessionRecency(a.session));
  }

  return candidates
    .map((session) => ({ session, rank: rankSearchFields(sessionSearchFields(session), trimmed) }))
    .filter((item): item is { session: SdkSessionInfo; rank: SearchRank } => item.rank !== null)
    .sort((a, b) => compareSearchRanks(a.rank, b.rank) || sessionRecency(b.session) - sessionRecency(a.session));
}

export function UniversalSearchOverlay({
  open,
  currentSessionId,
  currentThreadKey,
  sessions,
  presentation = "fixed",
  onClose,
  onOpenQuest,
  onOpenMessage,
  messageSearchPreviewResponse,
  initialMode,
  initialQuery,
}: UniversalSearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestSeqRef = useRef(0);
  const sessionByIdRef = useRef<Map<string, SdkSessionInfo>>(new Map());
  const searchKeyRef = useRef("");
  const copiedResetTimerRef = useRef<number | null>(null);
  const messageModeAvailable = Boolean(currentSessionId);

  const [mode, setMode] = useState<UniversalSearchMode>(() =>
    normalizeInitialModeOverride(initialMode, currentSessionId, messageModeAvailable),
  );
  const [query, setQuery] = useState(() => initialQuery ?? readLastQuery());
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [messageSettings, setMessageSettings] = useState<MessageSearchSettings>(() => readMessageSearchSettings());
  const [copiedQuestId, setCopiedQuestId] = useState<string | null>(null);
  const [questActionMenu, setQuestActionMenu] = useState<{ resultId: string; selectedActionIndex: number } | null>(
    null,
  );
  const [remoteState, setRemoteState] = useState<{
    mode: "quests" | "messages" | null;
    status: "idle" | "loading" | "error";
    results: UniversalSearchResult[];
    total: number;
    scopeLabel?: string;
  }>({ mode: null, status: "idle", results: [], total: 0 });

  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.sessionId, session] as const)),
    [sessions],
  );
  const currentSession = currentSessionId ? sessionById.get(currentSessionId) : undefined;
  const isLeaderSession = currentSession?.isOrchestrator === true;
  const effectiveMessageScope = normalizeMessageSearchScope({
    preferredScope: messageSettings.scope,
    isLeaderSession,
    currentThreadKey,
  });
  const messageScopeLabel =
    remoteState.mode === "messages" && remoteState.scopeLabel
      ? remoteState.scopeLabel
      : currentSessionId
        ? localMessageScopeLabel(currentSession?.sessionNum ?? null, effectiveMessageScope, currentThreadKey)
        : "Open a session to search messages";
  const sessionResults = useMemo(
    () =>
      searchSessionsForOverlay(sessions, debouncedQuery)
        .slice(0, visibleLimit)
        .map(({ session, rank }) => ({
          kind: "session" as const,
          id: session.sessionId,
          session,
          rank,
        })),
    [debouncedQuery, sessions, visibleLimit],
  );
  const totalSessionResults = useMemo(
    () => searchSessionsForOverlay(sessions, debouncedQuery).length,
    [debouncedQuery, sessions],
  );

  useEffect(() => {
    sessionByIdRef.current = sessionById;
  }, [sessionById]);

  useEffect(
    () => () => {
      if (copiedResetTimerRef.current != null) window.clearTimeout(copiedResetTimerRef.current);
    },
    [],
  );

  const setUserMode = useCallback((next: UniversalSearchMode) => {
    setMode(next);
    writeLastMode(next);
  }, []);

  const setUserQuery = useCallback((next: string) => {
    setQuery(next);
    writeLastQuery(next);
  }, []);

  useEffect(() => {
    if (!open) return;
    setMode(normalizeInitialModeOverride(initialMode, currentSessionId, messageModeAvailable));
    setMessageSettings(readMessageSearchSettings());
    setQuery(initialQuery ?? readLastQuery());
    setVisibleLimit(PAGE_SIZE);
    setSelectedIndex(0);
    setQuestActionMenu(null);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [currentSessionId, initialMode, initialQuery, messageModeAvailable, open]);

  useEffect(() => {
    if (mode === "messages" && !messageModeAvailable) setMode("quests");
  }, [messageModeAvailable, mode]);

  useEffect(() => {
    writeMessageSearchSettings(messageSettings);
  }, [messageSettings]);

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
    setSelectedIndex(0);
    setQuestActionMenu(null);
    listRef.current?.scrollTo({ top: 0 });
  }, [
    debouncedQuery,
    effectiveMessageScope,
    messageSettings.filters.assistant,
    messageSettings.filters.event,
    messageSettings.filters.user,
    mode,
  ]);

  const searchKey = `${mode}:${debouncedQuery.trim()}:scope=${effectiveMessageScope}:thread=${currentThreadKey ?? ""}:user=${messageSettings.filters.user}:assistant=${messageSettings.filters.assistant}:event=${messageSettings.filters.event}`;

  useEffect(() => {
    if (!open) return;
    const trimmedQuery = debouncedQuery.trim();
    const requestSeq = ++requestSeqRef.current;

    if (mode === "quests") {
      setRemoteState((current) => ({
        ...current,
        mode: "quests",
        status: "loading",
        results: current.mode === "quests" ? current.results : [],
      }));
      void api
        .listQuestPage({
          limit: visibleLimit,
          text: trimmedQuery || undefined,
          sortColumn: trimmedQuery ? undefined : "updated",
          sortDirection: trimmedQuery ? undefined : "desc",
        })
        .then((page) => {
          if (requestSeq !== requestSeqRef.current) return;
          setRemoteState({
            mode: "quests",
            status: "idle",
            total: page.total,
            results: page.quests.map((quest) => ({ kind: "quest", id: quest.questId, quest })),
          });
        })
        .catch((err) => {
          if (requestSeq !== requestSeqRef.current) return;
          console.warn("[universal-search] quest search failed:", err);
          setRemoteState({ mode: "quests", status: "error", total: 0, results: [] });
        });
      return;
    }

    if (mode === "messages" && currentSessionId) {
      if (messageSearchPreviewResponse) {
        setRemoteState({
          mode: "messages",
          status: "idle",
          total: messageSearchPreviewResponse.totalMatches,
          scopeLabel: messageSearchPreviewResponse.scope.label,
          results: messageSearchPreviewResponse.results.map((message) => ({
            kind: "message",
            id: message.id,
            message,
          })),
        });
        return;
      }
      const controller = new AbortController();
      const nextScopeLabel = localMessageScopeLabel(
        currentSession?.sessionNum ?? null,
        effectiveMessageScope,
        currentThreadKey,
      );
      setRemoteState((current) => ({
        ...current,
        mode: "messages",
        status: "loading",
        results: current.mode === "messages" ? current.results : [],
        scopeLabel: nextScopeLabel,
      }));
      void api
        .searchSessionMessages(currentSessionId, {
          query: trimmedQuery,
          scope: effectiveMessageScope,
          threadKey: effectiveMessageScope === "current_thread" ? currentThreadKey || "main" : undefined,
          filters: messageSettings.filters,
          limit: visibleLimit,
          signal: controller.signal,
        })
        .then((response) => {
          if (controller.signal.aborted || requestSeq !== requestSeqRef.current) return;
          setRemoteState({
            mode: "messages",
            status: "idle",
            total: response.totalMatches,
            scopeLabel: response.scope.label,
            results: response.results.map((message) => ({ kind: "message", id: message.id, message })),
          });
        })
        .catch((err) => {
          if (controller.signal.aborted || requestSeq !== requestSeqRef.current) return;
          console.warn("[universal-search] message search failed:", err);
          setRemoteState({ mode: "messages", status: "error", total: 0, results: [], scopeLabel: nextScopeLabel });
        });
      return () => controller.abort();
    }
  }, [
    currentSessionId,
    currentSession?.sessionNum,
    currentThreadKey,
    debouncedQuery,
    effectiveMessageScope,
    messageSearchPreviewResponse,
    messageSettings.filters,
    mode,
    open,
    visibleLimit,
  ]);

  const results = useMemo(() => {
    if (mode === "quests") return remoteState.mode === "quests" ? remoteState.results : [];
    if (mode === "sessions") return sessionResults;
    return remoteState.mode === "messages" ? remoteState.results : [];
  }, [mode, remoteState, sessionResults]);

  const totalResults = useMemo(() => {
    if (mode === "quests" && remoteState.mode === "quests") return remoteState.total;
    if (mode === "sessions") return totalSessionResults;
    if (mode === "messages" && remoteState.mode === "messages") return remoteState.total;
    return 0;
  }, [mode, remoteState, totalSessionResults]);

  const loading =
    (mode === "quests" || mode === "messages") && remoteState.mode === mode && remoteState.status === "loading";
  const error =
    (mode === "quests" || mode === "messages") && remoteState.mode === mode && remoteState.status === "error";
  const hasMore = results.length < totalResults;
  const selectedResultIndex = results.length === 0 ? -1 : Math.min(Math.max(selectedIndex, 0), results.length - 1);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (results.length === 0) return -1;
      if (searchKeyRef.current !== searchKey) return 0;
      if (current < 0) return 0;
      return Math.min(current, results.length - 1);
    });
    searchKeyRef.current = searchKey;
  }, [results.length, searchKey]);

  useEffect(() => {
    if (!questActionMenu) return;
    const result = results.find(
      (item): item is Extract<UniversalSearchResult, { kind: "quest" }> =>
        item.kind === "quest" && item.id === questActionMenu.resultId,
    );
    if (!result) {
      setQuestActionMenu(null);
      return;
    }
    const actionCount = getQuestResultActions(result.quest, sessions).length;
    if (questActionMenu.selectedActionIndex >= actionCount) {
      setQuestActionMenu({ resultId: questActionMenu.resultId, selectedActionIndex: Math.max(0, actionCount - 1) });
    }
  }, [questActionMenu, results, sessions]);

  const openResult = useCallback(
    (result: UniversalSearchResult | undefined) => {
      if (!result) return;
      if (result.kind === "quest") {
        onOpenQuest(result.quest.questId, debouncedQuery.trim());
      } else if (result.kind === "session") {
        navigateToSession(result.session.sessionId);
      } else {
        onOpenMessage(
          result.message.sessionId,
          result.message.messageId,
          result.message.routeThreadKey ?? currentThreadKey,
        );
      }
      onClose();
    },
    [currentThreadKey, debouncedQuery, onClose, onOpenMessage, onOpenQuest],
  );

  const copyQuestId = useCallback((questId: string) => {
    void writeClipboardText(questId)
      .then(() => {
        setCopiedQuestId(questId);
        if (copiedResetTimerRef.current != null) window.clearTimeout(copiedResetTimerRef.current);
        copiedResetTimerRef.current = window.setTimeout(() => setCopiedQuestId(null), 1200);
      })
      .catch((error) => console.error("Failed to copy quest ID:", error));
  }, []);

  const activateQuestResultAction = useCallback(
    (quest: QuestmasterTask, action: QuestResultAction) => {
      if (action.id === "copy") {
        copyQuestId(quest.questId);
        setQuestActionMenu(null);
        return;
      }
      if (action.id === "leader") {
        navigateToSessionThread(action.sessionId, quest.questId, false, action.sessionNum ?? action.sessionId);
        setQuestActionMenu(null);
        onClose();
        return;
      }
      navigateToSession(action.sessionId);
      setQuestActionMenu(null);
      onClose();
    },
    [copyQuestId, onClose],
  );

  const cycleMode = useCallback(
    (direction: 1 | -1) =>
      setMode((current) => {
        const next = nextMode(current, direction, messageModeAvailable);
        writeLastMode(next);
        return next;
      }),
    [messageModeAvailable],
  );

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (isComposingEnter(event)) return;

    if (questActionMenu) {
      const menuResult = results.find(
        (result): result is Extract<UniversalSearchResult, { kind: "quest" }> =>
          result.kind === "quest" && result.id === questActionMenu.resultId,
      );
      const actions = menuResult ? getQuestResultActions(menuResult.quest, sessions) : [];
      const selectedActionIndex =
        actions.length > 0 ? Math.min(questActionMenu.selectedActionIndex, actions.length - 1) : 0;

      if (!menuResult || actions.length === 0) {
        setQuestActionMenu(null);
      } else if (event.key === "Escape" || event.key === "ArrowLeft") {
        setQuestActionMenu(null);
        event.preventDefault();
        event.stopPropagation();
        return;
      } else if (event.key === "ArrowDown") {
        setQuestActionMenu({
          resultId: questActionMenu.resultId,
          selectedActionIndex: (selectedActionIndex + 1) % actions.length,
        });
        event.preventDefault();
        return;
      } else if (event.key === "ArrowUp") {
        setQuestActionMenu({
          resultId: questActionMenu.resultId,
          selectedActionIndex: (selectedActionIndex - 1 + actions.length) % actions.length,
        });
        event.preventDefault();
        return;
      } else if (event.key === "Enter") {
        activateQuestResultAction(menuResult.quest, actions[selectedActionIndex]!);
        event.preventDefault();
        return;
      }
    }

    if (event.key === "Escape") {
      onClose();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Tab") {
      cycleMode(event.shiftKey ? -1 : 1);
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown") {
      if (results.length > 0) setSelectedIndex((current) => (current + 1 + results.length) % results.length);
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowUp") {
      if (results.length > 0) setSelectedIndex((current) => (current - 1 + results.length) % results.length);
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowRight") {
      const result = results[selectedResultIndex];
      if (result?.kind === "quest") {
        setQuestActionMenu({ resultId: result.id, selectedActionIndex: 0 });
        event.preventDefault();
      }
      return;
    }
    if (event.key === "Enter") {
      openResult(results[selectedResultIndex]);
      event.preventDefault();
    }
  }

  function handleScroll() {
    const el = listRef.current;
    if (!el || !hasMore || loading) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 64) {
      setVisibleLimit((current) => current + PAGE_SIZE);
    }
  }

  if (!open) return null;

  const modeLabel = MODE_OPTIONS.find((option) => option.id === mode)?.label ?? "Search";
  const placeholder =
    mode === "quests"
      ? "Search quests..."
      : mode === "sessions"
        ? "Search sessions..."
        : messageModeAvailable
          ? "Search messages..."
          : "Open a session to search messages";

  const fixedPresentation = presentation === "fixed";

  return (
    <div
      className={
        fixedPresentation
          ? "fixed inset-0 z-[80] flex items-start justify-center bg-black/35 px-3 pt-[9vh] sm:px-6"
          : "relative flex items-start justify-center px-0 py-0"
      }
      onMouseDown={(event) => {
        if (fixedPresentation && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Universal Search"
        className="w-full max-w-3xl overflow-hidden rounded-xl border border-cc-border bg-cc-card text-cc-fg shadow-2xl"
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-cc-border bg-cc-sidebar/80 px-3 py-3 sm:px-4">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 shrink-0 text-cc-muted">
              <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85-.017.016zm-5.442.156a5 5 0 110-10 5 5 0 010 10z" />
            </svg>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setUserQuery(event.target.value)}
              placeholder={placeholder}
              className="min-w-0 flex-1 bg-transparent text-sm text-cc-fg outline-none placeholder:text-cc-muted"
            />
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
              title="Close Universal Search"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
                <path
                  fillRule="evenodd"
                  d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-cc-border/70 bg-cc-bg/70 p-0.5">
              {MODE_OPTIONS.map((option) => {
                const disabled = option.id === "messages" && !messageModeAvailable;
                const active = mode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    onClick={() => !disabled && setUserMode(option.id)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? "bg-cc-primary/18 text-cc-primary"
                        : disabled
                          ? "cursor-not-allowed text-cc-muted/45"
                          : "text-cc-muted hover:bg-cc-hover/70 hover:text-cc-fg"
                    }`}
                    title={disabled ? "Open a session to search messages" : `Search ${option.label.toLowerCase()}`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-cc-muted">
              <span>
                {loading ? "Searching..." : `${results.length}${hasMore ? "+" : ""} ${modeLabel.toLowerCase()}`}
              </span>
              <span className="hidden sm:inline">Tab switches modes</span>
            </div>
          </div>
          {mode === "messages" && messageModeAvailable && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] text-cc-muted">{messageScopeLabel}</span>
              {isLeaderSession && (
                <div className="mr-1 flex items-center gap-1 rounded-lg border border-cc-border/70 bg-cc-bg/60 p-0.5">
                  <button
                    type="button"
                    aria-pressed={effectiveMessageScope === "current_thread"}
                    disabled={!currentThreadKey}
                    onClick={() => setMessageSettings((current) => ({ ...current, scope: "current_thread" }))}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      effectiveMessageScope === "current_thread"
                        ? "bg-cc-primary/18 text-cc-primary"
                        : currentThreadKey
                          ? "text-cc-muted hover:bg-cc-hover/70 hover:text-cc-fg"
                          : "cursor-not-allowed text-cc-muted/45"
                    }`}
                  >
                    Current tab
                  </button>
                  <button
                    type="button"
                    aria-pressed={effectiveMessageScope === "leader_all_tabs"}
                    onClick={() => setMessageSettings((current) => ({ ...current, scope: "leader_all_tabs" }))}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      effectiveMessageScope === "leader_all_tabs"
                        ? "bg-cc-primary/18 text-cc-primary"
                        : "text-cc-muted hover:bg-cc-hover/70 hover:text-cc-fg"
                    }`}
                  >
                    Across tabs
                  </button>
                </div>
              )}
              {MESSAGE_FILTERS.map((filter) => {
                const active = messageSettings.filters[filter.id];
                return (
                  <button
                    key={filter.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setMessageSettings((current) => ({
                        ...current,
                        filters: { ...current.filters, [filter.id]: !current.filters[filter.id] },
                      }))
                    }
                    className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? "border-cc-primary/30 bg-cc-primary/15 text-cc-primary"
                        : "border-cc-border bg-cc-bg/60 text-cc-muted hover:text-cc-fg"
                    }`}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div ref={listRef} onScroll={handleScroll} className="max-h-[58vh] overflow-y-auto p-2 sm:max-h-[62vh]">
          {mode === "messages" && !messageModeAvailable ? (
            <EmptySearchState title="Current session required" detail="Quest search is still available." />
          ) : error ? (
            <EmptySearchState title="Search failed" detail="Try again or switch modes." />
          ) : results.length === 0 && loading ? (
            <SearchSkeleton />
          ) : results.length === 0 ? (
            <EmptySearchState
              title="No results"
              detail={debouncedQuery.trim() ? "Try a shorter query." : "Nothing to show yet."}
            />
          ) : (
            <div role="listbox" aria-label={`${modeLabel} results`} className="space-y-1">
              {results.map((result, index) => (
                <ResultRow
                  key={`${result.kind}:${result.id}`}
                  result={result}
                  query={debouncedQuery}
                  sessions={sessions}
                  selected={index === selectedResultIndex}
                  copiedQuestId={copiedQuestId}
                  questActionMenu={
                    result.kind === "quest" && questActionMenu?.resultId === result.id ? questActionMenu : null
                  }
                  onPointerMove={() => {
                    setSelectedIndex(index);
                    if (questActionMenu && questActionMenu.resultId !== result.id) setQuestActionMenu(null);
                  }}
                  onOpen={() => openResult(result)}
                  onCopyQuestId={copyQuestId}
                  onOpenQuestActionMenu={() => setQuestActionMenu({ resultId: result.id, selectedActionIndex: 0 })}
                  onSelectQuestAction={(selectedActionIndex) =>
                    setQuestActionMenu({ resultId: result.id, selectedActionIndex })
                  }
                  onActivateQuestAction={(quest, action) => activateQuestResultAction(quest, action)}
                  onInlineNavigate={onClose}
                />
              ))}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}
                  className="mt-2 w-full rounded-lg border border-cc-border bg-cc-bg/70 px-3 py-2 text-xs font-medium text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
                >
                  Load more
                </button>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div className="space-y-2 p-2" aria-label="Searching">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-14 animate-pulse rounded-lg bg-cc-hover/60" />
      ))}
    </div>
  );
}

function EmptySearchState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="text-sm font-medium text-cc-fg">{title}</div>
      <div className="mt-1 text-xs text-cc-muted">{detail}</div>
    </div>
  );
}

function ResultRow({
  result,
  query,
  sessions,
  selected,
  copiedQuestId,
  questActionMenu,
  onPointerMove,
  onOpen,
  onCopyQuestId,
  onOpenQuestActionMenu,
  onSelectQuestAction,
  onActivateQuestAction,
  onInlineNavigate,
}: {
  result: UniversalSearchResult;
  query: string;
  sessions: SdkSessionInfo[];
  selected: boolean;
  copiedQuestId: string | null;
  questActionMenu: { resultId: string; selectedActionIndex: number } | null;
  onPointerMove: () => void;
  onOpen: () => void;
  onCopyQuestId: (questId: string) => void;
  onOpenQuestActionMenu: () => void;
  onSelectQuestAction: (selectedActionIndex: number) => void;
  onActivateQuestAction: (quest: QuestmasterTask, action: QuestResultAction) => void;
  onInlineNavigate: () => void;
}) {
  if (result.kind === "quest") {
    return (
      <QuestResultRow
        quest={result.quest}
        sessions={sessions}
        selected={selected}
        copied={copiedQuestId === result.quest.questId}
        actionMenu={questActionMenu}
        onPointerMove={onPointerMove}
        onOpen={onOpen}
        onCopyQuestId={onCopyQuestId}
        onOpenActionMenu={onOpenQuestActionMenu}
        onSelectAction={onSelectQuestAction}
        onActivateAction={onActivateQuestAction}
        onInlineNavigate={onInlineNavigate}
      />
    );
  }
  if (result.kind === "session") {
    return (
      <SessionResultRow
        session={result.session}
        query={query}
        selected={selected}
        onPointerMove={onPointerMove}
        onOpen={onOpen}
      />
    );
  }
  return (
    <MessageResultRow
      message={result.message}
      query={query}
      selected={selected}
      onPointerMove={onPointerMove}
      onOpen={onOpen}
    />
  );
}

function ResultOption({
  selected,
  onPointerMove,
  onOpen,
  children,
}: {
  selected: boolean;
  onPointerMove: () => void;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      onPointerMove={onPointerMove}
      onClick={onOpen}
      className={`w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-cc-primary/35 bg-cc-primary/12"
          : "border-transparent bg-transparent hover:border-cc-border hover:bg-cc-hover/70"
      }`}
    >
      {children}
    </div>
  );
}

function QuestResultRow({
  quest,
  sessions,
  selected,
  copied,
  actionMenu,
  onPointerMove,
  onOpen,
  onCopyQuestId,
  onOpenActionMenu,
  onSelectAction,
  onActivateAction,
  onInlineNavigate,
}: {
  quest: QuestmasterTask;
  sessions: SdkSessionInfo[];
  selected: boolean;
  copied: boolean;
  actionMenu: { resultId: string; selectedActionIndex: number } | null;
  onPointerMove: () => void;
  onOpen: () => void;
  onCopyQuestId: (questId: string) => void;
  onOpenActionMenu: () => void;
  onSelectAction: (selectedActionIndex: number) => void;
  onActivateAction: (quest: QuestmasterTask, action: QuestResultAction) => void;
  onInlineNavigate: () => void;
}) {
  const leaderSessionId = getQuestLeaderSessionId(quest);
  const workerSessionId = getQuestOwnerSessionId(quest);
  const leaderSessionNum = sessionNumForId(sessions, leaderSessionId);
  const workerSessionNum = sessionNumForId(sessions, workerSessionId);
  const actions = getQuestResultActions(quest, sessions);
  const selectedActionIndex = Math.min(actionMenu?.selectedActionIndex ?? 0, actions.length - 1);
  function handleInteractiveKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  }
  function handleCopyClick(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    onCopyQuestId(quest.questId);
  }
  function handleOpenActionMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    onOpenActionMenu();
  }
  return (
    <ResultOption selected={selected} onPointerMove={onPointerMove} onOpen={onOpen}>
      <div className="relative flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <QuestInlineLink
              questId={quest.questId}
              stopPropagation
              hoverCardZIndexClassName="z-[90]"
              onNavigate={onInlineNavigate}
              className="shrink-0 font-mono-code text-[11px] text-cc-primary hover:underline"
            />
            <button
              type="button"
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-transparent text-cc-muted transition-colors hover:border-cc-border hover:bg-cc-hover hover:text-cc-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70 ${
                copied ? "text-emerald-300" : ""
              }`}
              aria-label={`Copy quest ID ${quest.questId}`}
              title={copied ? `Copied ${quest.questId}` : `Copy ${quest.questId}`}
              onKeyDown={handleInteractiveKeyDown}
              onClick={handleCopyClick}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
                <rect x="5" y="3" width="8" height="10" rx="1.5" />
                <path d="M3 11V5.5A2.5 2.5 0 015.5 3H9" />
              </svg>
            </button>
            <span className="truncate text-sm font-medium text-cc-fg">{quest.title}</span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-cc-muted">
            <span className="rounded-md bg-cc-hover px-1.5 py-0.5">{quest.status}</span>
            {leaderSessionId && (
              <span className="inline-flex items-center gap-1 rounded-md border border-cc-border px-1.5 py-0.5">
                <span>leader</span>
                <SessionInlineLink
                  sessionId={leaderSessionId}
                  sessionNum={leaderSessionNum}
                  threadKey={quest.questId}
                  stopPropagation
                  hoverCardZIndexClassName="z-[90]"
                  onNavigate={onInlineNavigate}
                  className="font-mono-code text-cc-primary hover:underline"
                >
                  {`#${leaderSessionNum ?? "?"}`}
                </SessionInlineLink>
              </span>
            )}
            {workerSessionId && (
              <span className="inline-flex items-center gap-1 rounded-md border border-cc-border px-1.5 py-0.5">
                <span>worker</span>
                <SessionInlineLink
                  sessionId={workerSessionId}
                  sessionNum={workerSessionNum}
                  stopPropagation
                  hoverCardZIndexClassName="z-[90]"
                  onNavigate={onInlineNavigate}
                  className="font-mono-code text-cc-primary hover:underline"
                >
                  {`#${workerSessionNum ?? "?"}`}
                </SessionInlineLink>
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[11px] text-cc-muted">
          <span>{formatRelativeTime(questRecency(quest))}</span>
          <button
            type="button"
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70 ${
              selected || actionMenu ? "text-cc-fg" : "text-cc-muted/75"
            }`}
            aria-label={`More options for ${quest.questId}`}
            title="More options (Right Arrow)"
            onKeyDown={handleInteractiveKeyDown}
            onClick={handleOpenActionMenu}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
              <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        {actionMenu && (
          <div
            role="menu"
            aria-label={`Actions for ${quest.questId}`}
            className="absolute right-0 top-8 z-[90] min-w-44 rounded-lg border border-cc-border bg-cc-card py-1 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            {actions.map((action, index) => {
              const actionSelected = index === selectedActionIndex;
              return (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  className={`flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                    actionSelected ? "bg-cc-primary/15 text-cc-primary" : "text-cc-fg hover:bg-cc-hover"
                  }`}
                  onMouseEnter={() => onSelectAction(index)}
                  onKeyDown={handleInteractiveKeyDown}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onActivateAction(quest, action);
                  }}
                >
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </ResultOption>
  );
}

function SessionResultRow({
  session,
  query,
  selected,
  onPointerMove,
  onOpen,
}: {
  session: SdkSessionInfo;
  query: string;
  selected: boolean;
  onPointerMove: () => void;
  onOpen: () => void;
}) {
  const displayName = sessionDisplayName(session);
  const nameParts = getHighlightParts(displayName, query);
  const metadata = [
    session.gitBranch ? `branch ${session.gitBranch}` : null,
    session.cwd || session.repoRoot || null,
    session.backendType ?? null,
  ].filter((item): item is string => Boolean(item));

  return (
    <ResultOption selected={selected} onPointerMove={onPointerMove} onOpen={onOpen}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-md bg-cc-hover px-1.5 py-0.5 font-mono-code text-[10px] text-cc-muted">
              {typeof session.sessionNum === "number" ? `#${session.sessionNum}` : "session"}
            </span>
            <span className="truncate text-sm font-medium text-cc-fg">
              {nameParts.map((part, index) =>
                part.matched ? (
                  <mark key={`${part.text}-${index}`} className="rounded-[2px] bg-amber-300/25 px-0.5 text-amber-100">
                    {part.text}
                  </mark>
                ) : (
                  <span key={`${part.text}-${index}`}>{part.text}</span>
                ),
              )}
            </span>
          </div>
          {metadata.length > 0 && (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-cc-muted">
              {metadata.map((item) => (
                <span key={item} className="max-w-[320px] truncate rounded-md border border-cc-border px-1.5 py-0.5">
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-[11px] text-cc-muted">{formatRelativeTime(sessionRecency(session))}</div>
      </div>
    </ResultOption>
  );
}

function MessageResultRow({
  message,
  query,
  selected,
  onPointerMove,
  onOpen,
}: {
  message: MessageSearchResult;
  query: string;
  selected: boolean;
  onPointerMove: () => void;
  onOpen: () => void;
}) {
  const parts = getHighlightParts(message.snippet, query);
  const badgeLabel = message.category;
  return (
    <ResultOption selected={selected} onPointerMove={onPointerMove} onOpen={onOpen}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-cc-hover px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cc-muted">
              {badgeLabel}
            </span>
            {message.sourceLabel && (
              <span className="rounded-md border border-cc-border px-1.5 py-0.5 text-[10px] text-cc-muted">
                {message.sourceLabel}
              </span>
            )}
            <span className="text-[11px] text-cc-muted">{formatRelativeTime(message.timestamp)}</span>
          </div>
          <div className="mt-1 line-clamp-2 text-sm text-cc-fg">
            {parts.map((part, index) =>
              part.matched ? (
                <mark key={`${part.text}-${index}`} className="rounded-[2px] bg-amber-300/25 px-0.5 text-amber-100">
                  {part.text}
                </mark>
              ) : (
                <span key={`${part.text}-${index}`}>{part.text}</span>
              ),
            )}
          </div>
        </div>
      </div>
    </ResultOption>
  );
}
