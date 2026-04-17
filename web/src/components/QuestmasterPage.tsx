import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { questIdFromHash, withoutQuestIdInHash } from "../utils/routing.js";
import { SessionNumChip } from "./SessionNumChip.js";
import {
  VERIFICATION_INBOX_COLLAPSE_KEY,
  loadQuestmasterViewState,
  saveQuestmasterViewState,
  toggleStatusFilter,
} from "../utils/questmaster-view-state.js";
import type { QuestmasterCollapsedGroup } from "../utils/questmaster-view-state.js";
import { getHighlightParts } from "../utils/highlight.js";
import { normalizeForSearch } from "../../shared/search-utils.js";
import { QUEST_STATUS_THEME } from "../utils/quest-status-theme.js";
import { timeAgo, verificationProgress, getQuestOwnerSessionId, CopyableQuestId } from "../utils/quest-helpers.js";
import {
  extractPastedImages,
  extractHashtags,
  findHashtagTokenAtCursor,
  isVerificationInboxUnread,
  autoResizeTextarea,
} from "../utils/quest-editor-helpers.js";
import type { QuestmasterViewMode } from "../api.js";
import type { QuestmasterTask, QuestStatus, QuestFeedbackEntry, QuestImage } from "../types.js";

// ─── Status config ──────────────────────────────────────────────────────────

const STATUS_CONFIG = QUEST_STATUS_THEME;

const ALL_STATUSES: QuestStatus[] = ["idea", "refined", "in_progress", "needs_verification", "done"];

// Display order: most-needs-attention → least
const DISPLAY_ORDER: QuestStatus[] = ["needs_verification", "in_progress", "refined", "idea", "done"];

const FILTER_TABS: Array<{ value: QuestStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "idea", label: "Idea" },
  { value: "refined", label: "Refined" },
  { value: "in_progress", label: "In Progress" },
  { value: "needs_verification", label: "Verification" },
  { value: "done", label: "Done" },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function questRecencyTs(quest: QuestmasterTask): number {
  return (quest as { updatedAt?: number }).updatedAt ?? quest.createdAt;
}

function classifyQuestSearchToken(token: string): { kind: "positiveTag" | "negatedTag" | "text"; value: string } {
  const negatedMatch = token.match(/^-#([^\s#]+)$/);
  if (negatedMatch) return { kind: "negatedTag", value: negatedMatch[1].toLowerCase() };
  const positiveMatch = token.match(/^#([^\s#]*)$/);
  if (positiveMatch) return { kind: "positiveTag", value: positiveMatch[1].toLowerCase() };
  return { kind: "text", value: token };
}

function getTrailingQuestSearchToken(query: string): { kind: "positiveTag" | "negatedTag"; value: string } | null {
  const match = query.match(/(?:^|\s)(-?#([^\s#]*))$/);
  if (!match) return null;
  const rawToken = match[1];
  const classified = classifyQuestSearchToken(rawToken);
  if (classified.kind === "text") return null;
  return { kind: classified.kind, value: classified.value };
}

function parseQuestSearchQuery(query: string): { searchText: string; negatedTags: Set<string> } {
  const negatedTags = new Set<string>();
  const positiveTokens: string[] = [];

  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const classified = classifyQuestSearchToken(token);
    if (classified.kind === "negatedTag") {
      negatedTags.add(classified.value);
      continue;
    }
    positiveTokens.push(token);
  }

  // Preserve the existing positive #tag autocomplete flow by keeping a trailing
  // positive hashtag token out of plain-text matching/highlighting until the
  // user selects it into the positive tag pill set.
  const searchText = positiveTokens
    .join(" ")
    .replace(/(?:^|\s)#[^\s]*$/, "")
    .trim();
  return { searchText, negatedTags };
}

type EditorTarget = "newTitle" | "newDescription";

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
  const quests = useStore((s) => s.quests);
  const questsLoading = useStore((s) => s.questsLoading);
  const refreshQuests = useStore((s) => s.refreshQuests);
  const setQuests = useStore((s) => s.setQuests);
  const replaceQuest = useStore((s) => s.replaceQuest);
  const questOverlayId = useStore((s) => s.questOverlayId);

  const [filter, setFilter] = useState<Set<QuestStatus>>(() => {
    const persisted = initialViewState?.statusFilter;
    return persisted ? new Set(persisted) : new Set(ALL_STATUSES);
  });
  const allSelected = filter.size === ALL_STATUSES.length;
  const [viewMode, setViewMode] = useState<QuestmasterViewMode>("cards");
  const [viewModeSaving, setViewModeSaving] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Search & tag filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Status dropdown state
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // Hashtag autocomplete state
  const [hashtagQuery, setHashtagQuery] = useState("");
  const [hashtagAutocompleteActive, setHashtagAutocompleteActive] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [searchFocused, setSearchFocused] = useState(false);
  const autocompleteRef = useRef<HTMLDivElement>(null);

  // Create form state
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  const newDescRef = useRef<HTMLTextAreaElement>(null);

  // Hashtag autocomplete for create/edit title + description fields.
  const [editorHashtagQuery, setEditorHashtagQuery] = useState("");
  const [editorAutocompleteIndex, setEditorAutocompleteIndex] = useState(0);
  const [editorAutocompleteTarget, setEditorAutocompleteTarget] = useState<EditorTarget | null>(null);

  // Create form images (uploaded but not yet attached to a quest)
  const [createImages, setCreateImages] = useState<QuestImage[]>([]);
  const [uploadingCreateImage, setUploadingCreateImage] = useState(false);
  const createFileInputRef = useRef<HTMLInputElement>(null);

  // Error state
  const [error, setError] = useState("");

  // Collapsed phase groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<QuestmasterCollapsedGroup>>(
    () => new Set(initialViewState?.collapsedGroups ?? []),
  );
  const parsedSearch = useMemo(() => parseQuestSearchQuery(searchQuery), [searchQuery]);
  const searchText = parsedSearch.searchText;
  const negatedTags = parsedSearch.negatedTags;

  // Load quests on mount, poll periodically as a fallback for cases where
  // no session WebSocket is open (the `quest_list_updated` broadcast only
  // reaches browsers that have an active session WS connection), and refetch
  // when the tab regains visibility so switching back always shows fresh data.
  useEffect(() => {
    if (!isActive) return;
    refreshQuests();

    // Poll every 5 seconds as a fallback — lightweight GET that only triggers
    // a React re-render when the returned data differs (Zustand shallow check).
    const interval = setInterval(() => {
      refreshQuests({ background: true });
    }, 5_000);

    // Refetch when the tab becomes visible again (e.g. user switches back)
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        refreshQuests();
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);

    // Refetch on window focus (covers cases where visibilitychange doesn't fire,
    // e.g. switching between windows on the same desktop)
    function handleFocus() {
      refreshQuests();
    }
    window.addEventListener("focus", handleFocus);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [isActive]);

  const refreshServerViewMode = useCallback(async () => {
    try {
      const settings = await api.getSettings();
      setViewMode(settings.questmasterViewMode);
    } catch (err) {
      console.warn("[questmaster] failed to load server view mode", err);
    }
  }, []);

  // The compact/card preference is server-owned. Refresh it on page activation
  // and on focus so multiple browser tabs converge to the latest saved mode.
  useEffect(() => {
    if (!isActive) return;
    refreshServerViewMode();

    function handleFocus() {
      refreshServerViewMode();
    }
    function handleVisibility() {
      if (document.visibilityState === "visible") refreshServerViewMode();
    }

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [isActive, refreshServerViewMode]);

  // Hydrate persisted scroll position once enough content has rendered.
  useEffect(() => {
    if (!isActive) return;
    if (hasHydratedViewStateRef.current) return;
    const el = scrollContainerRef.current;
    const savedScrollTop = restoreScrollTopRef.current;
    if (!el || savedScrollTop === null) return;
    if (questsLoading && quests.length === 0) return;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(savedScrollTop, maxScrollTop);
    hasHydratedViewStateRef.current = true;
    restoreScrollTopRef.current = null;
  }, [isActive, questsLoading, quests.length]);

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
    const targetQuest = quests.find((q) => q.questId === targetQuestId);
    if (!targetQuest) return;
    setFilter(new Set(ALL_STATUSES));
    // Ensure deep-linked quests are visible in the list as well as the modal.
    setCollapsedGroups((prev) => {
      const targetGroup = isVerificationInboxUnread(targetQuest) ? VERIFICATION_INBOX_COLLAPSE_KEY : targetQuest.status;
      if (!prev.has(targetGroup)) return prev;
      const next = new Set(prev);
      next.delete(targetGroup);
      return next;
    });
    useStore.getState().openQuestOverlay(targetQuestId);
    setShowCreateForm(false);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-quest-id="${targetQuestId}"]`);
      if (el instanceof HTMLElement && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }, [hash, quests]);

  // Focus title input when create form opens
  useEffect(() => {
    if (showCreateForm && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [showCreateForm]);

  // Auto-resize on programmatic content changes.
  // We also include showCreateForm so that autoResizeTextarea fires when
  // the textarea first mounts with pre-existing content (the value deps alone
  // won't re-trigger if the value hasn't changed since the form appeared).
  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [newTitle, showCreateForm]);
  useEffect(() => {
    autoResizeTextarea(newDescRef.current);
  }, [newDescription, showCreateForm]);

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

  async function handleCreate() {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    setError("");
    try {
      const description = newDescription.trim() || undefined;
      const tags = extractHashtags(`${title}\n${description ?? ""}`);
      const createdQuest = await api.createQuest({
        title,
        description,
        tags: tags.length > 0 ? tags : undefined,
        images: createImages.length > 0 ? createImages : undefined,
      });
      const currentQuests = useStore.getState().quests;
      setQuests(
        [createdQuest, ...currentQuests.filter((q) => q.questId !== createdQuest.questId)].sort(
          (a, b) => b.createdAt - a.createdAt,
        ),
      );
      setNewTitle("");
      setNewDescription("");
      setCreateImages([]);
      setEditorHashtagQuery("");
      setEditorAutocompleteTarget(null);
      setEditorAutocompleteIndex(0);
      setShowCreateForm(false);
      useStore.getState().openQuestOverlay(createdQuest.questId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

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

  // ─── Image handling for create form ─────────────────────────────

  /** Upload files via standalone endpoint (for create form, before quest exists). */
  async function handleCreateImageUpload(files: FileList | File[]) {
    setError("");
    setUploadingCreateImage(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const image = await api.uploadStandaloneQuestImage(file);
        setCreateImages((prev) => [...prev, image]);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingCreateImage(false);
    }
  }

  function handleCreatePaste(e: React.ClipboardEvent) {
    const files = extractPastedImages(e);
    if (files.length > 0) {
      e.preventDefault();
      handleCreateImageUpload(files);
    }
  }

  function removeCreateImage(imageId: string) {
    setCreateImages((prev) => prev.filter((img) => img.id !== imageId));
  }

  // ─── Derived tag list ─────────────────────────────────────────────────

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const q of quests) {
      if (q.tags) for (const t of q.tags) tagSet.add(t.toLowerCase());
    }
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
  }, [quests]);

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
    if (!hashtagAutocompleteActive) return [];
    const q = hashtagQuery.toLowerCase();
    return allTags.filter((t) => (!q || t.includes(q)) && !selectedTags.has(t));
  }, [hashtagAutocompleteActive, hashtagQuery, allTags, selectedTags]);

  const editorAutocompleteMatches = useMemo(() => {
    if (!editorHashtagQuery) return [];
    const q = editorHashtagQuery.toLowerCase();
    return allTags.filter((t) => t.includes(q));
  }, [editorHashtagQuery, allTags]);

  const editorAutocompleteOptions = useMemo(() => {
    if (!editorHashtagQuery) return [];
    const q = editorHashtagQuery.toLowerCase();
    const existing = editorAutocompleteMatches.map((tag) => ({ tag, isNew: false }));
    if (!allTags.includes(q)) existing.push({ tag: q, isNew: true });
    return existing;
  }, [editorHashtagQuery, editorAutocompleteMatches, allTags]);

  function getEditorText(target: EditorTarget): string {
    if (target === "newTitle") return newTitle;
    return newDescription;
  }

  function setEditorText(target: EditorTarget, value: string) {
    if (target === "newTitle") setNewTitle(value);
    else setNewDescription(value);
  }

  function getEditorRef(target: EditorTarget) {
    if (target === "newTitle") return titleInputRef;
    return newDescRef;
  }

  function updateEditorHashtagState(target: EditorTarget, value: string, cursor: number) {
    const token = findHashtagTokenAtCursor(value, cursor);
    if (!token) {
      setEditorHashtagQuery("");
      setEditorAutocompleteTarget(null);
      setEditorAutocompleteIndex(0);
      return;
    }
    setEditorAutocompleteTarget(target);
    setEditorHashtagQuery(token.query.toLowerCase());
    setEditorAutocompleteIndex(0);
  }

  function applyEditorHashtag(tag: string) {
    const target = editorAutocompleteTarget;
    if (!target) return;
    const current = getEditorText(target);
    const ref = getEditorRef(target).current;
    const cursor = ref?.selectionStart ?? current.length;
    const token = findHashtagTokenAtCursor(current, cursor);
    if (!token) return;
    const before = current.slice(0, token.start);
    const after = current.slice(token.end);
    const next = `${before}#${tag} ${after}`;
    setEditorText(target, next);
    setEditorHashtagQuery("");
    setEditorAutocompleteTarget(null);
    setEditorAutocompleteIndex(0);
    const nextCursor = before.length + tag.length + 2;
    requestAnimationFrame(() => {
      const node = getEditorRef(target).current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCursor, nextCursor);
      autoResizeTextarea(node);
    });
  }

  // ─── Filtering ────────────────────────────────────────────────────────

  // Layer 1: text search (case-insensitive on quest ID + title + description)
  // Negated tags like `-#mobile` are parsed separately so free-text matching
  // and highlighting stay focused on the positive portion of the query.
  const searchNormalized = normalizeForSearch(searchText);
  const afterSearch = searchNormalized
    ? quests.filter((q) => {
        if (normalizeForSearch(q.questId).includes(searchNormalized)) return true;
        if (normalizeForSearch(q.title).includes(searchNormalized)) return true;
        if (q.description && normalizeForSearch(q.description).includes(searchNormalized)) return true;
        return false;
      })
    : quests;

  // Layer 2: tag filter (OR — quest matches if it has ANY selected tag)
  const afterTags =
    selectedTags.size === 0
      ? afterSearch
      : afterSearch.filter((q) => q.tags?.some((t) => selectedTags.has(t.toLowerCase())) ?? false);

  // Layer 3: negated tag filter (exclude quests matching ANY negated tag)
  const afterNegatedTags =
    negatedTags.size === 0
      ? afterTags
      : afterTags.filter((q) => !(q.tags?.some((t) => negatedTags.has(t.toLowerCase())) ?? false));

  // Status counts (after search + tags + negated tags, before status filter)
  const counts: Record<string, number> = { all: afterNegatedTags.length };
  for (const s of ALL_STATUSES) {
    counts[s] = afterNegatedTags.filter((q) => q.status === s).length;
  }

  // Layer 4: status filter (multi-select -- filter.has checks membership in the active set)
  const filtered = allSelected ? afterNegatedTags : afterNegatedTags.filter((q) => filter.has(q.status));

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

  const showVerificationSplit = allSelected || filter.has("needs_verification");
  const verificationInboxQuests = showVerificationSplit ? filtered.filter((q) => isVerificationInboxUnread(q)) : [];
  const regularVerificationQuests = showVerificationSplit
    ? filtered.filter((q) => q.status === "needs_verification" && !isVerificationInboxUnread(q))
    : [];
  const sortByRecencyDesc = (items: QuestmasterTask[]): QuestmasterTask[] =>
    [...items].sort((a, b) => questRecencyTs(b) - questRecencyTs(a));
  const compactQuests = sortByRecencyDesc(filtered);

  const questSections: QuestSection[] = [];
  if (showVerificationSplit && verificationInboxQuests.length > 0) {
    questSections.push({
      key: VERIFICATION_INBOX_COLLAPSE_KEY,
      label: "Verification Inbox",
      dotClass: "bg-amber-400",
      textClass: "text-amber-300",
      quests: sortByRecencyDesc(verificationInboxQuests),
      ...(filter.size > 1 ? { collapseGroup: VERIFICATION_INBOX_COLLAPSE_KEY } : {}),
    });
  }

  for (const status of allSelected ? DISPLAY_ORDER : ALL_STATUSES) {
    const sectionQuests =
      status === "needs_verification" && showVerificationSplit
        ? regularVerificationQuests
        : filtered.filter((q) => q.status === status);
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

  function renderSearchHighlight(text: string): React.ReactNode {
    if (!searchText) return text;
    const parts = getHighlightParts(text, searchText);
    if (!parts.some((part) => part.matched)) return text;
    return (
      <>
        {parts.map((part, index) =>
          part.matched ? (
            <mark key={`${part.text}-${index}`} className="bg-amber-300/25 text-amber-100 rounded-[2px] px-0.5">
              {part.text}
            </mark>
          ) : (
            <span key={`${part.text}-${index}`}>{part.text}</span>
          ),
        )}
      </>
    );
  }

  function handleEditorAutocompleteKeyDown(e: { key: string; preventDefault: () => void }): boolean {
    if (!editorHashtagQuery || editorAutocompleteOptions.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setEditorAutocompleteIndex((i) => Math.min(i + 1, editorAutocompleteOptions.length - 1));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setEditorAutocompleteIndex((i) => Math.max(i - 1, 0));
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const option = editorAutocompleteOptions[editorAutocompleteIndex];
      if (option) applyEditorHashtag(option.tag);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setEditorHashtagQuery("");
      setEditorAutocompleteTarget(null);
      setEditorAutocompleteIndex(0);
      return true;
    }
    return false;
  }

  function renderEditorHashtagDropdown(target: EditorTarget) {
    if (editorAutocompleteTarget !== target || !editorHashtagQuery || editorAutocompleteOptions.length === 0) {
      return null;
    }
    return (
      <div className="mt-1 bg-cc-card border border-cc-border rounded-lg shadow-xl py-1 max-h-44 overflow-y-auto">
        {editorAutocompleteOptions.map((option, i) => (
          <button
            key={`${option.tag}:${option.isNew ? "new" : "existing"}`}
            onMouseDown={(e) => {
              e.preventDefault();
              applyEditorHashtag(option.tag);
            }}
            className={`w-full px-3 py-1.5 text-xs text-left flex items-center gap-2 transition-colors cursor-pointer ${
              i === editorAutocompleteIndex ? "bg-cc-primary/10 text-cc-primary" : "text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <span className="text-cc-muted">#</span>
            <span className="flex-1">{option.tag}</span>
            {option.isNew && <span className="text-[10px] text-cc-muted">(new tag)</span>}
          </button>
        ))}
      </div>
    );
  }

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
                      setHashtagAutocompleteActive(false);
                      setAutocompleteIndex(0);
                    }, 150);
                  }}
                  onChange={(e) => {
                    const val = e.target.value;
                    // Positive trailing #tags keep the existing autocomplete flow.
                    // Negated tags (`-#tag`) stay in the raw query and should not
                    // create positive tag pills.
                    const trailingToken = getTrailingQuestSearchToken(val);
                    if (trailingToken?.kind === "positiveTag") {
                      setHashtagQuery(trailingToken.value);
                      setHashtagAutocompleteActive(true);
                      setAutocompleteIndex(0);
                      setSearchQuery(val);
                      return;
                    }
                    setHashtagQuery("");
                    setHashtagAutocompleteActive(false);
                    setSearchQuery(val);
                  }}
                  onKeyDown={(e) => {
                    // Autocomplete navigation
                    if (hashtagAutocompleteActive && autocompleteMatches.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setAutocompleteIndex((i) => Math.min(i + 1, autocompleteMatches.length - 1));
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setAutocompleteIndex((i) => Math.max(i - 1, 0));
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        const tag = autocompleteMatches[autocompleteIndex];
                        if (tag) {
                          setSelectedTags((prev) => new Set([...prev, tag]));
                          // Remove #query from search text
                          const hashIdx = searchQuery.lastIndexOf("#");
                          setSearchQuery(hashIdx > 0 ? searchQuery.slice(0, hashIdx).trimEnd() : "");
                          setHashtagQuery("");
                          setHashtagAutocompleteActive(false);
                          setAutocompleteIndex(0);
                        }
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      if (hashtagAutocompleteActive) {
                        setHashtagQuery("");
                        setHashtagAutocompleteActive(false);
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
                      setHashtagAutocompleteActive(false);
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
              {hashtagAutocompleteActive && autocompleteMatches.length > 0 && searchFocused && (
                <div
                  ref={autocompleteRef}
                  className="absolute top-full left-0 right-0 mt-1 bg-cc-card border border-cc-border rounded-lg shadow-xl z-30 py-1 max-h-48 overflow-y-auto"
                >
                  {autocompleteMatches.map((tag, i) => (
                    <button
                      key={tag}
                      onMouseDown={(e) => {
                        e.preventDefault(); // Prevent blur
                        setSelectedTags((prev) => new Set([...prev, tag]));
                        const hashIdx = searchQuery.lastIndexOf("#");
                        setSearchQuery(hashIdx > 0 ? searchQuery.slice(0, hashIdx).trimEnd() : "");
                        setHashtagQuery("");
                        setHashtagAutocompleteActive(false);
                        setAutocompleteIndex(0);
                        searchInputRef.current?.focus();
                      }}
                      className={`w-full px-3 py-1.5 text-xs text-left flex items-center gap-2 transition-colors cursor-pointer ${
                        i === autocompleteIndex ? "bg-cc-primary/10 text-cc-primary" : "text-cc-fg hover:bg-cc-hover"
                      }`}
                    >
                      <span className="text-cc-muted">#</span>
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
        {showCreateForm && (
          <div
            className="mb-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3"
            onPaste={handleCreatePaste}
          >
            <h2 className="text-sm font-semibold text-cc-fg">New Quest</h2>
            <textarea
              ref={titleInputRef}
              value={newTitle}
              onChange={(e) => {
                setNewTitle(e.target.value);
                autoResizeTextarea(e.target);
                updateEditorHashtagState("newTitle", e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onFocus={(e) => {
                updateEditorHashtagState(
                  "newTitle",
                  e.currentTarget.value,
                  e.currentTarget.selectionStart ?? e.currentTarget.value.length,
                );
              }}
              onBlur={() => {
                setTimeout(() => {
                  setEditorHashtagQuery("");
                  setEditorAutocompleteTarget(null);
                  setEditorAutocompleteIndex(0);
                }, 120);
              }}
              onKeyDown={(e) => {
                if (handleEditorAutocompleteKeyDown(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (newTitle.trim()) handleCreate();
                }
                if (e.key === "Escape") setShowCreateForm(false);
              }}
              placeholder="Quest title"
              rows={1}
              className="w-full px-3 py-2 text-base sm:text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 resize-none overflow-hidden"
              style={{ minHeight: "36px" }}
            />
            {renderEditorHashtagDropdown("newTitle")}
            <textarea
              ref={newDescRef}
              value={newDescription}
              onChange={(e) => {
                setNewDescription(e.target.value);
                autoResizeTextarea(e.target);
                updateEditorHashtagState(
                  "newDescription",
                  e.target.value,
                  e.target.selectionStart ?? e.target.value.length,
                );
              }}
              onFocus={(e) => {
                updateEditorHashtagState(
                  "newDescription",
                  e.currentTarget.value,
                  e.currentTarget.selectionStart ?? e.currentTarget.value.length,
                );
              }}
              onBlur={() => {
                setTimeout(() => {
                  setEditorHashtagQuery("");
                  setEditorAutocompleteTarget(null);
                  setEditorAutocompleteIndex(0);
                }, 120);
              }}
              onKeyDown={(e) => {
                handleEditorAutocompleteKeyDown(e);
              }}
              placeholder="Description (optional)"
              rows={1}
              className="w-full px-3 py-2 text-base sm:text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 resize-none overflow-y-auto"
              style={{ minHeight: "36px", maxHeight: "200px" }}
            />
            <p className="text-[10px] text-cc-muted/60 -mt-1">Tip: use #tag in description to attach tags.</p>
            {renderEditorHashtagDropdown("newDescription")}

            {/* Images section */}
            <div>
              {createImages.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {createImages.map((img) => (
                    <div
                      key={img.id}
                      className="relative group rounded-lg overflow-hidden border border-cc-border bg-cc-input-bg"
                    >
                      <img
                        src={api.questImageUrl(img.id)}
                        alt={img.filename}
                        className="w-16 h-16 object-cover cursor-zoom-in"
                        onClick={() => window.open(api.questImageUrl(img.id), "_blank")}
                      />
                      <button
                        onClick={() => removeCreateImage(img.id)}
                        className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 rounded-full flex items-center justify-center cursor-pointer"
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="2" className="w-2 h-2">
                          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                        </svg>
                      </button>
                      <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-0.5 py-px text-[8px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
                        {img.filename}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => createFileInputRef.current?.click()}
                  disabled={uploadingCreateImage}
                  className="px-2 py-1 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg border border-cc-border transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                    <circle cx="5" cy="6" r="1.5" />
                    <path d="M1.5 11l3-3.5 2.5 2.5 2-1.5 5.5 4" />
                  </svg>
                  {uploadingCreateImage ? "Uploading..." : "Add Image"}
                </button>
                <span className="text-[10px] text-cc-muted/50">or paste</span>
                <input
                  ref={createFileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      handleCreateImageUpload(e.target.files);
                      e.target.value = "";
                    }
                  }}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCreate}
                disabled={!newTitle.trim() || creating}
                className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  newTitle.trim() && !creating
                    ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                    : "bg-cc-hover text-cc-muted cursor-not-allowed"
                }`}
              >
                {creating ? "Creating..." : "Create"}
              </button>
              <button
                onClick={() => {
                  setShowCreateForm(false);
                  setCreateImages([]);
                }}
                className="px-3 py-2 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Quest list */}
        <div className="space-y-2">
          {questsLoading && quests.length === 0 ? (
            <div className="text-sm text-cc-muted text-center py-12">Loading quests...</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-cc-muted text-center py-12">
              {quests.length === 0
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
                  renderSearchHighlight={renderSearchHighlight}
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
                  const showSectionHeader =
                    filter.size > 1 ||
                    (filter.has("needs_verification") &&
                      (section.key === VERIFICATION_INBOX_COLLAPSE_KEY || section.key === "needs_verification"));
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
                            <span className="text-[10px] text-cc-muted/50">{section.quests.length}</span>
                          </button>
                        ) : (
                          <div className="flex items-center gap-2 mb-1.5 mt-3 first:mt-0 px-0.5">
                            <span className={`w-1.5 h-1.5 rounded-full ${section.dotClass}`} />
                            <span className={`text-xs font-medium ${section.textClass}`}>{section.label}</span>
                            <span className="text-[10px] text-cc-muted/50">{section.quests.length}</span>
                          </div>
                        ))}
                      {(!isCollapsed || viewMode === "compact") && (
                        <div className="space-y-2">
                          {section.quests.map((quest) => {
                            const isCancelled = "cancelled" in quest && !!(quest as { cancelled?: boolean }).cancelled;
                            const cfg = STATUS_CONFIG[quest.status];
                            const isExpanded = questOverlayId === quest.questId;
                            const isInboxVerification = isVerificationInboxUnread(quest);
                            const hasVerification = "verificationItems" in quest && quest.verificationItems?.length > 0;
                            const vProgress = hasVerification ? verificationProgress(quest.verificationItems) : null;
                            const questSessionId = getQuestOwnerSessionId(quest);
                            const feedbackEntries =
                              "feedback" in quest ? (quest as { feedback?: QuestFeedbackEntry[] }).feedback : undefined;
                            const unaddressedFeedbackCount =
                              feedbackEntries?.filter((e) => e.author === "human" && !e.addressed).length ?? 0;
                            const addressedFeedbackCount =
                              feedbackEntries?.filter((e) => e.author === "human" && e.addressed).length ?? 0;

                            return (
                              <div key={quest.id}>
                                <div
                                  data-quest-id={quest.questId}
                                  className={`border rounded-xl transition-colors ${
                                    isExpanded
                                      ? "bg-cc-card border-cc-primary/30"
                                      : `bg-cc-card border-cc-border hover:border-cc-border/80 ${isCancelled ? "opacity-60" : ""}`
                                  }`}
                                >
                                  {/* Card header */}
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => handleExpand(quest)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        handleExpand(quest);
                                      }
                                    }}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer group"
                                  >
                                    {/* Status dot */}
                                    <span
                                      className={`w-2 h-2 rounded-full shrink-0 ${isCancelled ? "bg-red-400" : cfg.dot}`}
                                    />

                                    {/* Title + meta */}
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span
                                          className={`text-sm font-medium ${isExpanded ? "" : "truncate"} ${isCancelled ? "text-cc-muted line-through" : "text-cc-fg"}`}
                                        >
                                          {renderSearchHighlight(quest.title)}
                                        </span>
                                        {quest.parentId && (
                                          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted shrink-0">
                                            sub:{quest.parentId}
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-[10px] text-cc-muted/50 shrink-0">
                                          {renderSearchHighlight(quest.questId)}
                                        </span>
                                        {isInboxVerification && (
                                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted border border-cc-border flex items-center gap-1">
                                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                                            Inbox
                                          </span>
                                        )}
                                        {questSessionId && <SessionNumChip sessionId={questSessionId} />}
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
                                        <span className="text-[10px] text-cc-muted/50">
                                          {timeAgo((quest as { updatedAt?: number }).updatedAt ?? quest.createdAt)}
                                        </span>
                                      </div>
                                      {quest.tags && quest.tags.length > 0 && (
                                        <div className="flex items-center gap-1.5 mt-0.5">
                                          {quest.tags.map((tag) => (
                                            <span
                                              key={tag}
                                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted"
                                            >
                                              {tag.toLowerCase()}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </div>

                                    {/* Expand chevron */}
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
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CompactQuestTable({
  quests,
  onOpenQuest,
  renderSearchHighlight,
}: {
  quests: QuestmasterTask[];
  onOpenQuest: (quest: QuestmasterTask) => void;
  renderSearchHighlight: (text: string) => React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-cc-border bg-cc-card">
      <table className="w-full min-w-[760px] text-xs">
        <thead>
          <tr className="border-b border-cc-border bg-cc-bg/50 text-cc-muted">
            <th className="px-3 py-1.5 text-left font-medium whitespace-nowrap">Quest</th>
            <th className="px-3 py-1.5 text-left font-medium whitespace-nowrap">Title</th>
            <th className="px-3 py-1.5 text-left font-medium whitespace-nowrap">Owner</th>
            <th className="px-3 py-1.5 text-left font-medium whitespace-nowrap">Status</th>
            <th className="px-3 py-1.5 text-left font-medium whitespace-nowrap">Verify</th>
            <th className="px-3 py-1.5 text-left font-medium whitespace-nowrap">Feedback</th>
            <th className="px-3 py-1.5 text-left font-medium whitespace-nowrap">Updated</th>
          </tr>
        </thead>
        <tbody>
          {quests.map((quest) => {
            const isCancelled = "cancelled" in quest && !!(quest as { cancelled?: boolean }).cancelled;
            const cfg = STATUS_CONFIG[quest.status];
            const questSessionId = getQuestOwnerSessionId(quest);
            const hasVerification = "verificationItems" in quest && quest.verificationItems?.length > 0;
            const vProgress = hasVerification ? verificationProgress(quest.verificationItems) : null;
            const feedbackEntries =
              "feedback" in quest ? (quest as { feedback?: QuestFeedbackEntry[] }).feedback : undefined;
            const unaddressedFeedbackCount =
              feedbackEntries?.filter((entry) => entry.author === "human" && !entry.addressed).length ?? 0;
            const totalFeedbackCount = feedbackEntries?.filter((entry) => entry.author === "human").length ?? 0;
            const isInboxVerification = isVerificationInboxUnread(quest);

            return (
              <tr
                key={quest.id}
                data-quest-id={quest.questId}
                role="button"
                tabIndex={0}
                onClick={() => onOpenQuest(quest)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenQuest(quest);
                  }
                }}
                className={`group border-b border-cc-border last:border-0 hover:bg-cc-hover/30 focus-visible:bg-cc-hover/40 focus-visible:outline-none cursor-pointer ${
                  isCancelled ? "opacity-60" : ""
                }`}
              >
                <td className="px-3 py-1.5 whitespace-nowrap align-middle">
                  <span className="font-mono-code text-blue-400 group-hover:text-blue-300">
                    {renderSearchHighlight(quest.questId)}
                  </span>
                </td>
                <td className="px-3 py-1.5 align-middle">
                  <div
                    className={`max-w-[360px] truncate font-medium ${
                      isCancelled ? "text-cc-muted line-through" : "text-cc-fg"
                    }`}
                  >
                    {renderSearchHighlight(quest.title)}
                  </div>
                  {quest.tags && quest.tags.length > 0 && (
                    <div className="mt-0.5 flex items-center gap-1 overflow-hidden text-[10px] text-cc-muted/60">
                      {quest.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="truncate">
                          #{tag.toLowerCase()}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap align-middle">
                  {questSessionId ? (
                    <SessionNumChip sessionId={questSessionId} />
                  ) : (
                    <span className="text-cc-muted">{"\u2014"}</span>
                  )}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap align-middle">
                  <span className="inline-flex items-center gap-1.5 text-cc-muted">
                    <span className={`h-1.5 w-1.5 rounded-full ${isCancelled ? "bg-red-400" : cfg.dot}`} />
                    <span>{isCancelled ? "Cancelled" : cfg.label}</span>
                    {isInboxVerification && <span className="text-amber-300">Inbox</span>}
                  </span>
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap align-middle text-cc-muted tabular-nums">
                  {vProgress ? `${vProgress.checked}/${vProgress.total}` : "\u2014"}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap align-middle tabular-nums">
                  {totalFeedbackCount > 0 ? (
                    <span className={unaddressedFeedbackCount > 0 ? "text-amber-400" : "text-emerald-400/70"}>
                      {unaddressedFeedbackCount > 0
                        ? `${unaddressedFeedbackCount} open / ${totalFeedbackCount}`
                        : `${totalFeedbackCount} addressed`}
                    </span>
                  ) : (
                    <span className="text-cc-muted">{"\u2014"}</span>
                  )}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap align-middle text-cc-muted/70">
                  {timeAgo((quest as { updatedAt?: number }).updatedAt ?? quest.createdAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
