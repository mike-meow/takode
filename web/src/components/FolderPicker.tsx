import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { api, type DirEntry } from "../api.js";
import { getRecentDirs, addRecentDir } from "../utils/recent-dirs.js";

interface FolderPickerProps {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderPicker({ initialPath, onSelect, onClose }: FolderPickerProps) {
  const [browsePath, setBrowsePath] = useState("");
  const [browseDirs, setBrowseDirs] = useState<DirEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [dirInput, setDirInput] = useState("");
  const [showDirInput, setShowDirInput] = useState(false);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [recentDirs] = useState<string[]>(() => getRecentDirs());
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const loadDirs = useCallback(async (path?: string) => {
    setBrowseLoading(true);
    setFilter("");
    setFocusIndex(-1);
    try {
      const result = await api.listDirs(path, { hidden: showHidden });
      setBrowsePath(result.path);
      setBrowseDirs(result.dirs);
    } catch {
      setBrowseDirs([]);
    } finally {
      setBrowseLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    loadDirs(initialPath || undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload when hidden toggle changes
  useEffect(() => {
    if (browsePath) loadDirs(browsePath);
  }, [showHidden]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectDir(path: string) {
    addRecentDir(path);
    onSelect(path);
    onClose();
  }

  // Filtered dirs for display
  const filteredDirs = filter
    ? browseDirs.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()))
    : browseDirs;

  // Build breadcrumb segments from browsePath
  const breadcrumbs = buildBreadcrumbs(browsePath);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Escape closes picker (unless typing a path)
      if (e.key === "Escape" && !showDirInput) {
        onClose();
        return;
      }

      // Cmd/Ctrl+Enter selects current directory
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        selectDir(browsePath);
        return;
      }

      // Don't intercept keys when in manual path input mode
      if (showDirInput) return;

      // Arrow navigation through directory list
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((prev) => Math.min(prev + 1, filteredDirs.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((prev) => Math.max(prev - 1, -1));
        return;
      }

      // Enter navigates into focused directory
      if (e.key === "Enter" && focusIndex >= 0) {
        const dirs = filter
          ? browseDirs.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()))
          : browseDirs;
        if (focusIndex < dirs.length) {
          e.preventDefault();
          loadDirs(dirs[focusIndex].path);
        }
        return;
      }

      // Backspace goes to parent when filter is empty and filter input isn't focused
      if (e.key === "Backspace" && !filter && browsePath !== "/") {
        if (document.activeElement !== filterRef.current) {
          e.preventDefault();
          const parent = browsePath.split("/").slice(0, -1).join("/") || "/";
          loadDirs(parent);
        }
        return;
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, showDirInput, browsePath, filter, focusIndex, browseDirs, loadDirs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll focused item into view
  useEffect(() => {
    if (focusIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-dir-item]");
      items[focusIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg h-[min(480px,90dvh)] mx-0 sm:mx-4 flex flex-col bg-cc-bg border border-cc-border rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-cc-border shrink-0">
          <h2 className="text-sm font-semibold text-cc-fg">Select Folder</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Recent directories */}
        {recentDirs.length > 0 && (
          <div className="border-b border-cc-border shrink-0">
            <div className="px-4 pt-2.5 pb-1 text-[10px] text-cc-muted uppercase tracking-wider">Recent</div>
            {recentDirs.map((dir) => (
              <button
                key={dir}
                onClick={() => selectDir(dir)}
                className="w-full px-4 py-2 sm:py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-fg"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-30 shrink-0">
                  <path d="M8 3.5a.5.5 0 00-1 0V8a.5.5 0 00.252.434l3.5 2a.5.5 0 00.496-.868L8 7.71V3.5z" />
                  <path fillRule="evenodd" d="M8 16A8 8 0 108 0a8 8 0 000 16zm7-8A7 7 0 111 8a7 7 0 0114 0z" />
                </svg>
                <span className="font-medium truncate">{dir.split("/").pop() || dir}</span>
                <span className="text-cc-muted font-mono-code text-[10px] truncate ml-auto">{dir}</span>
              </button>
            ))}
          </div>
        )}

        {/* Breadcrumb path bar */}
        <div className="px-4 py-2.5 border-b border-cc-border flex items-center gap-1 shrink-0 min-w-0">
          {showDirInput ? (
            <input
              type="text"
              value={dirInput}
              onChange={(e) => setDirInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirInput.trim()) {
                  loadDirs(dirInput.trim());
                  setShowDirInput(false);
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setShowDirInput(false);
                }
              }}
              placeholder="/path/to/project"
              className="flex-1 px-2 py-1 text-base sm:text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
              autoFocus
            />
          ) : (
            <>
              {/* Clickable breadcrumbs */}
              <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto no-scrollbar">
                {breadcrumbs.map((crumb, i) => (
                  <span key={crumb.path} className="flex items-center gap-0.5 shrink-0">
                    {i > 0 && (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 text-cc-muted/50 shrink-0">
                        <path d="M6 4l4 4-4 4" />
                      </svg>
                    )}
                    <button
                      onClick={() => loadDirs(crumb.path)}
                      className="text-[11px] font-mono-code text-cc-muted hover:text-cc-fg hover:bg-cc-hover px-1 py-0.5 rounded transition-colors cursor-pointer shrink-0"
                      title={crumb.path}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </div>

              {/* Show hidden toggle */}
              <button
                onClick={() => setShowHidden(!showHidden)}
                className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors cursor-pointer shrink-0 ${
                  showHidden ? "text-cc-primary bg-cc-primary/10" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
                title={showHidden ? "Hide hidden directories" : "Show hidden directories"}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  {showHidden ? (
                    <path d="M8 3C4.511 3 1.486 5.032.163 7.906a.5.5 0 000 .188C1.486 10.968 4.511 13 8 13s6.514-2.032 7.837-4.906a.5.5 0 000-.188C14.514 5.032 11.489 3 8 3zm0 8.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7zM8 6a2 2 0 100 4 2 2 0 000-4z" />
                  ) : (
                    <path d="M1.48 1.48a.75.75 0 011.06 0l11.38 11.38a.75.75 0 01-1.06 1.06l-1.8-1.8A8.76 8.76 0 018 13c-3.489 0-6.514-2.032-7.837-4.906a.5.5 0 010-.188 9.33 9.33 0 012.97-3.54L1.48 2.54a.75.75 0 010-1.06zm3.18 4.24A3.5 3.5 0 008 11.5c.588 0 1.142-.145 1.63-.4l-1.17-1.17a2 2 0 01-2.39-2.39L4.66 5.72zm8.47.33c.468.6.864 1.25 1.178 1.944a9.32 9.32 0 01-2.97 3.54l-1.68-1.68A3.5 3.5 0 008 4.5c-.205 0-.407.018-.604.051L5.88 3.034A8.76 8.76 0 018 3c3.489 0 6.514 2.032 7.837 4.906a.5.5 0 010 .188 9.33 9.33 0 01-1.174 1.95l-1.533-1.533z" />
                  )}
                </svg>
              </button>

              {/* Edit path button */}
              <button
                onClick={() => {
                  setShowDirInput(true);
                  setDirInput(browsePath);
                }}
                className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
                title="Type path manually"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354l-1.098-1.097z" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* Filter input */}
        {!showDirInput && (
          <div className="px-4 py-2 border-b border-cc-border shrink-0">
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setFocusIndex(-1);
              }}
              placeholder="Filter directories..."
              className="w-full px-2 py-1 text-base sm:text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
            />
          </div>
        )}

        {/* Directory browser */}
        {!showDirInput && (
          <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto">
            {browseLoading ? (
              <div className="px-4 py-6 text-xs text-cc-muted text-center">Loading...</div>
            ) : filteredDirs.length === 0 ? (
              <div className="px-4 py-6 text-xs text-cc-muted text-center">
                {filter ? "No matching directories" : "No subdirectories"}
              </div>
            ) : (
              filteredDirs.map((d, i) => (
                <button
                  key={d.path}
                  data-dir-item
                  onClick={() => loadDirs(d.path)}
                  className={`w-full px-4 py-2 sm:py-1.5 text-xs text-left cursor-pointer font-mono-code flex items-center gap-2 text-cc-fg transition-colors ${
                    i === focusIndex ? "bg-cc-hover" : "hover:bg-cc-hover"
                  }`}
                  title={d.path}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-40 shrink-0">
                    <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                  </svg>
                  <span className="truncate">{d.name}</span>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-30 shrink-0 ml-auto">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                </button>
              ))
            )}
          </div>
        )}

        {/* Footer with Open button */}
        <div className="border-t border-cc-border px-4 py-3 flex items-center gap-3 shrink-0 bg-cc-bg">
          <span className="text-[11px] text-cc-muted font-mono-code truncate flex-1 min-w-0" title={browsePath}>
            {browsePath}
          </span>
          <button
            onClick={() => selectDir(browsePath)}
            className="px-4 py-1.5 text-xs font-medium rounded-md bg-cc-primary text-white hover:bg-cc-primary/90 transition-colors cursor-pointer shrink-0"
          >
            Open
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Build breadcrumb segments from an absolute path */
function buildBreadcrumbs(path: string): { label: string; path: string }[] {
  if (!path) return [];
  const parts = path.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  for (let i = 0; i < parts.length; i++) {
    crumbs.push({ label: parts[i], path: "/" + parts.slice(0, i + 1).join("/") });
  }
  return crumbs;
}
