import { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback, memo } from "react";
import { useStore } from "../store.js";
import { MessageBubble } from "./MessageBubble.js";
import { ToolBlock, getToolIcon, getToolLabel, ToolIcon, formatDuration } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CollapseFooter, TurnCollapseFooter } from "./CollapseFooter.js";
import { api } from "../api.js";
import type { ChatMessage, ContentBlock } from "../types.js";
import { YarnBallDot, YarnBallSpinner, SleepingCat } from "./CatIcons.js";
import { PawTrailAvatar, PawCounterContext, PawScrollProvider, HidePawContext } from "./PawTrail.js";
import { isTouchDevice } from "../utils/mobile.js";

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

// ─── Message-level grouping ─────────────────────────────────────────────────

interface ToolItem { id: string; name: string; input: Record<string, unknown> }

interface ToolMsgGroup {
  kind: "tool_msg_group";
  toolName: string;
  items: ToolItem[];
  firstId: string;
}

interface SubagentGroup {
  kind: "subagent";
  taskToolUseId: string;
  description: string;
  agentType: string;
  taskInput: Record<string, unknown> | null;
  children: FeedEntry[];
  isBackground: boolean;
}

interface SubagentBatch {
  kind: "subagent_batch";
  subagents: SubagentGroup[];
}

type FeedEntry =
  | { kind: "message"; msg: ChatMessage }
  | ToolMsgGroup
  | SubagentGroup
  | SubagentBatch;

/**
 * Get the dominant tool name if this message is "tool-only"
 * (assistant message whose contentBlocks are ALL tool_use of the same name).
 * Returns null if it has text/thinking or mixed tool types.
 */
function getToolOnlyName(msg: ChatMessage): string | null {
  if (msg.role !== "assistant") return null;
  // Some SDK payloads carry assistant text only in `content` while contentBlocks
  // contain tool_use entries. Treat those as mixed messages, not tool-only.
  if (msg.content.trim()) return null;
  const blocks = msg.contentBlocks;
  if (!blocks || blocks.length === 0) return null;

  let toolName: string | null = null;
  for (const b of blocks) {
    if (b.type === "text" && b.text.trim()) return null;
    if (b.type === "thinking") return null;
    if (b.type === "tool_use") {
      if (toolName === null) toolName = b.name;
      else if (toolName !== b.name) return null;
    }
  }
  return toolName;
}

function extractToolItems(msg: ChatMessage): ToolItem[] {
  const blocks = msg.contentBlocks || [];
  return blocks
    .filter((b): b is ContentBlock & { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

/** Get Task tool_use IDs from a feed entry */
function getTaskIdsFromEntry(entry: FeedEntry): string[] {
  if (entry.kind === "message") {
    const blocks = entry.msg.contentBlocks || [];
    return blocks
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .filter(b => b.name === "Task")
      .map(b => b.id);
  }
  if (entry.kind === "tool_msg_group" && entry.toolName === "Task") {
    return entry.items.map(item => item.id);
  }
  return [];
}

/** Group consecutive same-tool messages */
function groupToolMessages(messages: ChatMessage[]): FeedEntry[] {
  const entries: FeedEntry[] = [];

  for (const msg of messages) {
    const toolName = getToolOnlyName(msg);

    if (toolName) {
      const last = entries[entries.length - 1];
      if (last?.kind === "tool_msg_group" && last.toolName === toolName) {
        last.items.push(...extractToolItems(msg));
        continue;
      }
      entries.push({
        kind: "tool_msg_group",
        toolName,
        items: extractToolItems(msg),
        firstId: msg.id,
      });
    } else {
      entries.push({ kind: "message", msg });
    }
  }

  return entries;
}

/** Build feed entries with subagent nesting.
 *  Task ToolMsgGroups are absorbed into SubagentGroups so the Task tool_use
 *  and its children render as a single unified card. */
function buildEntries(
  messages: ChatMessage[],
  taskInfo: Map<string, { description: string; agentType: string; input: Record<string, unknown> }>,
  childrenByParent: Map<string, ChatMessage[]>,
): FeedEntry[] {
  const grouped = groupToolMessages(messages);

  const result: FeedEntry[] = [];
  for (const entry of grouped) {
    const taskIds = getTaskIdsFromEntry(entry);

    if (taskIds.length === 0) {
      // Non-Task entry — push as-is
      result.push(entry);
      continue;
    }

    // Case A: Pure Task ToolMsgGroup — absorb entirely into SubagentGroups
    if (entry.kind === "tool_msg_group" && entry.toolName === "Task") {
      for (const taskId of taskIds) {
        const info = taskInfo.get(taskId) || { description: "Subagent", agentType: "", input: {} };
        const children = childrenByParent.get(taskId);
        const childEntries = children && children.length > 0
          ? buildEntries(children, taskInfo, childrenByParent)
          : [];
        result.push({
          kind: "subagent",
          taskToolUseId: taskId,
          description: info.description,
          agentType: info.agentType,
          taskInput: info.input,
          children: childEntries,
          isBackground: !!info.input?.run_in_background,
        });
      }
      continue;
    }

    // Case B: Mixed message (text + Task tool_use) — filter Task blocks from contentBlocks
    // (they render as SubagentContainers instead), then push SubagentGroups
    if (entry.kind === "message") {
      const filteredBlocks = entry.msg.contentBlocks?.filter(
        (b) => !(b.type === "tool_use" && b.name === "Task")
      );
      result.push({ kind: "message", msg: { ...entry.msg, contentBlocks: filteredBlocks } });
    } else {
      result.push(entry);
    }
    for (const taskId of taskIds) {
      const info = taskInfo.get(taskId) || { description: "Subagent", agentType: "", input: {} };
      const children = childrenByParent.get(taskId);
      const childEntries = children && children.length > 0
        ? buildEntries(children, taskInfo, childrenByParent)
        : [];
      result.push({
        kind: "subagent",
        taskToolUseId: taskId,
        description: info.description,
        agentType: info.agentType,
        taskInput: info.input,
        children: childEntries,
        isBackground: !!info.input?.run_in_background,
      });
    }
  }

  return result;
}

function groupMessages(messages: ChatMessage[]): FeedEntry[] {
  // Phase 1: Find all Task tool_use IDs across all messages
  const taskInfo = new Map<string, { description: string; agentType: string; input: Record<string, unknown> }>();
  for (const msg of messages) {
    if (!msg.contentBlocks) continue;
    for (const b of msg.contentBlocks) {
      if (b.type === "tool_use" && b.name === "Task") {
        const { input, id } = b;
        taskInfo.set(id, {
          description: String(input?.description || "Subagent"),
          agentType: String(input?.subagent_type || ""),
          input: (input || {}) as Record<string, unknown>,
        });
      }
    }
  }

  // Phase 2: Partition into top-level and child messages.
  // Also detect orphaned children whose parent Task block was lost (e.g. due to
  // message dedup dropping a split assistant message). Create synthetic taskInfo
  // entries so they still get grouped under a SubagentContainer.
  const childrenByParent = new Map<string, ChatMessage[]>();
  const topLevel: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.parentToolUseId) {
      if (!taskInfo.has(msg.parentToolUseId)) {
        // Orphaned child — parent Task block was lost. Create synthetic entry.
        taskInfo.set(msg.parentToolUseId, { description: "Subagent", agentType: "", input: {} });
      }
      let arr = childrenByParent.get(msg.parentToolUseId);
      if (!arr) { arr = []; childrenByParent.set(msg.parentToolUseId, arr); }
      arr.push(msg);
    } else {
      topLevel.push(msg);
    }
  }

  // If no Task tool_uses found (including synthetic), skip the overhead
  if (taskInfo.size === 0) {
    return groupToolMessages(messages);
  }

  // Phase 3: Build grouped entries with subagent nesting.
  // Orphaned subagent groups (no parent entry in topLevel) are appended at the end.
  const entries = buildEntries(topLevel, taskInfo, childrenByParent);

  // Emit any orphaned subagent groups whose parent Task wasn't in any top-level entry
  const emittedTaskIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "subagent") emittedTaskIds.add(entry.taskToolUseId);
  }
  for (const [taskId, children] of childrenByParent) {
    if (emittedTaskIds.has(taskId)) continue;
    if (children.length === 0) continue;
    const info = taskInfo.get(taskId) || { description: "Subagent", agentType: "", input: {} };
    const childEntries = buildEntries(children, taskInfo, childrenByParent);
    entries.push({
      kind: "subagent",
      taskToolUseId: taskId,
      description: info.description,
      agentType: info.agentType,
      taskInput: info.input || null,
      children: childEntries,
      isBackground: !!info.input?.run_in_background,
    });
  }

  return batchSubagents(entries);
}

/** Group consecutive SubagentGroup entries into SubagentBatch wrappers. */
function batchSubagents(entries: FeedEntry[]): FeedEntry[] {
  const result: FeedEntry[] = [];
  let i = 0;

  while (i < entries.length) {
    if (entries[i].kind === "subagent") {
      const batch: SubagentGroup[] = [];
      while (i < entries.length && entries[i].kind === "subagent") {
        batch.push(entries[i] as SubagentGroup);
        i++;
      }

      if (batch.length >= 2) {
        result.push({ kind: "subagent_batch", subagents: batch });
      } else {
        result.push(batch[0]);
      }
    } else {
      result.push(entries[i]);
      i++;
    }
  }

  return result;
}

// ─── Turn grouping (collapsible agent activity) ─────────────────────────────

interface TurnStats {
  messageCount: number;
  toolCount: number;
  subagentCount: number;
}

interface Turn {
  id: string;                      // Stable ID for collapse state (user msg ID or synthetic)
  userEntry: FeedEntry | null;
  allEntries: FeedEntry[];         // All entries in original order (for expanded rendering)
  agentEntries: FeedEntry[];       // Non-system agent activity (collapsible), excludes responseEntry
  systemEntries: FeedEntry[];      // System messages (always visible, never collapsed)
  responseEntry: FeedEntry | null; // Default-visible assistant response entry (leader mode: only @user messages)
  stats: TurnStats;
}

/** Count tool_use blocks and subagents recursively in a list of FeedEntries */
function countEntryStats(entries: FeedEntry[]): { messages: number; tools: number; subagents: number; lastText: string } {
  let messages = 0;
  let tools = 0;
  let subagents = 0;
  let lastText = "";

  for (const entry of entries) {
    if (entry.kind === "message") {
      const msg = entry.msg;
      if (msg.role === "assistant") {
        // Count tool_use blocks
        let entryTools = 0;
        if (msg.contentBlocks) {
          for (const b of msg.contentBlocks) {
            if (b.type === "tool_use") entryTools++;
          }
        }
        tools += entryTools;
        // Only count as a "message" if it has text content (not just tool invocations)
        const text = msg.content?.trim();
        if (text) {
          messages++;
          lastText = text;
        }
      } else {
        // Non-assistant messages (e.g. user, system) count as messages
        messages++;
      }
    } else if (entry.kind === "tool_msg_group") {
      // Tool results — only count as tools, not messages
      tools += entry.items.length;
    } else if (entry.kind === "subagent") {
      subagents++;
      const childStats = countEntryStats(entry.children);
      messages += childStats.messages;
      tools += childStats.tools;
      subagents += childStats.subagents;
      if (childStats.lastText) lastText = childStats.lastText;
    } else if (entry.kind === "subagent_batch") {
      for (const sg of entry.subagents) {
        subagents++;
        const childStats = countEntryStats(sg.children);
        messages += childStats.messages;
        tools += childStats.tools;
        subagents += childStats.subagents;
        if (childStats.lastText) lastText = childStats.lastText;
      }
    }
  }

  return { messages, tools, subagents, lastText };
}

/** Check if a FeedEntry is a system message (compact markers, errors, info dividers).
 *  Permission denied/approved badges and quest_claimed blocks are NOT system entries
 *  — they flow with agent activity so they appear at the correct chronological position in the turn. */
function isSystemEntry(entry: FeedEntry): boolean {
  if (entry.kind !== "message" || entry.msg.role !== "system") return false;
  if (entry.msg.variant === "denied" || entry.msg.variant === "approved" || entry.msg.variant === "quest_claimed") return false;
  return true;
}

/** Get a stable ID for an entry (for use as turn ID fallback) */
function getEntryId(entry: FeedEntry): string {
  if (entry.kind === "message") return entry.msg.id;
  if (entry.kind === "tool_msg_group") return entry.firstId;
  if (entry.kind === "subagent_batch") return entry.subagents[0]?.taskToolUseId || "batch";
  return entry.taskToolUseId;
}

/** Build a Turn from accumulated entries */
function makeTurn(userEntry: FeedEntry | null, entries: FeedEntry[], turnIndex: number, leaderMode = false): Turn {
  // Separate system messages (always visible) from collapsible agent activity
  const agentEntries: FeedEntry[] = [];
  const systemEntries: FeedEntry[] = [];
  for (const e of entries) {
    if (isSystemEntry(e)) {
      systemEntries.push(e);
    } else {
      agentEntries.push(e);
    }
  }

  // Count stats on ALL agent entries before extracting the response
  const s = countEntryStats(agentEntries);

  // Extract the default-visible response entry.
  // Normal sessions: final assistant text.
  // Leader sessions: final assistant text explicitly addressed to human (@user:).
  let responseEntry: FeedEntry | null = null;
  for (let i = agentEntries.length - 1; i >= 0; i--) {
    const e = agentEntries[i];
    if (
      e.kind === "message"
      && e.msg.role === "assistant"
      && e.msg.content?.trim()
      && (!leaderMode || e.msg.leaderUserAddressed === true)
    ) {
      responseEntry = e;
      agentEntries.splice(i, 1);
      break;
    }
  }

  // Stable ID: prefer user message ID, fall back to first agent entry ID, then synthetic
  const id = userEntry
    ? (userEntry.kind === "message" ? userEntry.msg.id : `turn-u-${turnIndex}`)
    : (entries.length > 0 ? `turn-a-${getEntryId(entries[0])}` : `turn-${turnIndex}`);

  return {
    id,
    userEntry,
    allEntries: entries,
    agentEntries,
    systemEntries,
    responseEntry,
    stats: {
      // Subtract 1 for the responseEntry since it's shown separately below the bar
      messageCount: responseEntry ? s.messages - 1 : s.messages,
      toolCount: s.tools,
      subagentCount: s.subagents,
    },
  };
}

/** Group flat feed entries into turns, splitting on user messages */
function groupIntoTurns(entries: FeedEntry[], leaderMode = false): Turn[] {
  const turns: Turn[] = [];
  let currentUser: FeedEntry | null = null;
  let currentEntries: FeedEntry[] = [];

  for (const entry of entries) {
    const isUser = entry.kind === "message" && entry.msg.role === "user"
      && entry.msg.agentSource?.sessionId !== "herd-events"; // Herd events don't start new turns
    if (isUser) {
      // Flush previous turn
      if (currentUser !== null || currentEntries.length > 0) {
        turns.push(makeTurn(currentUser, currentEntries, turns.length, leaderMode));
      }
      currentUser = entry;
      currentEntries = [];
    } else {
      currentEntries.push(entry);
    }
  }

  // Flush final turn
  if (currentUser !== null || currentEntries.length > 0) {
    turns.push(makeTurn(currentUser, currentEntries, turns.length, leaderMode));
  }

  return turns;
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
                  <ToolBlock key={item.id || i} name={item.name} input={item.input} toolUseId={item.id} sessionId={sessionId} />
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

const FeedEntries = memo(function FeedEntries({
  entries,
  sessionId,
  minuteBoundaryLabels,
}: {
  entries: FeedEntry[];
  sessionId: string;
  minuteBoundaryLabels?: Map<string, string>;
}) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.kind === "tool_msg_group") {
          return <ToolMessageGroup key={entry.firstId || i} group={entry} sessionId={sessionId} />;
        }
        if (entry.kind === "subagent") {
          return <SubagentContainer key={entry.taskToolUseId} group={entry} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />;
        }
        if (entry.kind === "subagent_batch") {
          return <SubagentBatchContainer key={entry.subagents[0]?.taskToolUseId || i} batch={entry} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />;
        }
        if (isTimedChatMessage(entry.msg)) {
          const markerLabel = minuteBoundaryLabels?.get(entry.msg.id);
          const showTimestamp = entry.msg.role === "assistant" && typeof entry.msg.turnDurationMs === "number";
          return (
            <div key={entry.msg.id} data-message-id={entry.msg.id}>
              {markerLabel && <MinuteBoundaryTimestamp timestamp={entry.msg.timestamp} label={markerLabel} />}
              <MessageBubble message={entry.msg} sessionId={sessionId} showTimestamp={showTimestamp} />
            </div>
          );
        }
        return <div key={entry.msg.id} data-message-id={entry.msg.id}><MessageBubble message={entry.msg} sessionId={sessionId} /></div>;
      })}
    </>
  );
});

/** Compact bar showing agent activity stats. Click to expand the full activity. */
const CollapsedActivityBar = memo(function CollapsedActivityBar({ stats, onClick }: { stats: TurnStats; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-1.5 py-1.5 px-3 hover:bg-cc-hover/30 transition-colors cursor-pointer text-[11px] text-cc-muted font-mono-code"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/60">
        <path d="M6 4l4 4-4 4" />
      </svg>
      {stats.messageCount > 0 && (
        <span>{stats.messageCount} message{stats.messageCount !== 1 ? "s" : ""}</span>
      )}
      {stats.toolCount > 0 && (
        <>
          {stats.messageCount > 0 && <span className="text-cc-muted/40">·</span>}
          <span>{stats.toolCount} tool{stats.toolCount !== 1 ? "s" : ""}</span>
        </>
      )}
      {stats.subagentCount > 0 && (
        <>
          {(stats.messageCount > 0 || stats.toolCount > 0) && <span className="text-cc-muted/40">·</span>}
          <span>{stats.subagentCount} agent{stats.subagentCount !== 1 ? "s" : ""}</span>
        </>
      )}
    </button>
  );
});

/** Thin clickable bar to collapse an expanded turn's agent activity */
function TurnCollapseBar({ stats, onClick, ref }: { stats: TurnStats; onClick: () => void; ref?: React.Ref<HTMLButtonElement> }) {
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
      {stats.messageCount > 0 && (
        <span>{stats.messageCount} message{stats.messageCount !== 1 ? "s" : ""}</span>
      )}
      {stats.toolCount > 0 && (
        <>
          {stats.messageCount > 0 && <span className="text-cc-muted/30">·</span>}
          <span>{stats.toolCount} tool{stats.toolCount !== 1 ? "s" : ""}</span>
        </>
      )}
    </button>
  );
}

const TurnEntriesExpanded = memo(function TurnEntriesExpanded({
  turn,
  sessionId,
  onCollapse,
  minuteBoundaryLabels,
}: {
  turn: Turn;
  sessionId: string;
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
  const [bgOutput, setBgOutput] = useState<string | null>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  const label = group.description || "Subagent";
  const agentType = group.agentType;
  const childCount = group.children.length;
  const hasPrompt = !!group.taskInput?.prompt;

  // Read the subagent's final result from the toolResults store
  const resultPreview = useStore((s) => s.toolResults.get(sessionId)?.get(group.taskToolUseId));
  const progressElapsedSeconds = useStore((s) =>
    s.toolProgress.get(sessionId)?.get(group.taskToolUseId)?.elapsedSeconds
  );
  const startTimestamp = useStore((s) =>
    s.toolStartTimestamps.get(sessionId)?.get(group.taskToolUseId)
  );

  // Read background agent notification
  const bgNotif = useStore((s) =>
    s.backgroundAgentNotifs.get(sessionId)?.get(group.taskToolUseId)
  );

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
    return lastPreview;
  }, [parsedResultPreview, lastPreview]);

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
          isComplete={resultPreview != null}
        />
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
          {childCount > 0
            ? childCount
            : resultPreview
              ? "✓"
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
              <button
                onClick={() => setPromptOpen(!promptOpen)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${promptOpen ? "rotate-90" : ""}`}>
                  <path d="M6 4l4 4-4 4" />
                </svg>
                <span className="text-[11px] font-medium text-cc-muted">Prompt</span>
              </button>
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
          {childCount > 0 && (
            <div className="px-3 py-2 space-y-3">
              <FeedEntries entries={group.children} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />
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
          {childCount === 0 && !resultPreview && !bgNotif && (
            <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-cc-muted">
              <YarnBallSpinner className="w-3.5 h-3.5" />
              <span>{group.isBackground ? "Running in background..." : "Agent starting..."}</span>
            </div>
          )}

          {/* Result */}
          {resultPreview && (
            <SubagentResult
              preview={resultPreview}
              parsedText={parsedResultPreview}
              sessionId={sessionId}
              toolUseId={group.taskToolUseId}
            />
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
    <div className="border-t border-cc-border/50 px-3 pt-2 pb-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary/60 shrink-0">
          <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5a.75.75 0 011.5 0v.5a.75.75 0 01-1.5 0V5zM6.5 7.75A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.5h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-1.75H7.25a.75.75 0 01-.75-.75z" />
        </svg>
        <span className="text-[11px] font-medium text-cc-muted">Result</span>
        {loading && (
          <svg className="w-3 h-3 animate-spin text-cc-muted" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </div>
      <div className="text-sm max-h-96 overflow-y-auto">
        <MarkdownContent text={displayText} />
      </div>
    </div>
  );
}


// ─── Self-subscribing footer (isolates rapid store updates from the feed) ────

const FeedFooter = memo(function FeedFooter({ sessionId }: { sessionId: string }) {
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const streamingText = useStore((s) => s.streaming.get(sessionId));
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const [codexStreamingText, setCodexStreamingText] = useState("");
  const codexPendingTextRef = useRef("");
  const codexFlushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isCodexSession) {
      if (codexFlushTimerRef.current !== null) {
        window.clearTimeout(codexFlushTimerRef.current);
        codexFlushTimerRef.current = null;
      }
      codexPendingTextRef.current = "";
      if (codexStreamingText) setCodexStreamingText("");
      return;
    }

    const next = streamingText || "";
    codexPendingTextRef.current = next;

    if (!next) {
      if (codexFlushTimerRef.current !== null) {
        window.clearTimeout(codexFlushTimerRef.current);
        codexFlushTimerRef.current = null;
      }
      if (codexStreamingText) setCodexStreamingText("");
      return;
    }

    // First chunk should show immediately.
    if (!codexStreamingText) {
      setCodexStreamingText(next);
      return;
    }

    // Flush whole lines immediately; otherwise throttle markdown re-renders.
    if (next.endsWith("\n")) {
      if (codexFlushTimerRef.current !== null) {
        window.clearTimeout(codexFlushTimerRef.current);
        codexFlushTimerRef.current = null;
      }
      if (codexStreamingText !== next) setCodexStreamingText(next);
      return;
    }

    if (codexFlushTimerRef.current !== null) return;
    codexFlushTimerRef.current = window.setTimeout(() => {
      codexFlushTimerRef.current = null;
      setCodexStreamingText((prev) => (
        prev === codexPendingTextRef.current ? prev : codexPendingTextRef.current
      ));
    }, 120);
  }, [isCodexSession, streamingText, codexStreamingText]);

  useEffect(() => {
    return () => {
      if (codexFlushTimerRef.current !== null) {
        window.clearTimeout(codexFlushTimerRef.current);
        codexFlushTimerRef.current = null;
      }
    };
  }, []);

  return (
    <>
      {/* Tool progress indicator */}
      {toolProgress && toolProgress.size > 0 && !streamingText && !isCodexSession && (
        <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
          <YarnBallDot className="text-cc-primary animate-pulse" />
          {Array.from(toolProgress.values()).map((p, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-cc-muted/40">·</span>}
              <span>{getToolLabel(p.toolName)}</span>
              <span className="text-cc-muted/60">{p.elapsedSeconds}s</span>
            </span>
          ))}
        </div>
      )}

      {/* Streaming indicator */}
      {streamingText && (
        <div className="animate-[fadeSlideIn_0.2s_ease-out]">
          <div className="flex items-start gap-3">
            <PawTrailAvatar isStreaming />
            <div className="flex-1 min-w-0">
              {isCodexSession ? (
                <div>
                  <MarkdownContent text={codexStreamingText || streamingText} />
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
  const overrides = useStore((s) => s.turnActivityOverrides.get(sessionId));
  const toggleTurn = useStore((s) => s.toggleTurnActivity);
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const minuteBoundaryLabels = useMemo(() => {
    const visibleTimedMessages: ChatMessage[] = [];

    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index];
      const isLastTurn = index === turns.length - 1;
      const isPenultimateTurn = index === turns.length - 2;
      const lastTurn = turns[turns.length - 1];
      const lastTurnIsFreshUserOnly = !!lastTurn?.userEntry && lastTurn.allEntries.length === 0;
      const keepExpandedDuringStreaming =
        sessionStatus === "running" && isPenultimateTurn && lastTurnIsFreshUserOnly;
      const override = overrides?.get(turn.id);
      const defaultExpanded = leaderMode
        ? (
            keepExpandedDuringStreaming
            || (isLastTurn && turn.responseEntry === null && turn.agentEntries.length === 0)
          )
        : (isLastTurn || turn.responseEntry === null || keepExpandedDuringStreaming);
      const isActivityExpanded = override !== undefined ? override : defaultExpanded;

      if (turn.userEntry?.kind === "message" && isTimedChatMessage(turn.userEntry.msg)) {
        visibleTimedMessages.push(turn.userEntry.msg);
      }

      if (isActivityExpanded) {
        appendTimedMessagesFromEntries(turn.allEntries, visibleTimedMessages);
      } else {
        appendTimedMessagesFromEntries(turn.systemEntries, visibleTimedMessages);
        if (turn.responseEntry?.kind === "message" && isTimedChatMessage(turn.responseEntry.msg)) {
          visibleTimedMessages.push(turn.responseEntry.msg);
        }
      }
    }

    return buildMinuteBoundaryLabelMap(visibleTimedMessages);
  }, [turns, overrides, sessionStatus]);

  return (
    <>
      {turns.map((turn, index) => {
        const isLastTurn = index === turns.length - 1;
        const isPenultimateTurn = index === turns.length - 2;
        const lastTurn = turns[turns.length - 1];
        const lastTurnIsFreshUserOnly = !!lastTurn?.userEntry && lastTurn.allEntries.length === 0;
        const keepExpandedDuringStreaming =
          sessionStatus === "running" && isPenultimateTurn && lastTurnIsFreshUserOnly;
        const override = overrides?.get(turn.id);
        const defaultExpanded = leaderMode
          ? (
              keepExpandedDuringStreaming
              || (isLastTurn && turn.responseEntry === null && turn.agentEntries.length === 0)
            )
          : (
              // Default: last turn expanded, older finished turns collapsed.
              // Keep in-flight turns expanded for both:
              // 1) turns without a final assistant text
              // 2) the previous turn while streaming a fresh user-only follow-up turn
              //    (Codex can be mid-turn with partial text/tool activity already emitted).
              isLastTurn || turn.responseEntry === null || keepExpandedDuringStreaming
            );
        const isActivityExpanded = override !== undefined ? override : defaultExpanded;

        return (
          <div key={turn.id} data-turn-id={turn.id} className="turn-container space-y-3 sm:space-y-5" data-user-turn={turn.userEntry ? "true" : undefined}>
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
                  minuteBoundaryLabels={minuteBoundaryLabels}
                  onCollapse={() => toggleTurn(sessionId, turn.id, isLastTurn)}
                />
              )
            ) : (
              <>
                {/* System messages — always visible */}
                {turn.systemEntries.length > 0 && (
                  <FeedEntries entries={turn.systemEntries} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />
                )}
                {/* Collapsed: single paw outside, activity bar + response in shared card */}
                {(turn.agentEntries.length > 0 || turn.responseEntry) && (
                  <div className="flex items-start gap-3">
                    <PawTrailAvatar />
                    <div className="flex-1 min-w-0 rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
                      {turn.agentEntries.length > 0 && (
                        <CollapsedActivityBar
                          stats={turn.stats}
                          onClick={() => toggleTurn(sessionId, turn.id, isLastTurn)}
                        />
                      )}
                      {turn.responseEntry && (
                        <div className="px-3 py-2.5">
                          <HidePawContext.Provider value={true}>
                            <FeedEntries entries={[turn.responseEntry]} sessionId={sessionId} minuteBoundaryLabels={minuteBoundaryLabels} />
                          </HidePawContext.Provider>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
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
  // Tracks the first render — used to scroll instantly on session switch
  // instead of smooth-scrolling. Cleared inside the auto-scroll effect itself
  // (not a separate effect) to avoid React's same-render effect batching.
  const isInitialRender = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isTouch = useMemo(() => isTouchDevice(), []);
  const loadingMore = useRef(false);
  const visibleCount = useStore((s) => s.feedVisibleCount.get(sessionId) ?? FEED_PAGE_SIZE);

  // Save scroll position on unmount. Uses useLayoutEffect so the cleanup runs
  // in the layout phase — BEFORE the new component's effects try to restore,
  // avoiding the race where useEffect cleanup runs too late.
  useLayoutEffect(() => {
    return () => {
      const el = containerRef.current;
      if (el) {
        useStore.getState().setFeedScrollPosition(sessionId, {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          isAtBottom: isNearBottom.current,
        });
      }
    };
  }, [sessionId]);

  const grouped = useMemo(() => groupMessages(messages), [messages]);
  const turns = useMemo(() => groupIntoTurns(grouped, isLeaderSession), [grouped, isLeaderSession]);

  const totalTurns = turns.length;
  const hasMore = totalTurns > visibleCount;
  const visibleTurns = hasMore ? turns.slice(totalTurns - visibleCount) : turns;

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

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    isNearBottom.current = nearBottom;
    // Only trigger a re-render when the button state actually changes
    const shouldShow = !nearBottom;
    setShowScrollButton((prev) => (prev === shouldShow ? prev : shouldShow));
    // Track active scrolling for mobile FAB auto-hide
    setIsScrolling(true);
    clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => setIsScrolling(false), 1500);
  }

  // Auto-scroll: on initial render, restore saved scroll position or jump to
  // bottom. On subsequent renders, keep "sticky to bottom" behavior if the
  // user is near bottom:
  // - during streaming: use immediate alignment to avoid smooth-scroll lag
  // - otherwise: keep smooth scrolling for non-streaming message arrivals
  // Throttled to avoid layout thrashing on heavy feeds.
  const lastScrollTime = useRef(0);
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      const pos = useStore.getState().feedScrollPosition.get(sessionId);
      if (pos && !pos.isAtBottom) {
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
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
      return;
    }
    if (isNearBottom.current) {
      const now = Date.now();
      const throttleMs = streamingText ? 80 : 200;
      if (now - lastScrollTime.current >= throttleMs) {
        lastScrollTime.current = now;
        const el = containerRef.current;
        if (el) {
          if (streamingText) {
            // Keep up with token streaming without animation backlog.
            el.scrollTop = el.scrollHeight;
          } else {
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }
        }
      }
    }
  }, [messages.length, streamingText]);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      isNearBottom.current = true;
      setShowScrollButton(false);
    }
  }, []);

  // Scroll-to-turn: triggered from the Session Tasks panel
  const scrollToTurnId = useStore((s) => s.scrollToTurnId.get(sessionId));
  const clearScrollToTurn = useStore((s) => s.clearScrollToTurn);
  useEffect(() => {
    if (!scrollToTurnId) return;
    clearScrollToTurn(sessionId);
    const el = containerRef.current;
    if (!el) return;
    // Expand the target turn's activity if it's collapsed
    const overrides = useStore.getState().turnActivityOverrides.get(sessionId);
    const isExpanded = overrides?.get(scrollToTurnId);
    if (isExpanded === false || isExpanded === undefined) {
      // Force expand by toggling (isLastTurn=false so toggle sets true)
      useStore.getState().toggleTurnActivity(sessionId, scrollToTurnId, false);
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
      const target = el.querySelector(`[data-message-id="${CSS.escape(scrollToMessageId)}"]`);
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
                  el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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
