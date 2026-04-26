import { useEffect, useRef, useMemo, useState } from "react";
import { useStore } from "../store.js";
import {
  GitHubPRSection,
  McpCollapsible,
  ClaudeMdCollapsible,
  HerdDiagnosticsSection,
  SystemPromptCollapsible,
} from "./TaskPanel.js";
import { formatModel, getModelsForBackend, CODEX_REASONING_EFFORTS } from "../utils/backends.js";
import { coalesceSessionViewModel } from "../utils/session-view-model.js";
import { navigateTo } from "../utils/navigation.js";
import { sendToSession } from "../ws.js";
import { SessionNumChip } from "./SessionNumChip.js";
import { SessionPathSummary } from "./SessionPathSummary.js";
import { SessionPayloadStats } from "./SessionPayloadStats.js";
import { api, type EditorKind } from "../api.js";
import type { SdkSessionInfo } from "../types.js";
import { openPathWithEditorPreference } from "../utils/vscode-bridge.js";

export function SessionInfoPopover({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const sdkSessions = useStore((s) => s.sdkSessions);
  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const sessionVm = coalesceSessionViewModel(session, sdkSession);
  const cwd = sessionVm?.cwd ?? null;
  const model = sessionVm?.model ?? "";
  const backendType = sessionVm?.backendType ?? "claude";
  const popoverRef = useRef<HTMLDivElement>(null);
  const taskHistoryScrollRef = useRef<HTMLDivElement>(null);

  // Stats
  const turns = sessionVm?.numTurns ?? 0;
  const contextPercent = sessionVm?.contextUsedPercent ?? 0;
  const contextWindow = sessionVm?.modelContextWindow ?? 0;
  const historyBytes = sessionVm?.messageHistoryBytes ?? 0;
  const codexRetainedPayloadBytes = sessionVm?.codexRetainedPayloadBytes ?? 0;
  const isCodexSession = backendType === "codex";

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
      if (
        targetEl?.closest("[data-claude-md-editor-root='true']") ||
        targetEl?.closest("[data-session-info-modal='true']")
      ) {
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

  const isConnected = useStore((s) => s.connectionStatus.get(sessionId) === "connected");
  const codexReasoningEffort = session?.codex_reasoning_effort || "";
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showReasoningDropdown, setShowReasoningDropdown] = useState(false);
  const [editorKind, setEditorKind] = useState<EditorKind | null>(null);
  const [editorConfigError, setEditorConfigError] = useState("");
  const [openEditorError, setOpenEditorError] = useState("");
  const [openingEditor, setOpeningEditor] = useState(false);
  const [sdkSessionsFallback, setSdkSessionsFallback] = useState<SdkSessionInfo[] | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const reasoningDropdownRef = useRef<HTMLDivElement>(null);
  const modelOptions = useMemo(() => getModelsForBackend(backendType as "claude" | "codex"), [backendType]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (reasoningDropdownRef.current && !reasoningDropdownRef.current.contains(e.target as Node)) {
        setShowReasoningDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setEditorKind(null);
    setEditorConfigError("");
    api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        setEditorKind(settings.editorConfig?.editor ?? "none");
      })
      .catch((error) => {
        if (cancelled) return;
        setEditorConfigError(error instanceof Error ? error.message : "Unable to load editor settings.");
        setEditorKind("none");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (sdkSessions.length > 0 && sdkSession) {
      setSdkSessionsFallback(null);
      return;
    }
    let cancelled = false;
    api
      .listSessions()
      .then((sessions) => {
        if (cancelled) return;
        setSdkSessionsFallback(sessions);
      })
      .catch(() => {
        if (cancelled) return;
        setSdkSessionsFallback(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sdkSession, sdkSessions.length]);

  const backendLabel = backendType === "codex" ? "Codex" : "Claude";
  const hasGit = gitBranch || gitAhead > 0 || gitBehind > 0 || linesAdded > 0 || linesRemoved > 0;
  const hasStats =
    turns > 0 || contextPercent > 0 || contextWindow > 0 || historyBytes > 0 || codexRetainedPayloadBytes > 0;
  const effectiveSdkSessions = sdkSessions.length > 0 ? sdkSessions : (sdkSessionsFallback ?? []);
  const effectiveSdkSession = sdkSession ?? effectiveSdkSessions.find((x) => x.sessionId === sessionId);
  const codexLeaderRecycleLineage = effectiveSdkSession?.codexLeaderRecycleLineage;
  const codexLeaderRecyclePending = effectiveSdkSession?.codexLeaderRecyclePending;
  const taskEntries = (taskHistory ?? []).map((task) => ({
    ...task,
    title: task.title.trim(),
  }));
  const herdedSessions = useMemo(() => {
    if (!effectiveSdkSession?.isOrchestrator) return [];
    return effectiveSdkSessions
      .filter((sdk) => sdk.herdedBy === sessionId && !sdk.archived)
      .map((sdk) => sdk.sessionId);
  }, [effectiveSdkSession?.isOrchestrator, effectiveSdkSessions, sessionId]);
  const leaderSession = useMemo(() => {
    if (effectiveSdkSession?.isOrchestrator || !effectiveSdkSession?.herdedBy) return null;
    const leader = effectiveSdkSessions.find((sdk) => sdk.sessionId === effectiveSdkSession.herdedBy && !sdk.archived);
    return leader?.sessionId ?? effectiveSdkSession.herdedBy;
  }, [effectiveSdkSession?.isOrchestrator, effectiveSdkSession?.herdedBy, effectiveSdkSessions]);
  const editorDisabledReason = !cwd
    ? "No working directory is available for this session."
    : editorConfigError
      ? `Unable to load editor settings: ${editorConfigError}`
      : editorKind === null
        ? "Loading editor settings..."
        : editorKind === "none"
          ? "Configure an editor in Settings to open this directory."
          : "";
  const canOpenWorkingDirectory = !!cwd && !!editorKind && editorKind !== "none" && !editorConfigError;

  async function handleOpenWorkingDirectory() {
    if (!cwd || !editorKind || editorKind === "none") return;
    setOpeningEditor(true);
    setOpenEditorError("");
    try {
      const opened = await openPathWithEditorPreference(
        {
          absolutePath: cwd,
          targetKind: "directory",
        },
        editorKind,
      );
      if (!opened) {
        setOpenEditorError("Configure an editor in Settings to open this directory.");
      }
    } catch (error) {
      setOpenEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningEditor(false);
    }
  }

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
                <div className="relative" ref={modelDropdownRef}>
                  <button
                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                    disabled={!isConnected}
                    className={`flex items-center gap-0.5 text-[11px] transition-colors select-none ${
                      !isConnected
                        ? "cursor-not-allowed opacity-30 text-cc-muted"
                        : "cursor-pointer text-cc-muted hover:text-cc-fg"
                    }`}
                    title={`Model: ${model} (click to change)`}
                  >
                    <span>{formatModel(model)}</span>
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </button>
                  {showModelDropdown && (
                    <div className="absolute left-0 top-full z-10 mt-1 max-h-64 w-52 overflow-y-auto rounded-[10px] border border-cc-border bg-cc-card py-1 shadow-lg">
                      {modelOptions.map((m) => (
                        <button
                          key={m.value}
                          onClick={() => {
                            sendToSession(sessionId, { type: "set_model", model: m.value });
                            setShowModelDropdown(false);
                          }}
                          className={`w-full cursor-pointer px-3 py-2 text-left text-xs transition-colors hover:bg-cc-hover ${
                            m.value === model ? "font-medium text-cc-primary" : "text-cc-fg"
                          }`}
                        >
                          <span className="mr-1.5">{m.icon}</span>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          {isCodexSession && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-cc-muted/60">Reasoning</span>
              <div className="relative" ref={reasoningDropdownRef}>
                <button
                  onClick={() => setShowReasoningDropdown(!showReasoningDropdown)}
                  disabled={!isConnected}
                  className={`flex items-center gap-0.5 text-[11px] transition-colors select-none ${
                    !isConnected
                      ? "cursor-not-allowed opacity-30 text-cc-muted"
                      : "cursor-pointer text-cc-muted hover:text-cc-fg"
                  }`}
                  title="Reasoning effort (relaunch required)"
                >
                  <span>
                    {CODEX_REASONING_EFFORTS.find((x) => x.value === codexReasoningEffort)?.label.toLowerCase() ||
                      "default"}
                  </span>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                {showReasoningDropdown && (
                  <div className="absolute left-0 top-full z-10 mt-1 w-40 overflow-hidden rounded-[10px] border border-cc-border bg-cc-card py-1 shadow-lg">
                    {CODEX_REASONING_EFFORTS.map((effort) => (
                      <button
                        key={effort.value || "default"}
                        onClick={() => {
                          sendToSession(sessionId, { type: "set_codex_reasoning_effort", effort: effort.value });
                          setShowReasoningDropdown(false);
                        }}
                        className={`w-full cursor-pointer px-3 py-2 text-left text-xs transition-colors hover:bg-cc-hover ${
                          effort.value === codexReasoningEffort ? "font-medium text-cc-primary" : "text-cc-fg"
                        }`}
                      >
                        {effort.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {cwd && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Working Directory</span>
                <button
                  type="button"
                  data-testid="session-info-open-working-directory"
                  className="hidden sm:inline-flex items-center gap-1 rounded-md border border-cc-border px-2 py-1 text-[11px] text-cc-muted transition-colors hover:border-cc-primary/40 hover:bg-cc-hover hover:text-cc-fg disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={!canOpenWorkingDirectory || openingEditor}
                  title={editorDisabledReason || "Open this session's working directory in the configured editor"}
                  onClick={() => {
                    void handleOpenWorkingDirectory();
                  }}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                    <path d="M6 3.5h6.5V10" />
                    <path d="M12.5 3.5 6 10" />
                    <path d="M12.5 12.5h-9v-9" />
                  </svg>
                  {openingEditor ? "Opening" : "Open"}
                </button>
              </div>
              <SessionPathSummary
                cwd={cwd}
                repoRoot={sessionVm?.repoRoot}
                isWorktree={sessionVm?.isWorktree}
                testIdPrefix="session-info-path"
                interactivePaths
              />
              {openEditorError && (
                <div data-testid="session-info-open-editor-error" className="text-[11px] leading-snug text-red-400">
                  {openEditorError}
                </div>
              )}
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
        {(herdedSessions.length > 0 || leaderSession) && (
          <div className="px-4 py-2 border-t border-cc-border/50 space-y-2">
            {herdedSessions.length > 0 && (
              <div data-testid="session-info-herding">
                <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Herding</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
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
              <div data-testid="session-info-herded-by">
                <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Herded by</span>
                <div className="mt-1">
                  <SessionNumChip
                    sessionId={leaderSession}
                    className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 cursor-pointer transition-colors"
                  />
                </div>
              </div>
            )}
          </div>
        )}

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
            <SessionPayloadStats
              turns={turns}
              contextPercent={contextPercent}
              contextWindow={contextWindow}
              historyBytes={historyBytes}
              codexRetainedPayloadBytes={codexRetainedPayloadBytes}
              isCodexSession={isCodexSession}
              highlightHighHistoryBytes
            />
          </div>
        )}

        {codexLeaderRecycleLineage &&
          (codexLeaderRecycleLineage.cliSessionIds.length > 0 ||
            codexLeaderRecycleLineage.recycleEvents.length > 0) && (
            <div
              className="px-4 py-2 border-t border-cc-border/50 space-y-2"
              data-testid="codex-leader-recycle-lineage"
            >
              <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Codex Recycle</span>
              {codexLeaderRecyclePending && (
                <div className="text-[11px] text-amber-400">
                  Pending {codexLeaderRecyclePending.trigger === "manual_compact" ? "manual /compact" : "threshold"}{" "}
                  recycle
                </div>
              )}
              {codexLeaderRecycleLineage.cliSessionIds.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] text-cc-muted/70">CLI sessions</div>
                  <div className="space-y-1">
                    {codexLeaderRecycleLineage.cliSessionIds.map((cliSessionId, index) => (
                      <div key={`${cliSessionId}-${index}`} className="text-[11px] text-cc-fg/90 font-mono break-all">
                        {cliSessionId}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {codexLeaderRecycleLineage.recycleEvents.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] text-cc-muted/70">Recycle events</div>
                  <div className="space-y-1.5">
                    {codexLeaderRecycleLineage.recycleEvents.map((event, index) => (
                      <div key={`${event.requestedAt}-${index}`} className="rounded-lg bg-cc-hover/40 px-2 py-1.5">
                        <div className="text-[11px] text-cc-fg">
                          {event.trigger === "manual_compact" ? "Manual /compact" : "Threshold"} recycle
                        </div>
                        <div className="mt-0.5 text-[10px] text-cc-muted">
                          {formatRecycleTimestamp(event.requestedAt)}
                          {typeof event.tokenUsage?.contextTokensUsed === "number"
                            ? ` • ${formatRecycleTokenCount(event.tokenUsage.contextTokensUsed)} context`
                            : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        {/* Herd diagnostics — only for leader sessions */}
        {sdkSession?.isOrchestrator && (
          <div className="border-t border-cc-border/50">
            <HerdDiagnosticsSection sessionId={sessionId} />
          </div>
        )}

        {/* GitHub PR, MCP, CLAUDE.md, System Prompt */}
        <GitHubPRSection sessionId={sessionId} />
        <McpCollapsible sessionId={sessionId} />
        {cwd && <ClaudeMdCollapsible cwd={cwd} repoRoot={sessionVm?.repoRoot} />}
        <SystemPromptCollapsible sessionId={sessionId} />
      </div>
    </div>
  );
}

function formatRecycleTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRecycleTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
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
