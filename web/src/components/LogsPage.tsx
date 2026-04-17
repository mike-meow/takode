import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import { api, buildLogStreamUrl } from "../api.js";
import { LOG_LEVELS, type LogLevel, type ServerLogEntry } from "../../shared/logging.js";

const MAX_VISIBLE_ENTRIES = 500;

function isNearBottom(element: HTMLElement, threshold = 48): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function levelBadgeClass(level: LogLevel): string {
  switch (level) {
    case "debug":
      return "text-cc-muted";
    case "warn":
      return "text-cc-warning";
    case "error":
      return "text-cc-error";
    default:
      return "text-cc-fg";
  }
}

function toggleSelection<T extends string>(allItems: T[], current: T[] | null, item: T): T[] | null {
  if (allItems.length <= 1) return null;
  if (current === null) {
    const next = allItems.filter((value) => value !== item);
    return next.length === allItems.length ? null : next;
  }

  if (current.includes(item)) {
    if (current.length === 1) return current;
    return current.filter((value) => value !== item);
  }

  const next = [...current, item].sort((a, b) => a.localeCompare(b));
  return next.length === allItems.length ? null : next;
}

function formatSessionLabel(sessionId: string, sessionLabels: Map<string, string>): string {
  return sessionLabels.get(sessionId) || sessionId;
}

function formatComponentLabel(component: string, sessionLabels: Map<string, string>): string {
  const match = component.match(/^session:([^:]+):(stdout|stderr)$/);
  if (!match) return component;
  return `session:${formatSessionLabel(match[1], sessionLabels)}:${match[2]}`;
}

function renderMetaWithSessions(entry: ServerLogEntry, sessionLabels: Map<string, string>): string {
  const details: string[] = [];
  if (entry.sessionId) details.push(`session=${formatSessionLabel(entry.sessionId, sessionLabels)}`);
  if (entry.source) details.push(`source=${entry.source}`);
  if (entry.meta && Object.keys(entry.meta).length > 0) details.push(JSON.stringify(entry.meta));
  return details.join(" ");
}

export function LogsPage() {
  const isDesktopViewport = typeof window === "undefined" ? true : window.innerWidth >= 1024;
  const [entries, setEntries] = useState<ServerLogEntry[]>([]);
  const [availableComponents, setAvailableComponents] = useState<string[]>([]);
  const [selectedLevels, setSelectedLevels] = useState<LogLevel[] | null>(null);
  const [selectedComponents, setSelectedComponents] = useState<string[] | null>(null);
  const [pattern, setPattern] = useState("");
  const deferredPattern = useDeferredValue(pattern);
  const [regexMode, setRegexMode] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [streamState, setStreamState] = useState<"connecting" | "live" | "offline">("connecting");
  const [logFile, setLogFile] = useState<string | null>(null);
  const [followPaused, setFollowPaused] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 1024,
  );
  const [sessionLabels, setSessionLabels] = useState<Map<string, string>>(new Map());
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .listSessions()
      .then((sessions) => {
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const session of sessions) {
          if (typeof session.sessionNum === "number") {
            next.set(session.sessionId, `#${session.sessionNum}`);
          }
        }
        setSessionLabels(next);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedComponents === null) return;
    const next = selectedComponents.filter((component) => availableComponents.includes(component));
    if (next.length === 0 || next.length === availableComponents.length) {
      setSelectedComponents(null);
      return;
    }
    if (next.length !== selectedComponents.length) {
      setSelectedComponents(next);
    }
  }, [availableComponents, selectedComponents]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setEntries([]);

    void api
      .getLogs({
        levels: selectedLevels ?? undefined,
        components: selectedComponents ?? undefined,
        pattern: deferredPattern.trim() || undefined,
        regex: regexMode,
        limit: MAX_VISIBLE_ENTRIES,
      })
      .then((result) => {
        if (cancelled) return;
        startTransition(() => {
          setAvailableComponents(result.availableComponents);
          setLogFile(result.logFile);
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [deferredPattern, regexMode, selectedLevels, selectedComponents]);

  useEffect(() => {
    setStreamState("connecting");
    const eventSource = new EventSource(
      buildLogStreamUrl({
        levels: selectedLevels ?? undefined,
        components: selectedComponents ?? undefined,
        pattern: deferredPattern.trim() || undefined,
        regex: regexMode,
        tail: MAX_VISIBLE_ENTRIES,
      }),
    );

    eventSource.addEventListener("ready", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          availableComponents?: string[];
          logFile?: string | null;
        };
        startTransition(() => {
          if (Array.isArray(payload.availableComponents)) setAvailableComponents(payload.availableComponents);
          if (typeof payload.logFile === "string" || payload.logFile === null) setLogFile(payload.logFile ?? null);
        });
      } catch {
        // Metadata is best-effort only.
      }
      setStreamState("live");
    });
    eventSource.addEventListener("entry", (event) => {
      try {
        const entry = JSON.parse((event as MessageEvent<string>).data) as ServerLogEntry;
        startTransition(() => {
          setEntries((current) => [...current, entry].slice(-MAX_VISIBLE_ENTRIES));
          setAvailableComponents((current) =>
            current.includes(entry.component)
              ? current
              : [...current, entry.component].sort((a, b) => a.localeCompare(b)),
          );
        });
      } catch {
        // Ignore malformed streamed entries.
      }
    });
    eventSource.onerror = () => {
      setStreamState("offline");
    };

    return () => {
      eventSource.close();
    };
  }, [deferredPattern, regexMode, selectedLevels, selectedComponents]);

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed || followPaused) return;
    feed.scrollTop = feed.scrollHeight;
  }, [entries, followPaused]);

  return (
    <div className="h-[100dvh] bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-hidden">
      <div className="max-w-6xl mx-auto h-full px-4 sm:px-8 py-6 sm:py-8 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Logs</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Structured server/runtime logs with live tailing for operators and agents.
            </p>
            {logFile && <p className="mt-2 text-xs text-cc-muted font-mono break-all">{logFile}</p>}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-1 rounded-full text-xs border ${
                streamState === "live"
                  ? "border-cc-success/30 text-cc-success bg-cc-success/10"
                  : streamState === "connecting"
                    ? "border-cc-warning/30 text-cc-warning bg-cc-warning/10"
                    : "border-cc-error/30 text-cc-error bg-cc-error/10"
              }`}
            >
              {streamState === "live" ? "Live" : streamState === "connecting" ? "Connecting" : "Offline"}
            </span>
            <button
              type="button"
              onClick={() => {
                window.location.hash = "#/settings";
              }}
              className="px-3 py-1.5 rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Back
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 lg:hidden">
          <button
            type="button"
            onClick={() => setFiltersOpen((current) => !current)}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          >
            {filtersOpen ? "Hide Filters" : "Show Filters"}
          </button>
          <span className="text-xs text-cc-muted">{filtersOpen ? "Filters expanded" : "Logs prioritized"}</span>
        </div>

        <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)] min-h-0 flex-1">
          {(filtersOpen || isDesktopViewport) && (
            <div className="min-h-0 rounded-2xl border border-cc-border bg-cc-card p-4 space-y-4 overflow-y-auto">
              <div>
                <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="log-pattern">
                  Message Filter
                </label>
                <input
                  id="log-pattern"
                  type="text"
                  value={pattern}
                  onChange={(event) => setPattern(event.target.value)}
                  placeholder={regexMode ? "Regex pattern" : "Substring"}
                  className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
                />
                <label className="mt-2 flex items-center gap-2 text-xs text-cc-muted">
                  <input
                    type="checkbox"
                    checked={regexMode}
                    onChange={(event) => setRegexMode(event.target.checked)}
                    className="rounded border-cc-border"
                  />
                  Treat pattern as regex
                </label>
              </div>

              <div>
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <h2 className="text-xs font-medium text-cc-muted">Severity</h2>
                  <button
                    type="button"
                    onClick={() => setSelectedLevels(null)}
                    className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
                  >
                    All
                  </button>
                </div>
                <div className="space-y-1">
                  {LOG_LEVELS.map((level) => {
                    const checked = selectedLevels === null || selectedLevels.includes(level);
                    return (
                      <label key={level} className="flex items-center gap-2 text-sm text-cc-fg">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedLevels((current) => toggleSelection([...LOG_LEVELS], current, level))
                          }
                          className="rounded border-cc-border"
                        />
                        <span className={levelBadgeClass(level)}>{level.toUpperCase()}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <h2 className="text-xs font-medium text-cc-muted">Components</h2>
                  <button
                    type="button"
                    onClick={() => setSelectedComponents(null)}
                    className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
                  >
                    All
                  </button>
                </div>
                <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                  {availableComponents.length === 0 && <p className="text-xs text-cc-muted">No components yet.</p>}
                  {availableComponents.map((component) => {
                    const checked = selectedComponents === null || selectedComponents.includes(component);
                    return (
                      <label key={component} className="flex items-center gap-2 text-sm text-cc-fg">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedComponents((current) => toggleSelection(availableComponents, current, component))
                          }
                          className="rounded border-cc-border"
                        />
                        <span className="font-mono text-xs">{formatComponentLabel(component, sessionLabels)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div className="min-h-0 rounded-2xl border border-cc-border bg-cc-card overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-cc-border flex items-center justify-between gap-3 text-xs text-cc-muted">
              <span>
                {loading ? "Loading logs..." : `${entries.length} visible entr${entries.length === 1 ? "y" : "ies"}`}
              </span>
              <div className="flex items-center gap-3">
                <span>{followPaused ? "Auto-scroll paused" : "Following live tail"}</span>
                {followPaused && (
                  <button
                    type="button"
                    onClick={() => {
                      setFollowPaused(false);
                      if (feedRef.current) {
                        feedRef.current.scrollTop = feedRef.current.scrollHeight;
                      }
                    }}
                    className="px-2 py-1 rounded-md bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
                  >
                    Jump to live
                  </button>
                )}
              </div>
            </div>

            {error && (
              <div className="mx-4 mt-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
                {error}
              </div>
            )}

            <div
              data-testid="logs-feed"
              ref={feedRef}
              onScroll={(event) => {
                setFollowPaused(!isNearBottom(event.currentTarget));
              }}
              className="flex-1 overflow-y-auto px-4 py-4 space-y-2 font-mono text-xs leading-5"
            >
              {entries.length === 0 && !loading && <p className="text-cc-muted">No logs match the current filters.</p>}

              {entries.map((entry) => {
                const details = renderMetaWithSessions(entry, sessionLabels);
                return (
                  <div
                    key={`${entry.ts}-${entry.seq}`}
                    className="rounded-xl border border-cc-border/70 bg-cc-bg/70 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-cc-muted">{new Date(entry.ts).toLocaleTimeString()}</span>
                      <span className={`font-semibold ${levelBadgeClass(entry.level)}`}>
                        {entry.level.toUpperCase()}
                      </span>
                      <span className="text-cc-primary">{formatComponentLabel(entry.component, sessionLabels)}</span>
                      <span className="text-cc-fg break-all">{entry.message}</span>
                    </div>
                    {details && <div className="mt-1 text-[11px] text-cc-muted break-all">{details}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
