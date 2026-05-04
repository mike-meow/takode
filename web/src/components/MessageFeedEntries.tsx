import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { ChatMessage, ContentBlock, ThreadAttachmentMarker, ThreadTransitionMarker } from "../types.js";
import { isSubagentToolName } from "../types.js";
import {
  isUserBoundaryEntry,
  type FeedEntry,
  type SubagentBatch,
  type SubagentGroup,
  type ToolMsgGroup,
  type Turn,
  type TurnStats,
} from "../hooks/use-feed-model.js";
import { CodexThinkingInline, HerdEventMessage, MessageBubble, isEmptyAssistantMessage } from "./MessageBubble.js";
import { EVENT_HEADER_RE, HERD_CHIP_BASE, HERD_CHIP_INTERACTIVE } from "../utils/herd-event-parser.js";
import { ToolBlock, getToolIcon, getToolLabel, ToolIcon } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CollapseFooter, TurnCollapseFooter } from "./CollapseFooter.js";
import { LiveCodexTerminalStub, LiveDurationBadge } from "./MessageFeedLiveActivity.js";
import {
  appendTimedMessagesFromEntries,
  buildMinuteBoundaryLabelMap,
  formatElapsed,
  getApprovalBatchFeedBlockId,
  getFooterFeedBlockId,
  getMessageFeedBlockId,
  getSubagentFeedBlockId,
  getToolGroupFeedBlockId,
  getTurnFeedBlockId,
  isTimedChatMessage,
} from "./message-feed-utils.js";
import { findPreviousSectionStartIndex, type FeedSection } from "./message-feed-sections.js";
import { YarnBallDot, YarnBallSpinner } from "./CatIcons.js";
import { PawTrailAvatar, HidePawContext } from "./PawTrail.js";
import {
  formatThreadAttachmentMarkerDetail,
  isCrossThreadActivityMarkerMessage,
  isThreadAttachmentMarkerMessage,
  isThreadTransitionMarkerMessage,
} from "../utils/thread-projection.js";
import { AttentionLedgerRow } from "./AttentionLedgerRow.js";
import { isAttentionLedgerMessage } from "../utils/attention-records.js";

function useExpandForScrollTarget(
  sessionId: string,
  containedMessageIds: string[],
  setOpen: (v: boolean) => void,
): void {
  const expandTargetId = useStore((s) => s.expandAllInTurn.get(sessionId));
  useEffect(() => {
    if (expandTargetId && containedMessageIds.includes(expandTargetId)) {
      setOpen(true);
    }
  }, [expandTargetId, containedMessageIds, setOpen]);
}

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
  if (
    !boundary ||
    boundary.kind !== "message" ||
    boundary.msg.role !== "user" ||
    boundary.msg.agentSource?.sessionId === "herd-events"
  )
    return null;
  const userTimestamp = boundary.msg.timestamp;
  if (!turn.responseEntry || turn.responseEntry.kind !== "message" || turn.responseEntry.msg.role !== "assistant")
    return null;
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

export { findPreviousSectionStartIndex };

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
        <span>
          {stats.messageCount} message{stats.messageCount !== 1 ? "s" : ""}
        </span>
      )}
      {hasTools && (
        <>
          {hasMessages && <span className={separatorClass}>·</span>}
          <span>
            {stats.toolCount} tool{stats.toolCount !== 1 ? "s" : ""}
          </span>
        </>
      )}
      {hasAgents && (
        <>
          {(hasMessages || hasTools) && <span className={separatorClass}>·</span>}
          <span>
            {stats.subagentCount} agent{stats.subagentCount !== 1 ? "s" : ""}
          </span>
        </>
      )}
      {hasHerdEvents && (
        <>
          {(hasMessages || hasTools || hasAgents) && <span className={separatorClass}>·</span>}
          <span>
            {stats.herdEventCount} herd event{stats.herdEventCount !== 1 ? "s" : ""}
          </span>
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

function hasTurnSummaryStats(stats: TurnStats, durationMs: number | null): boolean {
  return (
    stats.messageCount > 0 ||
    stats.toolCount > 0 ||
    stats.subagentCount > 0 ||
    stats.herdEventCount > 0 ||
    durationMs !== null
  );
}

function isApprovalEntry(entry: FeedEntry): entry is { kind: "message"; msg: ChatMessage } {
  return entry.kind === "message" && entry.msg.role === "system" && entry.msg.variant === "approved";
}

function ApprovalBatchGroup({ messages, sessionId }: { messages: ChatMessage[]; sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const count = messages.length;
  const messageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  useExpandForScrollTarget(sessionId, messageIds, setExpanded);
  return (
    <div
      className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]"
      data-feed-block-id={getApprovalBatchFeedBlockId(messages[0]?.id ?? `count:${count}`)}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-start gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-green-500/10 text-xs text-green-400/80 font-mono-code max-w-[85%] text-left cursor-pointer hover:bg-green-500/15 transition-colors"
      >
        <svg
          className="w-3 h-3 text-green-400/60 shrink-0 mt-0.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path d="M5.5 8.5l2 2 3.5-4" />
        </svg>
        <div className="min-w-0">
          {expanded ? (
            <div className="space-y-0.5">
              {messages.map((msg) => (
                <div key={msg.id} className="line-clamp-1">
                  {msg.content}
                </div>
              ))}
            </div>
          ) : (
            <span>
              {count} tool{count !== 1 ? "s" : ""} auto-approved
            </span>
          )}
        </div>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-green-400/40 shrink-0 mt-0.5 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
    </div>
  );
}

function getHerdBatchFeedBlockId(messageId: string): string {
  return `herd-batch:${messageId}`;
}

function isHerdEventEntry(entry: FeedEntry): entry is { kind: "message"; msg: ChatMessage } {
  return entry.kind === "message" && entry.msg.role === "user" && entry.msg.agentSource?.sessionId === "herd-events";
}

function isThreadSystemMarkerMessage(message: ChatMessage): boolean {
  return (
    isThreadAttachmentMarkerMessage(message) ||
    isThreadTransitionMarkerMessage(message) ||
    isCrossThreadActivityMarkerMessage(message)
  );
}

function formatHerdBatchTimeRange(messages: ChatMessage[]): string {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const fmt = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  const firstLabel = fmt(first.timestamp);
  const lastLabel = fmt(last.timestamp);
  return firstLabel === lastLabel ? firstLabel : `${firstLabel} – ${lastLabel}`;
}

function HerdEventBatchGroup({ messages, sessionId }: { messages: ChatMessage[]; sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const count = messages.length;
  const timeRange = formatHerdBatchTimeRange(messages);
  const messageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  useExpandForScrollTarget(sessionId, messageIds, setExpanded);

  const totalLines = messages.reduce((sum, msg) => {
    const lines = msg.content.split("\n").filter((line) => EVENT_HEADER_RE.test(line));
    return sum + lines.length;
  }, 0);
  const eventCount = totalLines || count;

  return (
    <div
      className="animate-[fadeSlideIn_0.2s_ease-out]"
      data-feed-block-id={getHerdBatchFeedBlockId(messages[0]?.id ?? `count:${count}`)}
    >
      <div className="pl-9">
        <button onClick={() => setExpanded((v) => !v)} className={`${HERD_CHIP_BASE} ${HERD_CHIP_INTERACTIVE}`}>
          <span className="text-amber-500/50 shrink-0 text-[10px]">◇</span>
          <span>
            {eventCount} herd update{eventCount !== 1 ? "s" : ""} · {timeRange}
          </span>
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-2.5 h-2.5 text-cc-muted/40 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M6 3l5 5-5 5V3z" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="space-y-1 mt-1">
          {messages.map((msg) => (
            <HerdEventMessage key={msg.id} message={msg} showTimestamp={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadMarkerClusterRow({
  messages,
  onSelectThread,
}: {
  messages: ChatMessage[];
  onSelectThread?: (threadKey: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const moveSummary = summarizeThreadAttachmentMarkers(messages);
  const transitionSummary = summarizeThreadTransitionMarkers(messages);
  const activitySummary = summarizeCrossThreadActivityMarkers(messages);
  if (!moveSummary && !transitionSummary && !activitySummary) return null;
  const firstMessage = messages[0];
  const firstThreadKey =
    moveSummary?.destinations[0]?.threadKey ??
    transitionSummary?.destinations[0]?.threadKey ??
    activitySummary?.destinations[0]?.threadKey;
  const details = buildThreadMarkerClusterDetails(messages);
  const showDetails = details.length > 0 && (messages.length > 1 || !!moveSummary || !!transitionSummary);
  const testId =
    [moveSummary, transitionSummary, activitySummary].filter(Boolean).length > 1
      ? "thread-system-marker-cluster"
      : moveSummary
        ? "thread-attachment-marker"
        : transitionSummary
          ? "thread-transition-marker"
          : "cross-thread-activity-marker";

  return (
    <div
      className="animate-[fadeSlideIn_0.2s_ease-out] pl-9"
      data-testid={testId}
      data-thread-key={firstThreadKey}
      data-message-id={firstMessage?.id}
      data-feed-block-id={getMessageFeedBlockId(firstMessage?.id ?? "thread-marker-cluster")}
    >
      <div className="max-w-full space-y-0.5 text-[11px] text-cc-muted font-mono-code">
        {moveSummary && (
          <div>
            <MoveSummaryLine summary={moveSummary} onSelectThread={onSelectThread} />
            {showDetails && (
              <>
                <span className="mx-1.5 text-cc-muted/35">·</span>
                <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((v) => !v)} />
              </>
            )}
          </div>
        )}
        {transitionSummary && (
          <div>
            <TransitionSummaryLine summary={transitionSummary} onSelectThread={onSelectThread} />
            {!moveSummary && showDetails && (
              <>
                <span className="mx-1.5 text-cc-muted/35">·</span>
                <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((v) => !v)} />
              </>
            )}
          </div>
        )}
        {activitySummary && (
          <div>
            <ActivitySummaryLine summary={activitySummary} onSelectThread={onSelectThread} />
            {!moveSummary && !transitionSummary && showDetails && (
              <>
                <span className="mx-1.5 text-cc-muted/35">·</span>
                <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((v) => !v)} />
              </>
            )}
          </div>
        )}
        {detailsOpen && showDetails && (
          <div className="mt-1 max-w-3xl space-y-0.5 text-cc-muted/70" data-testid="thread-marker-cluster-details">
            {details.map((detail, index) => (
              <div key={`${detail}-${index}`}>{detail}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-cc-primary hover:text-cc-primary/80 underline-offset-2 hover:underline"
      aria-expanded={open}
    >
      Details
    </button>
  );
}

type ThreadMarkerDestinationSummary = {
  threadKey: string;
  label: string;
  count: number;
};

function MoveSummaryLine({
  summary,
  onSelectThread,
}: {
  summary: { count: number; destinations: ThreadMarkerDestinationSummary[] };
  onSelectThread?: (threadKey: string) => void;
}) {
  const grouped = summary.destinations.length > 1;
  const countLabel = `${summary.count} ${summary.count === 1 ? "message" : "messages"} moved to `;
  return (
    <>
      {!grouped && <span>{countLabel}</span>}
      {summary.destinations.map((destination, index) => (
        <span key={destination.threadKey}>
          {index > 0 && <span className="text-cc-muted">, </span>}
          {grouped && (
            <span>
              {destination.count}{" "}
              {index === 0 ? `${destination.count === 1 ? "message" : "messages"} moved to ` : "to "}
            </span>
          )}
          <ThreadMarkerDestinationButton destination={destination} onSelectThread={onSelectThread} />
        </span>
      ))}
    </>
  );
}

function ActivitySummaryLine({
  summary,
  onSelectThread,
}: {
  summary: { count: number; destinations: ThreadMarkerDestinationSummary[] };
  onSelectThread?: (threadKey: string) => void;
}) {
  const countLabel = `${summary.count} ${summary.count === 1 ? "activity" : "activities"} in `;
  return (
    <>
      <span>{countLabel}</span>
      {summary.destinations.map((destination, index) => (
        <span key={destination.threadKey}>
          {index > 0 && <span className="text-cc-muted">, </span>}
          <ThreadMarkerDestinationButton destination={destination} onSelectThread={onSelectThread} />
        </span>
      ))}
    </>
  );
}

function TransitionSummaryLine({
  summary,
  onSelectThread,
}: {
  summary: { transitions: ThreadTransitionDestinationSummary[] };
  onSelectThread?: (threadKey: string) => void;
}) {
  return (
    <>
      {summary.transitions.map((transition, index) => (
        <span key={`${transition.sourceLabel}-${transition.destination.threadKey}`}>
          {index > 0 && <span className="text-cc-muted">, </span>}
          <span>Work continued from {transition.sourceLabel} to </span>
          <ThreadMarkerDestinationButton destination={transition.destination} onSelectThread={onSelectThread} />
        </span>
      ))}
    </>
  );
}

function ThreadMarkerDestinationButton({
  destination,
  onSelectThread,
}: {
  destination: ThreadMarkerDestinationSummary;
  onSelectThread?: (threadKey: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectThread?.(destination.threadKey)}
      className="text-cc-primary hover:text-cc-primary/80 underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline disabled:text-cc-muted/60"
      disabled={!onSelectThread}
      title={`Open ${destination.label}`}
    >
      {destination.label}
    </button>
  );
}

function summarizeCrossThreadActivityMarkers(messages: ChatMessage[]): {
  count: number;
  destinations: ThreadMarkerDestinationSummary[];
} | null {
  const destinations = new Map<string, ThreadMarkerDestinationSummary>();
  let count = 0;
  for (const message of messages) {
    const marker = message.metadata?.crossThreadActivityMarker;
    if (!marker) continue;
    count += marker.count;
    const destination = marker.questId ?? marker.threadKey;
    const existing = destinations.get(marker.threadKey);
    if (existing) {
      existing.count += marker.count;
    } else {
      destinations.set(marker.threadKey, {
        threadKey: marker.threadKey,
        label: `thread:${destination}`,
        count: marker.count,
      });
    }
  }
  if (count === 0 || destinations.size === 0) return null;
  return { count, destinations: [...destinations.values()] };
}

function summarizeThreadAttachmentMarkers(messages: ChatMessage[]): {
  count: number;
  destinations: ThreadMarkerDestinationSummary[];
} | null {
  const destinations = new Map<string, ThreadMarkerDestinationSummary>();
  let count = 0;
  for (const message of messages) {
    const marker = message.metadata?.threadAttachmentMarker;
    if (!marker) continue;
    count += marker.count;
    const destination = marker.questId ?? marker.threadKey;
    const existing = destinations.get(marker.threadKey);
    if (existing) {
      existing.count += marker.count;
    } else {
      destinations.set(marker.threadKey, {
        threadKey: marker.threadKey,
        label: `thread:${destination}`,
        count: marker.count,
      });
    }
  }
  if (count === 0 || destinations.size === 0) return null;
  return { count, destinations: [...destinations.values()] };
}

type ThreadTransitionDestinationSummary = {
  sourceLabel: string;
  destination: ThreadMarkerDestinationSummary;
};

function summarizeThreadTransitionMarkers(messages: ChatMessage[]): {
  transitions: ThreadTransitionDestinationSummary[];
  destinations: ThreadMarkerDestinationSummary[];
} | null {
  const transitions: ThreadTransitionDestinationSummary[] = [];
  for (const message of messages) {
    const marker = message.metadata?.threadTransitionMarker;
    if (!marker) continue;
    transitions.push({
      sourceLabel: formatThreadLabel(marker.sourceQuestId ?? marker.sourceThreadKey),
      destination: {
        threadKey: marker.threadKey,
        label: formatThreadLabel(marker.questId ?? marker.threadKey),
        count: 1,
      },
    });
  }
  if (transitions.length === 0) return null;
  return { transitions, destinations: transitions.map((transition) => transition.destination) };
}

function buildThreadMarkerClusterDetails(messages: ChatMessage[]): string[] {
  const details: string[] = [];
  for (const message of messages) {
    const attachment = message.metadata?.threadAttachmentMarker;
    if (attachment) {
      details.push(formatThreadAttachmentDetail(attachment));
      continue;
    }
    const transition = message.metadata?.threadTransitionMarker;
    if (transition) {
      details.push(formatThreadTransitionDetail(transition));
      continue;
    }
    const activity = message.metadata?.crossThreadActivityMarker;
    if (activity) {
      const destination = activity.questId ?? activity.threadKey;
      const countLabel = `${activity.count} ${activity.count === 1 ? "activity" : "activities"}`;
      details.push(activity.summary ?? `${countLabel} in thread:${destination}`);
    }
  }
  return details;
}

function formatThreadAttachmentDetail(marker: ThreadAttachmentMarker): string {
  return formatThreadAttachmentMarkerDetail(marker);
}

function formatThreadTransitionDetail(marker: ThreadTransitionMarker): string {
  return `Work continued from ${formatThreadLabel(marker.sourceQuestId ?? marker.sourceThreadKey)} to ${formatThreadLabel(
    marker.questId ?? marker.threadKey,
  )}`;
}

function formatThreadLabel(threadKey: string): string {
  return threadKey === "main" ? "Main" : `thread:${threadKey}`;
}

function ToolMessageGroup({
  group,
  sessionId,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
}: {
  group: ToolMsgGroup;
  sessionId: string;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const iconType = getToolIcon(group.toolName);
  const label = getToolLabel(group.toolName);
  const count = group.items.length;

  if (count === 1) {
    const item = group.items[0];
    const showLiveCodexTerminalStub = isCodexSession && item.name === "Bash" && activeCodexTerminalIds.has(item.id);
    return (
      <div className="animate-[fadeSlideIn_0.2s_ease-out]" data-feed-block-id={getToolGroupFeedBlockId(group)}>
        <div className="flex items-start gap-3">
          <PawTrailAvatar />
          <div className="flex-1 min-w-0">
            {showLiveCodexTerminalStub ? (
              <LiveCodexTerminalStub
                sessionId={sessionId}
                toolUseId={item.id}
                input={item.input}
                onInspect={() => onOpenCodexTerminal(item.id)}
              />
            ) : (
              <ToolBlock
                name={item.name}
                input={item.input}
                toolUseId={item.id}
                sessionId={sessionId}
                parentMessageId={item.messageId}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]" data-feed-block-id={getToolGroupFeedBlockId(group)}>
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0">
          <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
              >
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
                {group.items.map((item, i) =>
                  isCodexSession && item.name === "Bash" && activeCodexTerminalIds.has(item.id) ? (
                    <LiveCodexTerminalStub
                      key={item.id || i}
                      sessionId={sessionId}
                      toolUseId={item.id}
                      input={item.input}
                      onInspect={() => onOpenCodexTerminal(item.id)}
                    />
                  ) : (
                    <ToolBlock
                      key={item.id || i}
                      name={item.name}
                      input={item.input}
                      toolUseId={item.id}
                      sessionId={sessionId}
                      parentMessageId={item.messageId}
                      hideLabel={group.toolName === "Bash"}
                    />
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const FeedEntries = memo(function FeedEntries({
  entries,
  sessionId,
  currentThreadKey,
  minuteBoundaryLabels,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
}: {
  entries: FeedEntry[];
  sessionId: string;
  currentThreadKey?: string;
  minuteBoundaryLabels?: Map<string, string>;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
}) {
  const rendered = useMemo(() => {
    const result: React.ReactNode[] = [];
    let i = 0;
    // Keep every branch in this manual renderer loop advancing `i`, assigning
    // `i` to a larger cursor, or returning. A skipped row must not spin render.
    while (i < entries.length) {
      const entry = entries[i];
      if (isApprovalEntry(entry)) {
        const batch: ChatMessage[] = [entry.msg];
        let j = i + 1;
        while (j < entries.length && isApprovalEntry(entries[j])) {
          batch.push((entries[j] as { kind: "message"; msg: ChatMessage }).msg);
          j++;
        }
        if (batch.length >= 2) {
          result.push(<ApprovalBatchGroup key={batch[0].id} messages={batch} sessionId={sessionId} />);
          i = j;
          continue;
        }
      }
      if (isHerdEventEntry(entry)) {
        const batch: ChatMessage[] = [entry.msg];
        let j = i + 1;
        while (j < entries.length && isHerdEventEntry(entries[j])) {
          batch.push((entries[j] as { kind: "message"; msg: ChatMessage }).msg);
          j++;
        }
        if (batch.length >= 2) {
          result.push(<HerdEventBatchGroup key={`herd-batch:${batch[0].id}`} messages={batch} sessionId={sessionId} />);
          i = j;
          continue;
        }
      }
      if (entry.kind === "message" && isThreadSystemMarkerMessage(entry.msg)) {
        const batch: ChatMessage[] = [entry.msg];
        let j = i + 1;
        while (j < entries.length) {
          const next = entries[j];
          if (next.kind !== "message" || !isThreadSystemMarkerMessage(next.msg)) break;
          batch.push(next.msg);
          j++;
        }
        result.push(<ThreadMarkerClusterRow key={entry.msg.id} messages={batch} onSelectThread={onSelectThread} />);
        i = j;
        continue;
      }
      if (entry.kind === "message" && isAttentionLedgerMessage(entry.msg)) {
        const record = entry.msg.metadata?.attentionRecord;
        if (record) {
          result.push(
            <div
              key={entry.msg.id}
              data-message-id={entry.msg.id}
              data-message-role={entry.msg.role}
              data-feed-block-id={getMessageFeedBlockId(entry.msg.id)}
            >
              <AttentionLedgerRow
                record={record}
                sessionId={sessionId}
                currentThreadKey={currentThreadKey}
                onSelectThread={onSelectThread}
              />
            </div>,
          );
          i++;
          continue;
        }
      }
      if (entry.kind === "tool_msg_group") {
        result.push(
          <ToolMessageGroup
            key={entry.firstId || i}
            group={entry}
            sessionId={sessionId}
            isCodexSession={isCodexSession}
            activeCodexTerminalIds={activeCodexTerminalIds}
            onOpenCodexTerminal={onOpenCodexTerminal}
          />,
        );
      } else if (entry.kind === "subagent") {
        result.push(
          <SubagentContainer
            key={entry.taskToolUseId}
            group={entry}
            sessionId={sessionId}
            minuteBoundaryLabels={minuteBoundaryLabels}
            activeCodexTerminalIds={activeCodexTerminalIds}
            onOpenCodexTerminal={onOpenCodexTerminal}
          />,
        );
      } else if (entry.kind === "subagent_batch") {
        result.push(
          <SubagentBatchContainer
            key={entry.subagents[0]?.taskToolUseId || i}
            batch={entry}
            sessionId={sessionId}
            minuteBoundaryLabels={minuteBoundaryLabels}
            activeCodexTerminalIds={activeCodexTerminalIds}
            onOpenCodexTerminal={onOpenCodexTerminal}
          />,
        );
      } else if (isTimedChatMessage(entry.msg)) {
        if (isEmptyAssistantMessage(entry.msg)) {
          i++;
          continue;
        }
        const markerLabel = minuteBoundaryLabels?.get(entry.msg.id);
        const showTimestamp = entry.msg.role === "assistant" && typeof entry.msg.turnDurationMs === "number";
        result.push(
          <div
            key={entry.msg.id}
            data-message-id={entry.msg.id}
            data-message-role={entry.msg.role}
            data-feed-block-id={getMessageFeedBlockId(entry.msg.id)}
          >
            {markerLabel && <MinuteBoundaryTimestamp timestamp={entry.msg.timestamp} label={markerLabel} />}
            <MessageBubble
              message={entry.msg}
              sessionId={sessionId}
              showTimestamp={showTimestamp}
              currentThreadKey={currentThreadKey}
              onSelectThread={onSelectThread}
            />
          </div>,
        );
      } else {
        result.push(
          <div
            key={entry.msg.id}
            data-message-id={entry.msg.id}
            data-message-role={entry.msg.role}
            data-feed-block-id={getMessageFeedBlockId(entry.msg.id)}
          >
            <MessageBubble
              message={entry.msg}
              sessionId={sessionId}
              currentThreadKey={currentThreadKey}
              onSelectThread={onSelectThread}
            />
          </div>,
        );
      }
      i++;
    }
    return result;
  }, [
    activeCodexTerminalIds,
    entries,
    isCodexSession,
    currentThreadKey,
    minuteBoundaryLabels,
    onOpenCodexTerminal,
    onSelectThread,
    sessionId,
  ]);

  return <>{rendered}</>;
});

const CollapsedActivityBar = memo(function CollapsedActivityBar({
  stats,
  durationMs,
  leaderMode,
  onClick,
}: {
  stats: TurnStats;
  durationMs: number | null;
  leaderMode: boolean;
  onClick: () => void;
}) {
  const hasStats = hasTurnSummaryStats(stats, durationMs);
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-1.5 py-1.5 px-3 border-l-2 border-cc-border/40 bg-cc-hover/10 hover:bg-cc-hover/30 transition-colors cursor-pointer text-[11px] text-cc-muted font-mono-code"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/60">
        <path d="M6 4l4 4-4 4" />
      </svg>
      {leaderMode && (
        <>
          <span>Leader activity</span>
          {hasStats && <span className="text-cc-muted/40">·</span>}
        </>
      )}
      <TurnSummaryStats stats={stats} durationMs={durationMs} separatorClass="text-cc-muted/40" />
    </button>
  );
});

function CollapsedTurnRows({
  turn,
  sessionId,
  currentThreadKey,
  durationMs,
  leaderMode,
  minuteBoundaryLabels,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
  onExpand,
}: {
  turn: Turn;
  sessionId: string;
  currentThreadKey: string;
  durationMs: number | null;
  leaderMode: boolean;
  minuteBoundaryLabels: Map<string, string>;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
  onExpand: () => void;
}) {
  const collapsedEntries = turn.collapsedEntries ?? [];
  const activityRowCount = collapsedEntries.filter((row) => row.kind === "activity").length;
  return (
    <>
      {collapsedEntries.map((row) => {
        if (row.kind === "activity") {
          return (
            <CollapsedActivityBar
              key={row.key}
              stats={row.stats}
              durationMs={activityRowCount === 1 ? durationMs : null}
              leaderMode={leaderMode}
              onClick={onExpand}
            />
          );
        }

        return (
          <div key={row.key} className="px-3 py-2">
            <HidePawContext.Provider value={true}>
              <FeedEntries
                entries={[row.entry]}
                sessionId={sessionId}
                currentThreadKey={currentThreadKey}
                minuteBoundaryLabels={minuteBoundaryLabels}
                isCodexSession={isCodexSession}
                activeCodexTerminalIds={activeCodexTerminalIds}
                onOpenCodexTerminal={onOpenCodexTerminal}
                onSelectThread={onSelectThread}
              />
            </HidePawContext.Provider>
          </div>
        );
      })}
    </>
  );
}

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

export const TurnEntriesExpanded = memo(function TurnEntriesExpanded({
  turn,
  sessionId,
  currentThreadKey,
  durationMs,
  onCollapse,
  minuteBoundaryLabels,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
}: {
  turn: Turn;
  sessionId: string;
  currentThreadKey: string;
  durationMs: number | null;
  onCollapse: () => void;
  minuteBoundaryLabels: Map<string, string>;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
}) {
  const headerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {turn.agentEntries.length > 0 && (
        <TurnCollapseBar ref={headerRef} stats={turn.stats} durationMs={durationMs} onClick={onCollapse} />
      )}
      <FeedEntries
        entries={turn.allEntries}
        sessionId={sessionId}
        currentThreadKey={currentThreadKey}
        minuteBoundaryLabels={minuteBoundaryLabels}
        isCodexSession={isCodexSession}
        activeCodexTerminalIds={activeCodexTerminalIds}
        onOpenCodexTerminal={onOpenCodexTerminal}
        onSelectThread={onSelectThread}
      />
      {turn.agentEntries.length > 0 && <TurnCollapseFooter headerRef={headerRef} onCollapse={onCollapse} />}
    </>
  );
});

function parseSubagentResultText(raw: string): string {
  try {
    const blocks = JSON.parse(raw);
    if (!Array.isArray(blocks)) return raw;
    const texts: string[] = [];
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") {
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

function SubagentBatchContainer({
  batch,
  sessionId,
  minuteBoundaryLabels,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
}: {
  batch: SubagentBatch;
  sessionId: string;
  minuteBoundaryLabels?: Map<string, string>;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
}) {
  return (
    <div
      className="animate-[fadeSlideIn_0.2s_ease-out]"
      data-feed-block-id={`subagent-batch:${batch.subagents[0]?.taskToolUseId || "empty"}`}
    >
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0 space-y-2">
          {batch.subagents.map((sg) => (
            <SubagentContainer
              key={sg.taskToolUseId}
              group={sg}
              sessionId={sessionId}
              minuteBoundaryLabels={minuteBoundaryLabels}
              activeCodexTerminalIds={activeCodexTerminalIds}
              onOpenCodexTerminal={onOpenCodexTerminal}
              inBatch
            />
          ))}
        </div>
      </div>
    </div>
  );
}

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
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
      >
        <path d="M6 4l4 4-4 4" />
      </svg>
      <span className="text-[11px] font-medium text-cc-muted">{label}</span>
      {extra && <span className="ml-auto shrink-0">{extra}</span>}
    </button>
  );
}

function SubagentContainer({
  group,
  sessionId,
  inBatch,
  minuteBoundaryLabels,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
}: {
  group: SubagentGroup;
  sessionId: string;
  inBatch?: boolean;
  minuteBoundaryLabels?: Map<string, string>;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [bgOutput, setBgOutput] = useState<string | null>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  const label = group.description || "Subagent";
  const agentType = group.agentType;
  const childCount = group.children.length;
  const hasPrompt = !!group.taskInput?.prompt;

  const childMessageIds = useMemo(
    () => group.children.filter((e) => e.kind === "message").map((e) => (e as { msg: ChatMessage }).msg.id),
    [group.children],
  );
  useExpandForScrollTarget(sessionId, childMessageIds, setOpen);

  const resultPreview = useStore((s) => s.toolResults.get(sessionId)?.get(group.taskToolUseId));
  const rawStreamingText = useStore((s) => s.streamingByParentToolUseId.get(sessionId)?.get(group.taskToolUseId) || "");
  const rawThinkingText = useStore(
    (s) => s.streamingThinkingByParentToolUseId.get(sessionId)?.get(group.taskToolUseId) || "",
  );
  const progressElapsedSeconds = useStore(
    (s) => s.toolProgress.get(sessionId)?.get(group.taskToolUseId)?.elapsedSeconds,
  );
  const startTimestamp = useStore((s) => s.toolStartTimestamps.get(sessionId)?.get(group.taskToolUseId));
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const streamingText = useMemo(
    () => (isCodexSession ? getCommittedCodexStreamingText(rawStreamingText) : rawStreamingText),
    [isCodexSession, rawStreamingText],
  );
  const bgNotif = useStore((s) => s.backgroundAgentNotifs.get(sessionId)?.get(group.taskToolUseId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const isEffectivelyComplete = group.isBackground ? bgNotif != null : resultPreview != null || bgNotif != null;
  const isAbandoned = !isEffectivelyComplete && sessionStatus !== "running" && !group.isBackground;

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
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (toolBlock) return getToolLabel(toolBlock.name);
    }
    return "";
  }, [lastEntry]);

  const parsedResultPreview = useMemo(() => {
    if (!resultPreview?.content) return null;
    return parseSubagentResultText(resultPreview.content);
  }, [resultPreview]);

  const collapsedPreview = useMemo(() => {
    if (parsedResultPreview) {
      const text = parsedResultPreview.trim();
      return text.length > 120 ? text.slice(0, 120) + "..." : text;
    }
    if (streamingText) {
      const text = streamingText.trim();
      return text.length > 120 ? text.slice(0, 120) + "..." : text;
    }
    if (rawThinkingText) {
      const text = rawThinkingText.trim();
      return text.length > 120 ? text.slice(0, 120) + "..." : text;
    }
    return lastPreview;
  }, [lastPreview, parsedResultPreview, rawThinkingText, streamingText]);

  const card = (
    <div
      className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card"
      data-feed-block-id={getSubagentFeedBlockId(group.taskToolUseId)}
    >
      <button
        ref={headerRef}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type="agent" />
        <span className="text-xs font-medium text-cc-fg truncate">{label}</span>
        {agentType && (
          <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">{agentType}</span>
        )}
        {!open && collapsedPreview && (
          <span className="text-[11px] text-cc-muted truncate ml-1 font-mono-code">{collapsedPreview}</span>
        )}
        <LiveDurationBadge
          finalDurationSeconds={
            group.isBackground
              ? bgNotif
                ? resultPreview?.duration_seconds
                : undefined
              : resultPreview?.duration_seconds
          }
          progressElapsedSeconds={progressElapsedSeconds}
          startTimestamp={startTimestamp}
          isComplete={isEffectivelyComplete || isAbandoned}
        />
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
          {childCount > 0
            ? childCount
            : isEffectivelyComplete
              ? "✓"
              : isAbandoned
                ? "—"
                : group.isBackground
                  ? "bg"
                  : "0"}
        </span>
      </button>

      {open && (
        <div className="border-t border-cc-border">
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

          {(childCount > 0 || rawStreamingText || rawThinkingText) && (
            <div className="border-b border-cc-border/50">
              <SubagentSectionHeader
                label="Activities"
                open={activitiesOpen}
                onToggle={() => setActivitiesOpen(!activitiesOpen)}
              />
              {activitiesOpen && (
                <div className="px-3 pb-2 space-y-3">
                  {childCount > 0 && (
                    <FeedEntries
                      entries={group.children}
                      sessionId={sessionId}
                      minuteBoundaryLabels={minuteBoundaryLabels}
                      isCodexSession={isCodexSession}
                      activeCodexTerminalIds={activeCodexTerminalIds}
                      onOpenCodexTerminal={onOpenCodexTerminal}
                    />
                  )}
                  {rawThinkingText && (
                    <div className="rounded-[8px] border border-cc-border/50 bg-cc-hover/20 px-3 py-2">
                      <CodexThinkingInline text={rawThinkingText} />
                    </div>
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

          {group.isBackground && childCount === 0 && bgNotif && (
            <div className="border-b border-cc-border/50">
              <div className="px-3 py-2">
                <div className="text-[11px] text-cc-muted">{bgNotif.summary}</div>
                {bgNotif.outputFile && !bgOutput && (
                  <button
                    onClick={async () => {
                      const resp = await fetch(
                        `/api/sessions/${sessionId}/agent-output?path=${encodeURIComponent(bgNotif.outputFile!)}`,
                      );
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

          {childCount === 0 && !rawStreamingText && !rawThinkingText && !isEffectivelyComplete && !isAbandoned && (
            <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-cc-muted">
              <YarnBallSpinner className="w-3.5 h-3.5" />
              <span>{group.isBackground ? "Running in background..." : "Agent starting..."}</span>
            </div>
          )}

          {childCount === 0 && isAbandoned && (
            <div className="px-3 py-2 text-[11px] text-cc-muted">Agent interrupted</div>
          )}

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

  if (inBatch) return card;

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0">{card}</div>
      </div>
    </div>
  );
}

function SubagentResult({
  preview,
  parsedText,
  sessionId,
  toolUseId,
}: {
  preview: { content: string; is_truncated: boolean };
  parsedText: string | null;
  sessionId: string;
  toolUseId: string;
}) {
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (preview.is_truncated && !fullContent && !loading) {
      setLoading(true);
      api
        .getToolResult(sessionId, toolUseId)
        .then((result: { content: string }) => setFullContent(result.content))
        .catch(() => setFullContent("[Failed to load full result]"))
        .finally(() => setLoading(false));
    }
  }, [preview.is_truncated, fullContent, loading, sessionId, toolUseId]);

  const displayText = fullContent ? parseSubagentResultText(fullContent) : (parsedText ?? preview.content);

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

export const FeedFooter = memo(function FeedFooter({
  sessionId,
  visibleToolUseIds,
}: {
  sessionId: string;
  visibleToolUseIds?: Set<string>;
}) {
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const rawStreamingText = useStore((s) => s.streaming.get(sessionId));
  const rawThinkingText = useStore((s) => s.streamingThinking.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const streamingText = useMemo(
    () => (isCodexSession ? getCommittedCodexStreamingText(rawStreamingText || "") : rawStreamingText || ""),
    [isCodexSession, rawStreamingText],
  );

  return (
    <>
      {sessionStatus === "compacting" && !rawStreamingText && (
        <div
          className="flex items-center gap-2 text-[12px] text-cc-muted font-mono-code pl-9 py-1 animate-[fadeSlideIn_0.2s_ease-out]"
          data-feed-block-id={getFooterFeedBlockId("compacting")}
        >
          <YarnBallDot className="text-cc-primary animate-pulse" />
          <span>Compacting conversation...</span>
        </div>
      )}

      {toolProgress &&
        toolProgress.size > 0 &&
        !rawStreamingText &&
        !isCodexSession &&
        (() => {
          const nonTaskProgress = Array.from(toolProgress.entries())
            .filter(([toolUseId]) => !visibleToolUseIds || visibleToolUseIds.has(toolUseId))
            .map(([, progress]) => progress)
            .filter((p) => !isSubagentToolName(p.toolName));
          if (nonTaskProgress.length === 0) return null;
          return (
            <div
              className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9"
              data-feed-block-id={getFooterFeedBlockId("tool-progress")}
            >
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

      {isCodexSession && !rawStreamingText && rawThinkingText && (
        <div className="animate-[fadeSlideIn_0.2s_ease-out]" data-feed-block-id={getFooterFeedBlockId("thinking")}>
          <div className="flex items-start gap-3">
            <PawTrailAvatar isStreaming />
            <div className="flex-1 min-w-0">
              <CodexThinkingInline text={rawThinkingText} />
            </div>
          </div>
        </div>
      )}

      {rawStreamingText && (
        <div
          className="animate-[fadeSlideIn_0.2s_ease-out]"
          data-feed-streaming-message="true"
          data-feed-block-id={getFooterFeedBlockId("streaming")}
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

export const TurnEntries = memo(function TurnEntries({
  sections,
  sessionId,
  currentThreadKey,
  leaderMode,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
  turnStates,
  toggleTurn,
}: {
  sections: FeedSection[];
  sessionId: string;
  currentThreadKey: string;
  leaderMode: boolean;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
  turnStates: Array<{ isActivityExpanded: boolean } | undefined>;
  toggleTurn: (turnId: string) => void;
}) {
  const turns = useMemo(() => sections.flatMap((section) => section.turns), [sections]);
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
      }
    }

    return buildMinuteBoundaryLabelMap(visibleTimedMessages);
  }, [turns, turnStates]);

  return (
    <>
      {(() => {
        let globalIndex = 0;
        return sections.map((section) => (
          <div key={section.id} data-feed-section-id={section.id} className="space-y-3 sm:space-y-5">
            {section.turns.map((turn) => {
              const turnIndex = globalIndex++;
              const isActivityExpanded = turnStates[turnIndex]?.isActivityExpanded ?? false;
              const turnSummaryDuration = getTurnSummaryDurationMs(turn, turns[turnIndex + 1] ?? null, leaderMode);

              return (
                <div key={turn.id}>
                  <div
                    data-turn-id={turn.id}
                    data-feed-block-id={getTurnFeedBlockId(turn.id)}
                    className="turn-container space-y-3 sm:space-y-5"
                    data-user-turn={isUserBoundaryEntry(turn.userEntry) ? "true" : undefined}
                  >
                    {turn.userEntry && (
                      <FeedEntries
                        entries={[turn.userEntry]}
                        sessionId={sessionId}
                        currentThreadKey={currentThreadKey}
                        minuteBoundaryLabels={minuteBoundaryLabels}
                        isCodexSession={isCodexSession}
                        activeCodexTerminalIds={activeCodexTerminalIds}
                        onOpenCodexTerminal={onOpenCodexTerminal}
                        onSelectThread={onSelectThread}
                      />
                    )}

                    {isActivityExpanded ? (
                      turn.allEntries.length > 0 && (
                        <TurnEntriesExpanded
                          turn={turn}
                          sessionId={sessionId}
                          currentThreadKey={currentThreadKey}
                          durationMs={turnSummaryDuration}
                          minuteBoundaryLabels={minuteBoundaryLabels}
                          isCodexSession={isCodexSession}
                          activeCodexTerminalIds={activeCodexTerminalIds}
                          onOpenCodexTerminal={onOpenCodexTerminal}
                          onSelectThread={onSelectThread}
                          onCollapse={() => toggleTurn(turn.id)}
                        />
                      )
                    ) : (
                      <>
                        {turn.systemEntries.length > 0 && (
                          <FeedEntries
                            entries={turn.systemEntries}
                            sessionId={sessionId}
                            currentThreadKey={currentThreadKey}
                            minuteBoundaryLabels={minuteBoundaryLabels}
                            isCodexSession={isCodexSession}
                            activeCodexTerminalIds={activeCodexTerminalIds}
                            onOpenCodexTerminal={onOpenCodexTerminal}
                            onSelectThread={onSelectThread}
                          />
                        )}
                        {((turn.collapsedEntries?.length ?? 0) > 0 || turn.subConclusions.length > 0) && (
                          <div className="flex items-start gap-3">
                            <PawTrailAvatar />
                            <div className="flex-1 min-w-0 rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
                              {turn.subConclusions.length > 0 && (
                                <div className="px-3 pt-2 space-y-1.5">
                                  <HidePawContext.Provider value={true}>
                                    {turn.subConclusions.map((sc, scIdx) => (
                                      <FeedEntries
                                        key={scIdx}
                                        entries={[sc.entry]}
                                        sessionId={sessionId}
                                        currentThreadKey={currentThreadKey}
                                        isCodexSession={isCodexSession}
                                        activeCodexTerminalIds={activeCodexTerminalIds}
                                        onOpenCodexTerminal={onOpenCodexTerminal}
                                        onSelectThread={onSelectThread}
                                      />
                                    ))}
                                  </HidePawContext.Provider>
                                </div>
                              )}
                              <CollapsedTurnRows
                                turn={turn}
                                sessionId={sessionId}
                                currentThreadKey={currentThreadKey}
                                durationMs={turnSummaryDuration}
                                leaderMode={leaderMode}
                                minuteBoundaryLabels={minuteBoundaryLabels}
                                isCodexSession={isCodexSession}
                                activeCodexTerminalIds={activeCodexTerminalIds}
                                onOpenCodexTerminal={onOpenCodexTerminal}
                                onSelectThread={onSelectThread}
                                onExpand={() => toggleTurn(turn.id)}
                              />
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ));
      })()}
    </>
  );
});
