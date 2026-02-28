#!/usr/bin/env bun
/**
 * Takode CLI — cross-session orchestration commands.
 * Only available in orchestrator sessions (TAKODE_ROLE=orchestrator).
 */

const DEFAULT_PORT = 3456;
const DEFAULT_TIMEOUT = 120; // seconds

// ─── Port discovery (same pattern as ctl.ts) ────────────────────────────────

function getPort(argv: string[]): number {
  const idx = argv.indexOf("--port");
  if (idx !== -1 && argv[idx + 1]) {
    const p = Number(argv[idx + 1]);
    if (!Number.isNaN(p) && p > 0) return p;
  }
  // Orchestrator sessions get TAKODE_API_PORT
  if (process.env.TAKODE_API_PORT) {
    const p = Number(process.env.TAKODE_API_PORT);
    if (!Number.isNaN(p) && p > 0) return p;
  }
  return Number(process.env.COMPANION_PORT) || DEFAULT_PORT;
}

function getBase(argv: string[]): string {
  return `http://localhost:${getPort(argv)}/api`;
}

/** Strip --port <n> from argv so subcommand parsers don't see it */
function stripGlobalFlags(argv: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === "--port" && argv[i + 1]) {
      i += 2;
      continue;
    }
    result.push(argv[i]);
    i++;
  }
  return result;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function apiGet(base: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost(base: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

function err(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

/** Parse --key value pairs from argv. Supports --flag (boolean true). */
function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      i++;
    }
  }
  return flags;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function formatTime(epoch: number): string {
  const d = new Date(epoch);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTimeShort(epoch: number): string {
  const d = new Date(epoch);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function formatDate(epoch: number): string {
  const d = new Date(epoch);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Returns YYYY-MM-DD for date boundary comparison */
function dateKey(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatRelativeTime(epoch: number): string {
  const diff = Date.now() - epoch;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  return `${Math.round(diff / 3600000)}h ago`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + ` [+${s.length - max} chars]`;
}

// ─── Event printer ──────────────────────────────────────────────────────────

function printEvents(events: unknown[], jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  for (const evt of events as Array<{
    event: string;
    sessionNum: number;
    sessionName: string;
    ts: number;
    data: Record<string, unknown>;
  }>) {
    const time = formatTime(evt.ts);
    const session = `#${evt.sessionNum} "${evt.sessionName}"`;

    switch (evt.event) {
      case "turn_end": {
        const duration = evt.data.duration_ms ? ` (${Math.round(Number(evt.data.duration_ms) / 1000)}s)` : "";
        console.log(`[${time}] turn_end  ${session}${duration}`);
        if (evt.data.toolSummary) {
          const tools = evt.data.toolSummary as Record<string, number>;
          const parts = Object.entries(tools).map(([k, v]) => `${k}(${v})`);
          console.log(`  Tools: ${parts.join(", ")}`);
        }
        if (evt.data.resultPreview) {
          console.log(`  Result: ${truncate(String(evt.data.resultPreview), 120)}`);
        }
        break;
      }
      case "turn_start": {
        console.log(`[${time}] turn_start  ${session}`);
        if (evt.data.userMessage) {
          console.log(`  Message: ${truncate(String(evt.data.userMessage), 100)}`);
        }
        break;
      }
      case "permission_request": {
        console.log(`[${time}] permission_request  ${session}`);
        console.log(`  ${evt.data.tool_name}: ${truncate(String(evt.data.summary || ""), 100)}`);
        break;
      }
      case "permission_resolved": {
        const icon = evt.data.outcome === "approved" ? "\u2713" : "\u2717";
        console.log(`[${time}] permission_resolved  ${session}  ${icon} ${evt.data.tool_name}`);
        break;
      }
      case "session_disconnected": {
        console.log(`[${time}] session_disconnected  ${session}`);
        break;
      }
      case "session_error": {
        console.log(`[${time}] session_error  ${session}`);
        if (evt.data.error) {
          console.log(`  Error: ${truncate(String(evt.data.error), 120)}`);
        }
        break;
      }
      case "quest_update": {
        console.log(`[${time}] quest_update`);
        break;
      }
      case "user_message": {
        console.log(`[${time}] user_message  ${session}`);
        if (evt.data.content) {
          console.log(`  "${truncate(String(evt.data.content), 100)}"`);
        }
        break;
      }
      default:
        console.log(`[${time}] ${evt.event}  ${session}`);
    }
    console.log(""); // blank line between events
  }
}

// ─── Command handlers ───────────────────────────────────────────────────────

async function handleList(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const showAll = flags.all === true;
  const jsonMode = flags.json === true;

  const sessions = await apiGet(base, "/sessions") as Array<{
    sessionId: string;
    sessionNum?: number;
    name?: string;
    state: string;
    archived?: boolean;
    cwd: string;
    createdAt: number;
    lastActivityAt?: number;
    model?: string;
    backendType?: string;
    isOrchestrator?: boolean;
    isAssistant?: boolean;
    cliConnected?: boolean;
    lastMessagePreview?: string;
    gitBranch?: string;
    attentionReason?: string;
    repoRoot?: string;
    isWorktree?: boolean;
  }>;

  // Filter unless --all
  const filtered = showAll ? sessions : sessions.filter(s => !s.archived && s.state !== "exited");

  if (jsonMode) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log("No active sessions.");
    return;
  }

  // Group sessions by project (repo root or cwd)
  const groups = new Map<string, typeof filtered>();
  const archived: typeof filtered = [];

  for (const s of filtered) {
    if (s.archived) {
      archived.push(s);
      continue;
    }
    const projectKey = (s.repoRoot || s.cwd || "").replace(/\/+$/, "") || "/";
    if (!groups.has(projectKey)) groups.set(projectKey, []);
    groups.get(projectKey)!.push(s);
  }

  // Sort groups alphabetically by label, render each
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => {
    const labelA = a.split("/").pop() || a;
    const labelB = b.split("/").pop() || b;
    return labelA.localeCompare(labelB);
  });

  let total = 0;
  for (const [projectKey, projectSessions] of sortedGroups) {
    const label = projectKey.split("/").pop() || projectKey;
    const running = projectSessions.filter(s => s.cliConnected && s.state === "running").length;
    const countLabel = running > 0 ? `  (${running} running)` : "";
    console.log(`▸ ${label}  ${projectSessions.length}${countLabel}`);

    // Sort: running first, then by most recent activity
    projectSessions.sort((a, b) => {
      const aRunning = a.cliConnected && a.state === "running" ? 1 : 0;
      const bRunning = b.cliConnected && b.state === "running" ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });

    for (const s of projectSessions) {
      printSessionLine(s);
      total++;
    }
    console.log("");
  }

  // Archived group
  if (archived.length > 0) {
    console.log(`▸ ARCHIVED  ${archived.length}`);
    for (const s of archived) {
      printSessionLine(s);
      total++;
    }
    console.log("");
  }

  console.log(`${total} session(s)${showAll ? "" : " (active only, use --all to see all)"}`);
  console.log(`Status: ● running  ○ idle  ✗ disconnected  ⊘ archived  ⚠ needs attention`);
}

function printSessionLine(s: {
  sessionNum?: number;
  name?: string;
  state: string;
  cliConnected?: boolean;
  archived?: boolean;
  isOrchestrator?: boolean;
  isAssistant?: boolean;
  model?: string;
  gitBranch?: string;
  attentionReason?: string;
  lastActivityAt?: number;
  lastMessagePreview?: string;
  isWorktree?: boolean;
}): void {
  const num = s.sessionNum !== undefined ? `#${s.sessionNum}` : "  ";
  const name = s.name || "(unnamed)";
  const role = s.isOrchestrator ? " [orch]" : s.isAssistant ? " [asst]" : "";
  const status = s.cliConnected
    ? (s.state === "running" ? "●" : "○")
    : (s.archived ? "⊘" : "✗");
  const attention = s.attentionReason ? ` ⚠ ${s.attentionReason}` : "";
  const branch = s.gitBranch ? `  ${s.gitBranch}` : "";
  const wt = s.isWorktree ? " wt" : "";
  const activity = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : "";
  const preview = s.lastMessagePreview ? `  "${truncate(s.lastMessagePreview, 50)}"` : "";

  console.log(`  ${num.padEnd(5)} ${status} ${name}${role}${attention}`);
  console.log(`        ${branch}${wt}  ${activity}${preview}`);
}

async function handleWatch(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  let sessionsRaw = flags.sessions as string;
  if (!sessionsRaw) err("Usage: takode watch --sessions <id1,id2,...> [--timeout <seconds>] [--all-events] [--json]");

  // Auto-include own session so human messages interrupt watch
  const ownSessionId = process.env.COMPANION_SESSION_ID;
  if (ownSessionId) {
    sessionsRaw = sessionsRaw + "," + ownSessionId;
  }

  const timeout = Number(flags.timeout) || DEFAULT_TIMEOUT;
  const jsonMode = flags.json === true;
  const since = Number(flags.since) || 0;
  const allEvents = flags["all-events"] === true;

  // Default: only actionable events (things a human would be notified about).
  // Use --all-events to include intermediate events like turn_start, permission_resolved.
  const actionableEvents = new Set([
    "turn_end", "permission_request", "quest_update",
    "session_disconnected", "session_error", "user_message",
  ]);

  const url = `${base}/events/stream?sessions=${encodeURIComponent(sessionsRaw)}&timeout=${timeout * 1000}&since=${since}`;

  const controller = new AbortController();
  const res = await fetch(url, {
    signal: controller.signal,
    headers: { Accept: "text/event-stream" },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    err((body as { error?: string }).error || `HTTP ${res.status}`);
  }

  const events: unknown[] = [];
  let flushed = false;

  // Parse SSE stream
  const reader = res.body?.getReader();
  if (!reader) err("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // keep incomplete line

    let eventType = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6);

        if (eventType === "flush_complete") {
          flushed = true;
          // If we already collected events during the flush, print and exit
          if (events.length > 0) {
            printEvents(events, jsonMode);
            controller.abort();
            return;
          }
          // Otherwise, wait for first real event
          continue;
        }

        if (eventType === "timeout") {
          // Timeout with no events
          if (events.length > 0) {
            printEvents(events, jsonMode);
          } else if (jsonMode) {
            console.log("[]");
          }
          controller.abort();
          return;
        }

        if (eventType === "event") {
          try {
            const evt = JSON.parse(data);
            // Filter: unless --all-events, only show actionable events
            if (!allEvents && !actionableEvents.has(evt.event)) continue;
            events.push(evt);

            // If flush is complete, we got a real-time event — print and exit
            if (flushed) {
              printEvents(events, jsonMode);
              controller.abort();
              return;
            }
          } catch { /* skip malformed */ }
        }
      } else if (line === "") {
        eventType = ""; // reset after blank line (SSE event boundary)
      }
    }
  }

  // Stream closed — print whatever we have
  if (events.length > 0) {
    printEvents(events, jsonMode);
  } else if (jsonMode) {
    console.log("[]");
  }
}

// ─── Tasks handler ───────────────────────────────────────────────────────────

async function handleTasks(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode tasks <session> [--json]");

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;

  const data = await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/tasks`) as {
    sessionId: string;
    sessionNum: number;
    sessionName: string;
    totalMessages: number;
    tasks: Array<{
      taskNum: number;
      title: string;
      startIdx: number;
      endIdx: number;
      startedAt: number;
      source: string;
      questId: string | null;
    }>;
  };

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Session #${data.sessionNum} "${data.sessionName}"`);
  console.log(`${data.tasks.length} tasks, ${data.totalMessages} messages`);
  console.log("");

  if (data.tasks.length === 0) {
    console.log("  No tasks recorded yet.");
    return;
  }

  // Table header
  console.log(`  #  Started   Task${" ".repeat(50)}Msg Range`);
  console.log(`  ${"─".repeat(78)}`);

  for (const task of data.tasks) {
    const num = String(task.taskNum).padStart(2);
    const time = formatTimeShort(task.startedAt);
    const title = truncate(task.title, 50).padEnd(54);
    const range = `[${task.startIdx}]-[${task.endIdx}]`;
    const quest = task.questId ? ` (${task.questId})` : "";
    console.log(`  ${num}  ${time}   ${title}${range}${quest}`);
  }

  console.log("");
  console.log(`Browse: takode peek ${sessionRef} --from <msg-id> | Task: takode peek ${sessionRef} --task <n>`);
}

// ─── Peek types ──────────────────────────────────────────────────────────────

type PeekMessage = {
  idx: number;
  type: string;
  content: string;
  ts: number;
  tools?: Array<{ idx: number; name: string; summary: string }>;
  toolCounts?: Record<string, number>;
  turnDurationMs?: number;
  success?: boolean;
};

type CollapsedTurn = {
  turnNum: number;
  startIdx: number;
  endIdx: number;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  stats: { tools: number; messages: number; subagents: number };
  success: boolean | null;
  resultPreview: string;
  userPreview: string;
};

type PeekDefaultResponse = {
  sessionId: string;
  sessionNum: number;
  sessionName: string;
  status: string;
  quest: { id: string; title: string; status: string } | null;
  mode: "default";
  totalTurns: number;
  totalMessages: number;
  collapsedTurns: CollapsedTurn[];
  omittedTurnCount: number;
  expandedTurn: {
    turnNum: number;
    startedAt: number;
    endedAt: number | null;
    durationMs: number | null;
    messages: PeekMessage[];
    stats: { tools: number; messages: number; subagents: number };
    omittedMessageCount: number;
  } | null;
};

type PeekRangeResponse = {
  sessionId: string;
  sessionNum: number;
  sessionName: string;
  status: string;
  quest: { id: string; title: string; status: string } | null;
  mode: "range";
  totalMessages: number;
  from: number;
  to: number;
  messages: PeekMessage[];
  turnBoundaries: Array<{ turnNum: number; startIdx: number; endIdx: number }>;
};

type PeekDetailResponse = {
  sessionId: string;
  sessionNum: number;
  sessionName: string;
  status: string;
  quest: { id: string; title: string; status: string } | null;
  turns: Array<{
    turnNum: number;
    startedAt: number;
    endedAt: number | null;
    durationMs: number | null;
    messages: PeekMessage[];
  }>;
};

// ─── Peek rendering helpers ──────────────────────────────────────────────────

function formatCollapsedTurn(turn: CollapsedTurn): string {
  const startTime = formatTimeShort(turn.startedAt);
  const endTime = turn.endedAt ? formatTimeShort(turn.endedAt) : "running";
  const duration = turn.durationMs ? `${Math.round(turn.durationMs / 1000)}s` : "";
  const durationPart = duration ? ` (${duration})` : "";

  const statParts: string[] = [];
  if (turn.stats.tools > 0) statParts.push(`${turn.stats.tools} tools`);
  if (turn.stats.subagents > 0) statParts.push(`${turn.stats.subagents} agents`);
  const statStr = statParts.length > 0 ? ` · ${statParts.join(" · ")}` : "";

  const icon = turn.success === true ? "✓" : turn.success === false ? "✗" : "…";
  const preview = turn.resultPreview ? ` "${truncate(turn.resultPreview, 60)}"` : "";

  return `Turn ${turn.turnNum} · ${startTime}-${endTime}${durationPart}${statStr} · ${icon}${preview}`;
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
        console.log(`  ${idx.padEnd(7)} ${time}  user  "${truncate(msg.content, 80)}"`);
        break;
      case "assistant": {
        const text = msg.content.trim();
        if (text) {
          console.log(`  ${idx.padEnd(7)} ${time}  asst  ${truncate(text, 100)}`);
        }
        if (msg.tools && msg.tools.length > 0) {
          for (let ti = 0; ti < msg.tools.length; ti++) {
            const tool = msg.tools[ti];
            const isLastTool = ti === msg.tools.length - 1 && !text;
            const connector = isLastTool && isLast ? "└─" : "├─";
            console.log(`  ${pipe}       ${connector} ${tool.name.padEnd(6)} ${tool.summary}`);
          }
        }
        break;
      }
      case "result": {
        const icon = msg.success ? "✓" : "✗";
        const resultText = msg.content.trim();
        if (resultText) {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} ${truncate(resultText, 100)}`);
        } else {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} done`);
        }
        break;
      }
      case "system":
        console.log(`  ${idx.padEnd(7)} ${time}  sys   ${msg.content}`);
        break;
    }
  }
}

function printPeekHeader(d: { sessionNum: number; sessionName: string; status: string; quest?: { id: string; title: string; status: string } | null }): void {
  console.log(`Session #${d.sessionNum} "${d.sessionName}" -- ${d.status}`);
  if (d.quest) {
    console.log(`Quest: ${d.quest.id} "${d.quest.title}" [${d.quest.status}]`);
  }
}

// ─── Peek mode handlers ─────────────────────────────────────────────────────

function printPeekDefault(d: PeekDefaultResponse, sessionRef: string): void {
  printPeekHeader(d);
  console.log(`Total: ${d.totalTurns} turns, ${d.totalMessages} messages (msg [0]-[${d.totalMessages - 1}])`);
  console.log("");

  let lastDate = "";

  // Omitted turns hint
  if (d.omittedTurnCount > 0) {
    // Print the date boundary for the first collapsed turn if we have one
    if (d.collapsedTurns.length > 0) {
      const firstDate = dateKey(d.collapsedTurns[0].startedAt);
      if (firstDate !== lastDate) {
        console.log(`── ${formatDate(d.collapsedTurns[0].startedAt)} ──`);
        lastDate = firstDate;
      }
    }
    console.log(`  ... ${d.omittedTurnCount} earlier turns omitted (takode peek ${sessionRef} --from 0 to browse)`);
    console.log("");
  }

  // Collapsed turns
  for (const turn of d.collapsedTurns) {
    const turnDate = dateKey(turn.startedAt);
    if (turnDate !== lastDate) {
      console.log(`── ${formatDate(turn.startedAt)} ──`);
      lastDate = turnDate;
    }
    console.log(formatCollapsedTurn(turn));
  }

  // Expanded turn (the last turn, shown in detail)
  if (d.expandedTurn) {
    const et = d.expandedTurn;
    const turnDate = dateKey(et.startedAt);
    if (turnDate !== lastDate) {
      console.log(`── ${formatDate(et.startedAt)} ──`);
      lastDate = turnDate;
    }

    const duration = et.durationMs ? `${Math.round(et.durationMs / 1000)}s` : "running";
    const durationPart = et.durationMs ? ` (${duration})` : "";
    const msgCount = et.messages.length + et.omittedMessageCount;

    const statParts: string[] = [];
    if (et.stats.tools > 0) statParts.push(`${et.stats.tools} tools`);
    if (et.stats.subagents > 0) statParts.push(`${et.stats.subagents} agents`);
    const statStr = statParts.length > 0 ? ` · ${statParts.join(" · ")}` : "";

    // Check if last message is a result to show success icon
    const lastMsg = et.messages.length > 0 ? et.messages[et.messages.length - 1] : null;
    const successIcon = lastMsg?.type === "result"
      ? (lastMsg.success ? " · ✓" : " · ✗")
      : "";

    console.log("");
    console.log(`Turn ${et.turnNum} (last, ${msgCount} messages) · ${formatTimeShort(et.startedAt)}-${et.endedAt ? formatTimeShort(et.endedAt) : "running"}${durationPart}${statStr}${successIcon}`);

    // Omitted messages hint
    if (et.omittedMessageCount > 0) {
      const firstIdx = et.messages.length > 0 ? et.messages[0].idx - et.omittedMessageCount : 0;
      console.log(`  ... ${et.omittedMessageCount} earlier messages omitted (takode peek ${sessionRef} --from ${firstIdx} to see all)`);
    }

    printExpandedMessages(et.messages);
    console.log("");
  }

  // Hint
  console.log(`Hint: takode peek ${sessionRef} --from <msg-id> to browse history | takode read ${sessionRef} <msg-id> for full message`);
}

function printPeekRange(d: PeekRangeResponse, sessionRef: string, count: number): void {
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
    const boundary = d.turnBoundaries.find(b => msg.idx >= b.startIdx && msg.idx <= b.endIdx);
    if (boundary && boundary.turnNum !== activeTurnNum) {
      console.log(`--- Turn ${boundary.turnNum} ---`);
      activeTurnNum = boundary.turnNum;
    }

    // Message rendering (compact: tool counts instead of individual lines)
    const time = formatTime(msg.ts);
    const idx = `[${msg.idx}]`;

    switch (msg.type) {
      case "user":
        console.log(`  ${idx.padEnd(7)} ${time}  user  "${truncate(msg.content, 80)}"`);
        break;
      case "assistant": {
        const text = msg.content.trim();
        const toolStr = msg.toolCounts
          ? "  (" + Object.entries(msg.toolCounts).map(([n, c]) => c > 1 ? `${n}×${c}` : n).join(", ") + ")"
          : "";
        if (text) {
          console.log(`  ${idx.padEnd(7)} ${time}  asst  ${truncate(text, 90)}${toolStr}`);
        } else if (toolStr) {
          console.log(`  ${idx.padEnd(7)} ${time}  asst ${toolStr}`);
        }
        break;
      }
      case "result": {
        const icon = msg.success ? "✓" : "✗";
        const resultText = msg.content.trim();
        if (resultText) {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} ${truncate(resultText, 100)}`);
        } else {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} done`);
        }
        break;
      }
      case "system":
        console.log(`  ${idx.padEnd(7)} ${time}  sys   ${msg.content}`);
        break;
    }
  }

  console.log("");

  // Navigation hints
  const hints: string[] = [];
  if (d.from > 0) {
    const prevFrom = Math.max(0, d.from - count);
    hints.push(`Prev: takode peek ${sessionRef} --from ${prevFrom}`);
  }
  if (d.to < d.totalMessages - 1) {
    hints.push(`Next: takode peek ${sessionRef} --from ${d.to + 1}`);
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
    const turnDate = turn.startedAt ? dateKey(turn.startedAt) : "";
    if (turnDate && turnDate !== lastDate) {
      console.log(`── ${formatDate(turn.startedAt)} ──`);
      lastDate = turnDate;
    }

    const duration = turn.durationMs ? `${Math.round(turn.durationMs / 1000)}s` : "running";
    const ended = turn.endedAt ? `, ended ${formatTime(turn.endedAt)}` : "";
    console.log(`--- Turn ${turn.turnNum} (${duration}${ended}) ---`);

    printExpandedMessages(turn.messages);
    console.log("");
  }
}

// ─── Peek entry point ────────────────────────────────────────────────────────

async function handlePeek(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode peek <session> [--from N] [--task N] [--detail] [--turns N] [--json]");

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const taskNum = flags.task !== undefined ? Number(flags.task) : undefined;
  const fromIdx = flags.from !== undefined ? Number(flags.from) : undefined;
  const detail = flags.detail === true;

  // Resolve --task N to a message range via the tasks endpoint
  if (taskNum !== undefined) {
    const tasksData = await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/tasks`) as {
      tasks: Array<{ taskNum: number; startIdx: number; endIdx: number }>;
    };
    const task = tasksData.tasks.find(t => t.taskNum === taskNum);
    if (!task) err(`Task #${taskNum} not found. Use "takode tasks ${sessionRef}" to see available tasks.`);

    const count = Number(flags.count) || 30;
    const params = new URLSearchParams({ from: String(task.startIdx), count: String(count) });
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

  if (fromIdx !== undefined) {
    // Range mode
    const count = Number(flags.count) || 30;
    const params = new URLSearchParams({ from: String(fromIdx), count: String(count) });
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

async function handleRead(base: string, args: string[]): Promise<void> {
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

  const data = await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/messages/${encodeURIComponent(msgIdx)}${qs}`);

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
  };

  const time = formatTime(d.ts);
  const lineInfo = d.totalLines > d.limit ? ` (lines ${d.offset + 1}-${d.offset + d.limit} of ${d.totalLines})` : ` (${d.totalLines} lines)`;
  console.log(`[msg ${d.idx}] ${d.type} -- ${time}${lineInfo}`);
  console.log("\u2500".repeat(60));

  // Print with line numbers (like the Read tool)
  const lines = d.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNum = String(d.offset + i + 1).padStart(4);
    console.log(`${lineNum}  ${lines[i]}`);
  }

  if (d.offset + lines.length < d.totalLines) {
    console.log("");
    console.log(`... ${d.totalLines - d.offset - lines.length} more lines. Use --offset ${d.offset + d.limit} to continue.`);
  }
}

async function handleSend(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  const content = args.slice(1).join(" ");

  // Strip flags from content
  const cleanContent = content.replace(/\s*--json\s*/, "").trim();
  const jsonMode = args.includes("--json");

  if (!sessionRef || !cleanContent) err("Usage: takode send <session> <message>");

  const result = await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/message`, { content: cleanContent });

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[${formatTime(Date.now())}] \u2713 Message sent to session ${sessionRef}`);
}

// ─── Search handler ──────────────────────────────────────────────────────────

async function handleSearch(base: string, args: string[]): Promise<void> {
  const query = args.filter(a => !a.startsWith("--")).join(" ").trim();
  if (!query) err("Usage: takode search <query> [--all] [--json]");

  const flags = parseFlags(args);
  const showAll = flags.all === true;
  const jsonMode = flags.json === true;

  const sessions = await apiGet(base, "/sessions") as Array<{
    sessionId: string;
    sessionNum?: number;
    name?: string;
    state: string;
    archived?: boolean;
    cwd: string;
    createdAt: number;
    lastActivityAt?: number;
    backendType?: string;
    cliConnected?: boolean;
    lastMessagePreview?: string;
    gitBranch?: string;
    isWorktree?: boolean;
    isOrchestrator?: boolean;
    isAssistant?: boolean;
    repoRoot?: string;
    taskHistory?: Array<{ title: string }>;
    keywords?: string[];
  }>;

  // Filter active sessions unless --all
  const pool = showAll ? sessions : sessions.filter(s => !s.archived && s.state !== "exited");

  // Search across multiple fields (same algorithm as browser sidebar)
  const q = query.toLowerCase();
  const results: Array<{ session: typeof pool[0]; matchContext: string }> = [];

  for (const s of pool) {
    // 1. Session name
    if (s.name?.toLowerCase().includes(q)) {
      results.push({ session: s, matchContext: `name match` });
      continue;
    }

    // 2. Task history titles
    const matchedTask = s.taskHistory?.find(t => t.title.toLowerCase().includes(q));
    if (matchedTask) {
      results.push({ session: s, matchContext: `task: ${matchedTask.title}` });
      continue;
    }

    // 3. Keywords
    const matchedKw = s.keywords?.find(kw => kw.toLowerCase().includes(q));
    if (matchedKw) {
      results.push({ session: s, matchContext: `keyword: ${matchedKw}` });
      continue;
    }

    // 4. Git branch
    if (s.gitBranch?.toLowerCase().includes(q)) {
      results.push({ session: s, matchContext: `branch: ${s.gitBranch}` });
      continue;
    }

    // 5. Last message preview
    if (s.lastMessagePreview?.toLowerCase().includes(q)) {
      results.push({ session: s, matchContext: `message: "${truncate(s.lastMessagePreview, 50)}"` });
      continue;
    }

    // 6. Working directory
    if (s.cwd?.toLowerCase().includes(q)) {
      results.push({ session: s, matchContext: `path: ${s.cwd}` });
      continue;
    }

    // 7. Repo root
    if (s.repoRoot?.toLowerCase().includes(q)) {
      results.push({ session: s, matchContext: `repo: ${s.repoRoot}` });
      continue;
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(results.map(r => ({
      ...r.session,
      matchContext: r.matchContext,
    })), null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`No sessions matching "${query}".`);
    return;
  }

  console.log(`${results.length} session(s) matching "${query}":`);
  console.log("");

  for (const { session: s, matchContext } of results) {
    const num = s.sessionNum !== undefined ? `#${s.sessionNum}` : "  ";
    const name = s.name || "(unnamed)";
    const status = s.cliConnected
      ? (s.state === "running" ? "●" : "○")
      : (s.archived ? "⊘" : "✗");
    const activity = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : "";

    console.log(`  ${num.padEnd(5)} ${status} ${name}`);
    console.log(`        ${matchContext}  ${activity}`);
    console.log("");
  }
}

// ─── Main dispatch ──────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Usage: takode <command> [options]

Commands:
  list     List sessions (active by default, --all for all)
  search   Search sessions by name, keyword, branch, path, or message
  watch    Wait for events from watched sessions
  tasks    Show task outline of a session (table of contents)
  peek     View session activity (smart overview by default)
  read     Read full content of a specific message
  send     Send a message to a session

Peek modes:
  takode peek 1                    Smart overview (collapsed turns + expanded last turn)
  takode peek 1 --from 500         Browse messages starting at index 500
  takode peek 1 --from 500 --count 50  Browse 50 messages from index 500
  takode peek 1 --detail --turns 3 Full detail on last 3 turns

Global options:
  --port <n>    Override API port (default: TAKODE_API_PORT or 3456)
  --json        Output in JSON format

Examples:
  takode list
  takode list --all
  takode search "auth"
  takode search "jwt" --all
  takode tasks 1
  takode watch --sessions 1,2,3
  takode peek 1
  takode peek 1 --from 200
  takode peek 1 --detail --turns 3
  takode read 1 42
  takode send 2 "Please add tests for the edge cases"
`);
}

const command = process.argv[2];
const rawArgs = process.argv.slice(3);
const args = stripGlobalFlags(rawArgs);
const base = getBase(rawArgs);

// Role check — orchestrator sessions only
const role = process.env.TAKODE_ROLE;
if (role !== "orchestrator") {
  console.error("Error: takode commands require an orchestrator session.");
  console.error("Create a session with the orchestrator role to use these commands.");
  process.exit(1);
}

try {
  switch (command) {
    case "list":
      await handleList(base, args);
      break;
    case "search":
      await handleSearch(base, args);
      break;
    case "watch":
      await handleWatch(base, args);
      break;
    case "tasks":
      await handleTasks(base, args);
      break;
    case "peek":
      await handlePeek(base, args);
      break;
    case "read":
      await handleRead(base, args);
      break;
    case "send":
      await handleSend(base, args);
      break;
    case "help":
    case "-h":
    case "--help":
      printUsage();
      break;
    default:
      if (!command) {
        printUsage();
      } else {
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
      }
  }
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    console.error(JSON.stringify({ error: "Cannot connect to Companion server. Is it running?" }));
  } else {
    console.error(JSON.stringify({ error: message }));
  }
  process.exit(1);
}
