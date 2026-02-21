import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { invalidateDiffStatsCache } from "../ws.js";
import { DiffViewer } from "./DiffViewer.js";
import { YarnBallSpinner } from "./CatIcons.js";

const LINE_NUMBERS_KEY = "cc-diff-line-numbers";

/** Count additions and deletions from a unified diff string */
function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

interface FileStats {
  additions: number;
  deletions: number;
}

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((sdk) => sdk.sessionId === sessionId));
  const selectedFile = useStore((s) => s.diffPanelSelectedFile.get(sessionId) ?? null);
  const setSelectedFile = useStore((s) => s.setDiffPanelSelectedFile);
  const changedFilesSet = useStore((s) => s.changedFiles.get(sessionId));

  const cwd = session?.cwd || sdkSession?.cwd;
  const repoRoot = (session?.repo_root && cwd?.startsWith(session.repo_root + "/"))
    ? session.repo_root
    : cwd;

  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 640 : true,
  );
  const [fileStats, setFileStats] = useState<Map<string, FileStats>>(new Map());
  const fetchedFilesRef = useRef<Set<string>>(new Set());

  // Multi-file diff state: all fetched diffs keyed by abs path
  const [allDiffs, setAllDiffs] = useState<Map<string, string>>(new Map());
  const [allDiffsLoading, setAllDiffsLoading] = useState(false);

  // Line numbers toggle — persisted in localStorage, default based on screen width
  const [showLineNumbers, setShowLineNumbers] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem(LINE_NUMBERS_KEY);
    if (stored !== null) return stored === "true";
    return window.innerWidth >= 640;
  });
  const toggleLineNumbers = useCallback(() => {
    setShowLineNumbers((prev) => {
      const next = !prev;
      localStorage.setItem(LINE_NUMBERS_KEY, String(next));
      return next;
    });
  }, []);

  // Base branch — server-authoritative
  const serverBaseBranch = session?.diff_base_branch || null;
  const [baseBranch, setBaseBranch] = useState<string | null>(serverBaseBranch);

  useEffect(() => {
    if (serverBaseBranch !== baseBranch) {
      setBaseBranch(serverBaseBranch);
      fetchedFilesRef.current.clear();
      setFileStats(new Map());
      setAllDiffs(new Map());
    }
  }, [serverBaseBranch]); // eslint-disable-line react-hooks/exhaustive-deps

  const serverDefaultBranch = session?.git_default_branch || null;
  const [fallbackDefault, setFallbackDefault] = useState<string | null>(null);
  const resolvedDefault = serverDefaultBranch || fallbackDefault;
  const effectiveBranch = baseBranch || resolvedDefault || null;
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);
  const branchesFetched = useRef(false);

  const changedFiles = useMemo(() => changedFilesSet ?? new Set<string>(), [changedFilesSet]);

  const relativeChangedFiles = useMemo(() => {
    if (!changedFiles.size || !repoRoot) return [];
    const rootPrefix = `${repoRoot}/`;
    return [...changedFiles]
      .filter((fp) => fp === repoRoot || fp.startsWith(rootPrefix))
      .map((fp) => ({ abs: fp, rel: fp.startsWith(repoRoot + "/") ? fp.slice(repoRoot.length + 1) : fp }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }, [changedFiles, repoRoot]);

  const visibleChangedFiles = useMemo(() => {
    if (fileStats.size === 0) return relativeChangedFiles;
    return relativeChangedFiles.filter((f) => {
      const stats = fileStats.get(f.abs);
      return !stats || stats.additions > 0 || stats.deletions > 0;
    });
  }, [relativeChangedFiles, fileStats]);

  // Fetch branch list (once per cwd)
  useEffect(() => {
    if (!cwd || branchesFetched.current) return;
    branchesFetched.current = true;
    if (!serverDefaultBranch) {
      api.getRepoInfo(cwd).then((info) => {
        if (info?.defaultBranch) setFallbackDefault(info.defaultBranch);
      }).catch(() => {});
    }
    api.listBranches(cwd).then((branches) => {
      setAvailableBranches(branches.map((b) => b.name));
    }).catch(() => {});
  }, [cwd, serverDefaultBranch]);

  const handleBaseBranchChange = useCallback((value: string | null) => {
    setBaseBranch(value);
    api.setDiffBase(sessionId, value || "").catch(() => {});
    fetchedFilesRef.current.clear();
    setFileStats(new Map());
    setAllDiffs(new Map());
    invalidateDiffStatsCache(sessionId);
    useStore.getState().setDiffFileStats(sessionId, new Map());
  }, [sessionId]);

  // Fetch diffs for ALL changed files (stats + content in one pass)
  useEffect(() => {
    if (!effectiveBranch || relativeChangedFiles.length === 0) return;
    const newFiles = relativeChangedFiles.filter((f) => !fetchedFilesRef.current.has(f.abs));
    if (newFiles.length === 0) return;

    let cancelled = false;
    setAllDiffsLoading(true);
    const promises = newFiles.map(({ abs }) =>
      api.getFileDiff(abs, effectiveBranch).then((res) => {
        return { abs, diff: res.diff, stats: countDiffStats(res.diff) };
      }).catch(() => ({ abs, diff: "", stats: { additions: 0, deletions: 0 } })),
    );
    Promise.all(promises).then((results) => {
      if (cancelled) return;
      setFileStats((prev) => {
        const next = new Map(prev);
        for (const { abs, stats } of results) {
          next.set(abs, stats);
          fetchedFilesRef.current.add(abs);
        }
        return next;
      });
      setAllDiffs((prev) => {
        const next = new Map(prev);
        for (const { abs, diff } of results) {
          next.set(abs, diff);
        }
        return next;
      });
      setAllDiffsLoading(false);
    });
    return () => { cancelled = true; };
  }, [relativeChangedFiles, effectiveBranch]);

  // Aggregate totals
  const totalStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const stats of fileStats.values()) {
      additions += stats.additions;
      deletions += stats.deletions;
    }
    return { additions, deletions };
  }, [fileStats]);

  // Sync fileStats to store for TopBar badge
  useEffect(() => {
    useStore.getState().setDiffFileStats(sessionId, fileStats);
  }, [fileStats, sessionId]);

  // Auto-select first file
  useEffect(() => {
    if (!selectedFile && visibleChangedFiles.length > 0) {
      setSelectedFile(sessionId, visibleChangedFiles[0].abs);
    }
  }, [selectedFile, visibleChangedFiles, sessionId, setSelectedFile]);

  // Reselect if selected file falls out of scope
  useEffect(() => {
    if (!selectedFile) return;
    if (visibleChangedFiles.some((f) => f.abs === selectedFile)) return;
    setSelectedFile(sessionId, visibleChangedFiles[0]?.abs ?? null);
  }, [selectedFile, visibleChangedFiles, sessionId, setSelectedFile]);

  // Refs for scroll-to-file
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Suppress observer-driven selection while a programmatic scroll is in progress
  const scrollingToFileRef = useRef(false);

  // Scroll to file on sidebar click
  const handleFileSelect = useCallback(
    (path: string) => {
      setSelectedFile(sessionId, path);
      if (typeof window !== "undefined" && window.innerWidth < 640) {
        setSidebarOpen(false);
      }
      // Scroll to the file's section
      const el = fileRefs.current.get(path);
      if (el) {
        scrollingToFileRef.current = true;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        // Release the lock after the smooth scroll settles
        setTimeout(() => { scrollingToFileRef.current = false; }, 600);
      }
    },
    [sessionId, setSelectedFile],
  );

  // IntersectionObserver: update selected file as user scrolls
  useEffect(() => {
    if (visibleChangedFiles.length === 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (scrollingToFileRef.current) return;
        // Find the topmost visible file section
        let topEntry: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
              topEntry = entry;
            }
          }
        }
        if (topEntry) {
          const abs = (topEntry.target as HTMLElement).dataset.filePath;
          if (abs) setSelectedFile(sessionId, abs);
        }
      },
      { root: container, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );

    for (const [, el] of fileRefs.current) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [visibleChangedFiles, sessionId, setSelectedFile]);

  const branchSelector = (
    <select
      value={baseBranch || ""}
      onChange={(e) => handleBaseBranchChange(e.target.value || null)}
      className="text-cc-muted text-[11px] bg-transparent border border-cc-border rounded px-1.5 py-0.5 cursor-pointer hover:text-cc-fg hover:border-cc-fg/30 transition-colors max-w-[180px]"
      title="Base branch for diff comparison"
    >
      <option value="">
        {resolvedDefault ? `vs ${resolvedDefault} (default)` : "vs default branch"}
      </option>
      {availableBranches.map((b) => (
        <option key={b} value={b}>vs {b}</option>
      ))}
    </select>
  );

  if (!cwd) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <p className="text-cc-muted text-sm">Waiting for session to initialize...</p>
      </div>
    );
  }

  return (
    <div className="h-full flex bg-cc-bg relative">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-20 sm:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Changed files sidebar */}
      <div
        className={`
          ${sidebarOpen ? "w-[220px] translate-x-0" : "w-0 -translate-x-full"}
          fixed sm:relative z-30 sm:z-auto
          ${sidebarOpen ? "sm:w-[220px]" : "sm:w-0 sm:-translate-x-full"}
          shrink-0 h-full flex flex-col bg-cc-sidebar border-r border-cc-border transition-all duration-200 overflow-hidden
        `}
      >
        <div className="w-[220px] px-4 py-3 text-[11px] font-semibold text-cc-fg border-b border-cc-border shrink-0 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 uppercase tracking-wider">
              <span className="w-2 h-2 rounded-full bg-cc-warning" />
              <span>Changed ({visibleChangedFiles.length})</span>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="w-5 h-5 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer sm:hidden"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-2 text-[11px] font-normal pl-4">
            {(totalStats.additions > 0 || totalStats.deletions > 0) && (
              <>
                <span className="text-green-500">+{totalStats.additions}</span>
                <span className="text-red-400">-{totalStats.deletions}</span>
              </>
            )}
          </div>
          <div className="pl-4">{branchSelector}</div>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
          {visibleChangedFiles.map(({ abs, rel }) => (
            <button
              key={abs}
              onClick={() => handleFileSelect(abs)}
              className={`flex items-center gap-2 w-full mx-1 px-2 py-1.5 text-[13px] rounded-[10px] hover:bg-cc-hover transition-colors cursor-pointer whitespace-nowrap ${
                abs === selectedFile ? "bg-cc-active text-cc-fg" : "text-cc-fg/70"
              }`}
              style={{ width: "calc(100% - 8px)" }}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning shrink-0">
                <path
                  fillRule="evenodd"
                  d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="truncate leading-snug flex-1">{rel}</span>
              {fileStats.has(abs) && (
                <span className="text-[10px] font-mono-code shrink-0 flex items-center gap-1 ml-auto">
                  <span className="text-green-500">+{fileStats.get(abs)!.additions}</span>
                  <span className="text-red-400">-{fileStats.get(abs)!.deletions}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Diff area */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* Top bar — always visible with controls */}
        <div className="shrink-0 flex items-center gap-2 sm:gap-2.5 px-2 sm:px-4 py-2 bg-cc-card border-b border-cc-border">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="flex items-center justify-center w-6 h-6 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
              title="Show file list"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
            </button>
          )}
          <div className="flex-1 min-w-0">
            {!sidebarOpen && branchSelector}
          </div>
          {(totalStats.additions > 0 || totalStats.deletions > 0) && (
            <span className="text-[11px] font-mono-code shrink-0 flex items-center gap-1.5">
              <span className="text-green-500">+{totalStats.additions}</span>
              <span className="text-red-400">-{totalStats.deletions}</span>
            </span>
          )}
          <button
            onClick={toggleLineNumbers}
            className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors cursor-pointer shrink-0 ${
              showLineNumbers ? "text-cc-fg bg-cc-hover" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
            title={showLineNumbers ? "Hide line numbers" : "Show line numbers"}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M3 3v10M7 3h6M7 8h6M7 13h4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Diff content — multi-file scrollable feed */}
        <div className="flex-1 overflow-auto" ref={scrollContainerRef}>
          {allDiffsLoading && visibleChangedFiles.length > 0 && allDiffs.size === 0 ? (
            <div className="h-full flex items-center justify-center">
              <YarnBallSpinner className="w-5 h-5 text-cc-primary" />
            </div>
          ) : visibleChangedFiles.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-1 select-none px-6">
              <p className="text-sm text-cc-muted">No changes yet</p>
              <p className="text-xs text-cc-muted/60">File changes from Edit and Write tool calls will appear here.</p>
            </div>
          ) : (
            <div className="p-4 flex flex-col gap-4">
              {visibleChangedFiles.map(({ abs, rel }) => {
                const diff = allDiffs.get(abs);
                return (
                  <div
                    key={abs}
                    data-file-path={abs}
                    ref={(el) => {
                      if (el) fileRefs.current.set(abs, el);
                      else fileRefs.current.delete(abs);
                    }}
                  >
                    <DiffViewer
                      unifiedDiff={diff ?? ""}
                      fileName={rel}
                      mode="full"
                      showLineNumbers={showLineNumbers}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
