export type ThreadRouteTarget = {
  threadKey: string;
  questId?: string;
};

export type ThreadRouteParseResult =
  | { ok: true; target: ThreadRouteTarget; body: string }
  | { ok: false; reason: "missing" | "invalid"; marker?: string; body: string };

const TEXT_THREAD_MARKER_RE = /^\[thread:(main|q-\d+)\](?=$|[ \t]|\r?\n)/;
const COMMAND_THREAD_COMMENT_RE = /^#\s*thread:(main|q-\d+)\s*$/;
const QUEST_MENTION_RE = /\bq-\d+\b/gi;
const LEADING_QUEST_TARGET_RE = /^(?:work on|advance|review|reopen)\b/i;

export function isQuestThreadKey(threadKey: string): boolean {
  return /^q-\d+$/.test(threadKey);
}

export function normalizeThreadTarget(raw: string): ThreadRouteTarget | null {
  const threadKey = raw.trim().toLowerCase();
  if (threadKey === "main") return { threadKey };
  if (isQuestThreadKey(threadKey)) return { threadKey, questId: threadKey };
  return null;
}

export function inferThreadTargetFromTextContent(text: string): ThreadRouteTarget | null {
  const uniqueQuestIds = uniqueQuestMentions(text);
  if (uniqueQuestIds.length === 1) {
    return normalizeThreadTarget(uniqueQuestIds[0]);
  }

  const leadingLine = firstLeadingQuestTargetLine(text);
  if (!leadingLine) return null;

  const leadingQuestIds = uniqueQuestMentions(leadingLine);
  if (leadingQuestIds.length !== 1) return null;
  return normalizeThreadTarget(leadingQuestIds[0]);
}

export function formatThreadMarker(threadKey: string): string {
  return `[thread:${threadKey}]`;
}

export function parseThreadTextPrefix(text: string): ThreadRouteParseResult {
  const markerStart = firstNonWhitespaceIndex(text);
  if (markerStart === null) return { ok: false, reason: "missing", body: text };

  const candidate = text.slice(markerStart);
  const match = TEXT_THREAD_MARKER_RE.exec(candidate);
  if (!match) {
    const markerLike = candidate.toLowerCase().startsWith("[thread:") ? extractThreadMarkerLike(candidate) : undefined;
    return { ok: false, reason: markerLike ? "invalid" : "missing", marker: markerLike, body: text };
  }

  const target = normalizeThreadTarget(match[1]);
  const marker = match[0];
  if (!target) return { ok: false, reason: "invalid", marker, body: text };
  return { ok: true, target, body: removeSingleThreadMarkerSeparator(candidate.slice(marker.length)) };
}

export function parseCommandThreadComment(command: string): ThreadRouteTarget | null {
  const lines = command.split(/\r?\n/);
  const first = firstNonEmptyLine(lines);
  if (!first) return null;
  const match = COMMAND_THREAD_COMMENT_RE.exec(first.text);
  return match ? normalizeThreadTarget(match[1]) : null;
}

export function stripCommandThreadComment(command: string): string {
  const lines = command.split(/\r?\n/);
  const first = firstNonEmptyLine(lines);
  if (!first || !COMMAND_THREAD_COMMENT_RE.test(first.text)) return command;
  return removeLineAt(lines, first.index);
}

function firstNonEmptyLine(lines: string[]): { index: number; text: string } | null {
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]?.trim() ?? "";
    if (text) return { index, text };
  }
  return null;
}

function firstNonWhitespaceIndex(text: string): number | null {
  const match = /\S/.exec(text);
  return match ? match.index : null;
}

function extractThreadMarkerLike(text: string): string {
  return /^\[thread:[^\]]*\]/.exec(text)?.[0] ?? text.split(/\r?\n/, 1)[0] ?? text;
}

function uniqueQuestMentions(text: string): string[] {
  const mentions = new Set<string>();
  for (const match of text.matchAll(QUEST_MENTION_RE)) {
    mentions.add(match[0].toLowerCase());
  }
  return [...mentions];
}

function firstLeadingQuestTargetLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const candidate = stripTranscriptPrefix(line.trim());
    if (!candidate) continue;
    if (LEADING_QUEST_TARGET_RE.test(candidate)) return candidate;
    if (uniqueQuestMentions(candidate).length > 0) return null;
  }
  return null;
}

function stripTranscriptPrefix(line: string): string {
  const withoutIndex = line.replace(/^\[\d+\]\s+/, "");
  const withoutSpeaker = withoutIndex.replace(/^(?:leader|user|human|system|agent(?:\([^)]*\))?)\s*:\s*/i, "");
  return withoutSpeaker.replace(/^["']+/, "").trimStart();
}

function removeLineAt(lines: string[], index: number): string {
  const next = lines.slice();
  next.splice(index, 1);
  return next.join("\n").replace(/^\n+/, "");
}

function removeSingleThreadMarkerSeparator(body: string): string {
  if (body.startsWith("\r\n")) return body.slice(2);
  if (body.startsWith("\n") || body.startsWith("\r") || body.startsWith(" ") || body.startsWith("\t")) {
    return body.slice(1);
  }
  return body;
}
