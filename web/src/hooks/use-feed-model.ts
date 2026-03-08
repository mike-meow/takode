import { useMemo, useRef } from "react";
import { isSubagentToolName, type ChatMessage, type ContentBlock } from "../types.js";

export interface ToolItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
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

export type FeedEntry =
  | { kind: "message"; msg: ChatMessage }
  | ToolMsgGroup
  | SubagentGroup
  | SubagentBatch;

interface TaskInfo {
  description: string;
  agentType: string;
  input: Record<string, unknown>;
}

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
      .filter((b) => isSubagentToolName(b.name))
      .map((b) => b.id);
  }
  if (entry.kind === "tool_msg_group" && isSubagentToolName(entry.toolName)) {
    return entry.items.map((item) => item.id);
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
  taskInfo: Map<string, TaskInfo>,
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
    if (entry.kind === "tool_msg_group" && isSubagentToolName(entry.toolName)) {
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

    // Case B: Mixed message (text + Task tool_use) — emit SubagentGroups FIRST,
    // then the cleaned message. This ensures SubagentContainers appear inline
    // above the text response rather than being "stuck at the bottom" of the turn.
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
    if (entry.kind === "message") {
      const filteredBlocks = entry.msg.contentBlocks?.filter(
        (b) => !(b.type === "tool_use" && isSubagentToolName(b.name)),
      );
      result.push({ kind: "message", msg: { ...entry.msg, contentBlocks: filteredBlocks } });
    } else {
      result.push(entry);
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

export function groupMessages(messages: ChatMessage[]): FeedEntry[] {
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
    return groupToolMessages(messages);
  }

  // Phase 3: Build grouped entries with subagent nesting.
  // Orphaned subagent groups (no parent entry in topLevel) are appended at the end.
  const entries = buildEntries(topLevel, taskInfo, childrenByParent);

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

export interface TurnStats {
  messageCount: number;
  toolCount: number;
  subagentCount: number;
  herdEventCount: number;
}

export interface Turn {
  id: string;
  userEntry: FeedEntry | null;
  allEntries: FeedEntry[];
  agentEntries: FeedEntry[];
  systemEntries: FeedEntry[];
  responseEntry: FeedEntry | null;
  promotedEntries: FeedEntry[];
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

export function isUserBoundaryEntry(entry: FeedEntry | null): boolean {
  return !!(
    entry
    && entry.kind === "message"
    && entry.msg.role === "user"
    && entry.msg.agentSource?.sessionId !== "herd-events"
  );
}

function isLeaderBoundaryEntry(entry: FeedEntry): boolean {
  // Only split at user messages — NOT at @to(user) assistant messages.
  // When a turn contains @to(user), earlier text blocks should stay in the
  // same turn and be promoted to user-facing (see makeTurn promotedEntries).
  return isUserBoundaryEntry(entry);
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
  // Leader sessions: fallback final user-addressed response.
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

  // Leader mode: when a turn has @to(user), promote all non-@to(self) text
  // entries from agentEntries so they're visible even when the turn is collapsed.
  // Also hide @to(self) entries entirely (both collapsed and expanded views).
  let promotedEntries: FeedEntry[] = [];
  let selfAddressedCount = 0;
  let allEntries: FeedEntry[] = entries;
  if (leaderMode && responseEntry) {
    const isSelfAddressed = (e: FeedEntry) =>
      e.kind === "message"
      && e.msg.role === "assistant"
      && e.msg.content?.trimEnd().endsWith("@to(self)");

    // Collect indices to splice: promote (user-facing text) or hide (@to(self))
    const toSplice: { i: number; promote: boolean }[] = [];
    for (let i = 0; i < agentEntries.length; i++) {
      const e = agentEntries[i];
      if (e.kind === "message" && e.msg.role === "assistant" && e.msg.content?.trim()) {
        toSplice.push({ i, promote: !isSelfAddressed(e) });
      }
    }
    // Single reverse pass keeps indices stable
    for (let j = toSplice.length - 1; j >= 0; j--) {
      const [entry] = agentEntries.splice(toSplice[j].i, 1);
      if (toSplice[j].promote) {
        promotedEntries.unshift(entry);
      } else {
        selfAddressedCount++;
      }
    }
    // Filter @to(self) from allEntries so expanded view also hides them
    if (selfAddressedCount > 0) {
      allEntries = entries.filter((e) => !isSelfAddressed(e));
    }
  }

  // Stable ID: prefer user message ID, fall back to first agent entry ID, then synthetic
  const id = userEntry
    ? (userEntry.kind === "message" ? userEntry.msg.id : `turn-u-${turnIndex}`)
    : (entries.length > 0 ? `turn-a-${getEntryId(entries[0])}` : `turn-${turnIndex}`);

  return {
    id,
    userEntry,
    allEntries,
    agentEntries,
    systemEntries,
    responseEntry,
    promotedEntries,
    stats: {
      // Subtract responseEntry, promotedEntries, and hidden @to(self) entries
      messageCount: s.messages - (responseEntry ? 1 : 0) - promotedEntries.length - selfAddressedCount,
      toolCount: s.tools,
      subagentCount: s.subagents,
      herdEventCount: s.herdEvents,
    },
  };
}

/** Group flat feed entries into turns.
 *  Leader mode keeps the same boundary rule (user messages only); @to(user) affects
 *  response/promotion behavior inside a turn, not turn splitting. */
export function groupIntoTurns(entries: FeedEntry[], leaderMode = false, startTurnIndex = 0): Turn[] {
  const turns: Turn[] = [];
  let currentUser: FeedEntry | null = null;
  let currentEntries: FeedEntry[] = [];

  for (const entry of entries) {
    const isBoundary = leaderMode ? isLeaderBoundaryEntry(entry) : isUserBoundaryEntry(entry);
    if (isBoundary) {
      // Flush previous turn
      if (currentUser !== null || currentEntries.length > 0) {
        turns.push(makeTurn(currentUser, currentEntries, startTurnIndex + turns.length, leaderMode));
      }
      currentUser = entry;
      currentEntries = [];
    } else {
      currentEntries.push(entry);
    }
  }

  // Flush final turn
  if (currentUser !== null || currentEntries.length > 0) {
    turns.push(makeTurn(currentUser, currentEntries, startTurnIndex + turns.length, leaderMode));
  }

  return turns;
}

export function buildFeedModel(messages: ChatMessage[], leaderMode = false, startTurnIndex = 0): FeedModel {
  const entries = groupMessages(messages);
  const turns = groupIntoTurns(entries, leaderMode, startTurnIndex);
  return { entries, turns };
}

function concatFeedModels(base: FeedModel, next: FeedModel): FeedModel {
  if (base.entries.length === 0) return next;
  if (next.entries.length === 0) return base;
  return {
    entries: [...base.entries, ...next.entries],
    turns: [...base.turns, ...next.turns],
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
  config?: { leaderMode?: boolean; frozenCount?: number; frozenRevision?: number },
): FeedModel {
  const leaderMode = config?.leaderMode ?? false;
  const frozenCount = Math.max(0, Math.min(config?.frozenCount ?? 0, messages.length));
  const frozenRevision = config?.frozenRevision ?? 0;
  const cacheRef = useRef<{
    leaderMode: boolean;
    frozenCount: number;
    frozenRevision: number;
    frozenMessages: ChatMessage[];
    frozenModel: FeedModel;
  } | null>(null);

  return useMemo(() => {
    const frozenMessages = messages.slice(0, frozenCount);
    const activeMessages = messages.slice(frozenCount);

    let frozenModel: FeedModel;
    const cached = cacheRef.current;
    if (
      cached
      && cached.leaderMode === leaderMode
      && cached.frozenCount === frozenCount
      && cached.frozenRevision === frozenRevision
      && haveSameMessageRefs(cached.frozenMessages, frozenMessages)
    ) {
      frozenModel = cached.frozenModel;
    } else if (
      cached
      && cached.leaderMode === leaderMode
      && cached.frozenRevision === frozenRevision
      && frozenCount >= cached.frozenCount
      && haveSameMessageRefs(cached.frozenMessages, frozenMessages.slice(0, cached.frozenCount))
    ) {
      const newlyFrozen = frozenMessages.slice(cached.frozenCount);
      const deltaModel = buildFeedModel(newlyFrozen, leaderMode, cached.frozenModel.turns.length);
      frozenModel = concatFeedModels(cached.frozenModel, deltaModel);
    } else {
      frozenModel = buildFeedModel(frozenMessages, leaderMode);
    }

    cacheRef.current = {
      leaderMode,
      frozenCount,
      frozenRevision,
      frozenMessages,
      frozenModel,
    };

    const activeModel = buildFeedModel(activeMessages, leaderMode, frozenModel.turns.length);
    return concatFeedModels(frozenModel, activeModel);
  }, [messages, leaderMode, frozenCount, frozenRevision]);
}
