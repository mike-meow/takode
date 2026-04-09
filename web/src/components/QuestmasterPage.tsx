import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useStore, countUserPermissions } from "../store.js";
import { api } from "../api.js";
import { navigateToSession, questIdFromHash, withoutQuestIdInHash } from "../utils/routing.js";
import { SessionNumChip } from "./SessionNumChip.js";
import {
  VERIFICATION_INBOX_COLLAPSE_KEY,
  loadQuestmasterViewState,
  saveQuestmasterViewState,
} from "../utils/questmaster-view-state.js";
import type { QuestmasterCollapsedGroup } from "../utils/questmaster-view-state.js";
import { getHighlightParts } from "../utils/highlight.js";
import { Lightbox } from "./Lightbox.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { buildQuestAssignDraft } from "./quest-assign.js";
import { buildQuestReworkDraft } from "./quest-rework.js";
import { writeClipboardText } from "../utils/copy-utils.js";
import { MarkdownContent } from "./MarkdownContent.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { QUEST_STATUS_THEME } from "../utils/quest-status-theme.js";
import { timeAgo, verificationProgress, getQuestOwnerSessionId, CopyableQuestId } from "../utils/quest-helpers.js";
import type { QuestmasterViewMode } from "../api.js";
import type { QuestmasterTask, QuestStatus, QuestVerificationItem, QuestFeedbackEntry, QuestImage } from "../types.js";

// ─── Image paste/upload helpers ────────────────────────────────────────────

/** Handle paste events on a container: extract image files from clipboard. */
function extractPastedImages(e: React.ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

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

function isVerificationInboxUnread(quest: QuestmasterTask): boolean {
  return (
    quest.status === "needs_verification" && !!(quest as { verificationInboxUnread?: boolean }).verificationInboxUnread
  );
}

const DEFAULT_DONE_VERIFICATION_ITEM: QuestVerificationItem = {
  text: "User marked this quest as done in Questmaster.",
  checked: true,
};

function getDoneVerificationItems(quest: QuestmasterTask): QuestVerificationItem[] | undefined {
  if ("verificationItems" in quest && Array.isArray(quest.verificationItems) && quest.verificationItems.length > 0) {
    return undefined;
  }
  return [DEFAULT_DONE_VERIFICATION_ITEM];
}

type EditorTarget = "newTitle" | "newDescription" | "editTitle" | "editDescription";

function extractHashtags(text: string): string[] {
  const tags = new Set<string>();
  const matches = text.matchAll(/(^|\s)#([a-zA-Z0-9][a-zA-Z0-9_-]*)/g);
  for (const match of matches) tags.add(match[2].toLowerCase());
  return Array.from(tags);
}

function findHashtagTokenAtCursor(text: string, cursor: number): { start: number; end: number; query: string } | null {
  const clamped = Math.max(0, Math.min(cursor, text.length));
  const beforeCursor = text.slice(0, clamped);
  const hashPos = beforeCursor.lastIndexOf("#");
  if (hashPos < 0) return null;
  if (hashPos > 0) {
    const prev = beforeCursor[hashPos - 1];
    if (!/\s/.test(prev)) return null;
  }
  const token = beforeCursor.slice(hashPos + 1);
  if (/\s/.test(token)) return null;
  return { start: hashPos, end: clamped, query: token };
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
  const quests = useStore((s) => s.quests);
  const questsLoading = useStore((s) => s.questsLoading);
  const refreshQuests = useStore((s) => s.refreshQuests);
  const setQuests = useStore((s) => s.setQuests);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessionNames = useStore((s) => s.sessionNames);
  const sessions = useStore((s) => s.sessions);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const sessionPreviews = useStore((s) => s.sessionPreviews);
  const askPermissionMap = useStore((s) => s.askPermission);

  const [filter, setFilter] = useState<QuestStatus | "all">("all");
  const [viewMode, setViewMode] = useState<QuestmasterViewMode>("cards");
  const [viewModeSaving, setViewModeSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [searchFocused, setSearchFocused] = useState(false);
  const autocompleteRef = useRef<HTMLDivElement>(null);

  // Create form state
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  const newDescRef = useRef<HTMLTextAreaElement>(null);
  const editTitleRef = useRef<HTMLTextAreaElement>(null);
  const editDescRef = useRef<HTMLTextAreaElement>(null);

  // Edit mode: null = read view, questId = editing that quest
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");

  // Hashtag autocomplete for create/edit title + description fields.
  const [editorHashtagQuery, setEditorHashtagQuery] = useState("");
  const [editorAutocompleteIndex, setEditorAutocompleteIndex] = useState(0);
  const [editorAutocompleteTarget, setEditorAutocompleteTarget] = useState<EditorTarget | null>(null);

  // Track the quest version when entering edit mode so we can detect remote
  // changes and exit edit mode to prevent overwriting someone else's edits.
  const editVersionRef = useRef<number>(0);
  const [editStaleNotice, setEditStaleNotice] = useState(false);

  // Create form images (uploaded but not yet attached to a quest)
  const [createImages, setCreateImages] = useState<QuestImage[]>([]);
  const [uploadingCreateImage, setUploadingCreateImage] = useState(false);
  const createFileInputRef = useRef<HTMLInputElement>(null);

  // Error state
  const [error, setError] = useState("");

  // Confirm delete
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Assign-to-session picker (questId → show picker)
  const [assignPickerForId, setAssignPickerForId] = useState<string | null>(null);

  // Collapsed phase groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<QuestmasterCollapsedGroup>>(
    () => new Set(initialViewState?.collapsedGroups ?? []),
  );

  // Lightbox for image preview
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // Feedback thread state
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackImages, setFeedbackImages] = useState<QuestImage[]>([]);
  const [uploadingFeedbackImage, setUploadingFeedbackImage] = useState(false);
  const feedbackTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Editing an existing feedback entry: { questId, index, text, images }
  const [editingFeedback, setEditingFeedback] = useState<{
    questId: string;
    index: number;
    text: string;
    images: QuestImage[];
  } | null>(null);
  const editFeedbackTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Version history toggle (questId → show history)
  const [historyForId, setHistoryForId] = useState<string | null>(null);
  function toggleHistory(questId: string) {
    setHistoryForId(historyForId === questId ? null : questId);
  }

  const closeQuestDetails = useCallback(() => {
    setExpandedId(null);
    setEditingId(null);
    const nextHash = withoutQuestIdInHash(window.location.hash);
    const currentHash = window.location.hash || "#/";
    if (nextHash !== currentHash) {
      window.location.hash = nextHash.startsWith("#") ? nextHash.slice(1) : nextHash;
    }
  }, []);

  // Close assign modal on Escape
  useEffect(() => {
    if (!assignPickerForId) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAssignPickerForId(null);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [assignPickerForId]);

  // Close quest detail modal on Escape
  useEffect(() => {
    if (!expandedId) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // When image preview is open, Esc should close that first.
        if (lightboxSrc) return;
        closeQuestDetails();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [expandedId, lightboxSrc, closeQuestDetails]);

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
      refreshQuests();
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
  }, [isActive, collapsedGroups]);

  // Persist immediately when collapse state changes.
  useEffect(() => {
    if (!isActive) return;
    if (!hasHydratedViewStateRef.current) return;
    saveQuestmasterViewState({
      scrollTop: scrollContainerRef.current?.scrollTop ?? 0,
      collapsedGroups: Array.from(collapsedGroups),
    });
  }, [isActive, collapsedGroups]);

  // Deep-link support: any hash with ?quest=q-123 should focus and expand that quest.
  useEffect(() => {
    const targetQuestId = questIdFromHash(hash);
    if (!targetQuestId) return;
    const targetQuest = quests.find((q) => q.questId === targetQuestId);
    if (!targetQuest) return;
    setFilter("all");
    // Ensure deep-linked quests are visible in the list as well as the modal.
    setCollapsedGroups((prev) => {
      const targetGroup = isVerificationInboxUnread(targetQuest) ? VERIFICATION_INBOX_COLLAPSE_KEY : targetQuest.status;
      if (!prev.has(targetGroup)) return prev;
      const next = new Set(prev);
      next.delete(targetGroup);
      return next;
    });
    setExpandedId(targetQuestId);
    setShowCreateForm(false);
    setEditingId(null);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-quest-id="${targetQuestId}"]`);
      if (el instanceof HTMLElement && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }, [hash, quests]);

  // If the quest being edited was remotely updated (version changed), exit
  // edit mode and briefly show a stale-data notice so the user knows why.
  useEffect(() => {
    if (!editingId) return;
    const storeQuest = quests.find((q) => q.questId === editingId);
    if (!storeQuest) {
      // Quest was deleted remotely — exit edit mode
      setEditingId(null);
      setEditStaleNotice(false);
      return;
    }
    if (storeQuest.version > editVersionRef.current) {
      setEditingId(null);
      setEditStaleNotice(true);
      // Auto-dismiss the stale notice after a few seconds
      const timer = setTimeout(() => setEditStaleNotice(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [editingId, quests]);

  // Focus title input when create form opens
  useEffect(() => {
    if (showCreateForm && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [showCreateForm]);

  function autoResize(ta: HTMLTextAreaElement | null) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  // Auto-resize on programmatic content changes (e.g. entering edit mode).
  // We also include showCreateForm/editingId so that autoResize fires when
  // the textarea first mounts with pre-existing content (the value deps alone
  // won't re-trigger if the value hasn't changed since the form appeared).
  useEffect(() => {
    autoResize(titleInputRef.current);
  }, [newTitle, showCreateForm]);
  useEffect(() => {
    autoResize(newDescRef.current);
  }, [newDescription, showCreateForm]);
  useEffect(() => {
    autoResize(editTitleRef.current);
  }, [editTitle, editingId]);
  useEffect(() => {
    autoResize(editDescRef.current);
  }, [editDescription, editingId]);

  const handleExpand = useCallback(
    (quest: QuestmasterTask) => {
      if (expandedId === quest.questId) {
        closeQuestDetails();
        return;
      }
      setExpandedId(quest.questId);
      setEditingId(null);
    },
    [expandedId, closeQuestDetails],
  );

  function enterEditMode(quest: QuestmasterTask) {
    setEditingId(quest.questId);
    setEditTitle(quest.title);
    setEditDescription("description" in quest ? (quest.description ?? "") : "");
    editVersionRef.current = quest.version;
    setEditStaleNotice(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditStaleNotice(false);
    setEditorHashtagQuery("");
    setEditorAutocompleteTarget(null);
    setEditorAutocompleteIndex(0);
  }

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
      setExpandedId(createdQuest.questId);
      setEditingId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handlePatch(questId: string) {
    setError("");
    try {
      const currentQuest = quests.find((q) => q.questId === questId);
      const nextDescription = editDescription.trim() || undefined;
      const extracted = extractHashtags(`${editTitle.trim()}\n${nextDescription ?? ""}`);
      const tags = extracted.length > 0 ? extracted : (currentQuest?.tags ?? []);
      const updatedQuest = await api.patchQuest(questId, {
        title: editTitle.trim() || undefined,
        description: nextDescription,
        tags: tags.length > 0 ? tags : undefined,
      });
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
      setEditingId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleMarkDone(quest: QuestmasterTask) {
    setError("");
    try {
      const verificationItems = getDoneVerificationItems(quest);
      const updatedQuest = verificationItems
        ? await api.markQuestDone(quest.questId, { verificationItems })
        : await api.markQuestDone(quest.questId);
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
      closeQuestDetails();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleTransition(quest: QuestmasterTask, status: QuestStatus) {
    if (status === "done") {
      await handleMarkDone(quest);
      return;
    }

    setError("");
    try {
      const sessionId = getQuestOwnerSessionId(quest);
      const updatedQuest = await api.transitionQuest(quest.questId, {
        status,
        ...(sessionId ? { sessionId } : {}),
      });
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCancel(quest: QuestmasterTask) {
    setError("");
    try {
      const updatedQuest = await api.markQuestDone(quest.questId, { cancelled: true });
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(questId: string) {
    setError("");
    try {
      await api.deleteQuest(questId);
      if (expandedId === questId) closeQuestDetails();
      setConfirmDeleteId(null);
      const currentQuests = useStore.getState().quests;
      setQuests(currentQuests.filter((q) => q.questId !== questId));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCheckVerification(questId: string, index: number, checked: boolean) {
    setError("");
    try {
      const updatedQuest = await api.checkQuestVerification(questId, index, checked);
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
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

  async function handleMarkVerificationRead(questId: string): Promise<boolean> {
    setError("");
    try {
      const updatedQuest = await api.markQuestVerificationRead(questId);
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function handleMarkVerificationInbox(questId: string) {
    setError("");
    try {
      const updatedQuest = await api.markQuestVerificationInbox(questId);
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleAddFeedback(questId: string, text: string) {
    if (!text.trim() && feedbackImages.length === 0) return;
    setFeedbackSubmitting(true);
    setError("");
    try {
      const updatedQuest = await api.addQuestFeedback(
        questId,
        text,
        "human",
        feedbackImages.length > 0 ? feedbackImages : undefined,
      );
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
      setFeedbackDraft("");
      setFeedbackImages([]);
      if (feedbackTextareaRef.current) {
        feedbackTextareaRef.current.style.height = "auto";
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  async function handleEditFeedbackSave() {
    if (!editingFeedback) return;
    if (!editingFeedback.text.trim() && editingFeedback.images.length === 0) return;
    setFeedbackSubmitting(true);
    setError("");
    try {
      const updatedQuest = await api.editQuestFeedback(editingFeedback.questId, editingFeedback.index, {
        text: editingFeedback.text,
        images: editingFeedback.images.length > 0 ? editingFeedback.images : undefined,
      });
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
      setEditingFeedback(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  async function handleToggleAddressed(questId: string, index: number) {
    setError("");
    try {
      const updatedQuest = await api.toggleFeedbackAddressed(questId, index);
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleFeedbackImageUpload(files: FileList | File[]) {
    setUploadingFeedbackImage(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const image = await api.uploadStandaloneQuestImage(file);
        setFeedbackImages((prev) => [...prev, image]);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingFeedbackImage(false);
    }
  }

  async function handleEditFeedbackImageUpload(files: FileList | File[]) {
    if (!editingFeedback) return;
    setUploadingFeedbackImage(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const image = await api.uploadStandaloneQuestImage(file);
        setEditingFeedback((prev) => (prev ? { ...prev, images: [...prev.images, image] } : prev));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingFeedbackImage(false);
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

  // ─── Image handling for existing quests (edit mode) ────────────

  const imageInputRef = useRef<HTMLInputElement>(null);

  async function handleImageUpload(questId: string, files: FileList | File[]) {
    setError("");
    let lastUpdatedQuest: QuestmasterTask | null = null;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        lastUpdatedQuest = await api.uploadQuestImage(questId, file);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    if (lastUpdatedQuest) {
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === lastUpdatedQuest.questId ? lastUpdatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    }
  }

  async function handleRemoveImage(questId: string, imageId: string) {
    setError("");
    try {
      const updatedQuest = await api.removeQuestImage(questId, imageId);
      const currentQuests = useStore.getState().quests;
      setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Paste handler for the edit form — uploads and attaches to the quest. */
  function handleEditPaste(questId: string, e: React.ClipboardEvent) {
    const files = extractPastedImages(e);
    if (files.length > 0) {
      e.preventDefault();
      handleImageUpload(questId, files);
    }
  }

  // Active sessions for the assign picker — built same as sidebar (newest first)
  const pickerSessions = useMemo(() => {
    return sdkSessions
      .filter((s) => s.state !== "exited" && !s.archived)
      .map((sdkInfo): SessionItemType => {
        const bridgeState = sessions.get(sdkInfo.sessionId);
        const sdkGitAhead = sdkInfo.gitAhead ?? 0;
        const sdkGitBehind = sdkInfo.gitBehind ?? 0;
        const gitAhead =
          bridgeState?.git_ahead === 0 && sdkGitAhead > 0 ? sdkGitAhead : (bridgeState?.git_ahead ?? sdkGitAhead);
        const gitBehind =
          bridgeState?.git_behind === 0 && sdkGitBehind > 0 ? sdkGitBehind : (bridgeState?.git_behind ?? sdkGitBehind);
        return {
          id: sdkInfo.sessionId,
          model: bridgeState?.model || sdkInfo.model || "",
          cwd: bridgeState?.cwd || sdkInfo.cwd || "",
          gitBranch: bridgeState?.git_branch || sdkInfo.gitBranch || "",
          isContainerized: bridgeState?.is_containerized || !!sdkInfo.containerId || false,
          gitAhead,
          gitBehind,
          linesAdded: bridgeState?.total_lines_added ?? sdkInfo.totalLinesAdded ?? 0,
          linesRemoved: bridgeState?.total_lines_removed ?? sdkInfo.totalLinesRemoved ?? 0,
          isConnected: cliConnected.get(sdkInfo.sessionId) ?? sdkInfo.cliConnected ?? false,
          status: sessionStatus.get(sdkInfo.sessionId) ?? null,
          sdkState: sdkInfo.state ?? null,
          createdAt: sdkInfo.createdAt ?? 0,
          archived: sdkInfo.archived ?? false,
          backendType: bridgeState?.backend_type || sdkInfo.backendType || "claude",
          repoRoot: bridgeState?.repo_root || sdkInfo.repoRoot || "",
          permCount: countUserPermissions(pendingPermissions.get(sdkInfo.sessionId)),
          cronJobId: bridgeState?.cronJobId || sdkInfo.cronJobId,
          cronJobName: bridgeState?.cronJobName || sdkInfo.cronJobName,
          isWorktree: bridgeState?.is_worktree || sdkInfo.isWorktree || false,
          worktreeExists: sdkInfo.worktreeExists,
          worktreeDirty: sdkInfo.worktreeDirty,
          askPermission: askPermissionMap?.get(sdkInfo.sessionId),
          idleKilled: cliDisconnectReason.get(sdkInfo.sessionId) === "idle_limit",
          isOrchestrator: sdkInfo.isOrchestrator || false,
          herdedBy: sdkInfo.herdedBy,
          sessionNum: sdkInfo.sessionNum ?? null,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [sdkSessions, sessions, cliConnected, sessionStatus, pendingPermissions, cliDisconnectReason, askPermissionMap]);

  async function handleAssignToSession(quest: QuestmasterTask, sessionId: string) {
    setAssignPickerForId(null);

    const draftText = buildQuestAssignDraft(quest.questId);

    useStore.getState().setComposerDraft(sessionId, {
      text: draftText,
      images: [],
    });
    navigateToSession(sessionId);
  }

  function handleReworkInSession(quest: QuestmasterTask, sessionId: string) {
    const draftText = buildQuestReworkDraft(quest.questId);
    useStore.getState().setComposerDraft(sessionId, {
      text: draftText,
      images: [],
    });
    navigateToSession(sessionId);
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
    if (!hashtagQuery) return [];
    const q = hashtagQuery.toLowerCase();
    return allTags.filter((t) => t.includes(q) && !selectedTags.has(t));
  }, [hashtagQuery, allTags, selectedTags]);

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
    if (target === "newDescription") return newDescription;
    if (target === "editTitle") return editTitle;
    return editDescription;
  }

  function setEditorText(target: EditorTarget, value: string) {
    if (target === "newTitle") setNewTitle(value);
    else if (target === "newDescription") setNewDescription(value);
    else if (target === "editTitle") setEditTitle(value);
    else setEditDescription(value);
  }

  function getEditorRef(target: EditorTarget) {
    if (target === "newTitle") return titleInputRef;
    if (target === "newDescription") return newDescRef;
    if (target === "editTitle") return editTitleRef;
    return editDescRef;
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
      autoResize(node);
    });
  }

  // ─── Filtering ────────────────────────────────────────────────────────

  // Layer 1: text search (case-insensitive on quest ID + title + description)
  // Strip any trailing #hashtag token from the search text
  const searchText = searchQuery.replace(/#[^\s]*$/, "").trim();
  const searchLower = searchText.toLowerCase();
  const afterSearch = searchLower
    ? quests.filter((q) => {
        if (q.questId.toLowerCase().includes(searchLower)) return true;
        if (q.title.toLowerCase().includes(searchLower)) return true;
        if (q.description && q.description.toLowerCase().includes(searchLower)) return true;
        return false;
      })
    : quests;

  // Layer 2: tag filter (OR — quest matches if it has ANY selected tag)
  const afterTags =
    selectedTags.size === 0
      ? afterSearch
      : afterSearch.filter((q) => q.tags?.some((t) => selectedTags.has(t.toLowerCase())) ?? false);

  // Status counts (after search + tags, before status filter)
  const counts: Record<string, number> = { all: afterTags.length };
  for (const s of ALL_STATUSES) {
    counts[s] = afterTags.filter((q) => q.status === s).length;
  }

  // Layer 3: status filter
  const filtered = filter === "all" ? afterTags : afterTags.filter((q) => q.status === filter);

  type QuestSection = {
    key: string;
    label: string;
    dotClass: string;
    textClass: string;
    quests: QuestmasterTask[];
    collapseGroup?: QuestmasterCollapsedGroup;
  };

  const showVerificationSplit = filter === "all" || filter === "needs_verification";
  const verificationInboxQuests = showVerificationSplit ? filtered.filter((q) => isVerificationInboxUnread(q)) : [];
  const regularVerificationQuests = showVerificationSplit
    ? filtered.filter((q) => q.status === "needs_verification" && !isVerificationInboxUnread(q))
    : [];
  const sortByRecencyDesc = (items: QuestmasterTask[]): QuestmasterTask[] =>
    [...items].sort((a, b) => questRecencyTs(b) - questRecencyTs(a));

  const questSections: QuestSection[] = [];
  if (showVerificationSplit && verificationInboxQuests.length > 0) {
    questSections.push({
      key: VERIFICATION_INBOX_COLLAPSE_KEY,
      label: "Verification Inbox",
      dotClass: "bg-amber-400",
      textClass: "text-amber-300",
      quests: sortByRecencyDesc(verificationInboxQuests),
      ...(filter === "all" ? { collapseGroup: VERIFICATION_INBOX_COLLAPSE_KEY } : {}),
    });
  }

  for (const status of filter === "all" ? DISPLAY_ORDER : ALL_STATUSES) {
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
      ...(filter === "all" ? { collapseGroup: status } : {}),
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

            {/* Status filter dropdown */}
            <div ref={statusDropdownRef} className="relative shrink-0">
              <button
                onClick={() => setStatusDropdownOpen((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-cc-hover border border-cc-border hover:border-cc-border text-cc-fg transition-colors cursor-pointer"
              >
                {filter !== "all" && <span className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[filter].dot}`} />}
                <span>{filter === "all" ? "All" : STATUS_CONFIG[filter].label}</span>
                <span className="text-[10px] text-cc-muted">{counts[filter] ?? 0}</span>
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
                <div className="absolute top-full left-0 mt-1 w-44 bg-cc-card border border-cc-border rounded-lg shadow-xl z-30 py-1 overflow-hidden">
                  {FILTER_TABS.map((tab) => {
                    const isActive = filter === tab.value;
                    const count = counts[tab.value] ?? 0;
                    return (
                      <button
                        key={tab.value}
                        onClick={() => {
                          setFilter(tab.value);
                          setStatusDropdownOpen(false);
                        }}
                        className={`w-full px-3 py-1.5 text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                          isActive ? "bg-cc-primary/10 text-cc-primary" : "text-cc-fg hover:bg-cc-hover"
                        }`}
                      >
                        {tab.value !== "all" ? (
                          <span className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[tab.value as QuestStatus].dot}`} />
                        ) : (
                          <span className="w-1.5" />
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
                    // Detect hashtag typing: find last # that starts a tag token
                    const hashIdx = val.lastIndexOf("#");
                    if (hashIdx >= 0) {
                      const afterHash = val.slice(hashIdx + 1);
                      // If there's no space after #, we're typing a tag
                      if (!/\s/.test(afterHash)) {
                        setHashtagQuery(afterHash);
                        setAutocompleteIndex(0);
                        setSearchQuery(val);
                        return;
                      }
                    }
                    setHashtagQuery("");
                    setSearchQuery(val);
                  }}
                  onKeyDown={(e) => {
                    // Autocomplete navigation
                    if (hashtagQuery && autocompleteMatches.length > 0) {
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
                          setAutocompleteIndex(0);
                        }
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      if (hashtagQuery) {
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
              {hashtagQuery && autocompleteMatches.length > 0 && searchFocused && (
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
        {/* Stale edit notice — shown when a quest is remotely updated while being edited */}
        {editStaleNotice && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400 flex items-center justify-between">
            <span>This quest was updated by another browser. Showing latest version.</span>
            <button
              onClick={() => setEditStaleNotice(false)}
              className="text-amber-400 hover:text-amber-300 cursor-pointer ml-2"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

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
                autoResize(e.target);
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
                autoResize(e.target);
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
                        onClick={() => setLightboxSrc(api.questImageUrl(img.id))}
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
            questSections.map((section) => {
              const isCollapsible = !!section.collapseGroup;
              const isCollapsed = !!section.collapseGroup && collapsedGroups.has(section.collapseGroup);
              const showSectionHeader =
                filter === "all" ||
                (filter === "needs_verification" &&
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
                  {!isCollapsed && (
                    <>
                      {viewMode === "compact" && (
                        <CompactQuestTable
                          quests={section.quests}
                          onOpenQuest={handleExpand}
                          renderSearchHighlight={renderSearchHighlight}
                        />
                      )}
                      <div
                        className={viewMode === "compact" ? "hidden" : "space-y-2"}
                        aria-hidden={viewMode === "compact"}
                        style={viewMode === "compact" ? { display: "none" } : undefined}
                      >
                        {section.quests.map((quest) => {
                        const isCancelled = "cancelled" in quest && !!(quest as { cancelled?: boolean }).cancelled;
                        const cfg = STATUS_CONFIG[quest.status];
                        const isExpanded = expandedId === quest.questId;
                        const isEditing = editingId === quest.questId;
                        const isInboxVerification = isVerificationInboxUnread(quest);
                        const hasVerification = "verificationItems" in quest && quest.verificationItems?.length > 0;
                        const vProgress = hasVerification ? verificationProgress(quest.verificationItems) : null;
                        const description = "description" in quest ? quest.description : undefined;
                        const questNotes = "notes" in quest ? (quest as { notes?: string }).notes : undefined;
                        const questSessionId = getQuestOwnerSessionId(quest);
                        const isKnownSession = questSessionId
                          ? sdkSessions.some((s) => s.sessionId === questSessionId)
                          : false;
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

                              {/* Expanded detail */}
                              {isExpanded &&
                                createPortal(
                                  <div
                                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-3 py-4"
                                    onClick={closeQuestDetails}
                                  >
                                    <div
                                      className="w-[min(920px,100%)] max-h-[88dvh] bg-cc-card border border-cc-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
                                      role="dialog"
                                      aria-modal="true"
                                      aria-label={`Quest details: ${quest.title}`}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <div className="shrink-0 flex items-start justify-between gap-3 px-4 py-3 border-b border-cc-border">
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-2">
                                            <span
                                              className={`w-2 h-2 rounded-full shrink-0 ${isCancelled ? "bg-red-400" : cfg.dot}`}
                                            />
                                            <span
                                              className={`text-xs font-medium px-1.5 py-0.5 rounded-full border ${cfg.border} ${cfg.bg} ${cfg.text}`}
                                            >
                                              {cfg.label}
                                            </span>
                                            <CopyableQuestId questId={quest.questId} />
                                          </div>
                                          <div className="flex items-center gap-2 mt-1 min-w-0">
                                            <div className="text-sm font-semibold text-cc-fg truncate">
                                              {quest.title}
                                            </div>
                                            {quest.parentId && (
                                              <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted shrink-0">
                                                sub:{quest.parentId}
                                              </span>
                                            )}
                                          </div>
                                          <div className="flex flex-wrap items-center gap-2 mt-1">
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
                                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
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
                                        <button
                                          type="button"
                                          onClick={closeQuestDetails}
                                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer shrink-0"
                                          aria-label="Close quest details"
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
                                      </div>
                                      <div
                                        className="overflow-y-auto px-4 pb-4 pt-3 space-y-3"
                                        onPaste={isEditing ? (e) => handleEditPaste(quest.questId, e) : undefined}
                                      >
                                        {isEditing ? (
                                          /* ─── Edit mode ─── */
                                          <>
                                            <div>
                                              <label className="block text-[11px] text-cc-muted mb-1">Title</label>
                                              <textarea
                                                ref={editTitleRef}
                                                value={editTitle}
                                                onChange={(e) => {
                                                  setEditTitle(e.target.value);
                                                  autoResize(e.target);
                                                  updateEditorHashtagState(
                                                    "editTitle",
                                                    e.target.value,
                                                    e.target.selectionStart ?? e.target.value.length,
                                                  );
                                                }}
                                                onFocus={(e) => {
                                                  updateEditorHashtagState(
                                                    "editTitle",
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
                                                  if (e.key === "Enter") e.preventDefault();
                                                }}
                                                rows={1}
                                                className="w-full px-3 py-2 text-base sm:text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/50 resize-none overflow-hidden"
                                                style={{ minHeight: "36px" }}
                                              />
                                              {renderEditorHashtagDropdown("editTitle")}
                                            </div>
                                            <div>
                                              <label className="block text-[11px] text-cc-muted mb-1">
                                                Description
                                              </label>
                                              <textarea
                                                ref={editDescRef}
                                                value={editDescription}
                                                onChange={(e) => {
                                                  setEditDescription(e.target.value);
                                                  autoResize(e.target);
                                                  updateEditorHashtagState(
                                                    "editDescription",
                                                    e.target.value,
                                                    e.target.selectionStart ?? e.target.value.length,
                                                  );
                                                }}
                                                onFocus={(e) => {
                                                  updateEditorHashtagState(
                                                    "editDescription",
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
                                                placeholder="Add a description..."
                                                rows={1}
                                                className="w-full px-3 py-2 text-base sm:text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 resize-none overflow-y-auto"
                                                style={{ minHeight: "36px", maxHeight: "200px" }}
                                              />
                                              <p className="text-[10px] text-cc-muted/60 mt-1">
                                                Tip: use #tag in description to attach tags.
                                              </p>
                                              {renderEditorHashtagDropdown("editDescription")}
                                            </div>

                                            {/* Images (always show upload in edit mode) */}
                                            <div>
                                              <label className="block text-[11px] text-cc-muted mb-1.5">Images</label>
                                              {quest.images && quest.images.length > 0 && (
                                                <div className="flex flex-wrap gap-2 mb-2">
                                                  {quest.images.map((img: QuestImage) => (
                                                    <div
                                                      key={img.id}
                                                      className="relative group rounded-lg overflow-hidden border border-cc-border bg-cc-input-bg"
                                                    >
                                                      <img
                                                        src={api.questImageUrl(img.id)}
                                                        alt={img.filename}
                                                        className="w-24 h-24 object-cover cursor-zoom-in"
                                                        onClick={() => setLightboxSrc(api.questImageUrl(img.id))}
                                                      />
                                                      <button
                                                        onClick={() => handleRemoveImage(quest.questId, img.id)}
                                                        className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center cursor-pointer"
                                                      >
                                                        <svg
                                                          viewBox="0 0 16 16"
                                                          fill="none"
                                                          stroke="white"
                                                          strokeWidth="2"
                                                          className="w-2.5 h-2.5"
                                                        >
                                                          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                                                        </svg>
                                                      </button>
                                                      <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
                                                        {img.filename}
                                                      </div>
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                              <div
                                                onDragOver={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                }}
                                                onDrop={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  if (e.dataTransfer.files.length > 0) {
                                                    handleImageUpload(quest.questId, e.dataTransfer.files);
                                                  }
                                                }}
                                                className="flex items-center gap-2"
                                              >
                                                <button
                                                  onClick={() => imageInputRef.current?.click()}
                                                  className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg border border-cc-border transition-colors cursor-pointer flex items-center gap-1.5"
                                                >
                                                  <svg
                                                    viewBox="0 0 16 16"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="1.5"
                                                    className="w-3 h-3"
                                                  >
                                                    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                                                    <circle cx="5" cy="6" r="1.5" />
                                                    <path d="M1.5 11l3-3.5 2.5 2.5 2-1.5 5.5 4" />
                                                  </svg>
                                                  Add Image
                                                </button>
                                                <span className="text-[10px] text-cc-muted/50">or drag & drop</span>
                                                <input
                                                  ref={imageInputRef}
                                                  type="file"
                                                  accept="image/*"
                                                  multiple
                                                  className="hidden"
                                                  onChange={(e) => {
                                                    if (e.target.files && e.target.files.length > 0) {
                                                      handleImageUpload(quest.questId, e.target.files);
                                                      e.target.value = "";
                                                    }
                                                  }}
                                                />
                                              </div>
                                            </div>

                                            {/* Save / Cancel */}
                                            <div className="flex items-center gap-2">
                                              <button
                                                onClick={() => handlePatch(quest.questId)}
                                                className="px-3 py-1.5 text-xs font-medium bg-cc-primary hover:bg-cc-primary-hover text-white rounded-lg transition-colors cursor-pointer"
                                              >
                                                Save
                                              </button>
                                              <button
                                                onClick={cancelEdit}
                                                className="px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg transition-colors cursor-pointer"
                                              >
                                                Cancel
                                              </button>
                                            </div>
                                          </>
                                        ) : (
                                          /* ─── Read mode ─── */
                                          <>
                                            {/* Description */}
                                            {description && (
                                              <MarkdownContent
                                                text={description}
                                                size="sm"
                                                searchHighlight={
                                                  searchText
                                                    ? { query: searchText, mode: "fuzzy", isCurrent: false }
                                                    : null
                                                }
                                              />
                                            )}

                                            {/* Images (read-only thumbnails, only if images exist) */}
                                            {quest.images && quest.images.length > 0 && (
                                              <div className="flex flex-wrap gap-2">
                                                {quest.images.map((img: QuestImage) => (
                                                  <div
                                                    key={img.id}
                                                    className="relative group rounded-lg overflow-hidden border border-cc-border bg-cc-input-bg"
                                                  >
                                                    <img
                                                      src={api.questImageUrl(img.id)}
                                                      alt={img.filename}
                                                      className="w-20 h-20 object-cover cursor-zoom-in"
                                                      onClick={() => setLightboxSrc(api.questImageUrl(img.id))}
                                                    />
                                                    <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
                                                      {img.filename}
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            )}

                                            {/* Verification checklist */}
                                            {hasVerification && (
                                              <div>
                                                <label className="block text-[11px] text-cc-muted mb-1">
                                                  Verification
                                                </label>
                                                <div className="space-y-0.5">
                                                  {quest.verificationItems.map(
                                                    (item: QuestVerificationItem, i: number) => (
                                                      <label
                                                        key={i}
                                                        className="flex items-start gap-2 py-1 px-2 rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
                                                      >
                                                        <input
                                                          type="checkbox"
                                                          checked={item.checked}
                                                          onChange={(e) =>
                                                            handleCheckVerification(quest.questId, i, e.target.checked)
                                                          }
                                                          className="mt-0.5 accent-cc-primary cursor-pointer"
                                                        />
                                                        <span
                                                          className={`text-xs ${
                                                            item.checked ? "text-cc-muted line-through" : "text-cc-fg"
                                                          }`}
                                                        >
                                                          {item.text}
                                                        </span>
                                                      </label>
                                                    ),
                                                  )}
                                                </div>
                                              </div>
                                            )}

                                            {/* Feedback thread */}
                                            {(() => {
                                              const feedbackEntries: QuestFeedbackEntry[] =
                                                "feedback" in quest
                                                  ? ((quest as { feedback?: QuestFeedbackEntry[] }).feedback ?? [])
                                                  : [];
                                              const hasFeedback = feedbackEntries.length > 0;
                                              const canAddFeedback =
                                                quest.status === "needs_verification" || quest.status === "in_progress";
                                              if (!hasFeedback && !canAddFeedback) return null;
                                              return (
                                                <div>
                                                  {hasFeedback && (
                                                    <>
                                                      <label className="block text-xs text-cc-muted mb-1">
                                                        Feedback
                                                      </label>
                                                      <div className="space-y-2 mb-2">
                                                        {feedbackEntries.map((entry, i) => {
                                                          const isEditing =
                                                            editingFeedback?.questId === quest.questId &&
                                                            editingFeedback?.index === i;
                                                          const feedbackSessionId =
                                                            entry.author === "agent"
                                                              ? entry.authorSessionId
                                                              : undefined;
                                                          const feedbackAuthorLabel = entry.author;
                                                          return (
                                                            <div
                                                              key={i}
                                                              className={`px-2.5 py-2 rounded-lg text-sm ${
                                                                entry.author === "human"
                                                                  ? entry.addressed
                                                                    ? "bg-amber-500/5 border border-amber-500/10 text-amber-300/50"
                                                                    : "bg-amber-500/8 border border-amber-500/15 text-amber-300/90"
                                                                  : "bg-cc-input-bg border border-cc-border text-cc-fg/80 ml-4"
                                                              }`}
                                                            >
                                                              <div className="flex items-center gap-1.5 mb-0.5">
                                                                {feedbackSessionId ? (
                                                                  <SessionNumChip
                                                                    sessionId={feedbackSessionId}
                                                                    className="text-xs font-medium font-mono text-cc-primary hover:text-cc-primary-hover cursor-pointer"
                                                                  />
                                                                ) : (
                                                                  <span
                                                                    className={`text-xs font-medium ${
                                                                      entry.author === "human"
                                                                        ? "text-amber-400/70"
                                                                        : "text-cc-muted"
                                                                    }`}
                                                                  >
                                                                    {feedbackAuthorLabel}
                                                                  </span>
                                                                )}
                                                                <span className="text-[11px] text-cc-muted/40">
                                                                  {timeAgo(entry.ts)}
                                                                </span>
                                                                {entry.author === "human" && entry.addressed && (
                                                                  <span className="text-[11px] text-green-500/60 font-medium">
                                                                    addressed
                                                                  </span>
                                                                )}
                                                                <span className="ml-auto flex items-center gap-1">
                                                                  {entry.author === "human" && (
                                                                    <button
                                                                      onClick={() =>
                                                                        handleToggleAddressed(quest.questId, i)
                                                                      }
                                                                      className={`px-1 py-0.5 rounded transition-colors cursor-pointer ${
                                                                        entry.addressed
                                                                          ? "text-green-500/50 hover:text-green-500/70"
                                                                          : "text-cc-muted/30 hover:text-green-500/60"
                                                                      }`}
                                                                      title={
                                                                        entry.addressed
                                                                          ? "Mark unaddressed"
                                                                          : "Mark addressed"
                                                                      }
                                                                    >
                                                                      <svg
                                                                        viewBox="0 0 16 16"
                                                                        fill="currentColor"
                                                                        className="w-3.5 h-3.5"
                                                                      >
                                                                        <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm11.354-1.646a.5.5 0 00-.708-.708L7 9.293 5.354 7.646a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" />
                                                                      </svg>
                                                                    </button>
                                                                  )}
                                                                  {entry.author === "human" && !isEditing && (
                                                                    <button
                                                                      onClick={() =>
                                                                        setEditingFeedback({
                                                                          questId: quest.questId,
                                                                          index: i,
                                                                          text: entry.text,
                                                                          images: entry.images ?? [],
                                                                        })
                                                                      }
                                                                      className="text-cc-muted/30 hover:text-cc-muted/60 cursor-pointer transition-colors"
                                                                      title="Edit"
                                                                    >
                                                                      <svg
                                                                        viewBox="0 0 16 16"
                                                                        fill="currentColor"
                                                                        className="w-3.5 h-3.5"
                                                                      >
                                                                        <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.386 1.35 1.35-.386a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354L12.427 2.487z" />
                                                                      </svg>
                                                                    </button>
                                                                  )}
                                                                </span>
                                                              </div>
                                                              {isEditing ? (
                                                                <div className="flex flex-col gap-1 mt-1">
                                                                  <textarea
                                                                    ref={editFeedbackTextareaRef}
                                                                    value={editingFeedback.text}
                                                                    onChange={(e) => {
                                                                      setEditingFeedback((prev) =>
                                                                        prev ? { ...prev, text: e.target.value } : prev,
                                                                      );
                                                                      e.target.style.height = "auto";
                                                                      e.target.style.height =
                                                                        e.target.scrollHeight + "px";
                                                                    }}
                                                                    className="w-full text-sm bg-cc-bg border border-amber-500/30 rounded-lg px-2.5 py-1.5 text-cc-fg focus:outline-none focus:ring-1 focus:ring-amber-500/30 resize-none"
                                                                    rows={2}
                                                                    onKeyDown={(e) => {
                                                                      if (
                                                                        e.key === "Enter" &&
                                                                        (e.metaKey || e.ctrlKey)
                                                                      ) {
                                                                        e.preventDefault();
                                                                        handleEditFeedbackSave();
                                                                      } else if (e.key === "Escape") {
                                                                        setEditingFeedback(null);
                                                                      }
                                                                    }}
                                                                    onPaste={(e) => {
                                                                      const imgs = extractPastedImages(e);
                                                                      if (imgs.length > 0)
                                                                        handleEditFeedbackImageUpload(imgs);
                                                                    }}
                                                                  />
                                                                  {editingFeedback.images.length > 0 && (
                                                                    <div className="flex flex-wrap gap-1">
                                                                      {editingFeedback.images.map((img) => (
                                                                        <div key={img.id} className="relative group">
                                                                          <img
                                                                            src={api.questImageUrl(img.id)}
                                                                            className="w-10 h-10 object-cover rounded cursor-pointer"
                                                                            onClick={() =>
                                                                              setLightboxSrc(api.questImageUrl(img.id))
                                                                            }
                                                                          />
                                                                          <button
                                                                            onClick={() =>
                                                                              setEditingFeedback((prev) =>
                                                                                prev
                                                                                  ? {
                                                                                      ...prev,
                                                                                      images: prev.images.filter(
                                                                                        (im) => im.id !== img.id,
                                                                                      ),
                                                                                    }
                                                                                  : prev,
                                                                              )
                                                                            }
                                                                            className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[8px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                                                          >
                                                                            x
                                                                          </button>
                                                                        </div>
                                                                      ))}
                                                                    </div>
                                                                  )}
                                                                  <div className="flex items-center gap-1.5">
                                                                    <button
                                                                      onClick={handleEditFeedbackSave}
                                                                      disabled={feedbackSubmitting}
                                                                      className="text-xs px-2.5 py-1 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 hover:bg-amber-500/25 disabled:opacity-40 cursor-pointer"
                                                                    >
                                                                      Save
                                                                    </button>
                                                                    <button
                                                                      onClick={() => setEditingFeedback(null)}
                                                                      className="text-xs px-2.5 py-1 rounded text-cc-muted hover:text-cc-fg cursor-pointer"
                                                                    >
                                                                      Cancel
                                                                    </button>
                                                                  </div>
                                                                </div>
                                                              ) : (
                                                                <>
                                                                  <MarkdownContent text={entry.text} size="sm" />
                                                                  {entry.images && entry.images.length > 0 && (
                                                                    <div className="flex flex-wrap gap-1 mt-1">
                                                                      {entry.images.map((img) => (
                                                                        <img
                                                                          key={img.id}
                                                                          src={api.questImageUrl(img.id)}
                                                                          className="w-16 h-16 object-cover rounded cursor-pointer hover:opacity-80 transition-opacity"
                                                                          title={img.filename}
                                                                          onClick={() =>
                                                                            setLightboxSrc(api.questImageUrl(img.id))
                                                                          }
                                                                        />
                                                                      ))}
                                                                    </div>
                                                                  )}
                                                                </>
                                                              )}
                                                            </div>
                                                          );
                                                        })}
                                                      </div>
                                                    </>
                                                  )}
                                                  {canAddFeedback && (
                                                    <div className="flex flex-col gap-1">
                                                      {!hasFeedback && (
                                                        <label className="block text-xs text-cc-muted mb-0.5">
                                                          Feedback
                                                        </label>
                                                      )}
                                                      <textarea
                                                        ref={feedbackTextareaRef}
                                                        value={expandedId === quest.questId ? feedbackDraft : ""}
                                                        onChange={(e) => {
                                                          setFeedbackDraft(e.target.value);
                                                          e.target.style.height = "auto";
                                                          e.target.style.height = e.target.scrollHeight + "px";
                                                        }}
                                                        placeholder="Leave feedback..."
                                                        className="w-full text-sm bg-cc-input-bg border border-cc-border rounded-lg px-2.5 py-2 text-cc-fg placeholder-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-amber-500/30 resize-none"
                                                        rows={2}
                                                        onKeyDown={(e) => {
                                                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                                            e.preventDefault();
                                                            handleAddFeedback(quest.questId, feedbackDraft);
                                                          }
                                                        }}
                                                        onPaste={(e) => {
                                                          const imgs = extractPastedImages(e);
                                                          if (imgs.length > 0) handleFeedbackImageUpload(imgs);
                                                        }}
                                                      />
                                                      {feedbackImages.length > 0 && expandedId === quest.questId && (
                                                        <div className="flex flex-wrap gap-1">
                                                          {feedbackImages.map((img) => (
                                                            <div key={img.id} className="relative group">
                                                              <img
                                                                src={api.questImageUrl(img.id)}
                                                                className="w-10 h-10 object-cover rounded cursor-pointer"
                                                                onClick={() =>
                                                                  setLightboxSrc(api.questImageUrl(img.id))
                                                                }
                                                              />
                                                              <button
                                                                onClick={() =>
                                                                  setFeedbackImages((prev) =>
                                                                    prev.filter((im) => im.id !== img.id),
                                                                  )
                                                                }
                                                                className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[8px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                                              >
                                                                x
                                                              </button>
                                                            </div>
                                                          ))}
                                                        </div>
                                                      )}
                                                      <div className="flex items-center gap-1.5">
                                                        <button
                                                          onClick={() =>
                                                            handleAddFeedback(quest.questId, feedbackDraft)
                                                          }
                                                          disabled={
                                                            (!feedbackDraft.trim() && feedbackImages.length === 0) ||
                                                            feedbackSubmitting
                                                          }
                                                          className="text-xs px-2.5 py-1 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 hover:bg-amber-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                                                        >
                                                          {feedbackSubmitting ? "Saving..." : "Add Feedback"}
                                                        </button>
                                                        {uploadingFeedbackImage && (
                                                          <span className="text-xs text-cc-muted animate-pulse">
                                                            Uploading...
                                                          </span>
                                                        )}
                                                        <span className="text-[11px] text-cc-muted/40 ml-auto">
                                                          {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+Enter
                                                        </span>
                                                      </div>
                                                    </div>
                                                  )}
                                                </div>
                                              );
                                            })()}

                                            {/* Notes */}
                                            {questNotes && (
                                              <div className="px-3 py-2 text-xs bg-cc-input-bg border border-cc-border rounded-lg">
                                                <MarkdownContent text={questNotes} size="sm" />
                                              </div>
                                            )}

                                            {/* Metadata: quest ID + version history button */}
                                            <div className="flex items-center gap-2 text-[10px] text-cc-muted/50">
                                              <CopyableQuestId
                                                questId={quest.questId}
                                                className="text-[10px] text-cc-muted/50"
                                              />
                                              {quest.version > 1 ? (
                                                <button
                                                  onClick={() => toggleHistory(quest.questId)}
                                                  className="px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer text-[10px]"
                                                >
                                                  v{quest.version} — {historyForId === quest.questId ? "hide" : "show"}{" "}
                                                  history
                                                </button>
                                              ) : (
                                                <span>v{quest.version}</span>
                                              )}
                                            </div>

                                            {/* Version history (lazy-loaded) */}
                                            {historyForId === quest.questId && (
                                              <QuestVersionHistory questId={quest.questId} />
                                            )}

                                            {/* Action bar: Edit, Assign, Transitions, Delete + inbox controls */}
                                            <div className="flex items-start justify-between gap-2 flex-wrap pt-1">
                                              <div className="flex items-center gap-1.5 flex-wrap">
                                                {/* Edit button */}
                                                <button
                                                  onClick={() => enterEditMode(quest)}
                                                  className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg border border-cc-border transition-colors cursor-pointer"
                                                >
                                                  Edit
                                                </button>

                                                {/* Assign to Session */}
                                                {quest.status !== "done" && (
                                                  <button
                                                    onClick={() => setAssignPickerForId(quest.questId)}
                                                    className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-primary/10 text-cc-primary border border-cc-primary/20 hover:bg-cc-primary/20 transition-colors cursor-pointer"
                                                  >
                                                    Assign
                                                  </button>
                                                )}

                                                {/* Separator */}
                                                <span className="w-px h-4 bg-cc-border mx-0.5" />

                                                {/* Status transitions */}
                                                {(() => {
                                                  const dropdownCfg = isCancelled
                                                    ? {
                                                        bg: "bg-red-500/10",
                                                        text: "text-red-400",
                                                        border: "border-red-500/20",
                                                      }
                                                    : cfg;
                                                  return (
                                                    <select
                                                      value={isCancelled ? "cancelled" : quest.status}
                                                      onChange={(e) => {
                                                        const val = e.target.value;
                                                        if (val === "cancelled") {
                                                          handleCancel(quest);
                                                        } else {
                                                          handleTransition(quest, val as QuestStatus);
                                                        }
                                                      }}
                                                      className={`px-2 py-1.5 text-[11px] font-medium rounded-lg cursor-pointer outline-none transition-colors ${dropdownCfg.bg} ${dropdownCfg.text} border ${dropdownCfg.border}`}
                                                    >
                                                      {ALL_STATUSES.map((s) => (
                                                        <option key={s} value={s}>
                                                          {STATUS_CONFIG[s].label}
                                                        </option>
                                                      ))}
                                                      <option key="cancelled" value="cancelled">
                                                        Cancelled
                                                      </option>
                                                    </select>
                                                  );
                                                })()}

                                                {/* Separator */}
                                                <span className="w-px h-4 bg-cc-border mx-0.5" />

                                                {/* Complete quest */}
                                                {quest.status !== "done" && (
                                                  <>
                                                    <button
                                                      onClick={() => handleTransition(quest, "done")}
                                                      className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-primary text-white border border-cc-primary/40 hover:bg-cc-primary-hover transition-colors cursor-pointer"
                                                    >
                                                      Finish Quest
                                                    </button>
                                                    {/* Separator */}
                                                    <span className="w-px h-4 bg-cc-border mx-0.5" />
                                                  </>
                                                )}

                                                {/* Rework in session */}
                                                {questSessionId && isKnownSession && (
                                                  <>
                                                    <button
                                                      type="button"
                                                      onClick={() => handleReworkInSession(quest, questSessionId)}
                                                      disabled={unaddressedFeedbackCount === 0}
                                                      title={
                                                        unaddressedFeedbackCount > 0
                                                          ? "Switch to this session and draft a rework message for quest feedback."
                                                          : "No unaddressed human feedback."
                                                      }
                                                      className={`px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                                                        unaddressedFeedbackCount > 0
                                                          ? "bg-cc-hover text-cc-fg border-cc-border hover:bg-amber-500/10 hover:text-amber-300 hover:border-amber-500/20 cursor-pointer"
                                                          : "bg-cc-hover text-cc-muted/60 border-cc-border cursor-not-allowed"
                                                      }`}
                                                    >
                                                      Rework
                                                    </button>
                                                    {/* Separator */}
                                                    <span className="w-px h-4 bg-cc-border mx-0.5" />
                                                  </>
                                                )}

                                                {/* Delete */}
                                                {confirmDeleteId === quest.questId ? (
                                                  <>
                                                    <button
                                                      onClick={() => handleDelete(quest.questId)}
                                                      className="px-2 py-1.5 text-[11px] font-medium rounded-lg bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25 transition-colors cursor-pointer"
                                                    >
                                                      Confirm Delete
                                                    </button>
                                                    <button
                                                      onClick={() => setConfirmDeleteId(null)}
                                                      className="px-2 py-1.5 text-[11px] font-medium text-cc-muted hover:text-cc-fg rounded-lg transition-colors cursor-pointer"
                                                    >
                                                      Cancel
                                                    </button>
                                                  </>
                                                ) : (
                                                  <button
                                                    onClick={() => setConfirmDeleteId(quest.questId)}
                                                    className="px-2 py-1.5 text-[11px] font-medium text-cc-muted hover:text-red-400 rounded-lg transition-colors cursor-pointer"
                                                  >
                                                    Delete
                                                  </button>
                                                )}
                                              </div>

                                              {quest.status === "needs_verification" &&
                                                (isInboxVerification ? (
                                                  <button
                                                    onClick={async () => {
                                                      const marked = await handleMarkVerificationRead(quest.questId);
                                                      if (marked) {
                                                        closeQuestDetails();
                                                      }
                                                    }}
                                                    title="Remove from Verification Inbox and keep it in Verification for now."
                                                    className="ml-auto px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted border border-cc-border hover:bg-amber-500/10 hover:text-amber-300 hover:border-amber-500/20 transition-colors cursor-pointer"
                                                  >
                                                    Later
                                                  </button>
                                                ) : (
                                                  <button
                                                    onClick={() => handleMarkVerificationInbox(quest.questId)}
                                                    title="Move this quest back to Verification Inbox to prioritize it again."
                                                    className="ml-auto px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted border border-cc-border hover:bg-amber-500/10 hover:text-amber-300 hover:border-amber-500/20 transition-colors cursor-pointer"
                                                  >
                                                    Inbox
                                                  </button>
                                                ))}
                                            </div>
                                          </>
                                        )}
                                      </div>
                                    </div>
                                  </div>,
                                  document.body,
                                )}
                            </div>
                          </div>
                        );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Image lightbox */}
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      {/* Assign-to-session modal */}
      {assignPickerForId &&
        (() => {
          const assignQuest = quests.find((q) => q.questId === assignPickerForId);
          if (!assignQuest) return null;
          return createPortal(
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
              onClick={() => setAssignPickerForId(null)}
            >
              <div
                className="w-[min(480px,90vw)] max-h-[70vh] bg-cc-card border border-cc-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-cc-border shrink-0">
                  <div>
                    <h3 className="text-sm font-semibold text-cc-fg">Assign to Session</h3>
                    <p className="text-[11px] text-cc-muted truncate mt-0.5">{assignQuest.title}</p>
                  </div>
                  <button
                    onClick={() => setAssignPickerForId(null)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
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
                </div>

                {/* Session list */}
                {pickerSessions.length === 0 ? (
                  <div className="px-4 py-8 text-xs text-cc-muted text-center">No active sessions</div>
                ) : (
                  <div className="overflow-y-auto p-2 space-y-0.5">
                    {pickerSessions.map((s) => (
                      <PickerSessionChip
                        key={s.id}
                        session={s}
                        sessionName={sessionNames.get(s.id)}
                        sessionPreview={sessionPreviews.get(s.id)}
                        onClick={() => handleAssignToSession(assignQuest, s.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>,
            document.body,
          );
        })()}
    </div>
  );
}

// ─── Picker session chip (read-only mirror of SessionItem) ───────────────────

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

/** Read-only session chip for the assign picker, matching the sidebar's visual layout. */
function PickerSessionChip({
  session: s,
  sessionName,
  sessionPreview,
  onClick,
}: {
  session: SessionItemType;
  sessionName: string | undefined;
  sessionPreview: string | undefined;
  onClick: () => void;
}) {
  const taskPreview = useStore((st) => st.sessionTaskPreview.get(s.id));
  const userUpdatedAt = useStore((st) => st.sessionPreviewUpdatedAt.get(s.id) ?? 0);

  const label = sessionName || s.model || s.id.slice(0, 8);
  const backendLogo = s.backendType === "codex" ? "/logo-codex.svg" : "/logo.png";
  const backendAlt = s.backendType === "codex" ? "Codex" : "Claude";
  const showTask = taskPreview && taskPreview.updatedAt > userUpdatedAt;
  const hasBranchDivergence = s.gitAhead > 0 || s.gitBehind > 0;
  const hasLineDiff = s.linesAdded > 0 || s.linesRemoved > 0;

  return (
    <button
      onClick={onClick}
      className="relative w-full pl-3.5 pr-3 py-2 text-left rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
    >
      {/* Left accent border */}
      <span
        className={`absolute left-0 top-2 bottom-2 w-[2px] rounded-full ${
          s.backendType === "codex" ? "bg-blue-500" : "bg-[#D97757]"
        } opacity-40`}
      />

      <div className="flex items-start gap-2">
        {/* Status dot */}
        <SessionStatusDot
          permCount={s.permCount}
          isConnected={s.isConnected}
          sdkState={s.sdkState}
          status={s.status}
          idleKilled={s.idleKilled}
        />

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Row 1: Name */}
          <span className="text-[13px] font-medium truncate text-cc-fg leading-snug block">{label}</span>

          {/* Row 2: Preview — active task or last user message */}
          {showTask ? (
            <div className="mt-0.5 text-[10.5px] text-cc-primary/60 leading-tight truncate italic">
              {taskPreview.text}
            </div>
          ) : sessionPreview ? (
            <div className="mt-0.5 text-[10.5px] text-cc-muted/60 leading-tight truncate">{sessionPreview}</div>
          ) : null}

          {/* Row 3: Metadata — backend, permissions, branch, badges */}
          <div className="flex items-center gap-1 mt-0.5 text-[10.5px] text-cc-muted leading-tight">
            <img src={backendLogo} alt={backendAlt} className="w-3 h-3 shrink-0 object-contain opacity-60" />
            {s.backendType !== "codex" && s.askPermission === true && (
              <span title="Permissions: asking before tool use">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 text-cc-primary">
                  <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                  <path
                    d="M6.5 8.5L7.5 9.5L10 7"
                    stroke="white"
                    strokeWidth="1.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            )}
            {s.backendType !== "codex" && s.askPermission === false && (
              <span title="Permissions: auto-approving tool use">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  className="w-2.5 h-2.5 shrink-0 text-cc-muted/50"
                >
                  <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                </svg>
              </span>
            )}
            {s.isContainerized && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-blue-400 bg-blue-500/10">
                Docker
              </span>
            )}
            {s.cronJobId && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-violet-500 bg-violet-500/10">
                Cron
              </span>
            )}
            {s.isOrchestrator && (
              <span
                className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-amber-500 bg-amber-500/10"
                title="Leader session"
              >
                leader
              </span>
            )}
            {!s.isOrchestrator && s.herdedBy && s.herdedBy.length > 0 && (
              <span
                className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-amber-400 bg-amber-500/10"
                title="Herded by a leader"
              >
                herd
              </span>
            )}
            {s.sessionNum != null && (
              <span className="text-[9px] font-mono text-cc-muted/60 shrink-0">#{s.sessionNum}</span>
            )}
            {s.gitBranch && (
              <>
                {s.isWorktree ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                    <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                    <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                  </svg>
                )}
                <span className="truncate">{s.gitBranch}</span>
                {s.isWorktree && (
                  <span className="text-[9px] px-1 rounded shrink-0 bg-cc-primary/10 text-cc-primary">wt</span>
                )}
              </>
            )}
          </div>

          {/* Row 4: Git stats */}
          {(hasBranchDivergence || hasLineDiff) && (
            <div className="flex items-center gap-1.5 mt-px text-[10px] text-cc-muted">
              {hasBranchDivergence && (
                <span className="flex items-center gap-0.5">
                  {s.gitAhead > 0 && <span className="text-green-500">{s.gitAhead}&#8593;</span>}
                  {s.gitBehind > 0 && <span className="text-cc-warning">{s.gitBehind}&#8595;</span>}
                </span>
              )}
              {hasLineDiff && (
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-green-500">+{s.linesAdded}</span>
                  <span className="text-red-400">-{s.linesRemoved}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Version history (lazy-loaded) ──────────────────────────────────────────

function QuestVersionHistory({ questId }: { questId: string }) {
  const [history, setHistory] = useState<QuestmasterTask[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setErr("");
    api
      .getQuestHistory(questId)
      .then((h) => {
        if (!active) return;
        // API returns all versions; show oldest-first, exclude the current (last) version
        const sorted = h.sort((a, b) => a.version - b.version);
        setHistory(sorted.slice(0, -1));
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [questId]);

  /** Navigate to the quest_claimed/quest_submitted chat message for this version. */
  const handleVersionClick = useCallback((ver: QuestmasterTask) => {
    const sessionId = "sessionId" in ver && typeof ver.sessionId === "string" ? ver.sessionId : undefined;
    if (!sessionId) return;

    // Match the variant that ws.ts uses for the chat message ID prefix
    const variant = ver.status === "needs_verification" ? "quest_submitted" : "quest_claimed";
    const prefix = `${variant}-${ver.questId}-`;

    // Search the session's messages for the closest match by timestamp
    const messages = useStore.getState().messages.get(sessionId) ?? [];
    const candidates = messages.filter((m) => m.id.startsWith(prefix));
    const match =
      candidates.length > 0
        ? candidates.reduce((best, m) => {
            const bestDist = Math.abs((best.timestamp ?? 0) - ver.createdAt);
            const mDist = Math.abs((m.timestamp ?? 0) - ver.createdAt);
            return mDist < bestDist ? m : best;
          })
        : undefined;

    if (match) {
      useStore.getState().requestScrollToMessage(sessionId, match.id);
    }
    navigateToSession(sessionId);
  }, []);

  if (loading) {
    return <div className="text-[10px] text-cc-muted py-1">Loading history...</div>;
  }
  if (err) {
    return <div className="text-[10px] text-red-400 py-1">{err}</div>;
  }
  if (!history || history.length === 0) {
    return <div className="text-[10px] text-cc-muted py-1">No previous versions.</div>;
  }

  return (
    <div className="space-y-1.5">
      {history.map((ver) => {
        const cfg = STATUS_CONFIG[ver.status];
        const description = "description" in ver ? ver.description : undefined;
        const hasSession = "sessionId" in ver && typeof ver.sessionId === "string" && !!ver.sessionId;
        return (
          <div
            key={ver.id}
            role={hasSession ? "button" : undefined}
            tabIndex={hasSession ? 0 : undefined}
            onClick={hasSession ? () => handleVersionClick(ver) : undefined}
            onKeyDown={
              hasSession
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleVersionClick(ver);
                    }
                  }
                : undefined
            }
            className={`px-3 py-2 rounded-lg bg-cc-input-bg border border-cc-border/50 text-xs${
              hasSession ? " cursor-pointer hover:bg-cc-hover/40 hover:border-cc-border transition-colors" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
              <span className="text-cc-fg font-medium">v{ver.version}</span>
              <span className={`text-[10px] ${cfg.text}`}>{cfg.label}</span>
              <span className="text-[10px] text-cc-muted/50 ml-auto">{timeAgo(ver.createdAt)}</span>
            </div>
            <div className="mt-1 text-cc-fg">{ver.title}</div>
            {description && (
              <div className="mt-0.5">
                <MarkdownContent text={description} size="sm" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
