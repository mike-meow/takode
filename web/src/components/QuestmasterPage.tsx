import { useState, useEffect, useCallback, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { navigateToSession } from "../utils/routing.js";
import type {
  QuestmasterTask,
  QuestStatus,
  QuestVerificationItem,
  QuestImage,
} from "../types.js";

// ─── Status config ──────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  QuestStatus,
  { label: string; dot: string; bg: string; text: string; border: string }
> = {
  idea: {
    label: "Idea",
    dot: "bg-zinc-400",
    bg: "bg-zinc-500/10",
    text: "text-zinc-400",
    border: "border-zinc-500/20",
  },
  refined: {
    label: "Refined",
    dot: "bg-blue-400",
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/20",
  },
  in_progress: {
    label: "In Progress",
    dot: "bg-amber-400",
    bg: "bg-amber-500/10",
    text: "text-amber-400",
    border: "border-amber-500/20",
  },
  needs_verification: {
    label: "Verification",
    dot: "bg-purple-400",
    bg: "bg-purple-500/10",
    text: "text-purple-400",
    border: "border-purple-500/20",
  },
  done: {
    label: "Done",
    dot: "bg-green-400",
    bg: "bg-green-500/10",
    text: "text-green-400",
    border: "border-green-500/20",
  },
};

const ALL_STATUSES: QuestStatus[] = [
  "idea",
  "refined",
  "in_progress",
  "needs_verification",
  "done",
];

const FILTER_TABS: Array<{ value: QuestStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "idea", label: "Idea" },
  { value: "refined", label: "Refined" },
  { value: "in_progress", label: "In Progress" },
  { value: "needs_verification", label: "Verification" },
  { value: "done", label: "Done" },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function verificationProgress(
  items: QuestVerificationItem[],
): { checked: number; total: number } {
  return {
    checked: items.filter((i) => i.checked).length,
    total: items.length,
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function QuestmasterPage() {
  const quests = useStore((s) => s.quests);
  const questsLoading = useStore((s) => s.questsLoading);
  const refreshQuests = useStore((s) => s.refreshQuests);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessionNames = useStore((s) => s.sessionNames);

  const [filter, setFilter] = useState<QuestStatus | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Create form state
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newTags, setNewTags] = useState("");
  const [creating, setCreating] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Edit state
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTags, setEditTags] = useState("");

  // Error state
  const [error, setError] = useState("");

  // Confirm delete
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Assign-to-session picker (questId → show picker)
  const [assignPickerForId, setAssignPickerForId] = useState<string | null>(null);

  // Load quests on mount
  useEffect(() => {
    refreshQuests();
  }, []);

  // Focus title input when create form opens
  useEffect(() => {
    if (showCreateForm && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [showCreateForm]);

  // Set up edit state when expanding a quest
  const handleExpand = useCallback(
    (quest: QuestmasterTask) => {
      if (expandedId === quest.questId) {
        setExpandedId(null);
        return;
      }
      setExpandedId(quest.questId);
      setEditTitle(quest.title);
      setEditDescription("description" in quest ? (quest.description ?? "") : "");
      setEditTags(quest.tags?.join(", ") ?? "");
    },
    [expandedId],
  );

  // ─── Actions ──────────────────────────────────────────────────────────

  async function handleCreate() {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    setError("");
    try {
      const tags = newTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await api.createQuest({
        title,
        description: newDescription.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
      });
      setNewTitle("");
      setNewDescription("");
      setNewTags("");
      setShowCreateForm(false);
      await refreshQuests();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handlePatch(questId: string) {
    setError("");
    try {
      const tags = editTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await api.patchQuest(questId, {
        title: editTitle.trim() || undefined,
        description: editDescription.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
      });
      await refreshQuests();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleTransition(questId: string, status: QuestStatus) {
    setError("");
    try {
      await api.transitionQuest(questId, {
        status,
        description: editDescription.trim() || undefined,
      });
      await refreshQuests();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(questId: string) {
    setError("");
    try {
      await api.deleteQuest(questId);
      if (expandedId === questId) setExpandedId(null);
      setConfirmDeleteId(null);
      await refreshQuests();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCheckVerification(
    questId: string,
    index: number,
    checked: boolean,
  ) {
    setError("");
    try {
      await api.checkQuestVerification(questId, index, checked);
      await refreshQuests();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ─── Image handling ──────────────────────────────────────────────

  const imageInputRef = useRef<HTMLInputElement>(null);

  async function handleImageUpload(questId: string, files: FileList | File[]) {
    setError("");
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        await api.uploadQuestImage(questId, file);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    await refreshQuests();
  }

  async function handleRemoveImage(questId: string, imageId: string) {
    setError("");
    try {
      await api.removeQuestImage(questId, imageId);
      await refreshQuests();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Active sessions for the assign picker (non-archived, non-exited)
  const activeSessions = sdkSessions.filter(
    (s) => s.state !== "exited" && !s.archived,
  );

  async function handleAssignToSession(
    quest: QuestmasterTask,
    sessionId: string,
  ) {
    setError("");
    try {
      await api.claimQuest(quest.questId, sessionId);
      await refreshQuests();
      setAssignPickerForId(null);

      // Build composer draft
      const lines: string[] = [];
      lines.push("I have a quest for you:\n");
      lines.push(`**${quest.title}** (${quest.questId})\n`);
      if ("description" in quest && quest.description) {
        lines.push(quest.description);
        lines.push("");
      }
      if (quest.tags?.length) {
        lines.push(`Tags: ${quest.tags.join(", ")}`);
      }
      if (quest.images?.length) {
        lines.push("");
        lines.push(
          `Reference images (${quest.images.length}): ${quest.images.map((img: QuestImage) => img.path).join(", ")}`,
        );
      }
      const draftText = lines.join("\n").trim();

      // Fetch quest images as base64 for the composer so they get sent to the agent
      const composerImages: Array<{
        name: string;
        base64: string;
        mediaType: string;
      }> = [];
      if (quest.images?.length) {
        for (const img of quest.images as QuestImage[]) {
          try {
            const res = await fetch(api.questImageUrl(img.id));
            if (res.ok) {
              const buf = await res.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let binary = "";
              for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              composerImages.push({
                name: img.filename,
                base64: btoa(binary),
                mediaType: img.mimeType,
              });
            }
          } catch {
            // Skip failed image fetches
          }
        }
      }

      useStore
        .getState()
        .setComposerDraft(sessionId, {
          text: draftText,
          images: composerImages,
        });
      navigateToSession(sessionId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ─── Filtering ────────────────────────────────────────────────────────

  const filtered =
    filter === "all" ? quests : quests.filter((q) => q.status === filter);

  // Status counts for tab badges
  const counts: Record<string, number> = { all: quests.length };
  for (const s of ALL_STATUSES) {
    counts[s] = quests.filter((q) => q.status === s).length;
  }

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className="h-full bg-cc-bg overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <div className="flex-1">
            <h1 className="text-xl font-semibold text-cc-fg">Quests</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Track tasks from idea to completion. Sessions claim quests to work
              on.
            </p>
          </div>
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="py-2 px-3 text-sm font-medium rounded-[10px] bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors duration-150 flex items-center gap-1.5 cursor-pointer"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="w-3.5 h-3.5"
            >
              <path d="M8 3v10M3 8h10" />
            </svg>
            New Quest
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={() => setError("")}
              className="text-red-400 hover:text-red-300 cursor-pointer ml-2"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="w-3 h-3"
              >
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        {/* Create form */}
        {showCreateForm && (
          <div className="mb-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
            <h2 className="text-sm font-semibold text-cc-fg">New Quest</h2>
            <input
              ref={titleInputRef}
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTitle.trim()) handleCreate();
                if (e.key === "Escape") setShowCreateForm(false);
              }}
              placeholder="Quest title"
              className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
            />
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Description (optional)"
              rows={3}
              className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 resize-y"
            />
            <input
              type="text"
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
              placeholder="Tags (comma separated)"
              className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
            />
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
                onClick={() => setShowCreateForm(false)}
                className="px-3 py-2 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Filter tabs */}
        <div className="mb-4 flex items-center gap-1 flex-wrap">
          {FILTER_TABS.map((tab) => {
            const isActive = filter === tab.value;
            const count = counts[tab.value] ?? 0;
            return (
              <button
                key={tab.value}
                onClick={() => setFilter(tab.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors cursor-pointer flex items-center gap-1.5 ${
                  isActive
                    ? "bg-cc-primary/15 text-cc-primary border border-cc-primary/30"
                    : "bg-cc-hover text-cc-muted hover:text-cc-fg border border-transparent"
                }`}
              >
                {tab.value !== "all" && (
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[tab.value as QuestStatus].dot}`}
                  />
                )}
                {tab.label}
                {count > 0 && (
                  <span
                    className={`text-[10px] ${isActive ? "text-cc-primary/70" : "text-cc-muted/60"}`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Quest list */}
        <div className="space-y-2">
          {questsLoading && quests.length === 0 ? (
            <div className="text-sm text-cc-muted text-center py-12">
              Loading quests...
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-cc-muted text-center py-12">
              {quests.length === 0
                ? "No quests yet. Create one to get started."
                : "No quests match this filter."}
            </div>
          ) : (
            filtered.map((quest) => {
              const isCancelled = "cancelled" in quest && !!(quest as { cancelled?: boolean }).cancelled;
              const cfg = STATUS_CONFIG[quest.status];
              const isExpanded = expandedId === quest.questId;
              const hasVerification =
                "verificationItems" in quest &&
                quest.verificationItems?.length > 0;
              const vProgress = hasVerification
                ? verificationProgress(quest.verificationItems)
                : null;

              return (
                <div
                  key={quest.id}
                  className={`border rounded-xl overflow-hidden transition-colors ${
                    isExpanded
                      ? "bg-cc-card border-cc-primary/30"
                      : `bg-cc-card border-cc-border hover:border-cc-border/80 ${isCancelled ? "opacity-60" : ""}`
                  }`}
                >
                  {/* Card header */}
                  <button
                    onClick={() => handleExpand(quest)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer group"
                  >
                    {/* Status dot */}
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${isCancelled ? "bg-red-400" : cfg.dot}`}
                    />

                    {/* Title + meta */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium truncate ${isCancelled ? "text-cc-muted line-through" : "text-cc-fg"}`}>
                          {quest.title}
                        </span>
                        {quest.parentId && (
                          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted shrink-0">
                            sub:{quest.parentId}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${isCancelled ? "bg-red-500/10 text-red-400" : `${cfg.bg} ${cfg.text}`}`}
                        >
                          {isCancelled ? "Cancelled" : cfg.label}
                        </span>
                        {quest.tags?.map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted"
                          >
                            {tag}
                          </span>
                        ))}
                        {"sessionId" in quest && quest.sessionId && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              window.location.hash = `#/session/${quest.sessionId}`;
                            }}
                            className="text-[10px] text-cc-primary hover:underline cursor-pointer"
                          >
                            session
                          </span>
                        )}
                        {vProgress && (
                          <span className="text-[10px] text-cc-muted flex items-center gap-1">
                            <svg
                              viewBox="0 0 16 16"
                              fill="currentColor"
                              className="w-3 h-3"
                            >
                              <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm11.354-1.646a.5.5 0 00-.708-.708L7 9.293 5.354 7.646a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" />
                            </svg>
                            {vProgress.checked}/{vProgress.total}
                          </span>
                        )}
                        <span className="text-[10px] text-cc-muted/50">
                          {timeAgo(quest.createdAt)}
                        </span>
                      </div>
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
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-cc-border space-y-3">
                      {/* Editable title */}
                      <div>
                        <label className="block text-[11px] text-cc-muted mb-1">
                          Title
                        </label>
                        <input
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/50"
                        />
                      </div>

                      {/* Editable description */}
                      <div>
                        <label className="block text-[11px] text-cc-muted mb-1">
                          Description
                        </label>
                        <textarea
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          placeholder="Add a description..."
                          rows={4}
                          className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 resize-y"
                        />
                      </div>

                      {/* Tags */}
                      <div>
                        <label className="block text-[11px] text-cc-muted mb-1">
                          Tags
                        </label>
                        <input
                          type="text"
                          value={editTags}
                          onChange={(e) => setEditTags(e.target.value)}
                          placeholder="Comma separated tags"
                          className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                        />
                      </div>

                      {/* Images */}
                      <div>
                        <label className="block text-[11px] text-cc-muted mb-1.5">
                          Images
                        </label>
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
                                  className="w-24 h-24 object-cover cursor-pointer"
                                  onClick={() =>
                                    window.open(
                                      api.questImageUrl(img.id),
                                      "_blank",
                                    )
                                  }
                                />
                                <button
                                  onClick={() =>
                                    handleRemoveImage(quest.questId, img.id)
                                  }
                                  className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                >
                                  <svg
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    stroke="white"
                                    strokeWidth="2"
                                    className="w-2.5 h-2.5"
                                  >
                                    <path
                                      d="M4 4l8 8M12 4l-8 8"
                                      strokeLinecap="round"
                                    />
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
                              handleImageUpload(
                                quest.questId,
                                e.dataTransfer.files,
                              );
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
                              <rect
                                x="1.5"
                                y="2.5"
                                width="13"
                                height="11"
                                rx="2"
                              />
                              <circle cx="5" cy="6" r="1.5" />
                              <path d="M1.5 11l3-3.5 2.5 2.5 2-1.5 5.5 4" />
                            </svg>
                            Add Image
                          </button>
                          <span className="text-[10px] text-cc-muted/50">
                            or drag & drop
                          </span>
                          <input
                            ref={imageInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                              if (e.target.files && e.target.files.length > 0) {
                                handleImageUpload(
                                  quest.questId,
                                  e.target.files,
                                );
                                e.target.value = "";
                              }
                            }}
                          />
                        </div>
                      </div>

                      {/* Save patch + Assign buttons */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => handlePatch(quest.questId)}
                          className="px-3 py-1.5 text-xs font-medium bg-cc-primary hover:bg-cc-primary-hover text-white rounded-lg transition-colors cursor-pointer"
                        >
                          Save Changes
                        </button>

                        {/* Assign to Session */}
                        {quest.status !== "done" && (
                          <div className="relative">
                            <button
                              onClick={() =>
                                setAssignPickerForId(
                                  assignPickerForId === quest.questId
                                    ? null
                                    : quest.questId,
                                )
                              }
                              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors cursor-pointer flex items-center gap-1.5"
                            >
                              <svg
                                viewBox="0 0 16 16"
                                fill="currentColor"
                                className="w-3 h-3"
                              >
                                <path d="M8 8a3 3 0 100-6 3 3 0 000 6zm-5 6a5 5 0 0110 0H3z" />
                              </svg>
                              Assign to Session
                            </button>

                            {/* Session picker dropdown */}
                            {assignPickerForId === quest.questId && (
                              <div className="absolute z-10 top-full left-0 mt-1 w-64 bg-cc-card border border-cc-border rounded-lg shadow-lg overflow-hidden">
                                {activeSessions.length === 0 ? (
                                  <div className="px-3 py-2 text-xs text-cc-muted">
                                    No active sessions
                                  </div>
                                ) : (
                                  <div className="max-h-48 overflow-y-auto">
                                    {activeSessions.map((session) => {
                                      const name =
                                        sessionNames.get(
                                          session.sessionId,
                                        ) ||
                                        session.sessionId.slice(0, 8);
                                      return (
                                        <button
                                          key={session.sessionId}
                                          onClick={() =>
                                            handleAssignToSession(
                                              quest,
                                              session.sessionId,
                                            )
                                          }
                                          className="w-full px-3 py-2 text-left text-xs text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2"
                                        >
                                          <span
                                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                              session.state === "connected"
                                                ? "bg-green-400"
                                                : "bg-zinc-400"
                                            }`}
                                          />
                                          <span className="truncate">
                                            {name}
                                          </span>
                                          <span className="text-cc-muted/50 text-[10px] shrink-0">
                                            {session.sessionId.slice(0, 8)}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Verification checklist */}
                      {hasVerification && (
                        <div>
                          <label className="block text-[11px] text-cc-muted mb-1.5">
                            Verification Checklist
                          </label>
                          <div className="space-y-1">
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
                                      handleCheckVerification(
                                        quest.questId,
                                        i,
                                        e.target.checked,
                                      )
                                    }
                                    className="mt-0.5 accent-cc-primary cursor-pointer"
                                  />
                                  <span
                                    className={`text-xs ${
                                      item.checked
                                        ? "text-cc-muted line-through"
                                        : "text-cc-fg"
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

                      {/* Notes */}
                      {"notes" in quest && (quest as { notes?: string }).notes && (
                        <div>
                          <label className="block text-[11px] text-cc-muted mb-1">
                            Notes
                          </label>
                          <div className="px-3 py-2 text-xs text-cc-fg bg-cc-input-bg border border-cc-border rounded-lg whitespace-pre-wrap">
                            {(quest as { notes: string }).notes}
                          </div>
                        </div>
                      )}

                      {/* Session link */}
                      {"sessionId" in quest && quest.sessionId && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-cc-muted">Session:</span>
                          <a
                            href={`#/session/${quest.sessionId}`}
                            className="text-cc-primary hover:underline"
                          >
                            {quest.sessionId}
                          </a>
                        </div>
                      )}

                      {/* Quest ID + version info */}
                      <div className="flex items-center gap-3 text-[10px] text-cc-muted/50">
                        <span>{quest.questId}</span>
                        <span>v{quest.version}</span>
                        {quest.prevId && <span>prev: {quest.prevId}</span>}
                      </div>

                      {/* Status transitions */}
                      <div>
                        <label className="block text-[11px] text-cc-muted mb-1.5">
                          Transition to
                        </label>
                        <div className="flex flex-wrap gap-1.5">
                          {ALL_STATUSES.filter(
                            (s) => s !== quest.status,
                          ).map((targetStatus) => {
                            const tcfg = STATUS_CONFIG[targetStatus];
                            return (
                              <button
                                key={targetStatus}
                                onClick={() =>
                                  handleTransition(quest.questId, targetStatus)
                                }
                                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-lg transition-colors cursor-pointer ${tcfg.bg} ${tcfg.text} border ${tcfg.border} hover:opacity-80`}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${tcfg.dot}`}
                                />
                                {tcfg.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Delete */}
                      <div className="pt-2 border-t border-cc-border">
                        {confirmDeleteId === quest.questId ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-red-400">
                              Delete all versions?
                            </span>
                            <button
                              onClick={() => handleDelete(quest.questId)}
                              className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25 transition-colors cursor-pointer"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2.5 py-1 text-[11px] font-medium text-cc-muted hover:text-cc-fg rounded-lg transition-colors cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() =>
                              setConfirmDeleteId(quest.questId)
                            }
                            className="text-xs text-cc-muted hover:text-red-400 transition-colors cursor-pointer"
                          >
                            Delete quest
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
