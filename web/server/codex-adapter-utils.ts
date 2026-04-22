import type { CodexAppReference, CodexSkillReference } from "./session-types.js";

export interface CodexItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export function safeKind(kind: unknown): string {
  if (typeof kind === "string") return kind;
  if (kind && typeof kind === "object" && "type" in kind) {
    const t = (kind as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return "modify";
}

export function toSafeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value))
    return value
      .map((v) => toSafeText(v))
      .filter(Boolean)
      .join(" ")
      .trim();
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const preferred = rec.text ?? rec.summary ?? rec.content;
    if (preferred !== undefined) return toSafeText(preferred);
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function stripOuterShellQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first !== "'" && first !== '"') || first !== last) return trimmed;

  const inner = trimmed.slice(1, -1);
  if (first === "'") {
    return inner.replace(/'\\''/g, "'");
  }
  return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export function unwrapShellWrappedCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";

  const posix = trimmed.match(/^(?:\/(?:usr\/)?bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/);
  if (posix) {
    return stripOuterShellQuotes(posix[1]);
  }

  const win = trimmed.match(/^cmd(?:\.exe)?\s+\/c\s+([\s\S]+)$/i);
  if (win) {
    return stripOuterShellQuotes(win[1]);
  }

  return trimmed;
}

export function isCompactSlashCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/compact";
}

function normalizeSlashPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/";
  const normalized = trimmed.replace(/\/+$/, "");
  return normalized || "/";
}

function toCodexMentionSlug(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "app";
}

function looksLikeSkillPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function unescapeCodexMentionPath(path: string): string {
  return path.replace(/\\\)/g, ")").replace(/\\\\/g, "\\").trim();
}

export function extractCodexSkillReferences(result: unknown, sessionCwd?: string): CodexSkillReference[] {
  const root = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const rawEntries = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.skills)
      ? root.skills
      : Array.isArray(result)
        ? result
        : [];
  const entries = rawEntries.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
  const normalizedCwd = sessionCwd ? normalizeSlashPath(sessionCwd) : "";
  const matchingEntries = normalizedCwd
    ? entries.filter((entry) => typeof entry.cwd === "string" && normalizeSlashPath(entry.cwd) === normalizedCwd)
    : [];
  const sourceEntries = matchingEntries.length > 0 ? matchingEntries : entries;

  const byName = new Map<string, CodexSkillReference>();
  for (const entry of sourceEntries) {
    const skills = entry.skills;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      if (typeof skill === "string") {
        const name = skill.trim();
        if (name && !byName.has(name)) {
          byName.set(name, { name, path: "" });
        }
        continue;
      }
      if (!skill || typeof skill !== "object") continue;
      const record = skill as Record<string, unknown>;
      if (record.enabled === false) continue;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) continue;
      const existing = byName.get(name);
      if (existing?.path) continue;
      const path = typeof record.path === "string" ? record.path.trim() : "";
      const description = typeof record.description === "string" ? record.description.trim() : "";
      byName.set(name, {
        name,
        path,
        ...(description ? { description } : {}),
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function extractCodexAppsPage(result: unknown): { apps: CodexAppReference[]; nextCursor: string | null } {
  const root = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const rawApps = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.apps)
      ? root.apps
      : Array.isArray(result)
        ? result
        : [];
  const apps = new Map<string, CodexAppReference>();
  for (const app of rawApps) {
    if (typeof app === "string") {
      const name = app.trim();
      if (name && !apps.has(name)) apps.set(name, { id: name, name });
      continue;
    }
    if (!app || typeof app !== "object") continue;
    const record = app as Record<string, unknown>;
    if (record.isAccessible === false || record.isEnabled === false) continue;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!id || !name) continue;
    const description = typeof record.description === "string" ? record.description.trim() : null;
    apps.set(id, {
      id,
      name,
      ...(description ? { description } : {}),
    });
  }
  const nextCursor = typeof root.nextCursor === "string" && root.nextCursor.trim() ? root.nextCursor.trim() : null;
  return {
    apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name)),
    nextCursor,
  };
}

export function extractCodexMentionInputs(
  text: string,
  skillPathByName: Map<string, string>,
): Array<{ type: "skill" | "mention"; name: string; path: string }> {
  const mentionInputs: Array<{ type: "skill" | "mention"; name: string; path: string }> = [];
  const seen = new Set<string>();
  const pushMention = (type: "skill" | "mention", name: string, path: string) => {
    const normalizedName = name.trim();
    const normalizedPath = path.trim();
    if (!normalizedName || !normalizedPath) return;
    const key = `${type}:${normalizedName}:${normalizedPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    mentionInputs.push({ type, name: normalizedName, path: normalizedPath });
  };

  const linkPattern = /\[\$([^\]\n]+)\]\(((?:\\\)|[^)\n])*)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const name = match[1]?.trim() ?? "";
    const path = unescapeCodexMentionPath(match[2] ?? "");
    if (!name || !path) continue;
    if (path.startsWith("app://")) {
      pushMention("mention", toCodexMentionSlug(name), path);
    } else if (looksLikeSkillPath(path)) {
      pushMention("skill", name, path);
    }
  }

  const plainSkillPattern = /(^|[\s({])\$([A-Za-z0-9][A-Za-z0-9._:-]*)/g;
  for (const match of text.matchAll(plainSkillPattern)) {
    const name = match[2]?.trim() ?? "";
    const path = skillPathByName.get(name) ?? skillPathByName.get(name.toLowerCase());
    if (name && path) {
      pushMention("skill", name, path);
    }
  }

  return mentionInputs;
}

function extractCommandAction(commandActions: unknown): string {
  if (!Array.isArray(commandActions)) return "";
  for (const action of commandActions) {
    if (!action || typeof action !== "object") continue;
    const cmd = (action as Record<string, unknown>).command;
    if (typeof cmd === "string" && cmd.trim()) {
      return cmd.trim();
    }
  }
  return "";
}

export function formatCommandForDisplay(command: string | string[] | undefined, commandActions?: unknown): string {
  const actionCommand = extractCommandAction(commandActions);
  if (actionCommand) return unwrapShellWrappedCommand(actionCommand);
  const raw = Array.isArray(command) ? command.join(" ") : command || "";
  return unwrapShellWrappedCommand(raw);
}

export function firstNonEmptyString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export type ToolFileChange = {
  path: string;
  kind: string;
  diff?: string;
};

function extractChangeDiff(change: Record<string, unknown>): string {
  const direct = firstNonEmptyString(change, ["diff", "unified_diff", "unifiedDiff", "patch"]);
  if (direct) return direct;

  const kind = change.kind;
  if (kind && typeof kind === "object") {
    const nested = firstNonEmptyString(kind as Record<string, unknown>, [
      "diff",
      "unified_diff",
      "unifiedDiff",
      "patch",
    ]);
    if (nested) return nested;
  }

  return "";
}

export function mapFileChangesForTool(changes: Array<Record<string, unknown>>): ToolFileChange[] {
  return changes.map((c) => {
    const path = typeof c.path === "string" ? c.path : "";
    const kind = safeKind(c.kind ?? c.type);
    const diff = extractChangeDiff(c);
    return {
      path,
      kind,
      ...(diff ? { diff } : {}),
    };
  });
}

export function mapFileChangesObjectForTool(fileChanges: Record<string, unknown>): ToolFileChange[] {
  return Object.entries(fileChanges).map(([path, raw]) => {
    const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const kind = safeKind(rec.kind ?? rec.type);
    const diff = extractChangeDiff(rec);
    return {
      path,
      kind,
      ...(diff ? { diff } : {}),
    };
  });
}

export function mapUnknownFileChangesForTool(raw: unknown): ToolFileChange[] {
  if (Array.isArray(raw)) {
    const entries = raw.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
    return mapFileChangesForTool(entries);
  }
  if (raw && typeof raw === "object") {
    return mapFileChangesObjectForTool(raw as Record<string, unknown>);
  }
  return [];
}

export function hasAnyPatchDiff(changes: ToolFileChange[]): boolean {
  return changes.some((change) => typeof change.diff === "string" && change.diff.trim().length > 0);
}

export interface CodexAgentMessageItem extends CodexItem {
  type: "agentMessage";
  text?: string;
}

export interface CodexCommandExecutionItem extends CodexItem {
  type: "commandExecution";
  command: string | string[];
  commandActions?: Array<{ command?: string }>;
  cwd?: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  exitCode?: number;
  durationMs?: number;
}

export interface CodexFileChangeItem extends CodexItem {
  type: "fileChange";
  changes?: Array<Record<string, unknown>> | Record<string, unknown>;
  status: "inProgress" | "completed" | "failed" | "declined";
}

export interface CodexMcpToolCallItem extends CodexItem {
  type: "mcpToolCall";
  server: string;
  tool: string;
  status: "inProgress" | "completed" | "failed";
  arguments?: Record<string, unknown>;
  result?: string;
  error?: string;
}

export interface CodexWebSearchItem extends CodexItem {
  type: "webSearch";
  query?: string;
  action?: { type?: string; url?: string; pattern?: string; query?: string; q?: string };
  result?: string;
  output?: string;
  summary?: string;
  results?: unknown[];
  searchResults?: unknown[];
}

export interface CodexImageViewItem extends CodexItem {
  type: "imageView";
  path?: string;
}

export interface CodexReasoningItem extends CodexItem {
  type: "reasoning";
  summary?: string;
  content?: string;
}

export interface CodexContextCompactionItem extends CodexItem {
  type: "contextCompaction";
}

export interface CodexCollabAgentToolCallItem extends CodexItem {
  type: "collabAgentToolCall";
  tool?: string;
  prompt?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  agentsStates?: unknown[];
  status?: "inProgress" | "completed" | "failed" | "declined";
  error?: unknown;
}

export interface PendingSubagentToolUse {
  prompt: string;
  startedAt: number;
  senderThreadId: string | null;
  parentToolUseId: string | null;
}

function formatWebSearchResultEntry(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const rec = entry as Record<string, unknown>;
  const title = toSafeText(rec.title ?? rec.name ?? "").trim();
  const url = toSafeText(rec.url ?? rec.link ?? "").trim();
  const snippet = toSafeText(rec.snippet ?? rec.description ?? rec.summary ?? "").trim();

  if (title && url) return `${title}\n${url}`;
  if (title && snippet) return `${title}\n${snippet}`;
  if (title) return title;
  if (url && snippet) return `${url}\n${snippet}`;
  if (url) return url;
  return snippet;
}

export function extractWebSearchResultText(item: CodexWebSearchItem): string {
  const directText = [item.result, item.output, item.summary]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join("\n")
    .trim();
  if (directText) return directText;

  const resultLists = [item.results, item.searchResults];
  for (const list of resultLists) {
    if (!Array.isArray(list)) continue;
    const lines = list.map((entry) => formatWebSearchResultEntry(entry)).filter((line) => line.length > 0);
    if (lines.length > 0) return lines.join("\n\n");
  }

  const actionUrl = item.action?.url;
  if (typeof actionUrl === "string" && actionUrl.trim()) return actionUrl.trim();

  return "Web search completed";
}

export function extractWebSearchQuery(item: CodexWebSearchItem): string {
  if (typeof item.query === "string" && item.query.trim()) return item.query.trim();
  if (typeof item.action?.query === "string" && item.action.query.trim()) return item.action.query.trim();
  if (typeof item.action?.q === "string" && item.action.q.trim()) return item.action.q.trim();
  if (typeof item.action?.pattern === "string" && item.action.pattern.trim()) return item.action.pattern.trim();
  return "";
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
    return raw.trim() ? { raw: raw.trim() } : {};
  }
  return {};
}

export interface CodexMcpServerStatus {
  name: string;
  tools?: Record<string, { name?: string; annotations?: unknown }>;
  authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
}

export interface CodexMcpStatusListResponse {
  data?: CodexMcpServerStatus[];
  nextCursor?: string | null;
}
