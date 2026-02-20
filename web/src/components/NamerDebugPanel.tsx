import { useCallback, useEffect, useState } from "react";
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
    case "name": return `named: "${parsed.title}"`;
    case "no_change": return "no change";
    case "revise": return `revise: "${parsed.title}"`;
    case "new": return `new: "${parsed.title}"`;
    default: return parsed.action;
  }
}

function actionColor(parsed: NamerLogIndexEntry["parsed"]): string {
  if (!parsed) return "text-cc-error";
  switch (parsed.action) {
    case "name": return "text-cc-success";
    case "no_change": return "text-cc-muted";
    case "revise": return "text-cc-warning";
    case "new": return "text-cc-primary";
    default: return "text-cc-fg";
  }
}

export function NamerDebugPanel() {
  const [entries, setEntries] = useState<NamerLogIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedEntry, setExpandedEntry] = useState<NamerLogEntry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError("");
    api.getNamerLogs()
      .then(setEntries)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-cc-fg">Session Namer Debug</h2>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="px-2 py-1 rounded text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <p className="text-xs text-cc-muted">
        In-memory log of Haiku naming calls. {entries.length > 0 ? `${entries.length} entries.` : "No entries yet."}
      </p>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
          {error}
        </div>
      )}

      {entries.length > 0 && (
        <div className="space-y-1 max-h-[400px] overflow-y-auto">
          {entries.map((entry) => (
            <div key={entry.id} className="rounded-lg border border-cc-border overflow-hidden">
              {/* Summary row */}
              <button
                type="button"
                onClick={() => handleToggle(entry.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <span className="text-cc-muted shrink-0 w-16">{timeAgo(entry.timestamp)}</span>
                <span className={`flex-1 truncate ${actionColor(entry.parsed)}`}>
                  {actionLabel(entry.parsed)}
                </span>
                <span className="text-cc-muted shrink-0">{entry.durationMs}ms</span>
                <span className="text-cc-muted shrink-0 font-mono text-[10px] w-16 truncate" title={entry.sessionId}>
                  {entry.sessionId.slice(0, 8)}
                </span>
              </button>

              {/* Expanded detail */}
              {expandedId === entry.id && (
                <div className="border-t border-cc-border px-3 py-2 space-y-2 bg-cc-bg">
                  {detailLoading ? (
                    <p className="text-xs text-cc-muted">Loading...</p>
                  ) : expandedEntry ? (
                    <>
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-cc-muted font-medium">Prompt</span>
                        <pre className="mt-1 text-[11px] text-cc-fg bg-cc-hover rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                          {expandedEntry.prompt}
                        </pre>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-cc-muted font-medium">Response</span>
                        <pre className="mt-1 text-[11px] text-cc-fg bg-cc-hover rounded p-2 overflow-x-auto whitespace-pre-wrap">
                          {expandedEntry.rawResponse ?? "(null — timeout or error)"}
                        </pre>
                      </div>
                      {entry.currentName && (
                        <div className="text-[11px] text-cc-muted">
                          Current name at time of call: <span className="text-cc-fg">{entry.currentName}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-cc-error">Failed to load details</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
