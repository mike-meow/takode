/** Chip shown above the composer textarea when replying to a specific assistant message. */
export function ReplyChip({ previewText, onDismiss }: { previewText: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-2 pb-1 text-[12px] text-cc-muted">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        className="w-3 h-3 shrink-0 text-cc-primary"
      >
        <path d="M6 3L2 7l4 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 7h7a4 4 0 014 4v1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="truncate min-w-0">
        <span className="text-cc-muted">{previewText}</span>
      </span>
      <button
        onClick={onDismiss}
        className="shrink-0 p-0.5 rounded hover:bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
        aria-label="Cancel reply"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
