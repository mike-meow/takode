import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import type { TranscriptionLogIndexEntry, TranscriptionLogEntry } from "../api.js";

function timeAgo(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function enhancementLabel(entry: TranscriptionLogIndexEntry): string {
  if (!entry.enhancement) return "STT only";
  if (entry.enhancement.skipReason) return `skipped: ${entry.enhancement.skipReason}`;
  if (entry.enhancement.enhancedText) return "enhanced";
  return "failed";
}

function enhancementColor(entry: TranscriptionLogIndexEntry): string {
  if (!entry.enhancement) return "text-cc-muted";
  if (entry.enhancement.skipReason) return "text-cc-warning";
  if (entry.enhancement.enhancedText) return "text-cc-success";
  return "text-cc-error";
}

export function TranscriptionDebugPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<TranscriptionLogIndexEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedEntry, setExpandedEntry] = useState<TranscriptionLogEntry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchIndex = useCallback(() => {
    setLoading(true);
    setError("");
    api.getTranscriptionLogs()
      .then((data) => { setEntries(data); setFetched(true); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next && !fetched) fetchIndex();
  };

  const handleToggle = async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedEntry(null);
      return;
    }
    setExpandedId(id);
    setExpandedEntry(null);
    setDetailLoading(true);
    try {
      const entry = await api.getTranscriptionLogEntry(id);
      setExpandedEntry(entry);
    } catch {
      setExpandedEntry(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const selectedIndexEntry = expandedId !== null ? entries.find((e) => e.id === expandedId) : null;

  // Close modal on Escape key
  useEffect(() => {
    if (expandedId === null) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpandedId(null);
        setExpandedEntry(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [expandedId]);

  return (
    <div>
      <button
        type="button"
        onClick={handleOpen}
        className="w-full flex items-center justify-between text-left cursor-pointer"
      >
        <h2 className="text-sm font-semibold text-cc-fg">Transcription Debug</h2>
        <span className="text-xs text-cc-muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-cc-muted">
              In-memory log of voice transcription calls.{fetched ? ` ${entries.length} entries.` : ""}
            </p>
            <button
              type="button"
              onClick={fetchIndex}
              disabled={loading}
              className="px-2 py-1 rounded text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-50"
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {error}
            </div>
          )}

          {entries.length > 0 && (
            <div className="space-y-1 max-h-[400px] overflow-y-auto">
              {entries.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-cc-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => handleToggle(entry.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-cc-hover transition-colors cursor-pointer ${expandedId === entry.id ? "bg-cc-hover" : ""}`}
                  >
                    <span className="text-cc-muted shrink-0 w-16">{timeAgo(entry.timestamp)}</span>
                    <span className="text-cc-fg shrink-0 font-mono text-[10px]">{entry.sttModel}</span>
                    <span className="text-cc-muted shrink-0">{formatDuration(entry.sttDurationMs)}</span>
                    <span className={`flex-1 truncate ${enhancementColor(entry)}`}>
                      {enhancementLabel(entry)}
                    </span>
                    {entry.enhancement && !entry.enhancement.skipReason && (
                      <span className="text-cc-muted shrink-0">{formatDuration(entry.enhancement.durationMs)}</span>
                    )}
                    <span className="text-cc-muted shrink-0 font-mono text-[10px]">{formatBytes(entry.audioSizeBytes)}</span>
                    {entry.sessionId && (
                      <span className="text-cc-muted shrink-0 font-mono text-[10px] w-16 truncate" title={entry.sessionId}>
                        {entry.sessionId.slice(0, 8)}
                      </span>
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Full-screen modal for entry detail */}
      {expandedId !== null && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => { setExpandedId(null); setExpandedEntry(null); }}
        >
          <div
            className="bg-cc-bg border border-cc-border rounded-xl shadow-2xl flex flex-col"
            style={{ width: "calc(100vw - 48px)", height: "calc(100vh - 48px)", maxWidth: "1400px" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-cc-border shrink-0">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold text-cc-fg">Transcription Detail</h3>
                {selectedIndexEntry && (
                  <>
                    <span className={`text-xs ${enhancementColor(selectedIndexEntry)}`}>
                      {enhancementLabel(selectedIndexEntry)}
                    </span>
                    <span className="text-xs text-cc-muted">
                      {timeAgo(selectedIndexEntry.timestamp)} &middot; STT {formatDuration(selectedIndexEntry.sttDurationMs)}
                      {selectedIndexEntry.enhancement && !selectedIndexEntry.enhancement.skipReason
                        ? ` &middot; Enh ${formatDuration(selectedIndexEntry.enhancement.durationMs)}`
                        : ""}
                      {selectedIndexEntry.sessionId ? ` \u00b7 ${selectedIndexEntry.sessionId.slice(0, 8)}` : ""}
                    </span>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setExpandedId(null); setExpandedEntry(null); }}
                className="px-2 py-1 rounded text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Close (Esc)
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {detailLoading ? (
                <p className="text-sm text-cc-muted">Loading...</p>
              ) : expandedEntry ? (
                <>
                  {/* STT info */}
                  <div className="text-xs text-cc-muted">
                    STT Model: <span className="text-cc-fg font-medium font-mono">{expandedEntry.sttModel}</span>
                    <span className="ml-3">Duration: <span className="text-cc-fg">{formatDuration(expandedEntry.sttDurationMs)}</span></span>
                    <span className="ml-3">Audio: <span className="text-cc-fg">{formatBytes(expandedEntry.audioSizeBytes)}</span></span>
                  </div>

                  <div>
                    <span className="text-[11px] uppercase tracking-wider text-cc-muted font-medium">Raw Transcript (Whisper Output)</span>
                    <pre className="mt-1 text-[12px] leading-relaxed text-cc-fg bg-cc-hover rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words font-mono">
                      {expandedEntry.rawTranscript || "(empty)"}
                    </pre>
                  </div>

                  {expandedEntry.sttPrompt && (
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-cc-muted font-medium">STT Prompt (sent to {expandedEntry.sttModel})</span>
                      <pre className="mt-1 text-[12px] leading-relaxed text-cc-fg bg-cc-hover rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words font-mono">
                        {expandedEntry.sttPrompt}
                      </pre>
                    </div>
                  )}

                  {/* Enhancement section */}
                  {expandedEntry.enhancement ? (
                    <>
                      <div className="text-xs text-cc-muted border-t border-cc-border pt-3">
                        Enhancement Model: <span className="text-cc-fg font-medium font-mono">{expandedEntry.enhancement.model}</span>
                        <span className="ml-3">Duration: <span className="text-cc-fg">{formatDuration(expandedEntry.enhancement.durationMs)}</span></span>
                        {expandedEntry.enhancement.skipReason && (
                          <span className="ml-3">Skip reason: <span className="text-cc-warning">{expandedEntry.enhancement.skipReason}</span></span>
                        )}
                      </div>

                      {expandedEntry.enhancement.systemPrompt && (
                        <div>
                          <span className="text-[11px] uppercase tracking-wider text-cc-muted font-medium">System Prompt</span>
                          <pre className="mt-1 text-[12px] leading-relaxed text-cc-fg bg-cc-hover rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words font-mono">
                            {expandedEntry.enhancement.systemPrompt}
                          </pre>
                        </div>
                      )}

                      {expandedEntry.enhancement.userMessage && (
                        <div>
                          <span className="text-[11px] uppercase tracking-wider text-cc-muted font-medium">User Message (Context + Transcript)</span>
                          <pre className="mt-1 text-[12px] leading-relaxed text-cc-fg bg-cc-hover rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words font-mono">
                            {expandedEntry.enhancement.userMessage}
                          </pre>
                        </div>
                      )}

                      <div>
                        <span className="text-[11px] uppercase tracking-wider text-cc-muted font-medium">Enhanced Result</span>
                        <pre className="mt-1 text-[12px] leading-relaxed text-cc-fg bg-cc-hover rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words font-mono">
                          {expandedEntry.enhancement.enhancedText ?? "(null — skipped, failed, or hallucination guard)"}
                        </pre>
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-cc-muted border-t border-cc-border pt-3">
                      Enhancement was not attempted for this transcription.
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-cc-error">Failed to load details</p>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
