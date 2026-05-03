import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getSessionAuthDir,
  getSessionAuthFilePrefixes,
  parseSessionAuthFileData,
  type SessionAuthFileData,
} from "../shared/session-auth.ts";

const DEFAULT_PORT = 3456;
export const DEFAULT_CODEX_MODEL = "gpt-5.4";

export function getCliDefaultModelForBackend(backend: "claude" | "claude-sdk" | "codex"): string {
  switch (backend) {
    case "claude":
    case "claude-sdk":
      return "";
    case "codex":
      return DEFAULT_CODEX_MODEL;
  }
}

export function getRequestedPort(argv: string[]): number | undefined {
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

export function getSessionAuthFileData(argv: string[] = process.argv.slice(2)): SessionAuthFileData | null {
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

export function getPort(argv: string[]): number {
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

export function getBase(argv: string[]): string {
  return `http://localhost:${getPort(argv)}/api`;
}

/** Strip --port <n> from argv so subcommand parsers don't see it */
export function stripGlobalFlags(argv: string[]): string[] {
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
export function getCredentials(): { sessionId: string; authToken: string } | null {
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

export function getCallerSessionId(): string {
  const creds = getCredentials();
  if (!creds?.sessionId) {
    err("COMPANION_SESSION_ID not set. Relaunch this session to refresh orchestration auth.");
  }
  return creds.sessionId;
}

/** Get auth headers for API requests. Returns empty object if no credentials. */
export function getAuthHeaders(): Record<string, string> {
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

export function getAuthContext(): { sessionId: string; authToken: string } {
  const creds = getCredentials();
  if (!creds?.sessionId) err("COMPANION_SESSION_ID not set. Relaunch this session to refresh orchestration auth.");
  if (!creds?.authToken) err("COMPANION_AUTH_TOKEN not set. Relaunch this session to refresh orchestration auth.");
  return creds;
}

export function takodeAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const { sessionId, authToken } = getAuthContext();
  return {
    [TAKODE_SESSION_ID_HEADER]: sessionId,
    [TAKODE_AUTH_TOKEN_HEADER]: authToken,
    ...extra,
  };
}

export async function apiGet(base: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    headers: takodeAuthHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiPost(base: string, path: string, body?: unknown): Promise<unknown> {
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

export async function apiDelete(base: string, path: string): Promise<unknown> {
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

export async function apiPatch(base: string, path: string, body?: unknown): Promise<unknown> {
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

export function err(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

let stdinTextPromise: Promise<string> | null = null;

export async function readStdinText(): Promise<string> {
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

export async function readOptionTextFile(pathOrDash: string, flagName: string): Promise<string> {
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

export async function readOptionalRichTextOption(
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
export function parseFlags(argv: string[]): Record<string, string | boolean> {
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

export function hasHelpFlag(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export function stripHelpFlags(argv: string[]): string[] {
  return argv.filter((arg) => arg !== "--help" && arg !== "-h");
}

export function assertKnownFlags(
  flags: Record<string, string | boolean>,
  allowed: ReadonlySet<string>,
  usage: string,
): void {
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  err(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}\n${usage}`);
}

export function resolveBooleanToggleFlag(
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

export function resolveStringFlag(
  flags: Record<string, string | boolean>,
  key: string,
  label: string,
): string | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") err(`--${key} requires a value for ${label}.`);
  const trimmed = value.trim();
  if (!trimmed) err(`--${key} requires a non-empty value for ${label}.`);
  return trimmed;
}

export function parseIntegerFlag(
  flags: Record<string, string | boolean>,
  key: string,
  label: string,
): number | undefined {
  const value = resolveStringFlag(flags, key, label);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) err(`--${key} must be an integer.`);
  return parsed;
}

export function parsePositiveIntegerFlag(
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

export type TakodeSessionInfo = {
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
  claimedQuestVerificationInboxUnread?: boolean;
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

export async function fetchSessionInfo(base: string, sessionRef: string): Promise<TakodeSessionInfo> {
  return apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/info`) as Promise<TakodeSessionInfo>;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

export function formatTime(epoch: number): string {
  const d = new Date(epoch);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

/** @deprecated Use formatTime — both now produce HH:MM. Kept as alias during migration. */
export const formatTimeShort = formatTime;

export function formatDate(epoch: number): string {
  const d = new Date(epoch);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Returns YYYY-MM-DD for date boundary comparison */
export function dateKey(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatRelativeTime(epoch: number): string {
  const diff = Date.now() - epoch;
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  return `${Math.round(diff / 3600000)}h ago`;
}

export function formatTimestampCompact(epoch: number): string {
  return dateKey(epoch) === dateKey(Date.now()) ? formatTime(epoch) : `${formatDate(epoch)} ${formatTime(epoch)}`;
}

export function formatDurationSeconds(seconds: number): string {
  if (seconds < 0.1) return "<0.1s";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m${secs}s`;
}

export type SessionTimerDetail = {
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

export const TIMER_CREATE_GUIDANCE =
  "Guidance: keep the timer title short and scannable. Use the description only for extra detail. " +
  "For recurring timers, keep the description general so it does not go stale across repeated firings.";

export function formatTimerScheduleLabel(timer: Pick<SessionTimerDetail, "type" | "originalSpec">): string {
  return timer.type === "recurring"
    ? `every ${timer.originalSpec}`
    : timer.type === "delay"
      ? `in ${timer.originalSpec}`
      : `at ${timer.originalSpec}`;
}

export function printTimerRows(timers: SessionTimerDetail[]): void {
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

export function escapeTerminalText(s: string): string {
  return s
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function formatInlineText(value: unknown): string {
  return escapeTerminalText(String(value ?? ""));
}

export function truncate(s: string, max: number): string {
  const escaped = escapeTerminalText(s);
  if (escaped.length <= max) return escaped;
  return escaped.slice(0, max) + ` [+${escaped.length - max} chars]`;
}
