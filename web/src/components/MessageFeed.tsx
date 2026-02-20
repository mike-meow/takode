import { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useStore } from "../store.js";
import { MessageBubble } from "./MessageBubble.js";
import { ToolBlock, getToolIcon, getToolLabel, ToolIcon } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CollapseFooter, TurnCollapseFooter } from "./CollapseFooter.js";
import { api } from "../api.js";
import type { ChatMessage, ContentBlock } from "../types.js";
import { YarnBallDot, YarnBallSpinner, SleepingCat } from "./CatIcons.js";
import { PawTrailAvatar, PawCounterContext, PawScrollProvider } from "./PawTrail.js";

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

// Self-contained timer component — its 1s tick only re-renders this element,
// not the entire MessageFeed (which would force all images to re-layout).
function ElapsedTimer({ sessionId }: { sessionId: string }) {
  const streamingStartedAt = useStore((s) => s.streamingStartedAt.get(sessionId));
  const streamingOutputTokens = useStore((s) => s.streamingOutputTokens.get(sessionId));
  const streamingPausedDuration = useStore((s) => s.streamingPausedDuration.get(sessionId) ?? 0);
  const streamingPauseStartedAt = useStore((s) => s.streamingPauseStartedAt.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
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

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
      <YarnBallDot className={streamingPauseStartedAt ? 'text-amber-400' : 'text-cc-primary animate-pulse'} />
      <span>{streamingPauseStartedAt ? 'Waiting...' : 'Generating...'}</span>
      <span className="text-cc-muted/60">(</span>
      <span>{formatElapsed(elapsed)}</span>
      {(streamingOutputTokens ?? 0) > 0 && (
        <>
          <span className="text-cc-muted/40">·</span>
          <span>↓ {formatTokens(streamingOutputTokens!)}</span>
        </>
      )}
      <span className="text-cc-muted/60">)</span>
    </div>
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
  lastAssistantText: string;
}

interface Turn {
  id: string;                      // Stable ID for collapse state (user msg ID or synthetic)
  userEntry: FeedEntry | null;
  allEntries: FeedEntry[];         // All entries in original order (for expanded rendering)
  agentEntries: FeedEntry[];       // Non-system agent activity (collapsible)
  systemEntries: FeedEntry[];      // System messages (always visible, never collapsed)
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
      messages++;
      const msg = entry.msg;
      if (msg.role === "assistant") {
        // Count tool_use blocks
        if (msg.contentBlocks) {
          for (const b of msg.contentBlocks) {
            if (b.type === "tool_use") tools++;
          }
        }
        // Track last assistant text
        const text = msg.content?.trim();
        if (text) lastText = text;
      }
    } else if (entry.kind === "tool_msg_group") {
      messages++;
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
 *  Permission denied/approved badges are NOT system entries — they flow with agent
 *  activity so they appear at the correct chronological position in the turn. */
function isSystemEntry(entry: FeedEntry): boolean {
  if (entry.kind !== "message" || entry.msg.role !== "system") return false;
  if (entry.msg.variant === "denied" || entry.msg.variant === "approved") return false;
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
function makeTurn(userEntry: FeedEntry | null, entries: FeedEntry[], turnIndex: number): Turn {
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

  const s = countEntryStats(agentEntries);

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
    stats: {
      messageCount: s.messages,
      toolCount: s.tools,
      subagentCount: s.subagents,
      lastAssistantText: s.lastText.length > 80 ? s.lastText.slice(0, 80) + "..." : s.lastText,
    },
  };
}

/** Group flat feed entries into turns, splitting on user messages */
function groupIntoTurns(entries: FeedEntry[]): Turn[] {
  const turns: Turn[] = [];
  let currentUser: FeedEntry | null = null;
  let currentEntries: FeedEntry[] = [];

  for (const entry of entries) {
    const isUser = entry.kind === "message" && entry.msg.role === "user";
    if (isUser) {
      // Flush previous turn
      if (currentUser !== null || currentEntries.length > 0) {
        turns.push(makeTurn(currentUser, currentEntries, turns.length));
      }
      currentUser = entry;
      currentEntries = [];
    } else {
      currentEntries.push(entry);
    }
  }

  // Flush final turn
  if (currentUser !== null || currentEntries.length > 0) {
    turns.push(makeTurn(currentUser, currentEntries, turns.length));
  }

  return turns;
}

// ─── Components ──────────────────────────────────────────────────────────────

function ToolMessageGroup({ group, sessionId }: { group: ToolMsgGroup; sessionId: string }) {
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
}

function FeedEntries({ entries, sessionId }: { entries: FeedEntry[]; sessionId: string }) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.kind === "tool_msg_group") {
          return <ToolMessageGroup key={entry.firstId || i} group={entry} sessionId={sessionId} />;
        }
        if (entry.kind === "subagent") {
          return <SubagentContainer key={entry.taskToolUseId} group={entry} sessionId={sessionId} />;
        }
        if (entry.kind === "subagent_batch") {
          return <SubagentBatchContainer key={entry.subagents[0]?.taskToolUseId || i} batch={entry} sessionId={sessionId} />;
        }
        return <MessageBubble key={entry.msg.id} message={entry.msg} sessionId={sessionId} />;
      })}
    </>
  );
}

function CollapsedTurnSummary({ stats, onClick }: { stats: TurnStats; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex flex-col gap-0.5 py-2 px-3 rounded-lg border border-cc-border/30 bg-cc-card/30 hover:bg-cc-hover/50 transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code">
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/60">
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span>{stats.messageCount} message{stats.messageCount !== 1 ? "s" : ""}</span>
        {stats.toolCount > 0 && (
          <>
            <span className="text-cc-muted/40">·</span>
            <span>{stats.toolCount} tool{stats.toolCount !== 1 ? "s" : ""}</span>
          </>
        )}
        {stats.subagentCount > 0 && (
          <>
            <span className="text-cc-muted/40">·</span>
            <span>{stats.subagentCount} agent{stats.subagentCount !== 1 ? "s" : ""}</span>
          </>
        )}
      </div>
      {stats.lastAssistantText && (
        <div className="text-[11px] text-cc-muted/60 truncate pl-[18px] italic font-mono-code">
          &ldquo;{stats.lastAssistantText}&rdquo;
        </div>
      )}
    </button>
  );
}

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
      <span>{stats.messageCount} message{stats.messageCount !== 1 ? "s" : ""}</span>
      {stats.toolCount > 0 && (
        <>
          <span className="text-cc-muted/30">·</span>
          <span>{stats.toolCount} tool{stats.toolCount !== 1 ? "s" : ""}</span>
        </>
      )}
    </button>
  );
}

function TurnEntriesExpanded({ turn, sessionId, onCollapse }: { turn: Turn; sessionId: string; onCollapse: () => void }) {
  const headerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {/* Per-turn collapse bar (only for turns with enough content) */}
      {turn.stats.messageCount > 1 && (
        <TurnCollapseBar
          ref={headerRef}
          stats={turn.stats}
          onClick={onCollapse}
        />
      )}
      {/* Render all entries interleaved in original chronological order */}
      <FeedEntries entries={turn.allEntries} sessionId={sessionId} />
      {/* Bottom collapse bar — appears when top bar scrolls out of view */}
      {turn.stats.messageCount > 1 && (
        <TurnCollapseFooter headerRef={headerRef} onCollapse={onCollapse} />
      )}
    </>
  );
}


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

function SubagentBatchContainer({ batch, sessionId }: { batch: SubagentBatch; sessionId: string }) {
  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0 space-y-2">
          {batch.subagents.map((sg) => (
            <SubagentContainer key={sg.taskToolUseId} group={sg} sessionId={sessionId} inBatch />
          ))}
        </div>
      </div>
    </div>
  );
}

function SubagentContainer({ group, sessionId, inBatch }: { group: SubagentGroup; sessionId: string; inBatch?: boolean }) {
  const [open, setOpen] = useState(true);
  const [promptOpen, setPromptOpen] = useState(false);
  const headerRef = useRef<HTMLButtonElement>(null);
  const label = group.description || "Subagent";
  const agentType = group.agentType;
  const childCount = group.children.length;
  const hasPrompt = !!group.taskInput?.prompt;

  // Read the subagent's final result from the toolResults store
  const resultPreview = useStore((s) => s.toolResults.get(sessionId)?.get(group.taskToolUseId));

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
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
          {childCount}
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
              <FeedEntries entries={group.children} sessionId={sessionId} />
            </div>
          )}

          {/* No children yet indicator */}
          {childCount === 0 && !resultPreview && (
            <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-cc-muted">
              <YarnBallSpinner className="w-3.5 h-3.5" />
              <span>Agent starting...</span>
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
}

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


// ─── Virtuoso context & stable Header/Footer ────────────────────────────────

interface FeedContext {
  hasMore: boolean;
  toolProgress: Map<string, { toolName: string; elapsedSeconds: number }> | undefined;
  streamingText: string | undefined;
  sessionStatus: string | null | undefined;
  sessionId: string;
}

function FeedHeader({ context }: { context?: FeedContext }) {
  return (
    <div className="px-3 sm:px-4 pt-4 sm:pt-6">
      {context?.hasMore && (
        <div className="max-w-3xl mx-auto flex justify-center pb-2">
          <span className="flex items-center gap-1.5 text-xs text-cc-muted">
            <YarnBallSpinner className="h-3 w-3 text-cc-muted" />
            Loading older messages...
          </span>
        </div>
      )}
    </div>
  );
}

function FeedFooter({ context }: { context?: FeedContext }) {
  if (!context) return <div className="pb-4 sm:pb-6" />;
  const { toolProgress, streamingText, sessionStatus, sessionId } = context;

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 pb-4 sm:pb-6">
      <div className="space-y-3 sm:space-y-5">
        {/* Tool progress indicator */}
        {toolProgress && toolProgress.size > 0 && !streamingText && (
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
                <pre className="font-serif-assistant text-[15px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                  {streamingText}
                  <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* Generation stats bar */}
        <ElapsedTimer sessionId={sessionId} />

        {/* Compacting indicator */}
        {sessionStatus === "compacting" && (
          <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
            <YarnBallDot className="text-cc-warning animate-pulse" />
            <span>Compacting conversation...</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Stable reference so Virtuoso doesn't remount Header/Footer on every render.
 *  Data is passed via context prop instead. */
const FEED_COMPONENTS = { Header: FeedHeader, Footer: FeedFooter };


// ─── Main Feed ───────────────────────────────────────────────────────────────

export function MessageFeed({ sessionId }: { sessionId: string }) {
  const messages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const streamingText = useStore((s) => s.streaming.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const collapsedSet = useStore((s) => s.collapsedTurns.get(sessionId));
  const toggleTurn = useStore((s) => s.toggleTurnCollapsed);
  const pawCounter = useRef<import("./PawTrail.js").PawCounterState>({ next: 0, cache: new Map() });
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const isNearBottom = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const loadingMore = useRef(false);
  const visibleCount = useStore((s) => s.feedVisibleCount.get(sessionId) ?? FEED_PAGE_SIZE);

  // Save isAtBottom on unmount so we know whether to auto-scroll on re-mount
  useLayoutEffect(() => {
    return () => {
      useStore.getState().setFeedScrollPosition(sessionId, {
        scrollTop: 0,
        scrollHeight: 0,
        isAtBottom: isNearBottom.current,
      });
    };
  }, [sessionId]);

  const grouped = useMemo(() => groupMessages(messages), [messages]);
  const turns = useMemo(() => groupIntoTurns(grouped), [grouped]);

  const totalTurns = turns.length;
  const hasMore = totalTurns > visibleCount;
  const visibleTurns = hasMore ? turns.slice(totalTurns - visibleCount) : turns;

  // firstItemIndex for Virtuoso — enables prepend without scroll jump
  const firstItemIndex = totalTurns - visibleTurns.length;

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

  // ─── Virtuoso callbacks ──────────────────────────────────────────────────

  const handleLoadMore = useCallback(() => {
    if (loadingMore.current) return;
    loadingMore.current = true;
    const current = useStore.getState().feedVisibleCount.get(sessionId) ?? FEED_PAGE_SIZE;
    useStore.getState().setFeedVisibleCount(sessionId, current + FEED_PAGE_SIZE);
    // Virtuoso handles scroll position automatically via firstItemIndex
    setTimeout(() => { loadingMore.current = false; }, 100);
  }, [sessionId]);

  const handleStartReached = useCallback(() => {
    if (hasMore) handleLoadMore();
  }, [hasMore, handleLoadMore]);

  /** When new turns are appended, auto-scroll if user is at the bottom. */
  const handleFollowOutput = useCallback((isAtBottom: boolean) => {
    return isAtBottom ? 'smooth' as const : false as const;
  }, []);

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    isNearBottom.current = atBottom;
    setShowScrollButton((prev) => {
      const shouldShow = !atBottom;
      return prev === shouldShow ? prev : shouldShow;
    });
  }, []);

  // Stable callback for scrollerRef to avoid re-triggering on every render
  const handleScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    setScrollerEl(ref as HTMLElement | null);
  }, []);

  // Auto-scroll for streaming text (Footer height changes) and within-turn
  // message additions (turns.length unchanged but content grew). Throttled
  // to 200ms to avoid layout thrashing on iOS Safari.
  // Double-checks actual scroll position to avoid fighting user scroll.
  const lastScrollTime = useRef(0);
  useEffect(() => {
    if (!scrollerEl) return;
    // Check actual scroll position — don't rely solely on isNearBottom ref
    // which can be stale after rapid touch gestures on mobile
    const distFromBottom = scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight;
    if (distFromBottom > 80) return;
    const now = Date.now();
    if (now - lastScrollTime.current >= 200) {
      lastScrollTime.current = now;
      scrollerEl.scrollTo({ top: scrollerEl.scrollHeight, behavior: 'smooth' });
    }
  }, [streamingText, messages.length, scrollerEl]);

  const scrollToBottom = useCallback(() => {
    scrollerEl?.scrollTo({ top: scrollerEl.scrollHeight, behavior: 'smooth' });
  }, [scrollerEl]);

  // ─── Context & item renderer ─────────────────────────────────────────────

  // Stable key by turn ID so Virtuoso tracks items across prepends
  const computeItemKey = useCallback((_index: number, turn: Turn) => turn.id, []);

  const feedContext: FeedContext = useMemo(() => ({
    hasMore, toolProgress, streamingText, sessionStatus, sessionId,
  }), [hasMore, toolProgress, streamingText, sessionStatus, sessionId]);

  const renderTurn = useCallback((_index: number, turn: Turn) => {
    const isCollapsed = collapsedSet?.has(turn.id) ?? false;
    return (
      <div className="max-w-3xl mx-auto px-3 sm:px-4 pb-3 sm:pb-5">
        <div className="space-y-3 sm:space-y-5">
          {/* User message */}
          {turn.userEntry && (
            <FeedEntries entries={[turn.userEntry]} sessionId={sessionId} />
          )}
          {isCollapsed ? (
            <>
              {/* System messages always visible in collapsed mode */}
              {turn.systemEntries.length > 0 && (
                <FeedEntries entries={turn.systemEntries} sessionId={sessionId} />
              )}
              {/* Collapsed summary for agent activity */}
              {turn.agentEntries.length > 0 && (
                <CollapsedTurnSummary
                  stats={turn.stats}
                  onClick={() => toggleTurn(sessionId, turn.id)}
                />
              )}
            </>
          ) : turn.allEntries.length > 0 && (
            <TurnEntriesExpanded
              turn={turn}
              sessionId={sessionId}
              onCollapse={() => toggleTurn(sessionId, turn.id)}
            />
          )}
        </div>
      </div>
    );
  }, [collapsedSet, toggleTurn, sessionId]);

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
      <PawScrollProvider scrollEl={scrollerEl}>
      <PawCounterContext.Provider value={pawCounter}>
        <Virtuoso<Turn, FeedContext>
          ref={virtuosoRef}
          scrollerRef={handleScrollerRef}
          style={{ height: '100%', overscrollBehavior: 'contain' }}
          data={visibleTurns}
          context={feedContext}
          computeItemKey={computeItemKey}
          defaultItemHeight={150}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={firstItemIndex + visibleTurns.length - 1}
          atBottomThreshold={40}
          followOutput={handleFollowOutput}
          atBottomStateChange={handleAtBottomChange}
          startReached={handleStartReached}
          itemContent={renderTurn}
          components={FEED_COMPONENTS}
        />
      </PawCounterContext.Provider>
      </PawScrollProvider>

      {/* Scroll-to-bottom FAB */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 right-3 z-10 w-8 h-8 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer"
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
            <path d="M8 3v10M4 9l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
