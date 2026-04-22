import type { ChatMessage, CodexAppReference, CodexSkillReference, SdkSessionInfo } from "../types.js";

export interface CommandItem {
  name: string;
  type: "command" | "skill" | "app";
  trigger: "/" | "$";
  insertText: string;
  description?: string;
}

export const DOLLAR_QUERY_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const REFERENCE_QUERY_PATTERN = /^\d*$/;
export const REFERENCE_MENU_LIMIT = 8;

export interface ReferenceSuggestion {
  key: string;
  kind: "quest" | "session";
  rawRef: string;
  preview: string;
  insertText: string;
  searchText: string;
  recentBoost: number;
  tieBreaker: number;
}

export interface ReferenceTriggerMatch {
  kind: "quest" | "session";
  query: string;
  replacementStart: number;
}

function getPathTail(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function buildQuestLinkInsertText(questId: string): string {
  return `[${questId}](quest:${questId})`;
}

export function buildSessionLinkInsertText(sessionNum: number): string {
  return `[#${sessionNum}](session:${sessionNum})`;
}

export function getSessionSuggestionPreview(session: SdkSessionInfo, sessionName: string | undefined): string {
  const explicitName = sessionName?.trim() || session.name?.trim();
  if (explicitName) return explicitName;
  return getPathTail(session.cwd) || `Session ${session.sessionNum ?? ""}`.trim();
}

export function computeRecentReferenceBoosts(messages: ChatMessage[]): {
  questBoosts: Map<string, number>;
  sessionBoosts: Map<number, number>;
} {
  const questBoosts = new Map<string, number>();
  const sessionBoosts = new Map<number, number>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = message?.content ?? "";
    if (!content) continue;

    const recencyWeight = index + 1;
    const questMatches = new Set<string>();
    const sessionMatches = new Set<number>();

    for (const match of content.matchAll(/\bquest:(q-\d+)\b/gi)) {
      questMatches.add(match[1]!.toLowerCase());
    }
    for (const match of content.matchAll(/(?:^|[^A-Za-z0-9])(q-\d+)\b/gi)) {
      questMatches.add(match[1]!.toLowerCase());
    }
    for (const match of content.matchAll(/\bsession:(?:\/\/)?(\d+)(?::\d+)?\b/gi)) {
      sessionMatches.add(Number.parseInt(match[1]!, 10));
    }
    for (const match of content.matchAll(/(?:^|[^A-Za-z0-9])#(\d+)\b/g)) {
      sessionMatches.add(Number.parseInt(match[1]!, 10));
    }

    for (const questId of questMatches) {
      if (!questBoosts.has(questId)) questBoosts.set(questId, recencyWeight);
    }
    for (const sessionNum of sessionMatches) {
      if (!Number.isFinite(sessionNum) || sessionBoosts.has(sessionNum)) continue;
      sessionBoosts.set(sessionNum, recencyWeight);
    }
  }

  return { questBoosts, sessionBoosts };
}

export function detectReferenceTrigger(inputText: string, cursorPos: number): ReferenceTriggerMatch | null {
  for (let i = cursorPos - 1; i >= 0; i -= 1) {
    const ch = inputText[i];
    if (ch === " " || ch === "\n" || ch === "\t") break;

    const prevChar = inputText[i - 1] ?? "";
    const isAllowedBoundary = i === 0 || /[\s([{]/.test(prevChar);
    const replacementStart = i > 0 && /[[({]/.test(prevChar) ? i - 1 : i;

    if (ch === "#" && isAllowedBoundary) {
      const query = inputText.slice(i + 1, cursorPos);
      if (!REFERENCE_QUERY_PATTERN.test(query)) return null;
      return { kind: "session", query, replacementStart };
    }

    if (ch === "q" && inputText[i + 1] === "-" && isAllowedBoundary) {
      const query = inputText.slice(i + 2, cursorPos);
      if (!REFERENCE_QUERY_PATTERN.test(query)) return null;
      return { kind: "quest", query, replacementStart };
    }
  }

  return null;
}

function toAppMentionSlug(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "app";
}

export function toSkillMentionInsertText(skill: CodexSkillReference): string {
  if (skill.path?.trim()) {
    const escapedPath = skill.path.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
    return `[$${skill.name}](${escapedPath})`;
  }
  return `$${skill.name}`;
}

export function toAppMentionInsertText(app: CodexAppReference): string {
  return `[$${toAppMentionSlug(app.name)}](app://${app.id})`;
}

export function parseCodexModeSlashCommand(text: string): { uiMode: "plan" | "agent"; askPermission?: boolean } | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, "");
  switch (normalized) {
    case "/plan":
      return { uiMode: "plan" };
    case "/suggest":
      return { uiMode: "agent", askPermission: true };
    case "/accept-edits":
    case "/acceptedits":
      return { uiMode: "agent", askPermission: true };
    case "/auto":
      return { uiMode: "agent", askPermission: false };
    default:
      return null;
  }
}
