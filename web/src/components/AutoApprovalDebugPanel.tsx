import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import type { AutoApprovalLogIndexEntry, AutoApprovalLogEntry } from "../api.js";

function timeAgo(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function decisionLabel(entry: AutoApprovalLogIndexEntry): string {
  if (entry.parsed) return `${entry.parsed.decision}: ${entry.parsed.reason}`;
  if (entry.failureReason) return entry.failureReason;
  return "error/timeout";
}

function decisionColor(parsed: AutoApprovalLogIndexEntry["parsed"]): string {
  if (!parsed) return "text-cc-error";
  return parsed.decision === "approve" ? "text-cc-success" : "text-cc-warning";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AutoApprovalDebugPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AutoApprovalLogIndexEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedEntry, setExpandedEntry] = useState<AutoApprovalLogEntry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchIndex = useCallback(() => {
    setLoading(true);
    setError("");
    api
      .getAutoApprovalLogs()
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
      const entry = await api.getAutoApprovalLogEntry(id);
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
        <h2 className="text-sm font-semibold text-cc-fg">Auto-Approval Debug</h2>
        <span className="text-xs text-cc-muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-cc-muted">
              In-memory log of LLM auto-approval evaluations.{fetched ? ` ${entries.length} entries.` : ""}
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
                    <span className="text-cc-fg shrink-0 font-mono-code">{entry.toolName}</span>
                    <span className="text-cc-muted shrink-0 text-[10px] font-mono-code">{entry.model}</span>
                    <span className={`flex-1 truncate ${decisionColor(entry.parsed)}`}>{decisionLabel(entry)}</span>
                    <span className="text-cc-muted shrink-0">{formatDuration(entry.durationMs)}</span>
                    {(entry.queueWaitMs ?? 0) > 0 && (
                      <span
                        className="text-cc-warning shrink-0 text-[10px]"
                        title={`Waited ${formatDuration(entry.queueWaitMs!)} in queue`}
                      >
                        +{formatDuration(entry.queueWaitMs!)}q
                      </span>
                    )}
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
                  <h3 className="text-sm font-semibold text-cc-fg">Auto-Approval Call Detail</h3>
                  {selectedIndexEntry && (
                    <>
                      <span className="text-xs font-mono-code text-cc-fg">{selectedIndexEntry.toolName}</span>
                      <span className={`text-xs ${decisionColor(selectedIndexEntry.parsed)}`}>
                        {selectedIndexEntry.parsed?.decision ?? "error"}
                      </span>
                      <span className="text-xs text-cc-muted">
                        {selectedIndexEntry.model} &middot; {timeAgo(selectedIndexEntry.timestamp)} &middot;{" "}
                        {formatDuration(selectedIndexEntry.durationMs)} &middot;{" "}
                        {selectedIndexEntry.sessionId.slice(0, 8)}
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
                    <div className="text-xs text-cc-muted">
                      Project:{" "}
                      <span className="text-cc-fg font-medium font-mono-code">{expandedEntry.projectPath}</span>
                      {(expandedEntry.queueWaitMs ?? 0) > 0 && (
                        <span className="ml-3">
                          Queue wait:{" "}
                          <span className="text-cc-warning">{formatDuration(expandedEntry.queueWaitMs!)}</span>
                        </span>
                      )}
                      {expandedEntry.failureReason && (
                        <span className="ml-3">
                          Failure: <span className="text-cc-error">{expandedEntry.failureReason}</span>
                        </span>
                      )}
                    </div>
                    {expandedEntry.failureDetail && (
                      <div>
                        <span className="text-[11px] uppercase tracking-wider text-cc-error font-medium">
                          Failure Detail
                        </span>
                        <pre className="mt-1 text-[12px] leading-relaxed text-cc-error bg-cc-error/5 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words font-mono border border-cc-error/10">
                          {expandedEntry.failureDetail}
                        </pre>
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
