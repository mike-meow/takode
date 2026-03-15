import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import type { NamerLogIndexEntry, NamerLogEntry } from "../api.js";

function timeAgo(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function actionLabel(parsed: NamerLogIndexEntry["parsed"]): string {
  if (!parsed) return "error";
  switch (parsed.action) {
    case "name":
      return `named: "${parsed.title}"`;
    case "no_change":
      return "no change";
    case "revise":
      return `revise: "${parsed.title}"`;
    case "new":
      return `new: "${parsed.title}"`;
    default:
      return parsed.action;
  }
}

function actionColor(parsed: NamerLogIndexEntry["parsed"]): string {
  if (!parsed) return "text-cc-error";
  switch (parsed.action) {
    case "name":
      return "text-cc-success";
    case "no_change":
      return "text-cc-muted";
    case "revise":
      return "text-cc-warning";
    case "new":
      return "text-cc-primary";
    default:
      return "text-cc-fg";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function NamerDebugPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<NamerLogIndexEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedEntry, setExpandedEntry] = useState<NamerLogEntry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchIndex = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .getNamerLogs()
      .then((data) => {
        setEntries(data);
        setFetched(true);
      })
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
      const entry = await api.getNamerLogEntry(id);
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
        <h2 className="text-sm font-semibold text-cc-fg">Session Namer Debug</h2>
        <span className="text-xs text-cc-muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-cc-muted">
              In-memory log of Haiku naming calls.{fetched ? ` ${entries.length} entries.` : ""}
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
                    <span className={`flex-1 truncate ${actionColor(entry.parsed)}`}>{actionLabel(entry.parsed)}</span>
                    <span className="text-cc-muted shrink-0">{formatDuration(entry.durationMs)}</span>
                    <span
                      className="text-cc-muted shrink-0 font-mono text-[10px]"
                      title={`Prompt: ${entry.promptLength} chars`}
                    >
                      {entry.promptLength > 1000 ? `${(entry.promptLength / 1000).toFixed(1)}k` : entry.promptLength}ch
                    </span>
                    <span
                      className="text-cc-muted shrink-0 font-mono text-[10px] w-16 truncate"
                      title={entry.sessionId}
                    >
                      {entry.sessionId.slice(0, 8)}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Full-screen modal for entry detail */}
      {expandedId !== null &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => {
              setExpandedId(null);
              setExpandedEntry(null);
            }}
          >
            <div
              className="bg-cc-bg border border-cc-border rounded-xl shadow-2xl flex flex-col"
              style={{ width: "calc(100vw - 48px)", height: "calc(100vh - 48px)", maxWidth: "1400px" }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-cc-border shrink-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-cc-fg">Namer Call Detail</h3>
                  {selectedIndexEntry && (
                    <>
                      <span className={`text-xs ${actionColor(selectedIndexEntry.parsed)}`}>
                        {actionLabel(selectedIndexEntry.parsed)}
                      </span>
                      <span className="text-xs text-cc-muted">
                        {timeAgo(selectedIndexEntry.timestamp)} &middot; {formatDuration(selectedIndexEntry.durationMs)}{" "}
                        &middot; {selectedIndexEntry.sessionId.slice(0, 8)}
                      </span>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setExpandedId(null);
                    setExpandedEntry(null);
                  }}
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
                    {selectedIndexEntry?.currentName && (
                      <div className="text-xs text-cc-muted">
                        Current name at time of call:{" "}
                        <span className="text-cc-fg font-medium">{selectedIndexEntry.currentName}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-cc-muted font-medium">
                        System Prompt
                      </span>
                      <pre className="mt-1 text-[12px] leading-relaxed text-cc-fg bg-cc-hover rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words font-mono">
                        {expandedEntry.systemPrompt}
                      </pre>
                    </div>
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-cc-muted font-medium">Prompt</span>
                      <pre className="mt-1 text-[12px] leading-relaxed text-cc-fg bg-cc-hover rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words font-mono">
                        {expandedEntry.prompt}
                      </pre>
                    </div>
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-cc-muted font-medium">Response</span>
                      <pre className="mt-1 text-[12px] leading-relaxed text-cc-fg bg-cc-hover rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words font-mono">
                        {expandedEntry.rawResponse ?? "(null — timeout or error)"}
                      </pre>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-cc-error">Failed to load details</p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
