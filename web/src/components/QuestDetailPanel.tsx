import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useStore, countUserPermissions } from "../store.js";
import { api } from "../api.js";
import { navigateToSession, withoutQuestIdInHash } from "../utils/routing.js";
import { QUEST_STATUS_THEME } from "../utils/quest-status-theme.js";
import {
  extractPastedImages,
  extractHashtags,
  findHashtagTokenAtCursor,
  isVerificationInboxUnread,
  getDoneVerificationItems,
  autoResizeTextarea,
  isQuestCancelled,
  getQuestDescription,
  getQuestNotes,
  getQuestFeedback,
  getQuestUpdatedAt,
} from "../utils/quest-editor-helpers.js";
import { timeAgo, verificationProgress, getQuestOwnerSessionId, CopyableQuestId } from "../utils/quest-helpers.js";
import { SessionNumChip } from "./SessionNumChip.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { Lightbox } from "./Lightbox.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { buildQuestAssignDraft } from "./quest-assign.js";
import { buildQuestReworkDraft } from "./quest-rework.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import type { QuestmasterTask, QuestStatus, QuestVerificationItem, QuestImage } from "../types.js";

type EditorTarget = "editTitle" | "editDescription";

const STATUS_CONFIG = QUEST_STATUS_THEME;
const ALL_STATUSES: QuestStatus[] = ["idea", "refined", "in_progress", "needs_verification", "done"];

export function QuestDetailPanel() {
  const questOverlayId = useStore((s) => s.questOverlayId);
  const searchHighlight = useStore((s) => s.questOverlaySearchHighlight);
  const quests = useStore((s) => s.quests);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessions = useStore((s) => s.sessions);
  const sessionNames = useStore((s) => s.sessionNames);
  const sessionPreviews = useStore((s) => s.sessionPreviews);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const askPermissionMap = useStore((s) => s.askPermission);

  const quest = useMemo(
    () => (questOverlayId ? (quests.find((q) => q.questId === questOverlayId) ?? null) : null),
    [quests, questOverlayId],
  );

  // Local state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const editVersionRef = useRef<number>(0);
  const [editStaleNotice, setEditStaleNotice] = useState(false);
  const editTitleRef = useRef<HTMLTextAreaElement>(null);
  const editDescRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const [editorHashtagQuery, setEditorHashtagQuery] = useState("");
  const [editorAutocompleteIndex, setEditorAutocompleteIndex] = useState(0);
  const [editorAutocompleteTarget, setEditorAutocompleteTarget] = useState<EditorTarget | null>(null);

  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackImages, setFeedbackImages] = useState<QuestImage[]>([]);
  const [uploadingFeedbackImage, setUploadingFeedbackImage] = useState(false);
  const feedbackTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [editingFeedback, setEditingFeedback] = useState<{
    questId: string;
    index: number;
    text: string;
    images: QuestImage[];
  } | null>(null);
  const editFeedbackTextareaRef = useRef<HTMLTextAreaElement>(null);

  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [assignPickerForId, setAssignPickerForId] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [historyForId, setHistoryForId] = useState<string | null>(null);

  // Reset local state when quest changes
  useEffect(() => {
    setEditingId(null);
    setEditStaleNotice(false);
    setFeedbackDraft("");
    setFeedbackImages([]);
    setFeedbackSubmitting(false);
    setEditingFeedback(null);
    setError("");
    setConfirmDeleteId(null);
    setAssignPickerForId(null);
    setLightboxSrc(null);
    setHistoryForId(null);
    setEditorHashtagQuery("");
    setEditorAutocompleteTarget(null);
    setEditorAutocompleteIndex(0);
  }, [questOverlayId]);

  // Lock body scroll while open
  useEffect(() => {
    if (!questOverlayId) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [questOverlayId]);

  const closePanel = useCallback(() => {
    const currentHash = window.location.hash || "#/";
    const nextHash = withoutQuestIdInHash(currentHash);
    if (nextHash !== currentHash) {
      window.location.hash = nextHash.startsWith("#") ? nextHash.slice(1) : nextHash;
    }
    useStore.getState().closeQuestOverlay();
  }, []);

  // Escape key: lightbox > assign picker > edit cancel > close panel
  useEffect(() => {
    if (!questOverlayId) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (lightboxSrc) return; // Lightbox has its own Escape handler
      if (assignPickerForId) return; // Assign picker has its own Escape handler
      if (editingId) {
        cancelEdit();
        return;
      }
      closePanel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [questOverlayId, lightboxSrc, assignPickerForId, editingId, closePanel]);

  // Close assign picker on Escape
  useEffect(() => {
    if (!assignPickerForId) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAssignPickerForId(null);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [assignPickerForId]);

  // Stale edit detection
  useEffect(() => {
    if (!editingId) return;
    const storeQuest = quests.find((q) => q.questId === editingId);
    if (!storeQuest) {
      setEditingId(null);
      setEditStaleNotice(false);
      return;
    }
    if (storeQuest.version > editVersionRef.current) {
      setEditingId(null);
      setEditStaleNotice(true);
      const timer = setTimeout(() => setEditStaleNotice(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [editingId, quests]);

  useEffect(() => {
    autoResizeTextarea(editTitleRef.current);
  }, [editTitle, editingId]);
  useEffect(() => {
    autoResizeTextarea(editDescRef.current);
  }, [editDescription, editingId]);

  // Hashtag autocomplete
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const q of quests) {
      if (q.tags) for (const t of q.tags) tagSet.add(t.toLowerCase());
    }
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
  }, [quests]);

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
    if (target === "editTitle") return editTitle;
    return editDescription;
  }

  function setEditorText(target: EditorTarget, value: string) {
    if (target === "editTitle") setEditTitle(value);
    else setEditDescription(value);
  }

  function getEditorRef(target: EditorTarget) {
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
      autoResizeTextarea(node);
    });
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

  // Edit mode helpers
  function enterEditMode(q: QuestmasterTask) {
    setEditingId(q.questId);
    setEditTitle(q.title);
    setEditDescription("description" in q ? (q.description ?? "") : "");
    editVersionRef.current = q.version;
    setEditStaleNotice(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditStaleNotice(false);
    setEditorHashtagQuery("");
    setEditorAutocompleteTarget(null);
    setEditorAutocompleteIndex(0);
  }

  function toggleHistory(questId: string) {
    setHistoryForId(historyForId === questId ? null : questId);
  }

  // Actions
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
      useStore.getState().setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
      setEditingId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleMarkDone(q: QuestmasterTask) {
    setError("");
    try {
      const verificationItems = getDoneVerificationItems(q);
      const updatedQuest = verificationItems
        ? await api.markQuestDone(q.questId, { verificationItems })
        : await api.markQuestDone(q.questId);
      const currentQuests = useStore.getState().quests;
      useStore.getState().setQuests(
        currentQuests
          .map((x) => (x.questId === updatedQuest.questId ? updatedQuest : x))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
      closePanel();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleTransition(q: QuestmasterTask, status: QuestStatus) {
    if (status === "done") {
      await handleMarkDone(q);
      return;
    }
    setError("");
    try {
      const sessionId = getQuestOwnerSessionId(q);
      const updatedQuest = await api.transitionQuest(q.questId, {
        status,
        ...(sessionId ? { sessionId } : {}),
      });
      const currentQuests = useStore.getState().quests;
      useStore.getState().setQuests(
        currentQuests
          .map((x) => (x.questId === updatedQuest.questId ? updatedQuest : x))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCancel(q: QuestmasterTask) {
    setError("");
    try {
      const updatedQuest = await api.markQuestDone(q.questId, { cancelled: true });
      const currentQuests = useStore.getState().quests;
      useStore.getState().setQuests(
        currentQuests
          .map((x) => (x.questId === updatedQuest.questId ? updatedQuest : x))
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
      setConfirmDeleteId(null);
      const currentQuests = useStore.getState().quests;
      useStore.getState().setQuests(currentQuests.filter((q) => q.questId !== questId));
      closePanel();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCheckVerification(questId: string, index: number, checked: boolean) {
    setError("");
    try {
      const updatedQuest = await api.checkQuestVerification(questId, index, checked);
      useStore.getState().replaceQuest(updatedQuest);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleMarkVerificationRead(questId: string): Promise<boolean> {
    setError("");
    try {
      const updatedQuest = await api.markQuestVerificationRead(questId);
      const currentQuests = useStore.getState().quests;
      useStore.getState().setQuests(
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
      useStore.getState().setQuests(
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
      useStore.getState().setQuests(
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
      useStore.getState().setQuests(
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
      useStore.getState().setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function uploadStandaloneImages(files: FileList | File[], onImage: (img: QuestImage) => void) {
    setUploadingFeedbackImage(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const image = await api.uploadStandaloneQuestImage(file);
        onImage(image);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingFeedbackImage(false);
    }
  }

  function handleFeedbackImageUpload(files: FileList | File[]) {
    return uploadStandaloneImages(files, (img) => setFeedbackImages((prev) => [...prev, img]));
  }

  function handleEditFeedbackImageUpload(files: FileList | File[]) {
    if (!editingFeedback) return;
    return uploadStandaloneImages(files, (img) =>
      setEditingFeedback((prev) => (prev ? { ...prev, images: [...prev.images, img] } : prev)),
    );
  }

  async function handleImageUpload(questId: string, files: FileList | File[]) {
    setError("");
    let lastUpdatedQuest: QuestmasterTask | null = null;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        lastUpdatedQuest = await api.uploadQuestImage(questId, file);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        break;
      }
    }
    if (lastUpdatedQuest) {
      const currentQuests = useStore.getState().quests;
      useStore.getState().setQuests(
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
      useStore.getState().setQuests(
        currentQuests
          .map((q) => (q.questId === updatedQuest.questId ? updatedQuest : q))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleEditPaste(questId: string, e: React.ClipboardEvent) {
    const files = extractPastedImages(e);
    if (files.length > 0) {
      e.preventDefault();
      handleImageUpload(questId, files);
    }
  }

  function handleAssignToSession(q: QuestmasterTask, sessionId: string) {
    setAssignPickerForId(null);
    const draftText = buildQuestAssignDraft(q.questId);
    useStore.getState().setComposerDraft(sessionId, { text: draftText, images: [] });
    navigateToSession(sessionId);
    closePanel();
  }

  function handleReworkInSession(q: QuestmasterTask, sessionId: string) {
    const draftText = buildQuestReworkDraft(q.questId);
    useStore.getState().setComposerDraft(sessionId, { text: draftText, images: [] });
    navigateToSession(sessionId);
    closePanel();
  }

  // Active sessions for assign picker
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

  if (!quest || !questOverlayId) return null;

  const isCancelled = isQuestCancelled(quest);
  const cfg = STATUS_CONFIG[quest.status];
  const isEditing = editingId === quest.questId;
  const isInboxVerification = isVerificationInboxUnread(quest);
  const hasVerification = "verificationItems" in quest && quest.verificationItems?.length > 0;
  const vProgress = hasVerification ? verificationProgress(quest.verificationItems) : null;
  const description = getQuestDescription(quest);
  const questNotes = getQuestNotes(quest);
  const questSessionId = getQuestOwnerSessionId(quest);
  const isKnownSession = questSessionId ? sdkSessions.some((s) => s.sessionId === questSessionId) : false;
  const feedbackEntries = getQuestFeedback(quest);
  const unaddressedFeedbackCount =
    feedbackEntries.filter((e) => e.author === "human" && !e.addressed).length;
  const addressedFeedbackCount =
    feedbackEntries.filter((e) => e.author === "human" && e.addressed).length;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-3 py-4"
      onClick={closePanel}
      data-testid="quest-detail-panel-backdrop"
    >
      <div
        className="w-[min(920px,100%)] max-h-[88dvh] bg-cc-card border border-cc-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={`Quest details: ${quest.title}`}
        onClick={(e) => e.stopPropagation()}
        data-testid="quest-detail-panel"
      >
        {/* Header */}
        <div className="shrink-0 flex items-start justify-between gap-3 px-4 py-3 border-b border-cc-border">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${isCancelled ? "bg-red-400" : cfg.dot}`} />
              <span
                className={`text-xs font-medium px-1.5 py-0.5 rounded-full border ${cfg.border} ${cfg.bg} ${cfg.text}`}
              >
                {cfg.label}
              </span>
              <CopyableQuestId questId={quest.questId} />
            </div>
            <div className="flex items-center gap-2 mt-1 min-w-0">
              <div className="text-sm font-semibold text-cc-fg truncate">{quest.title}</div>
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
                    <span className="flex items-center gap-0.5 text-amber-400" aria-label={`${unaddressedFeedbackCount} pending feedback`}>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                        <path d="M2.5 2A1.5 1.5 0 001 3.5v8A1.5 1.5 0 002.5 13H5l3 3 3-3h2.5a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0013.5 2h-11z" />
                      </svg>
                      {unaddressedFeedbackCount}
                    </span>
                  )}
                  {addressedFeedbackCount > 0 && (
                    <span className="flex items-center gap-0.5 text-emerald-400/70" aria-label={`${addressedFeedbackCount} addressed feedback`}>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                        <path d="M2.5 2A1.5 1.5 0 001 3.5v8A1.5 1.5 0 002.5 13H5l3 3 3-3h2.5a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0013.5 2h-11z" />
                      </svg>
                      {addressedFeedbackCount}
                    </span>
                  )}
                </span>
              )}
              <span className="text-[10px] text-cc-muted/50">
                {timeAgo(getQuestUpdatedAt(quest))}
              </span>
            </div>
            {quest.tags && quest.tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {quest.tags.map((tag) => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted">
                    {tag.toLowerCase()}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={closePanel}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer shrink-0"
            aria-label="Close quest details"
            data-testid="quest-detail-panel-close"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Stale edit notice */}
        {editStaleNotice && (
          <div className="px-4 py-2 text-xs text-amber-400 bg-amber-500/10 border-b border-amber-500/20">
            Quest was updated remotely. Your edits were discarded to avoid conflicts.
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="px-4 py-2 text-xs text-red-400 bg-red-500/10 border-b border-red-500/20">
            {error}
          </div>
        )}

        {/* Scrollable body */}
        <div
          className="overflow-y-auto px-4 pb-4 pt-3 space-y-3"
          onPaste={isEditing ? (e) => handleEditPaste(quest.questId, e) : undefined}
        >
          {isEditing ? (
            <>
              <div>
                <label className="block text-[11px] text-cc-muted mb-1">Title</label>
                <textarea
                  ref={editTitleRef}
                  value={editTitle}
                  onChange={(e) => {
                    setEditTitle(e.target.value);
                    autoResizeTextarea(e.target);
                    updateEditorHashtagState("editTitle", e.target.value, e.target.selectionStart ?? e.target.value.length);
                  }}
                  onFocus={(e) => {
                    updateEditorHashtagState("editTitle", e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
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
                <label className="block text-[11px] text-cc-muted mb-1">Description</label>
                <textarea
                  ref={editDescRef}
                  value={editDescription}
                  onChange={(e) => {
                    setEditDescription(e.target.value);
                    autoResizeTextarea(e.target);
                    updateEditorHashtagState("editDescription", e.target.value, e.target.selectionStart ?? e.target.value.length);
                  }}
                  onFocus={(e) => {
                    updateEditorHashtagState("editDescription", e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
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
                <p className="text-[10px] text-cc-muted/60 mt-1">Tip: use #tag in description to attach tags.</p>
                {renderEditorHashtagDropdown("editDescription")}
              </div>

              {/* Images (edit mode) */}
              <div>
                <label className="block text-[11px] text-cc-muted mb-1.5">Images</label>
                {quest.images && quest.images.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {quest.images.map((img: QuestImage) => (
                      <div key={img.id} className="relative group rounded-lg overflow-hidden border border-cc-border bg-cc-input-bg">
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
                          <svg viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="2" className="w-2.5 h-2.5">
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
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.dataTransfer.files.length > 0) handleImageUpload(quest.questId, e.dataTransfer.files);
                  }}
                  className="flex items-center gap-2"
                >
                  <button
                    onClick={() => imageInputRef.current?.click()}
                    className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg border border-cc-border transition-colors cursor-pointer flex items-center gap-1.5"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
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
            <>
              {/* Description */}
              {description && (
                <MarkdownContent
                  text={description}
                  size="sm"
                  searchHighlight={
                    searchHighlight ? { query: searchHighlight, mode: "fuzzy", isCurrent: false } : null
                  }
                />
              )}

              {/* Images (read-only) */}
              {quest.images && quest.images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {quest.images.map((img: QuestImage) => (
                    <div key={img.id} className="relative group rounded-lg overflow-hidden border border-cc-border bg-cc-input-bg">
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
                  <label className="block text-[11px] text-cc-muted mb-1">Verification</label>
                  <div className="space-y-0.5">
                    {quest.verificationItems.map((item: QuestVerificationItem, i: number) => (
                      <label
                        key={i}
                        className="flex items-start gap-2 py-1 px-2 rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={item.checked}
                          onChange={(e) => handleCheckVerification(quest.questId, i, e.target.checked)}
                          className="mt-0.5 accent-cc-primary cursor-pointer"
                        />
                        <span className={`text-xs ${item.checked ? "text-cc-muted line-through" : "text-cc-fg"}`}>
                          {item.text}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Feedback thread */}
              {(() => {
                const hasFeedback = feedbackEntries.length > 0;
                const canAddFeedback = quest.status === "needs_verification" || quest.status === "in_progress";
                if (!hasFeedback && !canAddFeedback) return null;
                return (
                  <div>
                    {hasFeedback && (
                      <>
                        <label className="block text-xs text-cc-muted mb-1">Feedback</label>
                        <div className="space-y-2 mb-2">
                          {feedbackEntries.map((entry, i) => {
                            const isEntryEditing =
                              editingFeedback?.questId === quest.questId && editingFeedback?.index === i;
                            const feedbackSessionId = entry.author === "agent" ? entry.authorSessionId : undefined;
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
                                        entry.author === "human" ? "text-amber-400/70" : "text-cc-muted"
                                      }`}
                                    >
                                      {feedbackAuthorLabel}
                                    </span>
                                  )}
                                  <span className="text-[11px] text-cc-muted/40">{timeAgo(entry.ts)}</span>
                                  {entry.author === "human" && entry.addressed && (
                                    <span className="text-[11px] text-green-500/60 font-medium">addressed</span>
                                  )}
                                  <span className="ml-auto flex items-center gap-1">
                                    {entry.author === "human" && (
                                      <button
                                        onClick={() => handleToggleAddressed(quest.questId, i)}
                                        className={`px-1 py-0.5 rounded transition-colors cursor-pointer ${
                                          entry.addressed
                                            ? "text-green-500/50 hover:text-green-500/70"
                                            : "text-cc-muted/30 hover:text-green-500/60"
                                        }`}
                                        title={entry.addressed ? "Mark unaddressed" : "Mark addressed"}
                                      >
                                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                                          <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm11.354-1.646a.5.5 0 00-.708-.708L7 9.293 5.354 7.646a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" />
                                        </svg>
                                      </button>
                                    )}
                                    {entry.author === "human" && !isEntryEditing && (
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
                                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                                          <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.386 1.35 1.35-.386a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354L12.427 2.487z" />
                                        </svg>
                                      </button>
                                    )}
                                  </span>
                                </div>
                                {isEntryEditing ? (
                                  <div className="flex flex-col gap-1 mt-1">
                                    <textarea
                                      ref={editFeedbackTextareaRef}
                                      value={editingFeedback.text}
                                      onChange={(e) => {
                                        setEditingFeedback((prev) => (prev ? { ...prev, text: e.target.value } : prev));
                                        e.target.style.height = "auto";
                                        e.target.style.height = e.target.scrollHeight + "px";
                                      }}
                                      className="w-full text-sm bg-cc-bg border border-amber-500/30 rounded-lg px-2.5 py-1.5 text-cc-fg focus:outline-none focus:ring-1 focus:ring-amber-500/30 resize-none"
                                      rows={2}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                          e.preventDefault();
                                          handleEditFeedbackSave();
                                        } else if (e.key === "Escape") {
                                          setEditingFeedback(null);
                                        }
                                      }}
                                      onPaste={(e) => {
                                        const imgs = extractPastedImages(e);
                                        if (imgs.length > 0) handleEditFeedbackImageUpload(imgs);
                                      }}
                                    />
                                    {editingFeedback.images.length > 0 && (
                                      <div className="flex flex-wrap gap-1">
                                        {editingFeedback.images.map((img) => (
                                          <div key={img.id} className="relative group">
                                            <img
                                              src={api.questImageUrl(img.id)}
                                              className="w-10 h-10 object-cover rounded cursor-pointer"
                                              onClick={() => setLightboxSrc(api.questImageUrl(img.id))}
                                            />
                                            <button
                                              onClick={() =>
                                                setEditingFeedback((prev) =>
                                                  prev ? { ...prev, images: prev.images.filter((im) => im.id !== img.id) } : prev,
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
                                            onClick={() => setLightboxSrc(api.questImageUrl(img.id))}
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
                          <label className="block text-xs text-cc-muted mb-0.5">Feedback</label>
                        )}
                        <textarea
                          ref={feedbackTextareaRef}
                          value={feedbackDraft}
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
                        {feedbackImages.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {feedbackImages.map((img) => (
                              <div key={img.id} className="relative group">
                                <img
                                  src={api.questImageUrl(img.id)}
                                  className="w-10 h-10 object-cover rounded cursor-pointer"
                                  onClick={() => setLightboxSrc(api.questImageUrl(img.id))}
                                />
                                <button
                                  onClick={() => setFeedbackImages((prev) => prev.filter((im) => im.id !== img.id))}
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
                            onClick={() => handleAddFeedback(quest.questId, feedbackDraft)}
                            disabled={(!feedbackDraft.trim() && feedbackImages.length === 0) || feedbackSubmitting}
                            className="text-xs px-2.5 py-1 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 hover:bg-amber-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                          >
                            {feedbackSubmitting ? "Saving..." : "Add Feedback"}
                          </button>
                          {uploadingFeedbackImage && (
                            <span className="text-xs text-cc-muted animate-pulse">Uploading...</span>
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

              {/* Metadata: quest ID + version history */}
              <div className="flex items-center gap-2 text-[10px] text-cc-muted/50">
                <CopyableQuestId questId={quest.questId} className="text-[10px] text-cc-muted/50" />
                {quest.version > 1 ? (
                  <button
                    onClick={() => toggleHistory(quest.questId)}
                    className="px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer text-[10px]"
                  >
                    v{quest.version} -- {historyForId === quest.questId ? "hide" : "show"} history
                  </button>
                ) : (
                  <span>v{quest.version}</span>
                )}
              </div>

              {historyForId === quest.questId && <QuestVersionHistory questId={quest.questId} />}

              {/* Action bar */}
              <div className="flex items-start justify-between gap-2 flex-wrap pt-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={() => enterEditMode(quest)}
                    className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg border border-cc-border transition-colors cursor-pointer"
                  >
                    Edit
                  </button>

                  {quest.status !== "done" && (
                    <button
                      onClick={() => setAssignPickerForId(quest.questId)}
                      className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-primary/10 text-cc-primary border border-cc-primary/20 hover:bg-cc-primary/20 transition-colors cursor-pointer"
                    >
                      Assign
                    </button>
                  )}

                  <span className="w-px h-4 bg-cc-border mx-0.5" />

                  {(() => {
                    const dropdownCfg = isCancelled
                      ? { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20" }
                      : cfg;
                    return (
                      <select
                        value={isCancelled ? "cancelled" : quest.status}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === "cancelled") handleCancel(quest);
                          else handleTransition(quest, val as QuestStatus);
                        }}
                        className={`px-2 py-1.5 text-[11px] font-medium rounded-lg cursor-pointer outline-none transition-colors ${dropdownCfg.bg} ${dropdownCfg.text} border ${dropdownCfg.border}`}
                      >
                        {ALL_STATUSES.map((s) => (
                          <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
                        ))}
                        <option key="cancelled" value="cancelled">Cancelled</option>
                      </select>
                    );
                  })()}

                  <span className="w-px h-4 bg-cc-border mx-0.5" />

                  {quest.status !== "done" && (
                    <>
                      <button
                        onClick={() => handleTransition(quest, "done")}
                        className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-cc-primary text-white border border-cc-primary/40 hover:bg-cc-primary-hover transition-colors cursor-pointer"
                      >
                        Finish Quest
                      </button>
                      <span className="w-px h-4 bg-cc-border mx-0.5" />
                    </>
                  )}

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
                      <span className="w-px h-4 bg-cc-border mx-0.5" />
                    </>
                  )}

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
                        if (marked) closePanel();
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

      {/* Lightbox */}
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}

      {/* Assign picker modal */}
      {assignPickerForId &&
        (() => {
          const assignQuest = quests.find((q) => q.questId === assignPickerForId);
          if (!assignQuest) return null;
          return (
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
              onClick={() => setAssignPickerForId(null)}
            >
              <div
                className="w-[min(480px,90vw)] max-h-[70vh] bg-cc-card border border-cc-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-cc-border shrink-0">
                  <div>
                    <h3 className="text-sm font-semibold text-cc-fg">Assign to Session</h3>
                    <p className="text-[11px] text-cc-muted truncate mt-0.5">{assignQuest.title}</p>
                  </div>
                  <button
                    onClick={() => setAssignPickerForId(null)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
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
            </div>
          );
        })()}
    </div>,
    document.body,
  );
}

// ─── QuestVersionHistory ───────────────────────────────────────────────────

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

  const handleVersionClick = useCallback((ver: QuestmasterTask) => {
    const sessionId = "sessionId" in ver && typeof ver.sessionId === "string" ? ver.sessionId : undefined;
    if (!sessionId) return;

    const variant = ver.status === "needs_verification" ? "quest_submitted" : "quest_claimed";
    const prefix = `${variant}-${ver.questId}-`;

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

  if (loading) return <div className="text-[10px] text-cc-muted py-1">Loading history...</div>;
  if (err) return <div className="text-[10px] text-red-400 py-1">{err}</div>;
  if (!history || history.length === 0) return <div className="text-[10px] text-cc-muted py-1">No previous versions.</div>;

  return (
    <div className="space-y-1.5">
      {history.map((ver) => {
        const verCfg = STATUS_CONFIG[ver.status];
        const verDescription = "description" in ver ? ver.description : undefined;
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
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${verCfg.dot}`} />
              <span className="text-cc-fg font-medium">v{ver.version}</span>
              <span className={`text-[10px] ${verCfg.text}`}>{verCfg.label}</span>
              <span className="text-[10px] text-cc-muted/50 ml-auto">{timeAgo(ver.createdAt)}</span>
            </div>
            <div className="mt-1 text-cc-fg">{ver.title}</div>
            {verDescription && (
              <div className="mt-0.5">
                <MarkdownContent text={verDescription} size="sm" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── PickerSessionChip ─────────────────────────────────────────────────────

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
      <span
        className={`absolute left-0 top-2 bottom-2 w-[2px] rounded-full ${
          s.backendType === "codex" ? "bg-blue-500" : "bg-[#D97757]"
        } opacity-40`}
      />
      <div className="flex items-start gap-2">
        <SessionStatusDot
          permCount={s.permCount}
          isConnected={s.isConnected}
          sdkState={s.sdkState}
          status={s.status}
          idleKilled={s.idleKilled}
        />
        <div className="flex-1 min-w-0">
          <span className="text-[13px] font-medium truncate text-cc-fg leading-snug block">{label}</span>
          {showTask ? (
            <div className="mt-0.5 text-[10.5px] text-cc-primary/60 leading-tight truncate italic">
              {taskPreview.text}
            </div>
          ) : sessionPreview ? (
            <div className="mt-0.5 text-[10.5px] text-cc-muted/60 leading-tight truncate">{sessionPreview}</div>
          ) : null}
          <div className="flex items-center gap-1 mt-0.5 text-[10.5px] text-cc-muted leading-tight">
            <img src={backendLogo} alt={backendAlt} className="w-3 h-3 shrink-0 object-contain opacity-60" />
            {s.backendType !== "codex" && s.askPermission === true && (
              <span title="Permissions: asking before tool use">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 text-cc-primary">
                  <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                  <path d="M6.5 8.5L7.5 9.5L10 7" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
            {s.backendType !== "codex" && s.askPermission === false && (
              <span title="Permissions: auto-approving tool use">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-2.5 h-2.5 shrink-0 text-cc-muted/50">
                  <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                </svg>
              </span>
            )}
            {s.isContainerized && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-blue-400 bg-blue-500/10">Docker</span>
            )}
            {s.cronJobId && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-violet-500 bg-violet-500/10">Cron</span>
            )}
            {s.isOrchestrator && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-amber-500 bg-amber-500/10" title="Leader session">leader</span>
            )}
            {!s.isOrchestrator && s.herdedBy && s.herdedBy.length > 0 && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-amber-400 bg-amber-500/10" title="Herded by a leader">herd</span>
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
