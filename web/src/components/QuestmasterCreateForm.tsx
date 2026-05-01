import { memo, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { api } from "../api.js";
import {
  autoResizeTextarea,
  extractHashtags,
  extractPastedImages,
  findHashtagTokenAtCursor,
} from "../utils/quest-editor-helpers.js";
import type { QuestImage, QuestmasterTask } from "../types.js";
import { Lightbox } from "./Lightbox.js";
import { QuestImageThumbnail } from "./QuestImageThumbnail.js";

type EditorTarget = "newTitle" | "newDescription";

export const QuestmasterCreateForm = memo(function QuestmasterCreateForm({
  isVisible,
  allTags,
  onCreated,
  onCancel,
}: {
  isVisible: boolean;
  allTags: string[];
  onCreated: (quest: QuestmasterTask) => void;
  onCancel: () => void;
}) {
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createImages, setCreateImages] = useState<QuestImage[]>([]);
  const [uploadingCreateImage, setUploadingCreateImage] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editorHashtagQuery, setEditorHashtagQuery] = useState("");
  const [editorAutocompleteIndex, setEditorAutocompleteIndex] = useState(0);
  const [editorAutocompleteTarget, setEditorAutocompleteTarget] = useState<EditorTarget | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const newDescRef = useRef<HTMLTextAreaElement>(null);
  const createFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isVisible) return;
    titleInputRef.current?.focus();
  }, [isVisible]);

  useEffect(() => {
    autoResizeTextarea(newDescRef.current);
  }, [newDescription]);

  const editorAutocompleteMatches = editorHashtagQuery
    ? allTags.filter((tag) => tag.includes(editorHashtagQuery.toLowerCase()))
    : [];
  const editorAutocompleteOptions = editorHashtagQuery
    ? [
        ...editorAutocompleteMatches.map((tag) => ({ tag, isNew: false })),
        ...(!allTags.includes(editorHashtagQuery.toLowerCase())
          ? [{ tag: editorHashtagQuery.toLowerCase(), isNew: true }]
          : []),
      ]
    : [];

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
      setNewTitle("");
      setNewDescription("");
      setCreateImages([]);
      setEditorHashtagQuery("");
      setEditorAutocompleteTarget(null);
      setEditorAutocompleteIndex(0);
      onCreated(createdQuest);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

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

  function handleCreatePaste(e: ClipboardEvent) {
    const files = extractPastedImages(e);
    if (files.length === 0) return;
    e.preventDefault();
    handleCreateImageUpload(files);
  }

  function removeCreateImage(imageId: string) {
    setCreateImages((prev) => prev.filter((img) => img.id !== imageId));
  }

  function getEditorText(target: EditorTarget): string {
    return target === "newTitle" ? newTitle : newDescription;
  }

  function setEditorText(target: EditorTarget, value: string) {
    if (target === "newTitle") setNewTitle(value);
    else setNewDescription(value);
  }

  function getEditorNode(target: EditorTarget): HTMLInputElement | HTMLTextAreaElement | null {
    return target === "newTitle" ? titleInputRef.current : newDescRef.current;
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
    const node = getEditorNode(target);
    const cursor = node?.selectionStart ?? current.length;
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
      const nextNode = getEditorNode(target);
      if (!nextNode) return;
      nextNode.focus();
      nextNode.setSelectionRange(nextCursor, nextCursor);
      if (nextNode instanceof HTMLTextAreaElement) autoResizeTextarea(nextNode);
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

  return (
    <div
      data-testid="questmaster-create-form"
      className={`mb-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3 ${isVisible ? "" : "hidden"}`}
      style={{ contain: "layout paint style" }}
      aria-hidden={!isVisible}
      onPaste={handleCreatePaste}
    >
      <h2 className="text-sm font-semibold text-cc-fg">New Quest</h2>
      {error && (
        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError("")} className="text-red-400 hover:text-red-300 cursor-pointer ml-2">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
      <input
        ref={titleInputRef}
        value={newTitle}
        onChange={(e) => {
          setNewTitle(e.target.value);
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
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Quest title"
        className="w-full px-3 py-2 text-base sm:text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
        style={{ minHeight: "36px" }}
      />
      {renderEditorHashtagDropdown("newTitle")}
      <textarea
        ref={newDescRef}
        value={newDescription}
        onChange={(e) => {
          setNewDescription(e.target.value);
          autoResizeTextarea(e.target);
          updateEditorHashtagState("newDescription", e.target.value, e.target.selectionStart ?? e.target.value.length);
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

      <div>
        {createImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {createImages.map((img) => (
              <QuestImageThumbnail
                key={img.id}
                image={img}
                onOpen={setLightboxSrc}
                imageClassName="w-16 h-16 object-cover cursor-zoom-in"
                showFilenameOverlay
                overlayClassName="absolute bottom-0 left-0 right-0 bg-black/50 px-0.5 py-px text-[8px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity"
                onRemove={removeCreateImage}
                removeButtonClassName="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 rounded-full flex items-center justify-center cursor-pointer"
                removeLabel={`Remove image ${img.filename}`}
                removeContent={
                  <svg viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="2" className="w-2 h-2">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                }
              />
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
            setCreateImages([]);
            onCancel();
          }}
          className="px-3 py-2 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
});
