#!/usr/bin/env bun
/**
 * Questmaster CLI — standalone tool for managing quests.
 *
 * Imports quest-store.ts directly (no HTTP for data operations).
 * After mutations, notifies the Companion server so browsers refresh.
 *
 * Usage:  quest <command> [options]
 *
 * Commands:
 *   list       List all quests (latest versions)
 *   mine       List quests owned by current session
 *   show       Show full quest detail
 *   status     Show compact action-oriented quest status
 *   history    Show quest history (live or legacy backup)
 *   create     Create a new quest
 *   claim      Claim a quest for a session
 *   complete   Mark done and enter review inbox with checklist
 *   done       Mark quest as done
 *   cancel     Cancel a quest from any status
 *   transition Generic status transition
 *   edit       In-place edit (no new version)
 *   later      Move review-pending quest out of review inbox
 *   inbox      Move review-pending quest back to review inbox
 *   check      Toggle a verification checkbox
 *   feedback   Add a feedback entry to a quest's thread
 *   address    Toggle feedback addressed status
 *   delete     Delete a quest
 *   resize-image  Resize an image to fit within a max pixel dimension
 */

import {
  listQuests,
  getQuest,
  getQuestHistoryView,
  createQuest,
  claimQuest,
  completeQuest,
  markDone,
  cancelQuest,
  transitionQuest,
  patchQuest,
  checkVerificationItem,
  markQuestVerificationRead,
  markQuestVerificationInboxUnread,
  deleteQuest,
} from "../server/quest-store.js";
import type { QuestmasterTask } from "../server/quest-types.js";
import { hasQuestReviewMetadata, isQuestReviewInboxUnread } from "../server/quest-types.js";
import { applyQuestListFilters } from "../server/quest-list-filters.js";
import { grepQuests } from "../server/quest-grep.js";
import { getName } from "../server/session-names.js";
import { formatQuestDetail, formatQuestLine, formatSessionLabel } from "./quest-format.js";
import {
  normalizeTldr,
  preferredFeedbackPreview,
  tldrWarningForContent,
  QUEST_TLDR_WARNING_HEADER,
} from "../server/quest-tldr.js";
import {
  completionHygieneWarnings,
  feedbackAddWarnings,
  filterFeedbackEntries,
  formatFeedbackIndices,
  isAgentSummaryFeedback,
  latestAgentSummaryFeedback,
  latestFeedbackEntry,
  unaddressedHumanFeedbackEntries,
  type FeedbackAuthorFilter,
  type IndexedFeedbackEntry,
} from "./quest-feedback.js";
import { fetchSessionMetadataMap, type SessionMetadata } from "./quest-session-metadata.js";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { getSessionAuthDir, getSessionAuthFilePrefixes, parseSessionAuthFileData } from "../shared/session-auth.js";

const DEFAULT_PORT = 3456;
const COMPANION_SESSION_ID_HEADER = "x-companion-session-id";
const COMPANION_AUTH_TOKEN_HEADER = "x-companion-auth-token";

type CompanionCredentials = {
  sessionId: string;
  authToken: string;
  port?: number;
  serverId?: string;
};

function dedupeCompanionCredentials(candidates: CompanionCredentials[]): CompanionCredentials[] {
  const seen = new Set<string>();
  const deduped: CompanionCredentials[] = [];
  for (const candidate of candidates) {
    const key = [candidate.serverId || "", candidate.sessionId, candidate.authToken, candidate.port ?? ""].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

// ─── Arg parsing helpers ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
}

function options(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--")) {
      values.push(args[i + 1]);
      i++;
    }
  }
  return values;
}

/** Get positional arg at index (0-based, after the command). */
function positional(index: number): string | undefined {
  let pos = 0;
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // skip flag and its value if present
      if (args[i + 1] && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    if (pos === index) return args[i];
    pos++;
  }
  return undefined;
}

/**
 * Validate that all --flags in args are from the allowed set.
 * Rejects unknown flags with a helpful error message and "did you mean?" suggestions.
 */
function validateFlags(allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (allowedSet.has(name)) continue;

    // Find close matches for "did you mean?" suggestion
    const suggestions = allowed.filter((a) => {
      // Shared prefix of >= 3 chars
      if (a.startsWith(name.slice(0, 3)) || name.startsWith(a.slice(0, 3))) return true;
      // One contains the other
      if (a.includes(name) || name.includes(a)) return true;
      return false;
    });

    let msg = `Unknown flag: --${name}`;
    if (suggestions.length > 0) {
      msg += `. Did you mean: ${suggestions.map((s) => `--${s}`).join(", ")}?`;
    }
    msg += `\nValid flags: ${allowed.map((f) => `--${f}`).join(", ")}`;
    die(msg);
  }
}

const jsonOutput = flag("json");

// ─── Companion auth discovery ──────────────────────────────────────────────

/** Discover session credentials from env vars or session-auth file fallback. */
function getCredentials(): CompanionCredentials | null {
  const sessionId = process.env.COMPANION_SESSION_ID;
  const authToken = process.env.COMPANION_AUTH_TOKEN;
  const envPort = Number(process.env.COMPANION_PORT);
  const serverId = process.env.COMPANION_SERVER_ID?.trim();
  if (sessionId && authToken) {
    return {
      sessionId,
      authToken,
      ...(Number.isFinite(envPort) && envPort > 0 ? { port: envPort } : {}),
      ...(serverId ? { serverId } : {}),
    };
  }

  const cwd = process.cwd();
  const authDir = getSessionAuthDir();
  const prefixes = getSessionAuthFilePrefixes(cwd).map((prefix) => `${prefix}-`);

  let fileNames: string[] = [];
  try {
    fileNames = readdirSync(authDir);
  } catch {
    fileNames = [];
  }

  const candidates = fileNames
    .filter((name) => name.endsWith(".json") && prefixes.some((prefix) => name.startsWith(prefix)))
    .map((name) => {
      try {
        return parseSessionAuthFileData(JSON.parse(readFileSync(`${authDir}/${name}`, "utf-8")));
      } catch {
        return null;
      }
    })
    .filter((value): value is CompanionCredentials => value !== null);
  const uniqueCandidates = dedupeCompanionCredentials(candidates);

  if (uniqueCandidates.length > 0) {
    const envServerId = process.env.COMPANION_SERVER_ID?.trim();
    if (envServerId) {
      const serverMatches = uniqueCandidates.filter((candidate) => candidate.serverId === envServerId);
      if (serverMatches.length === 1) return serverMatches[0];
      if (serverMatches.length > 1) {
        die(
          `Multiple Companion auth contexts matched server ${envServerId} for ${cwd}. Refusing to guess which server to use.`,
        );
      }
    }

    const envSessionId = process.env.COMPANION_SESSION_ID?.trim();
    if (envSessionId) {
      const sessionMatches = uniqueCandidates.filter((candidate) => candidate.sessionId === envSessionId);
      if (sessionMatches.length === 1) return sessionMatches[0];
      if (sessionMatches.length > 1) {
        die(
          `Multiple Companion auth contexts matched session ${envSessionId} for ${cwd}. Refusing to guess which server to use.`,
        );
      }
    }

    if (Number.isFinite(envPort) && envPort > 0) {
      const portMatches = uniqueCandidates.filter((candidate) => candidate.port === envPort);
      if (portMatches.length === 1) return portMatches[0];
      if (portMatches.length > 1) {
        die(
          `Multiple Companion auth contexts matched port ${envPort} for ${cwd}. Refusing to guess which server to use.`,
        );
      }
    }

    if (uniqueCandidates.length === 1) return uniqueCandidates[0];
    die(
      `Multiple Companion auth contexts were found for ${cwd}. Refusing to guess which server to use. Relaunch this session to restore COMPANION_* env vars.`,
    );
  }

  const legacyCentral = (() => {
    for (const prefix of getSessionAuthFilePrefixes(cwd)) {
      try {
        const data = parseSessionAuthFileData(JSON.parse(readFileSync(`${authDir}/${prefix}.json`, "utf-8")));
        if (data) return data;
      } catch {
        // Try next candidate
      }
    }
    return null;
  })();
  if (legacyCentral) return legacyCentral;

  // Legacy fallback: auth files in the user's repo (for backwards compatibility)
  const legacyCandidates = [
    join(cwd, ".companion", "session-auth.json"),
    join(cwd, ".codex", "session-auth.json"),
    join(cwd, ".claude", "session-auth.json"),
  ];
  for (const authFile of legacyCandidates) {
    try {
      const data = parseSessionAuthFileData(JSON.parse(readFileSync(authFile, "utf-8")));
      if (data) return data;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

function getCurrentSessionId(): string | undefined {
  return getCredentials()?.sessionId || process.env.COMPANION_SESSION_ID || undefined;
}

function getCompanionPort(): string | undefined {
  if (process.env.COMPANION_PORT) return process.env.COMPANION_PORT;
  const creds = getCredentials();
  const credsPort = creds?.port;
  if (typeof credsPort === "number" && credsPort > 0) return String(credsPort);
  return creds ? String(DEFAULT_PORT) : undefined;
}

function companionAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const creds = getCredentials();
  if (!creds) return extra;
  return {
    [COMPANION_SESSION_ID_HEADER]: creds.sessionId,
    [COMPANION_AUTH_TOKEN_HEADER]: creds.authToken,
    ...extra,
  };
}

// ─── Server notification ────────────────────────────────────────────────────

async function notifyServer(): Promise<void> {
  const port = getCompanionPort();
  if (!port) return;
  try {
    await fetch(`http://localhost:${port}/api/quests/_notify`, {
      method: "POST",
      headers: companionAuthHeaders(),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Best effort — server may not be running
  }
}

// ─── Output helpers ─────────────────────────────────────────────────────────

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function compactSnippet(text: string, maxLen: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), maxLen);
}

function warn(message: string): void {
  console.error(`Warning: ${message}`);
}

function warnAll(messages: string[]): void {
  for (const message of messages) warn(message);
}

function tldrWarningsForWrite(kind: "description" | "feedback", text: unknown, tldr: unknown): string[] {
  const warning = tldrWarningForContent(kind, text, tldr);
  return warning ? [warning] : [];
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_LABELS: Record<string, string> = {
  idea: "idea",
  refined: "refined",
  in_progress: "in_progress",
  done: "done",
};

const VERIFICATION_FILTER_VALUES = new Set([
  "all",
  "verification",
  "needs_verification",
  "inbox",
  "unread",
  "new",
  "reviewed",
  "non-inbox",
  "non_inbox",
  "read",
  "acknowledged",
]);

function parseVerificationFilterTokens(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function requireReviewPendingQuest(quest: QuestmasterTask, questId: string, action: "later" | "inbox"): void {
  if (hasQuestReviewMetadata(quest)) return;
  die(`Quest ${questId} is ${quest.status}; quest ${action} only applies to quests under review.`);
}

const currentSessionId = getCurrentSessionId();
const companionPort = getCompanionPort();

let sessionMetadataCache: Map<string, SessionMetadata> | null = null;

async function getSessionMetadataMap(): Promise<Map<string, SessionMetadata>> {
  if (sessionMetadataCache) return sessionMetadataCache;
  sessionMetadataCache = await fetchSessionMetadataMap(companionPort, companionAuthHeaders());
  return sessionMetadataCache;
}

function die(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

type QuestImageRef = {
  id: string;
  filename: string;
  mimeType: string;
  path: string;
};

function guessMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function parseCommitShasFromFlags(): string[] {
  const raw = [
    ...options("commit"),
    ...options("commits").flatMap((group) => group.split(",").map((value) => value.trim())),
  ].filter(Boolean);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of raw) {
    const sha = value.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      die(`Invalid commit SHA: ${value}`);
    }
    if (seen.has(sha)) continue;
    seen.add(sha);
    result.push(sha);
  }
  return result;
}

function parsePositiveIntegerFlag(name: string, fallback: number, label: string): number {
  const value = option(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    die(`--${name} must be a positive integer for ${label}`);
  }
  return parsed;
}

function parseFeedbackAuthorFilter(): FeedbackAuthorFilter {
  const author = option("author") ?? "all";
  if (author === "human" || author === "agent" || author === "all") return author;
  die("--author must be one of: human, agent, all");
}

function humanFeedbackWarning(quest: QuestmasterTask): string | null {
  const unaddressed = unaddressedHumanFeedbackEntries(quest);
  if (unaddressed.length === 0) return null;
  return `unaddressed human feedback on ${quest.questId}: ${formatFeedbackIndices(unaddressed)}. Inspect with quest feedback list ${quest.questId} --unaddressed and mark resolved with quest address ${quest.questId} <index>.`;
}

function printHumanFeedbackWarning(quest: QuestmasterTask): void {
  const message = humanFeedbackWarning(quest);
  if (message) warn(message);
}

function feedbackEntryForJson(entry: IndexedFeedbackEntry): IndexedFeedbackEntry {
  return entry;
}

function formatFeedbackEntry(entry: IndexedFeedbackEntry, options: { full?: boolean } = {}): string {
  const state =
    entry.author === "human"
      ? entry.addressed
        ? "addressed"
        : "unaddressed"
      : isAgentSummaryFeedback(entry.text)
        ? "summary"
        : "comment";
  const text = options.full ? entry.text : compactSnippet(preferredFeedbackPreview(entry), 160);
  const imageNote = entry.images?.length
    ? ` (${entry.images.length} image${entry.images.length === 1 ? "" : "s"})`
    : "";
  return `#${entry.index} [${entry.author}, ${state}, ${timeAgo(entry.ts)}] ${text}${imageNote}`;
}

function formatStatusSummary(quest: QuestmasterTask, sessionMetadata?: Map<string, SessionMetadata>): string {
  const lines: string[] = [];
  const owner =
    "sessionId" in quest
      ? formatSessionLabel(quest.sessionId, sessionMetadata, { currentSessionId, getSessionName: getName })
      : "unclaimed";
  const verification =
    "verificationItems" in quest
      ? `${quest.verificationItems.filter((item) => item.checked).length}/${quest.verificationItems.length}`
      : "none";
  const inbox = hasQuestReviewMetadata(quest) ? (isQuestReviewInboxUnread(quest) ? "unread" : "acknowledged") : "n/a";
  const humanEntries = filterFeedbackEntries(quest, { author: "human" });
  const unaddressed = unaddressedHumanFeedbackEntries(quest);
  const latestSummary = latestAgentSummaryFeedback(quest);
  lines.push(`Quest ${quest.questId}: ${quest.title}`);
  lines.push(`Status:      ${STATUS_LABELS[quest.status] ?? quest.status}`);
  lines.push(`Owner:       ${owner}`);
  lines.push(`Verification:${verification}`);
  lines.push(`Inbox:       ${inbox}`);
  lines.push(
    `Commits:     ${quest.commitShas?.length ?? 0}${quest.commitShas?.length ? ` (${quest.commitShas.join(", ")})` : ""}`,
  );
  lines.push(`Human Feedback: ${humanEntries.length}`);
  lines.push(`Unaddressed: ${unaddressed.length ? formatFeedbackIndices(unaddressed) : "none"}`);
  lines.push(
    `Latest Summary: ${latestSummary ? `#${latestSummary.index} ${compactSnippet(preferredFeedbackPreview(latestSummary), 120)}` : "none"}`,
  );
  lines.push(`Next Action:  ${suggestNextQuestAction(quest)}`);
  return lines.join("\n");
}

function statusSummaryForJson(quest: QuestmasterTask): Record<string, unknown> {
  const humanEntries = filterFeedbackEntries(quest, { author: "human" });
  const unaddressed = unaddressedHumanFeedbackEntries(quest);
  const latestSummary = latestAgentSummaryFeedback(quest);
  return {
    questId: quest.questId,
    title: quest.title,
    status: quest.status,
    ownerSessionId: "sessionId" in quest ? quest.sessionId : null,
    verification:
      "verificationItems" in quest
        ? {
            checked: quest.verificationItems.filter((item) => item.checked).length,
            total: quest.verificationItems.length,
          }
        : { checked: 0, total: 0 },
    inbox: hasQuestReviewMetadata(quest) ? (isQuestReviewInboxUnread(quest) ? "unread" : "acknowledged") : null,
    commitCount: quest.commitShas?.length ?? 0,
    commitShas: quest.commitShas ?? [],
    humanFeedbackCount: humanEntries.length,
    unaddressedHumanFeedbackIndices: unaddressed.map((entry) => entry.index),
    latestSummary: latestSummary
      ? { index: latestSummary.index, text: latestSummary.text, tldr: latestSummary.tldr, ts: latestSummary.ts }
      : null,
    suggestedNextAction: suggestNextQuestAction(quest),
  };
}

function suggestNextQuestAction(quest: QuestmasterTask): string {
  const unaddressed = unaddressedHumanFeedbackEntries(quest);
  if (unaddressed.length > 0) return `address human feedback ${formatFeedbackIndices(unaddressed)}`;
  if (quest.status === "idea") return "refine the quest before dispatch";
  if (quest.status === "refined") return "claim the quest before implementation";
  if (quest.status === "in_progress")
    return "implement and add a consolidated Summary: feedback comment before handoff";
  if (hasQuestReviewMetadata(quest)) {
    return isQuestReviewInboxUnread(quest)
      ? "human review inbox triage"
      : "await final review or respond to new feedback";
  }
  if (quest.status === "done") return "no action";
  return "inspect quest details";
}

let stdinTextPromise: Promise<string> | null = null;
let stdinFlagName: string | null = null;

async function readStdinText(): Promise<string> {
  if (!stdinTextPromise) {
    process.stdin.setEncoding("utf8");
    stdinTextPromise = (async () => {
      let text = "";
      for await (const chunk of process.stdin) {
        text += chunk;
      }
      return text;
    })();
  }
  return stdinTextPromise;
}

async function readOptionTextFile(pathOrDash: string, flagName: string): Promise<string> {
  if (pathOrDash === "-") {
    if (stdinFlagName && stdinFlagName !== flagName) {
      die(
        `Only one option can read from stdin per command. Already using ${stdinFlagName}; cannot also use ${flagName}.`,
      );
    }
    stdinFlagName = flagName;
    return readStdinText();
  }

  try {
    return await readFile(resolve(pathOrDash), "utf-8");
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    die(`Cannot read ${flagName} input from ${pathOrDash}${detail}`);
  }
}

async function readOptionalRichTextOption(args: {
  inlineFlag: string;
  fileFlag: string;
  label: string;
  allowEmpty?: boolean;
}): Promise<string | undefined> {
  const inlineValue = option(args.inlineFlag);
  const fileValue = option(args.fileFlag);
  const hasInlineFlag = flag(args.inlineFlag);
  const hasFileFlag = flag(args.fileFlag);

  if (hasInlineFlag && inlineValue === undefined) {
    die(`--${args.inlineFlag} requires a value`);
  }
  if (hasFileFlag && fileValue === undefined) {
    die(`--${args.fileFlag} requires a path or '-' for stdin`);
  }
  if (inlineValue !== undefined && fileValue !== undefined) {
    die(`Use either --${args.inlineFlag} or --${args.fileFlag}, not both`);
  }

  const value =
    fileValue !== undefined
      ? await readOptionTextFile(fileValue, `--${args.fileFlag}`)
      : inlineValue !== undefined
        ? inlineValue
        : undefined;

  if (value !== undefined && !args.allowEmpty && !value.trim()) {
    die(`${args.label} is required`);
  }

  return value;
}

async function readRichTextOption(args: {
  inlineFlag: string;
  fileFlag: string;
  label: string;
  allowEmpty?: boolean;
}): Promise<string> {
  const value = await readOptionalRichTextOption(args);

  if (value === undefined) {
    die(
      `${args.label} is required. Use --${args.inlineFlag} for short inline text or ` +
        `--${args.fileFlag} <path> (or '-') for arbitrary rich text.`,
    );
  }

  if (!args.allowEmpty && !value.trim()) {
    die(`${args.label} is required`);
  }

  return value;
}

function parseVerificationItems(raw: string, sourceLabel: string): { text: string; checked: boolean }[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
      die(`Invalid JSON in ${sourceLabel}${detail}`);
    }
    if (!Array.isArray(parsed)) {
      die(`${sourceLabel} JSON input must be an array of strings or { text } objects`);
    }
    return parsed.map((entry, index) => {
      const text =
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string"
            ? entry.text
            : null;
      if (!text || !text.trim()) {
        die(`${sourceLabel} item ${index + 1} must be a non-empty string or object with a non-empty text field`);
      }
      return { text: text.trim(), checked: false };
    });
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ text, checked: false }));
}

async function uploadQuestImage(port: string, rawPath: string): Promise<QuestImageRef> {
  const filePath = resolve(rawPath);
  const data = await readFile(filePath);
  const form = new FormData();
  form.set("file", new File([data], basename(filePath), { type: guessMimeType(filePath) }));
  const res = await fetch(`http://localhost:${port}/api/quests/_images`, {
    method: "POST",
    headers: companionAuthHeaders(),
    body: form,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }
  return (await res.json()) as QuestImageRef;
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  validateFlags(["status", "tags", "tag", "session", "text", "verification", "json"]);
  const verification = option("verification");
  const verificationTokens = parseVerificationFilterTokens(verification);
  const invalidVerification = verificationTokens.filter((token) => !VERIFICATION_FILTER_VALUES.has(token));
  if (invalidVerification.length > 0) {
    die(
      `Invalid --verification value(s): ${invalidVerification.join(", ")}. ` +
        "Valid values: all, inbox, reviewed (aliases: verification, needs_verification, unread, new, non-inbox, non_inbox, read, acknowledged).",
    );
  }
  const quests = applyQuestListFilters(await listQuests(), {
    status: option("status"),
    tags: option("tags"),
    tag: option("tag"),
    session: option("session"),
    text: option("text"),
    verification,
  });
  const sessionMetadata = await getSessionMetadataMap();

  if (jsonOutput) {
    out(quests);
    return;
  }

  if (quests.length === 0) {
    console.log("No quests found.");
    return;
  }
  for (const q of quests) {
    console.log(formatQuestLine(q, sessionMetadata, { currentSessionId, getSessionName: getName }));
    const tldr = normalizeTldr((q as { tldr?: unknown }).tldr);
    if (tldr) {
      console.log(`       TLDR: ${compactSnippet(tldr, 120)}`);
    }
  }
}

async function cmdShow(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest show <questId>");

  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);

  if (jsonOutput) {
    out(quest);
    return;
  }
  const sessionMetadata = await getSessionMetadataMap();
  console.log(formatQuestDetail(quest, sessionMetadata, { currentSessionId, getSessionName: getName }));
  printHumanFeedbackWarning(quest);
}

async function cmdStatus(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest status <questId>");

  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);

  if (jsonOutput) {
    out(statusSummaryForJson(quest));
    return;
  }
  const sessionMetadata = await getSessionMetadataMap();
  console.log(formatStatusSummary(quest, sessionMetadata));
  printHumanFeedbackWarning(quest);
}

async function cmdGrep(): Promise<void> {
  validateFlags(["count", "json"]);
  const limit = parsePositiveIntegerFlag("count", 50, "match count");

  const flagConsumed = new Set<number>();
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    flagConsumed.add(i);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
      flagConsumed.add(i + 1);
      i += 1;
    }
  }

  const query = args
    .slice(1)
    .filter((_, index) => !flagConsumed.has(index + 1))
    .join(" ")
    .trim();

  if (!query) die("Usage: quest grep <pattern> [--count N] [--json]");

  const quests = await listQuests();
  let result;
  try {
    result = grepQuests(quests, query, { limit });
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (jsonOutput) {
    out(result);
    return;
  }

  if (result.totalMatches === 0) {
    console.log(`No quest matches for "${query}".`);
    if (result.warning) console.log(`Hint: ${result.warning}`);
    return;
  }

  const shown = result.matches.length;
  console.log(
    `${result.totalMatches} quest match${result.totalMatches === 1 ? "" : "es"} for "${query}"${shown < result.totalMatches ? ` (showing first ${shown})` : ""}:`,
  );
  console.log("");

  const groupedMatches = new Map<
    string,
    {
      questId: string;
      title: string;
      status: QuestmasterTask["status"];
      matches: (typeof result.matches)[number][];
    }
  >();
  for (const match of result.matches) {
    const existing = groupedMatches.get(match.questId);
    if (existing) {
      existing.matches.push(match);
      continue;
    }
    groupedMatches.set(match.questId, {
      questId: match.questId,
      title: match.title,
      status: match.status,
      matches: [match],
    });
  }

  const questById = new Map(quests.map((quest) => [quest.questId, quest] as const));

  for (const group of groupedMatches.values()) {
    const title = truncate(group.title, 48);
    const status = STATUS_LABELS[group.status] ?? group.status;
    const questLabel = `${group.questId.padEnd(6)} ${title}`;
    console.log(`  ${questLabel} (${status})`);
    for (const match of group.matches) {
      const parts = [match.matchedField];
      if (match.feedbackAuthor) parts.push(match.feedbackAuthor);
      const quest = questById.get(match.questId);
      const feedbackEntries =
        quest && "feedback" in quest ? (quest as { feedback?: Array<{ ts?: number }> }).feedback : undefined;
      const feedbackTs = match.feedbackIndex !== undefined ? feedbackEntries?.[match.feedbackIndex]?.ts : undefined;
      if (feedbackTs) parts.push(timeAgo(feedbackTs));
      console.log(`        ${parts.join(" | ")}`);
      console.log(`        ${compactSnippet(match.snippet, 96)}`);
    }
    console.log("");
  }

  if (result.warning) console.log(`Hint: ${result.warning}`);
}

async function cmdHistory(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest history <questId>");

  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);
  const history = await getQuestHistoryView(id);

  if (jsonOutput) {
    out(history);
    return;
  }

  if (history.mode === "legacy_backup") {
    console.log("Legacy backup history");
  } else if (history.mode === "unavailable") {
    console.log(history.message ?? "History is unavailable.");
    return;
  }

  if (history.entries.length === 0) {
    console.log(history.message ?? "No previous versions.");
    return;
  }

  for (const v of history.entries) {
    console.log(`v${v.version} (${STATUS_LABELS[v.status] ?? v.status}) -- ${timeAgo(v.createdAt)}  [${v.id}]`);
  }
}

async function cmdCreate(): Promise<void> {
  validateFlags(["title", "title-file", "desc", "desc-file", "tldr", "tldr-file", "tags", "image", "images", "json"]);
  const positionalTitle = positional(0);
  const title = await readOptionalRichTextOption({
    inlineFlag: "title",
    fileFlag: "title-file",
    label: "Quest title",
  });
  if (positionalTitle !== undefined && title !== undefined) {
    die("Use either a positional <title>, --title, or --title-file, not multiple title inputs");
  }
  const resolvedTitle = positionalTitle ?? title;
  if (!resolvedTitle) {
    die(
      'Usage: quest create [<title> | --title "..." | --title-file <path>|-] ' +
        '[--desc "..." | --desc-file <path>|-] [--tldr "..." | --tldr-file <path>|-] ' +
        '[--tags "t1,t2"] [--image <path>] [--images "p1,p2"]',
    );
  }

  const description = await readOptionalRichTextOption({
    inlineFlag: "desc",
    fileFlag: "desc-file",
    label: "Quest description",
  });
  const tldr = await readOptionalRichTextOption({
    inlineFlag: "tldr",
    fileFlag: "tldr-file",
    label: "Quest TLDR",
  });
  const normalizedTldr = normalizeTldr(tldr);
  const tagsStr = option("tags");
  const tags = tagsStr
    ? tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;
  const imagePaths = [
    ...options("image"),
    ...options("images").flatMap((group) => group.split(",").map((p) => p.trim())),
  ].filter(Boolean);

  try {
    const uploadedImages =
      imagePaths.length > 0
        ? (() => {
            const port = companionPort;
            if (!port) {
              die("Companion server port not found. Set COMPANION_PORT env var.");
            }
            return Promise.all(imagePaths.map((p) => uploadQuestImage(port, p)));
          })()
        : undefined;
    const resolvedImages = uploadedImages ? await uploadedImages : undefined;
    const quest = await createQuest({
      title: resolvedTitle,
      description,
      ...(normalizedTldr ? { tldr: normalizedTldr } : {}),
      tags,
      ...(resolvedImages?.length ? { images: resolvedImages } : {}),
    });
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      const imageNote = resolvedImages?.length ? `, ${resolvedImages.length} image(s)` : "";
      console.log(`Created ${quest.questId}: "${quest.title}" (${quest.status}${imageNote})`);
    }
    warnAll(tldrWarningsForWrite("description", description, normalizedTldr));
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdClaim(): Promise<void> {
  validateFlags(["session", "json"]);
  // Hard enforcement: leader sessions cannot claim quests (q-87)
  if (process.env.TAKODE_ROLE === "orchestrator") {
    die("Leader sessions cannot claim quests. Dispatch to a worker instead.");
  }
  const id = positional(0);
  if (!id) die("Usage: quest claim <questId> [--session <sid>]");

  const sessionId = option("session") || currentSessionId;
  if (!sessionId && !companionPort) {
    die("No session identity. Pass --session <id> or run from a Companion session.");
  }

  // Prefer HTTP endpoint when server is available — it handles session name
  // override, session_quest_claimed broadcast, and task entry addition.
  if (companionPort) {
    try {
      const res = await fetch(`http://localhost:${companionPort}/api/quests/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        headers: companionAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(sessionId ? { sessionId } : {}),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        die((err as { error: string }).error || res.statusText);
      }
      const quest = (await res.json()) as QuestmasterTask;
      if (jsonOutput) {
        out(quest);
      } else {
        const owner = "sessionId" in quest && typeof quest.sessionId === "string" ? quest.sessionId : sessionId;
        console.log(
          `Claimed ${quest.questId} "${quest.title}" for session ${formatSessionLabel(owner || "unknown", undefined, {
            currentSessionId,
            getSessionName: getName,
          })}`,
        );
        printHumanFeedbackWarning(quest);
      }
      return;
    } catch (e) {
      die(`Failed to claim via Companion server: ${(e as Error).message}`);
    }
  }

  // Fallback: direct filesystem claim (no session name integration)
  if (!sessionId) {
    die("No session identity. Pass --session <id> or run from a Companion session.");
  }
  try {
    const quest = await claimQuest(id, sessionId);
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(
        `Claimed ${quest.questId} "${quest.title}" for session ${formatSessionLabel(sessionId, undefined, {
          currentSessionId,
          getSessionName: getName,
        })}`,
      );
      printHumanFeedbackWarning(quest);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdComplete(): Promise<void> {
  validateFlags(["items", "items-file", "commit", "commits", "no-code", "session", "json"]);
  const id = positional(0);
  if (!id) {
    die(
      'Usage: quest complete <questId> [--items "check1,check2" | --items-file <path>|-] ' +
        '[--no-code] [--session <sid>] [--commit <sha>] [--commits "sha1,sha2"]',
    );
  }

  if (flag("items") && option("items") === undefined) {
    die("--items requires a comma-separated value");
  }
  if (flag("items-file") && option("items-file") === undefined) {
    die("--items-file requires a path or '-' for stdin");
  }
  const commitShas = parseCommitShasFromFlags();
  const noCode = flag("no-code");
  if (noCode && commitShas.length > 0) {
    die("--no-code cannot be combined with --commit/--commits");
  }
  const inlineItems = option("items");
  const itemsFile = option("items-file");
  if (inlineItems !== undefined && itemsFile !== undefined) {
    die("Use either --items or --items-file, not both");
  }
  const targetSessionId = option("session")?.trim();
  if (flag("session") && !targetSessionId) {
    die("--session requires a session id");
  }

  let items: { text: string; checked: boolean }[] = [];
  if (itemsFile !== undefined) {
    const rawItems = await readOptionTextFile(itemsFile, "--items-file");
    items = parseVerificationItems(rawItems, "--items-file");
  } else if (inlineItems) {
    items = inlineItems
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text) => ({ text, checked: false }));
  }
  if (items.length === 0) {
    console.error(
      "Warning: quest submitted for verification without verification items. " +
        "Consider adding --items for simple inline lists or --items-file <path> / --items-file - for richer input.",
    );
  }
  const currentQuest = await getQuest(id);
  if (currentQuest) {
    warnAll(completionHygieneWarnings(currentQuest, items, commitShas));
  }

  // Prefer HTTP endpoint when server is available — it broadcasts quest status
  // change to browsers (triggers "Quest Submitted" chat message + review badge).
  if (companionPort) {
    try {
      const res = await fetch(`http://localhost:${companionPort}/api/quests/${encodeURIComponent(id)}/complete`, {
        method: "POST",
        headers: companionAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          verificationItems: items,
          ...(targetSessionId ? { sessionId: targetSessionId } : {}),
          ...(commitShas.length > 0 ? { commitShas } : {}),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        die((err as { error: string }).error || res.statusText);
      }
      const quest = (await res.json()) as QuestmasterTask;
      if (jsonOutput) {
        out(quest);
      } else {
        console.log(`Completed ${quest.questId} "${quest.title}" with ${items.length} verification items`);
        console.log(formatCompletionReminder(quest.questId, { noCode }));
      }
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError" || (e as Error).message?.includes("timeout")) {
        // Server unreachable — fall through to direct filesystem
      } else {
        die((e as Error).message);
      }
    }
  }

  // Fallback: direct filesystem (no browser notification)
  try {
    const quest = await completeQuest(
      id,
      items,
      commitShas.length > 0 || targetSessionId
        ? { commitShas, ...(targetSessionId ? { sessionId: targetSessionId } : {}) }
        : undefined,
    );
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Completed ${quest.questId} "${quest.title}" with ${items.length} verification items`);
      console.log(formatCompletionReminder(quest.questId, { noCode }));
    }
  } catch (e) {
    die((e as Error).message);
  }
}

function formatCompletionReminder(questId: string, options: { noCode: boolean }): string {
  const summaryLine =
    `Reminder: keep one substantive user-oriented quest summary comment up to date with ` +
    `\`quest feedback ${questId} --text "Summary: <what changed, why it matters, and what verification passed>"\`` +
    ` before reporting that the quest is ready. Use \`--text-file <path>\` or \`--text-file -\`` +
    ` when that summary includes copied logs, backticks, or other shell-like text. Put implementation details and automated verification results in that summary, not in \`quest complete --items\`. Avoid review/rework timelines unless essential.`;
  if (options.noCode) {
    return (
      summaryLine +
      " You used `--no-code` for this local CLI handoff, so do not add port commentary or synced SHA placeholders. Only use `--no-code` when the quest produced zero git-tracked changes."
    );
  }
  return (
    summaryLine +
    " Use `--commit/--commits` structured metadata for routine port info, including docs, skills, prompts, templates, and other text-only tracked-file commits; only add a second prose port comment when the port was exceptional."
  );
}

async function cmdDone(): Promise<void> {
  validateFlags(["notes", "notes-file", "cancelled", "json"]);
  const id = positional(0);
  if (!id) die('Usage: quest done <questId> [--notes "..." | --notes-file <path>|-] [--cancelled]');

  const notes = await readOptionalRichTextOption({
    inlineFlag: "notes",
    fileFlag: "notes-file",
    label: "Closure notes",
  });
  const cancelled = flag("cancelled");

  try {
    const quest = await markDone(id, { notes, cancelled });
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      const verb = cancelled ? "Cancelled" : "Marked done";
      console.log(`${verb} ${quest.questId} "${quest.title}"`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdCancel(): Promise<void> {
  validateFlags(["notes", "notes-file", "json"]);
  const id = positional(0);
  if (!id) die('Usage: quest cancel <id> [--notes "reason" | --notes-file <path>|-] [--json]');

  const notes = await readOptionalRichTextOption({
    inlineFlag: "notes",
    fileFlag: "notes-file",
    label: "Cancellation reason",
  });

  try {
    const quest = await cancelQuest(id, notes);
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Cancelled ${quest.questId} "${quest.title}"`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdTransition(): Promise<void> {
  validateFlags(["status", "desc", "desc-file", "tldr", "tldr-file", "session", "commit", "commits", "json"]);
  const id = positional(0);
  if (!id)
    die(
      'Usage: quest transition <questId> --status <s> [--desc "..." | --desc-file <path>|-] ' +
        '[--tldr "..." | --tldr-file <path>|-]',
    );

  const status = option("status");
  if (!status) die("--status is required");
  if (status === "needs_verification" || status === "verification") {
    die(
      "needs_verification is no longer a lifecycle transition target. Use `quest complete` for review handoff or `quest list --verification ...` for review filters.",
    );
  }

  const description = await readOptionalRichTextOption({
    inlineFlag: "desc",
    fileFlag: "desc-file",
    label: "Quest description",
  });
  const tldr = await readOptionalRichTextOption({
    inlineFlag: "tldr",
    fileFlag: "tldr-file",
    label: "Quest TLDR",
  });
  const normalizedTldr = normalizeTldr(tldr);
  const sessionId = option("session") || currentSessionId;
  const commitShas = parseCommitShasFromFlags();
  if (commitShas.length > 0 && status !== "done") {
    die("--commit/--commits can only be used when completing a quest");
  }

  try {
    const quest = await transitionQuest(id, {
      status: status as import("../server/quest-types.js").QuestStatus,
      ...(description !== undefined ? { description } : {}),
      ...(tldr !== undefined ? { tldr: normalizedTldr ?? "" } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(commitShas.length > 0 ? { commitShas } : {}),
    });
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Transitioned ${quest.questId} to ${quest.status}`);
    }
    warnAll(tldrWarningsForWrite("description", description, normalizedTldr));
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdLater(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest later <questId>");

  if (companionPort) {
    try {
      const res = await fetch(
        `http://localhost:${companionPort}/api/quests/${encodeURIComponent(id)}/verification/read`,
        {
          method: "POST",
          headers: companionAuthHeaders(),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        die((err as { error: string }).error || res.statusText);
      }
      const quest = (await res.json()) as QuestmasterTask;
      requireReviewPendingQuest(quest, id, "later");
      if (jsonOutput) {
        out(quest);
      } else {
        console.log(`Marked ${quest.questId} as acknowledged (left Review Inbox, stays under review)`);
      }
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError" || (e as Error).message?.includes("timeout")) {
        // Server unreachable — fall through to direct filesystem.
      } else {
        die((e as Error).message);
      }
    }
  }

  try {
    const quest = await markQuestVerificationRead(id);
    if (!quest) die(`Quest ${id} not found`);
    requireReviewPendingQuest(quest, id, "later");
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Marked ${quest.questId} as acknowledged (left Review Inbox, stays under review)`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdInbox(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest inbox <questId>");

  if (companionPort) {
    try {
      const res = await fetch(
        `http://localhost:${companionPort}/api/quests/${encodeURIComponent(id)}/verification/inbox`,
        {
          method: "POST",
          headers: companionAuthHeaders(),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        die((err as { error: string }).error || res.statusText);
      }
      const quest = (await res.json()) as QuestmasterTask;
      requireReviewPendingQuest(quest, id, "inbox");
      if (jsonOutput) {
        out(quest);
      } else {
        console.log(`Moved ${quest.questId} back to Review Inbox`);
      }
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError" || (e as Error).message?.includes("timeout")) {
        // Server unreachable — fall through to direct filesystem.
      } else {
        die((e as Error).message);
      }
    }
  }

  try {
    const quest = await markQuestVerificationInboxUnread(id);
    if (!quest) die(`Quest ${id} not found`);
    requireReviewPendingQuest(quest, id, "inbox");
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Moved ${quest.questId} back to Review Inbox`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdEdit(): Promise<void> {
  validateFlags(["title", "title-file", "desc", "desc-file", "tldr", "tldr-file", "tags", "json"]);
  const id = positional(0);
  if (!id) {
    die(
      'Usage: quest edit <questId> [--title "..." | --title-file <path>|-] ' +
        '[--desc "..." | --desc-file <path>|-] [--tldr "..." | --tldr-file <path>|-] [--tags "t1,t2"]',
    );
  }

  const title = await readOptionalRichTextOption({
    inlineFlag: "title",
    fileFlag: "title-file",
    label: "Quest title",
  });
  const description = await readOptionalRichTextOption({
    inlineFlag: "desc",
    fileFlag: "desc-file",
    label: "Quest description",
  });
  const tldr = await readOptionalRichTextOption({
    inlineFlag: "tldr",
    fileFlag: "tldr-file",
    label: "Quest TLDR",
  });
  const normalizedTldr = normalizeTldr(tldr);
  const tagsStr = option("tags");
  const tags = tagsStr
    ? tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  if (title === undefined && description === undefined && tldr === undefined && tags === undefined) {
    die("At least one of --title/--title-file, --desc/--desc-file, --tldr/--tldr-file, or --tags is required");
  }

  try {
    const quest = await patchQuest(id, {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(tldr !== undefined ? { tldr: normalizedTldr ?? "" } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Updated ${quest.questId} "${quest.title}"`);
    }
    warnAll(tldrWarningsForWrite("description", description, normalizedTldr));
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdCheck(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  const indexStr = positional(1);
  if (!id || indexStr === undefined) die("Usage: quest check <questId> <index>");

  const index = Number(indexStr);
  if (Number.isNaN(index)) die("Index must be a number");

  // Toggle: read current state and flip it
  const current = await getQuest(id);
  if (!current) die(`Quest ${id} not found`);
  if (!("verificationItems" in current)) die("Quest has no verification items");
  const items = (current as { verificationItems: { checked: boolean }[] }).verificationItems;
  if (index < 0 || index >= items.length) die(`Index ${index} out of range (0-${items.length - 1})`);
  const newChecked = !items[index].checked;

  try {
    const quest = await checkVerificationItem(id, index, newChecked);
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      const item = (quest as { verificationItems: { text: string; checked: boolean }[] }).verificationItems[index];
      console.log(`[${item.checked ? "x" : " "}] ${item.text}`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdFeedback(): Promise<void> {
  const subcommand = positional(0);
  if (subcommand === "list") return cmdFeedbackList();
  if (subcommand === "latest") return cmdFeedbackLatest();
  if (subcommand === "show") return cmdFeedbackShow();
  if (subcommand === "add") return cmdFeedbackAdd({ explicitAdd: true });
  return cmdFeedbackAdd({ explicitAdd: false });
}

async function cmdFeedbackList(): Promise<void> {
  validateFlags(["last", "author", "unaddressed", "json"]);
  const id = positional(1);
  if (!id) die("Usage: quest feedback list <questId> [--last N] [--author human|agent|all] [--unaddressed] [--json]");
  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);
  if (flag("last") && option("last") === undefined) die("--last requires a positive integer value");
  const last = flag("last") ? parsePositiveIntegerFlag("last", 10, "feedback entries") : undefined;
  const entries = filterFeedbackEntries(quest, {
    author: parseFeedbackAuthorFilter(),
    unaddressed: flag("unaddressed"),
    ...(last !== undefined ? { last } : {}),
  });
  if (jsonOutput) {
    out(entries.map(feedbackEntryForJson));
    return;
  }
  if (entries.length === 0) {
    console.log(`No feedback entries found for ${quest.questId}.`);
    return;
  }
  for (const entry of entries) {
    console.log(formatFeedbackEntry(entry));
  }
}

async function cmdFeedbackLatest(): Promise<void> {
  validateFlags(["author", "unaddressed", "full", "json"]);
  const id = positional(1);
  if (!id) die("Usage: quest feedback latest <questId> [--author human|agent|all] [--unaddressed] [--full] [--json]");
  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);
  const entry = latestFeedbackEntry(quest, {
    author: parseFeedbackAuthorFilter(),
    unaddressed: flag("unaddressed"),
  });
  if (jsonOutput) {
    out(entry ? feedbackEntryForJson(entry) : null);
    return;
  }
  if (!entry) {
    console.log(`No matching feedback entries found for ${quest.questId}.`);
    return;
  }
  console.log(formatFeedbackEntry(entry, { full: flag("full") }));
}

async function cmdFeedbackShow(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(1);
  const indexStr = positional(2);
  if (!id || indexStr === undefined) die("Usage: quest feedback show <questId> <index> [--json]");
  const index = Number(indexStr);
  if (!Number.isInteger(index) || index < 0) die("Index must be a non-negative integer");
  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);
  const entry = filterFeedbackEntries(quest).find((candidate) => candidate.index === index);
  if (!entry) die(`Feedback index ${index} out of range`);
  if (jsonOutput) {
    out(feedbackEntryForJson(entry));
    return;
  }
  console.log(formatFeedbackEntry(entry, { full: true }));
  if (entry.images?.length) {
    for (const img of entry.images) {
      console.log(`  ${img.filename} -> ${img.path}`);
    }
  }
}

async function cmdFeedbackAdd(addOptions: { explicitAdd: boolean }): Promise<void> {
  validateFlags(["text", "text-file", "tldr", "tldr-file", "author", "session", "image", "images", "json"]);
  const id = positional(addOptions.explicitAdd ? 1 : 0);
  if (!id) {
    die(
      'Usage: quest feedback <questId> (--text "..." | --text-file <path>|-) ' +
        '[--tldr "..." | --tldr-file <path>|-] [--author agent|human] [--session <sid>] ' +
        '[--image <path>] [--images "p1,p2"]',
    );
  }

  const text = await readRichTextOption({
    inlineFlag: "text",
    fileFlag: "text-file",
    label: "Feedback text",
  });
  const tldr = await readOptionalRichTextOption({
    inlineFlag: "tldr",
    fileFlag: "tldr-file",
    label: "Feedback TLDR",
  });
  const normalizedTldr = normalizeTldr(tldr);

  const authorOpt = option("author");
  const author = authorOpt === "human" ? "human" : "agent";
  const sessionId = option("session") || currentSessionId;
  if (author === "agent" && !sessionId) {
    die("Agent feedback requires --session <sid> or Companion session auth.");
  }
  const imagePaths = [
    ...options("image"),
    ...options("images").flatMap((group) => group.split(",").map((p) => p.trim())),
  ].filter(Boolean);

  const port = companionPort;
  if (!port) {
    die("Companion server port not found. Set COMPANION_PORT env var.");
  }

  try {
    const before = await getQuest(id);
    const uploadedImages =
      imagePaths.length > 0 ? await Promise.all(imagePaths.map((p) => uploadQuestImage(port, p))) : undefined;
    const res = await fetch(`http://localhost:${port}/api/quests/${encodeURIComponent(id)}/feedback`, {
      method: "POST",
      headers: companionAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        text: text.trim(),
        ...(normalizedTldr ? { tldr: normalizedTldr } : {}),
        author,
        ...(author === "agent" && sessionId ? { sessionId } : {}),
        ...(uploadedImages?.length ? { images: uploadedImages } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      die((err as { error: string }).error || res.statusText);
    }
    const quest = (await res.json()) as QuestmasterTask;
    const tldrHeaderWarning = res.headers.get(QUEST_TLDR_WARNING_HEADER);
    const mutationWarnings = feedbackAddWarnings({ before, after: quest, author, text: text.trim() });
    const tldrWarnings = tldrHeaderWarning
      ? [tldrHeaderWarning]
      : author === "agent"
        ? tldrWarningsForWrite("feedback", text, normalizedTldr)
        : [];
    if (jsonOutput) {
      out(quest);
      warnAll([...mutationWarnings, ...tldrWarnings]);
    } else {
      const entries = "feedback" in quest ? (quest as { feedback?: { author: string; text: string }[] }).feedback : [];
      const imageNote = uploadedImages?.length ? `, ${uploadedImages.length} image(s)` : "";
      console.log(`Added feedback to ${quest.questId} (${entries?.length ?? 0} entries total${imageNote})`);
      warnAll([...mutationWarnings, ...tldrWarnings]);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdAddress(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  const indexStr = positional(1);
  if (!id || indexStr === undefined) die("Usage: quest address <questId> <index>");

  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0) die("Invalid index");

  const port = companionPort;
  if (!port) {
    die("Companion server port not found. Set COMPANION_PORT env var.");
  }

  try {
    const res = await fetch(
      `http://localhost:${port}/api/quests/${encodeURIComponent(id)}/feedback/${index}/addressed`,
      {
        method: "POST",
        headers: companionAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      die((err as { error: string }).error || res.statusText);
    }
    const quest = (await res.json()) as QuestmasterTask;
    const unaddressed = unaddressedHumanFeedbackEntries(quest);
    if (jsonOutput) {
      out(quest);
      if (unaddressed.length > 0) {
        warn(`remaining unaddressed human feedback: ${formatFeedbackIndices(unaddressed)}.`);
      }
    } else {
      const fb = "feedback" in quest ? (quest as { feedback?: { addressed?: boolean }[] }).feedback : [];
      const entry = fb?.[index];
      console.log(`Feedback #${index} on ${quest.questId}: ${entry?.addressed ? "addressed" : "unaddressed"}`);
      if (unaddressed.length > 0) {
        warn(`remaining unaddressed human feedback: ${formatFeedbackIndices(unaddressed)}.`);
      }
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdMine(): Promise<void> {
  validateFlags(["json"]);
  if (!currentSessionId) die("No current session identity found.");

  const quests = (await listQuests()).filter(
    (q) => "sessionId" in q && (q as { sessionId?: string }).sessionId === currentSessionId,
  );

  if (jsonOutput) {
    out(quests);
    return;
  }

  if (quests.length === 0) {
    console.log("No quests owned by this session.");
    return;
  }

  for (const q of quests) {
    console.log(formatQuestLine(q, undefined, { currentSessionId, getSessionName: getName }));
  }
}

async function cmdDelete(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest delete <questId>");

  const deleted = await deleteQuest(id);
  if (!deleted) die(`Quest ${id} not found`);
  await notifyServer();
  if (jsonOutput) {
    out({ deleted: true, questId: id });
  } else {
    console.log(`Deleted ${id}`);
  }
}

async function cmdResizeImage(): Promise<void> {
  validateFlags(["max-dim", "json"]);
  const imagePath = positional(0);
  if (!imagePath) die("Usage: quest resize-image <path> [--max-dim 1920]");

  const maxDimStr = option("max-dim");
  const maxDim = maxDimStr ? Number(maxDimStr) : 1920;
  if (!Number.isFinite(maxDim) || maxDim < 1) die("--max-dim must be a positive integer");

  const sharp = (await import("sharp")).default;
  const { readFile, writeFile } = await import("node:fs/promises");

  let buf: Buffer;
  try {
    buf = (await readFile(imagePath)) as Buffer;
  } catch {
    die(`Cannot read file: ${imagePath}`);
  }

  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) die("Could not read image dimensions");

  if (meta.width <= maxDim && meta.height <= maxDim) {
    if (jsonOutput) {
      out({ resized: false, width: meta.width, height: meta.height, path: imagePath });
    } else {
      console.log(`Already within ${maxDim}px: ${meta.width}×${meta.height}  ${imagePath}`);
    }
    return;
  }

  const resized = await sharp(buf)
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .toBuffer();
  await writeFile(imagePath, resized);
  const after = await sharp(resized).metadata();

  if (jsonOutput) {
    out({
      resized: true,
      before: { width: meta.width, height: meta.height, bytes: buf.length },
      after: { width: after.width, height: after.height, bytes: resized.length },
      path: imagePath,
    });
  } else {
    console.log(
      `Resized: ${meta.width}×${meta.height} → ${after.width}×${after.height}  ` +
        `(${(buf.length / 1024).toFixed(0)}KB → ${(resized.length / 1024).toFixed(0)}KB)  ${imagePath}`,
    );
  }
}

async function cmdTags(): Promise<void> {
  validateFlags(["json"]);
  const quests = await listQuests();
  const tagCounts = new Map<string, number>();
  for (const q of quests) {
    if (q.tags) {
      for (const tag of q.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }

  if (jsonOutput) {
    out(Object.fromEntries(tagCounts));
    return;
  }

  if (tagCounts.size === 0) {
    console.log("No tags found.");
    return;
  }
  // Sort by count desc, then alpha
  const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [tag, count] of sorted) {
    console.log(`  ${tag} (${count})`);
  }
}

// ─── Help ───────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`Questmaster CLI

Usage: quest <command> [options]

Commands:
  list   [--status <s1,s2>] [--tag <t>] [--tags "t1,t2"] [--session <sid>] [--text <q>] [--verification <scope>] [--json]
                                                         List quests with optional filters
  mine   [--json]                                        List quests owned by current session
  grep   <pattern> [--count N] [--json]                  Search inside quest title, description, and feedback/comments with snippets
  show   <id> [--json]                                   Show quest detail
  status <id> [--json]                                   Show compact action-oriented quest status
  history <id> [--json]                                  Show quest history
  tags   [--json]                                        List all existing tags with counts
  create [<title> | --title "..." | --title-file <path>|-] [--desc "..." | --desc-file <path>|-] [--tldr "..." | --tldr-file <path>|-] [--tags "t1,t2"] [--image <path>] [--images "p1,p2"] [--json]
                                                         Create a quest
  claim  <id> [--session <sid>] [--json]                 Claim for session
  complete <id> [--items "c1,c2" | --items-file <path>|-] [--session <sid>] [--commit <sha>] [--commits "s1,s2"] [--json]
                                                         Mark done and submit for review
  done   <id> [--notes "..." | --notes-file <path>|-] [--cancelled] [--json]
                                                         Mark as done/cancelled
  cancel <id> [--notes "reason" | --notes-file <path>|-] [--json]
                                                         Cancel from any status
  transition <id> --status <s> [--desc "..." | --desc-file <path>|-] [--tldr "..." | --tldr-file <path>|-] [--commit <sha>] [--commits "s1,s2"] [--json]
                                                         Change status
  later  <id> [--json]                                   Move review-pending quest out of inbox
  inbox  <id> [--json]                                   Move review-pending quest back to inbox
  edit   <id> [--title "..." | --title-file <path>|-] [--desc "..." | --desc-file <path>|-] [--tldr "..." | --tldr-file <path>|-] [--tags "t1,t2"] [--json]
                                                         Edit in place
  check  <id> <index> [--json]                           Toggle verification item
  feedback <id> [--text "..." | --text-file <path>|-] [--tldr "..." | --tldr-file <path>|-] [--author agent|human] [--session <sid>] [--image <path>] [--images "p1,p2"] [--json]
                                                         Add feedback entry
  feedback add <id> [--text "..." | --text-file <path>|-] [--tldr "..." | --tldr-file <path>|-] [--author agent|human] [--session <sid>] [--image <path>] [--images "p1,p2"] [--json]
                                                         Add feedback entry explicitly
  feedback list <id> [--last N] [--author human|agent|all] [--unaddressed] [--json]
                                                         List indexed feedback entries
  feedback latest <id> [--author human|agent|all] [--unaddressed] [--full] [--json]
                                                         Show latest matching feedback entry
  feedback show <id> <index> [--json]                    Show one indexed feedback entry
  address <id> <index> [--json]                          Toggle feedback addressed status
  delete <id> [--json]                                   Delete quest
  resize-image <path> [--max-dim 1920] [--json]          Resize an image to fit within max dimension

Environment:
  COMPANION_SESSION_ID  Session ID (auto-set by Companion)
  COMPANION_AUTH_TOKEN  Session auth token (auto-set by Companion)
  COMPANION_PORT        Server port for browser notifications

Auth fallback:
  .companion/session-auth.json (or legacy .codex/.claude paths)

Verification scopes:
  --verification inbox      done quests in Review Inbox
  --verification reviewed   done quests acknowledged and still under review
  --verification all        all done quests still under review

Search tips:
  quest list --text "foo"   Filter quests broadly by text
  quest grep "foo|bar"      Search inside quest text/comments with contextual snippets

Safer rich-text input:
  quest create --title-file title.txt --desc-file body.md
  quest create --title-file title.txt --desc-file body.md --tldr-file summary.txt
  printf '%s\\n' 'Copied \`$(snippet)\` stays literal' | quest create "Quest title" --desc-file -
  quest edit q-1 --desc-file body.md
  quest feedback q-1 --text-file note.md --tldr "Short human-readable summary"
  quest feedback latest q-1 --author human --unaddressed --full
  quest feedback show q-1 0
  printf '%s\\n' 'Line 1' '\`$(nope)\`' | quest feedback q-1 --text-file -
  quest complete q-1 --items-file items.txt
  printf '%s\\n' 'Review comma-heavy item, "quotes", {braces}' | quest complete q-1 --items-file -
  quest done q-1 --notes-file closeout.md
  printf '%s\\n' 'Superseded by q-2 with copied \`$(note)\` text' | quest cancel q-1 --notes-file -`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  switch (command) {
    case "list":
      return cmdList();
    case "mine":
      return cmdMine();
    case "grep":
      return cmdGrep();
    case "show":
      return cmdShow();
    case "status":
      return cmdStatus();
    case "history":
      return cmdHistory();
    case "tags":
      return cmdTags();
    case "create":
      return cmdCreate();
    case "claim":
      return cmdClaim();
    case "complete":
      return cmdComplete();
    case "done":
      return cmdDone();
    case "cancel":
      return cmdCancel();
    case "transition":
      return cmdTransition();
    case "later":
      return cmdLater();
    case "inbox":
      return cmdInbox();
    case "edit":
      return cmdEdit();
    case "check":
      return cmdCheck();
    case "feedback":
      return cmdFeedback();
    case "address":
      return cmdAddress();
    case "delete":
      return cmdDelete();
    case "resize-image":
      return cmdResizeImage();
    case "help":
    case "--help":
    case "-h":
    case undefined:
      showHelp();
      return;
    default:
      die(`Unknown command: ${command}. Run 'quest help' for usage.`);
  }
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
