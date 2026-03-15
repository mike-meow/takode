import { useEffect, type RefObject, type KeyboardEvent } from "react";
import { useStore, getSessionSearchState } from "../store.js";

/**
 * Horizontal search bar that appears below the TopBar inside ChatView.
 * Shows input, mode toggle, match counter, prev/next navigation, and close button.
 */
export function SearchBar({
  sessionId,
  inputRef,
}: {
  sessionId: string;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const searchState = useStore((s) => getSessionSearchState(s, sessionId));
  const setQuery = useStore((s) => s.setSessionSearchQuery);
  const setMode = useStore((s) => s.setSessionSearchMode);
  const navigate = useStore((s) => s.navigateSessionSearch);
  const close = useStore((s) => s.closeSessionSearch);

  const { query, mode, matches, currentMatchIndex, isOpen } = searchState;

  // Auto-focus when opened
  useEffect(() => {
    if (isOpen) {
      // Small delay to let the DOM render the bar before focusing
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen, inputRef]);

  if (!isOpen) return null;

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      close(sessionId);
      e.preventDefault();
    } else if (e.key === "Enter" && e.shiftKey) {
      navigate(sessionId, "prev");
      e.preventDefault();
    } else if (e.key === "Enter") {
      navigate(sessionId, "next");
      e.preventDefault();
    }
  }

  const hasMatches = matches.length > 0;
  const counterText = hasMatches
    ? `${currentMatchIndex + 1} of ${matches.length}`
    : query.trim().length > 0
      ? "No results"
      : "";

  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-cc-border bg-cc-card">
      {/* Search icon */}
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted shrink-0">
        <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85-.017.016zm-5.442.156a5 5 0 110-10 5 5 0 010 10z" />
      </svg>

      {/* Input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(sessionId, e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search messages..."
        className="flex-1 min-w-0 bg-transparent text-sm text-cc-fg placeholder:text-cc-muted outline-none"
      />

      {/* Mode toggle */}
      <button
        onClick={() => setMode(sessionId, mode === "strict" ? "fuzzy" : "strict")}
        className={`flex items-center justify-center w-7 h-7 rounded-lg text-xs font-mono-code transition-colors cursor-pointer ${
          mode === "strict" ? "bg-cc-hover text-cc-fg" : "bg-cc-primary/15 text-cc-primary"
        }`}
        title={mode === "strict" ? "Strict match (click for fuzzy)" : "Fuzzy match (click for strict)"}
      >
        {mode === "strict" ? "Aa" : "~"}
      </button>

      {/* Match counter */}
      {counterText && (
        <span className="text-[11px] text-cc-muted whitespace-nowrap tabular-nums shrink-0">{counterText}</span>
      )}

      {/* Previous match */}
      <button
        onClick={() => navigate(sessionId, "prev")}
        disabled={!hasMatches}
        className="flex items-center justify-center w-6 h-6 rounded-md transition-colors cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-cc-muted"
        title="Previous match (Shift+Enter)"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <path
            fillRule="evenodd"
            d="M8 3.293l-5.354 5.353a.5.5 0 00.708.708L8 4.707l4.646 4.647a.5.5 0 00.708-.708L8 3.293z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* Next match */}
      <button
        onClick={() => navigate(sessionId, "next")}
        disabled={!hasMatches}
        className="flex items-center justify-center w-6 h-6 rounded-md transition-colors cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-cc-muted"
        title="Next match (Enter)"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <path
            fillRule="evenodd"
            d="M8 12.707l5.354-5.353a.5.5 0 00-.708-.708L8 11.293 3.354 6.646a.5.5 0 00-.708.708L8 12.707z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* Close */}
      <button
        onClick={() => close(sessionId)}
        className="flex items-center justify-center w-6 h-6 rounded-md transition-colors cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
        title="Close search (Escape)"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <path
            fillRule="evenodd"
            d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}
