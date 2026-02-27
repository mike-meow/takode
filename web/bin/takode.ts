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
      default:
        console.log(`[${time}] ${evt.event}  ${session}`);
    }
    console.log(""); // blank line between events
  }
}

// ─── Command handlers ───────────────────────────────────────────────────────

async function handleWatch(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const sessionsRaw = flags.sessions as string;
  if (!sessionsRaw) err("Usage: takode watch --sessions <id1,id2,...> [--timeout <seconds>] [--json]");

  const timeout = Number(flags.timeout) || DEFAULT_TIMEOUT;
  const jsonMode = flags.json === true;
  const since = Number(flags.since) || 0;

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

async function handlePeek(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode peek <session> [--turns N] [--since TIMESTAMP] [--json]");

  const flags = parseFlags(args.slice(1));
  const turns = Number(flags.turns) || 1;
  const since = Number(flags.since) || 0;
  const jsonMode = flags.json === true;

  const params = new URLSearchParams({ turns: String(turns) });
  if (since) params.set("since", String(since));

  const data = await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/messages?${params}`);

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Human-readable format
  const d = data as {
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
      messages: Array<{
        idx: number;
        type: string;
        content: string;
        ts: number;
        tools?: Array<{ idx: number; name: string; summary: string }>;
        turnDurationMs?: number;
        success?: boolean;
      }>;
    }>;
  };

  // Header
  console.log(`Session #${d.sessionNum} "${d.sessionName}" -- ${d.status}`);
  if (d.quest) {
    console.log(`Quest: ${d.quest.id} "${d.quest.title}" [${d.quest.status}]`);
  }
  console.log("");

  // Turns
  for (const turn of d.turns) {
    const duration = turn.durationMs ? `${Math.round(turn.durationMs / 1000)}s` : "running";
    const ended = turn.endedAt ? `, ended ${formatTime(turn.endedAt)}` : "";
    console.log(`--- Turn ${turn.turnNum} (${duration}${ended}) ---`);

    for (const msg of turn.messages) {
      const time = formatTime(msg.ts);
      const idxStr = `[${msg.idx}]`.padEnd(6);

      switch (msg.type) {
        case "user":
          console.log(`  ${idxStr} ${time}  user  "${truncate(msg.content, 80)}"`);
          break;
        case "assistant":
          console.log(`  ${idxStr} ${time}  asst  ${msg.content}`);
          if (msg.tools) {
            for (const tool of msg.tools) {
              const toolIdx = `[${tool.idx}]`;
              console.log(`                        |- ${tool.name.padEnd(6)} ${tool.summary.padEnd(45)} ${toolIdx}`);
            }
          }
          break;
        case "result": {
          const icon = msg.success ? "\u2713" : "\u2717";
          console.log(`  ${idxStr} ${time}  ${icon} done  ${msg.content}`);
          break;
        }
        case "system":
          console.log(`  ${idxStr} ${time}  sys   ${msg.content}`);
          break;
      }
    }
    console.log("");
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

// ─── Main dispatch ──────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Usage: takode <command> [options]

Commands:
  watch    Wait for events from watched sessions
  peek     View recent activity of a session (truncated)
  read     Read full content of a specific message
  send     Send a message to a session

Global options:
  --port <n>    Override API port (default: TAKODE_API_PORT or 3456)
  --json        Output in JSON format

Examples:
  takode watch --sessions 1,2,3
  takode peek 1 --turns 3
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
    case "watch":
      await handleWatch(base, args);
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
