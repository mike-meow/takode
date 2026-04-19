import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import type { SessionState, SessionTaskEntry } from "../../server/session-types.js";
import { useRef, useLayoutEffect, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { SessionNumChip } from "./SessionNumChip.js";
import { SessionPathSummary } from "./SessionPathSummary.js";
import { SessionPayloadStats } from "./SessionPayloadStats.js";
import { QuestInlineLink } from "./QuestInlineLink.js";

interface SessionHoverCardProps {
  session: SessionItemType;
  sessionName: string | undefined;
  sessionPreview: string | undefined;
  taskHistory: SessionTaskEntry[] | undefined;
  sessionState: SessionState | undefined;
  /** The CLI's internal session ID, used for `claude --resume` */
  cliSessionId?: string;
  anchorRect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/** Format model name for display (e.g. "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5") */
function formatModel(model: string): string {
  // Strip date suffixes like -20250929
  return model.replace(/-\d{8}$/, "");
}

export function SessionHoverCard({
  session: s,
  sessionName,
  sessionPreview,
  taskHistory,
  sessionState,
  cliSessionId,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
}: SessionHoverCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const taskHistoryScrollRef = useRef<HTMLDivElement>(null);
  const zoomLevel = useStore((st) => st.zoomLevel ?? 1);
  const quests = useStore((st) => st.quests);

  // For leader sessions: find which sessions this leader is herding
  const sdkSessions = useStore((st) => st.sdkSessions);
  const sdkSessionMeta = useMemo(() => sdkSessions.find((sdk) => sdk.sessionId === s.id), [sdkSessions, s.id]);
  const effectiveBackendType = sessionState?.backend_type ?? sdkSessionMeta?.backendType ?? s.backendType;
  const herdedSessions = useMemo(() => {
    if (!s.isOrchestrator) return [];
    return sdkSessions.filter((sdk) => sdk.herdedBy === s.id && !sdk.archived).map((sdk) => sdk.sessionId);
  }, [s.isOrchestrator, s.id, sdkSessions]);
  const leaderSession = useMemo(() => {
    if (s.isOrchestrator || !s.herdedBy) return null;
    const leader = sdkSessions.find((sdk) => sdk.sessionId === s.herdedBy && !sdk.archived);
    return leader?.sessionId ?? s.herdedBy;
  }, [s.isOrchestrator, s.herdedBy, sdkSessions]);

  // Status info
  const isRunning = s.status === "running";
  const isCompacting = s.status === "compacting";
  const isExited = s.sdkState === "exited";
  const statusLabel = s.archived
    ? "archived"
    : isRunning
      ? "running"
      : isCompacting
        ? "compacting"
        : isExited
          ? "exited"
          : "idle";
  const statusDotClass = s.archived
    ? "bg-cc-muted/40"
    : s.permCount > 0
      ? "bg-cc-warning"
      : isExited
        ? "bg-cc-muted/40"
        : isRunning
          ? "bg-cc-success"
          : isCompacting
            ? "bg-cc-warning"
            : "bg-cc-success/60";

  const shortId = s.id.slice(0, 8);
  const label = sessionName || s.model || shortId;
  const model = sessionState?.model || s.model || "";
  const backendType = effectiveBackendType ?? "claude";
  const backendLabel = backendType === "codex" ? "Codex" : backendType === "claude-sdk" ? "Claude SDK" : "Claude";
  const backendToneClass = backendType === "codex" ? "text-blue-500" : "text-[#D97757]";
  const createdAtLabel = s.createdAt > 0 ? new Date(s.createdAt).toLocaleString() : "Unknown";
  const taskEntries = (taskHistory ?? []).map((task) => ({
    ...task,
    title: task.title.trim(),
  }));
  const activeQuest = useMemo(
    () =>
      quests.find((quest) => quest.status === "in_progress" && "sessionId" in quest && quest.sessionId === s.id) ??
      null,
    [quests, s.id],
  );

  // Stats from sessionState
  const turns = sessionState?.num_turns ?? sdkSessionMeta?.numTurns ?? 0;
  const contextPercent = sessionState?.context_used_percent ?? sdkSessionMeta?.contextUsedPercent ?? 0;
  const contextWindow =
    sessionState?.codex_token_details?.modelContextWindow ??
    sessionState?.claude_token_details?.modelContextWindow ??
    sdkSessionMeta?.codexTokenDetails?.modelContextWindow ??
    sdkSessionMeta?.claudeTokenDetails?.modelContextWindow ??
    0;
  const isCodexSession = effectiveBackendType === "codex";
  const messageHistoryBytes = sessionState?.message_history_bytes ?? sdkSessionMeta?.messageHistoryBytes ?? 0;
  const codexRetainedPayloadBytes =
    sessionState?.codex_retained_payload_bytes ?? sdkSessionMeta?.codexRetainedPayloadBytes ?? 0;
  const hasBranchDivergence = s.gitAhead > 0 || s.gitBehind > 0;
  const hasLineDiff = s.linesAdded > 0 || s.linesRemoved > 0;

  // Position: right of sidebar, vertically aligned with the hovered item
  // The sidebar is 260px wide. Position card to the right of the anchor.
  const cardWidth = 340;
  const gap = 4;

  // Initial position — will be corrected by useLayoutEffect for viewport clamping
  const left = anchorRect.right + gap;
  const top = anchorRect.top;

  // Clamp to viewport after render
  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const el = cardRef.current;

    // Clamp horizontal: if overflows right, show to the left of the anchor
    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${anchorRect.left - cardWidth - gap}px`;
    }
    // Clamp vertical
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
    if (rect.top < 8) {
      el.style.top = "8px";
    }
  }, [anchorRect, cardWidth]);

  useEffect(() => {
    const container = taskHistoryScrollRef.current;
    if (!container || taskEntries.length === 0) return;
    container.scrollTop = container.scrollHeight;
  }, [taskHistory, s.id, taskEntries.length]);

  // Render via portal to escape sidebar wrapper's overflow:hidden clipping.
  // The sidebar wrapper uses overflow-hidden for collapse animation, which
  // clips fixed-position children. Portaling to document.body avoids this.
  return createPortal(
    <div
      ref={cardRef}
      className="fixed z-50 pointer-events-auto hidden-on-touch"
      style={{ left, top, width: cardWidth, transform: `scale(${zoomLevel})`, transformOrigin: "top left" }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="bg-cc-card border border-cc-border rounded-xl shadow-xl overflow-hidden">
        {/* Header: Name + Status */}
        <div className="px-4 pt-3 pb-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="text-[14px] font-semibold text-cc-fg leading-snug break-words min-w-0">{label}</span>
              {s.sessionNum != null && (
                <span className="text-[10px] font-mono text-cc-muted/60 shrink-0">#{s.sessionNum}</span>
              )}
            </span>
            <span className="flex items-center gap-1.5 shrink-0">
              <span className={`w-2 h-2 rounded-full ${statusDotClass}`} />
              <span className="text-[11px] text-cc-muted">{statusLabel}</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[11px] font-medium ${backendToneClass}`}>{backendLabel}</span>
            {model && (
              <>
                <span className="text-cc-muted/40 text-[10px]">&middot;</span>
                <span className="text-[11px] text-cc-muted">{formatModel(model)}</span>
              </>
            )}
            {s.cronJobId && (
              <>
                <span className="text-cc-muted/40 text-[10px]">&middot;</span>
                <span className="text-[11px] text-violet-500 font-medium">Cron</span>
              </>
            )}
            {s.isOrchestrator && (
              <>
                <span className="text-cc-muted/40 text-[10px]">&middot;</span>
                <span className="text-[11px] text-amber-500 font-medium">Leader</span>
              </>
            )}
          </div>
          {s.cwd && (
            <SessionPathSummary
              cwd={s.cwd}
              repoRoot={s.repoRoot}
              isWorktree={s.isWorktree}
              testIdPrefix="session-hover-path"
            />
          )}
        </div>

        {/* Herded sessions — shown for leader sessions */}
        {herdedSessions.length > 0 && (
          <div data-testid="session-hover-herding" className="px-4 py-2 border-t border-cc-border/50">
            <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Herding</span>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {herdedSessions.map((hs) => (
                <SessionNumChip
                  key={hs}
                  sessionId={hs}
                  className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 cursor-pointer transition-colors"
                />
              ))}
            </div>
          </div>
        )}
        {leaderSession && (
          <div data-testid="session-hover-herded-by" className="px-4 py-2 border-t border-cc-border/50">
            <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Herded by</span>
            <div className="mt-1">
              <SessionNumChip
                sessionId={leaderSession}
                className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 cursor-pointer transition-colors"
              />
            </div>
          </div>
        )}
        {activeQuest && (
          <div data-testid="session-hover-active-quest" className="px-4 py-2 border-t border-cc-border/50">
            <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Active quest</span>
            <div className="mt-1 flex items-center gap-2 min-w-0">
              <QuestInlineLink
                questId={activeQuest.questId}
                className="inline-flex shrink-0 items-center rounded-full border border-cc-primary/15 bg-cc-primary/10 px-2 py-0.5 text-[11px] font-medium text-cc-primary transition-colors hover:bg-cc-primary/20"
                stopPropagation
              >
                {activeQuest.questId}
              </QuestInlineLink>
              <span className="min-w-0 truncate text-[11px] text-cc-muted">{activeQuest.title}</span>
            </div>
          </div>
        )}

        {/* Task history + last message preview */}
        {taskEntries.length > 0 ? (
          <div className="px-4 py-2 border-t border-cc-border/50 space-y-1.5">
            <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Tasks</span>
            <div
              ref={taskHistoryScrollRef}
              data-testid="session-hover-task-history-scroll"
              className="max-h-40 overflow-y-auto pr-2 pb-1 space-y-1.5"
              style={{ scrollbarGutter: "stable both-edges" }}
            >
              {taskEntries.map((task, i) => (
                <div key={i} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-1.5">
                  <span className="text-[10px] tabular-nums text-right text-cc-muted/60 mt-px">{i + 1}.</span>
                  <span className="text-[12px] text-cc-fg leading-snug line-clamp-1">{task.title}</span>
                </div>
              ))}
            </div>
            {sessionPreview && (
              <div className="pt-1 border-t border-cc-border/30">
                <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Last message</span>
                <p className="text-[11px] text-cc-muted leading-relaxed line-clamp-2 italic mt-0.5">
                  {sessionPreview.length >= 80 ? `${sessionPreview}...` : sessionPreview}
                </p>
              </div>
            )}
          </div>
        ) : sessionPreview ? (
          <div className="px-4 py-2 border-t border-cc-border/50">
            <p className="text-[12px] text-cc-muted leading-relaxed line-clamp-3 italic">
              {sessionPreview.length >= 80 ? `${sessionPreview}...` : sessionPreview}
            </p>
          </div>
        ) : null}

        {/* Git section */}
        {(s.gitBranch || hasBranchDivergence || hasLineDiff) && (
          <div className="px-4 py-2 border-t border-cc-border/50">
            {s.gitBranch && (
              <div className="flex items-center gap-1.5 text-[12px] text-cc-muted leading-tight">
                {s.isWorktree ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-50">
                    <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-50">
                    <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                  </svg>
                )}
                <span className="break-all">{s.gitBranch}</span>
                {s.isWorktree && (
                  <span className="text-[9px] bg-cc-primary/10 text-cc-primary px-1 rounded shrink-0">wt</span>
                )}
              </div>
            )}
            {(hasBranchDivergence || hasLineDiff) && (
              <div className="flex items-center gap-2 mt-1 text-[11px] text-cc-muted">
                {hasBranchDivergence && (
                  <span className="flex items-center gap-1">
                    {s.gitAhead > 0 && <span className="text-green-500">{s.gitAhead}&#8593;</span>}
                    {s.gitBehind > 0 && <span className="text-cc-warning">{s.gitBehind}&#8595;</span>}
                  </span>
                )}
                {hasLineDiff && (
                  <span className="flex items-center gap-1">
                    <span className="text-green-500">+{s.linesAdded}</span>
                    <span className="text-red-400">-{s.linesRemoved}</span>
                  </span>
                )}
              </div>
            )}
            {/* Worktree liveness status for archived worktree sessions */}
            {s.archived && s.isWorktree && s.worktreeExists !== undefined && (
              <div
                className={`flex items-center gap-1.5 mt-1 text-[11px] ${
                  s.worktreeExists ? (s.worktreeDirty ? "text-amber-500" : "text-green-500") : "text-cc-muted"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    s.worktreeExists ? (s.worktreeDirty ? "bg-amber-500" : "bg-green-500") : "bg-cc-muted/50"
                  }`}
                />
                {s.worktreeExists
                  ? s.worktreeDirty
                    ? "Worktree preserved (uncommitted changes)"
                    : "Worktree preserved"
                  : "Worktree deleted"}
              </div>
            )}
          </div>
        )}

        {/* Stats row */}
        {(turns > 0 ||
          contextPercent > 0 ||
          messageHistoryBytes > 0 ||
          codexRetainedPayloadBytes > 0 ||
          contextWindow > 0 ||
          s.lastActivityAt) && (
          <div className="px-4 py-2 border-t border-cc-border/50">
            <SessionPayloadStats
              turns={turns}
              contextPercent={contextPercent}
              contextWindow={contextWindow}
              historyBytes={messageHistoryBytes}
              codexRetainedPayloadBytes={codexRetainedPayloadBytes}
              isCodexSession={isCodexSession}
              lastActivityAt={s.lastActivityAt}
            />
          </div>
        )}

        {/* Session metadata */}
        <div className="px-4 py-2 border-t border-cc-border/50 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] text-cc-muted">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-50">
              <path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM5.243 5.15a.5.5 0 00-.736.676l2.35 2.56-2.35 2.56a.5.5 0 00.736.676l2.5-2.722a.5.5 0 000-.676l-2.5-2.074zM8.5 11a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
            </svg>
            <span className="text-[10px] text-cc-muted/80 shrink-0">session</span>
            <span className="font-mono text-[10px] truncate" title={s.id}>
              {s.id}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-cc-muted">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-50">
              <path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM5.243 5.15a.5.5 0 00-.736.676l2.35 2.56-2.35 2.56a.5.5 0 00.736.676l2.5-2.722a.5.5 0 000-.676l-2.5-2.074zM8.5 11a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
            </svg>
            <span className="text-[10px] text-cc-muted/80 shrink-0">cli</span>
            <span className="font-mono text-[10px] truncate" title={cliSessionId || "Not available yet"}>
              {cliSessionId || "Not available yet"}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-cc-muted">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-50">
              <path d="M3 2a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1h-1V1h-1v1H5V1H4v1H3zm10 4H3v7h10V6z" />
            </svg>
            <span className="text-[10px] text-cc-muted/80 shrink-0">created</span>
            <span className="text-[10px] truncate" title={createdAtLabel}>
              {createdAtLabel}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
