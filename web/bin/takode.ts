#!/usr/bin/env bun
/**
 * Takode CLI — cross-session orchestration commands.
 * Server-authoritative orchestration commands.
 */

import { readFileSync, readdirSync } from "node:fs";
import { getDefaultModelForBackend } from "../shared/backend-defaults.js";
import { TAKODE_PEEK_CONTENT_LIMIT } from "../shared/takode-constants.js";
import {
  getSessionAuthDir,
  getSessionAuthFilePrefixes,
  parseSessionAuthFileData,
  type SessionAuthFileData,
} from "../shared/session-auth.js";

const DEFAULT_PORT = 3456;

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

async function readStdinText(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
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
    const projectKey =
      s.reviewerOf !== undefined ? (sessionProjectKey.get(s.reviewerOf) ?? ownKey) : ownKey;
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

  console.log(`${total} session(s)${filterHint}`);
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
    lastActivityAt?: number;
    lastMessagePreview?: string;
    isWorktree?: boolean;
    claimedQuestId?: string | null;
    claimedQuestStatus?: string | null;
  },
  opts?: { indent?: boolean },
): void {
  const prefix = opts?.indent ? "        ↳ " : "  ";
  const num = s.sessionNum !== undefined ? `#${s.sessionNum}` : "  ";
  const name = formatInlineText(s.name || "(unnamed)");
  const role = s.isOrchestrator ? " [leader]" : s.reviewerOf !== undefined ? " [reviewer]" : "";
  const herd = s.herdedBy ? " [herd]" : "";
  // Backend type tag: only show for codex (sdk is implied by session details)
  const backend = s.backendType === "codex" ? " [codex]" : "";
  const status = s.cliConnected ? (s.state === "running" ? "●" : "○") : s.archived ? "⊘" : "✗";
  const attention = s.attentionReason ? ` ⚠ ${formatInlineText(s.attentionReason)}` : "";

  // Quest indicator: "📋 q-42 in_progress"
  const quest = s.claimedQuestId
    ? ` 📋 ${formatInlineText(s.claimedQuestId)}${s.claimedQuestStatus ? ` ${formatInlineText(s.claimedQuestStatus)}` : ""}`
    : "";

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

  console.log(`${prefix}${num.padEnd(5)} ${status} ${name}${role}${herd}${backend}${quest}${attention}`);
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
    printSessionLine(s);
    if (showTasks) printSessionTasks(s.taskHistory);
    count++;
    const reviewers = s.sessionNum !== undefined ? reviewersByParent.get(s.sessionNum) : undefined;
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
  return `agent${msg.agentSource.sessionLabel ? ` ${formatInlineText(msg.agentSource.sessionLabel)}` : ""}`;
}

function formatCollapsedTurn(turn: CollapsedTurn): string {
  const endIdx = turn.endIdx >= 0 ? turn.endIdx : turn.startIdx; // in-progress turns use startIdx as fallback
  const msgRange = `[${turn.startIdx}]-[${endIdx}]`;
  const startTime = formatTimeShort(turn.startedAt);
  const endTime = turn.endedAt ? formatTimeShort(turn.endedAt) : "running";
  const duration = turn.durationMs ? `${Math.round(turn.durationMs / 1000)}s` : "";
  const durationPart = duration ? ` (${duration})` : "";

  const statParts: string[] = [];
  if (turn.stats.tools > 0) statParts.push(`${turn.stats.tools} tools`);
  if (turn.stats.subagents > 0) statParts.push(`${turn.stats.subagents} agents`);
  const statStr = statParts.length > 0 ? ` · ${statParts.join(" · ")}` : "";

  const icon = turn.success === true ? "✓" : turn.success === false ? "✗" : "…";

  const header = `Turn ${turn.turnNum} · ${msgRange} · ${startTime}-${endTime}${durationPart}${statStr} · ${icon}`;

  const sourceLabel = turn.agentSource ? "herd" : "user";
  const hasUser = !!turn.userPreview;
  const hasResult = !!turn.resultPreview;

  // Single-message turn or only one side exists: compact format
  if (!hasUser && !hasResult) return header;
  if (!hasUser) return `${header}\n  "${truncate(turn.resultPreview, TAKODE_PEEK_CONTENT_LIMIT)}"`;
  if (!hasResult) return `${header}\n  ${sourceLabel}: "${truncate(turn.userPreview, TAKODE_PEEK_CONTENT_LIMIT)}"`;

  // Multi-message turn: show source prompt, ellipsis, and assistant response
  return [
    header,
    `  ${sourceLabel}: "${truncate(turn.userPreview, TAKODE_PEEK_CONTENT_LIMIT)}"`,
    `  ...`,
    `  asst: "${truncate(turn.resultPreview, TAKODE_PEEK_CONTENT_LIMIT)}"`,
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
          `  ${idx.padEnd(7)} ${time}  ${userSourceLabel(msg)}  "${truncate(msg.content, TAKODE_PEEK_CONTENT_LIMIT)}"`,
        );
        break;
      case "assistant": {
        const text = msg.content.trim();
        if (text) {
          console.log(`  ${idx.padEnd(7)} ${time}  asst  ${truncate(text, TAKODE_PEEK_CONTENT_LIMIT)}`);
        } else if (msg.tools && msg.tools.length > 0) {
          // No text content -- print idx header so the msg ID is always visible
          console.log(`  ${idx.padEnd(7)} ${time}  asst`);
        }
        if (msg.tools && msg.tools.length > 0) {
          for (let ti = 0; ti < msg.tools.length; ti++) {
            const tool = msg.tools[ti];
            const isLastTool = ti === msg.tools.length - 1;
            const connector = isLastTool && isLast ? "└─" : "├─";
            console.log(
              `  ${pipe}       ${connector} ${formatInlineText(tool.name).padEnd(6)} ${truncate(tool.summary, 80)}`,
            );
          }
        }
        break;
      }
      case "result": {
        const icon = msg.success ? "✓" : "✗";
        const resultText = msg.content.trim();
        if (resultText) {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} ${truncate(resultText, TAKODE_PEEK_CONTENT_LIMIT)}`);
        } else {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} done`);
        }
        break;
      }
      case "system":
        console.log(`  ${idx.padEnd(7)} ${time}  sys   ${truncate(msg.content, TAKODE_PEEK_CONTENT_LIMIT)}`);
        break;
    }
  }
}

function printPeekHeader(d: {
  sessionNum: number;
  sessionName: string;
  status: string;
  quest?: { id: string; title: string; status: string } | null;
}): void {
  console.log(`Session #${d.sessionNum} "${formatInlineText(d.sessionName)}" -- ${formatInlineText(d.status)}`);
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
  if (d.omittedTurnCount > 0) {
    // Print the date boundary for the first collapsed turn if we have one
    if (d.collapsedTurns.length > 0) {
      const firstDate = dateKey(d.collapsedTurns[0].startedAt);
      if (firstDate !== lastDate) {
        console.log(`── ${formatDate(d.collapsedTurns[0].startedAt)} ──`);
        lastDate = firstDate;
      }
    }
    console.log(`  ... ${d.omittedTurnCount} earlier turns omitted (takode peek ${safeSessionRef} --from 0 to browse)`);
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
    const successIcon = lastMsg?.type === "result" ? (lastMsg.success ? " · ✓" : " · ✗") : "";

    console.log("");
    console.log(
      `Turn ${et.turnNum} (last, ${msgCount} messages) · ${formatTimeShort(et.startedAt)}-${et.endedAt ? formatTimeShort(et.endedAt) : "running"}${durationPart}${statStr}${successIcon}`,
    );

    // Omitted messages hint
    if (et.omittedMessageCount > 0) {
      const firstIdx = et.messages.length > 0 ? et.messages[0].idx - et.omittedMessageCount : 0;
      console.log(
        `  ... ${et.omittedMessageCount} earlier messages omitted (takode peek ${safeSessionRef} --from ${firstIdx} to see all)`,
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
    const boundary = d.turnBoundaries.find((b) => msg.idx >= b.startIdx && msg.idx <= b.endIdx);
    if (boundary && boundary.turnNum !== activeTurnNum) {
      console.log(`--- Turn ${boundary.turnNum} ---`);
      activeTurnNum = boundary.turnNum;
    }

    // Message rendering (compact: tool counts instead of individual lines)
    const time = formatTime(msg.ts);
    const idx = `[${msg.idx}]`;

    switch (msg.type) {
      case "user":
        console.log(
          `  ${idx.padEnd(7)} ${time}  ${userSourceLabel(msg)}  "${truncate(msg.content, TAKODE_PEEK_CONTENT_LIMIT)}"`,
        );
        break;
      case "assistant": {
        const text = msg.content.trim();
        if (msg.tools && msg.tools.length > 0) {
          // Expanded tool display (--show-tools)
          if (text) {
            console.log(`  ${idx.padEnd(7)} ${time}  asst  ${truncate(text, TAKODE_PEEK_CONTENT_LIMIT)}`);
          } else {
            console.log(`  ${idx.padEnd(7)} ${time}  asst`);
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
            console.log(`  ${idx.padEnd(7)} ${time}  asst  ${truncate(text, TAKODE_PEEK_CONTENT_LIMIT)}${toolStr}`);
          } else if (toolStr) {
            console.log(`  ${idx.padEnd(7)} ${time}  asst ${toolStr}`);
          }
        }
        break;
      }
      case "result": {
        const icon = msg.success ? "✓" : "✗";
        const resultText = msg.content.trim();
        if (resultText) {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} ${truncate(resultText, TAKODE_PEEK_CONTENT_LIMIT)}`);
        } else {
          console.log(`  ${idx.padEnd(7)} ${time}  ${icon} done`);
        }
        break;
      }
      case "system":
        console.log(`  ${idx.padEnd(7)} ${time}  sys   ${truncate(msg.content, TAKODE_PEEK_CONTENT_LIMIT)}`);
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
  };

  const time = formatTime(d.ts);
  const lineInfo =
    d.totalLines > d.limit
      ? ` (lines ${d.offset + 1}-${d.offset + d.limit} of ${d.totalLines})`
      : ` (${d.totalLines} lines)`;
  console.log(`[msg ${d.idx}] ${formatInlineText(d.type)} -- ${time}${lineInfo}`);
  console.log("\u2500".repeat(60));

  // Print with line numbers (like the Read tool)
  const lines = d.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNum = String(d.offset + i + 1).padStart(4);
    console.log(`${lineNum}  ${formatInlineText(lines[i] ?? "")}`);
  }

  if (d.offset + lines.length < d.totalLines) {
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
      if (msg.includes("not in your herd") || msg.includes("currently working")) throw e;
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

// ─── Spawn handler ───────────────────────────────────────────────────────────

const SPAWN_FLAG_USAGE = `Usage: takode spawn [options]

  Create and auto-herd new worker sessions.

Options:
  --backend <type>             AI backend: "claude", "codex", or "claude-sdk" (default: inherit from leader)
  --cwd <path>                 Working directory (default: current directory)
  --count <n>                  Number of sessions to spawn (default: 1)
  --message <text>             Initial message to send to spawned sessions
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
  takode spawn --reviewer 42 --message "Review the changes for q-10"`;

const SPAWN_ALLOWED_FLAGS = new Set([
  "backend",
  "cwd",
  "count",
  "message",
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
    permissionMode?: string;
    backendType?: string;
  };

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
  const message = typeof flags.message === "string" ? flags.message.trim() : "";
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
            `Stop it first with \`takode interrupt ${existingLabel}\`.`,
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
        agentSource: { sessionId: leaderSessionId },
      });
    }

    spawned.push(await fetchSessionInfo(base, created.sessionId));
  }

  // Check herd size and warn if over the limit
  const HERD_SIZE_LIMIT = 5;
  let herdWarning: { herdSize: number; excess: number; limit: number } | null = null;
  try {
    const allSessions = (await apiGet(base, "/takode/sessions")) as Array<{
      sessionId: string;
      archived?: boolean;
      herdedBy?: string;
      reviewerOf?: number;
    }>;
    // Reviewer sessions don't count toward the herd limit
    const activeHerded = allSessions.filter(
      (s) => !s.archived && s.herdedBy === leaderSessionId && s.reviewerOf === undefined,
    );
    if (activeHerded.length > HERD_SIZE_LIMIT) {
      herdWarning = {
        herdSize: activeHerded.length,
        excess: activeHerded.length - HERD_SIZE_LIMIT,
        limit: HERD_SIZE_LIMIT,
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
          defaultModel: backendRaw === "codex" && !model ? getDefaultModelForBackend("codex") : null,
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
      `\n\u26a0 Herd size is now ${herdWarning.herdSize} (limit: ${herdWarning.limit}). Please archive ${herdWarning.excess} session(s) least likely to be reused. Archived sessions' history remains readable via takode peek/read.`,
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
  // Parse comma/space-separated session refs (filtering out flags)
  const refs = args
    .filter((a) => !a.startsWith("--"))
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (refs.length === 0) err("Usage: takode herd <session1,session2,...>");

  const mySessionId = getCallerSessionId();

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(mySessionId)}/herd`, {
    workerIds: refs,
  })) as { herded: string[]; notFound: string[]; conflicts: Array<{ id: string; herder: string }>; leaders?: string[] };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.herded.length > 0) {
    console.log(`[${formatTime(Date.now())}] \u2713 Herded ${result.herded.length} session(s)`);
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
  }
  if (result.leaders?.length) {
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
      request_id: string;
      tool_name: string;
      timestamp: number;
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
    console.log("No pending questions or plans to answer.");
    return;
  }

  for (const p of result.pending) {
    const msgRef = typeof p.msg_index === "number" ? ` [msg ${p.msg_index}]` : "";

    if (p.tool_name === "AskUserQuestion" && p.questions) {
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
        console.log(`Answer: takode answer ${safeSessionRef} <option-number-or-text>`);
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
      console.log(`Approve: takode answer ${safeSessionRef} approve`);
      console.log(`Reject:  takode answer ${safeSessionRef} reject 'feedback here'`);
    }
  }
}

async function handleAnswer(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const response = args
    .filter((a) => !a.startsWith("--"))
    .slice(1)
    .join(" ");
  const jsonMode = args.includes("--json");

  if (!sessionRef || !response) err("Usage: takode answer <session> <response>");

  const mySessionId = getCallerSessionId();

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/answer`, {
    response,
    callerSessionId: mySessionId,
  })) as { ok: boolean; tool_name: string; answer?: string; action?: string; feedback?: string; error?: string };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.tool_name === "AskUserQuestion") {
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

async function handleNotify(base: string, args: string[]): Promise<void> {
  const category = args[0];
  if (!category || (category !== "needs-input" && category !== "review")) {
    err("Usage: takode notify <category> [summary]\nCategories: needs-input, review");
  }
  const remaining = args.slice(1).filter((a) => !a.startsWith("--"));
  const summary = remaining.length > 0 ? remaining.join(" ") : undefined;
  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const selfId = getCallerSessionId();
  const payload: Record<string, unknown> = { category };
  if (summary) payload.summary = summary;
  const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/notify`, payload)) as {
    ok: boolean;
    category: string;
    anchoredMessageId: string | null;
  };
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Notification sent (${category})`);
}

// ─── Board ─────────────────────────────────────────────────────────────────

import { QUEST_JOURNEY_STATES, QUEST_JOURNEY_HINTS, isValidQuestId } from "../shared/quest-journey.js";

interface BoardRow {
  questId: string;
  title?: string;
  worker?: string;
  workerNum?: number;
  status?: string;
  waitFor?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Format board output as JSON with a marker for frontend detection. */
function formatBoardOutput(board: BoardRow[], operation?: string): string {
  return JSON.stringify({ __takode_board__: true, board, ...(operation ? { operation } : {}) }, null, 2);
}

/** Print board in a human-readable table with Quest Journey state and next-action hints. */
function printBoardText(board: BoardRow[], allBoardRows?: BoardRow[]): void {
  if (board.length === 0) {
    console.log("Board is empty.");
    return;
  }

  // Build a set of active quest IDs on the board (for resolving wait-for status)
  const activeQuestIds = new Set((allBoardRows || board).map((r) => r.questId));

  console.log("");
  const qCol = 8;
  const tCol = 26;
  const wCol = 8;
  const sCol = 18;
  const waitCol = 16;
  console.log(
    `${"QUEST".padEnd(qCol)} ${"TITLE".padEnd(tCol)} ${"WORKER".padEnd(wCol)} ${"STATE".padEnd(sCol)} ${"WAIT-FOR".padEnd(waitCol)} NEXT ACTION`,
  );
  console.log("-".repeat(qCol + tCol + wCol + sCol + waitCol + 30));

  for (const row of board) {
    const quest = row.questId.padEnd(qCol);
    // Truncate to (tCol - 3) to leave room for the "…" character and column padding
    const titleStr = row.title ? (row.title.length > tCol - 2 ? row.title.slice(0, tCol - 3) + "…" : row.title) : "--";
    const title = titleStr.padEnd(tCol);
    const worker = row.worker ? `#${row.workerNum ?? "?"}`.padEnd(wCol) : "--".padEnd(wCol);
    const state = (row.status || "--").padEnd(sCol);

    // Wait-for column: distinguish "no deps", "blocked", and "all resolved"
    const allDeps = row.waitFor || [];
    const blockedDeps = allDeps.filter((wf) => activeQuestIds.has(wf));
    let waitForStr: string;
    if (blockedDeps.length > 0) {
      waitForStr = blockedDeps.join(", ");
    } else if (allDeps.length > 0) {
      waitForStr = "✓ " + allDeps.join(", ");
    } else {
      waitForStr = "--";
    }
    const waitForDisplay = waitForStr.slice(0, waitCol - 1).padEnd(waitCol);

    // Next action hint: if blocked, show "blocked"; otherwise show state hint
    let nextAction: string;
    if (blockedDeps.length > 0) {
      nextAction = `blocked (wait for ${blockedDeps.join(", ")})`;
    } else {
      nextAction = QUEST_JOURNEY_HINTS[row.status || ""] || "--";
      if (nextAction !== "--") nextAction = `-> ${nextAction}`;
    }

    console.log(`${quest} ${title} ${worker} ${state} ${waitForDisplay} ${nextAction}`);
  }
  console.log("");
}

/** Output board with frontend-detectable JSON marker, plus a human-readable table when not in --json mode. */
function outputBoard(board: BoardRow[], jsonMode: boolean, operation?: string): void {
  // Always emit the JSON marker so the Companion frontend can detect and render BoardBlock.
  console.log(formatBoardOutput(board, operation));
  if (!jsonMode) {
    printBoardText(board, board);
  }
}

async function handleBoard(base: string, args: string[]): Promise<void> {
  const selfId = getCallerSessionId();
  const sub = args[0];

  // No subcommand or "show": display board
  if (!sub || sub === "show" || sub.startsWith("--")) {
    const flags = parseFlags(sub === "show" ? args.slice(1) : args);
    const result = (await apiGet(base, `/sessions/${encodeURIComponent(selfId)}/board`)) as { board: BoardRow[] };
    outputBoard(result.board, flags.json === true);
    return;
  }

  if (sub === "add" || sub === "set") {
    const questId = args[1];
    if (!questId)
      err(
        `Usage: takode board ${sub} <quest-id> [--worker <session>] [--status "..."] [--title "..."] [--wait-for q-X,q-Y] [--json]`,
      );
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));

    const body: Record<string, unknown> = { questId };
    if (typeof flags.status === "string") body.status = flags.status;
    if (typeof flags.title === "string") body.title = flags.title;
    if (typeof flags["wait-for"] === "string") {
      const waitFor = flags["wait-for"]
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      body.waitFor = waitFor;
    }
    if (typeof flags.worker === "string") {
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
    }

    const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/board`, body)) as {
      board: BoardRow[];
    };
    outputBoard(result.board, flags.json === true, `set ${questId}`);
    return;
  }

  if (sub === "advance") {
    const questId = args[1];
    if (!questId) err("Usage: takode board advance <quest-id> [--json]");
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));

    const result = (await apiPost(
      base,
      `/sessions/${encodeURIComponent(selfId)}/board/${encodeURIComponent(questId)}/advance`,
    )) as { board: BoardRow[]; removed: boolean; previousState?: string; newState?: string };

    let operation: string;
    if (result.removed) {
      console.log(`${questId}: removed from board (Quest Journey complete)`);
      operation = `removed ${questId}`;
    } else if (result.previousState && result.newState) {
      console.log(`${questId}: ${result.previousState} -> ${result.newState}`);
      operation = `advanced ${questId} to ${result.newState}`;
    } else {
      operation = `advanced ${questId}`;
    }
    outputBoard(result.board, flags.json === true, operation);
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
    };
    outputBoard(result.board, flags.json === true, `removed ${questIds.join(", ")}`);
    return;
  }

  err(`Unknown board subcommand: ${sub}\nUsage: takode board [show|set|advance|rm] ...`);
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
  sessionId: string;
  sessionNum: number;
  sessionName: string;
  status: string;
  quest: { id: string; title: string; status: string } | null;
  mode: "turn_scan";
  totalTurns: number;
  totalMessages: number;
  fromTurn: number;
  returnedTurns: number;
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

  if (data.returnedTurns === 0) {
    console.log("\nNo turns in this range.");
    return;
  }

  const endTurn = data.fromTurn + data.returnedTurns - 1;
  console.log(`Showing turns ${data.fromTurn}-${endTurn}:`);
  console.log("");

  let lastDate = "";
  for (const turn of data.turns) {
    const turnDate = dateKey(turn.startedAt);
    if (turnDate !== lastDate) {
      console.log(`── ${formatDate(turn.startedAt)} ──`);
      lastDate = turnDate;
    }
    console.log(formatCollapsedTurn(turn));
  }

  console.log("");

  // Navigation hints -- "Older" goes toward turn 0, "Newer" goes toward the end
  const hints: string[] = [];
  if (data.fromTurn > 0) {
    hints.push(`Older: takode scan ${safeSessionRef} --until ${data.fromTurn} --count ${turnCount}`);
  }
  if (data.fromTurn + data.returnedTurns < data.totalTurns) {
    hints.push(
      `Newer: takode scan ${safeSessionRef} --from ${data.fromTurn + data.returnedTurns} --count ${turnCount}`,
    );
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
    matches: Array<{
      idx: number;
      type: string;
      ts: number;
      snippet: string;
      turnNum: number | null;
    }>;
  };

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.totalMatches === 0) {
    console.log(`No matches for "${formatInlineText(query)}" in session #${data.sessionNum}.`);
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
    const turnLabel = match.turnNum !== null ? `T${match.turnNum}` : "  ";
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

// ─── Main dispatch ──────────────────────────────────────────────────────────

async function handleTimer(base: string, args: string[]): Promise<void> {
  const sub = args[0];
  const sessionId = getCallerSessionId();

  switch (sub) {
    case "create": {
      // Parse: takode timer create "check the build" --in 30m
      //        takode timer create "deploy reminder" --at 3pm
      //        takode timer create "refresh context" --every 10m
      const prompt = args[1];
      if (!prompt) {
        err("Usage: takode timer create <prompt> --in|--at|--every <spec>");
      }

      const body: Record<string, string> = { prompt };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--in" && args[i + 1]) {
          body.in = args[++i];
        } else if (args[i] === "--at" && args[i + 1]) {
          body.at = args[++i];
        } else if (args[i] === "--every" && args[i + 1]) {
          body.every = args[++i];
        }
      }

      if (!body.in && !body.at && !body.every) {
        err("Usage: takode timer create <prompt> --in|--at|--every <spec>\n  e.g. --in 30m, --at 3pm, --every 10m");
      }

      const result = (await apiPost(base, `/sessions/${sessionId}/timers`, body)) as {
        timer: { id: string; type: string; nextFireAt: number; originalSpec: string; prompt: string };
      };
      const t = result.timer;
      const fireAt = new Date(t.nextFireAt).toLocaleTimeString();
      console.log(`Created timer ${t.id} (${t.type}): "${t.prompt}" -- next fire at ${fireAt}`);
      break;
    }
    case "list": {
      const result = (await apiGet(base, `/sessions/${sessionId}/timers`)) as {
        timers: {
          id: string;
          type: string;
          prompt: string;
          originalSpec: string;
          nextFireAt: number;
          fireCount: number;
          intervalMs?: number;
        }[];
      };
      if (result.timers.length === 0) {
        console.log("No active timers.");
        break;
      }
      console.log(`Active timers (${result.timers.length}):\n`);
      for (const t of result.timers) {
        const fireAt = new Date(t.nextFireAt).toLocaleTimeString();
        const typeLabel =
          t.type === "recurring" ? `every ${t.originalSpec}` : t.type === "delay" ? `in ${t.originalSpec}` : `at ${t.originalSpec}`;
        console.log(`  ${t.id}  ${typeLabel}  fires=${t.fireCount}  next=${fireAt}  "${t.prompt}"`);
      }
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
          "  create <prompt> --in|--at|--every <spec>   Create a timer\n" +
          "  list                                       List active timers\n" +
          "  cancel <timer-id>                          Cancel a timer\n\n" +
          "Examples:\n" +
          '  takode timer create "check build" --in 30m\n' +
          '  takode timer create "deploy" --at 3pm\n' +
          '  takode timer create "refresh" --every 10m\n' +
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
  spawn    Create and auto-herd new worker sessions
  tasks    Show a session task outline (available to all sessions)
  scan     Scan session turns (collapsed summaries, paginated)
  peek     View session activity (available to all sessions)
  read     Read a full message (available to all sessions)
  grep     Search within a session's messages (case-insensitive)
  export   Export full session history to a text file
  send     Send a message to a herded session
  rename   Rename a session (e.g. takode rename 5 My Session Name)
  herd     Herd sessions (e.g. takode herd 5,6,7)
  unherd   Release a session from your herd (e.g. takode unherd 5)
  interrupt  Interrupt a worker's current turn (e.g. takode interrupt 5)
  archive  Archive a herded session (e.g. takode archive 5)
  pending  Show pending questions/plans from a herded session
  answer   Answer a pending question or approve/reject a plan
  set-base       Set the diff base branch for a session
  refresh-branch Refresh git branch info for a session after checkout/rebase
  branch         Branch info and management for the current session
  notify         Alert the user (e.g. takode notify review "ready for verification")
  board          Quest Journey work board (e.g. takode board show, takode board set q-12 --status PLANNING)
  timer          Session-scoped timers (create, list, cancel)

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
  takode spawn --backend claude-sdk --count 2
  takode spawn --backend codex --count 3 --message "Check flaky tests"
  takode tasks 1
  takode scan 1
  takode scan 1 --from 50 --count 20
  takode peek 1
  takode peek 1 --from 200
  takode peek 1 --until 530 --count 30
  takode peek 1 --detail --turns 3
  takode read 1 42
  takode grep 1 "authentication"
  takode export 1 /tmp/session-1.txt
  takode send 2 "Please add tests for the edge cases"
  printf 'Line 1\\nLine 2 with $HOME and \`code\`\\n' | takode send 2 --stdin
  takode set-base 1 origin/main
  takode refresh-branch 1
  takode branch status
  takode branch set-base origin/main
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
    ["tasks", {}],
    ["scan", {}],
    ["peek", {}],
    ["read", {}],
    ["grep", {}],
    ["export", {}],
    ["send", { requireOrchestrator: true }],
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
    ["board", {}],
    ["timer", {}],
  ]);
  // Skip auth when asking for help — user should be able to read usage without
  // being in an orchestrator session.
  const wantsHelp = args.includes("--help") || args.includes("-h");
  const access = command ? commandAccess.get(command) : undefined;
  if (access && !wantsHelp) {
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
    case "export":
      await handleExport(base, args);
      break;
    case "send":
      await handleSend(base, args);
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
    case "board":
      await handleBoard(base, args);
      break;
    case "timer":
      await handleTimer(base, args);
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
