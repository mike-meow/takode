export type ThreadRouteTarget = {
  threadKey: string;
  questId?: string;
};

export type ThreadRouteParseResult =
  | { ok: true; target: ThreadRouteTarget; body: string }
  | { ok: false; reason: "missing" | "invalid"; marker?: string; body: string };

const TEXT_THREAD_MARKER_RE = /^\[thread:(main|q-\d+)\](.*)$/;
const COMMAND_THREAD_COMMENT_RE = /^#\s*thread:(main|q-\d+)\s*$/;

export function isQuestThreadKey(threadKey: string): boolean {
  return /^q-\d+$/.test(threadKey);
}

export function normalizeThreadTarget(raw: string): ThreadRouteTarget | null {
  const threadKey = raw.trim().toLowerCase();
  if (threadKey === "main") return { threadKey };
  if (isQuestThreadKey(threadKey)) return { threadKey, questId: threadKey };
  return null;
}

export function parseThreadTextPrefix(text: string): ThreadRouteParseResult {
  const lines = text.split(/\r?\n/);
  const first = firstNonEmptyLine(lines);
  if (!first) return { ok: false, reason: "missing", body: text };

  const match = TEXT_THREAD_MARKER_RE.exec(first.text);
  if (!match) {
    const markerLike = first.text.toLowerCase().startsWith("[thread:") ? first.text : undefined;
    return { ok: false, reason: markerLike ? "invalid" : "missing", marker: markerLike, body: text };
  }

  const target = normalizeThreadTarget(match[1]);
  if (!target) return { ok: false, reason: "invalid", marker: first.text, body: text };
  return { ok: true, target, body: removeThreadMarker(lines, first.index, match[2] ?? "") };
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

function removeLineAt(lines: string[], index: number): string {
  const next = lines.slice();
  next.splice(index, 1);
  return next.join("\n").replace(/^\n+/, "");
}

function removeThreadMarker(lines: string[], index: number, sameLineBody: string): string {
  if (!sameLineBody.trim()) return removeLineAt(lines, index);
  const next = lines.slice();
  next[index] = sameLineBody.replace(/^[ \t]+/, "");
  return next.join("\n").replace(/^\n+/, "");
}
