import { memo, useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { questIdFromHash, withoutQuestIdInHash } from "../utils/routing.js";
import { SessionNumChip } from "./SessionNumChip.js";
import {
  loadQuestmasterViewState,
  saveQuestmasterViewState,
  toggleStatusFilter,
} from "../utils/questmaster-view-state.js";
import type { QuestmasterCollapsedGroup } from "../utils/questmaster-view-state.js";
import { QUEST_STATUS_THEME, type QuestStatusTheme } from "../utils/quest-status-theme.js";
import {
  timeAgo,
  verificationProgress,
  getQuestOwnerSessionId,
  getQuestLeaderSessionId,
  CopyableQuestId,
} from "../utils/quest-helpers.js";
import { buildQuestJourneyContextByQuestId, type QuestJourneyContext } from "../utils/quest-journey-context.js";
import { getQuestDebriefTldr } from "../utils/quest-editor-helpers.js";
import { QuestPhaseScanLines } from "./QuestPhaseScanLines.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { QuestmasterCreateForm } from "./QuestmasterCreateForm.js";
import {
  CompactQuestTable,
  QuestStatusHoverTarget,
  getQuestmasterDisplayStatus,
  nextCompactSort,
  normalizeCompactSort,
  questRecencyTs,
  renderSearchHighlightText,
} from "./QuestmasterCompactTable.js";
import type {
  QuestListPage,
  QuestListPageOptions,
  QuestmasterCompactSort,
  QuestmasterCompactSortColumn,
  QuestmasterViewMode,
} from "../api.js";
import type { QuestmasterTask, QuestStatus, QuestFeedbackEntry } from "../types.js";
import { multiWordMatch } from "../../shared/search-utils.js";

// ─── Status config ──────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<QuestStatus, QuestStatusTheme> = {
  ...QUEST_STATUS_THEME,
  refined: { ...QUEST_STATUS_THEME.refined, label: "Actionable" },
  done: { ...QUEST_STATUS_THEME.done, label: "Completed" },
};

const ALL_STATUSES: QuestStatus[] = ["idea", "refined", "in_progress", "done"];

// Display order: most-needs-attention → least
const DISPLAY_ORDER: QuestStatus[] = ["in_progress", "refined", "idea", "done"];

const FILTER_TABS: Array<{ value: QuestStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "idea", label: "Idea" },
  { value: "refined", label: "Actionable" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Completed" },
];

const QUEST_PAGE_SIZE = 50;
const MAX_RENDERED_QUESTS = 150;
const SEARCH_DEBOUNCE_MS = 500;

// ─── Helpers ────────────────────────────────────────────────────────────────

function classifyQuestSearchToken(token: string): { kind: "positiveTag" | "negatedTag" | "text"; value: string } {
  const negatedMatch = token.match(/^(?:!#|-#)([^\s#]*)$/);
  if (negatedMatch) {
    const value = negatedMatch[1].toLowerCase();
    if (!/^\d/.test(value)) return { kind: "negatedTag", value };
  }
  const positiveMatch = token.match(/^#([^\s#]*)$/);
  if (positiveMatch) {
    const value = positiveMatch[1].toLowerCase();
    if (!/^\d/.test(value)) return { kind: "positiveTag", value };
  }
  return { kind: "text", value: token };
}

function getTrailingQuestSearchToken(query: string): { kind: "positiveTag" | "negatedTag"; value: string } | null {
  const match = query.match(/(?:^|\s)(\S*)$/);
  if (!match) return null;
  const rawToken = match[1];
  if (!rawToken) return null;
  const classified = classifyQuestSearchToken(rawToken);
  if (classified.kind === "text") return null;
  return { kind: classified.kind, value: classified.value };
}

function parseQuestSearchQuery(query: string): { searchText: string; negatedTags: Set<string> } {
  const negatedTags = new Set<string>();
  const positiveTokens: string[] = [];
  let trailingPositiveTag = false;

  const tokens = query.trim().split(/\s+/).filter(Boolean);
  for (const [index, token] of tokens.entries()) {
    const classified = classifyQuestSearchToken(token);
    if (classified.kind === "negatedTag") {
      if (classified.value) negatedTags.add(classified.value);
      continue;
    }
    if (classified.kind === "positiveTag" && index === tokens.length - 1) {
      trailingPositiveTag = true;
    }
    positiveTokens.push(token);
  }

  // Preserve the existing positive #tag autocomplete flow by keeping a trailing
  // positive hashtag token out of plain-text matching/highlighting until the
  // user selects it into the positive tag pill set.
  const searchText = (trailingPositiveTag ? positiveTokens.slice(0, -1) : positiveTokens).join(" ").trim();
  return { searchText, negatedTags };
}

function getQuestSearchAutocompleteMatches(query: string, allTags: string[], selectedTags: Set<string>): string[] {
  const q = query.toLowerCase();
  return allTags.filter((t) => (!q || t.includes(q)) && !selectedTags.has(t));
}

function mergeUniqueQuestPage(
  existing: QuestmasterTask[],
  incoming: QuestmasterTask[],
  direction: "append" | "prepend",
) {
  const merged = direction === "prepend" ? [...incoming, ...existing] : [...existing, ...incoming];
  const seen = new Set<string>();
  return merged.filter((quest) => {
    const key = quest.questId.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fallbackQuestPage(quests: QuestmasterTask[]): QuestListPage {
  return {
    quests,
    total: quests.length,
    offset: 0,
    limit: QUEST_PAGE_SIZE,
    hasMore: quests.length > QUEST_PAGE_SIZE,
    nextOffset: quests.length > QUEST_PAGE_SIZE ? QUEST_PAGE_SIZE : null,
    previousOffset: null,
    counts: {
      all: quests.length,
      idea: quests.filter((quest) => quest.status === "idea").length,
      refined: quests.filter((quest) => quest.status === "refined").length,
      in_progress: quests.filter((quest) => quest.status === "in_progress").length,
      done: quests.filter((quest) => quest.status === "done").length,
    },
    allTags: Array.from(new Set(quests.flatMap((quest) => quest.tags ?? []).map((tag) => tag.toLowerCase()))).sort(
      (a, b) => a.localeCompare(b),
    ),
  };
}

function questMatchesCurrentPageCorpus(
  quest: QuestmasterTask,
  selectedTags: Set<string>,
  negatedTags: Set<string>,
  searchText: string,
) {
  const questTags = new Set((quest.tags ?? []).map((tag) => tag.toLowerCase()));
  if (selectedTags.size > 0 && !Array.from(selectedTags).some((tag) => questTags.has(tag.toLowerCase()))) return false;
  if (Array.from(negatedTags).some((tag) => questTags.has(tag.toLowerCase()))) return false;

  const query = searchText.trim();
  if (!query) return true;
  const doneText =
    quest.status === "done" && quest.cancelled !== true ? `${quest.debriefTldr ?? ""}\n${quest.debrief ?? ""}` : "";
  const feedbackText =
    "feedback" in quest ? (quest.feedback ?? []).flatMap((entry) => [entry.tldr ?? "", entry.text]) : [];
  return multiWordMatch(
    `${quest.questId}\n${quest.title}\n${quest.tldr ?? ""}\n${"description" in quest ? quest.description || "" : ""}\n${doneText}\n${feedbackText.join("\n")}`,
    query,
  );
}

function questMatchesCurrentVisibleFilters(
  quest: QuestmasterTask,
  filter: Set<QuestStatus>,
  allSelected: boolean,
  selectedTags: Set<string>,
  negatedTags: Set<string>,
  searchText: string,
) {
  if (!questMatchesCurrentPageCorpus(quest, selectedTags, negatedTags, searchText)) return false;
  return allSelected || filter.has(quest.status);
}

function QuestTldrMarkdown({
  text,
  searchText,
  className = "",
}: {
  text: string;
  searchText: string;
  className?: string;
}) {
  return (
    <div
      className={`truncate text-cc-muted [&_.markdown-body]:truncate [&_.markdown-body]:text-inherit [&_.markdown-body]:leading-snug [&_.markdown-body_p]:mb-0 [&_.markdown-body_p]:truncate ${className}`}
      onClick={(event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest("a,button")) event.stopPropagation();
      }}
    >
      <MarkdownContent
        text={text}
        size="sm"
        variant="conservative"
        searchHighlight={searchText ? { query: searchText, mode: "strict", isCurrent: false } : null}
      />
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function QuestmasterPage({ isActive = true }: { isActive?: boolean }) {
  const initialViewStateRef = useRef<ReturnType<typeof loadQuestmasterViewState> | undefined>(undefined);
  if (initialViewStateRef.current === undefined) {
    initialViewStateRef.current = loadQuestmasterViewState();
  }
  const initialViewState = initialViewStateRef.current;
  const restoreScrollTopRef = useRef<number | null>(initialViewState?.scrollTop ?? null);
  const hasHydratedViewStateRef = useRef(restoreScrollTopRef.current === null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  const storeQuests = useStore((s) => s.quests);
  const setQuests = useStore((s) => s.setQuests);
  const questOverlayId = useStore((s) => s.questOverlayId);
  const sessionBoards = useStore((s) => s.sessionBoards);
  const sessionCompletedBoards = useStore((s) => s.sessionCompletedBoards);

  const [filter, setFilter] = useState<Set<QuestStatus>>(() => {
    const persisted = initialViewState?.statusFilter;
    return persisted ? new Set(persisted) : new Set(ALL_STATUSES);
  });
  const allSelected = filter.size === ALL_STATUSES.length;
  const [viewModeSaving, setViewModeSaving] = useState(false);
  const [compactSortSaving, setCompactSortSaving] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const initialPage = useMemo(() => fallbackQuestPage(storeQuests), []);
  const [pagedQuests, setPagedQuests] = useState<QuestmasterTask[]>(initialPage.quests.slice(0, QUEST_PAGE_SIZE));
  const [pageInfo, setPageInfo] = useState<QuestListPage>(initialPage);
  const [windowOffset, setWindowOffset] = useState(0);
  const [questsLoading, setQuestsLoading] = useState(false);
  const [loadingMoreDirection, setLoadingMoreDirection] = useState<"next" | "previous" | null>(null);
  const [debouncedSearchText, setDebouncedSearchText] = useState("");
  const pageRequestSeqRef = useRef(0);
  const visibleWindowRef = useRef({ offset: 0, count: 0 });

  // Search, tags, and view mode -- local state initialized from store, synced back on every change.
  // Local state ensures React re-renders on every keystroke; store persists across navigation.
  const [searchQuery, setSearchQueryLocal] = useState(() => useStore.getState().questmasterSearchQuery ?? "");
  const [selectedTags, setSelectedTagsLocal] = useState<Set<string>>(
    () => new Set(useStore.getState().questmasterSelectedTags ?? []),
  );
  const [viewMode, setViewModeLocal] = useState<QuestmasterViewMode>(
    () => useStore.getState().questmasterViewMode ?? "cards",
  );
  const [compactSort, setCompactSortLocal] = useState<QuestmasterCompactSort>(() =>
    normalizeCompactSort(useStore.getState().questmasterCompactSort),
  );
  const setSearchQuery = useCallback((val: string) => {
    setSearchQueryLocal(val);
    useStore.getState().setQuestmasterSearchQuery(val);
  }, []);
  const setSelectedTags = useCallback((update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setSelectedTagsLocal((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      useStore.getState().setQuestmasterSelectedTags(Array.from(next));
      return next;
    });
  }, []);
  const setViewMode = useCallback((mode: QuestmasterViewMode) => {
    setViewModeLocal((current) => (current === mode ? current : mode));
    useStore.getState().setQuestmasterViewMode(mode);
  }, []);
  const setCompactSort = useCallback((sort: QuestmasterCompactSort) => {
    const normalized = normalizeCompactSort(sort);
    setCompactSortLocal((current) =>
      current.column === normalized.column && current.direction === normalized.direction ? current : normalized,
    );
    useStore.getState().setQuestmasterCompactSort(normalized);
  }, []);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Status dropdown state
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // Hashtag autocomplete state
  const [hashtagQuery, setHashtagQuery] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [searchFocused, setSearchFocused] = useState(false);
  const autocompleteRef = useRef<HTMLDivElement>(null);

  // Error state
  const [error, setError] = useState("");

  // Collapsed phase groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<QuestmasterCollapsedGroup>>(
    () => new Set(initialViewState?.collapsedGroups ?? []),
  );
  const parsedSearch = useMemo(() => parseQuestSearchQuery(searchQuery), [searchQuery]);
  const searchText = parsedSearch.searchText;
  const negatedTags = parsedSearch.negatedTags;
  const negatedTagKey = Array.from(negatedTags).sort().join("\n");
  const negatedTagList = useMemo(() => (negatedTagKey ? negatedTagKey.split("\n") : []), [negatedTagKey]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedSearchText(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [searchText]);

  useEffect(() => {
    visibleWindowRef.current = { offset: windowOffset, count: pagedQuests.length };
  }, [windowOffset, pagedQuests.length]);

  const loadQuestPage = useCallback(
    async (offset: number, mode: "replace" | "append" | "prepend", pageLimit = QUEST_PAGE_SIZE) => {
      const requestSeq = ++pageRequestSeqRef.current;
      const loadingDirection = mode === "append" ? "next" : mode === "prepend" ? "previous" : null;
      if (mode === "replace") setQuestsLoading(true);
      else setLoadingMoreDirection(loadingDirection);
      setError("");

      try {
        const status = allSelected ? undefined : Array.from(filter).join(",");
        const pageOptions: Omit<QuestListPageOptions, "offset"> = {
          limit: pageLimit,
          status,
          tags: Array.from(selectedTags),
          excludeTags: negatedTagList,
          text: debouncedSearchText,
          sortColumn: debouncedSearchText ? undefined : viewMode === "compact" ? compactSort.column : "cards",
          sortDirection: debouncedSearchText ? undefined : viewMode === "compact" ? compactSort.direction : "asc",
        };
        let page = await api.listQuestPage({ ...pageOptions, offset });
        if (page.quests.length === 0 && page.total > 0 && offset > 0) {
          page = await api.listQuestPage({ ...pageOptions, offset: Math.max(0, page.total - pageLimit) });
        }
        if (requestSeq !== pageRequestSeqRef.current) return;

        setPageInfo(page);
        setPagedQuests((current) => {
          if (mode === "replace") {
            setWindowOffset(page.offset);
            return page.quests;
          }
          const merged = mergeUniqueQuestPage(current, page.quests, mode);
          if (merged.length <= MAX_RENDERED_QUESTS) return merged;
          if (mode === "append") {
            const dropped = merged.length - MAX_RENDERED_QUESTS;
            setWindowOffset((currentOffset) => currentOffset + dropped);
            return merged.slice(-MAX_RENDERED_QUESTS);
          }
          setWindowOffset(page.offset);
          return merged.slice(0, MAX_RENDERED_QUESTS);
        });
      } catch (err) {
        if (requestSeq === pageRequestSeqRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load quests");
        }
      } finally {
        if (requestSeq === pageRequestSeqRef.current) {
          setQuestsLoading(false);
          setLoadingMoreDirection(null);
        }
      }
    },
    [allSelected, compactSort, debouncedSearchText, filter, negatedTagList, selectedTags, viewMode],
  );

  const refreshVisibleQuestWindow = useCallback(() => {
    const { offset, count } = visibleWindowRef.current;
    const limit = Math.max(QUEST_PAGE_SIZE, Math.min(MAX_RENDERED_QUESTS, count || QUEST_PAGE_SIZE));
    return loadQuestPage(offset, "replace", limit);
  }, [loadQuestPage]);

  // Load quests on mount, pause polling entirely while hidden, and resume with
  // a foreground refresh when the tab becomes visible again.
  useEffect(() => {
    if (!isActive) return;
    let timeoutId: number | null = null;

    const scheduleNextPoll = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (document.visibilityState !== "visible") return;
      timeoutId = window.setTimeout(() => {
        void refreshVisibleQuestWindow();
        scheduleNextPoll();
      }, 5_000);
    };

    void loadQuestPage(0, "replace");
    scheduleNextPoll();

    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void refreshVisibleQuestWindow();
        scheduleNextPoll();
      } else if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);

    function handleFocus() {
      void refreshVisibleQuestWindow();
      scheduleNextPoll();
    }
    window.addEventListener("focus", handleFocus);

    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [isActive, loadQuestPage, refreshVisibleQuestWindow]);

  const refreshServerQuestmasterSettings = useCallback(async () => {
    try {
      const settings = await api.getSettings();
      setViewMode(settings.questmasterViewMode);
      setCompactSort(normalizeCompactSort(settings.questmasterCompactSort));
    } catch (err) {
      console.warn("[questmaster] failed to load server Questmaster settings", err);
    }
  }, [setCompactSort]);

  // The compact/card preference is server-owned. Refresh it on page activation
  // and on focus so multiple browser tabs converge to the latest saved mode.
  useEffect(() => {
    if (!isActive) return;
    refreshServerQuestmasterSettings();

    function handleFocus() {
      refreshServerQuestmasterSettings();
    }
    function handleVisibility() {
      if (document.visibilityState === "visible") refreshServerQuestmasterSettings();
    }

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [isActive, refreshServerQuestmasterSettings]);

  // Hydrate persisted scroll position once enough content has rendered.
  useEffect(() => {
    if (!isActive) return;
    if (hasHydratedViewStateRef.current) return;
    const el = scrollContainerRef.current;
    const savedScrollTop = restoreScrollTopRef.current;
    if (!el || savedScrollTop === null) return;
    if (questsLoading && pagedQuests.length === 0) return;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(savedScrollTop, maxScrollTop);
    hasHydratedViewStateRef.current = true;
    restoreScrollTopRef.current = null;
  }, [isActive, questsLoading, pagedQuests.length]);

  // Persist view state on scroll and before unmount so navigation preserves context.
  useEffect(() => {
    if (!isActive) return;
    const el = scrollContainerRef.current;
    if (!el) return;

    let rafId: number | null = null;
    const persistNow = () => {
      if (!hasHydratedViewStateRef.current) return;
      saveQuestmasterViewState({
        scrollTop: el.scrollTop,
        collapsedGroups: Array.from(collapsedGroups),
        statusFilter: Array.from(filter),
      });
    };

    const onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        persistNow();
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
      persistNow();
    };
  }, [isActive, collapsedGroups, filter]);

  // Persist immediately when collapse state or filter changes.
  useEffect(() => {
    if (!isActive) return;
    if (!hasHydratedViewStateRef.current) return;
    saveQuestmasterViewState({
      scrollTop: scrollContainerRef.current?.scrollTop ?? 0,
      collapsedGroups: Array.from(collapsedGroups),
      statusFilter: Array.from(filter),
    });
  }, [isActive, collapsedGroups, filter]);
  // Deep-link support: any hash with ?quest=q-123 should focus and expand that quest.
  useEffect(() => {
    const targetQuestId = questIdFromHash(hash);
    if (!targetQuestId) return;
    const targetQuest = pagedQuests.find((q) => q.questId === targetQuestId);
    setFilter(new Set(ALL_STATUSES));
    // Ensure deep-linked quests are visible in the list as well as the modal.
    useStore.getState().openQuestOverlay(targetQuestId);
    setShowCreateForm(false);

    if (!targetQuest) {
      let cancelled = false;
      void api
        .getQuest(targetQuestId)
        .then((quest) => {
          if (cancelled) return;
          setPagedQuests((current) =>
            current.some((existing) => existing.questId === quest.questId) ? current : [quest, ...current],
          );
          setCollapsedGroups((prev) => {
            if (!prev.has(quest.status)) return prev;
            const next = new Set(prev);
            next.delete(quest.status);
            return next;
          });
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }

    setCollapsedGroups((prev) => {
      const targetGroup = targetQuest.status;
      if (!prev.has(targetGroup)) return prev;
      const next = new Set(prev);
      next.delete(targetGroup);
      return next;
    });
    const scrollFrameId = window.requestAnimationFrame(() => {
      const el = document.querySelector(`[data-quest-id="${targetQuestId}"]`);
      if (el instanceof HTMLElement && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    return () => window.cancelAnimationFrame(scrollFrameId);
  }, [hash, pagedQuests]);

  const handleExpand = useCallback(
    (quest: QuestmasterTask) => {
      const store = useStore.getState();
      if (store.questOverlayId === quest.questId) {
        const currentHash = window.location.hash || "#/";
        const nextHash = withoutQuestIdInHash(currentHash);
        if (nextHash !== currentHash) {
          window.location.hash = nextHash.startsWith("#") ? nextHash.slice(1) : nextHash;
        }
        store.closeQuestOverlay();
        return;
      }
      store.openQuestOverlay(quest.questId, searchText || undefined);
    },
    [searchText],
  );

  // ─── Actions ──────────────────────────────────────────────────────────

  const handleCreateQuestCreated = useCallback(
    (createdQuest: QuestmasterTask) => {
      const currentQuests = useStore.getState().quests;
      setQuests(
        [createdQuest, ...currentQuests.filter((q) => q.questId !== createdQuest.questId)].sort(
          (a, b) => questRecencyTs(b) - questRecencyTs(a),
        ),
      );
      const matchesCurrentCorpus = questMatchesCurrentPageCorpus(createdQuest, selectedTags, negatedTags, searchText);
      const matchesVisibleFilters = questMatchesCurrentVisibleFilters(
        createdQuest,
        filter,
        allSelected,
        selectedTags,
        negatedTags,
        searchText,
      );
      const shouldInsertIntoWindow = matchesVisibleFilters && windowOffset === 0;
      if (shouldInsertIntoWindow) {
        setPagedQuests((current) =>
          [createdQuest, ...current.filter((q) => q.questId !== createdQuest.questId)].slice(0, MAX_RENDERED_QUESTS),
        );
      }
      setPageInfo((current) => ({
        ...current,
        quests: shouldInsertIntoWindow
          ? [createdQuest, ...current.quests.filter((q) => q.questId !== createdQuest.questId)].slice(0, current.limit)
          : current.quests,
        total: current.total + (matchesVisibleFilters ? 1 : 0),
        counts: matchesCurrentCorpus
          ? {
              ...current.counts,
              all: current.counts.all + 1,
              [createdQuest.status]: current.counts[createdQuest.status] + 1,
            }
          : current.counts,
        allTags: Array.from(
          new Set([...current.allTags, ...(createdQuest.tags ?? [])].map((tag) => tag.toLowerCase())),
        ).sort((a, b) => a.localeCompare(b)),
      }));
      setShowCreateForm(false);
      useStore.getState().openQuestOverlay(createdQuest.questId);
    },
    [allSelected, filter, negatedTags, searchText, selectedTags, setQuests, windowOffset],
  );
  const handleCreateQuestCancel = useCallback(() => {
    setShowCreateForm(false);
  }, []);

  async function handleViewModeChange(nextMode: QuestmasterViewMode) {
    if (nextMode === viewMode) return;
    const previousMode = viewMode;
    setViewMode(nextMode);
    setViewModeSaving(true);
    setError("");
    try {
      const settings = await api.updateSettings({ questmasterViewMode: nextMode });
      setViewMode(settings.questmasterViewMode);
    } catch (err) {
      setViewMode(previousMode);
      setError(err instanceof Error ? err.message : "Failed to save Questmaster view mode");
    } finally {
      setViewModeSaving(false);
    }
  }

  async function handleCompactSortChange(column: QuestmasterCompactSortColumn) {
    const previousSort = compactSort;
    const nextSort = nextCompactSort(compactSort, column);
    setCompactSort(nextSort);
    setCompactSortSaving(true);
    setError("");
    try {
      const settings = await api.updateSettings({ questmasterCompactSort: nextSort });
      setCompactSort(normalizeCompactSort(settings.questmasterCompactSort));
    } catch (err) {
      setCompactSort(previousSort);
      setError(err instanceof Error ? err.message : "Failed to save Questmaster compact sort");
    } finally {
      setCompactSortSaving(false);
    }
  }

  // ─── Derived tag list ─────────────────────────────────────────────────

  const allTags = pageInfo.allTags;

  // Clean up stale selected tags when tags disappear from dataset
  useEffect(() => {
    if (selectedTags.size === 0) return;
    const currentTagSet = new Set(allTags);
    const hasStale = Array.from(selectedTags).some((t) => !currentTagSet.has(t));
    if (hasStale) {
      setSelectedTags((prev) => new Set(Array.from(prev).filter((t) => currentTagSet.has(t))));
    }
  }, [allTags, selectedTags]);

  // Close status dropdown on click-outside or Escape
  useEffect(() => {
    if (!statusDropdownOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setStatusDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStatusDropdownOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [statusDropdownOpen]);

  // Compute autocomplete matches for hashtag query
  const autocompleteMatches = useMemo(() => {
    const activeSearchToken = getTrailingQuestSearchToken(searchQuery);
    if (!activeSearchToken) return [];
    return getQuestSearchAutocompleteMatches(hashtagQuery, allTags, selectedTags);
  }, [searchQuery, hashtagQuery, allTags, selectedTags]);
  const activeSearchToken = useMemo(() => getTrailingQuestSearchToken(searchQuery), [searchQuery]);

  function replaceTrailingSearchToken(query: string, replacement: string): string {
    const match = query.match(/^(.*?)(\S*)$/s);
    if (!match) return replacement;
    const prefix = match[1];
    return `${prefix}${replacement}`;
  }

  // ─── Backend paging result shaping ────────────────────────────────────

  const searchNormalized = searchText.trim();
  const counts: Record<string, number> = pageInfo.counts;
  const filtered = pagedQuests;

  // Pre-compute the single selected status (if exactly one) for the filter pill label
  const singleFilterStatus = filter.size === 1 ? [...filter][0] : null;
  const filterPillCount = allSelected
    ? (counts.all ?? 0)
    : singleFilterStatus
      ? (counts[singleFilterStatus] ?? 0)
      : ALL_STATUSES.reduce((sum, s) => sum + (filter.has(s) ? (counts[s] ?? 0) : 0), 0);

  type QuestSection = {
    key: string;
    label: string;
    dotClass: string;
    textClass: string;
    quests: QuestmasterTask[];
    collapseGroup?: QuestmasterCollapsedGroup;
  };

  const sortByRecencyDesc = (items: QuestmasterTask[]): QuestmasterTask[] =>
    [...items].sort((a, b) => questRecencyTs(b) - questRecencyTs(a));
  const journeyContextByQuestId = useMemo(
    () => buildQuestJourneyContextByQuestId(pagedQuests, sessionBoards, sessionCompletedBoards),
    [pagedQuests, sessionBoards, sessionCompletedBoards],
  );
  const compactQuests = filtered;

  const questSections: QuestSection[] = [];
  if (searchNormalized) {
    questSections.push({
      key: "search_results",
      label: "Search Results",
      dotClass: "bg-cc-primary",
      textClass: "text-cc-fg",
      quests: filtered,
    });
  }

  for (const status of searchNormalized ? [] : allSelected ? DISPLAY_ORDER : ALL_STATUSES) {
    const sectionQuests = filtered.filter((q) => q.status === status);
    if (sectionQuests.length === 0) continue;
    const cfg = STATUS_CONFIG[status];
    questSections.push({
      key: status,
      label: cfg.label,
      dotClass: cfg.dot,
      textClass: cfg.text,
      quests: sortByRecencyDesc(sectionQuests),
      // Enable collapsible groups when multiple statuses are visible
      ...(filter.size > 1 ? { collapseGroup: status } : {}),
    });
  }

  const previousPageOffset = windowOffset > 0 ? Math.max(0, windowOffset - QUEST_PAGE_SIZE) : null;
  const nextPageOffset = windowOffset + pagedQuests.length < pageInfo.total ? windowOffset + pagedQuests.length : null;

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div ref={scrollContainerRef} className="h-full bg-cc-bg overflow-y-auto">
      {/* ─── Sticky header ─────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-cc-bg">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 pt-4 sm:pt-6">
          {/* Title row + New Quest button */}
          <div className="mb-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-semibold text-cc-fg">Quests</h1>
              <p className="mt-0.5 text-xs sm:text-sm text-cc-muted hidden sm:block">
                Track tasks from idea to completion. Sessions claim quests to work on.
              </p>
            </div>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="py-2 px-3 text-sm font-medium rounded-[10px] bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors duration-150 flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                <path d="M8 3v10M3 8h10" />
              </svg>
              <span className="hidden sm:inline">New Quest</span>
            </button>
          </div>

          {/* Status dropdown + Search bar */}
          <div className="flex items-center gap-2">
            {/* Server-persisted view mode toggle */}
            <div
              className="flex items-center rounded-lg border border-cc-border bg-cc-input-bg p-0.5 shrink-0"
              aria-label="Quest view mode"
            >
              {(["cards", "compact"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleViewModeChange(mode)}
                  disabled={viewModeSaving}
                  aria-pressed={viewMode === mode}
                  className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer disabled:cursor-wait ${
                    viewMode === mode
                      ? "bg-cc-hover text-cc-fg shadow-sm"
                      : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover/50"
                  }`}
                >
                  {mode === "cards" ? "Cards" : "Compact"}
                </button>
              ))}
            </div>

            {/* Status filter dropdown (multi-select) */}
            <div ref={statusDropdownRef} className="relative shrink-0">
              <button
                onClick={() => setStatusDropdownOpen((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-cc-hover border border-cc-border hover:border-cc-border text-cc-fg transition-colors cursor-pointer"
              >
                {/* Filter pill label: All / single status / multi dots */}
                {allSelected ? (
                  <span>All</span>
                ) : singleFilterStatus ? (
                  <>
                    <span className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[singleFilterStatus].dot}`} />
                    <span>{STATUS_CONFIG[singleFilterStatus].label}</span>
                  </>
                ) : (
                  <span className="flex items-center gap-0.5">
                    {ALL_STATUSES.filter((s) => filter.has(s)).map((s) => (
                      <span key={s} className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[s].dot}`} />
                    ))}
                  </span>
                )}
                <span className="text-[10px] text-cc-muted">{filterPillCount}</span>
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="w-3 h-3 text-cc-muted"
                >
                  <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {statusDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 w-48 bg-cc-card border border-cc-border rounded-lg shadow-xl z-30 py-1 overflow-hidden">
                  {FILTER_TABS.map((tab) => {
                    const isAll = tab.value === "all";
                    const isActive = isAll ? allSelected : filter.has(tab.value as QuestStatus);
                    const count = counts[tab.value] ?? 0;
                    return (
                      <button
                        key={tab.value}
                        onClick={() => {
                          if (isAll) {
                            setFilter(new Set(ALL_STATUSES));
                          } else {
                            setFilter((prev) => toggleStatusFilter(prev, tab.value as QuestStatus));
                          }
                        }}
                        className={`w-full px-3 py-1.5 text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                          isActive ? "bg-cc-primary/10 text-cc-primary" : "text-cc-fg hover:bg-cc-hover"
                        }`}
                      >
                        {/* Checkbox indicator */}
                        {isAll ? (
                          <span className="w-3.5 h-3.5 flex items-center justify-center">
                            {allSelected ? (
                              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary">
                                <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                              </svg>
                            ) : (
                              <span className="w-3 h-3 rounded-sm border border-cc-border" />
                            )}
                          </span>
                        ) : (
                          <span className="w-3.5 h-3.5 flex items-center justify-center">
                            {isActive ? (
                              <span className={`w-2 h-2 rounded-full ${STATUS_CONFIG[tab.value as QuestStatus].dot}`} />
                            ) : (
                              <span
                                className={`w-2 h-2 rounded-full border ${STATUS_CONFIG[tab.value as QuestStatus].dot} opacity-25`}
                              />
                            )}
                          </span>
                        )}
                        <span className="flex-1 text-left">{tab.label}</span>
                        <span className={`text-[10px] ${isActive ? "text-cc-primary/70" : "text-cc-muted"}`}>
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Unified search bar with hashtag chips */}
            <div className="relative flex-1 min-w-0">
              <div
                onClick={() => searchInputRef.current?.focus()}
                className={`flex items-center gap-1 px-2.5 py-1.5 bg-cc-input-bg border rounded-lg transition-colors cursor-text ${
                  searchFocused ? "border-cc-primary/50" : "border-cc-border"
                }`}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="w-3.5 h-3.5 text-cc-muted shrink-0"
                >
                  <circle cx="6.5" cy="6.5" r="4.5" />
                  <path d="M10 10l3.5 3.5" strokeLinecap="round" />
                </svg>
                {/* Selected tag chips */}
                {Array.from(selectedTags).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-cc-primary/15 text-cc-primary shrink-0"
                  >
                    #{tag}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedTags((prev) => {
                          const next = new Set(prev);
                          next.delete(tag);
                          return next;
                        });
                      }}
                      className="hover:text-cc-fg cursor-pointer ml-0.5"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-2 h-2">
                        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                      </svg>
                    </button>
                  </span>
                ))}
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => {
                    setSearchFocused(false);
                    // Delay closing autocomplete to allow click on item
                    setTimeout(() => {
                      setHashtagQuery("");
                      setAutocompleteIndex(0);
                    }, 150);
                  }}
                  onChange={(e) => {
                    const val = e.target.value;
                    // Positive trailing #tags keep the existing autocomplete flow.
                    // Negated tags (`-#tag`) stay in the raw query and should not
                    // create positive tag pills.
                    const trailingToken = getTrailingQuestSearchToken(val);
                    if (trailingToken) {
                      setHashtagQuery(trailingToken.value);
                      setAutocompleteIndex(0);
                      setSearchQuery(val);
                      return;
                    }
                    setHashtagQuery("");
                    setSearchQuery(val);
                  }}
                  onKeyDown={(e) => {
                    const currentSearchValue = (e.currentTarget as HTMLInputElement).value;
                    const currentTrailingToken = getTrailingQuestSearchToken(currentSearchValue);
                    const currentAutocompleteMatches = currentTrailingToken
                      ? getQuestSearchAutocompleteMatches(currentTrailingToken.value, allTags, selectedTags)
                      : [];
                    // Autocomplete navigation
                    if (currentTrailingToken && currentAutocompleteMatches.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setAutocompleteIndex((i) => Math.min(i + 1, currentAutocompleteMatches.length - 1));
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setAutocompleteIndex((i) => Math.max(i - 1, 0));
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        const tag = currentAutocompleteMatches[autocompleteIndex];
                        if (tag) {
                          if (currentTrailingToken?.kind === "negatedTag") {
                            setSearchQuery(replaceTrailingSearchToken(currentSearchValue, `!#${tag}`));
                          } else {
                            setSelectedTags((prev) => new Set([...prev, tag]));
                            // Remove #query from search text
                            const hashIdx = currentSearchValue.lastIndexOf("#");
                            setSearchQuery(hashIdx > 0 ? currentSearchValue.slice(0, hashIdx).trimEnd() : "");
                          }
                          setHashtagQuery("");
                          setAutocompleteIndex(0);
                        }
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      if (currentTrailingToken) {
                        setHashtagQuery("");
                        setAutocompleteIndex(0);
                      } else {
                        setSearchQuery("");
                        setSelectedTags(new Set());
                        searchInputRef.current?.blur();
                      }
                    }
                    // Backspace on empty input removes last tag
                    if (e.key === "Backspace" && !searchQuery && selectedTags.size > 0) {
                      const tags = Array.from(selectedTags);
                      setSelectedTags(new Set(tags.slice(0, -1)));
                    }
                  }}
                  placeholder={selectedTags.size > 0 ? "Type or #tag..." : "Search or #tag..."}
                  className="flex-1 min-w-[60px] text-sm bg-transparent text-cc-fg placeholder:text-cc-muted focus:outline-none"
                />
                {(searchQuery || selectedTags.size > 0) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSearchQuery("");
                      setSelectedTags(new Set());
                      setHashtagQuery("");
                      searchInputRef.current?.focus();
                    }}
                    className="text-cc-muted hover:text-cc-fg cursor-pointer shrink-0"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="w-3.5 h-3.5"
                    >
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Hashtag autocomplete dropdown */}
              {activeSearchToken && autocompleteMatches.length > 0 && searchFocused && (
                <div
                  ref={autocompleteRef}
                  className="absolute top-full left-0 right-0 mt-1 bg-cc-card border border-cc-border rounded-lg shadow-xl z-30 py-1 max-h-48 overflow-y-auto"
                >
                  {activeSearchToken?.kind === "negatedTag" && (
                    <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-cc-muted/70">
                      excluding:
                    </div>
                  )}
                  {autocompleteMatches.map((tag, i) => (
                    <button
                      key={tag}
                      onMouseDown={(e) => {
                        e.preventDefault(); // Prevent blur
                        if (activeSearchToken?.kind === "negatedTag") {
                          setSearchQuery(replaceTrailingSearchToken(searchQuery, `!#${tag}`));
                        } else {
                          setSelectedTags((prev) => new Set([...prev, tag]));
                          const hashIdx = searchQuery.lastIndexOf("#");
                          setSearchQuery(hashIdx > 0 ? searchQuery.slice(0, hashIdx).trimEnd() : "");
                        }
                        setHashtagQuery("");
                        setAutocompleteIndex(0);
                        searchInputRef.current?.focus();
                      }}
                      className={`w-full px-3 py-1.5 text-xs text-left flex items-center gap-2 transition-colors cursor-pointer ${
                        i === autocompleteIndex ? "bg-cc-primary/10 text-cc-primary" : "text-cc-fg hover:bg-cc-hover"
                      }`}
                    >
                      <span className="text-cc-muted">{activeSearchToken?.kind === "negatedTag" ? "!#" : "#"}</span>
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Bottom border separator */}
        <div className="border-b border-cc-border/30 mt-3" />
      </div>

      {/* ─── Scrollable content ────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 sm:px-8 pb-6 sm:pb-10 pt-4">
        {/* Error banner */}
        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError("")} className="text-red-400 hover:text-red-300 cursor-pointer ml-2">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        {/* Create form */}
        <QuestmasterCreateForm
          isVisible={showCreateForm}
          allTags={allTags}
          onCreated={handleCreateQuestCreated}
          onCancel={handleCreateQuestCancel}
        />

        {/* Quest list */}
        <div className="space-y-2">
          {questsLoading && pagedQuests.length === 0 ? (
            <div className="text-sm text-cc-muted text-center py-12">Loading quests...</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-cc-muted text-center py-12">
              {pageInfo.total === 0 && counts.all === 0
                ? "No quests yet. Create one to get started."
                : searchText || selectedTags.size > 0
                  ? "No quests match your search."
                  : "No quests match this filter."}
            </div>
          ) : (
            <>
              {viewMode === "compact" && (
                <CompactQuestTable
                  quests={compactQuests}
                  onOpenQuest={handleExpand}
                  searchText={searchText}
                  journeyContextByQuestId={journeyContextByQuestId}
                  sort={compactSort}
                  sortSaving={compactSortSaving}
                  onSortChange={handleCompactSortChange}
                />
              )}
              <div
                className={viewMode === "compact" ? "hidden" : "contents"}
                aria-hidden={viewMode === "compact"}
                style={viewMode === "compact" ? { display: "none" } : undefined}
              >
                {questSections.map((section) => {
                  const isCollapsible = !!section.collapseGroup;
                  const isCollapsed = !!section.collapseGroup && collapsedGroups.has(section.collapseGroup);
                  const showSectionHeader = filter.size > 1;
                  return (
                    <div key={section.key}>
                      {showSectionHeader &&
                        (isCollapsible ? (
                          <button
                            onClick={() =>
                              setCollapsedGroups((prev) => {
                                const next = new Set(prev);
                                if (section.collapseGroup && next.has(section.collapseGroup))
                                  next.delete(section.collapseGroup);
                                else if (section.collapseGroup) next.add(section.collapseGroup);
                                return next;
                              })
                            }
                            className="flex items-center gap-2 mb-1.5 mt-3 first:mt-0 cursor-pointer group/gh w-full text-left"
                          >
                            <svg
                              viewBox="0 0 16 16"
                              fill="currentColor"
                              className={`w-3 h-3 text-cc-muted/40 group-hover/gh:text-cc-muted transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                            >
                              <path d="M6 3l5 5-5 5V3z" />
                            </svg>
                            <span className={`w-1.5 h-1.5 rounded-full ${section.dotClass}`} />
                            <span className={`text-xs font-medium ${section.textClass}`}>{section.label}</span>
                            <span className="text-[10px] text-cc-muted/50">
                              {counts[section.collapseGroup ?? section.key] ?? section.quests.length}
                            </span>
                          </button>
                        ) : (
                          <div className="flex items-center gap-2 mb-1.5 mt-3 first:mt-0 px-0.5">
                            <span className={`w-1.5 h-1.5 rounded-full ${section.dotClass}`} />
                            <span className={`text-xs font-medium ${section.textClass}`}>{section.label}</span>
                            <span className="text-[10px] text-cc-muted/50">
                              {counts[section.collapseGroup ?? section.key] ?? section.quests.length}
                            </span>
                          </div>
                        ))}
                      {(!isCollapsed || viewMode === "compact") && (
                        <div className="space-y-2">
                          {section.quests.map((quest) => (
                            <QuestCard
                              key={quest.id}
                              quest={quest}
                              isExpanded={questOverlayId === quest.questId}
                              onOpenQuest={handleExpand}
                              searchText={searchText}
                              journeyContext={journeyContextByQuestId.get(quest.questId.toLowerCase())}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <QuestPageControls
                total={pageInfo.total}
                limit={pageInfo.limit}
                windowOffset={windowOffset}
                renderedCount={pagedQuests.length}
                loadingDirection={loadingMoreDirection}
                onLoadPrevious={() => {
                  if (previousPageOffset !== null) void loadQuestPage(previousPageOffset, "prepend");
                }}
                onLoadNext={() => {
                  if (nextPageOffset !== null) void loadQuestPage(nextPageOffset, "append");
                }}
                canLoadPrevious={previousPageOffset !== null}
                canLoadNext={nextPageOffset !== null}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function QuestPageControls({
  total,
  limit,
  windowOffset,
  renderedCount,
  loadingDirection,
  canLoadPrevious,
  canLoadNext,
  onLoadPrevious,
  onLoadNext,
}: {
  total: number;
  limit: number;
  windowOffset: number;
  renderedCount: number;
  loadingDirection: "next" | "previous" | null;
  canLoadPrevious: boolean;
  canLoadNext: boolean;
  onLoadPrevious: () => void;
  onLoadNext: () => void;
}) {
  if (total <= limit && windowOffset === 0) return null;
  const start = total === 0 ? 0 : windowOffset + 1;
  const end = Math.min(windowOffset + renderedCount, total);

  return (
    <div className="flex flex-col items-center gap-2 py-4 text-xs text-cc-muted">
      <div>
        Showing {start}-{end} of {total}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canLoadPrevious || loadingDirection !== null}
          onClick={onLoadPrevious}
          className="px-3 py-1.5 rounded-lg border border-cc-border bg-cc-card text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loadingDirection === "previous" ? "Loading..." : "Previous"}
        </button>
        <button
          type="button"
          disabled={!canLoadNext || loadingDirection !== null}
          onClick={onLoadNext}
          className="px-3 py-1.5 rounded-lg border border-cc-border bg-cc-card text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loadingDirection === "next" ? "Loading..." : "Load more"}
        </button>
      </div>
    </div>
  );
}

const QuestCard = memo(function QuestCard({
  quest,
  isExpanded,
  onOpenQuest,
  searchText,
  journeyContext,
}: {
  quest: QuestmasterTask;
  isExpanded: boolean;
  onOpenQuest: (quest: QuestmasterTask) => void;
  searchText: string;
  journeyContext?: QuestJourneyContext;
}) {
  const isCancelled = "cancelled" in quest && !!(quest as { cancelled?: boolean }).cancelled;
  const displayStatus = getQuestmasterDisplayStatus(quest, journeyContext);
  const hasVerification = "verificationItems" in quest && quest.verificationItems?.length > 0;
  const vProgress = hasVerification ? verificationProgress(quest.verificationItems) : null;
  const questSessionId = getQuestOwnerSessionId(quest);
  const leaderSessionId = getQuestLeaderSessionId(quest);
  const debriefTldr = getQuestDebriefTldr(quest);
  const feedbackEntries = "feedback" in quest ? (quest as { feedback?: QuestFeedbackEntry[] }).feedback : undefined;
  const unaddressedFeedbackCount =
    feedbackEntries?.filter((entry) => entry.author === "human" && !entry.addressed).length ?? 0;
  const addressedFeedbackCount =
    feedbackEntries?.filter((entry) => entry.author === "human" && entry.addressed).length ?? 0;

  return (
    <div>
      <div
        data-quest-id={quest.questId}
        className={`border rounded-xl transition-colors ${
          isExpanded
            ? "bg-cc-card border-cc-primary/30"
            : `bg-cc-card border-cc-border hover:border-cc-border/80 ${isCancelled ? "opacity-60" : ""}`
        }`}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => onOpenQuest(quest)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenQuest(quest);
            }
          }}
          className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer group"
        >
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${displayStatus.dotClass ?? ""}`}
            style={displayStatus.dotStyle}
          />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`text-sm font-medium ${isExpanded ? "" : "truncate"} ${isCancelled ? "text-cc-muted line-through" : "text-cc-fg"}`}
              >
                {renderSearchHighlightText(quest.title, searchText)}
              </span>
              {quest.parentId && (
                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted shrink-0">
                  sub:{quest.parentId}
                </span>
              )}
            </div>
            {quest.tldr && <QuestTldrMarkdown text={quest.tldr} searchText={searchText} className="mt-0.5 text-xs" />}
            {debriefTldr && (
              <div className="mt-0.5 truncate text-xs text-cc-muted">
                <span className="text-cc-muted/70">Debrief: </span>
                {renderSearchHighlightText(debriefTldr, searchText)}
              </div>
            )}
            <QuestPhaseScanLines quest={quest} searchText={searchText} className="mt-0.5" />
            <div className="flex items-center gap-2 mt-0.5">
              <CopyableQuestId questId={quest.questId} className="text-[10px] text-cc-muted/50 shrink-0">
                {renderSearchHighlightText(quest.questId, searchText)}
              </CopyableQuestId>
              <QuestStatusHoverTarget quest={quest}>
                <span className={`inline-flex items-center gap-1 ${displayStatus.textClass}`}>
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${displayStatus.dotClass ?? ""}`}
                    style={displayStatus.dotStyle}
                  />
                  <span>{displayStatus.label}</span>
                </span>
              </QuestStatusHoverTarget>
              {questSessionId && <SessionNumChip sessionId={questSessionId} />}
              {leaderSessionId && (
                <span className="inline-flex items-center gap-1 text-[10px] text-cc-muted">
                  <span>Leader</span>
                  <SessionNumChip sessionId={leaderSessionId} />
                </span>
              )}
              {vProgress && (
                <span className="text-[10px] text-cc-muted flex items-center gap-1">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm11.354-1.646a.5.5 0 00-.708-.708L7 9.293 5.354 7.646a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" />
                  </svg>
                  {vProgress.checked}/{vProgress.total}
                </span>
              )}
              {(unaddressedFeedbackCount > 0 || addressedFeedbackCount > 0) && (
                <span className="text-[10px] flex items-center gap-1.5">
                  {unaddressedFeedbackCount > 0 && (
                    <span
                      className="flex items-center gap-0.5 text-amber-400"
                      aria-label={`${unaddressedFeedbackCount} pending feedback`}
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                        <path d="M2.5 2A1.5 1.5 0 001 3.5v8A1.5 1.5 0 002.5 13H5l3 3 3-3h2.5a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0013.5 2h-11z" />
                      </svg>
                      {unaddressedFeedbackCount}
                    </span>
                  )}
                  {addressedFeedbackCount > 0 && (
                    <span
                      className="flex items-center gap-0.5 text-emerald-400/70"
                      aria-label={`${addressedFeedbackCount} addressed feedback`}
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                        <path d="M2.5 2A1.5 1.5 0 001 3.5v8A1.5 1.5 0 002.5 13H5l3 3 3-3h2.5a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0013.5 2h-11z" />
                      </svg>
                      {addressedFeedbackCount}
                    </span>
                  )}
                </span>
              )}
              <span className="text-[10px] text-cc-muted/50">{timeAgo(questRecencyTs(quest))}</span>
            </div>
            {quest.tags && quest.tags.length > 0 && (
              <div className="flex items-center gap-1.5 mt-0.5">
                {quest.tags.map((tag) => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted">
                    {tag.toLowerCase()}
                  </span>
                ))}
              </div>
            )}
          </div>

          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-3.5 h-3.5 text-cc-muted/40 group-hover:text-cc-muted transition-transform ${
              isExpanded ? "rotate-90" : ""
            }`}
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        </div>
      </div>
    </div>
  );
});
