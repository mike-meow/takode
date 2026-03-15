import { useEffect, useRef, useCallback } from "react";
import { useStore } from "../store.js";
import { GitHubPRSection, McpCollapsible, ClaudeMdCollapsible, HerdDiagnosticsSection } from "./TaskPanel.js";
import { shortenHome } from "../utils/path-display.js";
import { formatModel } from "../utils/backends.js";
import { coalesceSessionViewModel } from "../utils/session-view-model.js";
import { navigateTo } from "../utils/navigation.js";
import { formatContextWindowLabel } from "../utils/token-format.js";

export function SessionInfoPopover({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const sessionVm = coalesceSessionViewModel(session, sdkSession);
  const cwd = sessionVm?.cwd ?? null;
  const model = sessionVm?.model ?? "";
  const backendType = sessionVm?.backendType ?? "claude";
  const popoverRef = useRef<HTMLDivElement>(null);
  const taskHistoryScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll cwd to the right end so the last path segment is visible
  const cwdScrollRef = useCallback((el: HTMLDivElement | null) => {
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  // Stats
  const turns = sessionVm?.numTurns ?? 0;
  const contextPercent = sessionVm?.contextUsedPercent ?? 0;
  const contextWindow = sessionVm?.modelContextWindow ?? 0;

  // Git
  const gitBranch = sessionVm?.gitBranch ?? null;
  const isWorktree = sessionVm?.isWorktree ?? false;
  const gitAhead = sessionVm?.gitAhead ?? 0;
  const gitBehind = sessionVm?.gitBehind ?? 0;
  const linesAdded = sessionVm?.totalLinesAdded ?? 0;
  const linesRemoved = sessionVm?.totalLinesRemoved ?? 0;

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const targetEl = e.target instanceof Element ? e.target : null;
      if (targetEl?.closest("[data-claude-md-editor-root='true']")) {
        return;
      }
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Keep task history anchored to newest entry so long histories open at the latest item.
  useEffect(() => {
    const container = taskHistoryScrollRef.current;
    if (!container || !taskHistory || taskHistory.length === 0) return;
    container.scrollTop = container.scrollHeight;
  }, [sessionId, taskHistory]);

  const backendLabel = backendType === "codex" ? "Codex" : "Claude";
  const hasGit = gitBranch || gitAhead > 0 || gitBehind > 0 || linesAdded > 0 || linesRemoved > 0;
  const hasStats = turns > 0 || contextPercent > 0 || contextWindow > 0;
  const taskEntries = (taskHistory ?? []).map((task) => ({
    ...task,
    title: task.title.trim(),
  }));

  return (
    <div
      ref={popoverRef}
      className="fixed right-2 z-50 w-[300px] max-h-[80dvh] flex flex-col bg-cc-card border border-cc-border rounded-xl shadow-xl overflow-hidden"
      style={{ top: "calc(2.75rem + 8px)" }}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-cc-border">
        <span className="text-[12px] font-semibold text-cc-fg">Session Info</span>
        <button
          onClick={onClose}
          className="flex items-center justify-center w-5 h-5 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Backend + model + cwd */}
        <div className="px-4 py-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className={`text-[11px] font-medium ${backendType === "codex" ? "text-blue-500" : "text-[#D97757]"}`}>
              {backendLabel}
            </span>
            {model && (
              <>
                <span className="text-cc-muted/40 text-[10px]">&middot;</span>
                <span className="text-[11px] text-cc-muted">{formatModel(model)}</span>
              </>
            )}
          </div>
          {cwd && (
            <div className="flex items-center gap-1.5">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/50">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              <div ref={cwdScrollRef} className="overflow-x-auto scrollbar-hide" title={cwd}>
                <span className="text-[11px] text-cc-muted font-mono-code whitespace-nowrap">{shortenHome(cwd)}</span>
              </div>
            </div>
          )}
          {/* Git summary */}
          {hasGit && (
            <div>
              {gitBranch && (
                <div className="flex items-center gap-1.5 text-[11px] text-cc-muted leading-tight">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-50">
                    {isWorktree ? (
                      <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                    ) : (
                      <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                    )}
                  </svg>
                  <span className="truncate">{gitBranch}</span>
                  {isWorktree && (
                    <span className="text-[9px] bg-cc-primary/10 text-cc-primary px-1 rounded shrink-0">wt</span>
                  )}
                </div>
              )}
              {(gitAhead > 0 || gitBehind > 0 || linesAdded > 0 || linesRemoved > 0) && (
                <div className="flex items-center gap-2 mt-1 text-[11px] text-cc-muted">
                  {(gitAhead > 0 || gitBehind > 0) && (
                    <span className="flex items-center gap-1">
                      {gitAhead > 0 && <span className="text-green-500">{gitAhead}&#8593;</span>}
                      {gitBehind > 0 && <span className="text-cc-warning">{gitBehind}&#8595;</span>}
                    </span>
                  )}
                  {(linesAdded > 0 || linesRemoved > 0) && (
                    <span className="flex items-center gap-1">
                      <span className="text-green-500">+{linesAdded}</span>
                      <span className="text-red-400">-{linesRemoved}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Task history */}
        {taskEntries.length > 0 && (
          <div className="px-4 py-2 border-t border-cc-border/50 space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Tasks</span>
            <div
              ref={taskHistoryScrollRef}
              data-testid="task-history-scroll"
              className="max-h-40 overflow-y-auto pr-2 pb-1 space-y-1.5"
              style={{ scrollbarGutter: "stable both-edges" }}
            >
              {taskEntries.map((task, i) => {
                const questId = task.questId;
                return (
                  <div key={i} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-1.5">
                    <span className="text-[10px] tabular-nums text-right text-cc-muted/60 mt-px">{i + 1}.</span>
                    {task.source === "quest" && questId ? (
                      <QuestTaskChip questId={questId} title={task.title} onNavigate={onClose} />
                    ) : (
                      <span
                        className={`text-left text-[11px] leading-snug line-clamp-1 ${task.source === "quest" ? "text-amber-400" : "text-cc-fg"}`}
                      >
                        {task.title}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Stats */}
        {hasStats && (
          <div className="px-4 py-2 border-t border-cc-border/50">
            <div className="flex items-center gap-2 text-[11px] text-cc-muted">
              {turns > 0 && (
                <span>
                  {turns} {turns === 1 ? "turn" : "turns"}
                </span>
              )}
              {contextPercent > 0 && (
                <>
                  {turns > 0 && <span className="text-cc-muted/40">&middot;</span>}
                  <span>{Math.round(contextPercent)}% context</span>
                </>
              )}
              {contextWindow > 0 && (
                <>
                  {(turns > 0 || contextPercent > 0) && <span className="text-cc-muted/40">&middot;</span>}
                  <span>{formatContextWindowLabel(contextWindow)}</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Herd diagnostics — only for leader sessions */}
        {sdkSession?.isOrchestrator && (
          <div className="border-t border-cc-border/50">
            <HerdDiagnosticsSection sessionId={sessionId} />
          </div>
        )}

        {/* GitHub PR, MCP, CLAUDE.md */}
        <GitHubPRSection sessionId={sessionId} />
        <McpCollapsible sessionId={sessionId} />
        {cwd && <ClaudeMdCollapsible cwd={cwd} repoRoot={sessionVm?.repoRoot} />}
      </div>
    </div>
  );
}

/** Quest chip in task history; hover popups are intentionally disabled here to keep scrolling smooth. */
function QuestTaskChip({ questId, title, onNavigate }: { questId: string; title: string; onNavigate: () => void }) {
  return (
    <button
      type="button"
      className="text-left text-[11px] leading-snug line-clamp-1 text-amber-400 hover:text-amber-300 hover:underline decoration-dotted underline-offset-2 cursor-pointer"
      onClick={() => {
        navigateTo(`/questmaster?quest=${encodeURIComponent(questId)}`);
        onNavigate();
      }}
    >
      {title}
    </button>
  );
}
