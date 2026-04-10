import { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback, memo, type ReactNode } from "react";
import { useStore } from "../store.js";
import { CodexThinkingInline, HerdEventMessage, MessageBubble, isEmptyAssistantMessage } from "./MessageBubble.js";
import { ToolBlock, getPreview, getToolIcon, getToolLabel, ToolIcon, formatDuration } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CollapseFooter, TurnCollapseFooter } from "./CollapseFooter.js";
import { api } from "../api.js";
import type { ChatMessage, ContentBlock, PendingCodexInput } from "../types.js";
import { isSubagentToolName } from "../types.js";
import { YarnBallDot, YarnBallSpinner, SleepingCat } from "./CatIcons.js";
import { PawTrailAvatar, PawCounterContext, PawScrollProvider, HidePawContext } from "./PawTrail.js";
import { isTouchDevice } from "../utils/mobile.js";
import { sendToSession } from "../ws.js";
import { useCollapsePolicy } from "../hooks/use-collapse-policy.js";
import { TimerChip } from "./TimerWidget.js";
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

const DEFAULT_VISIBLE_SECTION_COUNT = 3;
const FEED_SECTION_TURN_COUNT = 50;
const LIVE_ACTIVITY_RAIL_DWELL_MS = 5_000;
const FEED_EXTRA_SCROLL_SLACK_PX = 12;
const FLOATING_STATUS_SPACER_MARGIN_PX = 4;

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
const EMPTY_PENDING_CODEX_INPUTS: PendingCodexInput[] = [];

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function getMessageFeedBlockId(messageId: string): string {
  return `message:${messageId}`;
}

function getApprovalBatchFeedBlockId(messageId: string): string {
  return `approval:${messageId}`;
}

function getToolGroupFeedBlockId(group: ToolMsgGroup): string {
  return `tool-group:${group.firstId || group.items[0]?.id || group.toolName}`;
}

function getSubagentFeedBlockId(toolUseId: string): string {
  return `subagent:${toolUseId}`;
}

function getTurnFeedBlockId(turnId: string): string {
  return `turn:${turnId}`;
}

function getFooterFeedBlockId(kind: string): string {
  return `footer:${kind}`;
}

function getPendingCodexFeedBlockId(inputId: string): string {
  return `pending-codex:${inputId}`;
}

function getFeedBlockIdFromNode(node: Node | null): string | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return (element?.closest("[data-feed-block-id]") as HTMLElement | null)?.dataset.feedBlockId ?? null;
}

function collectFeedBlockIdsFromNode(node: Node | null, blockIds: Set<string>) {
  const ownId = getFeedBlockIdFromNode(node);
  if (ownId) blockIds.add(ownId);
  if (!(node instanceof Element)) return;
  const element = node as HTMLElement;
  if (element.dataset.feedBlockId) blockIds.add(element.dataset.feedBlockId);
  const descendants = element.querySelectorAll<HTMLElement>("[data-feed-block-id]");
  for (const descendant of descendants) {
    if (descendant.dataset.feedBlockId) blockIds.add(descendant.dataset.feedBlockId);
  }
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
    // Herd events manage their own time display (batch group shows a time range).
    // Exclude them from minute-boundary computation to avoid extra time dividers.
    if (entry.msg.agentSource?.sessionId === "herd-events") continue;
    out.push(entry.msg);
  }
}

function formatMinuteBoundaryLabel(timestamp: number, previousTimestamp: number | null): string | null {
  const current = new Date(timestamp);
  if (Number.isNaN(current.getTime())) return null;

  const prev = previousTimestamp === null ? null : new Date(previousTimestamp);
  const includesDate =
    !prev ||
    current.getFullYear() !== prev.getFullYear() ||
    current.getMonth() !== prev.getMonth() ||
    current.getDate() !== prev.getDate();

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
export function ElapsedTimer({
  sessionId,
  latestIndicatorVisible = false,
  onJumpToLatest,
  variant = "bar",
  onVisibleHeightChange,
}: {
  sessionId: string;
  latestIndicatorVisible?: boolean;
  onJumpToLatest?: () => void;
  variant?: "bar" | "floating";
  onVisibleHeightChange?: (height: number) => void;
}) {
  const streamingStartedAt = useStore((s) => s.streamingStartedAt.get(sessionId));
  const streamingOutputTokens = useStore((s) => s.streamingOutputTokens.get(sessionId));
  const streamingPausedDuration = useStore((s) => s.streamingPausedDuration.get(sessionId) ?? 0);
  const streamingPauseStartedAt = useStore((s) => s.streamingPauseStartedAt.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const isStuck = useStore((s) => s.sessionStuck.get(sessionId) ?? false);
  const [elapsed, setElapsed] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!streamingStartedAt && sessionStatus !== "running") {
      setElapsed(0);
      return;
    }
    const start = streamingStartedAt || Date.now();
    const calcElapsed = () => {
      const pauseOffset =
        streamingPausedDuration + (streamingPauseStartedAt ? Date.now() - streamingPauseStartedAt : 0);
      return Math.max(0, Date.now() - start - pauseOffset);
    };
    setElapsed(calcElapsed());
    const interval = setInterval(() => setElapsed(calcElapsed()), 1000);
    return () => clearInterval(interval);
  }, [streamingStartedAt, sessionStatus, streamingPausedDuration, streamingPauseStartedAt]);

  const showTimer = sessionStatus === "running" && elapsed > 0;
  useLayoutEffect(() => {
    if (!onVisibleHeightChange) return;
    if (!showTimer) {
      onVisibleHeightChange(0);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const reportHeight = () => {
      onVisibleHeightChange(Math.ceil(root.getBoundingClientRect().height));
    };
    reportHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(root);
    return () => observer.disconnect();
  }, [onVisibleHeightChange, showTimer, streamingOutputTokens, variant]);

  if (!showTimer) return null;

  const handleRelaunch = () => {
    api.relaunchSession(sessionId).catch(() => {});
  };

  const label = isStuck ? "Session may be stuck" : streamingPauseStartedAt ? "Napping..." : "Purring...";
  const dotColor = isStuck
    ? "text-amber-400"
    : streamingPauseStartedAt
      ? "text-amber-400"
      : "text-cc-primary animate-pulse";

  if (variant === "floating") {
    return (
      <div
        ref={rootRef}
        className="pointer-events-auto relative inline-flex max-w-[min(18rem,calc(100vw-2.75rem))] items-center gap-1.5 overflow-hidden rounded-[18px] border border-white/8 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-2.5 py-1 text-[11px] text-cc-muted font-mono-code shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-md"
      >
        <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.10),transparent_55%)]" />
        <YarnBallDot className={dotColor} />
        <span className="relative truncate text-cc-fg/90">{label}</span>
        <span className="relative text-cc-muted/75">{formatElapsed(elapsed)}</span>
        {(streamingOutputTokens ?? 0) > 0 && (
          <span className="relative hidden sm:inline truncate text-cc-muted/70">
            ↓ {formatTokens(streamingOutputTokens!)}
          </span>
        )}
        {isStuck && (
          <button
            onClick={handleRelaunch}
            className="relative ml-1 text-amber-400 hover:text-amber-300 underline cursor-pointer"
          >
            Relaunch
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="shrink-0 flex items-center gap-1.5 border-t border-cc-border bg-cc-card px-3 sm:px-4 py-1.5 text-[11px] text-cc-muted font-mono-code"
    >
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
        <button onClick={handleRelaunch} className="ml-1 text-amber-400 hover:text-amber-300 underline cursor-pointer">
          Relaunch
        </button>
      )}
      {latestIndicatorVisible && onJumpToLatest && (
        <button
          type="button"
          onClick={onJumpToLatest}
          className="ml-auto inline-flex min-w-0 items-center gap-1.5 rounded-full border border-cc-primary/25 bg-cc-card/70 px-2.5 py-0.5 text-[11px] font-medium text-cc-fg transition-colors hover:bg-cc-hover cursor-pointer"
          title="Jump to latest"
          aria-label="Jump to latest"
        >
          <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-cc-primary animate-pulse" />
          <span className="truncate">New content below</span>
        </button>
      )}
    </div>
  );
}

function FeedStatusPill({
  sessionId,
  onVisibleHeightChange,
}: {
  sessionId: string;
  onVisibleHeightChange?: (height: number) => void;
}) {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 z-10 sm:bottom-3 sm:left-3 flex flex-col-reverse items-start gap-1.5">
      <ElapsedTimer sessionId={sessionId} variant="floating" onVisibleHeightChange={onVisibleHeightChange} />
      <TimerChip sessionId={sessionId} />
    </div>
  );
}

function PendingCodexInputList({ sessionId, inputs }: { sessionId: string; inputs: PendingCodexInput[] }) {
  if (inputs.length === 0) return null;

  return (
    <div className="space-y-2" data-feed-block-id={getFooterFeedBlockId("pending-codex-inputs")}>
      <div className="px-1 text-[10px] uppercase tracking-wider text-cc-muted/60">Pending delivery</div>
      <div className="flex flex-col gap-2">
        {inputs.map((input) => {
          const preview = input.content.trim().replace(/\s+/g, " ");
          const truncated = preview.length > 120 ? `${preview.slice(0, 120)}...` : preview;
          return (
            <div
              key={input.id}
              data-feed-block-id={getPendingCodexFeedBlockId(input.id)}
              className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-sm text-cc-fg"
            >
              <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-amber-400" />
              <span className="min-w-0 flex-1 truncate" title={preview || "Pending message"}>
                {truncated || "Pending message"}
              </span>
              <button
                type="button"
                disabled={!input.cancelable}
                onClick={() => {
                  sendToSession(sessionId, { type: "cancel_pending_codex_input", id: input.id });
                }}
                className={`shrink-0 rounded-full p-1 transition-colors ${
                  input.cancelable
                    ? "text-cc-muted hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
                    : "text-cc-muted/40 cursor-not-allowed"
                }`}
                title={input.cancelable ? "Cancel pending message" : "Already being delivered"}
                aria-label={input.cancelable ? "Cancel pending message" : "Pending message is already being delivered"}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
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

interface CodexTerminalEntry {
  toolUseId: string;
  input: Record<string, unknown>;
  timestamp: number;
  preview: string;
  result: {
    content: string;
    is_error: boolean;
    is_truncated: boolean;
    duration_seconds?: number;
  } | null;
  progress: {
    elapsedSeconds?: number;
    output?: string;
  } | null;
  startTimestamp?: number;
}

interface LiveSubagentEntry {
  taskToolUseId: string;
  label: string;
  agentType: string;
  isBackground: boolean;
  turnId: string;
  startTimestamp?: number;
  progressElapsedSeconds?: number;
  freshnessToken: string;
}

function getLiveActivityStartedAt(
  now: number,
  startTimestamp?: number,
  progressElapsedSeconds?: number,
  fallbackTimestamp?: number,
): number {
  if (startTimestamp != null) return startTimestamp;
  if (progressElapsedSeconds != null) return now - progressElapsedSeconds * 1000;
  if (fallbackTimestamp != null) return fallbackTimestamp;
  return now;
}

function getLiveActivityRevealAt(startedAt: number): number {
  return startedAt + LIVE_ACTIVITY_RAIL_DWELL_MS;
}

function getCodexTerminalRevealAt(entry: CodexTerminalEntry, now: number): number {
  return getLiveActivityRevealAt(
    getLiveActivityStartedAt(now, entry.startTimestamp, entry.progress?.elapsedSeconds, entry.timestamp),
  );
}

function getLiveSubagentRevealAt(entry: LiveSubagentEntry, now: number): number {
  return getLiveActivityRevealAt(getLiveActivityStartedAt(now, entry.startTimestamp, entry.progressElapsedSeconds));
}

function collectLiveSubagentEntries(
  turns: Turn[],
  sessionStatus: "idle" | "running" | "compacting" | "reverting" | null,
  toolResults?: Map<
    string,
    {
      content: string;
      is_error: boolean;
      is_truncated: boolean;
      duration_seconds?: number;
    }
  >,
  toolProgress?: Map<
    string,
    {
      toolName: string;
      elapsedSeconds: number;
      output?: string;
    }
  >,
  toolStartTimestamps?: Map<string, number>,
  backgroundAgentNotifs?: Map<
    string,
    {
      status: string;
      outputFile?: string;
      summary?: string;
    }
  >,
  parentStreamingByToolUseId?: Map<string, string>,
): LiveSubagentEntry[] {
  const entries: LiveSubagentEntry[] = [];
  const seen = new Set<string>();

  const getEntrySignature = (feedEntries: FeedEntry[]): { count: number; lastKey: string } => {
    let count = 0;
    let lastKey = "";
    for (const feedEntry of feedEntries) {
      if (feedEntry.kind === "message") {
        count++;
        lastKey = feedEntry.msg.id;
        continue;
      }
      if (feedEntry.kind === "tool_msg_group") {
        count += Math.max(1, feedEntry.items.length);
        lastKey = feedEntry.firstId || feedEntry.items[feedEntry.items.length - 1]?.id || feedEntry.toolName;
        continue;
      }
      if (feedEntry.kind === "subagent") {
        count++;
        lastKey = feedEntry.taskToolUseId;
        const child = getEntrySignature(feedEntry.children);
        count += child.count;
        if (child.lastKey) lastKey = child.lastKey;
        continue;
      }
      if (feedEntry.kind === "subagent_batch") {
        for (const subagent of feedEntry.subagents) {
          count++;
          lastKey = subagent.taskToolUseId;
          const child = getEntrySignature(subagent.children);
          count += child.count;
          if (child.lastKey) lastKey = child.lastKey;
        }
      }
    }
    return { count, lastKey };
  };

  const visitEntries = (feedEntries: FeedEntry[], turnId: string) => {
    for (const entry of feedEntries) {
      if (entry.kind === "subagent") {
        const resultPreview = toolResults?.get(entry.taskToolUseId);
        const bgNotif = backgroundAgentNotifs?.get(entry.taskToolUseId);
        // Background agents: the CLI sends tool_result immediately ("task spawned")
        // so resultPreview is set right away. They only truly complete when
        // task_notification arrives (bgNotif). Foreground agents complete on either.
        const isEffectivelyComplete = entry.isBackground ? bgNotif != null : resultPreview != null || bgNotif != null;
        // Background agents stay "live" even when the main turn ends (session idle).
        // They only complete via task_notification (bgNotif).
        const isAbandoned = !isEffectivelyComplete && sessionStatus !== "running" && !entry.isBackground;
        if (!isEffectivelyComplete && !isAbandoned && !seen.has(entry.taskToolUseId)) {
          seen.add(entry.taskToolUseId);
          const childSignature = getEntrySignature(entry.children);
          const rawStreamingText = parentStreamingByToolUseId?.get(entry.taskToolUseId) || "";
          entries.push({
            taskToolUseId: entry.taskToolUseId,
            label: entry.description || "Subagent",
            agentType: entry.agentType,
            isBackground: entry.isBackground,
            turnId,
            startTimestamp: toolStartTimestamps?.get(entry.taskToolUseId),
            progressElapsedSeconds: toolProgress?.get(entry.taskToolUseId)?.elapsedSeconds,
            freshnessToken: `${childSignature.count}:${childSignature.lastKey}:${rawStreamingText.length}`,
          });
        }
        visitEntries(entry.children, turnId);
        continue;
      }

      if (entry.kind === "subagent_batch") {
        for (const subagent of entry.subagents) {
          visitEntries([subagent], turnId);
        }
      }
    }
  };

  for (const turn of turns) {
    visitEntries(turn.allEntries, turn.id);
  }

  return entries;
}

function getTerminalChipLabel(input: Record<string, unknown>): string {
  const commandValue = input.command;
  const command = Array.isArray(commandValue)
    ? commandValue.map((part) => String(part)).join(" ")
    : typeof commandValue === "string"
      ? commandValue
      : "";
  const firstToken = command.trim().split(/\s+/)[0] || "";
  if (!firstToken) return "cmd";
  const normalized = firstToken.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() || normalized;
  return basename || "cmd";
}

function collectCodexTerminalEntries(
  messages: ChatMessage[],
  toolResults?: Map<
    string,
    {
      content: string;
      is_error: boolean;
      is_truncated: boolean;
      duration_seconds?: number;
    }
  >,
  toolProgress?: Map<
    string,
    {
      toolName: string;
      elapsedSeconds: number;
      output?: string;
    }
  >,
  toolStartTimestamps?: Map<string, number>,
): CodexTerminalEntry[] {
  const entries = new Map<string, CodexTerminalEntry>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const blocks = msg.contentBlocks || [];
    for (const block of blocks) {
      if (block.type !== "tool_use" || block.name !== "Bash") continue;
      if (!block.id || entries.has(block.id)) continue;

      entries.set(block.id, {
        toolUseId: block.id,
        input: block.input,
        timestamp: msg.timestamp,
        preview: getPreview("Bash", block.input) || "Terminal command",
        result: toolResults?.get(block.id) ?? null,
        progress: toolProgress?.get(block.id) ?? null,
        startTimestamp: toolStartTimestamps?.get(block.id),
      });
    }
  }

  return Array.from(entries.values()).sort((a, b) => {
    const aTs = a.startTimestamp ?? a.timestamp;
    const bTs = b.startTimestamp ?? b.timestamp;
    return bTs - aTs;
  });
}

function LiveCodexTerminalStub({
  sessionId,
  toolUseId,
  input,
  onInspect,
}: {
  sessionId: string;
  toolUseId: string;
  input: Record<string, unknown>;
  onInspect?: () => void;
}) {
  const progress = useStore((s) => s.toolProgress.get(sessionId)?.get(toolUseId));
  const startTimestamp = useStore((s) => s.toolStartTimestamps.get(sessionId)?.get(toolUseId));
  const preview = getPreview("Bash", input) || "Terminal command";

  return (
    <div className="border border-cc-border rounded-[10px] bg-cc-card/70 px-3 py-2">
      <div className="flex items-center gap-2">
        <ToolIcon type="terminal" />
        <span className="min-w-0 flex-1 truncate text-xs font-mono-code text-cc-fg">{preview}</span>
        <LiveDurationBadge
          progressElapsedSeconds={progress?.elapsedSeconds}
          startTimestamp={startTimestamp}
          isComplete={false}
        />
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-cc-muted">
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cc-primary animate-pulse" />
          Live terminal
        </span>
        {onInspect && (
          <button
            type="button"
            onClick={onInspect}
            data-testid="codex-live-terminal-stub-inspect"
            className="ml-auto text-cc-primary hover:underline cursor-pointer"
          >
            Inspect
          </button>
        )}
      </div>
    </div>
  );
}

function LiveActivityRail({
  terminals,
  subagents,
  selectedToolUseId,
  onSelect,
  onSelectSubagent,
  onDismissSubagent,
}: {
  terminals: CodexTerminalEntry[];
  subagents: LiveSubagentEntry[];
  selectedToolUseId: string | null;
  onSelect: (toolUseId: string) => void;
  onSelectSubagent: (taskToolUseId: string, turnId: string) => void;
  onDismissSubagent: (taskToolUseId: string, freshnessToken: string) => void;
}) {
  const visibleEntries = [
    ...terminals.map((terminal) => ({
      kind: "terminal" as const,
      key: terminal.toolUseId,
      sortTs: terminal.startTimestamp ?? terminal.timestamp,
      terminal,
    })),
    ...subagents.map((subagent) => ({
      kind: "subagent" as const,
      key: subagent.taskToolUseId,
      sortTs: subagent.startTimestamp ?? 0,
      subagent,
    })),
  ].sort((a, b) => b.sortTs - a.sortTs);

  if (visibleEntries.length === 0) return null;

  return (
    <div
      data-testid="live-activity-rail"
      className="pointer-events-none absolute inset-x-2 top-2 z-10 flex justify-center sm:top-3 sm:inset-x-3"
    >
      <div className="pointer-events-auto flex w-full max-w-3xl justify-start">
        <div className="flex max-w-full items-center gap-1 overflow-x-auto scrollbar-hide rounded-[18px] border border-cc-border/80 bg-cc-bg/96 px-1.5 py-1 shadow-lg backdrop-blur-sm">
          {visibleEntries.map((entry) => {
            if (entry.kind === "terminal") {
              const terminal = entry.terminal;
              const isSelected = selectedToolUseId === terminal.toolUseId;
              return (
                <button
                  key={terminal.toolUseId}
                  type="button"
                  onClick={() => onSelect(terminal.toolUseId)}
                  data-testid="codex-live-terminal-chip"
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    isSelected
                      ? "border-cc-primary/40 bg-cc-card text-cc-fg"
                      : "border-cc-border bg-cc-card text-cc-fg hover:bg-cc-hover"
                  }`}
                  title={terminal.preview}
                  aria-label={`Open live terminal for ${terminal.preview}`}
                >
                  <ToolIcon type="terminal" />
                  <span className="shrink-0 text-xs font-mono-code">{getTerminalChipLabel(terminal.input)}</span>
                  <LiveDurationBadge
                    progressElapsedSeconds={terminal.progress?.elapsedSeconds}
                    startTimestamp={terminal.startTimestamp}
                    isComplete={false}
                  />
                </button>
              );
            }

            const subagent = entry.subagent;
            return (
              <div
                key={subagent.taskToolUseId}
                className="flex shrink-0 items-center gap-1 rounded-full border border-cc-border bg-cc-card pr-1 text-cc-fg"
              >
                <button
                  type="button"
                  onClick={() => onSelectSubagent(subagent.taskToolUseId, subagent.turnId)}
                  data-testid="live-subagent-chip"
                  className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-left text-cc-fg transition-colors hover:bg-cc-hover cursor-pointer"
                  title={subagent.label}
                  aria-label={`Jump to live subagent ${subagent.label}`}
                >
                  <ToolIcon type="agent" />
                  <span className="min-w-0 flex-1 truncate text-xs">{subagent.label}</span>
                  <LiveDurationBadge
                    progressElapsedSeconds={subagent.progressElapsedSeconds}
                    startTimestamp={subagent.startTimestamp}
                    isComplete={false}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => onDismissSubagent(subagent.taskToolUseId, subagent.freshnessToken)}
                  data-testid="live-subagent-chip-dismiss"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
                  aria-label={`Dismiss live subagent ${subagent.label}`}
                  title="Dismiss"
                >
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                    <path d="M3 3l6 6M9 3L3 9" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CodexTerminalInspector({
  sessionId,
  terminal,
  onClose,
}: {
  sessionId: string;
  terminal: CodexTerminalEntry;
  onClose: () => void;
}) {
  const statusLabel = terminal.result ? (terminal.result.is_error ? "error" : "complete") : "running";
  const statusClass = terminal.result
    ? terminal.result.is_error
      ? "bg-cc-error/10 text-cc-error"
      : "bg-cc-success/10 text-cc-success"
    : "bg-cc-primary/10 text-cc-primary";

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-4 z-20 flex justify-start sm:inset-x-auto sm:left-4">
      <div
        data-testid="codex-terminal-inspector"
        className="pointer-events-auto w-full max-w-[min(32rem,100%)] rounded-2xl border border-cc-border bg-cc-bg/98 shadow-2xl backdrop-blur-sm"
      >
        <div className="flex items-center gap-2 border-b border-cc-border px-4 py-3">
          <ToolIcon type="terminal" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-cc-fg">Terminal transcript</div>
            <div className="truncate text-[11px] font-mono-code text-cc-muted">{terminal.preview}</div>
          </div>
          <span className={`rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-wide ${statusClass}`}>
            {statusLabel}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[11px] text-cc-muted hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
          >
            Minimize
          </button>
        </div>
        <div className="p-3">
          <ToolBlock
            name="Bash"
            input={terminal.input}
            toolUseId={terminal.toolUseId}
            sessionId={sessionId}
            defaultOpen
          />
        </div>
      </div>
    </div>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

const ToolMessageGroup = memo(function ToolMessageGroup({
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

  // Single item — render using ToolBlock which includes result section
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
              <ToolBlock name={item.name} input={item.input} toolUseId={item.id} sessionId={sessionId} />
            )}
          </div>
        </div>
      </div>
    );
  }

  // Multi-item group
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

interface TurnOffsetIndex {
  turnId: string;
  offsetTop: number;
}

interface FeedViewportAnchor {
  messageId: string | null;
  turnId: string | null;
  offsetTop: number;
}

interface FeedSection {
  id: string;
  turns: Turn[];
}

export function buildFeedSections(turns: Turn[], sectionTurnCount = FEED_SECTION_TURN_COUNT): FeedSection[] {
  if (turns.length === 0) return [];

  const sections: FeedSection[] = [];
  const normalizedSectionTurnCount = Math.max(1, sectionTurnCount);
  for (let start = 0; start < turns.length; start += normalizedSectionTurnCount) {
    const current = turns.slice(start, start + normalizedSectionTurnCount);
    if (current.length === 0) continue;
    sections.push({
      id: current[0]?.id ?? `section-${sections.length}`,
      turns: current,
    });
  }

  return sections;
}

export function findVisibleSectionStartIndex(sections: FeedSection[], visibleSectionCount: number): number {
  return Math.max(0, sections.length - Math.max(1, visibleSectionCount));
}

export function findVisibleSectionEndIndex(
  sections: FeedSection[],
  startIndex: number,
  visibleSectionCount: number,
): number {
  if (sections.length === 0) return 0;
  const normalizedStartIndex = Math.min(Math.max(0, startIndex), sections.length - 1);
  return Math.min(sections.length, normalizedStartIndex + Math.max(1, visibleSectionCount));
}

function findPreviousSectionStartIndex(sections: FeedSection[], fromIndex: number): number | null {
  return fromIndex > 0 ? Math.min(fromIndex - 1, sections.length - 1) : null;
}

export function findSectionWindowStartIndexForTarget(
  sections: FeedSection[],
  targetIndex: number,
  visibleSectionCount: number,
): number {
  if (sections.length === 0) return 0;
  const normalizedCount = Math.max(1, visibleSectionCount);
  const maxStartIndex = Math.max(0, sections.length - normalizedCount);
  return Math.min(Math.max(0, targetIndex - 1), maxStartIndex);
}

export function findActiveTaskTurnIdForScroll(
  turnOffsets: TurnOffsetIndex[],
  scrollTop: number,
  fallbackTurnId: string | null,
  offsetPx = 48,
): string | null {
  if (turnOffsets.length === 0) return fallbackTurnId;

  const targetOffset = scrollTop + offsetPx;
  let low = 0;
  let high = turnOffsets.length - 1;
  let best = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (turnOffsets[mid].offsetTop <= targetOffset) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best >= 0 ? turnOffsets[best].turnId : fallbackTurnId;
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

/** Check if a feed entry is a herd event message (injected by the herd event dispatcher). */
function isHerdEventEntry(entry: FeedEntry): entry is { kind: "message"; msg: ChatMessage } {
  return entry.kind === "message" && entry.msg.role === "user" && entry.msg.agentSource?.sessionId === "herd-events";
}

/** Format a time range label for a batch of herd events.
 *  Same minute: "11:44". Different minutes: "11:44 – 11:55". */
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

/** Collapsed group for consecutive herd event messages — shows "N herd updates · time range"
 *  with an expand toggle to see individual events with their timestamps. */
function HerdEventBatchGroup({ messages }: { messages: ChatMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const count = messages.length;
  const timeRange = formatHerdBatchTimeRange(messages);

  // Count total event lines across all batched messages
  const totalLines = messages.reduce((sum, msg) => {
    const lines = msg.content.split("\n").filter((line) => line.trim().length > 0 && line.startsWith("#"));
    return sum + lines.length;
  }, 0);
  const eventCount = totalLines || count;

  return (
    <div
      className="animate-[fadeSlideIn_0.2s_ease-out]"
      data-feed-block-id={getHerdBatchFeedBlockId(messages[0]?.id ?? `count:${count}`)}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 cursor-pointer hover:text-cc-fg/70 transition-colors"
      >
        <span className="text-amber-500/60 shrink-0">◇</span>
        <span>
          {eventCount} herd update{eventCount !== 1 ? "s" : ""} · {timeRange}
        </span>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted/40 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
      {expanded && (
        <div className="space-y-0">
          {messages.map((msg) => (
            <HerdEventMessage key={msg.id} message={msg} showTimestamp={false} />
          ))}
        </div>
      )}
    </div>
  );
}

const FeedEntries = memo(function FeedEntries({
  entries,
  sessionId,
  minuteBoundaryLabels,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
}: {
  entries: FeedEntry[];
  sessionId: string;
  minuteBoundaryLabels?: Map<string, string>;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
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
      // Batch consecutive herd event entries (2+ become a collapsed group)
      if (isHerdEventEntry(entry)) {
        const batch: ChatMessage[] = [entry.msg];
        let j = i + 1;
        while (j < entries.length && isHerdEventEntry(entries[j])) {
          batch.push((entries[j] as { kind: "message"; msg: ChatMessage }).msg);
          j++;
        }
        if (batch.length >= 2) {
          result.push(<HerdEventBatchGroup key={`herd-batch:${batch[0].id}`} messages={batch} />);
          i = j;
          continue;
        }
        // Single herd event — render normally (fall through below)
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
        // Skip empty assistant messages entirely so they don't create gaps in space-y layout
        if (isEmptyAssistantMessage(entry.msg)) continue;
        const markerLabel = minuteBoundaryLabels?.get(entry.msg.id);
        const showTimestamp = entry.msg.role === "assistant" && typeof entry.msg.turnDurationMs === "number";
        result.push(
          <div
            key={entry.msg.id}
            data-message-id={entry.msg.id}
            data-feed-block-id={getMessageFeedBlockId(entry.msg.id)}
          >
            {markerLabel && <MinuteBoundaryTimestamp timestamp={entry.msg.timestamp} label={markerLabel} />}
            <MessageBubble message={entry.msg} sessionId={sessionId} showTimestamp={showTimestamp} />
          </div>,
        );
      } else {
        result.push(
          <div
            key={entry.msg.id}
            data-message-id={entry.msg.id}
            data-feed-block-id={getMessageFeedBlockId(entry.msg.id)}
          >
            <MessageBubble message={entry.msg} sessionId={sessionId} />
          </div>,
        );
      }
      i++;
    }
    return result;
  }, [activeCodexTerminalIds, entries, isCodexSession, minuteBoundaryLabels, onOpenCodexTerminal, sessionId]);

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
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
}: {
  turn: Turn;
  sessionId: string;
  durationMs: number | null;
  onCollapse: () => void;
  minuteBoundaryLabels: Map<string, string>;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
}) {
  const headerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {/* Per-turn collapse bar (only for turns with collapsible activity) */}
      {turn.agentEntries.length > 0 && (
        <TurnCollapseBar ref={headerRef} stats={turn.stats} durationMs={durationMs} onClick={onCollapse} />
      )}
      {/* Render all entries interleaved in original chronological order */}
      <FeedEntries
        entries={turn.allEntries}
        sessionId={sessionId}
        minuteBoundaryLabels={minuteBoundaryLabels}
        isCodexSession={isCodexSession}
        activeCodexTerminalIds={activeCodexTerminalIds}
        onOpenCodexTerminal={onOpenCodexTerminal}
      />
      {/* Bottom collapse bar — appears when top bar scrolls out of view */}
      {turn.agentEntries.length > 0 && <TurnCollapseFooter headerRef={headerRef} onCollapse={onCollapse} />}
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

const SubagentContainer = memo(function SubagentContainer({
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

  // Read the subagent's final result from the toolResults store
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

  // Read background agent notification
  const bgNotif = useStore((s) => s.backgroundAgentNotifs.get(sessionId)?.get(group.taskToolUseId));

  // Detect abandoned subagents: session is no longer running but this subagent
  // never received a result. This happens on CLI disconnect, user interrupt,
  // compaction, or SDK sessions that don't emit tool_result for Task tools.
  // Background agents (run_in_background: true) are NOT abandoned when the main
  // turn ends — they keep running after the session goes idle and complete via
  // task_notification. Only mark them abandoned if the session fully disconnects.
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  // Background agents: the CLI sends tool_result immediately ("task spawned")
  // so resultPreview is set right away. They only truly complete when
  // task_notification arrives (bgNotif). Foreground agents complete on either.
  const isEffectivelyComplete = group.isBackground ? bgNotif != null : resultPreview != null || bgNotif != null;
  const isAbandoned = !isEffectivelyComplete && sessionStatus !== "running" && !group.isBackground;

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
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
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
      {/* Header */}
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

          {/* Background agent output (no streaming children, output goes to file) */}
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

          {/* No children yet indicator */}
          {childCount === 0 && !rawStreamingText && !rawThinkingText && !isEffectivelyComplete && !isAbandoned && (
            <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-cc-muted">
              <YarnBallSpinner className="w-3.5 h-3.5" />
              <span>{group.isBackground ? "Running in background..." : "Agent starting..."}</span>
            </div>
          )}

          {/* Abandoned subagent — session ended without this subagent completing */}
          {childCount === 0 && isAbandoned && (
            <div className="px-3 py-2 text-[11px] text-cc-muted">Agent interrupted</div>
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
        <div className="flex-1 min-w-0">{card}</div>
      </div>
    </div>
  );
});

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

  // Auto-fetch full content when truncated — subagent results are usually short
  // and truncated previews render poorly (broken JSON/markdown)
  useEffect(() => {
    if (preview.is_truncated && !fullContent && !loading) {
      setLoading(true);
      api
        .getToolResult(sessionId, toolUseId)
        .then((result) => setFullContent(result.content))
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

// ─── Self-subscribing footer (isolates rapid store updates from the feed) ────

const FeedFooter = memo(function FeedFooter({ sessionId }: { sessionId: string }) {
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
      {/* Compaction indicator — shown prominently in the feed when agent is compacting context */}
      {sessionStatus === "compacting" && !rawStreamingText && (
        <div
          className="flex items-center gap-2 text-[12px] text-cc-muted font-mono-code pl-9 py-1 animate-[fadeSlideIn_0.2s_ease-out]"
          data-feed-block-id={getFooterFeedBlockId("compacting")}
        >
          <YarnBallDot className="text-cc-primary animate-pulse" />
          <span>Compacting conversation...</span>
        </div>
      )}

      {/* Tool progress indicator — skip Task tools since SubagentContainers show their own progress */}
      {toolProgress &&
        toolProgress.size > 0 &&
        !rawStreamingText &&
        !isCodexSession &&
        (() => {
          const nonTaskProgress = Array.from(toolProgress.values()).filter((p) => !isSubagentToolName(p.toolName));
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

      {/* Streaming indicator */}
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

// ─── Turn list (render-only; parent owns collapse state to preserve scroll on reflow) ─

const TurnEntries = memo(function TurnEntries({
  sections,
  sessionId,
  leaderMode,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  turnStates,
  toggleTurn,
}: {
  sections: FeedSection[];
  sessionId: string;
  leaderMode: boolean;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  turnStates: ReturnType<typeof useCollapsePolicy>["turnStates"];
  toggleTurn: ReturnType<typeof useCollapsePolicy>["toggleTurn"];
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
                    {/* User message — always visible */}
                    {turn.userEntry && (
                      <FeedEntries
                        entries={[turn.userEntry]}
                        sessionId={sessionId}
                        minuteBoundaryLabels={minuteBoundaryLabels}
                        isCodexSession={isCodexSession}
                        activeCodexTerminalIds={activeCodexTerminalIds}
                        onOpenCodexTerminal={onOpenCodexTerminal}
                      />
                    )}

                    {isActivityExpanded ? (
                      /* Expanded: show all entries with collapse affordance */
                      turn.allEntries.length > 0 && (
                        <TurnEntriesExpanded
                          turn={turn}
                          sessionId={sessionId}
                          durationMs={turnSummaryDuration}
                          minuteBoundaryLabels={minuteBoundaryLabels}
                          isCodexSession={isCodexSession}
                          activeCodexTerminalIds={activeCodexTerminalIds}
                          onOpenCodexTerminal={onOpenCodexTerminal}
                          onCollapse={() => toggleTurn(turn.id)}
                        />
                      )
                    ) : (
                      <>
                        {/* System messages — always visible */}
                        {turn.systemEntries.length > 0 && (
                          <FeedEntries
                            entries={turn.systemEntries}
                            sessionId={sessionId}
                            minuteBoundaryLabels={minuteBoundaryLabels}
                            isCodexSession={isCodexSession}
                            activeCodexTerminalIds={activeCodexTerminalIds}
                            onOpenCodexTerminal={onOpenCodexTerminal}
                          />
                        )}
                        {/* Collapsed: activity bar (with optional response) in a card, @to(user) messages rendered outside */}
                        {(turn.agentEntries.length > 0 || turn.responseEntry) && (
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
                              {turn.responseEntry && (
                                <div className="px-3 py-2.5">
                                  <HidePawContext.Provider value={true}>
                                    <FeedEntries
                                      entries={[turn.responseEntry]}
                                      sessionId={sessionId}
                                      minuteBoundaryLabels={minuteBoundaryLabels}
                                      isCodexSession={isCodexSession}
                                      activeCodexTerminalIds={activeCodexTerminalIds}
                                      onOpenCodexTerminal={onOpenCodexTerminal}
                                    />
                                  </HidePawContext.Provider>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        {/* @to(user) promoted messages — always visible outside the collapsed card */}
                        {turn.promotedEntries.length > 0 && (
                          <FeedEntries
                            entries={turn.promotedEntries}
                            sessionId={sessionId}
                            minuteBoundaryLabels={minuteBoundaryLabels}
                            isCodexSession={isCodexSession}
                            activeCodexTerminalIds={activeCodexTerminalIds}
                            onOpenCodexTerminal={onOpenCodexTerminal}
                          />
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

// ─── Main Feed ───────────────────────────────────────────────────────────────

export function MessageFeed({
  sessionId,
  sectionTurnCount = FEED_SECTION_TURN_COUNT,
  latestIndicatorMode = "overlay",
  onLatestIndicatorVisibleChange,
  onJumpToLatestReady,
}: {
  sessionId: string;
  sectionTurnCount?: number;
  latestIndicatorMode?: "overlay" | "external";
  onLatestIndicatorVisibleChange?: (visible: boolean) => void;
  onJumpToLatestReady?: ((scrollToLatest: (() => void) | null) => void) | undefined;
}) {
  const messages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const pendingCodexInputs = useStore((s) => s.pendingCodexInputs.get(sessionId) ?? EMPTY_PENDING_CODEX_INPUTS);
  const frozenCount = useStore((s) => s.messageFrozenCounts.get(sessionId) ?? 0);
  const frozenRevision = useStore((s) => s.messageFrozenRevisions.get(sessionId) ?? 0);
  const historyLoading = useStore((s) => s.historyLoading.get(sessionId) ?? false);
  const streamingText = useStore((s) => s.streaming.get(sessionId));
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const toolResults = useStore((s) => s.toolResults.get(sessionId));
  const toolStartTimestamps = useStore((s) => s.toolStartTimestamps.get(sessionId));
  const backgroundAgentNotifs = useStore((s) => s.backgroundAgentNotifs.get(sessionId));
  const currentSessionStatus = useStore((s) => s.sessionStatus.get(sessionId) ?? null);
  const parentStreamingByToolUseId = useStore((s) => s.streamingByParentToolUseId.get(sessionId));
  const isLeaderSession = useStore((s) =>
    s.sdkSessions.some((session) => session.sessionId === sessionId && session.isOrchestrator === true),
  );
  const shouldBottomAlignNextUserMessage = useStore((s) => s.bottomAlignNextUserMessage.has(sessionId));
  const pawCounter = useRef<import("./PawTrail.js").PawCounterState>({ next: 0, cache: new Map() });
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRootRef = useRef<HTMLDivElement>(null);
  // Initialize isNearBottom from saved scroll position — if the user was scrolled
  // up when they left this session, don't auto-scroll to bottom on re-mount.
  const savedScrollPos = useStore.getState().feedScrollPosition.get(sessionId);
  const autoFollowEnabledRef = useRef(savedScrollPos ? savedScrollPos.isAtBottom : true);
  const isNearBottom = useRef(savedScrollPos ? savedScrollPos.isAtBottom : true);
  const lastScrollTopRef = useRef(savedScrollPos?.scrollTop ?? 0);
  const programmaticScrollTargetRef = useRef<number | null>(null);
  const bottomAlignMessageIdRef = useRef<string | null>(null);
  const pendingChangedFeedBlockIdsRef = useRef<Set<string>>(new Set());
  const pendingAutoFollowFallbackRef = useRef(false);
  const autoFollowRafRef = useRef<number | null>(null);
  const didTrackContentRef = useRef(false);
  const lastSeenContentBottomRef = useRef<number | null>(null);
  const lastObservedContentBottomRef = useRef<number | null>(null);
  const suppressLatestPillOnRestoreRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [showLatestPill, setShowLatestPill] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [floatingStatusHeight, setFloatingStatusHeight] = useState(0);
  const [sectionWindowStart, setSectionWindowStart] = useState<number | null>(null);
  const [selectedCodexTerminalId, setSelectedCodexTerminalId] = useState<string | null>(null);
  const [dismissedSubagentChips, setDismissedSubagentChips] = useState<Map<string, string>>(new Map());
  const [liveActivityRailVersion, setLiveActivityRailVersion] = useState(0);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isTouch = useMemo(() => isTouchDevice(), []);
  const taskTurnOffsetsRef = useRef<TurnOffsetIndex[]>([]);
  const restoredSessionIdRef = useRef<string | null>(null);
  const lastViewportAnchorRef = useRef<{
    signature: string;
    wasAutoFollowing: boolean;
    anchor: FeedViewportAnchor | null;
  } | null>(null);

  const codexTerminalEntries = useMemo(
    () => (isCodexSession ? collectCodexTerminalEntries(messages, toolResults, toolProgress, toolStartTimestamps) : []),
    [isCodexSession, messages, toolProgress, toolResults, toolStartTimestamps],
  );
  const { turns } = useFeedModel(messages, {
    leaderMode: isLeaderSession,
    frozenCount,
    frozenRevision,
  });
  const activeLiveSubagentEntries = useMemo(
    () =>
      collectLiveSubagentEntries(
        turns,
        currentSessionStatus,
        toolResults,
        toolProgress,
        toolStartTimestamps,
        backgroundAgentNotifs,
        parentStreamingByToolUseId,
      ),
    [
      backgroundAgentNotifs,
      currentSessionStatus,
      parentStreamingByToolUseId,
      toolProgress,
      toolResults,
      toolStartTimestamps,
      turns,
    ],
  );
  const activeCodexTerminalEntries = useMemo(
    () => codexTerminalEntries.filter((entry) => entry.result == null),
    [codexTerminalEntries],
  );
  const visibleLiveSubagentEntries = useMemo(() => {
    const now = Date.now();
    return activeLiveSubagentEntries.filter(
      (entry) =>
        getLiveSubagentRevealAt(entry, now) <= now &&
        dismissedSubagentChips.get(entry.taskToolUseId) !== entry.freshnessToken,
    );
  }, [activeLiveSubagentEntries, dismissedSubagentChips, liveActivityRailVersion]);
  const visibleCodexTerminalRailEntries = useMemo(() => {
    const now = Date.now();
    return activeCodexTerminalEntries.filter((entry) => getCodexTerminalRevealAt(entry, now) <= now);
  }, [activeCodexTerminalEntries, liveActivityRailVersion]);
  const activeCodexTerminalIds = useMemo(
    () => new Set(activeCodexTerminalEntries.map((entry) => entry.toolUseId)),
    [activeCodexTerminalEntries],
  );
  const selectedCodexTerminal = useMemo(
    () => codexTerminalEntries.find((entry) => entry.toolUseId === selectedCodexTerminalId) ?? null,
    [codexTerminalEntries, selectedCodexTerminalId],
  );
  const latestMessage = messages[messages.length - 1] ?? null;
  const feedEndScrollSlack = Math.max(
    FEED_EXTRA_SCROLL_SLACK_PX,
    floatingStatusHeight > 0 ? floatingStatusHeight + FLOATING_STATUS_SPACER_MARGIN_PX : 0,
  );

  useEffect(() => {
    if (!selectedCodexTerminalId) return;
    if (codexTerminalEntries.some((entry) => entry.toolUseId === selectedCodexTerminalId)) return;
    setSelectedCodexTerminalId(null);
  }, [codexTerminalEntries, selectedCodexTerminalId]);

  useEffect(() => {
    if (activeCodexTerminalEntries.length === 0 && activeLiveSubagentEntries.length === 0) return;
    const now = Date.now();
    const pendingRevealTimes = [
      ...activeCodexTerminalEntries.map((entry) => getCodexTerminalRevealAt(entry, now)),
      ...activeLiveSubagentEntries.map((entry) => getLiveSubagentRevealAt(entry, now)),
    ].filter((revealAt) => revealAt > now);
    if (pendingRevealTimes.length === 0) return;
    const nextRevealAt = Math.min(...pendingRevealTimes);
    const timeout = setTimeout(() => {
      setLiveActivityRailVersion((version) => version + 1);
    }, nextRevealAt - now);
    return () => clearTimeout(timeout);
  }, [activeCodexTerminalEntries, activeLiveSubagentEntries]);

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

  const findVisibleFeedAnchor = useCallback((container: HTMLDivElement): FeedViewportAnchor | null => {
    const containerRect = container.getBoundingClientRect();
    const findFirstVisible = (selector: string) => {
      const elements = container.querySelectorAll<HTMLElement>(selector);
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
          return { element, rect };
        }
      }
      return null;
    };

    const visibleMessage = findFirstVisible("[data-message-id]");
    if (visibleMessage) {
      const turn = visibleMessage.element.closest<HTMLElement>("[data-turn-id]");
      return {
        messageId: visibleMessage.element.dataset.messageId ?? null,
        turnId: turn?.dataset.turnId ?? null,
        offsetTop: visibleMessage.rect.top - containerRect.top,
      };
    }

    const visibleTurn = findFirstVisible("[data-turn-id]");
    if (!visibleTurn) return null;

    return {
      messageId: null,
      turnId: visibleTurn.element.dataset.turnId ?? null,
      offsetTop: visibleTurn.rect.top - containerRect.top,
    };
  }, []);

  const markProgrammaticScroll = useCallback((top: number) => {
    programmaticScrollTargetRef.current = top;
  }, []);

  const setContainerScrollTop = useCallback(
    (top: number) => {
      const container = containerRef.current;
      if (!container) return;
      markProgrammaticScroll(top);
      container.scrollTop = top;
      lastScrollTopRef.current = top;
    },
    [markProgrammaticScroll],
  );

  const scrollContainerTo = useCallback(
    (top: number, behavior: ScrollBehavior) => {
      const container = containerRef.current;
      if (!container) return;
      markProgrammaticScroll(top);
      container.scrollTo({ top, behavior });
      if (behavior !== "smooth") {
        lastScrollTopRef.current = top;
      }
    },
    [markProgrammaticScroll],
  );

  const getFeedBlockBottom = useCallback((container: HTMLDivElement, element: HTMLElement) => {
    const offsetBottom = element.offsetTop + element.offsetHeight;
    if (offsetBottom > 0) {
      return offsetBottom;
    }
    const containerRect = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 || rect.bottom !== containerRect.top) {
      return container.scrollTop + (rect.bottom - containerRect.top);
    }
    return container.scrollHeight;
  }, []);

  const getRealContentBottom = useCallback(() => {
    const container = containerRef.current;
    const contentRoot = contentRootRef.current;
    if (!container) return null;
    const fallbackBottom = Math.max(0, Math.round(container.scrollHeight - feedEndScrollSlack));
    if (!contentRoot) return fallbackBottom;
    const blocks = contentRoot.querySelectorAll<HTMLElement>("[data-feed-block-id]");
    if (blocks.length === 0) {
      return fallbackBottom;
    }
    let maxBottom = 0;
    for (const block of blocks) {
      maxBottom = Math.max(maxBottom, getFeedBlockBottom(container, block));
    }
    if (maxBottom >= container.scrollHeight - 1) {
      return fallbackBottom;
    }
    return Math.max(0, Math.min(fallbackBottom, Math.round(maxBottom)));
  }, [feedEndScrollSlack, getFeedBlockBottom]);

  const getLowestFeedBlockBottom = useCallback(
    (blockIds: Iterable<string>, fallbackToLatestBlock = false) => {
      const container = containerRef.current;
      const contentRoot = contentRootRef.current;
      if (!container || !contentRoot) return null;

      let maxBottom: number | null = null;
      for (const blockId of blockIds) {
        const element = contentRoot.querySelector<HTMLElement>(
          `[data-feed-block-id="${escapeSelectorValue(blockId)}"]`,
        );
        if (!element) continue;
        const bottom = getFeedBlockBottom(container, element);
        maxBottom = maxBottom == null ? bottom : Math.max(maxBottom, bottom);
      }

      if (maxBottom != null || !fallbackToLatestBlock) {
        return maxBottom;
      }

      const blocks = contentRoot.querySelectorAll<HTMLElement>("[data-feed-block-id]");
      const lastBlock = blocks[blocks.length - 1];
      return lastBlock ? getFeedBlockBottom(container, lastBlock) : null;
    },
    [getFeedBlockBottom],
  );

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
          isAtBottom: autoFollowEnabledRef.current && isNearBottom.current,
          anchorTurnId: anchor?.turnId ?? null,
          anchorOffsetTop: anchor?.offsetTop,
          lastSeenContentBottom: lastSeenContentBottomRef.current ?? getRealContentBottom(),
        });
      }
    };
  }, [findVisibleTurnAnchor, getRealContentBottom, sessionId]);

  const sections = useMemo(() => buildFeedSections(turns, sectionTurnCount), [sectionTurnCount, turns]);
  const totalSections = sections.length;
  const latestVisibleSectionStartIndex = useMemo(
    () => findVisibleSectionStartIndex(sections, DEFAULT_VISIBLE_SECTION_COUNT),
    [sections],
  );
  const visibleSectionStartIndex = sectionWindowStart ?? latestVisibleSectionStartIndex;
  const visibleSectionEndIndex = useMemo(
    () => findVisibleSectionEndIndex(sections, visibleSectionStartIndex, DEFAULT_VISIBLE_SECTION_COUNT),
    [sections, visibleSectionStartIndex],
  );
  const visibleSections = useMemo(
    () => sections.slice(visibleSectionStartIndex, visibleSectionEndIndex),
    [sections, visibleSectionEndIndex, visibleSectionStartIndex],
  );
  const visibleTurns = useMemo(() => visibleSections.flatMap((section) => section.turns), [visibleSections]);
  const { turnStates, toggleTurn } = useCollapsePolicy({
    sessionId,
    turns: visibleTurns,
    leaderMode: isLeaderSession,
  });
  const collapseLayoutSignature = useMemo(
    () => turnStates.map((state) => `${state.turnId}:${state.isActivityExpanded ? "1" : "0"}`).join("|"),
    [turnStates],
  );
  const showConversationLoading = historyLoading && messages.length === 0 && !streamingText;
  const previousSectionStartIndex = useMemo(
    () => findPreviousSectionStartIndex(sections, visibleSectionStartIndex),
    [sections, visibleSectionStartIndex],
  );
  const nextSectionStartIndex = useMemo(() => {
    return visibleSectionStartIndex + 1 < sections.length ? visibleSectionStartIndex + 1 : null;
  }, [sections, visibleSectionStartIndex]);
  const hasOlderSections = previousSectionStartIndex !== null;
  const hasNewerSections = sectionWindowStart !== null && nextSectionStartIndex !== null;
  // Collapsible turn IDs: all turns with agent content are collapsible (including the last).
  // Stats and text preview recompute as new messages stream in.
  const collapsibleTurnIds = useMemo(
    () => visibleTurns.filter((t) => t.agentEntries.length > 0).map((t) => t.id),
    [visibleTurns],
  );

  // Sync collapsible turn IDs to the store so the Composer can render the global toggle
  useEffect(() => {
    useStore.getState().setCollapsibleTurnIds(sessionId, collapsibleTurnIds);
  }, [sessionId, collapsibleTurnIds]);

  useEffect(() => {
    setSectionWindowStart((current) => {
      if (current == null) return null;
      if (sections.length === 0) return null;
      const normalizedCurrent = Math.min(current, sections.length - 1);
      const next = findSectionWindowStartIndexForTarget(sections, normalizedCurrent, DEFAULT_VISIBLE_SECTION_COUNT);
      return next === latestVisibleSectionStartIndex ? null : next;
    });
  }, [latestVisibleSectionStartIndex, sections]);

  const getSectionWindowStartForTurnId = useCallback(
    (turnId: string): number | null => {
      const targetSectionIndex = sections.findIndex((section) => section.turns.some((turn) => turn.id === turnId));
      if (targetSectionIndex < 0) return null;
      const nextStartIndex = findSectionWindowStartIndexForTarget(
        sections,
        targetSectionIndex,
        DEFAULT_VISIBLE_SECTION_COUNT,
      );
      return nextStartIndex === latestVisibleSectionStartIndex ? null : nextStartIndex;
    },
    [latestVisibleSectionStartIndex, sections],
  );

  // ─── Scroll management ─────────────────────────────────────────────────

  const restoreTurnAnchor = useCallback(
    (anchorTurnId: string, anchorOffsetTop = 0) => {
      const container = containerRef.current;
      if (!container) return false;
      const target = container.querySelector<HTMLElement>(`[data-turn-id="${escapeSelectorValue(anchorTurnId)}"]`);
      if (!target) return false;
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const nextTop = container.scrollTop + targetRect.top - containerRect.top - anchorOffsetTop;
      markProgrammaticScroll(nextTop);
      container.scrollTop = nextTop;
      lastScrollTopRef.current = container.scrollTop;
      return true;
    },
    [markProgrammaticScroll],
  );

  const restoreFeedAnchor = useCallback(
    (anchor: FeedViewportAnchor) => {
      const container = containerRef.current;
      if (!container) return false;

      const restoreSelector = (selector: string) => {
        const target = container.querySelector<HTMLElement>(selector);
        if (!target) return false;
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const nextTop = container.scrollTop + targetRect.top - containerRect.top - anchor.offsetTop;
        markProgrammaticScroll(nextTop);
        container.scrollTop = nextTop;
        lastScrollTopRef.current = container.scrollTop;
        return true;
      };

      if (anchor.messageId && restoreSelector(`[data-message-id="${escapeSelectorValue(anchor.messageId)}"]`)) {
        return true;
      }

      if (anchor.turnId && restoreSelector(`[data-turn-id="${escapeSelectorValue(anchor.turnId)}"]`)) {
        return true;
      }

      return false;
    },
    [markProgrammaticScroll],
  );

  const snapshotViewportAnchor = useCallback(
    (container: HTMLDivElement) => {
      lastViewportAnchorRef.current = {
        signature: collapseLayoutSignature,
        wasAutoFollowing: autoFollowEnabledRef.current,
        anchor: findVisibleFeedAnchor(container),
      };
    },
    [collapseLayoutSignature, findVisibleFeedAnchor],
  );

  const moveSectionWindow = useCallback(
    (nextStartIndex: number | null) => {
      const el = containerRef.current;
      const anchor = el ? findVisibleTurnAnchor(el) : null;
      setSectionWindowStart(nextStartIndex);
      requestAnimationFrame(() => {
        if (anchor?.turnId) {
          restoreTurnAnchor(anchor.turnId, anchor.offsetTop ?? 0);
        }
      });
    },
    [findVisibleTurnAnchor, restoreTurnAnchor],
  );

  const ensureSectionForTurnVisible = useCallback(
    (turnId: string): boolean => {
      const nextStartIndex = getSectionWindowStartForTurnId(turnId);
      if (nextStartIndex === sectionWindowStart) return false;
      if (nextStartIndex == null && visibleSectionStartIndex === latestVisibleSectionStartIndex) return false;
      moveSectionWindow(nextStartIndex);
      return true;
    },
    [
      getSectionWindowStartForTurnId,
      moveSectionWindow,
      sectionWindowStart,
      latestVisibleSectionStartIndex,
      visibleSectionStartIndex,
    ],
  );

  const scrollToFeedBlock = useCallback(
    (blockId: string, turnId: string) => {
      const sectionChanged = ensureSectionForTurnVisible(turnId);
      const scheduleScroll = () => {
        requestAnimationFrame(() => {
          const contentRoot = contentRootRef.current;
          const target = contentRoot?.querySelector<HTMLElement>(
            `[data-feed-block-id="${escapeSelectorValue(blockId)}"]`,
          );
          target?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      };
      if (sectionChanged) {
        requestAnimationFrame(scheduleScroll);
        return;
      }
      scheduleScroll();
    },
    [ensureSectionForTurnVisible],
  );

  const handleLoadOlderSection = useCallback(() => {
    if (previousSectionStartIndex == null) return;
    autoFollowEnabledRef.current = false;
    setShowScrollButton(true);
    moveSectionWindow(previousSectionStartIndex);
  }, [moveSectionWindow, previousSectionStartIndex]);

  const handleLoadNewerSection = useCallback(() => {
    if (nextSectionStartIndex == null) return;
    autoFollowEnabledRef.current = false;
    moveSectionWindow(nextSectionStartIndex === latestVisibleSectionStartIndex ? null : nextSectionStartIndex);
  }, [latestVisibleSectionStartIndex, moveSectionWindow, nextSectionStartIndex]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const performScroll = () => {
        const container = containerRef.current;
        if (!container) return;
        autoFollowEnabledRef.current = true;
        const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(realContentBottom - container.clientHeight)));
        scrollContainerTo(targetTop, behavior);
        isNearBottom.current = true;
        lastSeenContentBottomRef.current = realContentBottom;
        lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
        setShowScrollButton(false);
        setShowLatestPill(false);
      };
      if (sectionWindowStart == null || totalSections <= DEFAULT_VISIBLE_SECTION_COUNT) {
        performScroll();
        return;
      }
      setSectionWindowStart(null);
      requestAnimationFrame(performScroll);
    },
    [getRealContentBottom, scrollContainerTo, sectionWindowStart, totalSections],
  );

  const handleScrollToBottomClick = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  const resetVisibleSectionsToLatest = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (sectionWindowStart == null || totalSections <= DEFAULT_VISIBLE_SECTION_COUNT) return;
      autoFollowEnabledRef.current = true;
      setSectionWindowStart(null);
      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container) return;
        const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(realContentBottom - container.clientHeight)));
        scrollContainerTo(targetTop, behavior);
      });
    },
    [getRealContentBottom, scrollContainerTo, sectionWindowStart, totalSections],
  );

  const flushAutoFollow = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const changedBlockIds = new Set(pendingChangedFeedBlockIdsRef.current);
    pendingChangedFeedBlockIdsRef.current.clear();
    const useFallback = pendingAutoFollowFallbackRef.current;
    pendingAutoFollowFallbackRef.current = false;

    if (!autoFollowEnabledRef.current) return;

    if (sectionWindowStart != null && totalSections > DEFAULT_VISIBLE_SECTION_COUNT) {
      changedBlockIds.forEach((blockId) => pendingChangedFeedBlockIdsRef.current.add(blockId));
      pendingAutoFollowFallbackRef.current = true;
      setSectionWindowStart(null);
      requestAnimationFrame(() => {
        if (autoFollowEnabledRef.current) {
          if (autoFollowRafRef.current != null) return;
          autoFollowRafRef.current = requestAnimationFrame(() => {
            autoFollowRafRef.current = null;
            flushAutoFollow();
          });
        }
      });
      return;
    }

    const lowestBottom = getLowestFeedBlockBottom(changedBlockIds, useFallback);
    if (lowestBottom == null) return;
    const bottomAlignMessageId = bottomAlignMessageIdRef.current;
    const bottomAlignTarget = bottomAlignMessageId
      ? contentRootRef.current?.querySelector<HTMLElement>(
          `[data-message-id="${escapeSelectorValue(bottomAlignMessageId)}"]`,
        )
      : null;
    const targetBottom = bottomAlignTarget ? getFeedBlockBottom(container, bottomAlignTarget) : lowestBottom;

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(targetBottom - container.clientHeight)));
    // A long-lived subagent can keep mutating above newer bottom content. While
    // auto-follow is enabled, never let those older updates yank the viewport
    // upward; only move farther down toward the latest active content.
    const currentTop = Math.max(0, Math.min(maxScrollTop, container.scrollTop));
    const nextTargetTop = Math.max(currentTop, targetTop);
    if (Math.abs(container.scrollTop - nextTargetTop) > 1) {
      setContainerScrollTop(nextTargetTop);
    }
    const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
    isNearBottom.current = realContentBottom - nextTargetTop - container.clientHeight < 120;
    lastSeenContentBottomRef.current = realContentBottom;
    lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
    setShowScrollButton(false);
    setShowLatestPill(false);
    if (bottomAlignMessageId) {
      bottomAlignMessageIdRef.current = null;
    }
  }, [
    getFeedBlockBottom,
    getLowestFeedBlockBottom,
    getRealContentBottom,
    sectionWindowStart,
    setContainerScrollTop,
    totalSections,
  ]);

  const scheduleAutoFollowFlush = useCallback(
    (useFallback = false) => {
      if (useFallback) {
        pendingAutoFollowFallbackRef.current = true;
      }
      if (autoFollowRafRef.current != null) return;
      autoFollowRafRef.current = requestAnimationFrame(() => {
        autoFollowRafRef.current = null;
        flushAutoFollow();
      });
    },
    [flushAutoFollow],
  );

  const updateLatestPillForContentBottom = useCallback(
    (realContentBottom: number | null) => {
      if (!didTrackContentRef.current) {
        didTrackContentRef.current = true;
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      if (autoFollowEnabledRef.current) {
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      if (hasNewerSections) {
        setShowLatestPill(true);
        return;
      }
      if (suppressLatestPillOnRestoreRef.current) {
        suppressLatestPillOnRestoreRef.current = false;
        lastSeenContentBottomRef.current = realContentBottom;
        lastObservedContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      if (realContentBottom == null) {
        setShowLatestPill(false);
        return;
      }
      const container = containerRef.current;
      const hasContentBelowViewport = container
        ? realContentBottom > container.scrollTop + container.clientHeight + 8
        : false;
      if (!hasContentBelowViewport) {
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      const baseline = lastSeenContentBottomRef.current;
      if (baseline == null) {
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      setShowLatestPill(realContentBottom > baseline + 8);
    },
    [hasNewerSections],
  );

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const currentScrollTop = el.scrollTop;
    const realContentBottom = getRealContentBottom() ?? el.scrollHeight;
    const nearBottom = realContentBottom - currentScrollTop - el.clientHeight < 120;
    const isProgrammaticScroll =
      programmaticScrollTargetRef.current != null &&
      Math.abs(currentScrollTop - programmaticScrollTargetRef.current) <= 2;
    if (isProgrammaticScroll) {
      programmaticScrollTargetRef.current = null;
    }
    const scrollingUp = currentScrollTop < lastScrollTopRef.current - 4;
    if (!isProgrammaticScroll) {
      if (scrollingUp) {
        autoFollowEnabledRef.current = false;
      } else if (!nearBottom) {
        autoFollowEnabledRef.current = false;
      } else if (nearBottom) {
        autoFollowEnabledRef.current = true;
      }
    }
    isNearBottom.current = nearBottom;
    if (autoFollowEnabledRef.current && nearBottom) {
      lastSeenContentBottomRef.current = realContentBottom;
      lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
      setShowLatestPill(false);
      resetVisibleSectionsToLatest("auto");
    }
    // Only trigger a re-render when the button state actually changes
    const shouldShow = !nearBottom || !autoFollowEnabledRef.current;
    setShowScrollButton((prev) => (prev === shouldShow ? prev : shouldShow));
    // Track active scrolling for mobile FAB auto-hide
    setIsScrolling(true);
    clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => setIsScrolling(false), 1500);
    lastScrollTopRef.current = currentScrollTop;
    snapshotViewportAnchor(el);
  }

  // Restore scroll position synchronously before the first paint.
  // useLayoutEffect runs before the browser paints, preventing the flash
  // where the feed appears at scrollTop=0 for one frame before jumping.
  useLayoutEffect(() => {
    if (restoredSessionIdRef.current === sessionId) return;
    if (showConversationLoading) return;
    const pos = useStore.getState().feedScrollPosition.get(sessionId);
    if (messages.length === 0 && pos?.anchorTurnId) return;
    const desiredSectionWindowStart = pos?.anchorTurnId ? getSectionWindowStartForTurnId(pos.anchorTurnId) : null;
    if (desiredSectionWindowStart !== sectionWindowStart) {
      setSectionWindowStart(desiredSectionWindowStart);
      return;
    }
    if (pos && !pos.isAtBottom && pos.anchorTurnId) {
      if (restoreTurnAnchor(pos.anchorTurnId!, pos.anchorOffsetTop ?? 0)) {
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
      } else {
        scrollToBottom("auto");
      }
    } else if (pos && !pos.isAtBottom) {
      const el = containerRef.current;
      if (el) {
        if (el.scrollHeight === pos.scrollHeight) {
          el.scrollTop = pos.scrollTop;
        } else if (pos.scrollHeight > 0) {
          el.scrollTop = pos.scrollTop * (el.scrollHeight / pos.scrollHeight);
        }
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
        lastScrollTopRef.current = el.scrollTop;
      }
    } else {
      scrollToBottom("auto");
    }
    restoredSessionIdRef.current = sessionId;
  }, [
    getSectionWindowStartForTurnId,
    messages.length,
    restoreTurnAnchor,
    scrollToBottom,
    sectionWindowStart,
    sessionId,
    showConversationLoading,
  ]);

  useEffect(() => {
    if (showConversationLoading) return;
    didTrackContentRef.current = savedScrollPos?.lastSeenContentBottom != null;
    lastSeenContentBottomRef.current = savedScrollPos?.lastSeenContentBottom ?? null;
    lastObservedContentBottomRef.current = savedScrollPos?.lastSeenContentBottom ?? null;
    suppressLatestPillOnRestoreRef.current = savedScrollPos?.lastSeenContentBottom != null;
    setShowLatestPill(false);
  }, [savedScrollPos?.lastSeenContentBottom, sessionId, showConversationLoading]);

  useEffect(() => {
    if (showConversationLoading) return;
    updateLatestPillForContentBottom(getRealContentBottom());
  }, [
    getRealContentBottom,
    messages.length,
    showConversationLoading,
    streamingText,
    toolProgress,
    updateLatestPillForContentBottom,
  ]);

  useEffect(() => {
    onLatestIndicatorVisibleChange?.(showLatestPill);
  }, [onLatestIndicatorVisibleChange, showLatestPill]);

  useEffect(() => {
    onJumpToLatestReady?.(() => scrollToBottom());
    return () => onJumpToLatestReady?.(null);
  }, [onJumpToLatestReady, scrollToBottom]);

  useLayoutEffect(() => {
    if (!shouldBottomAlignNextUserMessage) return;
    if (!latestMessage || latestMessage.role !== "user") return;

    const alignLatestUserMessage = () => {
      const container = containerRef.current;
      if (!container) return;
      const target = container.querySelector<HTMLElement>(
        `[data-message-id="${escapeSelectorValue(latestMessage.id)}"]`,
      );
      if (!target) return;
      const messageBottom = getFeedBlockBottom(container, target);
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(messageBottom - container.clientHeight)));
      autoFollowEnabledRef.current = true;
      isNearBottom.current = true;
      setContainerScrollTop(targetTop);
      lastSeenContentBottomRef.current = getRealContentBottom();
      lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
      setShowScrollButton(false);
      setShowLatestPill(false);
      bottomAlignMessageIdRef.current = latestMessage.id;
      useStore.getState().clearBottomAlignOnNextUserMessage(sessionId);
    };

    if (sectionWindowStart != null && totalSections > DEFAULT_VISIBLE_SECTION_COUNT) {
      setSectionWindowStart(null);
      requestAnimationFrame(alignLatestUserMessage);
      return;
    }
    alignLatestUserMessage();
  }, [
    getFeedBlockBottom,
    getRealContentBottom,
    latestMessage,
    sectionWindowStart,
    sessionId,
    setContainerScrollTop,
    shouldBottomAlignNextUserMessage,
    totalSections,
  ]);

  useEffect(() => {
    if (showConversationLoading) return;
    if (!toolProgress || toolProgress.size === 0) return;
    scheduleAutoFollowFlush(true);
  }, [scheduleAutoFollowFlush, showConversationLoading, toolProgress]);

  useEffect(() => {
    if (showConversationLoading) return;
    const container = containerRef.current;
    const contentRoot = contentRootRef.current;
    if (!container || !contentRoot) return;

    lastObservedContentBottomRef.current = getRealContentBottom();

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((mutations) => {
            let sawMutation = false;
            for (const mutation of mutations) {
              sawMutation = true;
              collectFeedBlockIdsFromNode(mutation.target, pendingChangedFeedBlockIdsRef.current);
              mutation.addedNodes.forEach((node) =>
                collectFeedBlockIdsFromNode(node, pendingChangedFeedBlockIdsRef.current),
              );
            }
            if (sawMutation) {
              scheduleAutoFollowFlush();
            }
          });

    mutationObserver?.observe(contentRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const realContentBottom = getRealContentBottom();
            if (realContentBottom == null || realContentBottom === lastObservedContentBottomRef.current) return;
            lastObservedContentBottomRef.current = realContentBottom;
            if (!autoFollowEnabledRef.current) {
              updateLatestPillForContentBottom(realContentBottom);
            }
            scheduleAutoFollowFlush(true);
          });

    resizeObserver?.observe(contentRoot);

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      if (autoFollowRafRef.current != null) {
        cancelAnimationFrame(autoFollowRafRef.current);
        autoFollowRafRef.current = null;
      }
      pendingChangedFeedBlockIdsRef.current.clear();
      pendingAutoFollowFallbackRef.current = false;
    };
  }, [getRealContentBottom, scheduleAutoFollowFlush, showConversationLoading, updateLatestPillForContentBottom]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previous = lastViewportAnchorRef.current;
    if (previous && previous.signature !== collapseLayoutSignature) {
      if (previous.wasAutoFollowing) {
        const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(realContentBottom - container.clientHeight)));
        setContainerScrollTop(targetTop);
        isNearBottom.current = true;
        lastSeenContentBottomRef.current = realContentBottom;
        lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
        setShowScrollButton(false);
        setShowLatestPill(false);
      } else if (previous.anchor && restoreFeedAnchor(previous.anchor)) {
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
      }
    }
    snapshotViewportAnchor(container);
  }, [collapseLayoutSignature, getRealContentBottom, restoreFeedAnchor, setContainerScrollTop, snapshotViewportAnchor]);

  // Scroll-to-turn: triggered from the Session Tasks panel
  const scrollToTurnId = useStore((s) => s.scrollToTurnId.get(sessionId));
  const clearScrollToTurn = useStore((s) => s.clearScrollToTurn);
  useEffect(() => {
    if (!scrollToTurnId) return;
    clearScrollToTurn(sessionId);
    autoFollowEnabledRef.current = false;
    // Expand the target turn's activity if needed.
    const overrides = useStore.getState().turnActivityOverrides.get(sessionId);
    const isExpanded = overrides?.get(scrollToTurnId);
    if (isExpanded !== true) {
      useStore.getState().keepTurnExpanded(sessionId, scrollToTurnId);
    }
    const sectionChanged = ensureSectionForTurnVisible(scrollToTurnId);
    const scheduleScroll = () => {
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el) return;
        const target = el.querySelector(`[data-turn-id="${escapeSelectorValue(scrollToTurnId)}"]`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    };
    if (sectionChanged) {
      requestAnimationFrame(scheduleScroll);
      return;
    }
    scheduleScroll();
  }, [clearScrollToTurn, ensureSectionForTurnVisible, scrollToTurnId, sessionId]);

  // Scroll-to-message: triggered from QuestmasterPage version history clicks.
  // Finds the turn containing the target message, focuses it (expand target,
  // collapse all others except last), and scrolls to the specific message element.
  const scrollToMessageId = useStore((s) => s.scrollToMessageId.get(sessionId));
  const clearScrollToMessage = useStore((s) => s.clearScrollToMessage);
  useEffect(() => {
    if (!scrollToMessageId) return;
    clearScrollToMessage(sessionId);
    autoFollowEnabledRef.current = false;

    // Find which turn contains this message
    const targetTurn = turns.find(
      (t) =>
        t.allEntries.some((e) => e.kind === "message" && e.msg.id === scrollToMessageId) ||
        (t.userEntry?.kind === "message" && t.userEntry.msg.id === scrollToMessageId),
    );
    if (!targetTurn) return;

    // Focus: expand target turn, all others revert to defaults (last expanded, rest collapsed)
    useStore.getState().focusTurn(sessionId, targetTurn.id);
    const sectionChanged = ensureSectionForTurnVisible(targetTurn.id);

    // Wait for DOM to settle, then scroll to the specific message
    const scheduleScroll = () => {
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el) return;
        const target = el.querySelector(`[data-message-id="${escapeSelectorValue(scrollToMessageId)}"]`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    };
    if (sectionChanged) {
      requestAnimationFrame(scheduleScroll);
      return;
    }
    scheduleScroll();
  }, [clearScrollToMessage, ensureSectionForTurnVisible, scrollToMessageId, sessionId, turns]);

  // Track which task outline chip should be highlighted based on scroll position.
  // The reference line is near the container top (with a small offset to avoid
  // edge-triggering). The last task-trigger turn whose top has scrolled past
  // this line is the active task — matching the chip-click behavior which
  // scrolls the trigger to the top of the viewport.
  // Uses a scroll listener instead of IntersectionObserver so the callback
  // fires on every scroll frame, not just on intersection threshold crossings.
  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const setActiveTaskTurnId = useStore((s) => s.setActiveTaskTurnId);
  const taskTriggerIds = useMemo(
    () => new Set((taskHistory || []).map((task) => task.triggerMessageId)),
    [taskHistory],
  );
  const firstTaskTurnId = taskHistory?.[0]?.triggerMessageId ?? null;

  const rebuildTaskTurnOffsets = useCallback(() => {
    const el = containerRef.current;
    if (!el || taskTriggerIds.size === 0) {
      taskTurnOffsetsRef.current = [];
      return;
    }
    const nextOffsets: TurnOffsetIndex[] = [];
    const targets = el.querySelectorAll<HTMLElement>("[data-turn-id]");
    for (const target of targets) {
      const turnId = target.dataset.turnId;
      if (!turnId || !taskTriggerIds.has(turnId)) continue;
      nextOffsets.push({ turnId, offsetTop: target.offsetTop });
    }
    taskTurnOffsetsRef.current = nextOffsets;
  }, [taskTriggerIds]);

  useLayoutEffect(() => {
    rebuildTaskTurnOffsets();
    if (containerRef.current) {
      setActiveTaskTurnId(
        sessionId,
        findActiveTaskTurnIdForScroll(taskTurnOffsetsRef.current, containerRef.current.scrollTop, firstTaskTurnId),
      );
    }

    const el = containerRef.current;
    if (!el || taskTriggerIds.size === 0 || typeof ResizeObserver === "undefined") {
      return;
    }

    let rafId = 0;
    const scheduleRebuild = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rebuildTaskTurnOffsets();
        setActiveTaskTurnId(
          sessionId,
          findActiveTaskTurnIdForScroll(taskTurnOffsetsRef.current, el.scrollTop, firstTaskTurnId),
        );
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleRebuild();
    });
    const targets = el.querySelectorAll<HTMLElement>("[data-turn-id]");
    targets.forEach((target) => observer.observe(target));

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [firstTaskTurnId, rebuildTaskTurnOffsets, sessionId, setActiveTaskTurnId, taskTriggerIds, visibleTurns]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !taskHistory || taskHistory.length === 0) return;

    let rafId = 0;
    const recalc = () => {
      const activeTurnId = findActiveTaskTurnIdForScroll(taskTurnOffsetsRef.current, el.scrollTop, firstTaskTurnId);
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
  }, [firstTaskTurnId, sessionId, setActiveTaskTurnId, taskHistory, visibleTurns]);

  // ─── Render ──────────────────────────────────────────────────────────────

  if (showConversationLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 select-none px-6">
        <YarnBallSpinner className="w-5 h-5 text-cc-primary" />
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">Loading conversation...</p>
          <p className="text-xs text-cc-muted leading-relaxed">Restoring recent history for this session.</p>
        </div>
      </div>
    );
  }

  if (messages.length === 0 && pendingCodexInputs.length === 0 && !streamingText) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 select-none px-6">
        <SleepingCat className="w-20 h-14" />
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">Start a conversation</p>
          <p className="text-xs text-cc-muted leading-relaxed">Send a message to begin working with The Companion.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-3 sm:px-4 py-4 sm:py-6"
          style={{ overscrollBehavior: "contain" }}
        >
          <PawScrollProvider scrollRef={containerRef}>
            <PawCounterContext.Provider value={pawCounter}>
              <div ref={contentRootRef} className="max-w-3xl mx-auto space-y-3 sm:space-y-5">
                {hasOlderSections && (
                  <div className="flex justify-center pb-2">
                    <button
                      type="button"
                      onClick={handleLoadOlderSection}
                      className="inline-flex items-center gap-1.5 rounded-full border border-cc-border bg-cc-card px-3 py-1.5 text-xs text-cc-muted transition-colors hover:bg-cc-hover cursor-pointer"
                    >
                      <YarnBallSpinner className="h-3 w-3 text-cc-muted" />
                      Load older section
                    </button>
                  </div>
                )}
                <TurnEntries
                  sections={visibleSections}
                  sessionId={sessionId}
                  leaderMode={isLeaderSession}
                  isCodexSession={isCodexSession}
                  activeCodexTerminalIds={activeCodexTerminalIds}
                  onOpenCodexTerminal={setSelectedCodexTerminalId}
                  turnStates={turnStates}
                  toggleTurn={toggleTurn}
                />
                {hasNewerSections && (
                  <div className="flex justify-center pt-1">
                    <button
                      type="button"
                      onClick={handleLoadNewerSection}
                      className="inline-flex items-center gap-1.5 rounded-full border border-cc-border bg-cc-card px-3 py-1.5 text-xs text-cc-muted transition-colors hover:bg-cc-hover cursor-pointer"
                    >
                      <YarnBallSpinner className="h-3 w-3 text-cc-muted" />
                      Load newer section
                    </button>
                  </div>
                )}
                {isCodexSession && pendingCodexInputs.length > 0 && (
                  <PendingCodexInputList sessionId={sessionId} inputs={pendingCodexInputs} />
                )}
                <FeedFooter sessionId={sessionId} />
                <div
                  aria-hidden="true"
                  className="pointer-events-none"
                  data-feed-end-slack="true"
                  style={{ height: `${feedEndScrollSlack}px` }}
                />
              </div>
            </PawCounterContext.Provider>
          </PawScrollProvider>
        </div>

        <FeedStatusPill sessionId={sessionId} onVisibleHeightChange={setFloatingStatusHeight} />

        {(visibleCodexTerminalRailEntries.length > 0 || visibleLiveSubagentEntries.length > 0) && (
          <LiveActivityRail
            terminals={visibleCodexTerminalRailEntries}
            subagents={visibleLiveSubagentEntries}
            selectedToolUseId={selectedCodexTerminalId}
            onSelect={setSelectedCodexTerminalId}
            onSelectSubagent={(taskToolUseId, turnId) => {
              scrollToFeedBlock(getSubagentFeedBlockId(taskToolUseId), turnId);
            }}
            onDismissSubagent={(taskToolUseId, freshnessToken) => {
              setDismissedSubagentChips((prev) => {
                const next = new Map(prev);
                next.set(taskToolUseId, freshnessToken);
                return next;
              });
            }}
          />
        )}

        {isCodexSession && selectedCodexTerminal && (
          <CodexTerminalInspector
            sessionId={sessionId}
            terminal={selectedCodexTerminal}
            onClose={() => setSelectedCodexTerminalId(null)}
          />
        )}

        {showLatestPill && latestIndicatorMode !== "external" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3 sm:px-4">
            <button
              type="button"
              onClick={handleScrollToBottomClick}
              className="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full border border-cc-primary/25 bg-cc-card/95 px-4 py-2 text-sm font-medium text-cc-fg shadow-lg backdrop-blur-sm transition-colors hover:bg-cc-hover cursor-pointer"
              title="Jump to latest"
              aria-label="Jump to latest"
            >
              <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-cc-primary animate-pulse" />
              <span className="truncate">New content below</span>
            </button>
          </div>
        )}

        {/* Navigation FABs — desktop: top, prev/next, bottom; mobile: top/bottom only, auto-hide */}
        {showScrollButton && (
          <div
            className={`absolute bottom-3 right-3 z-10 flex flex-col transition-opacity duration-300 ${
              isTouch ? `gap-1.5 ${isScrolling ? "opacity-60" : "opacity-0 pointer-events-none"}` : "gap-4"
            }`}
          >
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
              onClick={handleScrollToBottomClick}
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
    </div>
  );
}
