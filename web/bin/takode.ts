#!/usr/bin/env bun
/**
 * Takode CLI — cross-session orchestration commands.
 * Server-authoritative orchestration commands.
 */

import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HerdSessionsResponse } from "../shared/herd-types.ts";
import {
  encodeLogQuery,
  parseLogLevels,
  parseLogTime,
  type LogQueryResponse,
  type ServerLogEntry,
} from "../shared/logging.ts";
import { HERD_WORKER_SLOT_LIMIT, TAKODE_PEEK_CONTENT_LIMIT, formatQuotedContent } from "../shared/takode-constants.ts";
import {
  getSessionAuthDir,
  getSessionAuthFilePrefixes,
  parseSessionAuthFileData,
  type SessionAuthFileData,
} from "../shared/session-auth.ts";
import {
  renderLeaderContextResumeText,
  type LeaderContextResumeModel,
} from "../server/takode-leader-context-resume.js";

const DEFAULT_PORT = 3456;
const DEFAULT_CODEX_MODEL = "gpt-5.4";

function getCliDefaultModelForBackend(backend: "claude" | "claude-sdk" | "codex"): string {
  switch (backend) {
    case "claude":
    case "claude-sdk":
      return "";
    case "codex":
      return DEFAULT_CODEX_MODEL;
  }
}

function getRequestedPort(argv: string[]): number | undefined {
  const idx = argv.indexOf("--port");
  if (idx === -1 || !argv[idx + 1]) return undefined;
  const parsed = Number(argv[idx + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readSessionAuthFile(path: string): SessionAuthFileData | null {
  try {
    return parseSessionAuthFileData(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

function dedupeSessionAuthCandidates(candidates: SessionAuthFileData[]): SessionAuthFileData[] {
  const seen = new Set<string>();
  const deduped: SessionAuthFileData[] = [];
  for (const candidate of candidates) {
    const key = [candidate.serverId || "", candidate.sessionId, candidate.authToken, candidate.port ?? ""].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function getScopedSessionAuthFileData(argv: string[]): SessionAuthFileData | null {
  const authDir = getSessionAuthDir();
  const prefixes = getSessionAuthFilePrefixes(process.cwd()).map((prefix) => `${prefix}-`);

  let fileNames: string[];
  try {
    fileNames = readdirSync(authDir);
  } catch {
    return null;
  }

  const candidates = fileNames
    .filter((name) => name.endsWith(".json") && prefixes.some((prefix) => name.startsWith(prefix)))
    .map((name) => readSessionAuthFile(`${authDir}/${name}`))
    .filter((value): value is SessionAuthFileData => value !== null);
  const uniqueCandidates = dedupeSessionAuthCandidates(candidates);

  if (uniqueCandidates.length === 0) return null;

  const envServerId = process.env.COMPANION_SERVER_ID?.trim();
  if (envServerId) {
    const serverMatches = uniqueCandidates.filter((candidate) => candidate.serverId === envServerId);
    if (serverMatches.length === 1) return serverMatches[0];
    if (serverMatches.length > 1) {
      err(
        `Multiple Companion auth contexts matched server ${envServerId} for ${process.cwd()}. Refusing to guess which server to use.`,
      );
    }
  }

  const envSessionId = process.env.COMPANION_SESSION_ID?.trim();
  if (envSessionId) {
    const sessionMatches = uniqueCandidates.filter((candidate) => candidate.sessionId === envSessionId);
    if (sessionMatches.length === 1) return sessionMatches[0];
    if (sessionMatches.length > 1) {
      err(
        `Multiple Companion auth contexts matched session ${envSessionId} for ${process.cwd()}. Refusing to guess which server to use.`,
      );
    }
  }

  const envPreferredPort = [process.env.TAKODE_API_PORT, process.env.COMPANION_PORT]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0);
  if (envPreferredPort) {
    const portMatches = uniqueCandidates.filter((candidate) => candidate.port === envPreferredPort);
    if (portMatches.length === 1) return portMatches[0];
    if (portMatches.length > 1) {
      err(
        `Multiple Companion auth contexts matched port ${envPreferredPort} for ${process.cwd()}. Refusing to guess which server to use.`,
      );
    }
  }

  const explicitPort = getRequestedPort(argv);
  if (explicitPort && uniqueCandidates.length > 1) {
    const portMatches = uniqueCandidates.filter((candidate) => candidate.port === explicitPort);
    if (portMatches.length === 0) {
      err(
        `No Companion auth context matched port ${explicitPort} for ${process.cwd()}. Refusing to guess which server to use.`,
      );
    }
    if (portMatches.length === 1) return portMatches[0];
    err(
      `Multiple Companion auth contexts matched port ${explicitPort} for ${process.cwd()}. Refusing to guess which server to use.`,
    );
  }

  if (uniqueCandidates.length === 1) return uniqueCandidates[0];

  err(
    `Multiple Companion auth contexts were found for ${process.cwd()}. Refusing to guess which server to use. Relaunch this session to restore COMPANION_* env vars, or rerun with --port <server-port>.`,
  );
}

function getSessionAuthFileData(argv: string[] = process.argv.slice(2)): SessionAuthFileData | null {
  const scoped = getScopedSessionAuthFileData(argv);
  if (scoped) return scoped;

  const authDir = getSessionAuthDir();
  for (const prefix of getSessionAuthFilePrefixes(process.cwd())) {
    const legacyCentral = readSessionAuthFile(`${authDir}/${prefix}.json`);
    if (legacyCentral) return legacyCentral;
  }

  // Legacy fallback: auth files in the user's repo (for backwards compatibility)
  const legacyCandidates = [
    `${process.cwd()}/.companion/session-auth.json`,
    `${process.cwd()}/.codex/session-auth.json`,
    `${process.cwd()}/.claude/session-auth.json`,
  ];
  for (const authFile of legacyCandidates) {
    const data = readSessionAuthFile(authFile);
    if (data) return data;
  }
  return null;
}

// ─── Port discovery (same pattern as ctl.ts) ────────────────────────────────

function getPort(argv: string[]): number {
  const requestedPort = getRequestedPort(argv);
  if (requestedPort) return requestedPort;
  // Orchestrator sessions get TAKODE_API_PORT
  if (process.env.TAKODE_API_PORT) {
    const p = Number(process.env.TAKODE_API_PORT);
    if (!Number.isNaN(p) && p > 0) return p;
  }
  if (process.env.COMPANION_PORT) {
    const p = Number(process.env.COMPANION_PORT);
    if (!Number.isNaN(p) && p > 0) return p;
  }
  const authFile = getSessionAuthFileData(argv);
  if (authFile?.port) return authFile.port;
  return DEFAULT_PORT;
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
  const data = getSessionAuthFileData();
  if (data) {
    return { sessionId: data.sessionId, authToken: data.authToken };
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

async function apiPatch(base: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: takodeAuthHeaders({ "Content-Type": "application/json" }),
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

let stdinTextPromise: Promise<string> | null = null;

async function readStdinText(): Promise<string> {
  if (!stdinTextPromise) {
    process.stdin.setEncoding("utf8");
    stdinTextPromise = (async () => {
      let data = "";
      for await (const chunk of process.stdin) {
        data += chunk;
      }
      return data;
    })();
  }
  return stdinTextPromise;
}

async function readOptionTextFile(pathOrDash: string, flagName: string): Promise<string> {
  if (pathOrDash === "-") {
    return readStdinText();
  }

  try {
    return await readFile(resolve(pathOrDash), "utf-8");
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    err(`Cannot read ${flagName} input from ${pathOrDash}${detail}`);
  }
}

async function readOptionalRichTextOption(
  flags: Record<string, string | boolean>,
  args: {
    inlineFlag: string;
    fileFlag: string;
    label: string;
  },
): Promise<string | undefined> {
  const inlineValue = flags[args.inlineFlag];
  const fileValue = flags[args.fileFlag];

  if (inlineValue === true) {
    err(`--${args.inlineFlag} requires a value`);
  }
  if (fileValue === true) {
    err(`--${args.fileFlag} requires a path or '-' for stdin`);
  }
  if (inlineValue !== undefined && fileValue !== undefined) {
    err(`Use either --${args.inlineFlag} or --${args.fileFlag}, not both`);
  }

  const value =
    typeof fileValue === "string"
      ? await readOptionTextFile(fileValue, `--${args.fileFlag}`)
      : typeof inlineValue === "string"
        ? inlineValue
        : undefined;

  if (value !== undefined && !value.trim()) {
    err(`${args.label} is required`);
  }

  return value;
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
      if (next !== undefined && !next.startsWith("--")) {
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

function hasHelpFlag(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function stripHelpFlags(argv: string[]): string[] {
  return argv.filter((arg) => arg !== "--help" && arg !== "-h");
}

function assertKnownFlags(flags: Record<string, string | boolean>, allowed: ReadonlySet<string>, usage: string): void {
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  err(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}\n${usage}`);
}

function resolveBooleanToggleFlag(
  flags: Record<string, string | boolean>,
  positiveKey: string,
  negativeKey: string,
): boolean | undefined {
  const positive = flags[positiveKey];
  const negative = flags[negativeKey];
  if (positive !== undefined && negative !== undefined) {
    err(`Cannot combine --${positiveKey} and --${negativeKey}.`);
  }
  if (positive !== undefined) {
    if (positive !== true) err(`--${positiveKey} does not take a value.`);
    return true;
  }
  if (negative !== undefined) {
    if (negative !== true) err(`--${negativeKey} does not take a value.`);
    return false;
  }
  return undefined;
}

function resolveStringFlag(flags: Record<string, string | boolean>, key: string, label: string): string | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") err(`--${key} requires a value for ${label}.`);
  const trimmed = value.trim();
  if (!trimmed) err(`--${key} requires a non-empty value for ${label}.`);
  return trimmed;
}

function parseIntegerFlag(flags: Record<string, string | boolean>, key: string, label: string): number | undefined {
  const value = resolveStringFlag(flags, key, label);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) err(`--${key} must be an integer.`);
  return parsed;
}

function parsePositiveIntegerFlag(
  flags: Record<string, string | boolean>,
  key: string,
  label: string,
  fallback: number,
): number {
  const value = resolveStringFlag(flags, key, label);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) err(`--${key} must be a positive integer.`);
  return parsed;
}

type TakodeSessionInfo = {
  sessionId: string;
  sessionNum?: number | null;
  name?: string | null;
  state: string;
  backendType?: string;
  model?: string;
  cwd: string;
  createdAt: number;
  lastActivityAt?: number;
  cliSessionId?: string;
  pid?: number;
  exitCode?: number | null;
  archived?: boolean;
  archivedAt?: number;
  cliConnected: boolean;
  isGenerating: boolean;
  isOrchestrator?: boolean;
  isAssistant?: boolean;
  herdedBy?: string;
  isWorktree?: boolean;
  repoRoot?: string;
  branch?: string;
  actualBranch?: string;
  envSlug?: string;
  cronJobId?: string;
  cronJobName?: string;
  containerId?: string;
  containerName?: string;
  containerImage?: string;
  gitBranch?: string | null;
  gitHeadSha?: string | null;
  gitDefaultBranch?: string | null;
  diffBaseBranch?: string | null;
  gitAhead?: number;
  gitBehind?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  totalCostUsd?: number;
  numTurns?: number;
  contextUsedPercent?: number;
  isCompacting?: boolean;
  permissionMode?: string | null;
  askPermission?: boolean;
  tools?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
  claudeCodeVersion?: string | null;
  claimedQuestId?: string | null;
  claimedQuestTitle?: string | null;
  claimedQuestStatus?: string | null;
  pendingTimerCount?: number;
  uiMode?: string | null;
  attentionReason?: string | null;
  lastReadAt?: number;
  taskHistory?: Array<{ title: string; startedAt: number }>;
  keywords?: string[];
  codexInternetAccess?: boolean;
  codexSandbox?: string;
  codexReasoningEffort?: string;
};

async function fetchSessionInfo(base: string, sessionRef: string): Promise<TakodeSessionInfo> {
  return apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/info`) as Promise<TakodeSessionInfo>;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function formatTime(epoch: number): string {
  const d = new Date(epoch);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

/** @deprecated Use formatTime — both now produce HH:MM. Kept as alias during migration. */
const formatTimeShort = formatTime;

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

function formatTimestampCompact(epoch: number): string {
  return dateKey(epoch) === dateKey(Date.now()) ? formatTime(epoch) : `${formatDate(epoch)} ${formatTime(epoch)}`;
}

type SessionTimerDetail = {
  id: string;
  type: string;
  title: string;
  description: string;
  originalSpec: string;
  nextFireAt: number;
  fireCount: number;
  intervalMs?: number;
  createdAt?: number;
  lastFiredAt?: number;
};

const TIMER_CREATE_GUIDANCE =
  "Guidance: keep the timer title short and scannable. Use the description only for extra detail. " +
  "For recurring timers, keep the description general so it does not go stale across repeated firings.";

const LIST_HELP = `Usage: takode list [--herd|--active|--all] [--tasks] [--json]

List sessions.

Options:
  --herd    Show only sessions herded by you
  --active  Show all unarchived sessions
  --all     Include archived sessions
  --tasks   Include recent task history in each row
  --json    Output JSON
`;

const SEARCH_HELP = `Usage: takode search <query> [--all] [--json]

Search sessions by name, task, branch, path, repo, keyword, and user-message content.

Options:
  --all   Include archived sessions
  --json  Output JSON
`;

const INFO_HELP = `Usage: takode info <session> [--json]

Show detailed metadata for a session, including backend, git, quest, and timer state.
`;

const LEADER_CONTEXT_RESUME_HELP = `Usage: takode leader-context-resume <session> [--json]

Recover the minimum leader/orchestrator context needed to resume safely after compaction or interruption.
`;

const TASKS_HELP = `Usage: takode tasks <session> [--json]

Show the high-level task outline for a session's conversation history.
`;

const TIMERS_HELP = `Usage: takode timers <session> [--json]

Show pending timers for a session.
`;

const SCAN_HELP = `Usage: takode scan <session> [--from N] [--until N] [--count N] [--json]

Scan session turns as collapsed summaries.

Options:
  --from <turn>   Start at turn N
  --until <turn>  Show turns ending before turn N
  --count <n>     Number of turns to show (default: 50)
  --json          Output JSON
`;

const PEEK_HELP = `Usage: takode peek <session> [--from N] [--until N] [--count N] [--task N] [--turn N] [--show-tools] [--detail] [--turns N] [--json]

View session activity with progressive detail.

Examples:
  takode peek 1
  takode peek 1 --turn 5
  takode peek 1 --from 500 --count 50
  takode peek 1 --detail --turns 3
`;

const READ_HELP = `Usage: takode read <session> <msg-id> [--offset N] [--limit N] [--json]

Read one full message from a session.
`;

const GREP_HELP = `Usage: takode grep <session> <pattern> [--type user|assistant|result] [--count N] [--json]

Search within a session's messages using JavaScript regex matching.
`;

const LOGS_HELP = `Usage: takode logs [--level warn,error] [--component name] [--session <id>] [--pattern text] [--regex] [--since time] [--until time] [--limit N] [--follow] [--json]

Query and tail structured Companion server logs.
`;

const EXPORT_HELP = `Usage: takode export <session> <path>

Export a session's full history to a text file.
`;

const SEND_HELP = `Usage: takode send <session> <message> [--correction] [--json]
       takode send <session> --stdin [--correction] [--json]

Send a message to a herded session.

Options:
  --stdin       Read the message body from stdin
  --correction  Send steering input to a currently running session
  --json        Output JSON
`;

const USER_MESSAGE_HELP = `Usage: takode user-message --text-file <path|-> [--json]

Publish Markdown from a leader session into its user-visible left-panel chat. This command is for leader/orchestrator sessions only; normal worker and reviewer sessions should not use it.

Options:
  --text-file <path|->  Read the complete Markdown message from a file, or '-' for stdin
  --json                Output JSON
`;

const RENAME_HELP = `Usage: takode rename <session> <name> [--json]

Rename a session.
`;

const HERD_HELP = `Usage: takode herd [--force] <session1,session2,...> [--json]

Herd one or more worker sessions into your leader session.
`;

const UNHERD_HELP = `Usage: takode unherd <session> [--json]

Release a worker from your herd.
`;

const INTERRUPT_HELP = `Usage: takode interrupt <session> [--json]

Interrupt a worker's current turn without archiving it.
`;

const ARCHIVE_HELP = `Usage: takode archive <session> [--json]

Archive a herded session.
`;

const PENDING_HELP = `Usage: takode pending <session> [--json]

Show leader-answerable questions for a herded session, including
\`takode notify needs-input\` prompts and plan approvals.
`;

const ANSWER_HELP = `Usage: takode answer <session> [--message <msg-id> | --target <id>] <response> [--json]

Answer a pending question, \`needs-input\` prompt, or approve/reject a pending plan.
`;

const SET_BASE_HELP = `Usage: takode set-base <session> <branch> [--json]

Set the diff base branch for a session.
`;

const REFRESH_BRANCH_HELP = `Usage: takode refresh-branch <session> [--json]

Refresh git branch info for a session after checkout, rebase, or other branch changes.
`;

const NOTIFY_HELP = `Usage: takode notify <category> <summary> [--suggest <answer>]... [--json]
       takode notify list [--json]
       takode notify resolve <notification-id> [--json]

Categories:
  needs-input  User decision or information required
  review       Ready for user review

Options:
  --suggest <answer>  Suggested answer for needs-input notifications (repeat up to 3 times)
`;

const PHASES_HELP = `Usage: takode phases [--json]

List available Quest Journey phases from phase metadata, including exact leader/assignee brief paths.
`;

interface QuestJourneyPhaseCatalogEntry {
  id: string;
  label: string;
  boardState: string;
  assigneeRole: string;
  contract: string;
  nextLeaderAction: string;
  aliases: string[];
  sourceType: string;
  sourcePath: string;
  phaseJsonPath: string;
  leaderBriefPath: string;
  assigneeBriefPath: string;
  phaseJsonDisplayPath: string;
  leaderBriefDisplayPath: string;
  assigneeBriefDisplayPath: string;
}

const BOARD_HELP = `Usage: takode board [show|set|propose|present|promote|note|advance|rm] ...

Quest Journey work board for the current leader session.

Subcommands:
  show                    Show the board (default)
  set <quest-id>          Add or update a board row
  propose <quest-id>      Draft or revise a proposed Journey row
  present <quest-id>      Present a proposed Journey draft for approval
  promote <quest-id>      Promote a proposed Journey row into execution
  note <quest-id>         Add or clear a per-phase Journey note
  advance <quest-id>      Move a quest to the next Journey state
  rm <quest-id> [...]     Remove quests from the active board

Examples:
  takode board show
  takode board set q-12 --status PLANNING
  takode board set q-12 --phases planning,implement,code-review,port --preset full-code
  takode board set q-12 --phases planning,explore,outcome-review --preset investigation
  takode board set q-12 --phases implement,outcome-review,code-review,port --preset cli-rollout --revise-reason "Need outcome evidence before final code review"
  takode board set q-12 --status MENTAL_SIMULATING --active-phase-position 5
  takode board propose q-12 --phases alignment,implement,code-review,port --preset full-code --wait-for-input 3
  takode board present q-12 --wait-for-input 3
  takode board promote q-12 --worker 5
  takode board note q-12 3 --text "Inspect only the follow-up diff"
  takode board set q-12 --status QUEUED --wait-for ${FREE_WORKER_WAIT_FOR_TOKEN}
  takode board set q-12 --status IMPLEMENTING --wait-for-input 3,4
  takode board set q-12 --clear-wait-for-input
  takode board set q-12 --worker 5 --wait-for q-7,#9
  takode board advance q-12
  takode board rm q-12
`;

const BOARD_SET_HELP = `Usage: takode board set <quest-id> [--worker <session>] [--status <state>] [--active-phase-position <n>] [--title <title>] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--phases <ids>] [--preset <id>] [--revise-reason <text>] [--json]
       takode board add <quest-id> [--worker <session>] [--status <state>] [--active-phase-position <n>] [--title <title>] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--phases <ids>] [--preset <id>] [--revise-reason <text>] [--json]

Add or update a board row for a quest.

Quest Journey phases:
  --phases planning,explore,implement,code-review,mental-simulation,execute,outcome-review,bookkeeping,port
  --preset <id> labels the planned phase sequence; use with --phases
  --revise-reason <text> records why an active Journey's remaining phases changed
  --active-phase-position <n> pins the active occurrence for repeated phases using a 1-based phase position
  --wait-for-input links active rows to same-session needs-input notifications by ID (for example 3 or n-3)
  --clear-wait-for-input removes any existing linked needs-input wait state

Zero-tracked-change work uses the same board model: choose explicit phases that omit \`port\` instead of using a special no-code board flag.
`;

const BOARD_PROPOSE_HELP = `Usage: takode board propose <quest-id> [--title <title>] (--phases <ids> | --spec-file <path|->) [--preset <id>] [--revise-reason <text>] [--wait-for-input <id,id...> | --clear-wait-for-input] [--json]

Draft or revise a proposed pre-dispatch Journey row. Proposed rows stay board-owned and can wait on user approval without pretending they are generic queue rows. Use --spec-file for batch phase and note updates.
`;

const BOARD_PRESENT_HELP = `Usage: takode board present <quest-id> [--summary <text>] [--wait-for-input <id,id...> | --clear-wait-for-input] [--json]

Present the current proposed Journey draft as the deliberate user-facing approval artifact.
`;

const BOARD_PROMOTE_HELP = `Usage: takode board promote <quest-id> [--worker <session>] [--status <state>] [--active-phase-position <n>] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--force-promote-unpresented] [--json]

Promote an existing presented proposed Journey into active execution without redefining its phases. By default this clears any proposal hold linked through --wait-for-input. Use --force-promote-unpresented only for rare recovery/admin scenarios.
`;

const BOARD_NOTE_HELP = `Usage: takode board note <quest-id> <phase-position> [--text <text> | --clear] [--json]

Add or clear a lightweight per-phase Journey note. Phase positions are 1-based in CLI usage.
`;

const BOARD_ADVANCE_HELP = `Usage: takode board advance <quest-id> [--json]

Advance a quest to the next Quest Journey state. Advancing from the final planned phase removes the row, even when that Journey never included \`port\`.
`;

const BOARD_RM_HELP = `Usage: takode board rm <quest-id> [<quest-id> ...] [--json]

Remove one or more quests from the active board.
`;

const BRANCH_HELP = `Usage: takode branch <status|set-base> ...

Branch info and management for the current session.

Subcommands:
  status                  Show current branch, diff base, and ahead/behind state
  set-base <branch>       Set the current session's diff base branch
`;

const BRANCH_STATUS_HELP = `Usage: takode branch status [--json]

Show current branch, diff base, and ahead/behind status for the current session.
`;

const BRANCH_SET_BASE_HELP = `Usage: takode branch set-base <branch> [--json]

Set the current session's diff base branch.
`;

const TIMER_HELP = `Usage: takode timer <create|list|cancel> ...

Session-scoped timers for the current session.

Subcommands:
  create <title> [--desc <description>] --in|--at|--every <spec>
  list
  cancel <timer-id>

${TIMER_CREATE_GUIDANCE}
`;

const TIMER_CREATE_HELP = `Usage: takode timer create <title> [--desc <description>] --in|--at|--every <spec>

Create a session-scoped timer.

Examples:
  takode timer create "Check build health" --desc "Inspect the latest failing shard if red." --in 30m
  takode timer create "Deploy reminder" --at 3pm
  takode timer create "Refresh context" --desc "Summarize new blockers since the last run." --every 10m
`;

const TIMER_LIST_HELP = `Usage: takode timer list

List active timers for the current session.
`;

const TIMER_CANCEL_HELP = `Usage: takode timer cancel <timer-id>

Cancel a session-scoped timer.
`;

function printCommandHelp(command: string, argv: string[]): boolean {
  const args = stripHelpFlags(argv);
  switch (command) {
    case "list":
      console.log(LIST_HELP);
      return true;
    case "search":
      console.log(SEARCH_HELP);
      return true;
    case "info":
      console.log(INFO_HELP);
      return true;
    case "leader-context-resume":
      console.log(LEADER_CONTEXT_RESUME_HELP);
      return true;
    case "spawn":
      console.log(SPAWN_FLAG_USAGE);
      return true;
    case "tasks":
      console.log(TASKS_HELP);
      return true;
    case "timers":
      console.log(TIMERS_HELP);
      return true;
    case "scan":
      console.log(SCAN_HELP);
      return true;
    case "peek":
      console.log(PEEK_HELP);
      return true;
    case "read":
      console.log(READ_HELP);
      return true;
    case "grep":
      console.log(GREP_HELP);
      return true;
    case "logs":
      console.log(LOGS_HELP);
      return true;
    case "export":
      console.log(EXPORT_HELP);
      return true;
    case "send":
      console.log(SEND_HELP);
      return true;
    case "user-message":
      console.log(USER_MESSAGE_HELP);
      return true;
    case "rename":
      console.log(RENAME_HELP);
      return true;
    case "herd":
      console.log(HERD_HELP);
      return true;
    case "unherd":
      console.log(UNHERD_HELP);
      return true;
    case "interrupt":
      console.log(INTERRUPT_HELP);
      return true;
    case "archive":
      console.log(ARCHIVE_HELP);
      return true;
    case "pending":
      console.log(PENDING_HELP);
      return true;
    case "answer":
      console.log(ANSWER_HELP);
      return true;
    case "set-base":
      console.log(SET_BASE_HELP);
      return true;
    case "refresh-branch":
      console.log(REFRESH_BRANCH_HELP);
      return true;
    case "notify":
      console.log(NOTIFY_HELP);
      return true;
    case "phases":
      console.log(PHASES_HELP);
      return true;
    case "board": {
      const sub = args[0];
      if (!sub || sub === "show") {
        console.log(BOARD_HELP);
      } else if (sub === "set" || sub === "add") {
        console.log(BOARD_SET_HELP);
      } else if (sub === "propose") {
        console.log(BOARD_PROPOSE_HELP);
      } else if (sub === "present") {
        console.log(BOARD_PRESENT_HELP);
      } else if (sub === "promote") {
        console.log(BOARD_PROMOTE_HELP);
      } else if (sub === "note") {
        console.log(BOARD_NOTE_HELP);
      } else if (sub === "advance") {
        console.log(BOARD_ADVANCE_HELP);
      } else if (sub === "advance-no-groom") {
        console.log(
          "`takode board advance-no-groom` was removed. Use an explicit phase plan that omits `port`, then advance with `takode board advance`.",
        );
      } else if (sub === "rm") {
        console.log(BOARD_RM_HELP);
      } else {
        console.log(BOARD_HELP);
      }
      return true;
    }
    case "branch": {
      const sub = args[0];
      if (!sub) {
        console.log(BRANCH_HELP);
      } else if (sub === "status") {
        console.log(BRANCH_STATUS_HELP);
      } else if (sub === "set-base") {
        console.log(BRANCH_SET_BASE_HELP);
      } else {
        console.log(BRANCH_HELP);
      }
      return true;
    }
    case "timer": {
      const sub = args[0];
      if (!sub) {
        console.log(TIMER_HELP);
      } else if (sub === "create") {
        console.log(TIMER_CREATE_HELP);
      } else if (sub === "list") {
        console.log(TIMER_LIST_HELP);
      } else if (sub === "cancel") {
        console.log(TIMER_CANCEL_HELP);
      } else {
        console.log(TIMER_HELP);
      }
      return true;
    }
    default:
      return false;
  }
}

function formatTimerScheduleLabel(timer: Pick<SessionTimerDetail, "type" | "originalSpec">): string {
  return timer.type === "recurring"
    ? `every ${timer.originalSpec}`
    : timer.type === "delay"
      ? `in ${timer.originalSpec}`
      : `at ${timer.originalSpec}`;
}

function printTimerRows(timers: SessionTimerDetail[]): void {
  for (const timer of timers) {
    const parts = [
      `  ${timer.id}`,
      formatTimerScheduleLabel(timer),
      `fires=${timer.fireCount}`,
      `next=${formatTimestampCompact(timer.nextFireAt)}`,
    ];
    if (timer.lastFiredAt) parts.push(`last=${formatTimestampCompact(timer.lastFiredAt)}`);
    console.log(`${parts.join("  ")}  "${formatInlineText(timer.title)}"`);
    if (timer.description) {
      console.log(`      ${formatInlineText(timer.description)}`);
    }
  }
}

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
}

function collapseToolCalls(tools: Array<{ name: string; summary: string }>): CollapsedToolGroup[] {
  const groups: CollapsedToolGroup[] = [];
  for (const tool of tools) {
    const last = groups[groups.length - 1];
    if (last && last.name === tool.name) {
      last.count++;
      last.summaries.push(tool.summary);
    } else {
      groups.push({ name: tool.name, count: 1, summaries: [tool.summary] });
    }
  }
  return groups;
}

// ─── Command handlers ───────────────────────────────────────────────────────

async function handleList(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const showAll = flags.all === true;
  const showActive = flags.active === true;
  const showHerd = flags.herd === true;
  const showTasks = flags.tasks === true;
  const jsonMode = flags.json === true;

  const sessions = (await apiGet(base, "/takode/sessions")) as Array<{
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
    reviewerOf?: number;
    claimedQuestId?: string | null;
    claimedQuestStatus?: string | null;
    pendingTimerCount?: number;
    taskHistory?: Array<{ title: string; timestamp: number }>;
  }>;

  // 3-mode filter:
  //   default      — herded sessions only (orchestrator's flock, excludes self)
  //   --active     — all unarchived sessions (discovery/triage view)
  //   --all        — everything including archived
  const mySessionId = getCredentials()?.sessionId;
  const mySelf = mySessionId ? sessions.find((s) => s.sessionId === mySessionId) : null;
  const isOrchestrator = mySelf?.isOrchestrator === true;

  let filtered: typeof sessions;
  let filterHint = "";
  if (showAll) {
    filtered = sessions;
  } else if (showActive) {
    filtered = sessions.filter((s) => !s.archived);
    filterHint = " (use --all to include archived)";
  } else if (showHerd) {
    if (!isOrchestrator || !mySessionId) {
      err("--herd requires an orchestrator session. Only leaders have herded workers.");
    }
    filtered = sessions.filter((s) => !s.archived && s.herdedBy === mySessionId);
    filterHint =
      filtered.length === 0
        ? " (no herded sessions -- run `takode list --active` to discover, then `takode herd <ids>`)"
        : " (herded only)";
  } else if (isOrchestrator && mySessionId) {
    // Default for orchestrators: show only herded sessions (the flock)
    filtered = sessions.filter((s) => !s.archived && s.herdedBy === mySessionId);
    filterHint =
      filtered.length === 0
        ? " (no herded sessions — run `takode list --active` to discover, then `takode herd <ids>`)"
        : " (herded only — use --active to see all)";
  } else {
    filtered = sessions.filter((s) => !s.archived);
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

  const shownWorkerCount = filtered.filter((s) => s.reviewerOf === undefined).length;
  const shownReviewerCount = filtered.length - shownWorkerCount;
  const activeHerdWorkerCount =
    isOrchestrator && mySessionId
      ? sessions.filter((s) => !s.archived && s.herdedBy === mySessionId && s.reviewerOf === undefined).length
      : null;

  // Group sessions by project (repo root or cwd).
  // Reviewers are grouped with their parent worker so they don't create
  // separate single-session groups for each worktree.
  const groups = new Map<string, typeof filtered>();
  const archived: typeof filtered = [];

  // Build sessionNum → projectKey lookup so reviewers can join their parent's group
  const sessionProjectKey = new Map<number, string>();
  for (const s of filtered) {
    if (!s.archived && s.sessionNum !== undefined && s.reviewerOf === undefined) {
      sessionProjectKey.set(s.sessionNum, (s.repoRoot || s.cwd || "").replace(/\/+$/, "") || "/");
    }
  }

  for (const s of filtered) {
    if (s.archived) {
      archived.push(s);
      continue;
    }
    // Reviewers inherit their parent's project group when the parent is visible
    const ownKey = (s.repoRoot || s.cwd || "").replace(/\/+$/, "") || "/";
    const projectKey = s.reviewerOf !== undefined ? (sessionProjectKey.get(s.reviewerOf) ?? ownKey) : ownKey;
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
    const label = formatInlineText(projectKey.split("/").pop() || projectKey);
    // Single pass to count top-level (non-reviewer) sessions and running sessions
    let topLevelCount = 0;
    let runningCount = 0;
    for (const s of projectSessions) {
      if (s.reviewerOf === undefined) {
        topLevelCount++;
        if (s.cliConnected && s.state === "running") runningCount++;
      }
    }
    const countLabel = runningCount > 0 ? `  (${runningCount} running)` : "";
    console.log(`▸ ${label}  ${topLevelCount}${countLabel}`);

    // Sort: running first, then by most recent activity
    projectSessions.sort((a, b) => {
      const aRunning = a.cliConnected && a.state === "running" ? 1 : 0;
      const bRunning = b.cliConnected && b.state === "running" ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });

    // Build a map of parentSessionNum -> reviewer sessions for nesting display
    total += printNestedSessions(projectSessions, showTasks);
    console.log("");
  }

  // Archived group
  if (archived.length > 0) {
    console.log(`▸ ARCHIVED  ${archived.length}`);
    total += printNestedSessions(archived, showTasks);
    console.log("");
  }

  console.log(
    `${total} session(s) shown (${shownWorkerCount} worker${shownWorkerCount === 1 ? "" : "s"}, ${shownReviewerCount} reviewer${shownReviewerCount === 1 ? "" : "s"})${filterHint}`,
  );
  if (activeHerdWorkerCount !== null) {
    console.log(
      `Worker slots used: ${activeHerdWorkerCount}/${HERD_WORKER_SLOT_LIMIT}. Reviewers do not use worker slots, and archiving reviewers will not free worker-slot capacity.`,
    );
  }
  console.log(
    `Status: ● running  ○ idle  ✗ disconnected  ⊘ archived  ⚠ needs attention  📋 quest  ↑↓ commits ahead/behind`,
  );
}

function printSessionLine(
  s: {
    sessionNum?: number;
    name?: string;
    state: string;
    cliConnected?: boolean;
    archived?: boolean;
    isOrchestrator?: boolean;
    isAssistant?: boolean;
    herdedBy?: string;
    reviewerOf?: number;
    model?: string;
    backendType?: string;
    cwd?: string;
    gitBranch?: string;
    gitAhead?: number;
    gitBehind?: number;
    totalLinesAdded?: number;
    totalLinesRemoved?: number;
    attentionReason?: string;
    pendingPermissionSummary?: string | null;
    lastActivityAt?: number;
    lastMessagePreview?: string;
    isWorktree?: boolean;
    claimedQuestId?: string | null;
    claimedQuestStatus?: string | null;
    pendingTimerCount?: number;
  },
  opts?: {
    indent?: boolean;
    attachedReviewer?: {
      sessionNum?: number;
      state: string;
      cliConnected?: boolean;
      archived?: boolean;
    } | null;
  },
): void {
  const prefix = opts?.indent ? "        ↳ " : "  ";
  const num = s.sessionNum !== undefined ? `#${s.sessionNum}` : "  ";
  const name = formatInlineText(s.name || "(unnamed)");
  const role = s.isOrchestrator ? " [leader]" : s.reviewerOf !== undefined ? " [reviewer]" : "";
  const herd = s.herdedBy ? " [herd]" : "";
  // Backend type tag: only show for codex (sdk is implied by session details)
  const backend = s.backendType === "codex" ? " [codex]" : "";
  const status = s.cliConnected ? (s.state === "running" ? "●" : "○") : s.archived ? "⊘" : "✗";
  const attention = s.pendingPermissionSummary
    ? ` ⚠ ${formatInlineText(s.pendingPermissionSummary)}`
    : s.attentionReason
      ? ` ⚠ ${formatInlineText(s.attentionReason)}`
      : "";

  // Quest indicator: "📋 q-42 in_progress"
  const quest = s.claimedQuestId
    ? ` 📋 ${formatInlineText(s.claimedQuestId)}${s.claimedQuestStatus ? ` ${formatInlineText(s.claimedQuestStatus)}` : ""}`
    : "";
  const timers = ` ⏰${s.pendingTimerCount ?? 0}`;
  let reviewerSummary = "";
  if (!opts?.indent && s.reviewerOf === undefined && opts?.attachedReviewer) {
    const reviewer = opts.attachedReviewer;
    const reviewerStatus = reviewer.cliConnected
      ? reviewer.state === "running"
        ? "running"
        : "idle"
      : reviewer.archived
        ? "archived"
        : "disconnected";
    const reviewerNum = reviewer.sessionNum !== undefined ? `#${reviewer.sessionNum}` : "#?";
    reviewerSummary = ` 👀 ${reviewerNum} ${reviewerStatus}`;
  }

  const branch = s.gitBranch ? `  ${formatInlineText(s.gitBranch)}` : "";

  // Commits ahead/behind: "3↑5↓" (only show non-zero)
  const ahead = s.gitAhead ? `${s.gitAhead}↑` : "";
  const behind = s.gitBehind ? `${s.gitBehind}↓` : "";
  const gitDelta = ahead || behind ? ` ${ahead}${behind}` : "";

  // Uncommitted diff stats: "+114 -10" (only show non-zero)
  const added = s.totalLinesAdded ? `+${s.totalLinesAdded}` : "";
  const removed = s.totalLinesRemoved ? `-${s.totalLinesRemoved}` : "";
  const diffStats = added || removed ? ` ${[added, removed].filter(Boolean).join(" ")}` : "";

  const wt = s.isWorktree ? " wt" : "";
  // Show cwd as the last directory component (folder name) for brevity
  const cwdLabel = s.cwd ? truncate(s.cwd.replace(/\/$/, "").split("/").pop() || s.cwd, 30) : "";
  const activity = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : "";
  const preview = s.lastMessagePreview ? `  "${truncate(s.lastMessagePreview, 50)}"` : "";

  console.log(
    `${prefix}${num.padEnd(5)} ${status} ${name}${role}${herd}${backend}${quest}${timers}${reviewerSummary}${attention}`,
  );
  // Compact display for indented reviewer sessions: skip the detail line (cwd/branch)
  // since reviewers share the parent's worktree and the extra line is just noise
  if (!opts?.indent) {
    console.log(`${prefix}      ${cwdLabel}${branch}${gitDelta}${diffStats}${wt}  ${activity}${preview}`);
  }
}

/**
 * Print a list of sessions with reviewer sessions indented under their parent.
 * Returns the number of sessions printed.
 */
function printNestedSessions(
  sessions: Parameters<typeof printSessionLine>[0] &
    { sessionNum?: number; reviewerOf?: number; taskHistory?: Array<{ title: string; timestamp: number }> }[],
  showTasks: boolean,
): number {
  const reviewersByParent = new Map<number, typeof sessions>();
  const topLevel = sessions.filter((s) => {
    if (s.reviewerOf !== undefined) {
      const list = reviewersByParent.get(s.reviewerOf) || [];
      list.push(s);
      reviewersByParent.set(s.reviewerOf, list);
      return false;
    }
    return true;
  });

  let count = 0;
  for (const s of topLevel) {
    const reviewers = s.sessionNum !== undefined ? reviewersByParent.get(s.sessionNum) : undefined;
    printSessionLine(s, { attachedReviewer: reviewers?.[0] ?? null });
    if (showTasks) printSessionTasks(s.taskHistory);
    count++;
    if (reviewers) {
      for (const r of reviewers) {
        printSessionLine(r, { indent: true });
        if (showTasks) printSessionTasks(r.taskHistory);
        count++;
      }
      reviewersByParent.delete(s.sessionNum!);
    }
  }
  // Orphaned reviewers (parent filtered out or archived). Shown with ↳ indent
  // for visual consistency -- the [reviewer] tag clarifies they're reviewer sessions
  // even though their parent isn't visible in the current listing.
  for (const [, orphans] of reviewersByParent) {
    for (const r of orphans) {
      printSessionLine(r, { indent: true });
      if (showTasks) printSessionTasks(r.taskHistory);
      count++;
    }
  }
  return count;
}

function printSessionTasks(taskHistory?: Array<{ title: string; timestamp: number }>): void {
  if (!taskHistory || taskHistory.length === 0) return;
  const maxDisplay = 8;
  const entries = taskHistory.slice(-maxDisplay);
  const header =
    taskHistory.length > maxDisplay
      ? `       Tasks (showing ${entries.length} of ${taskHistory.length}):`
      : `       Tasks (${entries.length}):`;
  console.log(header);
  for (const t of entries) {
    const time = formatTimeShort(t.timestamp);
    const title = truncate(formatInlineText(t.title), 60);
    console.log(`         ${time}  ${title}`);
  }
}

// ─── Info handler ────────────────────────────────────────────────────────────

async function handleInfo(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode info <session> [--json]");

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const data = await fetchSessionInfo(base, sessionRef);

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  printSessionInfo(data);
}

async function handleLeaderContextResume(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode leader-context-resume <session> [--json]");
  const flags = parseFlags(args.slice(1));
  const result = (await apiGet(
    base,
    `/sessions/${encodeURIComponent(sessionRef)}/leader-context-resume`,
  )) as LeaderContextResumeModel;
  if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderLeaderContextResumeText(result));
}

function printSessionInfo(data: TakodeSessionInfo): void {
  // ── Header ──
  const num = data.sessionNum != null ? `#${data.sessionNum}` : "";
  const name = formatInlineText(data.name || "(unnamed)");
  const statusIcon = data.cliConnected ? (data.state === "running" ? "●" : "○") : data.archived ? "⊘" : "✗";
  const statusLabel = data.cliConnected
    ? data.isGenerating
      ? "running (generating)"
      : data.state
    : data.archived
      ? "archived"
      : "disconnected";
  console.log(`${num} ${name}  ${statusIcon} ${statusLabel}`);
  console.log("─".repeat(60));

  // ── Identity ──
  console.log(`  UUID           ${formatInlineText(data.sessionId)}`);
  if (data.cliSessionId) console.log(`  CLI Session    ${formatInlineText(data.cliSessionId)}`);
  if (data.pid) console.log(`  PID            ${data.pid}`);

  // ── Backend ──
  const backend = data.backendType || "claude";
  const model = data.model || "unknown";
  console.log(`  Backend        ${formatInlineText(backend)}  model: ${formatInlineText(model)}`);
  if (data.claudeCodeVersion) console.log(`  CLI Version    ${formatInlineText(data.claudeCodeVersion)}`);
  if (data.permissionMode) console.log(`  Permissions    ${formatInlineText(data.permissionMode)}`);
  if (typeof data.askPermission === "boolean") {
    console.log(`  Ask Mode       ${data.askPermission ? "ask" : "no-ask"}`);
  }
  if (data.uiMode) console.log(`  UI Mode        ${formatInlineText(data.uiMode)}`);
  if (backend === "codex") {
    if (typeof data.codexInternetAccess === "boolean") {
      console.log(`  Internet       ${data.codexInternetAccess ? "enabled" : "disabled"}`);
    }
    if (data.codexReasoningEffort) console.log(`  Reasoning      ${formatInlineText(data.codexReasoningEffort)}`);
    if (data.codexSandbox) console.log(`  Sandbox        ${formatInlineText(data.codexSandbox)}`);
  }

  // ── Working directory ──
  console.log(`  CWD            ${formatInlineText(data.cwd)}`);
  if (data.repoRoot && data.repoRoot !== data.cwd) {
    console.log(`  Repo Root      ${formatInlineText(data.repoRoot)}`);
  }

  // ── Worktree / Container ──
  console.log(`  Worktree       ${data.isWorktree ? "yes" : "no"}`);
  if (data.isWorktree) {
    if (data.branch) console.log(`  WT Branch      ${formatInlineText(data.branch)}`);
    if (data.actualBranch && data.actualBranch !== data.branch) {
      console.log(`  Actual Branch  ${formatInlineText(data.actualBranch)}`);
    }
  }
  if (data.containerId) {
    console.log(`  Container      ${formatInlineText(data.containerName || data.containerId)}`);
    if (data.containerImage) console.log(`  Image          ${formatInlineText(data.containerImage)}`);
  }

  // ── Git ──
  const gitBranch = data.gitBranch || data.branch;
  if (gitBranch) {
    const ahead = data.gitAhead ? `${data.gitAhead}↑` : "";
    const behind = data.gitBehind ? `${data.gitBehind}↓` : "";
    const delta = [ahead, behind].filter(Boolean).join(" ");
    console.log(`  Git Branch     ${formatInlineText(gitBranch)}${delta ? `  ${delta}` : ""}`);
  }
  if (data.gitHeadSha) console.log(`  HEAD           ${data.gitHeadSha.slice(0, 12)}`);
  if (data.gitDefaultBranch) console.log(`  Default Branch ${formatInlineText(data.gitDefaultBranch)}`);
  if (data.diffBaseBranch) console.log(`  Diff Base      ${formatInlineText(data.diffBaseBranch)}`);

  const added = data.totalLinesAdded || 0;
  const removed = data.totalLinesRemoved || 0;
  if (added || removed) {
    console.log(`  Diff Stats     +${added} -${removed}`);
  }

  // ── Roles ──
  const roles: string[] = [];
  if (data.isOrchestrator) roles.push("orchestrator");
  if (data.isAssistant) roles.push("assistant");
  if (data.herdedBy) roles.push(`herded`);
  if (roles.length > 0) console.log(`  Roles          ${roles.join(", ")}`);
  if (data.herdedBy) console.log(`  Herded By      ${formatInlineText(data.herdedBy)}`);

  // ── Quest ──
  if (data.claimedQuestId) {
    const questLine = `${formatInlineText(data.claimedQuestId)}${data.claimedQuestStatus ? ` (${formatInlineText(data.claimedQuestStatus)})` : ""}`;
    console.log(`  Quest          ${questLine}`);
    if (data.claimedQuestTitle) console.log(`                 ${formatInlineText(data.claimedQuestTitle)}`);
  }

  // ── Cron ──
  if (data.cronJobId) {
    console.log(`  Cron Job       ${formatInlineText(data.cronJobName || data.cronJobId)}`);
  }
  console.log(`  Timers         ${data.pendingTimerCount ?? 0} pending`);

  // ── Env ──
  if (data.envSlug) console.log(`  Env Profile    ${formatInlineText(data.envSlug)}`);

  // ── Metrics ──
  const turns = data.numTurns || 0;
  const cost = data.totalCostUsd || 0;
  const context = data.contextUsedPercent || 0;
  if (turns || cost || context) {
    console.log("");
    console.log(`  Turns          ${turns}`);
    if (cost > 0) console.log(`  Cost           $${cost.toFixed(4)}`);
    console.log(`  Context Used   ${context}%${data.isCompacting ? " (compacting)" : ""}`);
  }

  // ── MCP Servers ──
  if (data.mcpServers && data.mcpServers.length > 0) {
    console.log("");
    console.log(
      `  MCP Servers    ${data.mcpServers.map((s) => `${formatInlineText(s.name)} (${formatInlineText(s.status)})`).join(", ")}`,
    );
  }

  // ── Tools ──
  if (data.tools && data.tools.length > 0) {
    console.log(`  Tools          ${data.tools.length} available`);
  }

  // ── Attention ──
  if (data.attentionReason) {
    console.log(`  Attention      ⚠ ${formatInlineText(data.attentionReason)}`);
  }

  // ── Timestamps ──
  console.log("");
  console.log(`  Created        ${formatDate(data.createdAt)} ${formatTime(data.createdAt)}`);
  if (data.lastActivityAt) {
    console.log(`  Last Activity  ${formatRelativeTime(data.lastActivityAt)} (${formatTime(data.lastActivityAt)})`);
  }
  if (data.archived && data.archivedAt) {
    console.log(`  Archived       ${formatDate(data.archivedAt)} ${formatTime(data.archivedAt)}`);
  }

  // ── Keywords ──
  if (data.keywords && data.keywords.length > 0) {
    console.log(`  Keywords       ${data.keywords.map((keyword) => formatInlineText(keyword)).join(", ")}`);
  }
}

// ─── Tasks handler ───────────────────────────────────────────────────────────

async function handleTasks(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode tasks <session> [--json]");
  const safeSessionRef = formatInlineText(sessionRef);

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;

  const data = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/tasks`)) as {
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

  console.log(`Session #${data.sessionNum} "${formatInlineText(data.sessionName)}"`);
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
    const quest = task.questId ? ` (${formatInlineText(task.questId)})` : "";
    console.log(`  ${num}  ${time}   ${title}${range}${quest}`);
  }

  console.log("");
  console.log(`Browse: takode peek ${safeSessionRef} --from <msg-id> | Task: takode peek ${safeSessionRef} --task <n>`);
}

// ─── Timers handler ──────────────────────────────────────────────────────────

async function handleTimers(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode timers <session> [--json]");

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const result = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/timers`)) as {
    timers: SessionTimerDetail[];
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.timers.length === 0) {
    console.log(`No pending timers for ${formatInlineText(sessionRef)}.`);
    return;
  }

  console.log(`Pending timers for ${formatInlineText(sessionRef)} (${result.timers.length}):\n`);
  printTimerRows(result.timers);
}

// ─── Peek types ──────────────────────────────────────────────────────────────

type PeekMessage = {
  idx: number;
  type: string;
  content: string;
  ts: number;
  tools?: Array<{ idx: number; name: string; summary: string }>;
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
              console.log(
                `  ${pipe}       ${connector} ${formatInlineText(group.name).padEnd(6)} ${truncate(group.summaries[0], 80)}`,
              );
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
            console.log(`  ${idx.padEnd(7)}           → ${formatInlineText(tool.name)}: ${truncate(tool.summary, 80)}`);
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

async function handlePeek(base: string, args: string[]): Promise<void> {
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

async function handleSend(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  const usage =
    "Usage: takode send <session> <message> [--correction] [--json]\n       takode send <session> --stdin [--correction] [--json]";
  const flags = parseFlags(args.slice(1));
  assertKnownFlags(flags, new Set(["json", "correction", "stdin"]), usage);

  const jsonMode = flags.json === true;
  const isCorrection = flags.correction === true;
  const useStdin = flags.stdin === true;

  const messageParts = args.slice(1).filter((arg) => arg !== "--json" && arg !== "--correction" && arg !== "--stdin");

  if (!sessionRef) err(usage);
  if (useStdin && messageParts.length > 0) {
    err("Cannot combine --stdin with a positional message.");
  }

  const cleanContent = useStdin ? await readStdinText() : messageParts.join(" ");

  if (!cleanContent.trim()) err(usage);

  // Guard: orchestrators can only send to herded sessions
  const callerSessionId = getCredentials()?.sessionId;
  if (callerSessionId) {
    try {
      // Resolve target to a full UUID
      const targetSession = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}`)) as {
        sessionId: string;
        sessionNum?: number;
        name?: string;
        isGenerating?: boolean;
        archived?: boolean;
      };
      const targetId = targetSession.sessionId;
      if (targetSession.archived) {
        const label = targetSession.name
          ? `#${targetSession.sessionNum ?? "?"} ${targetSession.name}`
          : `#${targetSession.sessionNum ?? sessionRef}`;
        err(`Cannot send to archived session ${label}.`);
      }

      // Guard: block sends to running sessions unless --correction is used
      if (targetSession.isGenerating && !isCorrection) {
        const label = targetSession.name
          ? `#${targetSession.sessionNum ?? "?"} ${targetSession.name}`
          : `#${targetSession.sessionNum ?? sessionRef}`;
        err(
          `Session ${label} is currently working. ` +
            `Queue this task and send it after the session finishes. ` +
            `Use "takode send ${sessionRef} <message> --correction" if this is a steering message for the current task.`,
        );
      }

      // Check herd membership
      const herdList = (await apiGet(base, `/sessions/${encodeURIComponent(callerSessionId)}/herd`)) as Array<{
        sessionId: string;
      }>;
      if (!herdList.some((s) => s.sessionId === targetId)) {
        err(`Cannot send to session ${sessionRef} — not in your herd. Run \`takode herd ${sessionRef}\` first.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If error is from our own guards (herd check, running check), re-throw
      if (msg.includes("not in your herd") || msg.includes("currently working") || msg.includes("archived session")) {
        throw e;
      }
      // Other errors (session not found, etc.) — let the send call handle it
    }
  }

  // Identify the calling session so the receiver can show an agent badge
  let agentSource: { sessionId: string; sessionLabel?: string } | undefined;
  if (callerSessionId) {
    let sessionLabel: string | undefined;
    try {
      const sessions = (await apiGet(base, "/takode/sessions")) as Array<{
        sessionId: string;
        sessionNum?: number;
        name?: string;
      }>;
      const own = sessions.find((s) => s.sessionId === callerSessionId);
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

  const delivery = (result as { delivery?: string }).delivery;
  if (delivery === "queued") {
    console.log(
      `[${formatTime(Date.now())}] \u2713 Message queued for session ${formatInlineText(sessionRef)} (session restarting)`,
    );
  } else {
    console.log(`[${formatTime(Date.now())}] \u2713 Message sent to session ${formatInlineText(sessionRef)}`);
  }
}

async function handleUserMessage(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, new Set(["json", "text-file"]), USER_MESSAGE_HELP.trim());
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--text-file") {
      i++;
      continue;
    }
    if (arg === "--json") continue;
    if (arg.startsWith("--")) continue;
    positional.push(arg);
  }
  if (positional.length > 0) {
    err(`${USER_MESSAGE_HELP.trim()}\n\nDo not pass message text positionally. Use --text-file <path|->.`);
  }

  const textFile = flags["text-file"];
  if (textFile === undefined) {
    err(`${USER_MESSAGE_HELP.trim()}\n\n--text-file is required.`);
  }
  if (textFile === true) {
    err(`${USER_MESSAGE_HELP.trim()}\n\n--text-file requires a path or '-' for stdin.`);
  }
  const content = await readOptionTextFile(textFile, "--text-file");
  if (!content.trim()) err("User-visible message content is required.");

  const selfId = getCallerSessionId();
  const result = await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/user-message`, { content });
  if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`[${formatTime(Date.now())}] \u2713 User-visible message published`);
}

// ─── Spawn handler ───────────────────────────────────────────────────────────

const SPAWN_FLAG_USAGE = `Usage: takode spawn [options]

  Create and auto-herd new worker sessions.

Options:
  --backend <type>             AI backend: "claude", "codex", or "claude-sdk" (default: inherit from leader)
  --cwd <path>                 Working directory (default: current directory)
  --count <n>                  Number of sessions to spawn (default: 1)
  --message <text>             Short inline initial message
  --message-file <path>|-      Read the initial message from a file or stdin
  --model <id>                 Override the session model
  --ask / --no-ask             Override inherited ask mode
  --internet / --no-internet   Codex-only: enable or disable internet access
  --reasoning-effort <level>   Codex-only: low, medium, or high
  --no-worktree                Disable worktree creation
  --fixed-name <name>          Set a fixed session name (disables auto-naming)
  --reviewer <session>         Create a reviewer session tied to a parent worker (by session number)
  --json                       Output in JSON format

Examples:
  takode spawn --backend claude-sdk --count 2
  takode spawn --backend codex --model gpt-5.4 --reasoning-effort high --internet
  takode spawn --count 3 --no-worktree
  takode spawn --message-file /tmp/dispatch.txt
  printf '%s\n' 'Review q-10' 'Treat \`$(nope)\` as literal text.' | takode spawn --reviewer 42 --message-file -`;

const SPAWN_ALLOWED_FLAGS = new Set([
  "backend",
  "cwd",
  "count",
  "message",
  "message-file",
  "model",
  "ask",
  "no-ask",
  "internet",
  "no-internet",
  "reasoning",
  "reasoning-effort",
  "no-worktree",
  "fixed-name",
  "reviewer",
  "json",
  "help",
  "h",
]);

const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);

function resolveReasoningEffort(flags: Record<string, string | boolean>): string | undefined {
  const primary = flags["reasoning-effort"];
  const alias = flags.reasoning;
  if (primary !== undefined && alias !== undefined) {
    err("Cannot combine --reasoning-effort and --reasoning.");
  }
  const raw = primary ?? alias;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") err("--reasoning-effort requires a value: low, medium, or high.");
  const normalized = raw.trim().toLowerCase();
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    err(`Invalid --reasoning-effort: ${raw}. Expected low, medium, or high.`);
  }
  return normalized;
}

function buildSpawnDetailParts(session: TakodeSessionInfo): string[] {
  const parts: string[] = [];
  if (session.model) parts.push(`model=${session.model}`);
  if (typeof session.askPermission === "boolean") {
    parts.push(`ask=${session.askPermission ? "on" : "off"}`);
  }
  parts.push(`worktree=${session.isWorktree ? "yes" : "no"}`);
  if (session.backendType === "codex") {
    if (session.codexReasoningEffort) parts.push(`reasoning=${session.codexReasoningEffort}`);
    if (typeof session.codexInternetAccess === "boolean") {
      parts.push(`internet=${session.codexInternetAccess ? "on" : "off"}`);
    }
  }
  return parts;
}

function printSpawnedSession(session: TakodeSessionInfo): void {
  const num = session.sessionNum != null ? `#${session.sessionNum}` : session.sessionId.slice(0, 8);
  const name = formatInlineText(session.name || "(unnamed)");
  const backend = session.backendType === "codex" ? " [codex]" : "";
  const wt = session.isWorktree ? " wt" : "";
  const branch = formatInlineText(session.actualBranch || session.branch || "");
  const branchLabel = branch ? `  ${branch}` : "";
  const cwdLabel = session.cwd ? formatInlineText(session.cwd.replace(/\/$/, "").split("/").pop() || session.cwd) : "";
  console.log(`[${formatTime(Date.now())}] \u2713 Spawned ${num} "${name}"${backend}${wt}`);
  console.log(`        ${cwdLabel}${branchLabel}  ${formatInlineText(session.sessionId)}`);
  const detailParts = buildSpawnDetailParts(session);
  if (detailParts.length > 0) {
    console.log(`        ${detailParts.map((part) => formatInlineText(part)).join("  ")}`);
  }
}

async function handleSpawn(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, SPAWN_ALLOWED_FLAGS, SPAWN_FLAG_USAGE);

  if (flags.help === true || flags.h === true) {
    console.log(`\n${SPAWN_FLAG_USAGE}\n`);
    return;
  }

  await ensureTakodeAccess(base, { requireOrchestrator: true });

  const jsonMode = flags.json === true;
  const leaderSessionId = getCallerSessionId();

  // Fetch leader session first -- we need backendType for default resolution
  // and permissionMode for bypass inheritance.
  const leader = (await apiGet(base, `/sessions/${encodeURIComponent(leaderSessionId)}`)) as {
    sessionId: string;
    sessionNum?: number | null;
    name?: string | null;
    permissionMode?: string;
    backendType?: string;
  };
  const leaderSessionLabel = leader.name
    ? `#${leader.sessionNum ?? "?"} ${leader.name}`
    : leader.sessionNum != null
      ? `#${leader.sessionNum}`
      : undefined;

  // Inherit backend from leader when --backend is not explicitly provided.
  const backendRaw = typeof flags.backend === "string" ? flags.backend : leader.backendType || "claude";
  if (backendRaw !== "claude" && backendRaw !== "codex" && backendRaw !== "claude-sdk") {
    err(`Invalid backend: ${backendRaw}. Expected "claude", "codex", or "claude-sdk".`);
  }

  let cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const useWorktree = flags["no-worktree"] === true ? false : true;
  const fixedName = typeof flags["fixed-name"] === "string" ? flags["fixed-name"].trim() : "";
  if (flags["fixed-name"] !== undefined && !fixedName) {
    err("--fixed-name requires a non-empty name value.");
  }
  const message =
    (await readOptionalRichTextOption(flags, {
      inlineFlag: "message",
      fileFlag: "message-file",
      label: "Initial message",
    })) ?? "";
  const model = resolveStringFlag(flags, "model", "model");
  const askOverride = resolveBooleanToggleFlag(flags, "ask", "no-ask");
  const internetOverride = resolveBooleanToggleFlag(flags, "internet", "no-internet");
  const reasoningEffort = resolveReasoningEffort(flags);

  // --reviewer <session-number>: create a reviewer session tied to a parent worker
  const reviewerRaw = flags.reviewer;
  let reviewerOfNum: number | undefined;
  if (reviewerRaw !== undefined) {
    const parsed = Number(String(reviewerRaw).replace(/^#/, ""));
    if (!Number.isInteger(parsed) || parsed < 0) {
      err("--reviewer requires a valid session number (e.g. --reviewer 42).");
    }
    reviewerOfNum = parsed;
  }

  const countRaw = flags.count;
  const count = countRaw === undefined ? 1 : Number(countRaw);
  if (!Number.isInteger(count) || count < 1) {
    err("Invalid --count. Expected a positive integer.");
  }
  if (backendRaw !== "codex" && internetOverride !== undefined) {
    err("--internet and --no-internet are only supported for Codex sessions.");
  }
  if (backendRaw !== "codex" && reasoningEffort !== undefined) {
    err("--reasoning-effort is only supported for Codex sessions.");
  }

  // Reviewer-specific validations
  if (reviewerOfNum !== undefined) {
    if (count > 1) {
      err("--reviewer cannot be combined with --count > 1. Only one reviewer per parent.");
    }

    // Check that no existing active reviewer already targets this parent
    try {
      const allSessions = (await apiGet(base, "/takode/sessions")) as Array<{
        sessionId: string;
        archived?: boolean;
        reviewerOf?: number;
        name?: string;
        sessionNum?: number;
        cwd?: string;
      }>;
      const existingReviewer = allSessions.find((s) => !s.archived && s.reviewerOf === reviewerOfNum);
      if (existingReviewer) {
        const existingLabel =
          existingReviewer.sessionNum !== undefined
            ? `#${existingReviewer.sessionNum}`
            : existingReviewer.sessionId.slice(0, 8);
        err(
          `Session #${reviewerOfNum} already has an active reviewer (${existingLabel}). ` +
            `Archive it first with \`takode archive ${existingLabel}\`.`,
        );
      }

      // Inherit the parent worker's cwd so the reviewer lands in the same
      // sidebar project group. repoRoot is inferred by the server from cwd.
      const parentSession = allSessions.find((s) => s.sessionNum === reviewerOfNum && !s.archived);
      if (parentSession?.cwd?.trim() && typeof flags.cwd !== "string") {
        cwd = parentSession.cwd;
      }
    } catch (e) {
      // Only re-throw our own errors (from err()); skip API fetch failures
      if (e instanceof Error && e.message.startsWith("Session #")) throw e;
    }
  }

  const inheritBypass = leader.permissionMode === "bypassPermissions";

  const spawned: TakodeSessionInfo[] = [];
  for (let i = 0; i < count; i++) {
    const createPayload: Record<string, unknown> = {
      backend: backendRaw,
      cwd,
      useWorktree: reviewerOfNum !== undefined ? false : useWorktree,
      createdBy: leaderSessionId,
    };

    // Reviewer sessions: auto-set name and suppress auto-naming
    if (reviewerOfNum !== undefined) {
      createPayload.reviewerOf = reviewerOfNum;
      createPayload.noAutoName = true;
      if (!fixedName) {
        createPayload.fixedName = `Reviewer of #${reviewerOfNum}`;
      } else {
        createPayload.fixedName = fixedName;
      }
    } else if (fixedName) {
      createPayload.noAutoName = true;
      createPayload.fixedName = fixedName;
    }
    if (model) {
      createPayload.model = model;
    }

    const askPermission = askOverride ?? (inheritBypass ? false : undefined);
    if (askPermission !== undefined) {
      createPayload.askPermission = askPermission;
      if (backendRaw === "codex" && askPermission === false) {
        createPayload.permissionMode = "bypassPermissions";
      }
    }

    if (backendRaw === "codex") {
      createPayload.codexReasoningEffort = reasoningEffort || "high";
      if (internetOverride !== undefined) {
        createPayload.codexInternetAccess = internetOverride;
      } else if (inheritBypass) {
        createPayload.codexInternetAccess = true;
      }
    }

    const created = (await apiPost(base, "/sessions/create", createPayload)) as { sessionId: string };

    if (message) {
      await apiPost(base, `/sessions/${encodeURIComponent(created.sessionId)}/message`, {
        content: message,
        agentSource: {
          sessionId: leaderSessionId,
          ...(leaderSessionLabel ? { sessionLabel: leaderSessionLabel } : {}),
        },
      });
    }

    spawned.push(await fetchSessionInfo(base, created.sessionId));
  }

  // Check worker-slot usage and warn if over the limit.
  let herdWarning: { workerSlotsUsed: number; excessWorkers: number; limit: number } | null = null;
  try {
    const allSessions = (await apiGet(base, "/takode/sessions")) as Array<{
      sessionId: string;
      archived?: boolean;
      herdedBy?: string;
      reviewerOf?: number;
    }>;
    const activeHerdWorkers = allSessions.filter(
      (s) => !s.archived && s.herdedBy === leaderSessionId && s.reviewerOf === undefined,
    );
    if (activeHerdWorkers.length > HERD_WORKER_SLOT_LIMIT) {
      herdWarning = {
        workerSlotsUsed: activeHerdWorkers.length,
        excessWorkers: activeHerdWorkers.length - HERD_WORKER_SLOT_LIMIT,
        limit: HERD_WORKER_SLOT_LIMIT,
      };
    }
  } catch {
    // Non-critical — skip warning if we can't fetch sessions
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          count: spawned.length,
          backend: backendRaw,
          cwd,
          useWorktree,
          leaderSessionId,
          leaderPermissionMode: leader.permissionMode || null,
          inheritedAskPermission: askOverride === undefined && inheritBypass ? false : null,
          defaultModel: backendRaw === "codex" && !model ? getCliDefaultModelForBackend("codex") : null,
          message: message || null,
          sessions: spawned,
          ...(herdWarning ? { herdWarning } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const session of spawned) {
    printSpawnedSession(session);
  }
  if (herdWarning) {
    console.log(
      `\n\u26a0 Worker slots used: ${herdWarning.workerSlotsUsed}/${herdWarning.limit}. Please archive ${herdWarning.excessWorkers} worker session${herdWarning.excessWorkers === 1 ? "" : "s"} least likely to be reused. Reviewers do not use worker slots, and archiving reviewers will not free worker-slot capacity. Archived sessions' history remains readable via takode peek/read.`,
    );
  }
}

// ─── Rename handler ─────────────────────────────────────────────────────────

async function handleRename(base: string, args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const sessionRef = positional[0];
  const name = positional.slice(1).join(" ");
  const jsonMode = args.includes("--json");
  if (!sessionRef || !name.trim()) err("Usage: takode rename <session> <name>");

  const result = (await apiPatch(base, `/sessions/${encodeURIComponent(sessionRef)}/name`, {
    name: name.trim(),
  })) as { ok: boolean; name?: string; error?: string };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `[${formatTime(Date.now())}] ✓ Renamed session ${formatInlineText(sessionRef)} → "${formatInlineText(result.name || name.trim())}"`,
  );
}

// ─── Interrupt handler ──────────────────────────────────────────────────────

async function handleInterrupt(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode interrupt <session>");

  const mySessionId = getCallerSessionId();

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/interrupt`, {
    callerSessionId: mySessionId,
  })) as { ok: boolean; sessionId?: string; error?: string };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[${formatTime(Date.now())}] \u2713 Interrupted session ${formatInlineText(sessionRef)}`);
}

// ─── Archive handler ─────────────────────────────────────────────────────────

async function handleArchive(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode archive <session>");

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/archive`, {})) as {
    ok: boolean;
    error?: string;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.ok) {
    console.log(`[${formatTime(Date.now())}] \u2713 Archived session ${formatInlineText(sessionRef)}`);
  } else {
    console.log(
      `[${formatTime(Date.now())}] \u2717 Failed to archive session ${formatInlineText(sessionRef)}: ${result.error || "unknown error"}`,
    );
  }
}

// ─── Herd/Unherd handlers ───────────────────────────────────────────────────

async function handleHerd(base: string, args: string[]): Promise<void> {
  const jsonMode = args.includes("--json");
  const forceMode = args.includes("--force");
  // Parse comma/space-separated session refs (filtering out flags)
  const refs = args
    .filter((a) => !a.startsWith("--"))
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (refs.length === 0) err("Usage: takode herd [--force] <session1,session2,...>");

  const mySessionId = getCallerSessionId();

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(mySessionId)}/herd`, {
    workerIds: refs,
    ...(forceMode ? { force: true } : {}),
  })) as HerdSessionsResponse;

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    if (result.conflicts?.length > 0 && !forceMode) {
      const suggestionRefs = result.conflicts.map((c) => c.id).join(",");
      err(
        `Herd request conflicted with existing ownership. Rerun with \`takode herd --force ${suggestionRefs}\` if takeover is intended.`,
      );
    }
    return;
  }

  if (result.herded.length > 0) {
    console.log(`[${formatTime(Date.now())}] \u2713 Herded ${result.herded.length} session(s)`);
    await Promise.all(
      result.herded.map(async (sid) => {
        try {
          const info = await fetchSessionInfo(base, sid);
          printSessionLine(info);
        } catch (err) {
          console.error(`  Failed to fetch info for ${formatInlineText(sid)}: ${err}`);
        }
      }),
    );
  }
  if (result.reassigned.length > 0) {
    for (const reassigned of result.reassigned) {
      console.log(
        `[${formatTime(Date.now())}] \u21ba Reassigned ${formatInlineText(reassigned.id)} from ${formatInlineText(reassigned.fromLeader)}`,
      );
    }
  }
  if (result.notFound.length > 0) {
    console.log(
      `[${formatTime(Date.now())}] \u2717 Not found: ${result.notFound.map((ref) => formatInlineText(ref)).join(", ")}`,
    );
  }
  if (result.conflicts?.length > 0) {
    for (const c of result.conflicts) {
      console.log(
        `[${formatTime(Date.now())}] \u2717 Conflict: ${formatInlineText(c.id)} already herded by ${formatInlineText(c.herder)}`,
      );
    }
    if (!forceMode) {
      const suggestionRefs = result.conflicts.map((c) => c.id).join(",");
      err(
        `Herd request conflicted with existing ownership. Rerun with \`takode herd --force ${suggestionRefs}\` if takeover is intended.`,
      );
    }
  }
  if (result.leaders.length > 0) {
    for (const lid of result.leaders) {
      console.log(`[${formatTime(Date.now())}] \u2717 Cannot herd leader session: ${formatInlineText(lid)}`);
    }
  }
}

async function handleUnherd(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode unherd <session>");

  const mySessionId = getCallerSessionId();

  const result = (await apiDelete(
    base,
    `/sessions/${encodeURIComponent(mySessionId)}/herd/${encodeURIComponent(sessionRef)}`,
  )) as { ok: boolean; removed: boolean };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.removed) {
    console.log(`[${formatTime(Date.now())}] \u2713 Unherded session ${formatInlineText(sessionRef)}`);
  } else {
    console.log(`[${formatTime(Date.now())}] Session ${formatInlineText(sessionRef)} was not herded by you`);
  }
}

// ─── Pending/Answer handlers ────────────────────────────────────────────────

async function handlePending(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode pending <session>");
  const safeSessionRef = formatInlineText(sessionRef);

  const result = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/pending`)) as {
    pending: Array<{
      kind?: "permission" | "notification";
      request_id?: string;
      tool_name: string;
      timestamp: number;
      notification_id?: string;
      summary?: string;
      suggestedAnswers?: string[];
      msg_index?: number;
      questions?: Array<{
        header?: string;
        question: string;
        options?: Array<{ label: string; description?: string }>;
      }>;
      plan?: string;
      allowedPrompts?: Array<{ tool: string; prompt: string }>;
    }>;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.pending.length === 0) {
    console.log("No pending questions, needs-input prompts, or plans to answer.");
    return;
  }

  const buildAnswerTargetHint = (pendingItem: (typeof result.pending)[number]): string => {
    if (typeof pendingItem.msg_index === "number") return ` --message ${pendingItem.msg_index}`;
    if (typeof pendingItem.request_id === "string" && pendingItem.request_id)
      return ` --target ${pendingItem.request_id}`;
    if (typeof pendingItem.notification_id === "string" && pendingItem.notification_id) {
      return ` --target ${pendingItem.notification_id}`;
    }
    return "";
  };

  for (const p of result.pending) {
    const msgRef = typeof p.msg_index === "number" ? ` [msg ${p.msg_index}]` : "";
    const targetHint = buildAnswerTargetHint(p);

    if (p.kind === "notification" || p.tool_name === "takode.notify") {
      const summary = p.summary?.trim() || "Needs input";
      console.log(`\n[needs-input]${msgRef} ${formatInlineText(summary)}`);
      if (msgRef) {
        console.log(`\nFull message: takode read ${safeSessionRef} ${p.msg_index}`);
      }
      if (p.suggestedAnswers?.length) {
        console.log(`Suggestions: ${p.suggestedAnswers.map((answer) => formatInlineText(answer)).join(", ")}`);
      }
      console.log(`Answer: takode answer ${safeSessionRef}${targetHint} <response>`);
    } else if (p.tool_name === "AskUserQuestion" && p.questions) {
      for (const q of p.questions) {
        console.log(`\n[AskUserQuestion]${msgRef} ${formatInlineText(q.question)}`);
        if (q.options) {
          for (let i = 0; i < q.options.length; i++) {
            const opt = q.options[i];
            console.log(
              `  ${i + 1}. ${formatInlineText(opt.label)}${opt.description ? ` -- ${formatInlineText(opt.description)}` : ""}`,
            );
          }
        }
        if (msgRef) {
          console.log(`\nFull message: takode read ${safeSessionRef} ${p.msg_index}`);
        }
        console.log(`Answer: takode answer ${safeSessionRef}${targetHint} <option-number-or-text>`);
      }
    } else if (p.tool_name === "ExitPlanMode") {
      const planPreview = typeof p.plan === "string" ? p.plan.slice(0, TAKODE_PEEK_CONTENT_LIMIT) : "(no plan text)";
      console.log(`\n[ExitPlanMode]${msgRef} Plan approval requested`);
      console.log(formatInlineText(planPreview));
      if (typeof p.plan === "string" && p.plan.length > 500) {
        console.log("  ...(truncated)");
      }
      if (msgRef) {
        console.log(`\nFull plan: takode read ${safeSessionRef} ${p.msg_index}`);
      }
      console.log(`Approve: takode answer ${safeSessionRef}${targetHint} approve`);
      console.log(`Reject:  takode answer ${safeSessionRef}${targetHint} reject 'feedback here'`);
    }
  }
}

async function handleAnswer(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const targetId = typeof flags.target === "string" ? flags.target.trim() : "";
  const msgIndexRaw = typeof flags.message === "string" ? flags.message.trim() : "";
  const msgIndex = msgIndexRaw ? Number.parseInt(msgIndexRaw, 10) : undefined;
  if (msgIndexRaw && !Number.isInteger(msgIndex)) {
    err("Usage: takode answer <session> [--message <msg-id> | --target <id>] <response> [--json]");
  }
  if (!sessionRef || sessionRef.startsWith("--")) {
    err("Usage: takode answer <session> [--message <msg-id> | --target <id>] <response> [--json]");
  }
  const responseParts: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (arg === "--message" || arg === "--target") {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    responseParts.push(arg);
  }
  const response = responseParts.join(" ");

  if (!response) err("Usage: takode answer <session> [--message <msg-id> | --target <id>] <response> [--json]");

  const mySessionId = getCallerSessionId();

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/answer`, {
    response,
    callerSessionId: mySessionId,
    ...(targetId ? { targetId } : {}),
    ...(msgIndex !== undefined ? { msgIndex } : {}),
  })) as {
    ok: boolean;
    kind?: "permission" | "notification";
    tool_name: string;
    answer?: string;
    action?: string;
    feedback?: string;
    error?: string;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.kind === "notification" || result.tool_name === "takode.notify") {
    console.log(`[${formatTime(Date.now())}] \u2713 Answered needs-input prompt: "${formatInlineText(result.answer)}"`);
  } else if (result.tool_name === "AskUserQuestion") {
    console.log(`[${formatTime(Date.now())}] \u2713 Answered: "${formatInlineText(result.answer)}"`);
  } else if (result.tool_name === "ExitPlanMode") {
    if (result.action === "approved") {
      console.log(`[${formatTime(Date.now())}] \u2713 Plan approved`);
    } else {
      console.log(`[${formatTime(Date.now())}] \u2717 Plan rejected: ${formatInlineText(result.feedback)}`);
    }
  }
}

// ─── Search handler ──────────────────────────────────────────────────────────

async function handleSearch(base: string, args: string[]): Promise<void> {
  const query = args
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (!query) err("Usage: takode search <query> [--all] [--json]");

  const flags = parseFlags(args);
  const showAll = flags.all === true;
  const jsonMode = flags.json === true;

  const sessions = (await apiGet(base, "/takode/sessions")) as Array<{
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
  const searchResp = (await apiGet(base, `/sessions/search?${params.toString()}`)) as {
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
    const snippet =
      match.messageMatch?.snippet?.trim() ||
      snippetFromContext(match.matchContext) ||
      (match.matchedField === "name" ? fallbackName : "");
    const matchReason = match.matchContext || `${fieldLabel(match.matchedField)} match`;
    const messageId = match.matchedField === "user_message" ? match.messageMatch?.id || null : null;
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
    console.log(
      JSON.stringify(
        results.map((r) => ({
          ...r.session,
          matchedField: r.match.matchedField,
          matchReason: r.matchReason,
          matchContext: r.match.matchContext,
          snippet: r.snippet,
          messageId: r.messageId,
          matchedAt: r.match.matchedAt,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (results.length === 0) {
    console.log(`No sessions matching "${formatInlineText(query)}".`);
    return;
  }

  console.log(`${results.length} session(s) matching "${formatInlineText(query)}":`);
  console.log("");

  for (const row of results) {
    const s = row.session;
    const num = s.sessionNum !== undefined ? `#${s.sessionNum}` : "  ";
    const name = formatInlineText(s.name || "(unnamed)");
    const status = s.cliConnected ? (s.state === "running" ? "●" : "○") : s.archived ? "⊘" : "✗";
    const activity = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : "";
    const sessionRef = s.sessionNum != null ? String(s.sessionNum) : s.sessionId;

    console.log(`  ${num.padEnd(5)} ${status} ${name}`);
    console.log(
      `        field: ${formatInlineText(row.matchedFieldLabel)}  reason: ${formatInlineText(row.matchReason)}`,
    );
    if (row.snippet) {
      console.log(`        snippet: ${truncate(row.snippet, TAKODE_PEEK_CONTENT_LIMIT)}`);
    }
    if (row.messageId) {
      const messageId = formatInlineText(row.messageId);
      console.log(`        message id: ${messageId} (takode peek ${sessionRef} --from ${messageId})`);
    }
    if (activity) {
      console.log(`        activity: ${activity}`);
    }
    console.log("");
  }
}

// ─── Branch management commands ──────────────────────────────────────────────

async function handleSetBase(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode set-base <session> <branch> [--json]");
  const branch = args[1];
  if (branch === undefined) err("Usage: takode set-base <session> <branch> [--json]");

  const flags = parseFlags(args.slice(2));
  const jsonMode = flags.json === true;

  const result = (await apiPatch(base, `/sessions/${encodeURIComponent(sessionRef)}/diff-base`, { branch })) as {
    ok: boolean;
    diff_base_branch: string;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Diff base set to: ${result.diff_base_branch || "(default)"}`);
}

function parseNotifyCreateArgs(args: string[]): {
  jsonMode: boolean;
  summary: string | undefined;
  suggestedAnswers: string[];
} {
  let jsonMode = false;
  const suggestedAnswers: string[] = [];
  const summaryParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      jsonMode = true;
      continue;
    }
    if (arg === "--suggest") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        err("Usage: takode notify needs-input <summary> --suggest <answer> [--suggest <answer>]...");
      }
      suggestedAnswers.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      err(`Unknown notify option: ${arg}`);
    }
    summaryParts.push(arg);
  }

  return {
    jsonMode,
    summary: summaryParts.length > 0 ? summaryParts.join(" ") : undefined,
    suggestedAnswers,
  };
}

async function handleNotify(base: string, args: string[]): Promise<void> {
  const subcommand = args[0];
  const selfId = getCallerSessionId();

  if (subcommand === "list") {
    const flags = parseFlags(args.slice(1));
    const jsonMode = flags.json === true;
    const result = (await apiGet(base, `/sessions/${encodeURIComponent(selfId)}/notifications/needs-input/self`)) as {
      notifications: Array<{
        notificationId: number;
        rawNotificationId: string;
        summary?: string;
        suggestedAnswers?: string[];
        timestamp: number;
        messageId: string | null;
      }>;
      resolvedCount: number;
    };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.notifications.length === 0) {
      console.log(`No unresolved same-session needs-input notifications. Resolved: ${result.resolvedCount}.`);
      return;
    }
    console.log(
      `Unresolved same-session needs-input notifications: ${result.notifications.length}. Resolved: ${result.resolvedCount}.`,
    );
    for (const notification of result.notifications) {
      const summary = notification.summary?.trim() || "(no summary)";
      console.log(`  ${notification.notificationId}. ${formatInlineText(summary)}`);
      if (notification.suggestedAnswers?.length) {
        console.log(
          `     suggestions: ${notification.suggestedAnswers.map((answer) => formatInlineText(answer)).join(", ")}`,
        );
      }
    }
    return;
  }

  if (subcommand === "resolve") {
    const notificationArg = args.slice(1).find((arg) => !arg.startsWith("--"));
    if (!notificationArg) err("Usage: takode notify resolve <notification-id> [--json]");
    const notificationId = Number.parseInt(notificationArg, 10);
    if (!Number.isInteger(notificationId) || notificationId <= 0) {
      err("Usage: takode notify resolve <notification-id> [--json]");
    }
    const flags = parseFlags(args.slice(1));
    const jsonMode = flags.json === true;
    const result = (await apiPost(
      base,
      `/sessions/${encodeURIComponent(selfId)}/notifications/needs-input/${notificationId}/resolve`,
      {},
    )) as {
      ok: boolean;
      notificationId: number;
      rawNotificationId: string;
      changed: boolean;
    };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.changed) {
      console.log(`Resolved needs-input notification ${result.notificationId}.`);
    } else {
      console.log(`Needs-input notification ${result.notificationId} was already resolved.`);
    }
    return;
  }

  const category = subcommand;
  if (!category || (category !== "needs-input" && category !== "review")) {
    err(`${NOTIFY_HELP.trim()}\n`);
  }
  const parsed = parseNotifyCreateArgs(args.slice(1));
  const summary = parsed.summary;
  if (!summary) {
    err("Usage: takode notify <category> <summary>\nSummary is required -- describe what needs attention.");
  }
  const payload: Record<string, unknown> = { category };
  if (summary) payload.summary = summary;
  if (parsed.suggestedAnswers.length > 0) payload.suggestedAnswers = parsed.suggestedAnswers;
  const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/notify`, payload)) as {
    ok: boolean;
    category: string;
    anchoredMessageId: string | null;
    notificationId: number | null;
    rawNotificationId: string;
    suggestedAnswers?: string[];
  };
  if (parsed.jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const notificationLabel =
    typeof result.notificationId === "number"
      ? String(result.notificationId)
      : formatInlineText(result.rawNotificationId);
  console.log(`Notification sent (${category}, id ${notificationLabel})`);
}

async function handlePhases(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 0) err(PHASES_HELP.trim());

  const result = (await apiGet(base, "/takode/quest-journey-phases")) as {
    phases: QuestJourneyPhaseCatalogEntry[];
  };

  if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Quest Journey phases (${result.phases.length}):`);
  for (const phase of result.phases) {
    const aliases = phase.aliases.length > 0 ? ` aliases: ${phase.aliases.join(", ")}` : "";
    console.log(`\n${phase.id} -- ${phase.label} [${phase.sourceType}]`);
    console.log(`  role: ${phase.assigneeRole}  board: ${phase.boardState}${aliases}`);
    console.log(`  contract: ${formatInlineText(phase.contract)}`);
    console.log(`  assignee brief: ${phase.assigneeBriefDisplayPath}`);
    console.log(`  leader brief: ${phase.leaderBriefDisplayPath}`);
    console.log(`  phase metadata: ${phase.phaseJsonDisplayPath}`);
  }
}

// ─── Board ─────────────────────────────────────────────────────────────────

import {
  FREE_WORKER_WAIT_FOR_TOKEN,
  formatWaitForRefLabel,
  type BoardQueueWarning,
  getInvalidQuestJourneyPhaseIds,
  getQuestJourneyCurrentPhaseIndex,
  getQuestJourneyPhase,
  normalizeQuestJourneyPhaseIds,
  QUEST_JOURNEY_STATES,
  QUEST_JOURNEY_HINTS,
  getWaitForRefKind,
  isValidQuestId,
  isValidWaitForRef,
  type QuestJourneyPhaseNoteRebaseWarning,
  type QuestJourneyPlanState,
} from "../shared/quest-journey.ts";

interface BoardRow {
  questId: string;
  title?: string;
  worker?: string;
  workerNum?: number;
  journey?: QuestJourneyPlanState;
  status?: string;
  waitFor?: string[];
  waitForInput?: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

interface BoardParticipantStatus {
  sessionId: string;
  sessionNum?: number | null;
  name?: string;
  status: "running" | "idle" | "disconnected" | "archived";
}

interface BoardRowSessionStatus {
  worker?: BoardParticipantStatus;
  reviewer?: BoardParticipantStatus | null;
}

interface BoardProposalReviewPayload {
  questId: string;
  title?: string;
  status: string;
  journey: QuestJourneyPlanState;
  presentedAt: number;
  summary?: string;
  scheduling?: Record<string, unknown>;
}

interface BoardProposalSpecPhase {
  id: string;
  note?: string;
}

interface BoardProposalSpec {
  title?: string;
  presetId?: string;
  phases: BoardProposalSpecPhase[];
  revisionReason?: string;
  presentation?: {
    summary?: string;
    scheduling?: Record<string, unknown>;
  };
}

function normalizeBoardWaitForInputNotificationId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numericId = Number.parseInt(trimmed, 10);
    return numericId > 0 ? `n-${numericId}` : null;
  }
  const match = /^n-(\d+)$/i.exec(trimmed);
  if (!match) return null;
  const numericId = Number.parseInt(match[1], 10);
  return numericId > 0 ? `n-${numericId}` : null;
}

function formatBoardWaitForInputNotificationLabel(notificationId: string): string {
  const match = /^n-(\d+)$/i.exec(notificationId.trim());
  return match ? match[1] : notificationId;
}

function formatBoardWaitForInputNotificationList(notificationIds: string[]): string {
  return notificationIds.map((notificationId) => formatBoardWaitForInputNotificationLabel(notificationId)).join(", ");
}

function normalizeBoardProposalSpec(raw: unknown): BoardProposalSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    err("Proposal spec must be a JSON object.");
  }
  const spec = raw as Record<string, unknown>;
  const rawPhases = spec.phases ?? spec.phaseIds;
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    err("Proposal spec requires a non-empty phases array.");
  }

  const phases = rawPhases.map((entry, index): BoardProposalSpecPhase => {
    if (typeof entry === "string") return { id: entry };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      err(`Proposal spec phase ${index + 1} must be a string phase id or an object with id/note.`);
    }
    const phase = entry as Record<string, unknown>;
    if (typeof phase.id !== "string" || !phase.id.trim()) {
      err(`Proposal spec phase ${index + 1} requires a non-empty id.`);
    }
    if (phase.note !== undefined && typeof phase.note !== "string") {
      err(`Proposal spec phase ${index + 1} note must be a string when provided.`);
    }
    return {
      id: phase.id.trim(),
      ...(typeof phase.note === "string" && phase.note.trim() ? { note: phase.note.trim() } : {}),
    };
  });

  const invalid = getInvalidQuestJourneyPhaseIds(phases.map((phase) => phase.id));
  if (invalid.length > 0) {
    err(`Invalid Quest Journey phase(s) in proposal spec: ${invalid.join(", ")}`);
  }

  const presentation =
    spec.presentation && typeof spec.presentation === "object" && !Array.isArray(spec.presentation)
      ? (spec.presentation as Record<string, unknown>)
      : undefined;
  const scheduling =
    presentation?.scheduling && typeof presentation.scheduling === "object" && !Array.isArray(presentation.scheduling)
      ? { ...(presentation.scheduling as Record<string, unknown>) }
      : undefined;

  return {
    phases,
    ...(typeof spec.title === "string" && spec.title.trim() ? { title: spec.title.trim() } : {}),
    ...(typeof spec.presetId === "string" && spec.presetId.trim() ? { presetId: spec.presetId.trim() } : {}),
    ...(typeof spec.revisionReason === "string" && spec.revisionReason.trim()
      ? { revisionReason: spec.revisionReason.trim() }
      : {}),
    ...(presentation
      ? {
          presentation: {
            ...(typeof presentation.summary === "string" && presentation.summary.trim()
              ? { summary: presentation.summary.trim() }
              : {}),
            ...(scheduling ? { scheduling } : {}),
          },
        }
      : {}),
  };
}

async function readBoardProposalSpec(pathOrDash: string): Promise<BoardProposalSpec> {
  const raw = await readOptionTextFile(pathOrDash, "--spec-file");
  try {
    return normalizeBoardProposalSpec(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) {
      err(`Cannot parse --spec-file JSON: ${error.message}`);
    }
    throw error;
  }
}

function formatBoardParticipantStatus(
  participant: BoardParticipantStatus | undefined,
  fallbackNum?: number,
  opts?: { empty?: string },
): string {
  if (participant) return `#${participant.sessionNum ?? fallbackNum ?? "?"} ${participant.status}`;
  if (fallbackNum !== undefined) return `#${fallbackNum} unknown`;
  return opts?.empty ?? "--";
}

function formatBoardWorkerReviewerSummary(row: BoardRow, rowStatus: BoardRowSessionStatus | undefined): string {
  if (!row.worker && row.workerNum === undefined) return "--";
  const worker = formatBoardParticipantStatus(rowStatus?.worker, row.workerNum);
  const reviewer = rowStatus?.reviewer
    ? formatBoardParticipantStatus(rowStatus.reviewer, rowStatus.reviewer.sessionNum ?? undefined)
    : "no reviewer";
  return `${worker} / ${reviewer}`;
}

function formatBoardQueueWarnings(queueWarnings: BoardQueueWarning[] | undefined): string[] {
  if (!queueWarnings || queueWarnings.length === 0) return [];
  return queueWarnings.map((warning) =>
    warning.action ? `- ${warning.summary} Next: ${warning.action}` : `- ${warning.summary}`,
  );
}

function formatBoardPhaseNoteRebaseWarnings(warnings: QuestJourneyPhaseNoteRebaseWarning[] | undefined): string[] {
  if (!warnings || warnings.length === 0) return [];
  return warnings.map((warning) => {
    const phaseLabel = getQuestJourneyPhase(warning.previousPhaseId)?.label ?? warning.previousPhaseId;
    return `- note[${warning.previousIndex + 1}] ${phaseLabel} occurrence ${warning.previousOccurrence} was dropped during revision: ${warning.note}`;
  });
}

function formatBoardPhaseNoteLines(row: BoardRow): string[] {
  const entries = Object.entries(row.journey?.phaseNotes ?? {})
    .map(([rawIndex, note]) => {
      const index = Number.parseInt(rawIndex, 10);
      if (!Number.isInteger(index) || index < 0) return null;
      const phaseId = row.journey?.phaseIds?.[index];
      const phaseLabel = getQuestJourneyPhase(phaseId)?.label ?? phaseId ?? "Unknown";
      return `note[${index + 1}] ${phaseLabel}: ${note}`;
    })
    .filter((line): line is string => line !== null);
  return entries;
}

function formatBoardJourneyPathLine(row: BoardRow): string | null {
  const phaseIds = row.journey?.phaseIds ?? [];
  if (phaseIds.length === 0) return null;
  const currentIndex = getQuestJourneyCurrentPhaseIndex(row.journey, row.status);
  const segments = phaseIds.map((phaseId, index) => {
    const phaseLabel = getQuestJourneyPhase(phaseId)?.label ?? phaseId;
    const segment = `${index + 1}. ${phaseLabel}`;
    return currentIndex === index ? `[${segment}]` : segment;
  });
  return `journey: ${segments.join(" -> ")}`;
}

/** Format board output as JSON with a marker for frontend detection. */
function formatBoardOutput(
  board: BoardRow[],
  opts?: {
    operation?: string;
    completedCount?: number;
    completedBoard?: BoardRow[];
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
    queueWarnings?: BoardQueueWarning[];
    phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
    proposalReview?: BoardProposalReviewPayload;
    workerSlotUsage?: { used: number; limit: number };
  },
): string {
  const {
    operation,
    completedCount,
    completedBoard,
    rowSessionStatuses,
    queueWarnings,
    phaseNoteRebaseWarnings,
    proposalReview,
    workerSlotUsage,
  } = opts ?? {};
  return JSON.stringify(
    {
      __takode_board__: true,
      board,
      ...(rowSessionStatuses ? { rowSessionStatuses } : {}),
      ...(queueWarnings ? { queueWarnings } : {}),
      ...(phaseNoteRebaseWarnings ? { phaseNoteRebaseWarnings } : {}),
      ...(proposalReview ? { proposalReview } : {}),
      ...(workerSlotUsage ? { workerSlotUsage } : {}),
      ...(operation ? { operation } : {}),
      ...(completedCount != null ? { completedCount } : {}),
      ...(completedBoard ? { completedBoard } : {}),
    },
    null,
    2,
  );
}

/** Print board in a human-readable table with Quest Journey state and next-action hints. */
function printBoardText(
  board: BoardRow[],
  opts?: {
    allBoardRows?: BoardRow[];
    resolvedSessionDeps?: Set<string>;
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
    queueWarnings?: BoardQueueWarning[];
    workerSlotUsage?: { used: number; limit: number };
  },
): void {
  if (board.length === 0) {
    console.log("Board is empty.");
    return;
  }

  // Build a set of active quest IDs on the board (for resolving wait-for status)
  const { allBoardRows, resolvedSessionDeps, rowSessionStatuses, queueWarnings, workerSlotUsage } = opts ?? {};
  const activeQuestIds = new Set((allBoardRows || board).map((r) => r.questId));
  const dispatchableQuestIds = new Set(
    (queueWarnings ?? []).filter((warning) => warning.kind === "dispatchable").map((warning) => warning.questId),
  );

  console.log("");
  const qCol = 8;
  const tCol = 20;
  const ownerCol = 30;
  const sCol = 18;
  const waitCol = 16;
  console.log(
    `${"QUEST".padEnd(qCol)} ${"TITLE".padEnd(tCol)} ${"WORKER / REVIEWER".padEnd(ownerCol)} ${"STATE".padEnd(sCol)} ${"WAIT-FOR".padEnd(waitCol)} ACTION`,
  );
  console.log("-".repeat(qCol + tCol + ownerCol + sCol + waitCol + 22));

  for (const row of board) {
    const quest = row.questId.padEnd(qCol);
    // Truncate to (tCol - 3) to leave room for the "…" character and column padding
    const titleStr = row.title ? (row.title.length > tCol - 2 ? row.title.slice(0, tCol - 3) + "…" : row.title) : "--";
    const title = titleStr.padEnd(tCol);
    const rowStatus = rowSessionStatuses?.[row.questId];
    const ownerStr = formatBoardWorkerReviewerSummary(row, rowStatus);
    const owner = ownerStr.slice(0, ownerCol - 1).padEnd(ownerCol);
    const state = (row.status || "--").padEnd(sCol);
    const isQueuedRow = (row.status || "").trim().toUpperCase() === "QUEUED";

    // Wait-for column: distinguish input waits, queue deps, and ready states
    const linkedInputWaits = row.waitForInput || [];
    const allDeps = row.waitFor || [];
    const blockedDeps = allDeps.filter((wf) => {
      const kind = getWaitForRefKind(wf);
      if (kind === "session") return !resolvedSessionDeps?.has(wf);
      if (kind === "quest") return activeQuestIds.has(wf);
      if (kind === "free-worker")
        return (workerSlotUsage?.used ?? workerSlotUsage?.limit ?? 0) >= (workerSlotUsage?.limit ?? 0);
      return true;
    });
    let waitForStr: string;
    if (!isQueuedRow && linkedInputWaits.length > 0) {
      waitForStr = `input ${formatBoardWaitForInputNotificationList(linkedInputWaits)}`;
    } else if (isQueuedRow && dispatchableQuestIds.has(row.questId)) {
      waitForStr = "ready";
    } else if (isQueuedRow && blockedDeps.length > 0) {
      waitForStr = `wait ${blockedDeps.map((dep) => formatWaitForRefLabel(dep)).join(", ")}`;
    } else {
      waitForStr = "--";
    }
    const waitForDisplay = waitForStr.slice(0, waitCol - 1).padEnd(waitCol);

    // Next action hint: if blocked, show "blocked"; otherwise show state hint
    let nextAction: string;
    if (!isQueuedRow && linkedInputWaits.length > 0) {
      nextAction = `wait for user input (${formatBoardWaitForInputNotificationList(linkedInputWaits)})`;
    } else if (isQueuedRow && dispatchableQuestIds.has(row.questId)) {
      nextAction = "dispatch now";
    } else if (isQueuedRow && blockedDeps.length > 0) {
      nextAction = `wait for ${blockedDeps.map((dep) => formatWaitForRefLabel(dep)).join(", ")}`;
    } else {
      nextAction = row.journey?.nextLeaderAction ?? (QUEST_JOURNEY_HINTS[row.status || ""] || "--");
      if (row.journey?.revisionReason) {
        nextAction = `revised: ${row.journey.revisionReason}; ${nextAction}`;
      }
    }

    console.log(`${quest} ${title} ${owner} ${state} ${waitForDisplay} ${nextAction}`);
    const journeyPathLine = formatBoardJourneyPathLine(row);
    if (journeyPathLine) {
      console.log(
        `${"".padEnd(qCol)} ${"".padEnd(tCol)} ${"".padEnd(ownerCol)} ${"".padEnd(sCol)} ${"".padEnd(waitCol)} ${journeyPathLine}`,
      );
    }
    for (const noteLine of formatBoardPhaseNoteLines(row)) {
      console.log(
        `${"".padEnd(qCol)} ${"".padEnd(tCol)} ${"".padEnd(ownerCol)} ${"".padEnd(sCol)} ${"".padEnd(waitCol)} ${noteLine}`,
      );
    }
  }
  console.log("");
}

/** Output board as JSON in `--json` mode, otherwise as human-readable text. */
function outputBoard(
  board: BoardRow[],
  jsonMode: boolean,
  opts?: {
    operation?: string;
    resolvedSessionDeps?: Set<string>;
    completedCount?: number;
    completedBoard?: BoardRow[];
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
    queueWarnings?: BoardQueueWarning[];
    phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
    proposalReview?: BoardProposalReviewPayload;
    workerSlotUsage?: { used: number; limit: number };
  },
): void {
  const {
    operation,
    resolvedSessionDeps,
    completedCount,
    completedBoard,
    rowSessionStatuses,
    queueWarnings,
    phaseNoteRebaseWarnings,
    proposalReview,
    workerSlotUsage,
  } = opts ?? {};
  if (jsonMode) {
    console.log(
      formatBoardOutput(board, {
        operation,
        completedCount,
        completedBoard,
        rowSessionStatuses,
        queueWarnings,
        phaseNoteRebaseWarnings,
        proposalReview,
        workerSlotUsage,
      }),
    );
    return;
  }

  printBoardText(board, {
    allBoardRows: board,
    resolvedSessionDeps,
    rowSessionStatuses,
    queueWarnings,
    workerSlotUsage,
  });
  // Print completed items table when --all flag includes them
  if (completedBoard && completedBoard.length > 0) {
    console.log("── Completed ──────────────────────────────────────────");
    printBoardText(completedBoard, { rowSessionStatuses, queueWarnings, workerSlotUsage });
  }
  // Always show a footer count when completed items exist
  if (completedCount && completedCount > 0 && !completedBoard) {
    console.log(`${completedCount} quest${completedCount === 1 ? "" : "s"} completed`);
  }
  for (const line of formatBoardPhaseNoteRebaseWarnings(phaseNoteRebaseWarnings)) {
    console.log(line);
  }
  for (const line of formatBoardQueueWarnings(queueWarnings)) {
    console.log(line);
  }
}

async function handleBoard(base: string, args: string[]): Promise<void> {
  const selfId = getCallerSessionId();
  const sub = args[0];

  // No subcommand or "show": display board
  if (!sub || sub === "show" || sub.startsWith("--")) {
    const flags = parseFlags(sub === "show" ? args.slice(1) : args);
    const includeCompleted = flags.all === true;
    const queryParams = `resolve=true${includeCompleted ? "&include_completed=true" : ""}`;
    const result = (await apiGet(base, `/sessions/${encodeURIComponent(selfId)}/board?${queryParams}`)) as {
      board: BoardRow[];
      completedCount?: number;
      completedBoard?: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    const resolvedSessionDeps = new Set(result.resolvedSessionDeps ?? []);
    outputBoard(result.board, flags.json === true, {
      resolvedSessionDeps,
      completedCount: result.completedCount,
      completedBoard: includeCompleted ? result.completedBoard : undefined,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "add" || sub === "set" || sub === "propose" || sub === "promote") {
    const questId = args[1];
    const usageBySub =
      sub === "propose"
        ? `Usage: takode board propose <quest-id> [--title "..."] [--phases <ids> | --spec-file <path|->] [--preset <id>] [--revise-reason <text>] [--wait-for-input <id,id...> | --clear-wait-for-input] [--json]`
        : sub === "promote"
          ? `Usage: takode board promote <quest-id> [--worker <session>] [--status <state>] [--active-phase-position <n>] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--force-promote-unpresented] [--json]`
          : `Usage: takode board ${sub} <quest-id> [--worker <session>] [--status "..."] [--active-phase-position <n>] [--title "..."] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--phases <ids>] [--preset <id>] [--revise-reason <text>] [--json]`;
    if (!questId) err(usageBySub);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));
    const isProposalCommand = sub === "propose";
    const isPromoteCommand = sub === "promote";
    const activePhasePosition = parseIntegerFlag(flags, "active-phase-position", "active phase position");
    if (flags["no-code"] === true || flags["code-change"] === true) {
      err(
        "Board no-code flags were removed. Model zero-tracked-change work with an explicit phase plan that omits `port`.",
      );
    }

    const body: Record<string, unknown> = { questId };
    if (isProposalCommand) body.journeyMode = "proposed";
    if (isPromoteCommand) body.journeyMode = "active";
    if (isPromoteCommand && flags["force-promote-unpresented"] === true) {
      body.forcePromoteUnpresented = true;
    }
    if (activePhasePosition !== undefined) {
      if (activePhasePosition <= 0) err("--active-phase-position must be a positive integer.");
      if (isProposalCommand) {
        err("Proposed Journey rows cannot set an active phase position. Promote the row first.");
      }
      body.activePhaseIndex = activePhasePosition - 1;
    }
    if (typeof flags.status === "string") body.status = flags.status;
    if (typeof flags.title === "string") body.title = flags.title;
    if (flags["spec-file"] === true) err("--spec-file requires a path or '-' for stdin.");
    if (typeof flags["spec-file"] === "string") {
      if (!isProposalCommand) err("Use --spec-file only with `takode board propose`.");
      if (typeof flags.phases === "string") err("Use either --spec-file or --phases, not both.");
      const spec = await readBoardProposalSpec(flags["spec-file"]);
      body.phases = normalizeQuestJourneyPhaseIds(spec.phases.map((phase) => phase.id));
      body.phaseNoteEdits = spec.phases.map((phase, index) => ({ index, note: phase.note ?? null }));
      if (spec.title && !("title" in body)) body.title = spec.title;
      if (typeof flags.preset === "string" && flags.preset.trim()) body.presetId = flags.preset.trim();
      else if (spec.presetId) body.presetId = spec.presetId;
      else body.presetId = "custom";
      if (spec.revisionReason) body.revisionReason = spec.revisionReason;
      if (spec.presentation) body.presentation = spec.presentation;
    } else if (typeof flags.phases === "string") {
      if (isPromoteCommand) {
        err(
          "`takode board promote` reuses the existing Journey. Revise it first with `takode board propose` or `takode board set`.",
        );
      }
      const phases = flags.phases
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (phases.length === 0) {
        err("Invalid Quest Journey phases: provide at least one phase ID.");
      }
      const invalid = getInvalidQuestJourneyPhaseIds(phases);
      if (invalid.length > 0) {
        err(
          `Invalid Quest Journey phase(s): ${invalid.join(", ")} -- use planning, explore, implement, code-review, mental-simulation, execute, outcome-review, bookkeeping, or port`,
        );
      }
      body.phases = normalizeQuestJourneyPhaseIds(phases);
      if (typeof flags.preset === "string" && flags.preset.trim()) {
        body.presetId = flags.preset.trim();
      }
    } else if (typeof flags.preset === "string") {
      err("Use --preset only with --phases so the planned Quest Journey is explicit.");
    } else if (isProposalCommand) {
      err("Use --phases or --spec-file with `takode board propose` so the proposed Journey is explicit.");
    }
    if (typeof flags["revise-reason"] === "string") {
      if (!("phases" in body)) {
        err("Use --revise-reason only with --phases so the Journey revision is explicit.");
      }
      body.revisionReason = flags["revise-reason"];
    }
    if (typeof flags["wait-for"] === "string") {
      if (isProposalCommand) {
        err(
          "Proposed Journey rows do not use --wait-for. Use --wait-for-input when the proposal is waiting on approval.",
        );
      }
      const waitFor = flags["wait-for"]
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      const invalid = waitFor.filter((ref) => !isValidWaitForRef(ref));
      if (invalid.length > 0)
        err(
          `Invalid wait-for value(s): ${invalid.join(", ")} -- use q-N for quests, #N for sessions, or ${FREE_WORKER_WAIT_FOR_TOKEN}`,
        );
      body.waitFor = waitFor;
    }
    if (flags["clear-wait-for-input"] === true && typeof flags["wait-for-input"] === "string") {
      err("Use either --wait-for-input or --clear-wait-for-input, not both.");
    }
    if (typeof flags["wait-for"] === "string" && typeof flags["wait-for-input"] === "string") {
      err("Invalid board update: --wait-for and --wait-for-input cannot be combined on the same row.");
    }
    let explicitStatus = typeof flags.status === "string" ? flags.status.trim().toUpperCase() : null;
    if (isProposalCommand) {
      body.status = "PROPOSED";
      explicitStatus = "PROPOSED";
    } else if (isPromoteCommand && typeof flags["wait-for"] === "string" && !explicitStatus) {
      body.status = "QUEUED";
      explicitStatus = "QUEUED";
    }
    if (typeof flags["wait-for"] === "string" && explicitStatus && explicitStatus !== "QUEUED") {
      err("Invalid board update: --wait-for is only valid on QUEUED rows.");
    }
    if (typeof flags["wait-for-input"] === "string" && explicitStatus === "QUEUED") {
      err("Invalid board update: --wait-for-input is only valid on active rows.");
    }
    if (typeof flags["wait-for-input"] === "string") {
      const rawIds = flags["wait-for-input"]
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (rawIds.length === 0) {
        err("Invalid wait-for-input value: provide one or more notification IDs like 3 or n-3.");
      }
      const normalizedIds = rawIds.map((notificationId) => ({
        notificationId,
        normalized: normalizeBoardWaitForInputNotificationId(notificationId),
      }));
      const invalid = normalizedIds.filter((entry) => entry.normalized === null).map((entry) => entry.notificationId);
      if (invalid.length > 0) {
        err(`Invalid wait-for-input value(s): ${invalid.join(", ")} -- use needs-input notification IDs like 3 or n-3`);
      }
      body.waitForInput = [...new Set(normalizedIds.map((entry) => entry.normalized!))];
    }
    if (flags["clear-wait-for-input"] === true) {
      body.clearWaitForInput = true;
    } else if (isPromoteCommand && typeof flags["wait-for-input"] !== "string") {
      body.clearWaitForInput = true;
    }
    if (typeof flags.worker === "string") {
      if (isProposalCommand) {
        err("Proposed Journey rows cannot be assigned to a worker yet. Promote the row first.");
      }
      const workerRef = flags.worker;
      if (!workerRef) {
        // Empty string means "clear worker assignment"
        body.worker = "";
        body.workerNum = null;
      } else {
        // Resolve worker ref -- use the info endpoint to get session ID and num
        try {
          const info = (await apiGet(base, `/sessions/${encodeURIComponent(workerRef)}/info`)) as {
            sessionId: string;
            sessionNum: number;
          };
          body.worker = info.sessionId;
          body.workerNum = info.sessionNum;
        } catch {
          // Fallback: store the ref as-is
          body.worker = workerRef;
        }
      }
      // When changing the worker (reassigning or clearing), clear stale waitFor
      // dependencies unless the user explicitly provided --wait-for in the same command
      if (!("waitFor" in body)) {
        body.waitFor = [];
      }
    }

    const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/board`, body)) as {
      board: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    const resolved = new Set(result.resolvedSessionDeps ?? []);
    outputBoard(result.board, flags.json === true, {
      operation: `${sub} ${questId}`,
      resolvedSessionDeps: resolved,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      phaseNoteRebaseWarnings: result.phaseNoteRebaseWarnings,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "present") {
    const questId = args[1];
    const usage =
      "Usage: takode board present <quest-id> [--summary <text>] [--wait-for-input <id,id...> | --clear-wait-for-input] [--json]";
    if (!questId) err(usage);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));
    if (flags["clear-wait-for-input"] === true && typeof flags["wait-for-input"] === "string") {
      err("Use either --wait-for-input or --clear-wait-for-input, not both.");
    }
    const body: Record<string, unknown> = {
      questId,
      presentProposal: true,
    };
    if (typeof flags.summary === "string" && flags.summary.trim()) {
      body.presentation = { summary: flags.summary.trim() };
    }
    if (typeof flags["wait-for-input"] === "string") {
      const rawIds = flags["wait-for-input"]
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (rawIds.length === 0) {
        err("Invalid wait-for-input value: provide one or more notification IDs like 3 or n-3.");
      }
      const normalizedIds = rawIds.map((notificationId) => ({
        notificationId,
        normalized: normalizeBoardWaitForInputNotificationId(notificationId),
      }));
      const invalid = normalizedIds.filter((entry) => entry.normalized === null).map((entry) => entry.notificationId);
      if (invalid.length > 0) {
        err(`Invalid wait-for-input value(s): ${invalid.join(", ")} -- use needs-input notification IDs like 3 or n-3`);
      }
      body.waitForInput = [...new Set(normalizedIds.map((entry) => entry.normalized!))];
    }
    if (flags["clear-wait-for-input"] === true) {
      body.clearWaitForInput = true;
    }

    const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/board`, body)) as {
      board: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      proposalReview?: BoardProposalReviewPayload;
      workerSlotUsage?: { used: number; limit: number };
    };
    const resolved = new Set(result.resolvedSessionDeps ?? []);
    outputBoard(result.board, true, {
      operation: `present ${questId}`,
      resolvedSessionDeps: resolved,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      proposalReview: result.proposalReview,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "note") {
    const questId = args[1];
    const usage = "Usage: takode board note <quest-id> <phase-position> [--text <text> | --clear] [--json]";
    if (!questId) err(usage);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const phasePositionRaw = args[2];
    if (!phasePositionRaw) err(usage);
    const phasePosition = Number.parseInt(phasePositionRaw, 10);
    if (!Number.isInteger(phasePosition) || phasePosition <= 0) {
      err("Phase position must be a positive integer.");
    }
    const flags = parseFlags(args.slice(3));
    const hasText = typeof flags.text === "string";
    const wantsClear = flags.clear === true;
    if (hasText === wantsClear) {
      err("Use exactly one of --text or --clear.");
    }
    const body: Record<string, unknown> = {
      questId,
      phaseNoteEdits: [
        {
          index: phasePosition - 1,
          note: hasText ? flags.text : null,
        },
      ],
    };
    const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/board`, body)) as {
      board: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    const resolved = new Set(result.resolvedSessionDeps ?? []);
    outputBoard(result.board, flags.json === true, {
      operation: `note ${questId}`,
      resolvedSessionDeps: resolved,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      phaseNoteRebaseWarnings: result.phaseNoteRebaseWarnings,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "advance-no-groom") {
    err(
      "`takode board advance-no-groom` was removed. Use an explicit phase plan that omits `port`, then advance with `takode board advance`.",
    );
  }

  if (sub === "advance") {
    const questId = args[1];
    const usage = "Usage: takode board advance <quest-id> [--json]";
    if (!questId) err(usage);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));

    const result = (await apiPost(
      base,
      `/sessions/${encodeURIComponent(selfId)}/board/${encodeURIComponent(questId)}/${sub}`,
    )) as {
      board: BoardRow[];
      removed: boolean;
      previousState?: string;
      newState?: string;
      skippedStates?: string[];
      completedCount?: number;
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };

    let operation: string;
    if (result.removed) {
      console.log(`${questId}: completed (moved to history)`);
      operation = `completed ${questId}`;
    } else if (result.previousState && result.newState) {
      console.log(`${questId}: ${result.previousState} -> ${result.newState}`);
      operation = `advanced ${questId} to ${result.newState}`;
    } else {
      operation = `advanced ${questId}`;
    }
    const resolved = new Set(result.resolvedSessionDeps ?? []);
    outputBoard(result.board, flags.json === true, {
      operation,
      resolvedSessionDeps: resolved,
      completedCount: result.completedCount,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "rm") {
    const questIds = args.slice(1).filter((a) => !a.startsWith("--"));
    if (questIds.length === 0) err("Usage: takode board rm <quest-id> [<quest-id> ...] [--json]");
    const invalid = questIds.filter((id) => !isValidQuestId(id));
    if (invalid.length > 0)
      err(`Invalid quest ID(s): ${invalid.join(", ")} -- must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(1));

    const result = (await apiDelete(base, `/sessions/${encodeURIComponent(selfId)}/board/${questIds.join(",")}`)) as {
      board: BoardRow[];
      completedCount?: number;
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    const resolved = new Set(result.resolvedSessionDeps ?? []);
    outputBoard(result.board, flags.json === true, {
      operation: `removed ${questIds.join(", ")}`,
      resolvedSessionDeps: resolved,
      completedCount: result.completedCount,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  err(`Unknown board subcommand: ${sub}\nUsage: takode board [show|set|propose|present|promote|note|advance|rm] ...`);
}

async function handleRefreshBranch(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode refresh-branch <session> [--json]");

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/refresh-branch`)) as {
    ok: boolean;
    gitBranch: string | null;
    gitDefaultBranch: string | null;
    diffBaseBranch: string | null;
    gitAhead: number;
    gitBehind: number;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Branch: ${result.gitBranch || "(unknown)"}`);
  if (result.gitDefaultBranch) console.log(`Default: ${result.gitDefaultBranch}`);
  if (result.diffBaseBranch) console.log(`Diff Base: ${result.diffBaseBranch}`);
  const ahead = result.gitAhead ? `${result.gitAhead}↑` : "";
  const behind = result.gitBehind ? `${result.gitBehind}↓` : "";
  const delta = [ahead, behind].filter(Boolean).join(" ");
  if (delta) console.log(`Status: ${delta}`);
}

async function handleBranch(base: string, args: string[]): Promise<void> {
  const subcommand = args[0] || "status";
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "status": {
      const flags = parseFlags(subArgs);
      const jsonMode = flags.json === true;

      const result = (await apiGet(base, `/sessions/self/branch/status`)) as {
        ok: boolean;
        gitBranch: string | null;
        diffBaseBranch: string | null;
        gitDefaultBranch: string | null;
        gitHeadSha: string | null;
        gitAhead: number;
        gitBehind: number;
        totalLinesAdded: number;
        totalLinesRemoved: number;
        isWorktree: boolean;
      };

      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Branch Info:`);
      console.log(`  Current branch: ${result.gitBranch || "(unknown)"}`);
      console.log(`  Base branch:    ${result.diffBaseBranch || "(default)"}`);
      if (result.gitDefaultBranch) console.log(`  Default branch: ${result.gitDefaultBranch}`);
      if (result.gitHeadSha) console.log(`  HEAD SHA:       ${result.gitHeadSha.slice(0, 8)}`);
      const ahead = result.gitAhead || 0;
      const behind = result.gitBehind || 0;
      console.log(`  Ahead:          ${ahead}`);
      console.log(`  Behind:         ${behind}`);
      if (result.totalLinesAdded || result.totalLinesRemoved) {
        console.log(`  Lines added:    +${result.totalLinesAdded || 0}`);
        console.log(`  Lines removed:  -${result.totalLinesRemoved || 0}`);
      }
      if (result.isWorktree) console.log(`  Worktree:       yes`);
      break;
    }
    case "set-base": {
      const branch = subArgs[0];
      if (!branch) err("Usage: takode branch set-base <branch> [--json]");
      const flags = parseFlags(subArgs.slice(1));
      const jsonMode = flags.json === true;

      const result = (await apiPost(base, `/sessions/self/branch/set-base`, { branch })) as {
        ok: boolean;
        diffBaseBranch: string | null;
        gitBranch: string | null;
        gitAhead: number;
        gitBehind: number;
      };

      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Base branch set to: ${result.diffBaseBranch || "(default)"}`);
      const ahead = result.gitAhead ? `${result.gitAhead}↑` : "";
      const behind = result.gitBehind ? `${result.gitBehind}↓` : "";
      const delta = [ahead, behind].filter(Boolean).join(" ");
      if (delta) console.log(`Status: ${delta}`);
      break;
    }
    default:
      err(`Unknown branch subcommand: ${subcommand}. Use 'status' or 'set-base'.`);
  }
}

// ─── Scan handler ────────────────────────────────────────────────────────────

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

async function handleScan(base: string, args: string[]): Promise<void> {
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

async function handleGrep(base: string, args: string[]): Promise<void> {
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

async function handleExport(base: string, args: string[]): Promise<void> {
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

async function handleLogs(base: string, args: string[]): Promise<void> {
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

async function handleTimer(base: string, args: string[]): Promise<void> {
  const sub = args[0];
  const sessionId = getCallerSessionId();

  switch (sub) {
    case "create": {
      // Parse: takode timer create "Check build health" --desc "Inspect the latest failing shard." --in 30m
      //        takode timer create "Deploy reminder" --at 3pm
      //        takode timer create "Refresh context" --every 10m
      const title = args[1];
      if (!title) {
        err("Usage: takode timer create <title> [--desc <description>] --in|--at|--every <spec>");
      }

      const body: Record<string, string> = { title };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--in" && args[i + 1]) {
          body.in = args[++i];
        } else if (args[i] === "--at" && args[i + 1]) {
          body.at = args[++i];
        } else if (args[i] === "--every" && args[i + 1]) {
          body.every = args[++i];
        } else if ((args[i] === "--desc" || args[i] === "--description") && args[i + 1]) {
          body.description = args[++i];
        }
      }

      if (!body.in && !body.at && !body.every) {
        err(
          "Usage: takode timer create <title> [--desc <description>] --in|--at|--every <spec>\n" +
            "  e.g. --in 30m, --at 3pm, --every 10m\n" +
            `  ${TIMER_CREATE_GUIDANCE}`,
        );
      }

      const result = (await apiPost(base, `/sessions/${sessionId}/timers`, body)) as {
        timer: {
          id: string;
          type: string;
          nextFireAt: number;
          originalSpec: string;
          title: string;
          description: string;
        };
      };
      const t = result.timer;
      const fireAt = new Date(t.nextFireAt).toLocaleTimeString();
      console.log(`Created timer ${t.id} (${t.type}): "${formatInlineText(t.title)}" -- next fire at ${fireAt}`);
      if (t.description) console.log(`Description: ${formatInlineText(t.description)}`);
      break;
    }
    case "list": {
      const result = (await apiGet(base, `/sessions/${sessionId}/timers`)) as {
        timers: SessionTimerDetail[];
      };
      if (result.timers.length === 0) {
        console.log("No active timers.");
        break;
      }
      console.log(`Active timers (${result.timers.length}):\n`);
      printTimerRows(result.timers);
      break;
    }
    case "cancel": {
      const timerId = args[1];
      if (!timerId) err("Usage: takode timer cancel <timer-id>");

      await apiDelete(base, `/sessions/${sessionId}/timers/${timerId}`);
      console.log(`Cancelled timer ${timerId}`);
      break;
    }
    default:
      err(
        "Usage: takode timer <subcommand>\n\n" +
          "Subcommands:\n" +
          "  create <title> [--desc <description>] --in|--at|--every <spec>   Create a timer\n" +
          "  list                                       List active timers\n" +
          "  cancel <timer-id>                          Cancel a timer\n\n" +
          `${TIMER_CREATE_GUIDANCE}\n\n` +
          "Examples:\n" +
          '  takode timer create "Check build health" --desc "Inspect the latest failing shard if red." --in 30m\n' +
          '  takode timer create "Deploy reminder" --at 3pm\n' +
          '  takode timer create "Refresh context" --desc "Summarize new blockers since the last run." --every 10m\n' +
          "  takode timer list\n" +
          "  takode timer cancel t1",
      );
  }
}

function printUsage(): void {
  console.log(`
Usage: takode <command> [options]

Commands:
  list     List sessions (--active: all, --herd: herded only, --all: include archived)
  search   Search sessions via server-side ranking (available to all sessions)
  info     Show detailed metadata for a session
  leader-context-resume  Recover compact leader/orchestrator context for a session
  spawn    Create and auto-herd new worker sessions
  tasks    Show a session task outline (available to all sessions)
  timers   Inspect pending timers for a session
  scan     Scan session turns (collapsed summaries, paginated)
  peek     View session activity (available to all sessions)
  read     Read a full message (available to all sessions)
  grep     Search within a session's messages (JS regex, case-insensitive)
  logs     Query and tail structured server logs
  export   Export full session history to a text file
  send     Send a message to a herded session
  user-message  Publish leader Markdown to the user-visible left panel
  rename   Rename a session (e.g. takode rename 5 My Session Name)
  herd     Herd sessions (e.g. takode herd 5,6,7 or takode herd --force 5)
  unherd   Release a session from your herd (e.g. takode unherd 5)
  interrupt  Interrupt a worker's current turn (e.g. takode interrupt 5)
  archive  Archive a herded session (e.g. takode archive 5)
  pending  Show pending questions/plans from a herded session
  answer   Answer a pending question or approve/reject a plan
  set-base       Set the diff base branch for a session
  refresh-branch Refresh git branch info for a session after checkout/rebase
  branch         Branch info and management for the current session
  notify         Alert the user (e.g. takode notify review "ready for verification")
  phases        List Quest Journey phases and exact phase brief paths
  board          Quest Journey work board (e.g. takode board show, takode board advance q-12)
  timer          Session-scoped timers (create, list, cancel)
  help           Show detailed help for a command or nested subcommand

Peek modes:
  takode peek 1                    Smart overview (collapsed turns + expanded last turn)
  takode peek 1 --from 500         Browse messages starting at index 500
  takode peek 1 --until 530 --count 50  Browse backward ending at message 530 (inclusive)
  takode peek 1 --detail --turns 3 Full detail on last 3 turns

Global options:
  --port <n>    Override API port (default: TAKODE_API_PORT or 3456)
  --json        Output in JSON format

Examples:
  takode list
  takode list --herd
  takode list --all
  takode search "auth"
  takode search "jwt" --all
  takode info 1
  takode info 1 --json
  takode leader-context-resume 1
  takode spawn --backend claude-sdk --count 2
  takode spawn --backend codex --count 3 --message "Check flaky tests"
  takode spawn --message-file /tmp/dispatch.txt
  takode tasks 1
  takode timers 1
  takode scan 1
  takode scan 1 --from 50 --count 20
  takode peek 1
  takode peek 1 --from 200
  takode peek 1 --until 530 --count 30
  takode peek 1 --detail --turns 3
  takode read 1 42
  takode grep 1 "authentication"
  takode logs --level warn,error --component ws-bridge
  takode logs --session abc123 --pattern reconnect --follow
  takode export 1 /tmp/session-1.txt
  takode send 2 "Please add tests for the edge cases"
  printf 'Line 1\\nLine 2 with $HOME and \`code\`\\n' | takode send 2 --stdin
  takode set-base 1 origin/main
  takode refresh-branch 1
  takode branch status
  takode branch set-base origin/main
  takode phases
  takode board --help
  takode board advance q-12
  takode help timer create
`);
}

async function ensureTakodeAccess(base: string, options?: { requireOrchestrator?: boolean }): Promise<void> {
  const me = (await apiGet(base, "/takode/me")) as { isOrchestrator?: boolean };
  if (options?.requireOrchestrator && me.isOrchestrator !== true) {
    err("takode commands require an orchestrator session.");
  }
}

const command = process.argv[2];
const rawArgs = process.argv.slice(3);
const args = stripGlobalFlags(rawArgs);
const base = getBase(rawArgs);

try {
  const commandAccess = new Map<string, { requireOrchestrator?: boolean }>([
    ["list", {}],
    ["search", {}],
    ["info", {}],
    ["leader-context-resume", {}],
    ["tasks", {}],
    ["timers", {}],
    ["scan", {}],
    ["peek", {}],
    ["read", {}],
    ["grep", {}],
    ["logs", {}],
    ["export", {}],
    ["send", { requireOrchestrator: true }],
    ["user-message", { requireOrchestrator: true }],
    ["rename", { requireOrchestrator: true }],
    ["herd", { requireOrchestrator: true }],
    ["unherd", { requireOrchestrator: true }],
    ["interrupt", { requireOrchestrator: true }],
    ["archive", { requireOrchestrator: true }],
    ["pending", { requireOrchestrator: true }],
    ["answer", { requireOrchestrator: true }],
    ["set-base", {}],
    ["refresh-branch", {}],
    ["branch", {}],
    ["notify", {}],
    ["phases", {}],
    ["board", {}],
    ["timer", {}],
  ]);
  if (!command || command === "-h" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  if (command === "help") {
    const helpTarget = args[0];
    if (!helpTarget) {
      printUsage();
      process.exit(0);
    }
    if (!printCommandHelp(helpTarget, args.slice(1))) {
      console.error(`Unknown command: ${helpTarget}`);
      printUsage();
      process.exit(1);
    }
    process.exit(0);
  }

  // Skip auth when asking for help — user should be able to read usage without
  // being in an orchestrator session.
  const wantsHelp = hasHelpFlag(args);
  if (wantsHelp) {
    if (!printCommandHelp(command, args)) {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
    process.exit(0);
  }
  const access = command ? commandAccess.get(command) : undefined;
  if (access) {
    await ensureTakodeAccess(base, access);
  }

  switch (command) {
    case "list":
      await handleList(base, args);
      break;
    case "search":
      await handleSearch(base, args);
      break;
    case "info":
      await handleInfo(base, args);
      break;
    case "leader-context-resume":
      await handleLeaderContextResume(base, args);
      break;
    case "spawn":
      await handleSpawn(base, args);
      break;
    case "interrupt":
      await handleInterrupt(base, args);
      break;
    case "archive":
      await handleArchive(base, args);
      break;
    case "tasks":
      await handleTasks(base, args);
      break;
    case "timers":
      await handleTimers(base, args);
      break;
    case "scan":
      await handleScan(base, args);
      break;
    case "peek":
      await handlePeek(base, args);
      break;
    case "read":
      await handleRead(base, args);
      break;
    case "grep":
      await handleGrep(base, args);
      break;
    case "logs":
      await handleLogs(base, args);
      break;
    case "export":
      await handleExport(base, args);
      break;
    case "send":
      await handleSend(base, args);
      break;
    case "user-message":
      await handleUserMessage(base, args);
      break;
    case "rename":
      await handleRename(base, args);
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
    case "set-base":
      await handleSetBase(base, args);
      break;
    case "refresh-branch":
      await handleRefreshBranch(base, args);
      break;
    case "branch":
      await handleBranch(base, args);
      break;
    case "notify":
      await handleNotify(base, args);
      break;
    case "phases":
      await handlePhases(base, args);
      break;
    case "board":
      await handleBoard(base, args);
      break;
    case "timer":
      await handleTimer(base, args);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
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
