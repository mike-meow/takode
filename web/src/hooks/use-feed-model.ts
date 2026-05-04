import { useEffect, useMemo, useRef } from "react";
import { isSubagentToolName, type ChatMessage, type ContentBlock } from "../types.js";
import { EVENT_HEADER_RE } from "../utils/herd-event-parser.js";
import { recordFeedRenderSnapshot } from "../utils/frontend-perf-recorder.js";

export interface ToolItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
  messageId?: string;
}

export interface ToolMsgGroup {
  kind: "tool_msg_group";
  toolName: string;
  items: ToolItem[];
  firstId: string;
}

export interface SubagentGroup {
  kind: "subagent";
  taskToolUseId: string;
  description: string;
  agentType: string;
  taskInput: Record<string, unknown> | null;
  children: FeedEntry[];
  isBackground: boolean;
}

export interface SubagentBatch {
  kind: "subagent_batch";
  subagents: SubagentGroup[];
}

export type FeedEntry = { kind: "message"; msg: ChatMessage } | ToolMsgGroup | SubagentGroup | SubagentBatch;

interface TaskInfo {
  description: string;
  agentType: string;
  input: Record<string, unknown>;
}

export function isToolHiddenFromChat(name: string): boolean {
  return name === "write_stdin";
}

function filterHiddenToolUseBlocks(msg: ChatMessage): ChatMessage | null {
  const blocks = msg.contentBlocks;
  if (!blocks || blocks.length === 0) return msg;

  const filtered = blocks.filter((b) => !(b.type === "tool_use" && isToolHiddenFromChat(b.name)));
  if (filtered.length === blocks.length) return msg;
  if (filtered.length === 0 && !msg.content.trim() && !msg.notification) return null;
  return { ...msg, contentBlocks: filtered };
}

/**
 * Get the dominant tool name if this message is "tool-only"
 * (assistant message whose contentBlocks are ALL tool_use of the same name).
 * Returns null if it has text/thinking or mixed tool types.
 */
function getToolOnlyName(msg: ChatMessage, anchoredNotificationMessageIds?: ReadonlySet<string>): string | null {
  if (msg.role !== "assistant") return null;
  if (msg.notification) return null;
  if (anchoredNotificationMessageIds?.has(msg.id)) return null;
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
    .filter(
      (b): b is ContentBlock & { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use",
    )
    .map((b) => ({ id: b.id, name: b.name, input: b.input, messageId: msg.id }));
}

/** Get Task tool_use IDs from a feed entry */
function getTaskIdsFromEntry(entry: FeedEntry): string[] {
  if (entry.kind === "message") {
    const blocks = entry.msg.contentBlocks || [];
    return blocks
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .filter((b) => isSubagentToolName(b.name))
      .map((b) => b.id);
  }
  if (entry.kind === "tool_msg_group" && isSubagentToolName(entry.toolName)) {
    return entry.items.map((item) => item.id);
  }
  return [];
}

// File-operation tools get standalone chips (no grouping) so each edit
// shows its own path in the header without redundant double-headers.
export const FILE_TOOL_NAMES = new Set(["Edit", "Write", "Read"]);

/** Group consecutive same-tool messages */
function groupToolMessages(messages: ChatMessage[], anchoredNotificationMessageIds?: ReadonlySet<string>): FeedEntry[] {
  const entries: FeedEntry[] = [];

  for (const originalMsg of messages) {
    const msg = filterHiddenToolUseBlocks(originalMsg);
    if (!msg) continue;
    const toolName = getToolOnlyName(msg, anchoredNotificationMessageIds);

    if (toolName) {
      const last = entries[entries.length - 1];
      // Never merge file-operation tools -- each gets its own standalone chip
      if (!FILE_TOOL_NAMES.has(toolName) && last?.kind === "tool_msg_group" && last.toolName === toolName) {
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
  taskInfo: Map<string, TaskInfo>,
  childrenByParent: Map<string, ChatMessage[]>,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
): FeedEntry[] {
  const grouped = groupToolMessages(messages, anchoredNotificationMessageIds);

  const result: FeedEntry[] = [];
  for (const entry of grouped) {
    const taskIds = getTaskIdsFromEntry(entry);

    if (taskIds.length === 0) {
      // Non-Task entry — push as-is
      result.push(entry);
      continue;
    }

    // Case A: Pure Task ToolMsgGroup — absorb entirely into SubagentGroups
    if (entry.kind === "tool_msg_group" && isSubagentToolName(entry.toolName)) {
      for (const taskId of taskIds) {
        const info = taskInfo.get(taskId) || { description: "Subagent", agentType: "", input: {} };
        const children = childrenByParent.get(taskId);
        const childEntries =
          children && children.length > 0
            ? buildEntries(children, taskInfo, childrenByParent, anchoredNotificationMessageIds)
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

    // Case B: Mixed message (text + Task tool_use) — emit the text FIRST,
    // then the SubagentGroups. This preserves chronological order: the
    // assistant writes explanatory text before invoking the agent tool.
    if (entry.kind === "message") {
      const filteredBlocks = entry.msg.contentBlocks?.filter(
        (b) => !(b.type === "tool_use" && isSubagentToolName(b.name)),
      );
      result.push({ kind: "message", msg: { ...entry.msg, contentBlocks: filteredBlocks } });
    } else {
      result.push(entry);
    }
    for (const taskId of taskIds) {
      const info = taskInfo.get(taskId) || { description: "Subagent", agentType: "", input: {} };
      const children = childrenByParent.get(taskId);
      const childEntries =
        children && children.length > 0
          ? buildEntries(children, taskInfo, childrenByParent, anchoredNotificationMessageIds)
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

export function groupMessages(
  messages: ChatMessage[],
  anchoredNotificationMessageIds?: ReadonlySet<string> | readonly string[],
): FeedEntry[] {
  const anchoredIds =
    anchoredNotificationMessageIds instanceof Set
      ? anchoredNotificationMessageIds
      : new Set(anchoredNotificationMessageIds ?? []);
  // Phase 1: Find all Task tool_use IDs across all messages
  const taskInfo = new Map<string, TaskInfo>();
  for (const msg of messages) {
    if (!msg.contentBlocks) continue;
    for (const b of msg.contentBlocks) {
      if (b.type === "tool_use" && isSubagentToolName(b.name)) {
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
      if (!arr) {
        arr = [];
        childrenByParent.set(msg.parentToolUseId, arr);
      }
      arr.push(msg);
    } else {
      topLevel.push(msg);
    }
  }

  // If no Task tool_uses found (including synthetic), skip the overhead
  if (taskInfo.size === 0) {
    return groupToolMessages(messages, anchoredIds);
  }

  // Phase 3: Build grouped entries with subagent nesting.
  // Orphaned subagent groups (no parent entry in topLevel) are appended at the end.
  const entries = buildEntries(topLevel, taskInfo, childrenByParent, anchoredIds);

  // Emit any orphaned subagent groups whose parent Task wasn't in any top-level entry.
  // Skip orphans with synthetic taskInfo (empty input) — these appear when the parent
  // Task block was lost during message dedup or compaction. The synthetic entry has
  // input: {} while real Task entries have input with prompt/description.
  const emittedTaskIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "subagent") emittedTaskIds.add(entry.taskToolUseId);
  }
  for (const [taskId, children] of childrenByParent) {
    if (emittedTaskIds.has(taskId)) continue;
    if (children.length === 0) continue;
    const info = taskInfo.get(taskId);
    if (!info) continue;
    // Skip synthetic orphans (empty input = parent Task was never in message history)
    if (Object.keys(info.input).length === 0) continue;
    const childEntries = buildEntries(children, taskInfo, childrenByParent, anchoredIds);
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

export interface TurnStats {
  messageCount: number;
  toolCount: number;
  subagentCount: number;
  herdEventCount: number;
}

/** Assistant message immediately preceding a herd event injection --
 *  a sub-conclusion worth showing in the collapsed turn view. */
export interface SubConclusion {
  /** The assistant FeedEntry (same reference as in agentEntries) */
  entry: FeedEntry;
  /** One-line summary of the herd event(s) that followed, e.g. "Herd: #264 turn_end, #267 turn_end" */
  herdSummary: string;
}

export type CollapsedTurnEntry =
  | { kind: "activity"; key: string; stats: TurnStats }
  | { kind: "entry"; key: string; entry: FeedEntry };

export interface Turn {
  id: string;
  userEntry: FeedEntry | null;
  allEntries: FeedEntry[];
  agentEntries: FeedEntry[];
  systemEntries: FeedEntry[];
  /** Messages with notification chips -- always visible even when the turn is collapsed. */
  notificationEntries: FeedEntry[];
  responseEntry: FeedEntry | null;
  /** Sub-conclusions: assistant messages that precede herd events, shown in collapsed view */
  subConclusions: SubConclusion[];
  /** Chronological collapsed-turn projection of hidden activity and priority entries. */
  collapsedEntries?: CollapsedTurnEntry[];
  stats: TurnStats;
}

export interface FeedModel {
  entries: FeedEntry[];
  turns: Turn[];
}

/** Count tool_use blocks and subagents recursively in a list of FeedEntries */
function countEntryStats(entries: FeedEntry[]): {
  messages: number;
  tools: number;
  subagents: number;
  herdEvents: number;
  lastText: string;
} {
  let messages = 0;
  let tools = 0;
  let subagents = 0;
  let herdEvents = 0;
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
        // Track herd orchestration event injections
        if (msg.agentSource?.sessionId === "herd-events") herdEvents++;
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
      herdEvents += childStats.herdEvents;
      if (childStats.lastText) lastText = childStats.lastText;
    } else if (entry.kind === "subagent_batch") {
      for (const sg of entry.subagents) {
        subagents++;
        const childStats = countEntryStats(sg.children);
        messages += childStats.messages;
        tools += childStats.tools;
        subagents += childStats.subagents;
        herdEvents += childStats.herdEvents;
        if (childStats.lastText) lastText = childStats.lastText;
      }
    }
  }

  return { messages, tools, subagents, herdEvents, lastText };
}

/** Check if a FeedEntry is a system message (compact markers, errors, info dividers).
 *  Permission denied/approved badges and quest_claimed blocks are NOT system entries
 *  — they flow with agent activity so they appear at the correct chronological position in the turn.
 *  quest_submitted currently remains a system entry under this classifier. */
function isSystemEntry(entry: FeedEntry): boolean {
  if (entry.kind !== "message" || entry.msg.role !== "system") return false;
  if (entry.msg.metadata?.attentionRecord) return false;
  if (entry.msg.variant === "denied" || entry.msg.variant === "approved" || entry.msg.variant === "quest_claimed")
    return false;
  return true;
}

/** Get a stable ID for an entry (for use as turn ID fallback) */
function getEntryId(entry: FeedEntry): string {
  if (entry.kind === "message") return entry.msg.id;
  if (entry.kind === "tool_msg_group") return entry.firstId;
  if (entry.kind === "subagent_batch") return entry.subagents[0]?.taskToolUseId || "batch";
  return entry.taskToolUseId;
}

export function isUserBoundaryEntry(entry: FeedEntry | null): boolean {
  return !!(entry && entry.kind === "message" && entry.msg.role === "user" && entry.msg.agentSource == null);
}

/** Check if a FeedEntry is a herd event message (user message injected by herd dispatcher). */
function isHerdEventEntry(entry: FeedEntry): entry is Extract<FeedEntry, { kind: "message" }> {
  return entry.kind === "message" && entry.msg.role === "user" && entry.msg.agentSource?.sessionId === "herd-events";
}

/** Summarize herd event messages into a compact one-liner.
 *  Parses "#N | type | ..." header lines from each message and returns
 *  e.g. "Herd: #264 turn_end, #267 turn_end" */
export function summarizeHerdEvents(herdEntries: FeedEntry[]): string {
  const headers: string[] = [];
  for (const entry of herdEntries) {
    if (entry.kind !== "message") continue;
    for (const line of entry.msg.content.split("\n")) {
      if (!EVENT_HEADER_RE.test(line)) continue;
      // Parse "#5 | turn_end | ✓ 15.3s | ..." -> "#5 turn_end"
      const parts = line.split("|").map((s) => s.trim());
      if (parts.length >= 2) {
        headers.push(`${parts[0]} ${parts[1]}`);
      } else {
        headers.push(parts[0]);
      }
    }
  }
  return headers.length > 0 ? `Herd: ${headers.join(", ")}` : "Herd event";
}

/** Extract sub-conclusions from a turn's entries.
 *  A sub-conclusion is the last assistant text message before a herd event injection.
 *  Only the immediately preceding assistant message qualifies -- intervening tool results,
 *  system messages, or other non-assistant entries break the sequence.
 *  Consecutive herd events are grouped into a single summary. */
function extractSubConclusions(entries: FeedEntry[], excludedMessageIds: Set<string>): SubConclusion[] {
  const subConclusions: SubConclusion[] = [];
  let lastAssistantEntry: FeedEntry | null = null;

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];

    if (entry.kind === "message" && entry.msg.role === "assistant" && entry.msg.content?.trim()) {
      // Messages already promoted into another collapsed-visible slot (for
      // example notificationEntries or responseEntry) must not also become a
      // sub-conclusion, or the same assistant message renders twice.
      lastAssistantEntry = excludedMessageIds.has(entry.msg.id) ? null : entry;
      i++;
      continue;
    }

    if (isHerdEventEntry(entry) && lastAssistantEntry) {
      // Collect consecutive herd events
      const herdBatch: FeedEntry[] = [];
      while (i < entries.length && isHerdEventEntry(entries[i])) {
        herdBatch.push(entries[i]);
        i++;
      }

      if (lastAssistantEntry) {
        subConclusions.push({
          entry: lastAssistantEntry,
          herdSummary: summarizeHerdEvents(herdBatch),
        });
      }
      lastAssistantEntry = null;
      continue;
    }

    // Non-assistant, non-herd entry (tool results, system messages, etc.)
    // breaks the assistant→herd sequence
    lastAssistantEntry = null;
    i++;
  }

  return subConclusions;
}

function isLeaderBoundaryEntry(entry: FeedEntry): boolean {
  // Only split at user messages. Deprecated assistant suffix tags are treated
  // as literal text and do not affect turn boundaries.
  return isUserBoundaryEntry(entry);
}

function entryIsCollapsedVisible(
  entry: FeedEntry,
  leaderMode: boolean,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
): boolean {
  return (
    entry.kind === "message" &&
    ((entry.msg.role === "assistant" &&
      (entry.msg.notification != null ||
        anchoredNotificationMessageIds?.has(entry.msg.id) === true ||
        (leaderMode && entry.msg.metadata?.leaderUserMessage === true))) ||
      entry.msg.metadata?.attentionRecord != null)
  );
}

function buildCollapsedTurnEntries(entries: FeedEntry[], visibleEntryKeys: ReadonlySet<string>): CollapsedTurnEntry[] {
  const collapsedEntries: CollapsedTurnEntry[] = [];
  let hiddenStartKey: string | null = null;
  let hiddenEntries: FeedEntry[] = [];

  const flushHiddenActivity = () => {
    if (hiddenStartKey === null || hiddenEntries.length === 0) return;
    const stats = countEntryStats(hiddenEntries);
    collapsedEntries.push({
      kind: "activity",
      key: `activity:${hiddenStartKey}:${hiddenEntries.length}`,
      stats: {
        messageCount: stats.messages,
        toolCount: stats.tools,
        subagentCount: stats.subagents,
        herdEventCount: stats.herdEvents,
      },
    });
    hiddenStartKey = null;
    hiddenEntries = [];
  };

  for (const entry of entries) {
    const key = getEntryId(entry);
    if (visibleEntryKeys.has(key)) {
      flushHiddenActivity();
      collapsedEntries.push({ kind: "entry", key: `entry:${key}`, entry });
      continue;
    }
    hiddenStartKey ??= key;
    hiddenEntries.push(entry);
  }

  flushHiddenActivity();
  return collapsedEntries;
}

/** Build a Turn from accumulated entries */
function makeTurn(
  userEntry: FeedEntry | null,
  entries: FeedEntry[],
  turnIndex: number,
  leaderMode = false,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
): Turn {
  // Separate system messages (always visible) from collapsible agent activity
  const rawAgentEntries: FeedEntry[] = [];
  const systemEntries: FeedEntry[] = [];
  for (const e of entries) {
    if (isSystemEntry(e)) {
      systemEntries.push(e);
    } else {
      rawAgentEntries.push(e);
    }
  }

  // Count stats on ALL agent entries before extracting the response
  const s = countEntryStats(rawAgentEntries);

  // Extract messages with notification chips -- always visible like systemEntries.
  const notificationEntries: FeedEntry[] = [];
  for (const e of rawAgentEntries) {
    if (entryIsCollapsedVisible(e, leaderMode, anchoredNotificationMessageIds)) {
      notificationEntries.push(e);
    }
  }

  // Extract the default-visible response entry (last assistant text message).
  // Leader sessions publish user-visible text through `leader_user_message`;
  // ordinary assistant text is private activity unless the turn is expanded.
  // Deprecated @to(user)/@to(self) suffixes are treated as literal text and do
  // not affect which message becomes the collapsed preview.
  let responseEntry: FeedEntry | null = null;
  if (!leaderMode) {
    const notificationEntryKeys = new Set(notificationEntries.map(getEntryId));
    for (let i = rawAgentEntries.length - 1; i >= 0; i--) {
      const e = rawAgentEntries[i];
      if (notificationEntryKeys.has(getEntryId(e))) continue;
      if (e.kind === "message" && e.msg.role === "assistant" && e.msg.content?.trim()) {
        responseEntry = e;
        break;
      }
    }
  }

  const collapsedVisibleEntryKeys = new Set<string>();
  const collapsedVisibleMessageIds = new Set<string>();
  for (const entry of notificationEntries) {
    collapsedVisibleEntryKeys.add(getEntryId(entry));
    if (entry.kind === "message") collapsedVisibleMessageIds.add(entry.msg.id);
  }
  if (responseEntry) {
    collapsedVisibleEntryKeys.add(getEntryId(responseEntry));
    if (responseEntry.kind === "message") collapsedVisibleMessageIds.add(responseEntry.msg.id);
  }
  const agentEntries = rawAgentEntries.filter((entry) => !collapsedVisibleEntryKeys.has(getEntryId(entry)));
  const collapsedEntries = buildCollapsedTurnEntries(rawAgentEntries, collapsedVisibleEntryKeys);

  // Extract sub-conclusions for normal sessions only. In leader sessions,
  // ordinary assistant text is private activity and should not be promoted
  // into the user-visible left panel unless it came through `user-message`.
  const subConclusions = leaderMode ? [] : extractSubConclusions(entries, collapsedVisibleMessageIds);

  // Stable ID: prefer user message ID, fall back to first agent entry ID, then synthetic
  const id = userEntry
    ? userEntry.kind === "message"
      ? userEntry.msg.id
      : `turn-u-${turnIndex}`
    : entries.length > 0
      ? `turn-a-${getEntryId(entries[0])}`
      : `turn-${turnIndex}`;

  return {
    id,
    userEntry,
    allEntries: entries,
    agentEntries,
    systemEntries,
    notificationEntries,
    responseEntry,
    subConclusions,
    collapsedEntries,
    stats: {
      // Subtract responseEntry and notificationEntries; remaining count reflects
      // messages still inside the collapsible agent activity section.
      messageCount: s.messages - (responseEntry ? 1 : 0) - notificationEntries.length,
      toolCount: s.tools,
      subagentCount: s.subagents,
      herdEventCount: s.herdEvents,
    },
  };
}

/** Group flat feed entries into turns.
 *  Leader mode splits only on real human user boundaries. Injected user-shaped
 *  updates carry agentSource and remain inside the current agent turn. */
export function groupIntoTurns(
  entries: FeedEntry[],
  leaderMode = false,
  startTurnIndex = 0,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
): Turn[] {
  const turns: Turn[] = [];
  let currentUser: FeedEntry | null = null;
  let currentEntries: FeedEntry[] = [];

  for (const entry of entries) {
    const isBoundary = leaderMode ? isLeaderBoundaryEntry(entry) : isUserBoundaryEntry(entry);
    if (isBoundary) {
      // Flush previous turn
      if (currentUser !== null || currentEntries.length > 0) {
        turns.push(
          makeTurn(
            currentUser,
            currentEntries,
            startTurnIndex + turns.length,
            leaderMode,
            anchoredNotificationMessageIds,
          ),
        );
      }
      currentUser = entry;
      currentEntries = [];
    } else {
      currentEntries.push(entry);
    }
  }

  // Flush final turn
  if (currentUser !== null || currentEntries.length > 0) {
    turns.push(
      makeTurn(currentUser, currentEntries, startTurnIndex + turns.length, leaderMode, anchoredNotificationMessageIds),
    );
  }

  return turns;
}

export function buildFeedModel(
  messages: ChatMessage[],
  leaderMode = false,
  startTurnIndex = 0,
  anchoredNotificationMessageIds?: ReadonlySet<string> | readonly string[],
): FeedModel {
  const anchoredIds =
    anchoredNotificationMessageIds instanceof Set
      ? anchoredNotificationMessageIds
      : new Set(anchoredNotificationMessageIds ?? []);
  const entries = groupMessages(messages, anchoredIds);
  const turns = groupIntoTurns(entries, leaderMode, startTurnIndex, anchoredIds);
  return { entries, turns };
}

function shouldMergeFirstActiveTurnIntoLastFrozenTurn(baseTurn: Turn, nextTurn: Turn): boolean {
  if (nextTurn.userEntry !== null) return false;
  return true;
}

function concatFeedModels(
  base: FeedModel,
  next: FeedModel,
  leaderMode = false,
  anchoredNotificationMessageIds?: ReadonlySet<string> | readonly string[],
): FeedModel {
  if (base.entries.length === 0) return next;
  if (next.entries.length === 0) return base;

  // When the frozen/active boundary falls between two assistant messages
  // with no user message in between (e.g., a task_notification-triggered turn),
  // the active model's first turn has userEntry === null. Merge it into the
  // last frozen turn so they appear as one continuous agent turn in the UI,
  // rather than creating a phantom turn boundary that causes incorrect collapsing.
  let mergedTurns: Turn[];
  if (
    next.turns.length > 0 &&
    base.turns.length > 0 &&
    shouldMergeFirstActiveTurnIntoLastFrozenTurn(base.turns[base.turns.length - 1], next.turns[0])
  ) {
    const lastBase = base.turns[base.turns.length - 1];
    const firstNext = next.turns[0];
    // Re-derive the merged turn via makeTurn so stats, response entry,
    // and system/agent separation are all consistent.
    const merged = makeTurn(
      lastBase.userEntry,
      [...lastBase.allEntries, ...firstNext.allEntries],
      base.turns.length - 1,
      leaderMode,
      anchoredNotificationMessageIds instanceof Set
        ? anchoredNotificationMessageIds
        : new Set(anchoredNotificationMessageIds ?? []),
    );
    mergedTurns = [...base.turns.slice(0, -1), merged, ...next.turns.slice(1)];
  } else {
    mergedTurns = [...base.turns, ...next.turns];
  }

  return {
    entries: [...base.entries, ...next.entries],
    turns: mergedTurns,
  };
}

function haveSameMessageRefs(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function useFeedModel(
  messages: ChatMessage[],
  config?: {
    leaderMode?: boolean;
    frozenCount?: number;
    frozenRevision?: number;
    anchoredNotificationMessageIds?: readonly string[];
    perf?: { sessionId: string; threadKey: string };
  },
): FeedModel {
  const leaderMode = config?.leaderMode ?? false;
  const frozenCount = Math.max(0, Math.min(config?.frozenCount ?? 0, messages.length));
  const frozenRevision = config?.frozenRevision ?? 0;
  const anchoredNotificationMessageIds = config?.anchoredNotificationMessageIds ?? [];
  const anchoredNotificationSignature = anchoredNotificationMessageIds.join("\0");
  const perfSessionId = config?.perf?.sessionId;
  const perfThreadKey = config?.perf?.threadKey;
  const cacheRef = useRef<{
    leaderMode: boolean;
    frozenCount: number;
    frozenRevision: number;
    anchoredNotificationSignature: string;
    frozenMessages: ChatMessage[];
    frozenModel: FeedModel;
  } | null>(null);

  const model = useMemo(() => {
    const frozenMessages = messages.slice(0, frozenCount);
    const activeMessages = messages.slice(frozenCount);

    let frozenModel: FeedModel;
    const cached = cacheRef.current;
    if (
      cached &&
      cached.leaderMode === leaderMode &&
      cached.frozenCount === frozenCount &&
      cached.frozenRevision === frozenRevision &&
      cached.anchoredNotificationSignature === anchoredNotificationSignature &&
      haveSameMessageRefs(cached.frozenMessages, frozenMessages)
    ) {
      frozenModel = cached.frozenModel;
    } else if (
      cached &&
      cached.leaderMode === leaderMode &&
      cached.frozenRevision === frozenRevision &&
      cached.anchoredNotificationSignature === anchoredNotificationSignature &&
      frozenCount >= cached.frozenCount &&
      haveSameMessageRefs(cached.frozenMessages, frozenMessages.slice(0, cached.frozenCount))
    ) {
      const newlyFrozen = frozenMessages.slice(cached.frozenCount);
      const deltaModel = buildFeedModel(
        newlyFrozen,
        leaderMode,
        cached.frozenModel.turns.length,
        anchoredNotificationMessageIds,
      );
      frozenModel = concatFeedModels(cached.frozenModel, deltaModel, leaderMode, anchoredNotificationMessageIds);
    } else {
      frozenModel = buildFeedModel(frozenMessages, leaderMode, 0, anchoredNotificationMessageIds);
    }

    cacheRef.current = {
      leaderMode,
      frozenCount,
      frozenRevision,
      anchoredNotificationSignature,
      frozenMessages,
      frozenModel,
    };

    const activeModel = buildFeedModel(
      activeMessages,
      leaderMode,
      frozenModel.turns.length,
      anchoredNotificationMessageIds,
    );
    return concatFeedModels(frozenModel, activeModel, leaderMode, anchoredNotificationMessageIds);
  }, [
    messages,
    leaderMode,
    frozenCount,
    frozenRevision,
    anchoredNotificationMessageIds,
    anchoredNotificationSignature,
  ]);

  useEffect(() => {
    if (!perfSessionId || !perfThreadKey) return;
    recordFeedRenderSnapshot({
      sessionId: perfSessionId,
      threadKey: perfThreadKey,
      messageCount: messages.length,
      entryCount: model.entries.length,
      turnCount: model.turns.length,
    });
  }, [messages.length, model.entries.length, model.turns.length, perfSessionId, perfThreadKey]);

  return model;
}
