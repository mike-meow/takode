import { useMemo, useRef } from "react";
import { isSubagentToolName, type ChatMessage, type ContentBlock } from "../types.js";
import { EVENT_HEADER_RE } from "../utils/herd-event-parser.js";

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

export type FeedEntry = { kind: "message"; msg: ChatMessage } | ToolMsgGroup | SubagentGroup | SubagentBatch;

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
    .filter(
      (b): b is ContentBlock & { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use",
    )
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

// File-operation tools get standalone chips (no grouping) so each edit
// shows its own path in the header without redundant double-headers.
export const FILE_TOOL_NAMES = new Set(["Edit", "Write", "Read"]);

/** Group consecutive same-tool messages */
function groupToolMessages(messages: ChatMessage[]): FeedEntry[] {
  const entries: FeedEntry[] = [];

  for (const msg of messages) {
    const toolName = getToolOnlyName(msg);

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
        const childEntries = children && children.length > 0 ? buildEntries(children, taskInfo, childrenByParent) : [];
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
      const childEntries = children && children.length > 0 ? buildEntries(children, taskInfo, childrenByParent) : [];
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

/** Assistant message immediately preceding a herd event injection --
 *  a sub-conclusion worth showing in the collapsed turn view. */
export interface SubConclusion {
  /** The assistant FeedEntry (same reference as in agentEntries) */
  entry: FeedEntry;
  /** One-line summary of the herd event(s) that followed, e.g. "Herd: #264 turn_end, #267 turn_end" */
  herdSummary: string;
}

export interface Turn {
  id: string;
  userEntry: FeedEntry | null;
  allEntries: FeedEntry[];
  agentEntries: FeedEntry[];
  systemEntries: FeedEntry[];
  /** Messages with notification chips -- always visible even when the turn is collapsed. */
  notificationEntries: FeedEntry[];
  responseEntry: FeedEntry | null;
  promotedEntries: FeedEntry[];
  /** Sub-conclusions: assistant messages that precede herd events, shown in collapsed view */
  subConclusions: SubConclusion[];
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
  const sourceId =
    entry?.kind === "message" && entry.msg.role === "user" ? entry.msg.agentSource?.sessionId : undefined;
  return !!(
    entry &&
    entry.kind === "message" &&
    entry.msg.role === "user" &&
    sourceId !== "herd-events" &&
    sourceId !== "system" &&
    !sourceId?.startsWith("system:") &&
    !sourceId?.startsWith("timer:")
  );
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
function extractSubConclusions(entries: FeedEntry[], responseEntry: FeedEntry | null): SubConclusion[] {
  const subConclusions: SubConclusion[] = [];
  let lastAssistantEntry: FeedEntry | null = null;

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];

    if (entry.kind === "message" && entry.msg.role === "assistant" && entry.msg.content?.trim()) {
      lastAssistantEntry = entry;
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

      // Don't add as sub-conclusion if it's the same entry that will be responseEntry
      if (lastAssistantEntry !== responseEntry) {
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

  // Extract messages with notification chips -- always visible like systemEntries.
  // Splice in reverse to avoid index shifting. Done before responseEntry extraction
  // so a notification message isn't accidentally chosen as the response preview.
  const notificationEntries: FeedEntry[] = [];
  for (let i = agentEntries.length - 1; i >= 0; i--) {
    const e = agentEntries[i];
    if (e.kind === "message" && e.msg.notification) {
      notificationEntries.unshift(agentEntries.splice(i, 1)[0]);
    }
  }

  // Extract the default-visible response entry (last assistant text message).
  // This is the preview shown when a turn is collapsed. Both normal and leader
  // sessions use the same rule: pick the last assistant message with text content,
  // skipping @to(self) messages in leader mode (those are always hidden).
  // Leader sessions previously required leaderUserAddressed === true here, which
  // caused blank collapsed previews once @to(user) tags were replaced by
  // `takode notify`. The @to(user) promotion logic below still handles surfacing
  // user-addressed messages in collapsed view for backward compatibility.
  let responseEntry: FeedEntry | null = null;
  for (let i = agentEntries.length - 1; i >= 0; i--) {
    const e = agentEntries[i];
    if (e.kind === "message" && e.msg.role === "assistant" && e.msg.content?.trim()) {
      // Skip @to(self) messages -- they should never be the collapsed preview
      if (leaderMode && e.msg.content.trimEnd().endsWith("@to(self)")) continue;
      responseEntry = e;
      agentEntries.splice(i, 1);
      break;
    }
  }

  // Leader mode backward compat: promote @to(user) entries so they're visible
  // when collapsed. Hide @to(self) entries entirely. Non-addressed assistant
  // text stays in agentEntries (visible expanded, hidden collapsed).
  let promotedEntries: FeedEntry[] = [];
  let selfAddressedCount = 0;
  let allEntries: FeedEntry[] = entries;
  if (leaderMode) {
    const isSelfAddressed = (e: FeedEntry) =>
      e.kind === "message" && e.msg.role === "assistant" && e.msg.content?.trimEnd().endsWith("@to(self)");

    // Collect indices to splice: promote (@to(user)) or hide (@to(self))
    const toSplice: { i: number; promote: boolean }[] = [];
    for (let i = 0; i < agentEntries.length; i++) {
      const e = agentEntries[i];
      if (e.kind === "message" && e.msg.role === "assistant" && e.msg.content?.trim()) {
        if (isSelfAddressed(e)) {
          toSplice.push({ i, promote: false });
        } else if (e.msg.leaderUserAddressed === true) {
          toSplice.push({ i, promote: true });
        }
        // Unmarked internal text: leave in agentEntries (no splice)
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

  // Extract sub-conclusions: assistant messages immediately before herd event injections.
  // These represent intermediate conclusions worth showing in collapsed view.
  // Scan allEntries (post-@to(self) filtering) so hidden messages don't appear as sub-conclusions.
  const subConclusions = extractSubConclusions(allEntries, responseEntry);

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
    allEntries,
    agentEntries,
    systemEntries,
    notificationEntries,
    responseEntry,
    promotedEntries,
    subConclusions,
    stats: {
      // Subtract responseEntry, promotedEntries (@to(user)), notificationEntries,
      // and hidden @to(self) entries; remaining count reflects unmarked internal
      // messages still in agentEntries.
      messageCount:
        s.messages - (responseEntry ? 1 : 0) - promotedEntries.length - notificationEntries.length - selfAddressedCount,
      toolCount: s.tools,
      subagentCount: s.subagents,
      herdEventCount: s.herdEvents,
    },
  };
}

/** Group flat feed entries into turns.
 *  Leader mode splits only on real user boundaries. Herd events, timers, and
 *  notification-style injected updates remain inside the current agent turn
 *  until an explicit human or agent-authored user message starts a new one. */
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

function shouldMergeFirstActiveTurnIntoLastFrozenTurn(baseTurn: Turn, nextTurn: Turn): boolean {
  if (nextTurn.userEntry !== null) return false;
  return true;
}

function concatFeedModels(base: FeedModel, next: FeedModel, leaderMode = false): FeedModel {
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
      cached &&
      cached.leaderMode === leaderMode &&
      cached.frozenCount === frozenCount &&
      cached.frozenRevision === frozenRevision &&
      haveSameMessageRefs(cached.frozenMessages, frozenMessages)
    ) {
      frozenModel = cached.frozenModel;
    } else if (
      cached &&
      cached.leaderMode === leaderMode &&
      cached.frozenRevision === frozenRevision &&
      frozenCount >= cached.frozenCount &&
      haveSameMessageRefs(cached.frozenMessages, frozenMessages.slice(0, cached.frozenCount))
    ) {
      const newlyFrozen = frozenMessages.slice(cached.frozenCount);
      const deltaModel = buildFeedModel(newlyFrozen, leaderMode, cached.frozenModel.turns.length);
      frozenModel = concatFeedModels(cached.frozenModel, deltaModel, leaderMode);
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
    return concatFeedModels(frozenModel, activeModel, leaderMode);
  }, [messages, leaderMode, frozenCount, frozenRevision]);
}
