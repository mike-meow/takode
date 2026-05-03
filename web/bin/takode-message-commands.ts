import {
  encodeLogQuery,
  parseLogLevels,
  parseLogTime,
  type LogQueryResponse,
  type ServerLogEntry,
} from "../shared/logging.ts";
import { TAKODE_PEEK_CONTENT_LIMIT, formatQuotedContent } from "../shared/takode-constants.ts";
import {
  apiGet,
  dateKey,
  err,
  formatDate,
  formatTime,
  formatTimeShort,
  parseFlags,
  parseIntegerFlag,
  parsePositiveIntegerFlag,
  takodeAuthHeaders,
} from "./takode-core.js";

function escapeTerminalText(s: string): string {
  return s
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function formatInlineText(value: unknown): string {
  return escapeTerminalText(String(value ?? ""));
}

function truncate(s: string, max: number): string {
  const escaped = escapeTerminalText(s);
  if (escaped.length <= max) return escaped;
  return escaped.slice(0, max) + ` [+${escaped.length - max} chars]`;
}

type TakodeMessageSourceLike = {
  agent?: { sessionId: string; sessionLabel?: string };
};

type TakodeUserMessageSourceKind = "user" | "herd" | "agent";
type TakodeUserContentSurface = "scan" | "peek" | "read";

const TAKODE_SCAN_USER_CONTENT_LIMITS: Record<TakodeUserMessageSourceKind, number> = {
  user: 2000,
  herd: 90,
  agent: 180,
};

const TAKODE_PEEK_USER_CONTENT_LIMITS: Record<TakodeUserMessageSourceKind, number> = {
  user: TAKODE_PEEK_CONTENT_LIMIT,
  herd: 180,
  agent: 280,
};

const TAKODE_READ_USER_CONTENT_LIMITS: Record<TakodeUserMessageSourceKind, number> = {
  user: 2000,
  herd: 180,
  agent: 320,
};

function takodeUserMessageSourceKind(msg: TakodeMessageSourceLike): TakodeUserMessageSourceKind {
  if (!msg.agent) return "user";
  if (msg.agent.sessionId === "herd-events") return "herd";
  return "agent";
}

function userSourceLabel(msg: TakodeMessageSourceLike): string {
  const sourceKind = takodeUserMessageSourceKind(msg);
  if (sourceKind === "user") return "user";
  if (sourceKind === "herd") return "herd";
  return `agent${msg.agent?.sessionLabel ? ` ${formatInlineText(msg.agent.sessionLabel)}` : ""}`;
}

function takodeUserContentLimits(surface: TakodeUserContentSurface): Record<TakodeUserMessageSourceKind, number> {
  if (surface === "scan") return TAKODE_SCAN_USER_CONTENT_LIMITS;
  if (surface === "peek") return TAKODE_PEEK_USER_CONTENT_LIMITS;
  return TAKODE_READ_USER_CONTENT_LIMITS;
}

function formatTakodeUserContent(
  content: string,
  msg: TakodeMessageSourceLike,
  surface: TakodeUserContentSurface,
): string {
  const limits = takodeUserContentLimits(surface);
  return formatQuotedContent(content, limits[takodeUserMessageSourceKind(msg)]);
}

function truncateTakodeUserContent(
  content: string,
  msg: TakodeMessageSourceLike,
  surface: TakodeUserContentSurface,
): { content: string; remainingChars: number; truncated: boolean } {
  const limit = takodeUserContentLimits(surface)[takodeUserMessageSourceKind(msg)];
  if (content.length <= limit) return { content, remainingChars: 0, truncated: false };
  return {
    content: content.slice(0, limit),
    remainingChars: content.length - limit,
    truncated: true,
  };
}

/** Collapse consecutive tool calls with the same name into groups.
 *  e.g. [Read, Read, Grep, Edit, Edit] → [{Read, 2}, {Grep, 1}, {Edit, 2}] */
interface CollapsedToolGroup {
  name: string;
  count: number;
  summaries: string[];
  tools: PeekTool[];
}

type PeekTool = {
  idx: number;
  name: string;
  summary: string;
  status?: "running" | "completed" | "error" | "orphaned";
  durationSeconds?: number;
  result?: string;
  resultTruncated?: boolean;
  resultTotalSize?: number;
  syntheticReason?: string;
  retainedOutput?: boolean;
};

function collapseToolCalls(tools: PeekTool[]): CollapsedToolGroup[] {
  const groups: CollapsedToolGroup[] = [];
  for (const tool of tools) {
    const last = groups[groups.length - 1];
    if (last && last.name === tool.name) {
      last.count++;
      last.summaries.push(tool.summary);
      last.tools.push(tool);
    } else {
      groups.push({ name: tool.name, count: 1, summaries: [tool.summary], tools: [tool] });
    }
  }
  return groups;
}

function formatPeekToolStatus(tool: PeekTool): string {
  const duration = typeof tool.durationSeconds === "number" ? ` ${formatDurationSeconds(tool.durationSeconds)}` : "";
  switch (tool.status) {
    case "completed":
      return `✓${duration}`;
    case "error":
      return `✗${duration}`;
    case "orphaned":
      return `orphaned${duration}`;
    case "running":
      return "running";
    default:
      return "";
  }
}

function formatPeekToolLine(tool: PeekTool): string {
  const status = formatPeekToolStatus(tool);
  const summary = truncate(tool.summary, 80);
  const parts = [formatInlineText(tool.name), status, summary].filter(Boolean);
  const result = tool.result ? ` -- ${truncate(tool.result, 100)}${tool.resultTruncated ? " [truncated]" : ""}` : "";
  const reason = tool.syntheticReason ? ` (${formatInlineText(tool.syntheticReason)})` : "";
  return `${parts.join(" ")}${reason}${result}`;
}

// ─── Command handlers ───────────────────────────────────────────────────────

type PeekMessage = {
  idx: number;
  type: string;
  content: string;
  ts: number;
  tools?: PeekTool[];
  toolCounts?: Record<string, number>;
  dur?: number;
  success?: boolean;
  agent?: { sessionId: string; sessionLabel?: string };
};

type CollapsedTurn = {
  turn: number;
  si: number;
  ei: number;
  start: number;
  end?: number;
  dur?: number;
  stats: { tools: number; messages: number; subagents: number };
  success?: boolean;
  result: string;
  user: string;
  agent?: { sessionId: string; sessionLabel?: string };
};

type PeekDefaultResponse = {
  sid: string;
  sn: number;
  name: string;
  status: string;
  quest: { id: string; title: string; status: string } | null;
  pendingTimerCount?: number;
  mode: "default";
  totalTurns: number;
  totalMessages: number;
  collapsed: CollapsedTurn[];
  omitted: number;
  expanded: {
    turn: number;
    start: number;
    end?: number;
    dur?: number;
    messages: PeekMessage[];
    stats: { tools: number; messages: number; subagents: number };
    omittedMsgs: number;
  } | null;
};

type PeekRangeResponse = {
  sid: string;
  sn: number;
  name: string;
  status: string;
  quest: { id: string; title: string; status: string } | null;
  pendingTimerCount?: number;
  mode: "range";
  totalMessages: number;
  from: number;
  to: number;
  messages: PeekMessage[];
  bounds: Array<{ turn: number; si: number; ei: number }>;
};

type PeekDetailResponse = {
  sid: string;
  sn: number;
  name: string;
  status: string;
  quest: { id: string; title: string; status: string } | null;
  pendingTimerCount?: number;
  turns: Array<{
    turn: number;
    start: number;
    end?: number;
    dur?: number;
    messages: PeekMessage[];
  }>;
};

// ─── Peek rendering helpers ──────────────────────────────────────────────────

function formatCollapsedTurn(turn: CollapsedTurn, surface: "scan" | "peek"): string {
  const endIdx = turn.ei >= 0 ? turn.ei : turn.si; // in-progress turns use si as fallback
  const msgRange = `[${turn.si}]-[${endIdx}]`;
  const startTime = formatTimeShort(turn.start);
  const endTime = turn.end ? formatTimeShort(turn.end) : "running";
  const duration = turn.dur ? `${Math.round(turn.dur / 1000)}s` : "";
  const durationPart = duration ? ` (${duration})` : "";

  const statParts: string[] = [];
  if (turn.stats.tools > 0) statParts.push(`${turn.stats.tools} tools`);
  if (turn.stats.subagents > 0) statParts.push(`${turn.stats.subagents} agents`);
  const statStr = statParts.length > 0 ? ` · ${statParts.join(" · ")}` : "";

  const icon = turn.success === true ? "✓" : turn.success === false ? "✗" : "…";

  const header = `Turn ${turn.turn} · ${msgRange} · ${startTime}-${endTime}${durationPart}${statStr} · ${icon}`;

  const sourceLabel = userSourceLabel(turn);
  const hasUser = !!turn.user;
  const hasResult = !!turn.result;

  // Single-message turn or only one side exists: compact format
  if (!hasUser && !hasResult) return header;
  if (!hasUser) return `${header}\n  ${formatQuotedContent(turn.result, TAKODE_PEEK_CONTENT_LIMIT)}`;
  if (!hasResult) return `${header}\n  ${sourceLabel}: ${formatTakodeUserContent(turn.user, turn, surface)}`;

  // Multi-message turn: show source prompt, ellipsis, and assistant response (no asst: tag)
  return [
    header,
    `  ${sourceLabel}: ${formatTakodeUserContent(turn.user, turn, surface)}`,
    `  ...`,
    `  ${formatQuotedContent(turn.result, TAKODE_PEEK_CONTENT_LIMIT)}`,
  ].join("\n");
}

/** Render a list of messages with tree-pipe connectors for tool calls */
function printExpandedMessages(messages: PeekMessage[]): void {
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const time = formatTime(msg.ts);
    const idx = `[${msg.idx}]`;
    const isLast = mi === messages.length - 1;
    const pipe = isLast ? " " : "|";

    switch (msg.type) {
      case "user":
        console.log(
          `  ${idx.padEnd(7)} ${time}  ${userSourceLabel(msg)}  ${formatTakodeUserContent(msg.content, msg, "peek")}`,
        );
        break;
      case "assistant": {
        const text = msg.content.trim();
        const hasTools = msg.tools && msg.tools.length > 0;
        if (text) {
          console.log(`  ${idx.padEnd(7)} ${time}  ${formatQuotedContent(text, TAKODE_PEEK_CONTENT_LIMIT)}`);
        } else if (hasTools) {
          // No text content -- print idx header so the msg ID is always visible
          console.log(`  ${idx.padEnd(7)} ${time}  tool`);
        }
        if (hasTools) {
          // Collapse consecutive tool calls by name: Read×2, Grep×1
          const collapsed = collapseToolCalls(msg.tools);
          for (let ci = 0; ci < collapsed.length; ci++) {
            const group = collapsed[ci];
            const isLastGroup = ci === collapsed.length - 1;
            const connector = isLastGroup && isLast ? "└─" : "├─";
            if (group.count === 1) {
              const detail = formatPeekToolLine(group.tools[0]!);
              console.log(`  ${pipe}       ${connector} ${detail}`);
            } else {
              // Multiple consecutive calls of the same tool -- show count + combined summaries
              const summaryParts = group.summaries.filter(Boolean).slice(0, 3);
              const summaryStr =
                summaryParts.length > 0
                  ? ` ${summaryParts.join(", ")}${group.count > 3 ? `, ...+${group.count - 3}` : ""}`
                  : "";
              console.log(`  ${pipe}       ${connector} ${formatInlineText(group.name)}×${group.count}${summaryStr}`);
            }
          }
        }
        break;
      }
      case "result": {
        const icon = msg.success ? "✓" : "✗";
        const resultText = msg.content.trim();
        if (resultText) {
          console.log(
            `  ${idx.padEnd(7)} ${time}  ${icon} ${formatQuotedContent(resultText, TAKODE_PEEK_CONTENT_LIMIT)}`,
          );
        } else {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} "done"`);
        }
        break;
      }
      case "system":
        console.log(`  ${idx.padEnd(7)} ${time}  sys   ${formatQuotedContent(msg.content, TAKODE_PEEK_CONTENT_LIMIT)}`);
        break;
    }
  }
}

function printPeekHeader(d: {
  sn: number;
  name: string;
  status: string;
  quest?: { id: string; title: string; status: string } | null;
  pendingTimerCount?: number;
}): void {
  console.log(
    `Session #${d.sn} "${formatInlineText(d.name)}" -- ${formatInlineText(d.status)}  ⏰${d.pendingTimerCount ?? 0}`,
  );
  if (d.quest) {
    console.log(
      `Quest: ${formatInlineText(d.quest.id)} "${formatInlineText(d.quest.title)}" [${formatInlineText(d.quest.status)}]`,
    );
  }
}

// ─── Peek mode handlers ─────────────────────────────────────────────────────

function printPeekDefault(d: PeekDefaultResponse, sessionRef: string): void {
  const safeSessionRef = formatInlineText(sessionRef);
  printPeekHeader(d);
  console.log(`Total: ${d.totalTurns} turns, ${d.totalMessages} messages (msg [0]-[${d.totalMessages - 1}])`);
  console.log("");

  let lastDate = "";

  // Omitted turns hint
  if (d.omitted > 0) {
    // Print the date boundary for the first collapsed turn if we have one
    if (d.collapsed.length > 0) {
      const firstDate = dateKey(d.collapsed[0].start);
      if (firstDate !== lastDate) {
        console.log(`── ${formatDate(d.collapsed[0].start)} ──`);
        lastDate = firstDate;
      }
    }
    console.log(`  ... ${d.omitted} earlier turns omitted (takode peek ${safeSessionRef} --from 0 to browse)`);
    console.log("");
  }

  // Collapsed turns
  for (const turn of d.collapsed) {
    const turnDate = dateKey(turn.start);
    if (turnDate !== lastDate) {
      console.log(`── ${formatDate(turn.start)} ──`);
      lastDate = turnDate;
    }
    console.log(formatCollapsedTurn(turn, "peek"));
  }

  // Expanded turn (the last turn, shown in detail)
  if (d.expanded) {
    const et = d.expanded;
    const turnDate = dateKey(et.start);
    if (turnDate !== lastDate) {
      console.log(`── ${formatDate(et.start)} ──`);
      lastDate = turnDate;
    }

    const duration = et.dur ? `${Math.round(et.dur / 1000)}s` : "running";
    const durationPart = et.dur ? ` (${duration})` : "";
    const msgCount = et.messages.length + et.omittedMsgs;

    const statParts: string[] = [];
    if (et.stats.tools > 0) statParts.push(`${et.stats.tools} tools`);
    if (et.stats.subagents > 0) statParts.push(`${et.stats.subagents} agents`);
    const statStr = statParts.length > 0 ? ` · ${statParts.join(" · ")}` : "";

    // Check if last message is a result to show success icon
    const lastMsg = et.messages.length > 0 ? et.messages[et.messages.length - 1] : null;
    const successIcon = lastMsg?.type === "result" ? (lastMsg.success ? " · ✓" : " · ✗") : "";

    console.log("");
    console.log(
      `Turn ${et.turn} (last, ${msgCount} messages) · ${formatTimeShort(et.start)}-${et.end ? formatTimeShort(et.end) : "running"}${durationPart}${statStr}${successIcon}`,
    );

    // Omitted messages hint
    if (et.omittedMsgs > 0) {
      const firstIdx = et.messages.length > 0 ? et.messages[0].idx - et.omittedMsgs : 0;
      console.log(
        `  ... ${et.omittedMsgs} earlier messages omitted (takode peek ${safeSessionRef} --from ${firstIdx} to see all)`,
      );
    }

    printExpandedMessages(et.messages);
    console.log("");
  }

  // Hint
  console.log(
    `Hint: takode peek ${safeSessionRef} for latest activity | --turn <N> to expand a turn | --from <msg-id> or --until <msg-id> to browse | takode read ${safeSessionRef} <msg-id> for full message`,
  );
}

function printPeekRange(d: PeekRangeResponse, sessionRef: string, count: number): void {
  const safeSessionRef = formatInlineText(sessionRef);
  printPeekHeader(d);
  console.log(`Messages [${d.from}]-[${d.to}] of [0]-[${d.totalMessages - 1}]`);
  console.log("");

  let lastDate = "";
  let activeTurnNum = -1;

  for (let mi = 0; mi < d.messages.length; mi++) {
    const msg = d.messages[mi];

    // Date boundary
    const msgDate = dateKey(msg.ts);
    if (msgDate !== lastDate) {
      console.log(`── ${formatDate(msg.ts)} ──`);
      lastDate = msgDate;
    }

    // Turn boundary
    const boundary = d.bounds.find((b) => msg.idx >= b.si && msg.idx <= b.ei);
    if (boundary && boundary.turn !== activeTurnNum) {
      console.log(`--- Turn ${boundary.turn} ---`);
      activeTurnNum = boundary.turn;
    }

    // Message rendering (compact: tool counts instead of individual lines)
    const time = formatTime(msg.ts);
    const idx = `[${msg.idx}]`;

    switch (msg.type) {
      case "user":
        console.log(
          `  ${idx.padEnd(7)} ${time}  ${userSourceLabel(msg)}  ${formatTakodeUserContent(msg.content, msg, "peek")}`,
        );
        break;
      case "assistant": {
        const text = msg.content.trim();
        const hasExpandedTools = msg.tools && msg.tools.length > 0;
        if (hasExpandedTools) {
          // Expanded tool display (--show-tools)
          if (text) {
            console.log(`  ${idx.padEnd(7)} ${time}  ${formatQuotedContent(text, TAKODE_PEEK_CONTENT_LIMIT)}`);
          } else {
            console.log(`  ${idx.padEnd(7)} ${time}  tool`);
          }
          for (const tool of msg.tools) {
            console.log(`  ${idx.padEnd(7)}           → ${formatPeekToolLine(tool)}`);
          }
        } else {
          // Compact tool counts (default)
          const toolStr = msg.toolCounts
            ? "  (" +
              Object.entries(msg.toolCounts)
                .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
                .join(", ") +
              ")"
            : "";
          if (text) {
            console.log(
              `  ${idx.padEnd(7)} ${time}  ${formatQuotedContent(text, TAKODE_PEEK_CONTENT_LIMIT)}${toolStr}`,
            );
          } else if (toolStr) {
            console.log(`  ${idx.padEnd(7)} ${time}  tool ${toolStr}`);
          }
        }
        break;
      }
      case "result": {
        const icon = msg.success ? "✓" : "✗";
        const resultText = msg.content.trim();
        if (resultText) {
          console.log(
            `  ${idx.padEnd(7)} ${time}  ${icon} ${formatQuotedContent(resultText, TAKODE_PEEK_CONTENT_LIMIT)}`,
          );
        } else {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} "done"`);
        }
        break;
      }
      case "system":
        console.log(`  ${idx.padEnd(7)} ${time}  sys   ${formatQuotedContent(msg.content, TAKODE_PEEK_CONTENT_LIMIT)}`);
        break;
    }
  }

  console.log("");

  // Navigation hints
  const hints: string[] = [];
  const firstShown = d.messages[0]?.idx ?? d.from;
  const lastShown = d.messages[d.messages.length - 1]?.idx ?? d.to;
  if (firstShown > 0) {
    hints.push(`Prev: takode peek ${safeSessionRef} --until ${firstShown} --count ${count}`);
  }
  if (lastShown < d.totalMessages - 1) {
    hints.push(`Next: takode peek ${safeSessionRef} --from ${lastShown + 1} --count ${count}`);
  }
  if (hints.length > 0) {
    console.log(hints.join("  |  "));
  }
}

function printPeekDetail(d: PeekDetailResponse): void {
  printPeekHeader(d);
  console.log("");

  let lastDate = "";
  for (const turn of d.turns) {
    const turnDate = turn.start ? dateKey(turn.start) : "";
    if (turnDate && turnDate !== lastDate) {
      console.log(`── ${formatDate(turn.start)} ──`);
      lastDate = turnDate;
    }

    const duration = turn.dur ? `${Math.round(turn.dur / 1000)}s` : "running";
    const ended = turn.end ? `, ended ${formatTime(turn.end)}` : "";
    console.log(`--- Turn ${turn.turn} (${duration}${ended}) ---`);

    printExpandedMessages(turn.messages);
    console.log("");
  }
}

// ─── Peek entry point ────────────────────────────────────────────────────────

export async function handlePeek(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef)
    err(
      "Usage: takode peek <session> [--from N] [--until N] [--count N] [--task N] [--turn N] [--show-tools] [--detail] [--turns N] [--json]",
    );
  const safeSessionRef = formatInlineText(sessionRef);

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const showTools = flags["show-tools"] === true;
  const taskNum = parseIntegerFlag(flags, "task", "task number");
  const turnNum = parseIntegerFlag(flags, "turn", "turn number");
  const fromIdx = parseIntegerFlag(flags, "from", "message index");
  const untilIdx = parseIntegerFlag(flags, "until", "message index");
  const count = parsePositiveIntegerFlag(flags, "count", "message count", 60);
  const detail = flags.detail === true;

  if (fromIdx !== undefined && fromIdx < 0) err("--from must be a non-negative integer.");
  if (untilIdx !== undefined && untilIdx < 0) err("--until must be a non-negative integer.");
  if (turnNum !== undefined && turnNum < 0) err("--turn must be a non-negative integer.");

  // Resolve --turn N to a message range via the server
  if (turnNum !== undefined) {
    const params = new URLSearchParams({ turn: String(turnNum) });
    if (showTools) params.set("showTools", "true");
    const path = `/sessions/${encodeURIComponent(sessionRef)}/messages?${params}`;
    const data = await apiGet(base, path);
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    printPeekRange(data as PeekRangeResponse, sessionRef, count);
    return;
  }

  // Resolve --task N to a message range via the tasks endpoint
  if (taskNum !== undefined) {
    const tasksData = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/tasks`)) as {
      tasks: Array<{ taskNum: number; startIdx: number; endIdx: number }>;
    };
    const task = tasksData.tasks.find((t) => t.taskNum === taskNum);
    if (!task) err(`Task #${taskNum} not found. Use "takode tasks ${safeSessionRef}" to see available tasks.`);

    const params = new URLSearchParams({ from: String(task.startIdx), count: String(count) });
    if (showTools) params.set("showTools", "true");
    const path = `/sessions/${encodeURIComponent(sessionRef)}/messages?${params}`;
    const data = await apiGet(base, path);
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    printPeekRange(data as PeekRangeResponse, sessionRef, count);
    return;
  }

  // Determine mode and build query params
  let path: string;

  if (fromIdx !== undefined || untilIdx !== undefined) {
    // Range mode
    const params = new URLSearchParams({ count: String(count) });
    if (fromIdx !== undefined) params.set("from", String(fromIdx));
    if (untilIdx !== undefined) params.set("until", String(untilIdx));
    if (showTools) params.set("showTools", "true");
    path = `/sessions/${encodeURIComponent(sessionRef)}/messages?${params}`;

    const data = await apiGet(base, path);
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    printPeekRange(data as PeekRangeResponse, sessionRef, count);
  } else if (detail) {
    // Detail mode (legacy behavior)
    const turns = Number(flags.turns) || 1;
    const params = new URLSearchParams({ detail: "true", turns: String(turns) });
    path = `/sessions/${encodeURIComponent(sessionRef)}/messages?${params}`;

    const data = await apiGet(base, path);
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    printPeekDetail(data as PeekDetailResponse);
  } else {
    // Default mode (smart overview)
    path = `/sessions/${encodeURIComponent(sessionRef)}/messages`;

    const data = await apiGet(base, path);
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    printPeekDefault(data as PeekDefaultResponse, sessionRef);
  }
}

export async function handleRead(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  const msgIdx = args[1];
  if (!sessionRef || !msgIdx) err("Usage: takode read <session> <msg-id> [--offset N] [--limit N] [--json]");

  const flags = parseFlags(args.slice(2));
  const offset = Number(flags.offset) || 0;
  const limit = Number(flags.limit) || 200;
  const jsonMode = flags.json === true;

  const params = new URLSearchParams();
  if (offset) params.set("offset", String(offset));
  if (limit !== 200) params.set("limit", String(limit));
  const qs = params.toString() ? `?${params}` : "";

  const data = await apiGet(
    base,
    `/sessions/${encodeURIComponent(sessionRef)}/messages/${encodeURIComponent(msgIdx)}${qs}`,
  );

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const d = data as {
    idx: number;
    type: string;
    ts: number;
    totalLines: number;
    offset: number;
    limit: number;
    content: string;
    contentBlocks?: { type: string }[];
    rawMessage?: {
      type?: string;
      agentSource?: { sessionId: string; sessionLabel?: string };
    };
  };

  const time = formatTime(d.ts);
  const lineInfo =
    d.totalLines > d.limit
      ? ` (lines ${d.offset + 1}-${d.offset + d.limit} of ${d.totalLines})`
      : ` (${d.totalLines} lines)`;
  const userMessageSource =
    d.type === "user_message" || d.rawMessage?.type === "user_message" ? { agent: d.rawMessage?.agentSource } : null;
  const typeLabel = userMessageSource
    ? userSourceLabel(userMessageSource)
    : d.type === "assistant" && d.contentBlocks?.some((b) => b.type === "tool_use")
      ? "assistant (tools)"
      : d.type;
  console.log(`[msg ${d.idx}] ${formatInlineText(typeLabel)} -- ${time}${lineInfo}`);
  console.log("\u2500".repeat(60));

  // Print with line numbers (like the Read tool)
  const visibleContent = userMessageSource ? truncateTakodeUserContent(d.content, userMessageSource, "read") : null;
  const lines = (visibleContent?.content ?? d.content).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNum = String(d.offset + i + 1).padStart(4);
    console.log(`${lineNum}  ${formatInlineText(lines[i] ?? "")}`);
  }

  if (visibleContent?.truncated) {
    console.log("");
    console.log(`... ${visibleContent.remainingChars} more chars hidden. Use --json for full content.`);
  } else if (d.offset + lines.length < d.totalLines) {
    console.log("");
    console.log(
      `... ${d.totalLines - d.offset - lines.length} more lines. Use --offset ${d.offset + d.limit} to continue.`,
    );
  }
}

type PeekTurnScanResponse = {
  sid: string;
  sn: number;
  name: string;
  status: string;
  quest: { id: string; title: string; status: string } | null;
  pendingTimerCount?: number;
  mode: "turn_scan";
  totalTurns: number;
  totalMessages: number;
  from: number;
  count: number;
  turns: CollapsedTurn[];
};

export async function handleScan(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode scan <session> [--from N] [--until N] [--count N] [--json]");
  const safeSessionRef = formatInlineText(sessionRef);

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const explicitFrom = parseIntegerFlag(flags, "from", "turn number");
  const explicitUntil = parseIntegerFlag(flags, "until", "turn number");
  const turnCount = parsePositiveIntegerFlag(flags, "count", "turn count", 50);

  if (explicitFrom !== null && explicitFrom !== undefined && explicitFrom < 0)
    err("--from must be a non-negative integer.");
  if (explicitFrom !== null && explicitFrom !== undefined && explicitUntil !== null && explicitUntil !== undefined)
    err("Cannot use both --from and --until. Use one or the other.");

  // Resolve fromTurn:
  // --from N        → start at turn N (forward)
  // --until N       → show `count` turns ending before turn N (backward)
  // (neither)       → show last `count` turns (backward from end)
  let fromTurn: number;
  if (explicitFrom !== null && explicitFrom !== undefined) {
    fromTurn = explicitFrom;
  } else if (explicitUntil !== null && explicitUntil !== undefined) {
    fromTurn = Math.max(0, explicitUntil - turnCount);
  } else {
    // Probe total turns to compute backward offset
    const probeParams = new URLSearchParams({ scan: "turns", fromTurn: "0", turnCount: "0" });
    const probe = (await apiGet(
      base,
      `/sessions/${encodeURIComponent(sessionRef)}/messages?${probeParams}`,
    )) as PeekTurnScanResponse;
    fromTurn = Math.max(0, probe.totalTurns - turnCount);
  }

  const params = new URLSearchParams({
    scan: "turns",
    fromTurn: String(fromTurn),
    turnCount: String(turnCount),
  });
  const path = `/sessions/${encodeURIComponent(sessionRef)}/messages?${params}`;
  const data = (await apiGet(base, path)) as PeekTurnScanResponse;

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  printPeekHeader(data);
  console.log(`${data.totalTurns} turns, ${data.totalMessages} messages`);

  if (data.count === 0) {
    console.log("\nNo turns in this range.");
    return;
  }

  const endTurn = data.from + data.count - 1;
  console.log(`Showing turns ${data.from}-${endTurn}:`);
  console.log("");

  let lastDate = "";
  for (const turn of data.turns) {
    const turnDate = dateKey(turn.start);
    if (turnDate !== lastDate) {
      console.log(`── ${formatDate(turn.start)} ──`);
      lastDate = turnDate;
    }
    console.log(formatCollapsedTurn(turn, "scan"));
  }

  console.log("");

  // Navigation hints -- "Older" goes toward turn 0, "Newer" goes toward the end
  const hints: string[] = [];
  if (data.from > 0) {
    hints.push(`Older: takode scan ${safeSessionRef} --until ${data.from} --count ${turnCount}`);
  }
  if (data.from + data.count < data.totalTurns) {
    hints.push(`Newer: takode scan ${safeSessionRef} --from ${data.from + data.count} --count ${turnCount}`);
  }
  if (hints.length > 0) {
    console.log(hints.join("  |  "));
  }
  console.log(
    `Expand: takode peek ${safeSessionRef} --turn <N>  |  Full message: takode read ${safeSessionRef} <msg-id>`,
  );
}

// ─── Grep handler ────────────────────────────────────────────────────────────

export async function handleGrep(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode grep <session> <pattern> [--type user|assistant|result] [--count N] [--json]");
  const safeSessionRef = formatInlineText(sessionRef);

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const limit = parsePositiveIntegerFlag(flags, "count", "result count", 50);
  const typeFilter = typeof flags.type === "string" ? flags.type : undefined;

  if (typeFilter && !["user", "assistant", "result"].includes(typeFilter)) {
    err(`Invalid --type "${typeFilter}". Must be one of: user, assistant, result`);
  }

  // Build query from non-flag tokens after session ref.
  // Skip tokens consumed by flags (--key value pairs and --boolean flags).
  const flagConsumed = new Set<number>();
  {
    let i = 1; // skip session ref
    while (i < args.length) {
      if (args[i].startsWith("--")) {
        flagConsumed.add(i);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flagConsumed.add(i + 1);
          i += 2;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
  }
  const query = args
    .slice(1)
    .filter((_, i) => !flagConsumed.has(i + 1))
    .join(" ")
    .trim();

  if (!query) err("Usage: takode grep <session> <pattern> [--type user|assistant|result] [--count N] [--json]");

  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (typeFilter) params.set("type", typeFilter);
  const data = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/grep?${params}`)) as {
    sessionId: string;
    sessionNum: number;
    query: string;
    totalMatches: number;
    warning?: string;
    matches: Array<{
      idx: number;
      type: string;
      ts: number;
      snippet: string;
      turn: number | null;
    }>;
  };

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.totalMatches === 0) {
    console.log(`No matches for "${formatInlineText(query)}" in session #${data.sessionNum}.`);
    if (data.warning) console.log(`  Hint: ${data.warning}`);
    return;
  }

  const shown = data.matches.length;
  const total = data.totalMatches;
  console.log(
    `${total} match${total === 1 ? "" : "es"} for "${formatInlineText(query)}" in session #${data.sessionNum}${shown < total ? ` (showing first ${shown})` : ""}:`,
  );
  console.log("");

  for (const match of data.matches) {
    const time = formatTimeShort(match.ts);
    const idx = `[${match.idx}]`;
    const turnLabel = match.turn !== null ? `T${match.turn}` : "  ";
    const typeLabel = match.type.padEnd(6);
    console.log(`  ${idx.padEnd(7)} ${time}  ${typeLabel} ${turnLabel.padEnd(5)} ${match.snippet}`);
  }

  console.log("");
  console.log(
    `Hint: takode read ${safeSessionRef} <msg-id> for full message | takode peek ${safeSessionRef} --turn <N> for turn context`,
  );
}

// ─── Export handler ──────────────────────────────────────────────────────────

export async function handleExport(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const filePath = args.filter((a) => !a.startsWith("--"))[1];
  if (!sessionRef || !filePath) err("Usage: takode export <session> <path>");

  const data = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/export`)) as {
    sessionId: string;
    totalMessages: number;
    totalTurns: number;
    text: string;
  };

  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, data.text, "utf-8");
  console.log(`Exported ${data.totalMessages} messages (${data.totalTurns} turns) to ${filePath}`);
}

// ─── Logs handler ───────────────────────────────────────────────────────────

function parsePositiveInt(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function levelColor(level: ServerLogEntry["level"]): string {
  switch (level) {
    case "debug":
      return "\x1b[90m";
    case "warn":
      return "\x1b[33m";
    case "error":
      return "\x1b[31m";
    default:
      return "";
  }
}

function formatLogEntry(entry: ServerLogEntry): string {
  const time = new Date(entry.ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const level = entry.level.toUpperCase().padEnd(5);
  const component = entry.component.slice(0, 18).padEnd(18);
  const color = levelColor(entry.level);
  const reset = color ? "\x1b[0m" : "";
  const detailParts: string[] = [];
  if (entry.sessionId) detailParts.push(`session=${entry.sessionId}`);
  if (entry.source) detailParts.push(`source=${entry.source}`);
  if (entry.meta && Object.keys(entry.meta).length > 0) detailParts.push(JSON.stringify(entry.meta));
  const detail = detailParts.length > 0 ? ` ${detailParts.join(" ")}` : "";
  return `${time} ${color}${level}${reset} ${component} ${formatInlineText(entry.message)}${detail}`;
}

async function streamTakodeLogs(base: string, query: string, onEntry: (entry: ServerLogEntry) => void): Promise<void> {
  const controller = new AbortController();
  const cleanup = () => controller.abort();
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  try {
    const res = await fetch(`${base}/logs/stream${query ? `?${query}` : ""}`, {
      headers: takodeAuthHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error("Log stream did not return a body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        let eventType = "";
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (eventType !== "entry" || !data) continue;
        onEntry(JSON.parse(data) as ServerLogEntry);
      }
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      throw err;
    }
  } finally {
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
  }
}

export async function handleLogs(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const jsonMode = flags.json === true;
  const follow = flags.follow === true;
  const query = {
    levels: parseLogLevels(typeof flags.level === "string" ? flags.level : undefined),
    components:
      typeof flags.component === "string"
        ? flags.component
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : undefined,
    sessionId: typeof flags.session === "string" ? flags.session : undefined,
    pattern: typeof flags.pattern === "string" ? flags.pattern : undefined,
    regex: flags.regex === true,
    since: parseLogTime(typeof flags.since === "string" ? flags.since : undefined),
    until: parseLogTime(typeof flags.until === "string" ? flags.until : undefined),
    limit: parsePositiveInt(flags.limit) ?? 200,
  };

  if (follow) {
    await streamTakodeLogs(base, encodeLogQuery({ ...query, tail: query.limit ?? 200 }), (entry) => {
      if (jsonMode) {
        console.log(JSON.stringify(entry));
      } else {
        console.log(formatLogEntry(entry));
      }
    });
    return;
  }

  const queryString = encodeLogQuery(query);
  const data = (await apiGet(base, `/logs${queryString ? `?${queryString}` : ""}`)) as LogQueryResponse;

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.entries.length === 0) {
    console.log("No matching logs.");
  } else {
    for (const entry of data.entries) {
      console.log(formatLogEntry(entry));
    }
  }
}

// ─── Main dispatch ──────────────────────────────────────────────────────────
