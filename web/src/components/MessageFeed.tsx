import { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback, memo, type ReactNode } from "react";
import { useStore } from "../store.js";
import { MessageBubble } from "./MessageBubble.js";
import { ToolBlock, getToolIcon, getToolLabel, ToolIcon, formatDuration } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CollapseFooter, TurnCollapseFooter } from "./CollapseFooter.js";
import { api } from "../api.js";
import type { ChatMessage, ContentBlock } from "../types.js";
import { isSubagentToolName } from "../types.js";
import { YarnBallDot, YarnBallSpinner, SleepingCat } from "./CatIcons.js";
import { PawTrailAvatar, PawCounterContext, PawScrollProvider, HidePawContext } from "./PawTrail.js";
import { isTouchDevice } from "../utils/mobile.js";
import { useCollapsePolicy } from "../hooks/use-collapse-policy.js";
import {
  isUserBoundaryEntry,
  useFeedModel,
  type FeedEntry,
  type SubagentBatch,
  type SubagentGroup,
  type ToolMsgGroup,
  type Turn,
  type TurnStats,
} from "../hooks/use-feed-model.js";

const FEED_PAGE_SIZE = 100;

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const EMPTY_MESSAGES: ChatMessage[] = [];

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function minuteBucket(timestamp: number): string | null {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}

function isTimedChatMessage(msg: ChatMessage): boolean {
  return msg.role === "user" || msg.role === "assistant";
}

function appendTimedMessagesFromEntries(entries: FeedEntry[], out: ChatMessage[]) {
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    if (!isTimedChatMessage(entry.msg)) continue;
    out.push(entry.msg);
  }
}

function formatMinuteBoundaryLabel(timestamp: number, previousTimestamp: number | null): string | null {
  const current = new Date(timestamp);
  if (Number.isNaN(current.getTime())) return null;

  const prev = previousTimestamp === null ? null : new Date(previousTimestamp);
  const includesDate = !prev
    || current.getFullYear() !== prev.getFullYear()
    || current.getMonth() !== prev.getMonth()
    || current.getDate() !== prev.getDate();

  if (includesDate) {
    return current.toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return current.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildMinuteBoundaryLabelMap(messages: ChatMessage[]): Map<string, string> {
  const labels = new Map<string, string>();
  let prevMinute: string | null = null;
  let prevTimestamp: number | null = null;

  for (const msg of messages) {
    const currentMinute = minuteBucket(msg.timestamp);
    const startsNewMinute = currentMinute !== null && (prevMinute === null || currentMinute !== prevMinute);
    if (startsNewMinute) {
      const label = formatMinuteBoundaryLabel(msg.timestamp, prevTimestamp);
      if (label) labels.set(msg.id, label);
    }
    if (currentMinute !== null) {
      prevMinute = currentMinute;
      prevTimestamp = msg.timestamp;
    }
  }

  return labels;
}

// Self-contained timer component — its 1s tick only re-renders this element,
// not the entire MessageFeed (which would force all images to re-layout).
export function ElapsedTimer({ sessionId }: { sessionId: string }) {
  const streamingStartedAt = useStore((s) => s.streamingStartedAt.get(sessionId));
  const streamingOutputTokens = useStore((s) => s.streamingOutputTokens.get(sessionId));
  const streamingPausedDuration = useStore((s) => s.streamingPausedDuration.get(sessionId) ?? 0);
  const streamingPauseStartedAt = useStore((s) => s.streamingPauseStartedAt.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const isStuck = useStore((s) => s.sessionStuck.get(sessionId) ?? false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!streamingStartedAt && sessionStatus !== "running") {
      setElapsed(0);
      return;
    }
    const start = streamingStartedAt || Date.now();
    const calcElapsed = () => {
      const pauseOffset = streamingPausedDuration + (streamingPauseStartedAt ? Date.now() - streamingPauseStartedAt : 0);
      return Math.max(0, Date.now() - start - pauseOffset);
    };
    setElapsed(calcElapsed());
    const interval = setInterval(() => setElapsed(calcElapsed()), 1000);
    return () => clearInterval(interval);
  }, [streamingStartedAt, sessionStatus, streamingPausedDuration, streamingPauseStartedAt]);

  if (sessionStatus !== "running" || elapsed <= 0) return null;

  const handleRelaunch = () => {
    api.relaunchSession(sessionId).catch(() => {});
  };

  const label = isStuck ? 'Session may be stuck' : streamingPauseStartedAt ? 'Napping...' : 'Purring...';
  const dotColor = isStuck ? 'text-amber-400' : streamingPauseStartedAt ? 'text-amber-400' : 'text-cc-primary animate-pulse';

  return (
    <div className="shrink-0 flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code px-4 py-1">
      <YarnBallDot className={dotColor} />
      <span>{label}</span>
      <span className="text-cc-muted/60">(</span>
      <span>{formatElapsed(elapsed)}</span>
      {(streamingOutputTokens ?? 0) > 0 && (
        <>
          <span className="text-cc-muted/40">·</span>
          <span>↓ {formatTokens(streamingOutputTokens!)}</span>
        </>
      )}
      <span className="text-cc-muted/60">)</span>
      {isStuck && (
        <button
          onClick={handleRelaunch}
          className="ml-1 text-amber-400 hover:text-amber-300 underline cursor-pointer"
        >
          Relaunch
        </button>
      )}
    </div>
  );
}

function LiveDurationBadge({
  finalDurationSeconds,
  progressElapsedSeconds,
  startTimestamp,
  isComplete,
}: {
  finalDurationSeconds?: number;
  progressElapsedSeconds?: number;
  startTimestamp?: number;
  isComplete: boolean;
}) {
  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (finalDurationSeconds != null || isComplete) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setLiveSeconds(null);
      return;
    }

    if (startTimestamp == null) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setLiveSeconds(null);
      return;
    }

    const tick = () => {
      const elapsed = Math.max(0, Math.round((Date.now() - startTimestamp) / 1000));
      setLiveSeconds(elapsed);
    };
    tick();
    intervalRef.current = setInterval(tick, 1000);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [finalDurationSeconds, isComplete, startTimestamp]);

  const liveElapsed = liveSeconds ?? progressElapsedSeconds ?? null;
  const displaySeconds = finalDurationSeconds ?? (isComplete ? null : liveElapsed);
  if (displaySeconds == null) return null;

  const isLive = finalDurationSeconds == null;
  return (
    <span className={`text-[10px] tabular-nums shrink-0 ${isLive ? "text-cc-primary" : "text-cc-muted"}`}>
      {formatDuration(displaySeconds)}
    </span>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

const ToolMessageGroup = memo(function ToolMessageGroup({ group, sessionId }: { group: ToolMsgGroup; sessionId: string }) {
  const [open, setOpen] = useState(true);
  const iconType = getToolIcon(group.toolName);
  const label = getToolLabel(group.toolName);
  const count = group.items.length;

  // Single item — render using ToolBlock which includes result section
  if (count === 1) {
    const item = group.items[0];
    return (
      <div className="animate-[fadeSlideIn_0.2s_ease-out]">
        <div className="flex items-start gap-3">
          <PawTrailAvatar />
          <div className="flex-1 min-w-0">
            <ToolBlock name={item.name} input={item.input} toolUseId={item.id} sessionId={sessionId} />
          </div>
        </div>
      </div>
    );
  }

  // Multi-item group
  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0">
          <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
                <path d="M6 4l4 4-4 4" />
              </svg>
              <ToolIcon type={iconType} />
              <span className="text-xs font-medium text-cc-fg">{label}</span>
              <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums font-medium">
                {count}
              </span>
            </button>

            {open && (
              <div className="border-t border-cc-border px-3 py-2 flex flex-col gap-1.5">
                {group.items.map((item, i) => (
                  <ToolBlock
                    key={item.id || i}
                    name={item.name}
                    input={item.input}
                    toolUseId={item.id}
                    sessionId={sessionId}
                    hideLabel={group.toolName === "Bash"}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

function MinuteBoundaryTimestamp({ timestamp, label }: { timestamp: number; label: string }) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <div className="flex items-center justify-center py-1">
      <time
        data-testid="minute-boundary-timestamp"
        dateTime={d.toISOString()}
        title={d.toLocaleString()}
        className="text-[11px] text-cc-muted/70 font-mono-code"
      >
        {label}
      </time>
    </div>
  );
}

function getTurnBoundaryTimestamp(turn: Turn): number | null {
  const boundary = turn.userEntry;
  if (!boundary || boundary.kind !== "message") return null;
  if (!isTimedChatMessage(boundary.msg)) return null;
  return boundary.msg.timestamp;
}

function getNormalTurnDurationMs(turn: Turn): number | null {
  const boundary = turn.userEntry;
  if (!boundary || boundary.kind !== "message" || boundary.msg.role !== "user" || boundary.msg.agentSource?.sessionId === "herd-events") return null;
  const userTimestamp = boundary.msg.timestamp;
  if (!turn.responseEntry || turn.responseEntry.kind !== "message" || turn.responseEntry.msg.role !== "assistant") return null;
  const responseTimestamp = turn.responseEntry.msg.timestamp;
  if (responseTimestamp < userTimestamp) return null;
  return responseTimestamp - userTimestamp;
}

function getLeaderTurnDurationMs(turn: Turn, nextTurn: Turn | null): number | null {
  if (!nextTurn) return null;
  const currentBoundary = getTurnBoundaryTimestamp(turn);
  const nextBoundary = getTurnBoundaryTimestamp(nextTurn);
  if (currentBoundary == null || nextBoundary == null || nextBoundary < currentBoundary) return null;
  return nextBoundary - currentBoundary;
}

function getTurnSummaryDurationMs(turn: Turn, nextTurn: Turn | null, leaderMode: boolean): number | null {
  if (leaderMode) return getLeaderTurnDurationMs(turn, nextTurn);
  return getNormalTurnDurationMs(turn);
}

function TurnSummaryStats({
  stats,
  durationMs,
  separatorClass,
}: {
  stats: TurnStats;
  durationMs: number | null;
  separatorClass: string;
}) {
  const hasMessages = stats.messageCount > 0;
  const hasTools = stats.toolCount > 0;
  const hasAgents = stats.subagentCount > 0;
  const hasHerdEvents = stats.herdEventCount > 0;
  const hasDuration = durationMs !== null;

  return (
    <>
      {hasMessages && (
        <span>{stats.messageCount} message{stats.messageCount !== 1 ? "s" : ""}</span>
      )}
      {hasTools && (
        <>
          {hasMessages && <span className={separatorClass}>·</span>}
          <span>{stats.toolCount} tool{stats.toolCount !== 1 ? "s" : ""}</span>
        </>
      )}
      {hasAgents && (
        <>
          {(hasMessages || hasTools) && <span className={separatorClass}>·</span>}
          <span>{stats.subagentCount} agent{stats.subagentCount !== 1 ? "s" : ""}</span>
        </>
      )}
      {hasHerdEvents && (
        <>
          {(hasMessages || hasTools || hasAgents) && <span className={separatorClass}>·</span>}
          <span>{stats.herdEventCount} herd event{stats.herdEventCount !== 1 ? "s" : ""}</span>
        </>
      )}
      {hasDuration && (
        <>
          {(hasMessages || hasTools || hasAgents || hasHerdEvents) && <span className={separatorClass}>·</span>}
          <span data-testid="turn-summary-duration">{formatElapsed(durationMs)}</span>
        </>
      )}
    </>
  );
}

/** Check if a feed entry is an auto-approval message. */
function isApprovalEntry(entry: FeedEntry): entry is { kind: "message"; msg: ChatMessage } {
  return entry.kind === "message" && entry.msg.role === "system" && entry.msg.variant === "approved";
}

/** Collapsed group for consecutive auto-approved tool calls — shows "N tools auto-approved"
 *  with an expand toggle to see individual approval details. */
function ApprovalBatchGroup({ messages }: { messages: ChatMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const count = messages.length;
  return (
    <div className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-start gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-green-500/10 text-xs text-green-400/80 font-mono-code max-w-[85%] text-left cursor-pointer hover:bg-green-500/15 transition-colors"
      >
        <svg className="w-3 h-3 text-green-400/60 shrink-0 mt-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M5.5 8.5l2 2 3.5-4" />
        </svg>
        <div className="min-w-0">
          {expanded ? (
            <div className="space-y-0.5">
              {messages.map((msg) => (
                <div key={msg.id} className="line-clamp-1">{msg.content}</div>
              ))}
            </div>
          ) : (
            <span>{count} tool{count !== 1 ? "s" : ""} auto-approved</span>
          )}
        </div>
        <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-green-400/40 shrink-0 mt-0.5 transition-transform ${expanded ? "rotate-90" : ""}`}>
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
    </div>
  );
}

const FeedEntries = memo(function FeedEntries({
  entries,
  sessionId,
  minuteBoundaryLabels,
}: {
  entries: FeedEntry[];
  sessionId: string;
  minuteBoundaryLabels?: Map<string, string>;
}) {
  // Pre-compute batched rendering: merge consecutive approval messages into
  // single ApprovalBatchGroup components to reduce visual noise.
  const rendered = useMemo(() => {
    const result: React.ReactNode[] = [];
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      // Batch consecutive approval entries (2+ become a group)
      if (isApprovalEntry(entry)) {
        const batch: ChatMessage[] = [entry.msg];
        let j = i + 1;
        while (j < entries.length && isApprovalEntry(entries[j])) {
          batch.push((entries[j] as { kind: "message"; msg: ChatMessage }).msg);
          j++;
        }
        if (batch.length >= 2) {
          result.push(<ApprovalBatchGroup key={batch[0].id} messages={batch} />);
          i = j;
          continue;
        }
        // Single approval — render normally (fall through below)
      }
      if (entry.kind === "tool_msg_group") {
        result.push(<ToolMessageGroup key={entry.firstId || i} group={entry} sessionId={sessionId} />);
      } else if (entry.kind === "subagent") {
        result.push(<SubagentContainer key={entry.taskToolUseId} group={entry} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />);
      } else if (entry.kind === "subagent_batch") {
        result.push(<SubagentBatchContainer key={entry.subagents[0]?.taskToolUseId || i} batch={entry} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />);
      } else if (isTimedChatMessage(entry.msg)) {
        const markerLabel = minuteBoundaryLabels?.get(entry.msg.id);
        const showTimestamp = entry.msg.role === "assistant" && typeof entry.msg.turnDurationMs === "number";
        result.push(
          <div key={entry.msg.id} data-message-id={entry.msg.id}>
            {markerLabel && <MinuteBoundaryTimestamp timestamp={entry.msg.timestamp} label={markerLabel} />}
            <MessageBubble message={entry.msg} sessionId={sessionId} showTimestamp={showTimestamp} />
          </div>
        );
      } else {
        result.push(<div key={entry.msg.id} data-message-id={entry.msg.id}><MessageBubble message={entry.msg} sessionId={sessionId} /></div>);
      }
      i++;
    }
    return result;
  }, [entries, sessionId, minuteBoundaryLabels]);

  return <>{rendered}</>;
});

/** Compact bar showing agent activity stats. Click to expand the full activity. */
const CollapsedActivityBar = memo(function CollapsedActivityBar({
  stats,
  durationMs,
  onClick,
}: {
  stats: TurnStats;
  durationMs: number | null;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-1.5 py-1.5 px-3 border-l-2 border-cc-border/40 bg-cc-hover/10 hover:bg-cc-hover/30 transition-colors cursor-pointer text-[11px] text-cc-muted font-mono-code"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/60">
        <path d="M6 4l4 4-4 4" />
      </svg>
      <TurnSummaryStats stats={stats} durationMs={durationMs} separatorClass="text-cc-muted/40" />
    </button>
  );
});

/** Thin clickable bar to collapse an expanded turn's agent activity */
function TurnCollapseBar({
  stats,
  durationMs,
  onClick,
  ref,
}: {
  stats: TurnStats;
  durationMs: number | null;
  onClick: () => void;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      className="w-full flex items-center gap-1.5 py-1 px-2 -mb-1 rounded hover:bg-cc-hover/40 transition-colors cursor-pointer text-[11px] text-cc-muted/50 hover:text-cc-muted font-mono-code"
      title="Collapse this turn"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 transition-transform rotate-90">
        <path d="M6 4l4 4-4 4" />
      </svg>
      <TurnSummaryStats stats={stats} durationMs={durationMs} separatorClass="text-cc-muted/30" />
    </button>
  );
}

const TurnEntriesExpanded = memo(function TurnEntriesExpanded({
  turn,
  sessionId,
  durationMs,
  onCollapse,
  minuteBoundaryLabels,
}: {
  turn: Turn;
  sessionId: string;
  durationMs: number | null;
  onCollapse: () => void;
  minuteBoundaryLabels: Map<string, string>;
}) {
  const headerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {/* Per-turn collapse bar (only for turns with collapsible activity) */}
      {turn.agentEntries.length > 0 && (
        <TurnCollapseBar
          ref={headerRef}
          stats={turn.stats}
          durationMs={durationMs}
          onClick={onCollapse}
        />
      )}
      {/* Render all entries interleaved in original chronological order */}
      <FeedEntries entries={turn.allEntries} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />
      {/* Bottom collapse bar — appears when top bar scrolls out of view */}
      {turn.agentEntries.length > 0 && (
        <TurnCollapseFooter headerRef={headerRef} onCollapse={onCollapse} />
      )}
    </>
  );
});


/** Extract readable text from a Task tool_result string.
 *  The CLI sends the result as JSON.stringify'd content blocks:
 *    [{"type":"text","text":"..."}, {"type":"text","text":"agentId: ..."}]
 *  We parse the JSON array and pull out just the main text, skipping
 *  metadata blocks (agentId, usage). Falls back to the raw string. */
function parseSubagentResultText(raw: string): string {
  try {
    const blocks = JSON.parse(raw);
    if (!Array.isArray(blocks)) return raw;
    const texts: string[] = [];
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") {
        // Skip metadata blocks (agentId, usage)
        if (/^agentId:|^<usage>/i.test(b.text.trim())) continue;
        texts.push(b.text);
      }
    }
    return texts.length > 0 ? texts.join("\n") : raw;
  } catch {
    return raw;
  }
}

function getCommittedCodexStreamingText(raw: string): string {
  if (!raw) return "";
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline < 0) return "";
  return raw.slice(0, lastNewline + 1);
}

const SubagentBatchContainer = memo(function SubagentBatchContainer({
  batch,
  sessionId,
  minuteBoundaryLabels,
}: {
  batch: SubagentBatch;
  sessionId: string;
  minuteBoundaryLabels?: Map<string, string>;
}) {
  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0 space-y-2">
          {batch.subagents.map((sg) => (
            <SubagentContainer key={sg.taskToolUseId} group={sg} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} inBatch />
          ))}
        </div>
      </div>
    </div>
  );
});

function SubagentSectionHeader({
  label,
  open,
  onToggle,
  extra,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  extra?: ReactNode;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
        <path d="M6 4l4 4-4 4" />
      </svg>
      <span className="text-[11px] font-medium text-cc-muted">{label}</span>
      {extra && <span className="ml-auto shrink-0">{extra}</span>}
    </button>
  );
}

const SubagentContainer = memo(function SubagentContainer({
  group,
  sessionId,
  inBatch,
  minuteBoundaryLabels,
}: {
  group: SubagentGroup;
  sessionId: string;
  inBatch?: boolean;
  minuteBoundaryLabels?: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(true);
  const [resultOpen, setResultOpen] = useState(true);
  const [bgOutput, setBgOutput] = useState<string | null>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  const previousHadStreamingRef = useRef(false);
  const label = group.description || "Subagent";
  const agentType = group.agentType;
  const childCount = group.children.length;
  const hasPrompt = !!group.taskInput?.prompt;

  // Read the subagent's final result from the toolResults store
  const resultPreview = useStore((s) => s.toolResults.get(sessionId)?.get(group.taskToolUseId));
  const rawStreamingText = useStore((s) =>
    s.streamingByParentToolUseId.get(sessionId)?.get(group.taskToolUseId) || ""
  );
  const progressElapsedSeconds = useStore((s) =>
    s.toolProgress.get(sessionId)?.get(group.taskToolUseId)?.elapsedSeconds
  );
  const startTimestamp = useStore((s) =>
    s.toolStartTimestamps.get(sessionId)?.get(group.taskToolUseId)
  );
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const streamingText = useMemo(
    () => isCodexSession ? getCommittedCodexStreamingText(rawStreamingText) : rawStreamingText,
    [isCodexSession, rawStreamingText],
  );

  // Read background agent notification
  const bgNotif = useStore((s) =>
    s.backgroundAgentNotifs.get(sessionId)?.get(group.taskToolUseId)
  );

  // Detect abandoned subagents: session is no longer running but this subagent
  // never received a result. This happens on CLI disconnect, user interrupt,
  // compaction, or SDK sessions that don't emit tool_result for Task tools.
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const isEffectivelyComplete = resultPreview != null || bgNotif != null;
  const isAbandoned = !isEffectivelyComplete && sessionStatus !== "running";

  useEffect(() => {
    const hasStreaming = rawStreamingText.length > 0;
    if (hasStreaming && !previousHadStreamingRef.current) {
      setOpen(true);
      setActivitiesOpen(true);
    }
    previousHadStreamingRef.current = hasStreaming;
  }, [rawStreamingText]);

  // Get the last visible entry for a compact preview (fallback when no result)
  const lastEntry = group.children[group.children.length - 1];
  const lastPreview = useMemo(() => {
    if (!lastEntry) return "";
    if (lastEntry.kind === "tool_msg_group") {
      return `${getToolLabel(lastEntry.toolName)}${lastEntry.items.length > 1 ? ` ×${lastEntry.items.length}` : ""}`;
    }
    if (lastEntry.kind === "message" && lastEntry.msg.role === "assistant") {
      const text = lastEntry.msg.content?.trim();
      if (text) return text.length > 60 ? text.slice(0, 60) + "..." : text;
      const toolBlock = lastEntry.msg.contentBlocks?.find(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
      );
      if (toolBlock) return getToolLabel(toolBlock.name);
    }
    return "";
  }, [lastEntry]);

  // Parse result text from JSON content blocks
  const parsedResultPreview = useMemo(() => {
    if (!resultPreview?.content) return null;
    return parseSubagentResultText(resultPreview.content);
  }, [resultPreview]);

  // When collapsed, prefer showing parsed result over lastPreview
  const collapsedPreview = useMemo(() => {
    if (parsedResultPreview) {
      const text = parsedResultPreview.trim();
      return text.length > 120 ? text.slice(0, 120) + "..." : text;
    }
    if (streamingText) {
      const text = streamingText.trim();
      return text.length > 120 ? text.slice(0, 120) + "..." : text;
    }
    return lastPreview;
  }, [parsedResultPreview, streamingText, lastPreview]);

  const card = (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      {/* Header */}
      <button
        ref={headerRef}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type="agent" />
        <span className="text-xs font-medium text-cc-fg truncate">{label}</span>
        {agentType && (
          <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">
            {agentType}
          </span>
        )}
        {!open && collapsedPreview && (
          <span className="text-[11px] text-cc-muted truncate ml-1 font-mono-code">
            {collapsedPreview}
          </span>
        )}
        <LiveDurationBadge
          finalDurationSeconds={resultPreview?.duration_seconds}
          progressElapsedSeconds={progressElapsedSeconds}
          startTimestamp={startTimestamp}
          isComplete={isEffectivelyComplete || isAbandoned}
        />
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
          {childCount > 0
            ? childCount
            : resultPreview
              ? "✓"
              : isAbandoned
                ? "—"
                : group.isBackground
                  ? "bg"
                  : "0"}
        </span>
      </button>

      {/* Expanded content */}
      {open && (
        <div className="border-t border-cc-border">
          {/* Collapsible prompt section */}
          {hasPrompt && (
            <div className="border-b border-cc-border/50">
              <SubagentSectionHeader label="Prompt" open={promptOpen} onToggle={() => setPromptOpen(!promptOpen)} />
              {promptOpen && (
                <div className="px-3 pb-2">
                  <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                    {String(group.taskInput!.prompt)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Child activities */}
          {(childCount > 0 || rawStreamingText) && (
            <div className="border-b border-cc-border/50">
              <SubagentSectionHeader label="Activities" open={activitiesOpen} onToggle={() => setActivitiesOpen(!activitiesOpen)} />
              {activitiesOpen && (
                <div className="px-3 pb-2 space-y-3">
                  {childCount > 0 && (
                    <FeedEntries entries={group.children} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />
                  )}
                  {rawStreamingText && (
                    <div className="rounded-[8px] border border-cc-border/50 bg-cc-hover/20 px-3 py-2">
                      {isCodexSession ? (
                        <div className="text-[13px] text-cc-fg">
                          <MarkdownContent text={streamingText} sessionId={sessionId} />
                          <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle -translate-y-[2px] animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                        </div>
                      ) : (
                        <pre className="font-serif-assistant text-[14px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                          {streamingText}
                          <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Background agent output (no streaming children, output goes to file) */}
          {group.isBackground && childCount === 0 && bgNotif && (
            <div className="border-b border-cc-border/50">
              <div className="px-3 py-2">
                <div className="text-[11px] text-cc-muted">{bgNotif.summary}</div>
                {bgNotif.outputFile && !bgOutput && (
                  <button
                    onClick={async () => {
                      const resp = await fetch(`/api/sessions/${sessionId}/agent-output?path=${encodeURIComponent(bgNotif.outputFile!)}`);
                      if (resp.ok) setBgOutput(await resp.text());
                    }}
                    className="text-[11px] text-cc-accent hover:underline mt-1 cursor-pointer"
                  >
                    View full output
                  </button>
                )}
                {bgOutput && (
                  <pre className="text-[11px] text-cc-text font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto mt-1 bg-cc-bg-code rounded p-2">
                    {bgOutput}
                  </pre>
                )}
              </div>
            </div>
          )}

          {/* No children yet indicator */}
          {childCount === 0 && !rawStreamingText && !isEffectivelyComplete && !isAbandoned && (
            <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-cc-muted">
              <YarnBallSpinner className="w-3.5 h-3.5" />
              <span>{group.isBackground ? "Running in background..." : "Agent starting..."}</span>
            </div>
          )}

          {/* Abandoned subagent — session ended without this subagent completing */}
          {childCount === 0 && isAbandoned && (
            <div className="px-3 py-2 text-[11px] text-cc-muted">
              Agent interrupted
            </div>
          )}

          {/* Result */}
          {resultPreview && (
            <div className="border-t border-cc-border/50">
              <SubagentSectionHeader label="Result" open={resultOpen} onToggle={() => setResultOpen(!resultOpen)} />
              {resultOpen && (
                <SubagentResult
                  preview={resultPreview}
                  parsedText={parsedResultPreview}
                  sessionId={sessionId}
                  toolUseId={group.taskToolUseId}
                />
              )}
            </div>
          )}

          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );

  if (inBatch) {
    return card;
  }

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0">
          {card}
        </div>
      </div>
    </div>
  );
});

function SubagentResult({ preview, parsedText, sessionId, toolUseId }: {
  preview: { content: string; is_truncated: boolean };
  parsedText: string | null;
  sessionId: string;
  toolUseId: string;
}) {
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Auto-fetch full content when truncated — subagent results are usually short
  // and truncated previews render poorly (broken JSON/markdown)
  useEffect(() => {
    if (preview.is_truncated && !fullContent && !loading) {
      setLoading(true);
      api.getToolResult(sessionId, toolUseId)
        .then((result) => setFullContent(result.content))
        .catch(() => setFullContent("[Failed to load full result]"))
        .finally(() => setLoading(false));
    }
  }, [preview.is_truncated, fullContent, loading, sessionId, toolUseId]);

  const displayText = fullContent
    ? parseSubagentResultText(fullContent)
    : (parsedText ?? preview.content);

  return (
    <div className="px-3 pb-2">
      {loading && (
        <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-cc-muted">
          <svg className="w-3 h-3 animate-spin text-cc-muted" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Loading full result...</span>
        </div>
      )}
      <div className="text-sm max-h-96 overflow-y-auto">
        <MarkdownContent text={displayText} sessionId={sessionId} />
      </div>
    </div>
  );
}


// ─── Self-subscribing footer (isolates rapid store updates from the feed) ────

const FeedFooter = memo(function FeedFooter({ sessionId }: { sessionId: string }) {
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const rawStreamingText = useStore((s) => s.streaming.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const streamingText = useMemo(
    () => isCodexSession ? getCommittedCodexStreamingText(rawStreamingText || "") : (rawStreamingText || ""),
    [isCodexSession, rawStreamingText],
  );

  return (
    <>
      {/* Compaction indicator — shown prominently in the feed when agent is compacting context */}
      {sessionStatus === "compacting" && !rawStreamingText && (
        <div className="flex items-center gap-2 text-[12px] text-cc-muted font-mono-code pl-9 py-1 animate-[fadeSlideIn_0.2s_ease-out]">
          <YarnBallDot className="text-cc-primary animate-pulse" />
          <span>Compacting conversation...</span>
        </div>
      )}

      {/* Tool progress indicator — skip Task tools since SubagentContainers show their own progress */}
      {toolProgress && toolProgress.size > 0 && !rawStreamingText && !isCodexSession && (() => {
        const nonTaskProgress = Array.from(toolProgress.values()).filter((p) => !isSubagentToolName(p.toolName));
        if (nonTaskProgress.length === 0) return null;
        return (
          <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
            <YarnBallDot className="text-cc-primary animate-pulse" />
            {nonTaskProgress.map((p, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-cc-muted/40">·</span>}
                <span>{getToolLabel(p.toolName)}</span>
                <span className="text-cc-muted/60">{p.elapsedSeconds}s</span>
              </span>
            ))}
          </div>
        );
      })()}

      {/* Streaming indicator */}
      {rawStreamingText && (
        <div
          className="animate-[fadeSlideIn_0.2s_ease-out]"
          data-feed-streaming-message="true"
        >
          <div className="flex items-start gap-3">
            <PawTrailAvatar isStreaming />
            <div className="flex-1 min-w-0">
              {isCodexSession ? (
                <div>
                  <MarkdownContent text={streamingText} sessionId={sessionId} />
                  <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle -translate-y-[2px] animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                </div>
              ) : (
                <pre className="font-serif-assistant text-[15px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                  {streamingText}
                  <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

    </>
  );
});

// ─── Turn list (owns collapse state so MessageFeed doesn't re-render on toggle) ─

const TurnEntries = memo(function TurnEntries({ turns, sessionId, leaderMode }: { turns: Turn[]; sessionId: string; leaderMode: boolean }) {
  const { turnStates, toggleTurn } = useCollapsePolicy({ sessionId, turns, leaderMode });
  const minuteBoundaryLabels = useMemo(() => {
    const visibleTimedMessages: ChatMessage[] = [];

    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index];
      const isActivityExpanded = turnStates[index]?.isActivityExpanded ?? false;

      if (turn.userEntry?.kind === "message" && isTimedChatMessage(turn.userEntry.msg)) {
        visibleTimedMessages.push(turn.userEntry.msg);
      }

      if (isActivityExpanded) {
        appendTimedMessagesFromEntries(turn.allEntries, visibleTimedMessages);
      } else {
        appendTimedMessagesFromEntries(turn.systemEntries, visibleTimedMessages);
        for (const pe of turn.promotedEntries) {
          if (pe.kind === "message" && isTimedChatMessage(pe.msg)) {
            visibleTimedMessages.push(pe.msg);
          }
        }
        if (turn.responseEntry?.kind === "message" && isTimedChatMessage(turn.responseEntry.msg)) {
          visibleTimedMessages.push(turn.responseEntry.msg);
        }
      }
    }

    return buildMinuteBoundaryLabelMap(visibleTimedMessages);
  }, [turns, turnStates]);

  return (
    <>
      {turns.map((turn, index) => {
        const isActivityExpanded = turnStates[index]?.isActivityExpanded ?? false;
        const turnSummaryDuration = getTurnSummaryDurationMs(turn, turns[index + 1] ?? null, leaderMode);

        return (
          <div key={turn.id}>
            <div
              data-turn-id={turn.id}
              className="turn-container space-y-3 sm:space-y-5"
              data-user-turn={isUserBoundaryEntry(turn.userEntry) ? "true" : undefined}
            >
              {/* User message — always visible */}
              {turn.userEntry && (
                <FeedEntries entries={[turn.userEntry]} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />
              )}

              {isActivityExpanded ? (
                /* Expanded: show all entries with collapse affordance */
                turn.allEntries.length > 0 && (
                  <TurnEntriesExpanded
                    turn={turn}
                    sessionId={sessionId}
                    durationMs={turnSummaryDuration}
                    minuteBoundaryLabels={minuteBoundaryLabels}
                    onCollapse={() => toggleTurn(turn.id)}
                  />
                )
              ) : (
                <>
                  {/* System messages — always visible */}
                  {turn.systemEntries.length > 0 && (
                    <FeedEntries entries={turn.systemEntries} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />
                  )}
                  {/* Collapsed: single paw outside, activity bar + promoted entries + response in shared card */}
                  {(turn.agentEntries.length > 0 || turn.promotedEntries.length > 0 || turn.responseEntry) && (
                    <div className="flex items-start gap-3">
                      <PawTrailAvatar />
                      <div className="flex-1 min-w-0 rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
                        {turn.agentEntries.length > 0 && (
                          <CollapsedActivityBar
                            stats={turn.stats}
                            durationMs={turnSummaryDuration}
                            onClick={() => toggleTurn(turn.id)}
                          />
                        )}
                        {(turn.promotedEntries.length > 0 || turn.responseEntry) && (
                          <div className="px-3 py-2.5">
                            <HidePawContext.Provider value={true}>
                              <FeedEntries entries={[...turn.promotedEntries, ...(turn.responseEntry ? [turn.responseEntry] : [])]} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />
                            </HidePawContext.Provider>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
});


// ─── Main Feed ───────────────────────────────────────────────────────────────

export function MessageFeed({ sessionId }: { sessionId: string }) {
  const messages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const streamingText = useStore((s) => s.streaming.get(sessionId));
  const isLeaderSession = useStore((s) => s.sdkSessions.some((session) => session.sessionId === sessionId && session.isOrchestrator === true));
  const pawCounter = useRef<import("./PawTrail.js").PawCounterState>({ next: 0, cache: new Map() });
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Initialize isNearBottom from saved scroll position — if the user was scrolled
  // up when they left this session, don't auto-scroll to bottom on re-mount.
  const savedScrollPos = useStore.getState().feedScrollPosition.get(sessionId);
  const isNearBottom = useRef(savedScrollPos ? savedScrollPos.isAtBottom : true);
  const didMountRef = useRef(false);
  const lastSentUserMessageIdRef = useRef<string | null>(null);
  const stableAllowedBottomRef = useRef<number | null>(null);
  const [bottomRunwayHeight, setBottomRunwayHeight] = useState(
    0,
  );
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isTouch = useMemo(() => isTouchDevice(), []);
  const loadingMore = useRef(false);
  const visibleCount = useStore((s) => s.feedVisibleCount.get(sessionId) ?? FEED_PAGE_SIZE);
  const restoredSessionIdRef = useRef<string | null>(null);
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));

  const findVisibleTurnAnchor = useCallback((container: HTMLDivElement) => {
    const containerRect = container.getBoundingClientRect();
    const turns = container.querySelectorAll<HTMLElement>("[data-turn-id]");
    for (const turn of turns) {
      const rect = turn.getBoundingClientRect();
      if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
        return {
          turnId: turn.dataset.turnId ?? null,
          offsetTop: rect.top - containerRect.top,
        };
      }
    }
    return null;
  }, []);

  // Save scroll position on unmount. Uses useLayoutEffect so the cleanup runs
  // in the layout phase — BEFORE the new component's effects try to restore,
  // avoiding the race where useEffect cleanup runs too late.
  useLayoutEffect(() => {
    return () => {
      const el = containerRef.current;
      if (el) {
        const anchor = findVisibleTurnAnchor(el);
        useStore.getState().setFeedScrollPosition(sessionId, {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          isAtBottom: isNearBottom.current,
          anchorTurnId: anchor?.turnId ?? null,
          anchorOffsetTop: anchor?.offsetTop,
        });
      }
    };
  }, [findVisibleTurnAnchor, sessionId]);

  const { turns } = useFeedModel(messages, { leaderMode: isLeaderSession });

  const totalTurns = turns.length;
  const hasMore = totalTurns > visibleCount;
  const visibleTurns = hasMore ? turns.slice(totalTurns - visibleCount) : turns;
  const isTopLevelStreaming = Boolean(streamingText);
  const newestMessage = messages[messages.length - 1];
  const lastUserTurnId = [...visibleTurns]
    .reverse()
    .find((turn) => isUserBoundaryEntry(turn.userEntry))?.id ?? null;
  // Collapsible turn IDs: all turns with agent content are collapsible (including the last).
  // Stats and text preview recompute as new messages stream in.
  const collapsibleTurnIds = useMemo(() =>
    visibleTurns
      .filter((t) => t.agentEntries.length > 0)
      .map((t) => t.id),
    [visibleTurns],
  );

  // Sync collapsible turn IDs to the store so the Composer can render the global toggle
  useEffect(() => {
    useStore.getState().setCollapsibleTurnIds(sessionId, collapsibleTurnIds);
  }, [sessionId, collapsibleTurnIds]);

  // ─── Scroll management ─────────────────────────────────────────────────

  const updateBottomRunwayHeight = useCallback(() => {
    const el = containerRef.current;
    if (!el || !lastUserTurnId) {
      stableAllowedBottomRef.current = null;
      setBottomRunwayHeight((prev) => (prev === 0 ? prev : 0));
      return;
    }
    const viewportHeight = Math.max(
      0,
      Math.round(
        el.clientHeight ||
        el.getBoundingClientRect().height ||
        (typeof window === "undefined" ? 0 : window.innerHeight),
      ),
    );
    const lastRenderableMessage = el.querySelector<HTMLElement>(`[data-turn-id="${escapeSelectorValue(lastUserTurnId)}"]`);
    const bottomMarker = bottomRef.current;
    if (!lastRenderableMessage || !bottomMarker || viewportHeight === 0) {
      stableAllowedBottomRef.current = null;
      setBottomRunwayHeight((prev) => (prev === 0 ? prev : 0));
      return;
    }
    const messageRect = lastRenderableMessage.getBoundingClientRect();
    const containerRect = el.getBoundingClientRect();
    const bottomRect = bottomMarker.getBoundingClientRect();
    const contentSinceLastMessage = Math.max(0, bottomRect.bottom - messageRect.top);
    const desiredRunway = Math.max(0, Math.round(viewportHeight - contentSinceLastMessage));
    const stableAllowedBottom = Math.max(
      0,
      Math.round(messageRect.top - containerRect.top + el.scrollTop),
    );
    const realContentBottom = Math.max(0, Math.round(bottomRect.bottom - containerRect.top + el.scrollTop));
    const preserveVisibleRunway = Math.max(
      0,
      Math.round(el.scrollTop + viewportHeight - realContentBottom),
    );
    stableAllowedBottomRef.current = stableAllowedBottom;
    const nextHeight = Math.max(desiredRunway, preserveVisibleRunway);
    setBottomRunwayHeight((prev) => (prev === nextHeight ? prev : nextHeight));
  }, [lastUserTurnId]);

  const isNearContentBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  }, []);

  const scrollToContentBottom = useCallback((behavior: ScrollBehavior) => {
    const bottomMarker = bottomRef.current;
    if (bottomMarker) {
      bottomMarker.scrollIntoView({ behavior, block: "end" });
    }
    isNearBottom.current = true;
    setShowScrollButton(false);
  }, []);

  const scrollToAllowedBottom = useCallback((behavior: ScrollBehavior) => {
    const container = containerRef.current;
    if (container) {
      const stableTargetTop = stableAllowedBottomRef.current;
      const maxScrollableTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const targetTop = Math.min(
        stableTargetTop == null ? maxScrollableTop : Math.max(0, stableTargetTop),
        maxScrollableTop,
      );
      container.scrollTo({ top: targetTop, behavior });
      isNearBottom.current = true;
      setShowScrollButton(false);
      return;
    }
    scrollToContentBottom(behavior);
  }, [scrollToContentBottom]);

  const restoreTurnAnchor = useCallback((anchorTurnId: string, anchorOffsetTop = 0) => {
    const container = containerRef.current;
    if (!container) return false;
    const target = container.querySelector<HTMLElement>(`[data-turn-id="${escapeSelectorValue(anchorTurnId)}"]`);
    if (!target) return false;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    container.scrollTop += targetRect.top - containerRect.top - anchorOffsetTop;
    return true;
  }, []);

  const handleLoadMore = useCallback(() => {
    if (loadingMore.current) return;
    loadingMore.current = true;
    const el = containerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const current = useStore.getState().feedVisibleCount.get(sessionId) ?? FEED_PAGE_SIZE;
    useStore.getState().setFeedVisibleCount(sessionId, current + FEED_PAGE_SIZE);
    // Preserve scroll position after DOM updates
    requestAnimationFrame(() => {
      if (el) {
        const newHeight = el.scrollHeight;
        el.scrollTop += newHeight - prevHeight;
      }
      loadingMore.current = false;
    });
  }, [sessionId]);

  // Auto-load older messages when scrolling near the top
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = containerRef.current;
    if (!sentinel || !container || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          handleLoadMore();
        }
      },
      { root: container, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, handleLoadMore]);

  useLayoutEffect(() => {
    updateBottomRunwayHeight();
  }, [messages, updateBottomRunwayHeight]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("resize", updateBottomRunwayHeight);
    return () => window.removeEventListener("resize", updateBottomRunwayHeight);
  }, [updateBottomRunwayHeight]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = isNearContentBottom();
    isNearBottom.current = nearBottom;
    // Only trigger a re-render when the button state actually changes
    const shouldShow = !nearBottom;
    setShowScrollButton((prev) => (prev === shouldShow ? prev : shouldShow));
    // Track active scrolling for mobile FAB auto-hide
    setIsScrolling(true);
    clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => setIsScrolling(false), 1500);
  }

  // Restore scroll position synchronously before the first paint.
  // useLayoutEffect runs before the browser paints, preventing the flash
  // where the feed appears at scrollTop=0 for one frame before jumping.
  useLayoutEffect(() => {
    if (restoredSessionIdRef.current === sessionId) return;
    const pos = useStore.getState().feedScrollPosition.get(sessionId);
    if (messages.length === 0 && (pos?.anchorTurnId || !streamingText)) return;
    const shouldPreferAnchorRestore = Boolean(
      pos?.anchorTurnId && (isTopLevelStreaming || !pos.isAtBottom),
    );
    if (pos && shouldPreferAnchorRestore) {
      if (restoreTurnAnchor(pos.anchorTurnId!, pos.anchorOffsetTop ?? 0)) {
        isNearBottom.current = false;
        setShowScrollButton(true);
      } else {
        scrollToAllowedBottom("auto");
      }
    } else if (pos && !pos.isAtBottom) {
      const el = containerRef.current;
      if (el) {
        if (el.scrollHeight === pos.scrollHeight) {
          el.scrollTop = pos.scrollTop;
        } else if (pos.scrollHeight > 0) {
          el.scrollTop = pos.scrollTop * (el.scrollHeight / pos.scrollHeight);
        }
        isNearBottom.current = false;
        setShowScrollButton(true);
      }
    } else {
      scrollToAllowedBottom("auto");
    }
    restoredSessionIdRef.current = sessionId;
  }, [isTopLevelStreaming, messages.length, restoreTurnAnchor, scrollToAllowedBottom, sessionId, streamingText]);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      lastSentUserMessageIdRef.current = newestMessage?.role === "user"
        ? newestMessage?.id
        : null;
      return;
    }
    if (newestMessage?.role !== "user") return;
    if (newestMessage.id === lastSentUserMessageIdRef.current) return;
    lastSentUserMessageIdRef.current = newestMessage.id;
    requestAnimationFrame(() => {
      scrollToAllowedBottom("smooth");
    });
  }, [messages, scrollToAllowedBottom]);

  const scrollToBottom = useCallback(() => {
    scrollToAllowedBottom("smooth");
  }, [scrollToAllowedBottom]);

  // Scroll-to-turn: triggered from the Session Tasks panel
  const scrollToTurnId = useStore((s) => s.scrollToTurnId.get(sessionId));
  const clearScrollToTurn = useStore((s) => s.clearScrollToTurn);
  useEffect(() => {
    if (!scrollToTurnId) return;
    clearScrollToTurn(sessionId);
    const el = containerRef.current;
    if (!el) return;
    // Expand the target turn's activity if needed.
    const overrides = useStore.getState().turnActivityOverrides.get(sessionId);
    const isExpanded = overrides?.get(scrollToTurnId);
    if (isExpanded !== true) {
      useStore.getState().keepTurnExpanded(sessionId, scrollToTurnId);
    }
    // Use requestAnimationFrame so uncollapse DOM update settles first
    requestAnimationFrame(() => {
      const target = el.querySelector(`[data-turn-id="${CSS.escape(scrollToTurnId)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, [scrollToTurnId, sessionId, clearScrollToTurn]);

  // Scroll-to-message: triggered from QuestmasterPage version history clicks.
  // Finds the turn containing the target message, focuses it (expand target,
  // collapse all others except last), and scrolls to the specific message element.
  const scrollToMessageId = useStore((s) => s.scrollToMessageId.get(sessionId));
  const clearScrollToMessage = useStore((s) => s.clearScrollToMessage);
  useEffect(() => {
    if (!scrollToMessageId) return;
    clearScrollToMessage(sessionId);
    const el = containerRef.current;
    if (!el) return;

    // Find which turn contains this message
    const targetTurn = turns.find((t) =>
      t.allEntries.some((e) => e.kind === "message" && e.msg.id === scrollToMessageId) ||
      (t.userEntry?.kind === "message" && t.userEntry.msg.id === scrollToMessageId)
    );
    if (!targetTurn) return;

    // Focus: expand target turn, all others revert to defaults (last expanded, rest collapsed)
    useStore.getState().focusTurn(sessionId, targetTurn.id);

    // Wait for DOM to settle, then scroll to the specific message
    requestAnimationFrame(() => {
      const target = el.querySelector(`[data-message-id="${escapeSelectorValue(scrollToMessageId)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }, [scrollToMessageId, sessionId, clearScrollToMessage, turns]);

  // Track which task outline chip should be highlighted based on scroll position.
  // The reference line is near the container top (with a small offset to avoid
  // edge-triggering). The last task-trigger turn whose top has scrolled past
  // this line is the active task — matching the chip-click behavior which
  // scrolls the trigger to the top of the viewport.
  // Uses a scroll listener instead of IntersectionObserver so the callback
  // fires on every scroll frame, not just on intersection threshold crossings.
  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const setActiveTaskTurnId = useStore((s) => s.setActiveTaskTurnId);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !taskHistory || taskHistory.length === 0) return;

    const triggerIds = new Set(taskHistory.map((t) => t.triggerMessageId));

    let rafId = 0;
    const recalc = () => {
      const targets = el.querySelectorAll<HTMLElement>("[data-turn-id]");
      let activeTurnId: string | null = null;
      const containerRect = el.getBoundingClientRect();
      const refLine = containerRect.top + 48;
      for (const target of targets) {
        if (!triggerIds.has(target.dataset.turnId!)) continue;
        const rect = target.getBoundingClientRect();
        if (rect.top <= refLine) {
          activeTurnId = target.dataset.turnId!;
        }
      }
      if (!activeTurnId) {
        const first = taskHistory[0];
        if (first) activeTurnId = first.triggerMessageId;
      }
      setActiveTaskTurnId(sessionId, activeTurnId);
    };

    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(recalc);
    };

    recalc();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafId);
    };
  }, [taskHistory, sessionId, setActiveTaskTurnId, visibleTurns]);

  // ─── Render ──────────────────────────────────────────────────────────────

  if (messages.length === 0 && !streamingText) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 select-none px-6">
        <SleepingCat className="w-20 h-14" />
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">Start a conversation</p>
          <p className="text-xs text-cc-muted leading-relaxed">
            Send a message to begin working with The Companion.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-3 sm:px-4 py-4 sm:py-6"
        style={{ overscrollBehavior: 'contain' }}
      >
        <PawScrollProvider scrollRef={containerRef}>
        <PawCounterContext.Provider value={pawCounter}>
        <div className="max-w-3xl mx-auto space-y-3 sm:space-y-5">
          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center pb-2">
              <span className="flex items-center gap-1.5 text-xs text-cc-muted">
                <YarnBallSpinner className="h-3 w-3 text-cc-muted" />
                Loading older messages...
              </span>
            </div>
          )}
          <TurnEntries turns={visibleTurns} sessionId={sessionId} leaderMode={isLeaderSession} />
          <FeedFooter sessionId={sessionId} />
          <div ref={bottomRef} />
          <div
            aria-hidden="true"
            data-testid="feed-bottom-runway"
            style={{ height: `${bottomRunwayHeight}px` }}
          />
        </div>
        </PawCounterContext.Provider>
        </PawScrollProvider>
      </div>

      {/* Navigation FABs — desktop: top, prev/next, bottom; mobile: top/bottom only, auto-hide */}
      {showScrollButton && (
        <div className={`absolute bottom-3 right-3 z-10 flex flex-col transition-opacity duration-300 ${
          isTouch
            ? `gap-1.5 ${isScrolling ? "opacity-60" : "opacity-0 pointer-events-none"}`
            : "gap-4"
        }`}>
          {/* Go to top */}
          <button
            onClick={() => containerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
            className="w-8 h-8 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer"
            title="Go to top"
            aria-label="Go to top"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
              <path d="M4 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 12h8" strokeLinecap="round" />
            </svg>
          </button>
          {/* Prev/next user message — desktop only */}
          {!isTouch && (
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => {
                  const el = containerRef.current;
                  if (!el) return;
                  const containerRect = el.getBoundingClientRect();
                  const turns = el.querySelectorAll("[data-user-turn]");
                  for (let i = turns.length - 1; i >= 0; i--) {
                    const t = turns[i] as HTMLElement;
                    const tTop = t.getBoundingClientRect().top - containerRect.top;
                    if (tTop < -5) {
                      t.scrollIntoView({ block: "start", behavior: "smooth" });
                      return;
                    }
                  }
                }}
                className="w-8 h-8 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer"
                title="Previous user message"
                aria-label="Previous user message"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <path d="M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M8 3v10" strokeLinecap="round" />
                </svg>
              </button>
              <button
                onClick={() => {
                  const el = containerRef.current;
                  if (!el) return;
                  const containerRect = el.getBoundingClientRect();
                  const turns = el.querySelectorAll("[data-user-turn]");
                  for (let i = 0; i < turns.length; i++) {
                    const t = turns[i] as HTMLElement;
                    const tTop = t.getBoundingClientRect().top - containerRect.top;
                    if (tTop > el.clientHeight * 0.3) {
                      t.scrollIntoView({ block: "start", behavior: "smooth" });
                      return;
                    }
                  }
                  scrollToBottom();
                }}
                className="w-8 h-8 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer"
                title="Next user message"
                aria-label="Next user message"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <path d="M4 9l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M8 3v10" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
          {/* Go to bottom */}
          <button
            onClick={scrollToBottom}
            className="w-8 h-8 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer"
            title="Go to bottom"
            aria-label="Go to bottom"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
              <path d="M4 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 4h8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
