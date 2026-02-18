import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { DiffViewer } from "./DiffViewer.js";

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

function getSavedDiffBases(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem("cc-diff-base") || "{}");
  } catch {
    return {};
  }
}

function saveDiffBase(cwd: string, branch: string | null) {
  const map = getSavedDiffBases();
  if (branch) {
    map[cwd] = branch;
    // Cap at 20 entries
    const keys = Object.keys(map);
    if (keys.length > 20) delete map[keys[0]];
  } else {
    delete map[cwd];
  }
  localStorage.setItem("cc-diff-base", JSON.stringify(map));
}

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((sdk) => sdk.sessionId === sessionId));
  const selectedFile = useStore((s) => s.diffPanelSelectedFile.get(sessionId) ?? null);
  const setSelectedFile = useStore((s) => s.setDiffPanelSelectedFile);
  const changedFilesSet = useStore((s) => s.changedFiles.get(sessionId));

  const cwd = session?.cwd || sdkSession?.cwd;

  const [diffContent, setDiffContent] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 640 : true,
  );
  // Per-file diff stats (abs path → { additions, deletions })
  const [fileStats, setFileStats] = useState<Map<string, FileStats>>(new Map());
  // Track which set of files we've already fetched stats for
  const fetchedFilesRef = useRef<Set<string>>(new Set());

  // Base branch for diff comparison (null = server default)
  const [baseBranch, setBaseBranch] = useState<string | null>(() => {
    if (!cwd) return null;
    return getSavedDiffBases()[cwd] || null;
  });
  // The server-resolved default branch name (eagerly fetched via getRepoInfo)
  const [resolvedDefault, setResolvedDefault] = useState<string | null>(null);
  // Available branches for the dropdown
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);
  const branchesFetched = useRef(false);

  const changedFiles = useMemo(() => changedFilesSet ?? new Set<string>(), [changedFilesSet]);

  const relativeChangedFiles = useMemo(() => {
    if (!changedFiles.size || !cwd) return [];
    const cwdPrefix = `${cwd}/`;
    return [...changedFiles]
      .filter((fp) => fp === cwd || fp.startsWith(cwdPrefix))
      .map((fp) => ({ abs: fp, rel: fp.startsWith(cwd + "/") ? fp.slice(cwd.length + 1) : fp }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }, [changedFiles, cwd]);

  // Eagerly fetch default branch and branch list (once per cwd)
  useEffect(() => {
    if (!cwd || branchesFetched.current) return;
    branchesFetched.current = true;
    api.getRepoInfo(cwd).then((info) => {
      if (info?.defaultBranch) setResolvedDefault(info.defaultBranch);
    }).catch(() => {});
    api.listBranches(cwd).then((branches) => {
      setAvailableBranches(branches.map((b) => b.name));
    }).catch(() => {});
  }, [cwd]);

  const handleBaseBranchChange = useCallback((value: string | null) => {
    setBaseBranch(value);
    if (cwd) saveDiffBase(cwd, value);
    // Invalidate all cached stats so they re-fetch with new base
    fetchedFilesRef.current.clear();
    setFileStats(new Map());
  }, [cwd]);

  // Fetch diff stats for all changed files (in parallel)
  useEffect(() => {
    if (relativeChangedFiles.length === 0) return;
    // Only fetch stats for files we haven't fetched yet
    const newFiles = relativeChangedFiles.filter((f) => !fetchedFilesRef.current.has(f.abs));
    if (newFiles.length === 0) return;

    let cancelled = false;
    const base = baseBranch || undefined;
    const promises = newFiles.map(({ abs }) =>
      api.getFileDiff(abs, base).then((res) => {
        // Capture the server-resolved default branch from first response
        if (res.baseBranch && !resolvedDefault) {
          setResolvedDefault(res.baseBranch);
        }
        return { abs, stats: countDiffStats(res.diff) };
      }).catch(() => ({ abs, stats: { additions: 0, deletions: 0 } })),
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
    });
    return () => { cancelled = true; };
  }, [relativeChangedFiles, baseBranch, resolvedDefault]);

  // Aggregate totals across all files
  const totalStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const stats of fileStats.values()) {
      additions += stats.additions;
      deletions += stats.deletions;
    }
    return { additions, deletions };
  }, [fileStats]);

  // Auto-select first changed file if none selected
  useEffect(() => {
    if (!selectedFile && relativeChangedFiles.length > 0) {
      setSelectedFile(sessionId, relativeChangedFiles[0].abs);
    }
  }, [selectedFile, relativeChangedFiles, sessionId, setSelectedFile]);

  // If the selected file falls out of scope, clear or reselect.
  useEffect(() => {
    if (!selectedFile) return;
    if (relativeChangedFiles.some((f) => f.abs === selectedFile)) return;
    setSelectedFile(sessionId, relativeChangedFiles[0]?.abs ?? null);
  }, [selectedFile, relativeChangedFiles, sessionId, setSelectedFile]);

  // Fetch diff when selected file or base branch changes
  useEffect(() => {
    if (!selectedFile) {
      setDiffContent("");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    const base = baseBranch || undefined;
    api
      .getFileDiff(selectedFile, base)
      .then((res) => {
        if (!cancelled) {
          setDiffContent(res.diff);
          if (res.baseBranch) setResolvedDefault(res.baseBranch);
          // Update stats from the fetched diff (may already exist but ensures freshness)
          setFileStats((prev) => {
            const next = new Map(prev);
            next.set(selectedFile, countDiffStats(res.diff));
            return next;
          });
          setDiffLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiffContent("");
          setDiffLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [selectedFile, baseBranch]);

  const handleFileSelect = useCallback(
    (path: string) => {
      setSelectedFile(sessionId, path);
      if (typeof window !== "undefined" && window.innerWidth < 640) {
        setSidebarOpen(false);
      }
    },
    [sessionId, setSelectedFile],
  );

  const selectedRelPath = useMemo(() => {
    if (!selectedFile || !cwd) return selectedFile;
    return selectedFile.startsWith(cwd + "/") ? selectedFile.slice(cwd.length + 1) : selectedFile;
  }, [selectedFile, cwd]);

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

  if (relativeChangedFiles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 select-none px-6">
        <div className="w-14 h-14 rounded-2xl bg-cc-card border border-cc-border flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-cc-muted">
            <path d="M12 3v18M3 12h18" strokeLinecap="round" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">No changes yet</p>
          <p className="text-xs text-cc-muted leading-relaxed mb-3">
            File changes from Edit and Write tool calls will appear here.
          </p>
          {branchSelector}
        </div>
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
              <span>Changed ({relativeChangedFiles.length})</span>
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
          {(totalStats.additions > 0 || totalStats.deletions > 0) && (
            <div className="flex items-center gap-2 text-[11px] font-normal pl-4">
              <span className="text-green-500">+{totalStats.additions}</span>
              <span className="text-red-400">-{totalStats.deletions}</span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
          {relativeChangedFiles.map(({ abs, rel }) => (
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
        {/* Top bar */}
        {selectedFile && (
          <div className="shrink-0 flex items-center gap-2 sm:gap-2.5 px-2 sm:px-4 py-2.5 bg-cc-card border-b border-cc-border">
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
              <span className="text-cc-fg text-[13px] font-medium truncate block">
                {selectedRelPath?.split("/").pop()}
              </span>
              <span className="text-cc-muted truncate text-[11px] hidden sm:block font-mono-code">
                {selectedRelPath}
              </span>
            </div>
            {selectedFile && fileStats.has(selectedFile) && (
              <span className="text-[11px] font-mono-code shrink-0 flex items-center gap-1.5">
                <span className="text-green-500">+{fileStats.get(selectedFile)!.additions}</span>
                <span className="text-red-400">-{fileStats.get(selectedFile)!.deletions}</span>
              </span>
            )}
            <span className="shrink-0 hidden sm:block">{branchSelector}</span>
          </div>
        )}

        {/* Diff content */}
        <div className="flex-1 overflow-auto">
          {diffLoading ? (
            <div className="h-full flex items-center justify-center">
              <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : selectedFile ? (
            <div className="p-4">
              <DiffViewer unifiedDiff={diffContent} fileName={selectedRelPath || undefined} mode="full" />
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center">
              {!sidebarOpen && (
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                  </svg>
                  Show file list
                </button>
              )}
              <p className="text-cc-muted text-sm">Select a file to view changes</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
