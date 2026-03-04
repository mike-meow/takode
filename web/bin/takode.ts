#!/usr/bin/env bun
/**
 * Takode CLI — cross-session orchestration commands.
 * Server-authoritative orchestration commands.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PORT = 3456;

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

// ─── Credential discovery ───────────────────────────────────────────────────

/** Discover session credentials from env vars or session-auth file fallback. */
function getCredentials(): { sessionId: string; authToken: string } | null {
  const sessionId = process.env.COMPANION_SESSION_ID;
  const authToken = process.env.COMPANION_AUTH_TOKEN;
  if (sessionId && authToken) return { sessionId, authToken };

  // Fallback: read session-auth from workspace metadata files.
  const candidates = [
    join(process.cwd(), ".companion", "session-auth.json"), // current, backend-agnostic
    join(process.cwd(), ".codex", "session-auth.json"), // legacy Codex-specific fallback
    join(process.cwd(), ".claude", "session-auth.json"), // legacy Claude-specific fallback
  ];
  for (const authFile of candidates) {
    try {
      const data = JSON.parse(readFileSync(authFile, "utf-8"));
      if (data.sessionId && data.authToken) {
        return { sessionId: data.sessionId, authToken: data.authToken };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function getCallerSessionId(): string {
  const creds = getCredentials();
  if (!creds?.sessionId) {
    err("COMPANION_SESSION_ID not set. Relaunch this session to refresh orchestration auth.");
  }
  return creds.sessionId;
}

/** Get auth headers for API requests. Returns empty object if no credentials. */
function getAuthHeaders(): Record<string, string> {
  const creds = getCredentials();
  if (!creds) return {};
  return {
    "x-companion-session": creds.sessionId,
    "x-companion-auth": creds.authToken,
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const TAKODE_SESSION_ID_HEADER = "x-companion-session-id";
const TAKODE_AUTH_TOKEN_HEADER = "x-companion-auth-token";

function getAuthContext(): { sessionId: string; authToken: string } {
  const creds = getCredentials();
  if (!creds?.sessionId) err("COMPANION_SESSION_ID not set. Relaunch this session to refresh orchestration auth.");
  if (!creds?.authToken) err("COMPANION_AUTH_TOKEN not set. Relaunch this session to refresh orchestration auth.");
  return creds;
}

function takodeAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const { sessionId, authToken } = getAuthContext();
  return {
    [TAKODE_SESSION_ID_HEADER]: sessionId,
    [TAKODE_AUTH_TOKEN_HEADER]: authToken,
    ...extra,
  };
}

async function apiGet(base: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    headers: takodeAuthHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost(base: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: takodeAuthHeaders({ "Content-Type": "application/json" }),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiDelete(base: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: takodeAuthHeaders(),
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

// ─── Command handlers ───────────────────────────────────────────────────────

async function handleList(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const showAll = flags.all === true;
  const showActive = flags.active === true;
  const jsonMode = flags.json === true;

  const sessions = await apiGet(base, "/takode/sessions") as Array<{
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
    gitAhead?: number;
    gitBehind?: number;
    totalLinesAdded?: number;
    totalLinesRemoved?: number;
    attentionReason?: string;
    repoRoot?: string;
    isWorktree?: boolean;
    herdedBy?: string;
    claimedQuestId?: string | null;
    claimedQuestStatus?: string | null;
  }>;

  // 3-mode filter:
  //   default      — herded sessions only (orchestrator's flock, excludes self)
  //   --active     — all unarchived sessions (discovery/triage view)
  //   --all        — everything including archived
  const mySessionId = getCredentials()?.sessionId;
  const mySelf = mySessionId ? sessions.find(s => s.sessionId === mySessionId) : null;
  const isOrchestrator = mySelf?.isOrchestrator === true;

  let filtered: typeof sessions;
  let filterHint = "";
  if (showAll) {
    filtered = sessions;
  } else if (showActive) {
    filtered = sessions.filter(s => !s.archived);
    filterHint = " (use --all to include archived)";
  } else if (isOrchestrator && mySessionId) {
    // Default for orchestrators: show only herded sessions (the flock)
    filtered = sessions.filter(s => !s.archived && s.herdedBy === mySessionId);
    filterHint = filtered.length === 0
      ? " (no herded sessions — run `takode list --active` to discover, then `takode herd <ids>`)"
      : " (herded only — use --active to see all)";
  } else {
    filtered = sessions.filter(s => !s.archived);
    filterHint = " (use --all to include archived)";
  }

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

  console.log(`${total} session(s)${filterHint}`);
  console.log(`Status: ● running  ○ idle  ✗ disconnected  ⊘ archived  ⚠ needs attention  📋 quest  ↑↓ commits ahead/behind`);
}

function printSessionLine(s: {
  sessionNum?: number;
  name?: string;
  state: string;
  cliConnected?: boolean;
  archived?: boolean;
  isOrchestrator?: boolean;
  isAssistant?: boolean;
  herdedBy?: string;
  model?: string;
  backendType?: string;
  cwd?: string;
  gitBranch?: string;
  gitAhead?: number;
  gitBehind?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  attentionReason?: string;
  lastActivityAt?: number;
  lastMessagePreview?: string;
  isWorktree?: boolean;
  claimedQuestId?: string | null;
  claimedQuestStatus?: string | null;
}): void {
  const num = s.sessionNum !== undefined ? `#${s.sessionNum}` : "  ";
  const name = s.name || "(unnamed)";
  const role = s.isOrchestrator ? " [leader]" : "";
  const herd = s.herdedBy ? " [herd]" : "";
  // Backend type tag: only show for codex (sdk is implied by session details)
  const backend = s.backendType === "codex" ? " [codex]"
    : "";
  const status = s.cliConnected
    ? (s.state === "running" ? "●" : "○")
    : (s.archived ? "⊘" : "✗");
  const attention = s.attentionReason ? ` ⚠ ${s.attentionReason}` : "";

  // Quest indicator: "📋 q-42 in_progress"
  const quest = s.claimedQuestId
    ? ` 📋 ${s.claimedQuestId}${s.claimedQuestStatus ? ` ${s.claimedQuestStatus}` : ""}`
    : "";

  const branch = s.gitBranch ? `  ${s.gitBranch}` : "";

  // Commits ahead/behind: "3↑5↓" (only show non-zero)
  const ahead = s.gitAhead ? `${s.gitAhead}↑` : "";
  const behind = s.gitBehind ? `${s.gitBehind}↓` : "";
  const gitDelta = (ahead || behind) ? ` ${ahead}${behind}` : "";

  // Uncommitted diff stats: "+114 -10" (only show non-zero)
  const added = s.totalLinesAdded ? `+${s.totalLinesAdded}` : "";
  const removed = s.totalLinesRemoved ? `-${s.totalLinesRemoved}` : "";
  const diffStats = (added || removed) ? ` ${[added, removed].filter(Boolean).join(" ")}` : "";

  const wt = s.isWorktree ? " wt" : "";
  // Show cwd as the last directory component (folder name) for brevity
  const cwdLabel = s.cwd ? truncate(s.cwd.replace(/\/$/, "").split("/").pop() || s.cwd, 30) : "";
  const activity = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : "";
  const preview = s.lastMessagePreview ? `  "${truncate(s.lastMessagePreview, 50)}"` : "";

  console.log(`  ${num.padEnd(5)} ${status} ${name}${role}${herd}${backend}${quest}${attention}`);
  console.log(`        ${cwdLabel}${branch}${gitDelta}${diffStats}${wt}  ${activity}${preview}`);
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
  agentSource?: { sessionId: string; sessionLabel?: string };
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
  agentSource?: { sessionId: string; sessionLabel?: string };
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

/** Derive a source label for user messages: [User], [Herd], or [Agent #N name]. */
function userSourceLabel(msg: PeekMessage): string {
  if (!msg.agentSource) return "user";
  if (msg.agentSource.sessionId === "herd-events") return "herd";
  return `agent${msg.agentSource.sessionLabel ? ` ${msg.agentSource.sessionLabel}` : ""}`;
}

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
        console.log(`  ${idx.padEnd(7)} ${time}  ${userSourceLabel(msg)}  "${truncate(msg.content, 80)}"`);
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
        console.log(`  ${idx.padEnd(7)} ${time}  ${userSourceLabel(msg)}  "${truncate(msg.content, 80)}"`);
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
  const cleanContent = content.replace(/\s*--json\s*/, "").replace(/\s*--correction\s*/, "").trim();
  const jsonMode = args.includes("--json");
  const isCorrection = args.includes("--correction");

  if (!sessionRef || !cleanContent) err("Usage: takode send <session> <message> [--correction]");

  // Guard: orchestrators can only send to herded sessions
  const callerSessionId = getCredentials()?.sessionId;
  if (callerSessionId) {
    try {
      // Resolve target to a full UUID
      const targetSession = await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}`) as {
        sessionId: string; sessionNum?: number; name?: string; isGenerating?: boolean;
      };
      const targetId = targetSession.sessionId;

      // Guard: block sends to running sessions unless --correction is used
      if (targetSession.isGenerating && !isCorrection) {
        const label = targetSession.name
          ? `#${targetSession.sessionNum ?? "?"} ${targetSession.name}`
          : `#${targetSession.sessionNum ?? sessionRef}`;
        err(
          `Session ${label} is currently working. ` +
          `Queue this task and send it after the session finishes. ` +
          `Use "takode send --correction" if this is a steering message for the current task.`,
        );
      }

      // Check herd membership
      const herdList = await apiGet(base, `/sessions/${encodeURIComponent(callerSessionId)}/herd`) as Array<{ sessionId: string }>;
      if (!herdList.some(s => s.sessionId === targetId)) {
        err(`Cannot send to session ${sessionRef} — not in your herd. Run \`takode herd ${sessionRef}\` first.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If error is from our own guards (herd check, running check), re-throw
      if (msg.includes("not in your herd") || msg.includes("currently working")) throw e;
      // Other errors (session not found, etc.) — let the send call handle it
    }
  }

  // Identify the calling session so the receiver can show an agent badge
  let agentSource: { sessionId: string; sessionLabel?: string } | undefined;
  if (callerSessionId) {
    let sessionLabel: string | undefined;
    try {
      const sessions = await apiGet(base, "/takode/sessions") as Array<{
        sessionId: string; sessionNum?: number; name?: string;
      }>;
      const own = sessions.find(s => s.sessionId === callerSessionId);
      if (own) {
        sessionLabel = own.name
          ? `#${own.sessionNum ?? "?"} ${own.name}`
          : `#${own.sessionNum ?? callerSessionId.slice(0, 8)}`;
      }
    } catch {
      // Non-critical — send without label
    }
    agentSource = { sessionId: callerSessionId, ...(sessionLabel ? { sessionLabel } : {}) };
  }

  const result = await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/message`, {
    content: cleanContent,
    ...(agentSource ? { agentSource } : {}),
  });

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[${formatTime(Date.now())}] \u2713 Message sent to session ${sessionRef}`);
}

// ─── Spawn handler ───────────────────────────────────────────────────────────

type SpawnedSession = {
  sessionId: string;
  sessionNum?: number | null;
  name?: string;
  backendType?: string;
  cwd?: string;
  isWorktree?: boolean;
  actualBranch?: string;
  branch?: string;
  permissionMode?: string;
};

async function handleSpawn(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);

  if (flags.help === true || flags.h === true) {
    console.log(`
Usage: takode spawn [options]

  Create and auto-herd new worker sessions.

Options:
  --backend <type>   AI backend: "claude", "codex", or "claude-sdk" (default: "codex")
  --cwd <path>       Working directory (default: current directory)
  --count <n>        Number of sessions to spawn (default: 1)
  --message <text>   Initial message to send to spawned sessions
  --no-worktree      Disable worktree creation
  --json             Output in JSON format

Examples:
  takode spawn --backend claude-sdk --count 2
  takode spawn --backend codex --message "Fix the flaky tests"
  takode spawn --count 3 --no-worktree
`);
    return;
  }

  const jsonMode = flags.json === true;

  const backendRaw = typeof flags.backend === "string" ? flags.backend : "codex";
  if (backendRaw !== "claude" && backendRaw !== "codex" && backendRaw !== "claude-sdk") {
    err(`Invalid backend: ${backendRaw}. Expected "claude", "codex", or "claude-sdk".`);
  }

  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const useWorktree = flags["no-worktree"] === true ? false : true;
  const message = typeof flags.message === "string" ? flags.message.trim() : "";

  const countRaw = flags.count;
  const count = countRaw === undefined ? 1 : Number(countRaw);
  if (!Number.isInteger(count) || count < 1) {
    err("Invalid --count. Expected a positive integer.");
  }

  const leaderSessionId = getCallerSessionId();

  // Inherit permission behavior from the leader: bypass -> askPermission=false.
  const leader = await apiGet(base, `/sessions/${encodeURIComponent(leaderSessionId)}`) as {
    sessionId: string;
    permissionMode?: string;
  };
  const inheritBypass = leader.permissionMode === "bypassPermissions";

  const spawned: SpawnedSession[] = [];
  for (let i = 0; i < count; i++) {
    const createPayload: Record<string, unknown> = {
      backend: backendRaw,
      cwd,
      useWorktree,
      createdBy: leaderSessionId,
    };
    if (inheritBypass) {
      createPayload.askPermission = false;
      if (backendRaw === "codex") {
        // Codex ignores askPermission — it uses permissionMode directly.
        // Inherit bypass from leader: auto mode, no sandbox, full network.
        createPayload.permissionMode = "bypassPermissions";
        createPayload.codexInternetAccess = true;
      }
    }
    // Always default Codex to high reasoning effort.
    if (backendRaw === "codex") {
      createPayload.codexReasoningEffort = "high";
    }

    const session = await apiPost(base, "/sessions/create", createPayload) as SpawnedSession;
    spawned.push(session);

    if (message) {
      await apiPost(base, `/sessions/${encodeURIComponent(session.sessionId)}/message`, {
        content: message,
        agentSource: { sessionId: leaderSessionId },
      });
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      count: spawned.length,
      backend: backendRaw,
      cwd,
      useWorktree,
      leaderSessionId,
      leaderPermissionMode: leader.permissionMode || null,
      inheritedAskPermission: inheritBypass ? false : null,
      message: message || null,
      sessions: spawned,
    }, null, 2));
    return;
  }

  for (const session of spawned) {
    const num = session.sessionNum != null ? `#${session.sessionNum}` : session.sessionId.slice(0, 8);
    const name = session.name || "(unnamed)";
    const backend = session.backendType === "codex" ? " [codex]"
      : "";
    const wt = session.isWorktree ? " wt" : "";
    const branch = session.actualBranch || session.branch || "";
    const branchLabel = branch ? `  ${branch}` : "";
    const cwdLabel = session.cwd
      ? session.cwd.replace(/\/$/, "").split("/").pop() || session.cwd
      : "";
    console.log(`[${formatTime(Date.now())}] \u2713 Spawned ${num} "${name}"${backend}${wt}`);
    console.log(`        ${cwdLabel}${branchLabel}  ${session.sessionId}`);
  }
}

// ─── Stop handler ───────────────────────────────────────────────────────────

async function handleStop(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter(a => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode stop <session>");

  const mySessionId = getCallerSessionId();

  const result = await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/stop`, {
    callerSessionId: mySessionId,
  }) as { ok: boolean; sessionId?: string; error?: string };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[${formatTime(Date.now())}] \u2713 Stopped session ${sessionRef}`);
}

// ─── Herd/Unherd handlers ───────────────────────────────────────────────────

async function handleHerd(base: string, args: string[]): Promise<void> {
  const jsonMode = args.includes("--json");
  // Parse comma/space-separated session refs (filtering out flags)
  const refs = args.filter(a => !a.startsWith("--")).join(",").split(",").map(s => s.trim()).filter(Boolean);
  if (refs.length === 0) err("Usage: takode herd <session1,session2,...>");

  const mySessionId = getCallerSessionId();

  const result = await apiPost(base, `/sessions/${encodeURIComponent(mySessionId)}/herd`, {
    workerIds: refs,
  }) as { herded: string[]; notFound: string[]; conflicts: Array<{ id: string; herder: string }>; leaders?: string[] };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.herded.length > 0) {
    console.log(`[${formatTime(Date.now())}] \u2713 Herded ${result.herded.length} session(s)`);
  }
  if (result.notFound.length > 0) {
    console.log(`[${formatTime(Date.now())}] \u2717 Not found: ${result.notFound.join(", ")}`);
  }
  if (result.conflicts?.length > 0) {
    for (const c of result.conflicts) {
      console.log(`[${formatTime(Date.now())}] \u2717 Conflict: ${c.id} already herded by ${c.herder}`);
    }
  }
  if (result.leaders?.length) {
    for (const lid of result.leaders) {
      console.log(`[${formatTime(Date.now())}] \u2717 Cannot herd leader session: ${lid}`);
    }
  }
}

async function handleUnherd(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter(a => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode unherd <session>");

  const mySessionId = getCallerSessionId();

  const result = await apiDelete(base, `/sessions/${encodeURIComponent(mySessionId)}/herd/${encodeURIComponent(sessionRef)}`) as { ok: boolean; removed: boolean };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.removed) {
    console.log(`[${formatTime(Date.now())}] \u2713 Unherded session ${sessionRef}`);
  } else {
    console.log(`[${formatTime(Date.now())}] Session ${sessionRef} was not herded by you`);
  }
}

// ─── Pending/Answer handlers ────────────────────────────────────────────────

async function handlePending(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter(a => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode pending <session>");

  const result = await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/pending`) as {
    pending: Array<{
      request_id: string;
      tool_name: string;
      timestamp: number;
      questions?: Array<{ header?: string; question: string; options?: Array<{ label: string; description?: string }> }>;
      plan?: string;
      allowedPrompts?: Array<{ tool: string; prompt: string }>;
    }>;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.pending.length === 0) {
    console.log("No pending questions or plans to answer.");
    return;
  }

  for (const p of result.pending) {
    if (p.tool_name === "AskUserQuestion" && p.questions) {
      for (const q of p.questions) {
        console.log(`\n[AskUserQuestion] ${q.question}`);
        if (q.options) {
          for (let i = 0; i < q.options.length; i++) {
            const opt = q.options[i];
            console.log(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`);
          }
        }
        console.log(`\nAnswer: takode answer ${sessionRef} <option-number-or-text>`);
      }
    } else if (p.tool_name === "ExitPlanMode") {
      const planPreview = typeof p.plan === "string" ? p.plan.slice(0, 500) : "(no plan text)";
      console.log(`\n[ExitPlanMode] Plan approval requested`);
      console.log(planPreview);
      if (typeof p.plan === "string" && p.plan.length > 500) console.log("  ...(truncated)");
      console.log(`\nApprove: takode answer ${sessionRef} approve`);
      console.log(`Reject:  takode answer ${sessionRef} reject 'feedback here'`);
    }
  }
}

async function handleAnswer(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter(a => !a.startsWith("--"))[0];
  const response = args.filter(a => !a.startsWith("--")).slice(1).join(" ");
  const jsonMode = args.includes("--json");

  if (!sessionRef || !response) err("Usage: takode answer <session> <response>");

  const mySessionId = getCallerSessionId();

  const result = await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/answer`, {
    response,
    callerSessionId: mySessionId,
  }) as { ok: boolean; tool_name: string; answer?: string; action?: string; feedback?: string; error?: string };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.tool_name === "AskUserQuestion") {
    console.log(`[${formatTime(Date.now())}] \u2713 Answered: "${result.answer}"`);
  } else if (result.tool_name === "ExitPlanMode") {
    if (result.action === "approved") {
      console.log(`[${formatTime(Date.now())}] \u2713 Plan approved`);
    } else {
      console.log(`[${formatTime(Date.now())}] \u2717 Plan rejected: ${result.feedback}`);
    }
  }
}

// ─── Search handler ──────────────────────────────────────────────────────────

async function handleSearch(base: string, args: string[]): Promise<void> {
  const query = args.filter(a => !a.startsWith("--")).join(" ").trim();
  if (!query) err("Usage: takode search <query> [--all] [--json]");

  const flags = parseFlags(args);
  const showAll = flags.all === true;
  const jsonMode = flags.json === true;

  const sessions = await apiGet(base, "/takode/sessions") as Array<{
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

  const params = new URLSearchParams({ q: query });
  if (!showAll) {
    params.set("includeArchived", "false");
  }
  const searchResp = await apiGet(base, `/sessions/search?${params.toString()}`) as {
    query: string;
    tookMs: number;
    totalMatches: number;
    results: Array<{
      sessionId: string;
      score: number;
      matchedField: "name" | "task" | "keyword" | "branch" | "path" | "repo" | "user_message";
      matchContext: string | null;
      matchedAt: number;
      messageMatch?: {
        id?: string;
        timestamp: number;
        snippet: string;
      };
    }>;
  };

  const sessionsById = new Map(sessions.map((s) => [s.sessionId, s]));
  const fieldLabel = (field: "name" | "task" | "keyword" | "branch" | "path" | "repo" | "user_message"): string => {
    if (field === "user_message") return "message";
    return field;
  };
  const snippetFromContext = (context: string | null): string => {
    if (!context) return "";
    const m = context.match(/^[a-z_]+:\s*(.*)$/i);
    return (m?.[1] ?? context).trim();
  };

  type SearchResultRow = {
    session: (typeof sessions)[number] | undefined;
    match: (typeof searchResp.results)[number];
    matchReason: string;
    snippet: string;
    messageId: string | null;
    matchedFieldLabel: string;
  };

  const mappedResults: SearchResultRow[] = searchResp.results.map((match) => {
    const session = sessionsById.get(match.sessionId);
    const fallbackName = session?.name || "(unnamed)";
    const snippet = match.messageMatch?.snippet?.trim()
      || snippetFromContext(match.matchContext)
      || (match.matchedField === "name" ? fallbackName : "");
    const matchReason = match.matchContext || `${fieldLabel(match.matchedField)} match`;
    const messageId = match.matchedField === "user_message" ? (match.messageMatch?.id || null) : null;
    return {
      session,
      match,
      matchReason,
      snippet,
      messageId,
      matchedFieldLabel: fieldLabel(match.matchedField),
    };
  });

  const results = mappedResults.filter((row): row is SearchResultRow & { session: (typeof sessions)[number] } => {
    if (!row.session) return false; // Drop stale search rows that no longer map to a visible session.
    if (showAll) return true;
    return !row.session.archived && row.session.state !== "exited";
  });

  if (jsonMode) {
    console.log(JSON.stringify(results.map((r) => ({
      ...r.session,
      matchedField: r.match.matchedField,
      matchReason: r.matchReason,
      matchContext: r.match.matchContext,
      snippet: r.snippet,
      messageId: r.messageId,
      matchedAt: r.match.matchedAt,
    })), null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`No sessions matching "${query}".`);
    return;
  }

  console.log(`${results.length} session(s) matching "${query}":`);
  console.log("");

  for (const row of results) {
    const s = row.session;
    const num = s.sessionNum !== undefined ? `#${s.sessionNum}` : "  ";
    const name = s.name || "(unnamed)";
    const status = s.cliConnected
      ? (s.state === "running" ? "●" : "○")
      : (s.archived ? "⊘" : "✗");
    const activity = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : "";
    const sessionRef = s.sessionNum != null ? String(s.sessionNum) : s.sessionId;

    console.log(`  ${num.padEnd(5)} ${status} ${name}`);
    console.log(`        field: ${row.matchedFieldLabel}  reason: ${row.matchReason}`);
    if (row.snippet) {
      console.log(`        snippet: ${truncate(row.snippet, 120)}`);
    }
    if (row.messageId) {
      console.log(`        message id: ${row.messageId} (takode peek ${sessionRef} --from ${row.messageId})`);
    }
    if (activity) {
      console.log(`        activity: ${activity}`);
    }
    console.log("");
  }
}

// ─── Main dispatch ──────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Usage: takode <command> [options]

Commands:
  list     List sessions (herded only for leaders, --active for all, --all includes archived)
  search   Search sessions via server-side ranking (name/task/path/message, etc.)
  spawn    Create and auto-herd new worker sessions
  tasks    Show task outline of a session (table of contents)
  peek     View session activity (smart overview by default)
  read     Read full content of a specific message
  send     Send a message to a session
  herd     Herd sessions (e.g. takode herd 5,6,7)
  unherd   Release a session from your herd (e.g. takode unherd 5)
  stop     Gracefully stop a herded session (e.g. takode stop 5)
  pending  Show pending questions/plans from a herded session
  answer   Answer a pending question or approve/reject a plan

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
  takode spawn --backend claude-sdk --count 2
  takode spawn --backend codex --count 3 --message "Check flaky tests"
  takode tasks 1
  takode peek 1
  takode peek 1 --from 200
  takode peek 1 --detail --turns 3
  takode read 1 42
  takode send 2 "Please add tests for the edge cases"
`);
}

async function ensureOrchestratorAccess(base: string): Promise<void> {
  const me = await apiGet(base, "/takode/me") as { isOrchestrator?: boolean };
  if (me.isOrchestrator !== true) {
    err("takode commands require an orchestrator session.");
  }
}

const command = process.argv[2];
const rawArgs = process.argv.slice(3);
const args = stripGlobalFlags(rawArgs);
const base = getBase(rawArgs);

try {
  const requiresAuth = new Set([
    "list",
    "search",
    "spawn",
    "tasks",
    "peek",
    "read",
    "send",
    "herd",
    "unherd",
    "stop",
    "pending",
    "answer",
  ]);
  // Skip auth when asking for help — user should be able to read usage without
  // being in an orchestrator session.
  const wantsHelp = args.includes("--help") || args.includes("-h");
  if (command && requiresAuth.has(command) && !wantsHelp) {
    await ensureOrchestratorAccess(base);
  }

  switch (command) {
    case "list":
      await handleList(base, args);
      break;
    case "search":
      await handleSearch(base, args);
      break;
    case "spawn":
      await handleSpawn(base, args);
      break;
    case "stop":
      await handleStop(base, args);
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
    case "herd":
      await handleHerd(base, args);
      break;
    case "unherd":
      await handleUnherd(base, args);
      break;
    case "pending":
      await handlePending(base, args);
      break;
    case "answer":
      await handleAnswer(base, args);
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
  process.exit(0);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    console.error(JSON.stringify({ error: "Cannot connect to Companion server. Is it running?" }));
  } else {
    console.error(JSON.stringify({ error: message }));
  }
  process.exit(1);
}
