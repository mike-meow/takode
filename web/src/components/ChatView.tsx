import { useMemo, useState, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import {
  PermissionBanner,
  PlanReviewOverlay,
  PlanCollapsedChip,
  PermissionsCollapsedChip,
} from "./PermissionBanner.js";
import { TaskOutlineBar } from "./TaskOutlineBar.js";
import { TodoStatusLine } from "./TodoStatusLine.js";
import { WorkBoardBar } from "./WorkBoardBar.js";
import { YarnBallDot } from "./CatIcons.js";
import { SearchBar } from "./SearchBar.js";
import { useSessionSearch } from "../hooks/useSessionSearch.js";
import { orderBoardRows, type BoardRowData } from "./BoardTable.js";
import { QuestJourneyCompactSummary } from "./QuestJourneyTimeline.js";
import type { ChatMessage, QuestmasterTask } from "../types.js";

type LeaderThreadRow = {
  threadKey: string;
  questId?: string;
  title: string;
  status?: string;
  boardStatus?: string;
  journey?: BoardRowData["journey"];
  messageCount: number;
};

const EMPTY_BOARD_ROWS: BoardRowData[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];

function messageThreadKeys(message: ChatMessage): string[] {
  const keys = new Set<string>();
  const metadata = message.metadata;
  if (!metadata) return [];
  if (metadata.threadKey && metadata.threadKey !== "main") keys.add(metadata.threadKey.toLowerCase());
  if (metadata.questId) keys.add(metadata.questId.toLowerCase());
  if (metadata.quest?.questId) keys.add(metadata.quest.questId.toLowerCase());
  for (const ref of metadata.threadRefs ?? []) {
    if (ref.threadKey !== "main") keys.add(ref.threadKey.toLowerCase());
  }
  return [...keys];
}

function buildLeaderThreadRows({
  activeBoard,
  completedBoard,
  messages,
  quests,
}: {
  activeBoard: BoardRowData[];
  completedBoard: BoardRowData[];
  messages: ChatMessage[];
  quests: QuestmasterTask[];
}): LeaderThreadRow[] {
  const questById = new Map(quests.map((quest) => [quest.questId.toLowerCase(), quest]));
  const rows = new Map<string, LeaderThreadRow>();
  const counts = new Map<string, number>();

  for (const message of messages) {
    for (const key of messageThreadKeys(message)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const addQuestRow = (questId: string, partial: Partial<LeaderThreadRow> = {}) => {
    const key = questId.toLowerCase();
    const quest = questById.get(key);
    const existing = rows.get(key);
    rows.set(key, {
      threadKey: key,
      questId: key,
      title: partial.title ?? existing?.title ?? quest?.title ?? questId,
      status: partial.status ?? existing?.status ?? quest?.status,
      boardStatus: partial.boardStatus ?? existing?.boardStatus,
      journey: partial.journey ?? existing?.journey,
      messageCount: counts.get(key) ?? existing?.messageCount ?? 0,
    });
  };

  for (const row of orderBoardRows(activeBoard)) {
    addQuestRow(row.questId, { title: row.title, boardStatus: row.status, journey: row.journey });
  }
  for (const row of orderBoardRows(completedBoard, "completed")) {
    addQuestRow(row.questId, { title: row.title, boardStatus: row.status, journey: row.journey });
  }
  for (const key of counts.keys()) {
    if (/^q-\d+$/.test(key)) addQuestRow(key);
  }

  return [...rows.values()];
}

function LeaderThreadSwitcher({
  sessionId,
  selectedThreadKey,
  onSelectThread,
}: {
  sessionId: string;
  selectedThreadKey: string;
  onSelectThread: (threadKey: string) => void;
}) {
  const activeBoard = useStore((s) => s.sessionBoards.get(sessionId) ?? EMPTY_BOARD_ROWS);
  const completedBoard = useStore((s) => s.sessionCompletedBoards.get(sessionId) ?? EMPTY_BOARD_ROWS);
  const messages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const quests = useStore((s) => s.quests);
  const openQuestOverlay = useStore((s) => s.openQuestOverlay);
  const rows = useMemo(
    () => buildLeaderThreadRows({ activeBoard, completedBoard, messages, quests }),
    [activeBoard, completedBoard, messages, quests],
  );
  const normalizedSelected = selectedThreadKey.toLowerCase();

  return (
    <aside
      className="flex shrink-0 overflow-x-auto border-b border-cc-border bg-cc-card/70 sm:w-64 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:border-b-0 sm:border-r"
      data-testid="leader-thread-switcher"
    >
      <button
        type="button"
        onClick={() => onSelectThread("main")}
        className={`shrink-0 border-r border-cc-border/60 px-3 py-2 text-left transition-colors sm:w-full sm:border-r-0 sm:border-b ${
          normalizedSelected === "main" ? "bg-cc-hover text-cc-fg" : "text-cc-muted hover:bg-cc-hover/60"
        }`}
      >
        <div className="text-xs font-semibold">Main</div>
        <div className="text-[10px] text-cc-muted/80 tabular-nums">{messages.length} messages</div>
      </button>
      {rows.map((row) => {
        const selected = normalizedSelected === row.threadKey;
        return (
          <div
            key={row.threadKey}
            className={`min-w-56 shrink-0 border-r border-cc-border/60 sm:min-w-0 sm:w-full sm:border-r-0 sm:border-b ${
              selected ? "bg-cc-hover" : "hover:bg-cc-hover/50"
            }`}
          >
            <button type="button" onClick={() => onSelectThread(row.threadKey)} className="w-full px-3 py-2 text-left">
              <div className="flex items-center gap-2">
                <span className="font-mono-code text-[11px] text-blue-400">{row.threadKey}</span>
                {row.boardStatus && <span className="truncate text-[10px] text-cc-muted">{row.boardStatus}</span>}
              </div>
              <div className="mt-0.5 truncate text-xs text-cc-fg">{row.title}</div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-cc-muted">
                {row.status && <span className="truncate">{row.status}</span>}
                <span className="tabular-nums">{row.messageCount} msgs</span>
              </div>
              {row.journey && (
                <QuestJourneyCompactSummary journey={row.journey} status={row.boardStatus} className="mt-1" />
              )}
            </button>
            {row.questId && (
              <button
                type="button"
                onClick={() => openQuestOverlay(row.questId!)}
                className="mx-3 mb-2 text-[10px] text-blue-400 hover:text-blue-300 hover:underline"
              >
                Open quest
              </button>
            )}
          </div>
        );
      })}
    </aside>
  );
}

function CompactingIndicator({ sessionId }: { sessionId: string }) {
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  if (sessionStatus !== "compacting") return null;
  return (
    <div className="shrink-0 flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code px-4 py-1">
      <YarnBallDot className="text-cc-primary animate-pulse" />
      <span>Compacting conversation...</span>
    </div>
  );
}

export function ChatView({ sessionId, preview = false }: { sessionId: string; preview?: boolean }) {
  const {
    sessionPerms,
    connStatus,
    backendState,
    backendError,
    cliConnected,
    cliEverConnected,
    cliDisconnectReason,
    isArchived,
    isLeaderSession,
  } = useStore(
    useShallow((s) => ({
      sessionPerms: s.pendingPermissions.get(sessionId),
      connStatus: s.connectionStatus.get(sessionId) ?? "disconnected",
      backendState: s.sessions.get(sessionId)?.backend_state ?? "disconnected",
      backendError: s.sessions.get(sessionId)?.backend_error ?? null,
      cliConnected: s.cliConnected.get(sessionId) ?? false,
      cliEverConnected: s.cliEverConnected.get(sessionId) ?? false,
      cliDisconnectReason: s.cliDisconnectReason.get(sessionId) ?? null,
      isArchived: s.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.archived ?? false,
      isLeaderSession:
        s.sessions.get(sessionId)?.isOrchestrator === true ||
        s.sdkSessions.some((sdk) => sdk.sessionId === sessionId && sdk.isOrchestrator === true),
    })),
  );
  const [selectedThreadKey, setSelectedThreadKey] = useState("main");

  useEffect(() => {
    setSelectedThreadKey("main");
  }, [sessionId]);

  // Within-session search
  const searchInputRef = useRef<HTMLInputElement>(null);
  useSessionSearch(sessionId, !preview);

  const perms = useMemo(() => (sessionPerms ? Array.from(sessionPerms.values()) : []), [sessionPerms]);

  // Separate plan permission from other permissions
  const planPerm = perms.find((p) => p.tool_name === "ExitPlanMode") || null;
  const otherPerms = perms.filter((p) => p.tool_name !== "ExitPlanMode");

  // Plan collapse state — auto-expand when a new plan arrives
  const [planCollapsed, setPlanCollapsed] = useState(false);
  const planPermId = planPerm?.request_id;
  useEffect(() => {
    if (planPermId) setPlanCollapsed(false);
  }, [planPermId]);

  const showPlanOverlay = planPerm && !planCollapsed;

  // Permissions collapse state — auto-expand only when new permissions arrive
  const [permsCollapsed, setPermsCollapsed] = useState(false);
  const prevOtherPermsCount = useRef(0);
  useEffect(() => {
    if (otherPerms.length > prevOtherPermsCount.current) {
      setPermsCollapsed(false);
    }
    prevOtherPermsCount.current = otherPerms.length;
  }, [otherPerms.length]);

  const showStartingBanner =
    connStatus === "connected" &&
    !cliConnected &&
    backendState !== "broken" &&
    (backendState === "initializing" ||
      backendState === "resuming" ||
      backendState === "recovering" ||
      !cliEverConnected);
  const isResumeMissingRolloutError =
    backendError?.includes("could not be resumed because its local rollout is missing or unreadable") ?? false;
  return (
    <div className="flex flex-col h-full min-h-0">
      {preview ? (
        <div className="shrink-0 px-4 py-2 border-b border-cc-border bg-cc-card/80 text-[11px] text-cc-muted font-medium">
          Previewing search result. Press Enter to select this conversation.
        </div>
      ) : (
        /* Within-session message search bar */
        <SearchBar sessionId={sessionId} inputRef={searchInputRef} />
      )}

      {/* CLI starting / resuming banner */}
      {!preview && showStartingBanner && (
        <div className="px-4 py-2 bg-cc-border/30 border-b border-cc-border text-center flex items-center justify-center gap-2">
          <svg
            className="animate-spin h-3 w-3 text-cc-text-secondary"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-xs text-cc-text-secondary font-medium">
            {backendState === "recovering"
              ? "Recovering session..."
              : backendState === "resuming" || cliEverConnected
                ? "Reconnecting session..."
                : "Starting session..."}
          </span>
        </div>
      )}

      {/* Broken session banner */}
      {!preview && connStatus === "connected" && !cliConnected && backendState === "broken" && (
        <div className="px-4 py-2 bg-cc-warning/10 border-b border-cc-warning/20 text-center flex items-center justify-center gap-3">
          <span className="text-xs text-cc-warning font-medium">
            {backendError || "CLI failed to recover. Relaunch to resume queued messages."}
          </span>
          <button
            onClick={() => api.relaunchSession(sessionId).catch(console.error)}
            className="text-xs font-medium px-3 py-1 rounded-md bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-warning transition-colors cursor-pointer"
          >
            {isResumeMissingRolloutError ? "Start Fresh" : "Relaunch"}
          </button>
        </div>
      )}

      {/* CLI disconnected banner (CLI was connected before but dropped) */}
      {!preview &&
        connStatus === "connected" &&
        !cliConnected &&
        cliEverConnected &&
        backendState !== "broken" &&
        backendState !== "initializing" &&
        backendState !== "resuming" &&
        backendState !== "recovering" && (
          <div
            className={`px-4 py-2 border-b text-center flex items-center justify-center gap-3 ${
              cliDisconnectReason === "idle_limit"
                ? "bg-cc-border/30 border-cc-border"
                : "bg-cc-warning/10 border-cc-warning/20"
            }`}
          >
            <span
              className={`text-xs font-medium ${
                cliDisconnectReason === "idle_limit" ? "text-cc-text-secondary" : "text-cc-warning"
              }`}
            >
              {cliDisconnectReason === "idle_limit"
                ? "Session paused to stay within keep-alive limit"
                : "CLI disconnected"}
            </span>
            <button
              onClick={() => api.relaunchSession(sessionId).catch(console.error)}
              className={`text-xs font-medium px-3 py-1 rounded-md transition-colors cursor-pointer ${
                cliDisconnectReason === "idle_limit"
                  ? "bg-cc-hover hover:bg-cc-border text-cc-fg"
                  : "bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-warning"
              }`}
            >
              Resume
            </button>
          </div>
        )}

      {/* WebSocket disconnected banner */}
      {!preview && connStatus === "disconnected" && (
        <div className="px-4 py-2 bg-cc-warning/10 border-b border-cc-warning/20 text-center">
          <span className="text-xs text-cc-warning font-medium">Reconnecting to session...</span>
        </div>
      )}

      {/* Archived session banner */}
      {!preview && isArchived && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/25 flex items-center justify-center gap-3">
          <span className="text-xs text-amber-300 font-medium">This session is archived.</span>
          <button
            onClick={() => api.unarchiveSession(sessionId).catch(console.error)}
            className="text-xs font-medium px-3 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer"
          >
            Unarchive
          </button>
        </div>
      )}

      {/* Session task outline — horizontal milestone chips */}
      {!preview && <TaskOutlineBar sessionId={sessionId} />}

      {/* Plan overlay fills the chat area, OR show the normal message feed */}
      {!preview && showPlanOverlay ? (
        <PlanReviewOverlay permission={planPerm} sessionId={sessionId} onCollapse={() => setPlanCollapsed(true)} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {!preview && isLeaderSession && (
            <LeaderThreadSwitcher
              sessionId={sessionId}
              selectedThreadKey={selectedThreadKey}
              onSelectThread={setSelectedThreadKey}
            />
          )}
          <MessageFeed sessionId={sessionId} threadKey={isLeaderSession ? selectedThreadKey : "main"} />
        </div>
      )}

      {/* Collapsed plan chip (when plan exists but is collapsed) */}
      {!preview && planPerm && planCollapsed && (
        <div className="shrink-0 border-t border-cc-border bg-cc-card px-2 sm:px-4 py-2">
          <PlanCollapsedChip permission={planPerm} sessionId={sessionId} onExpand={() => setPlanCollapsed(false)} />
        </div>
      )}

      {/* Non-plan permission banners — collapsible */}
      {!preview &&
        otherPerms.length > 0 &&
        (permsCollapsed ? (
          <PermissionsCollapsedChip permissions={otherPerms} onExpand={() => setPermsCollapsed(false)} />
        ) : (
          <div className="shrink-0 max-h-[60dvh] overflow-y-auto border-t border-cc-border bg-cc-card">
            <div
              onClick={() => setPermsCollapsed(true)}
              className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-cc-card border-b border-cc-border/50 cursor-pointer hover:bg-cc-hover/50 transition-colors"
              role="button"
              title="Minimize approvals"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning">
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="text-[11px] font-medium text-cc-warning">
                {otherPerms.length} pending approval{otherPerms.length !== 1 ? "s" : ""}
              </span>
              <span className="ml-auto p-1.5 rounded-md text-cc-muted">
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
                  <path d="M4 8h4" />
                </svg>
              </span>
            </div>
            {otherPerms.map((p) => (
              <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
            ))}
          </div>
        ))}

      {/* Compacting indicator — fixed above composer, green like running state */}
      {!preview && <CompactingIndicator sessionId={sessionId} />}

      {/* Active todo status — shows current in-progress task */}
      {!preview && <TodoStatusLine sessionId={sessionId} />}

      {/* Persistent work board for orchestrator sessions */}
      {!preview && <WorkBoardBar sessionId={sessionId} />}

      {/* Composer */}
      {!preview && (
        <Composer
          sessionId={sessionId}
          threadKey={isLeaderSession ? selectedThreadKey : "main"}
          questId={isLeaderSession && selectedThreadKey !== "main" ? selectedThreadKey : undefined}
        />
      )}
    </div>
  );
}
