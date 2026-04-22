import { useStore } from "../store.js";
import type { SidebarSessionItem as SessionItemType } from "../utils/sidebar-session-item.js";
import { SessionStatusDot } from "./SessionStatusDot.js";

export function PickerSessionChip({
  session: s,
  sessionName,
  sessionPreview,
  onClick,
}: {
  session: SessionItemType;
  sessionName: string | undefined;
  sessionPreview: string | undefined;
  onClick: () => void;
}) {
  const taskPreview = useStore((st) => st.sessionTaskPreview.get(s.id));
  const userUpdatedAt = useStore((st) => st.sessionPreviewUpdatedAt.get(s.id) ?? 0);

  const label = sessionName || s.model || s.id.slice(0, 8);
  const backendLogo = s.backendType === "codex" ? "/logo-codex.svg" : "/logo.png";
  const backendAlt = s.backendType === "codex" ? "Codex" : "Claude";
  const showTask = taskPreview && taskPreview.updatedAt > userUpdatedAt;
  const hasBranchDivergence = s.gitAhead > 0 || s.gitBehind > 0;
  const hasLineDiff = s.linesAdded > 0 || s.linesRemoved > 0;

  return (
    <button
      onClick={onClick}
      className="relative w-full pl-3.5 pr-3 py-2 text-left rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
    >
      <span
        className={`absolute left-0 top-2 bottom-2 w-[2px] rounded-full ${
          s.backendType === "codex" ? "bg-blue-500" : "bg-[#D97757]"
        } opacity-40`}
      />
      <div className="flex items-start gap-2">
        <SessionStatusDot
          permCount={s.permCount}
          isConnected={s.isConnected}
          sdkState={s.sdkState}
          status={s.status}
          idleKilled={s.idleKilled}
        />
        <div className="flex-1 min-w-0">
          <span className="text-[13px] font-medium truncate text-cc-fg leading-snug block">{label}</span>
          {showTask ? (
            <div className="mt-0.5 text-[10.5px] text-cc-primary/60 leading-tight truncate italic">
              {taskPreview.text}
            </div>
          ) : sessionPreview ? (
            <div className="mt-0.5 text-[10.5px] text-cc-muted/60 leading-tight truncate">{sessionPreview}</div>
          ) : null}
          <div className="flex items-center gap-1 mt-0.5 text-[10.5px] text-cc-muted leading-tight">
            <img src={backendLogo} alt={backendAlt} className="w-3 h-3 shrink-0 object-contain opacity-60" />
            {s.backendType !== "codex" && s.askPermission === true && (
              <span title="Permissions: asking before tool use">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 text-cc-primary">
                  <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                  <path
                    d="M6.5 8.5L7.5 9.5L10 7"
                    stroke="white"
                    strokeWidth="1.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            )}
            {s.backendType !== "codex" && s.askPermission === false && (
              <span title="Permissions: auto-approving tool use">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  className="w-2.5 h-2.5 shrink-0 text-cc-muted/50"
                >
                  <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                </svg>
              </span>
            )}
            {s.isContainerized && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-blue-400 bg-blue-500/10">
                Docker
              </span>
            )}
            {s.cronJobId && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-violet-500 bg-violet-500/10">
                Cron
              </span>
            )}
            {s.isOrchestrator && (
              <span
                className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-amber-500 bg-amber-500/10"
                title="Leader session"
              >
                leader
              </span>
            )}
            {!s.isOrchestrator && s.herdedBy && s.herdedBy.length > 0 && (
              <span
                className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-amber-400 bg-amber-500/10"
                title="Herded by a leader"
              >
                herd
              </span>
            )}
            {s.sessionNum != null && <span className="text-[9px] font-mono text-cc-muted/60 shrink-0">#{s.sessionNum}</span>}
            {s.gitBranch && (
              <>
                {s.isWorktree ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                    <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                    <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                  </svg>
                )}
                <span className="truncate">{s.gitBranch}</span>
                {s.isWorktree && (
                  <span className="text-[9px] px-1 rounded shrink-0 bg-cc-primary/10 text-cc-primary">wt</span>
                )}
              </>
            )}
          </div>
          {(hasBranchDivergence || hasLineDiff) && (
            <div className="flex items-center gap-1.5 mt-px text-[10px] text-cc-muted">
              {hasBranchDivergence && (
                <span className="flex items-center gap-0.5">
                  {s.gitAhead > 0 && <span className="text-green-500">{s.gitAhead}&#8593;</span>}
                  {s.gitBehind > 0 && <span className="text-cc-warning">{s.gitBehind}&#8595;</span>}
                </span>
              )}
              {hasLineDiff && (
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-green-500">+{s.linesAdded}</span>
                  <span className="text-red-400">-{s.linesRemoved}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
