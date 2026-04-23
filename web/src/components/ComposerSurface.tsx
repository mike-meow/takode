import type { RefObject, ReactNode } from "react";
import { Lightbox } from "./Lightbox.js";

export function CollapsedComposerBar({
  isCollapsed,
  expandComposer,
  isPlan,
  onVoiceButton,
  compactVoiceButtonDisabled,
  voiceSupported,
  isPreparing,
  isRecording,
  voiceButtonTitle,
  isRunning,
  onStop,
}: {
  isCollapsed: boolean;
  expandComposer: () => void;
  isPlan: boolean;
  onVoiceButton: () => void;
  compactVoiceButtonDisabled: boolean;
  voiceSupported: boolean;
  isPreparing: boolean;
  isRecording: boolean;
  voiceButtonTitle: string;
  isRunning: boolean;
  onStop: () => void;
}) {
  if (!isCollapsed) return null;
  return (
    <div className="px-2 py-2">
      <div className="max-w-3xl mx-auto flex items-center gap-2">
        <button
          onClick={expandComposer}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 bg-cc-input-bg border border-cc-border rounded-[14px] cursor-text"
        >
          <span className="flex items-center gap-1 text-[11px] font-medium text-cc-muted shrink-0">
            {isPlan ? (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path d="M2 3.5h12v1H2zm0 4h8v1H2zm0 4h10v1H2z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path
                  d="M2.5 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
                <path
                  d="M8.5 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            )}
            {isPlan ? "Plan" : "Agent"}
          </span>
          <span className="flex-1 text-sm text-cc-muted text-left truncate">Type a message...</span>
        </button>
        <button
          onClick={onVoiceButton}
          disabled={compactVoiceButtonDisabled}
          aria-label="Voice input"
          aria-disabled={!voiceSupported || compactVoiceButtonDisabled}
          className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors shrink-0 ${
            !voiceSupported || compactVoiceButtonDisabled
              ? "text-cc-muted opacity-30 cursor-not-allowed"
              : isPreparing
                ? "text-cc-warning bg-cc-warning/10 cursor-wait"
                : isRecording
                  ? "text-red-500 bg-red-500/10 hover:bg-red-500/20 cursor-pointer"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
          }`}
          title={voiceButtonTitle}
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-5 h-5 ${isRecording || isPreparing ? "animate-pulse" : ""}`}
          >
            <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
            <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
          </svg>
        </button>
        {isRunning && (
          <button
            onClick={onStop}
            className="flex items-center justify-center w-10 h-10 rounded-lg bg-cc-error/10 hover:bg-cc-error/20 text-cc-error transition-colors cursor-pointer shrink-0"
            title="Stop generation"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

export function ComposerInputSurface({
  imageSrcs,
  lightboxSrc,
  setLightboxSrc,
  removeImage,
  retryImage,
  fileInputRef,
  handleFileSelect,
  handleComposerDragEnter,
  handleComposerDragOver,
  handleComposerDragLeave,
  handleComposerDrop,
  isImageDragOver,
  isPlan,
  textareaRef,
  text,
  handleInput,
  handleKeyDown,
  handlePaste,
  placeholder,
  isRecording,
  recordingCursorBefore,
  recordingCursorAfter,
  topChildren,
  bottomChildren,
}: {
  imageSrcs: Array<{
    id: string;
    src: string | null;
    name: string;
    status: "reading" | "uploading" | "ready" | "failed";
    error?: string;
  }>;
  lightboxSrc: string | null;
  setLightboxSrc: (src: string | null) => void;
  removeImage: (index: number) => void;
  retryImage: (imageId: string) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleComposerDragEnter: (e: React.DragEvent<HTMLDivElement>) => void;
  handleComposerDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  handleComposerDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  handleComposerDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  isImageDragOver: boolean;
  isPlan: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  handleInput: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handlePaste: (e: React.ClipboardEvent) => void;
  placeholder: string;
  isRecording: boolean;
  recordingCursorBefore: string;
  recordingCursorAfter: string;
  topChildren?: ReactNode;
  bottomChildren?: ReactNode;
}) {
  return (
    <div className="max-w-3xl mx-auto">
      {imageSrcs.length > 0 && (
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {imageSrcs.map(({ id, src, name, status, error }, i) => (
            <div key={id} className="relative group">
              {src ? (
                <img
                  src={src}
                  alt={name}
                  className="w-24 h-24 rounded-lg object-cover border border-cc-border cursor-zoom-in hover:opacity-80 transition-opacity"
                  onClick={() => setLightboxSrc(src)}
                />
              ) : (
                <div className="w-24 h-24 rounded-lg border border-cc-border bg-cc-hover flex items-center justify-center text-[10px] text-cc-muted">
                  Preparing...
                </div>
              )}
              <div className="pointer-events-none absolute inset-x-1 bottom-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] text-white">
                <div className="truncate font-medium">
                  {status === "reading"
                    ? "Preparing..."
                    : status === "uploading"
                      ? "Uploading..."
                      : status === "failed"
                        ? "Upload failed"
                        : "Ready"}
                </div>
                {error && <div className="truncate text-white/80">{error}</div>}
              </div>
              {status === "failed" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    retryImage(id);
                  }}
                  className="absolute left-1.5 top-1.5 rounded-full bg-cc-card/95 px-2 py-1 text-[10px] font-medium text-cc-primary shadow-sm transition-colors hover:bg-cc-card cursor-pointer"
                >
                  Retry
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeImage(i);
                }}
                aria-label={`Remove image ${name}`}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      {lightboxSrc && <Lightbox src={lightboxSrc} alt="attachment" onClose={() => setLightboxSrc(null)} />}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />

      <div
        data-testid="composer-input-card"
        onDragEnter={handleComposerDragEnter}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
        className={`relative bg-cc-input-bg border rounded-[14px] overflow-visible transition-colors ${
          isImageDragOver
            ? "border-cc-primary bg-cc-primary/5 shadow-[0_0_0_3px_rgba(255,122,26,0.12)]"
            : isPlan
              ? "border-cc-primary/40"
              : "border-cc-border focus-within:border-cc-primary/30"
        }`}
      >
        {isImageDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[14px] border border-dashed border-cc-primary/50 bg-cc-primary/10">
            <div className="rounded-full border border-cc-primary/25 bg-cc-card/95 px-3 py-1 text-[11px] font-medium text-cc-primary shadow-sm">
              Drop images to attach
            </div>
          </div>
        )}

        {topChildren}

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            spellCheck={false}
            placeholder={placeholder}
            rows={1}
            className={`w-full px-4 pt-3 pb-1 text-base sm:text-sm bg-transparent resize-none focus:outline-none font-sans-ui placeholder:text-cc-muted disabled:opacity-50 overflow-y-auto ${
              isRecording && recordingCursorAfter ? "text-transparent caret-transparent" : "text-cc-fg"
            }`}
            style={{ minHeight: "36px", maxHeight: "200px" }}
          />
          {isRecording && recordingCursorAfter && (
            <div className="absolute inset-0 px-4 pt-3 pb-1 text-base sm:text-sm font-sans-ui text-cc-fg pointer-events-none overflow-y-auto whitespace-pre-wrap break-words">
              <span>{recordingCursorBefore}</span>
              <span
                className="inline-block w-[2px] rounded-full animate-pulse mx-px"
                style={{ height: "1.15em", backgroundColor: "rgb(239 68 68 / 0.8)", verticalAlign: "text-bottom" }}
              />
              <span>{recordingCursorAfter}</span>
            </div>
          )}
        </div>

        {bottomChildren}
      </div>
    </div>
  );
}
