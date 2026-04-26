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

export interface RecentAutocompleteBoosts {
  questBoosts: Map<string, number>;
  sessionBoosts: Map<number, number>;
  skillBoosts: Map<string, number>;
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

function collectRecentAutocompleteMatches(
  content: string,
  normalizedSkillNames: ReadonlySet<string>,
): {
  questMatches: Set<string>;
  sessionMatches: Set<number>;
  skillMatches: Set<string>;
} {
  const questMatches = new Set<string>();
  const sessionMatches = new Set<number>();
  const skillMatches = new Set<string>();

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

  for (const match of content.matchAll(/(?:^|[\s([{])(\/|\$)([A-Za-z][A-Za-z0-9._:-]*)(?=$|[^A-Za-z0-9._:-])/g)) {
    const prefix = match[1]!;
    const token = match[2]!.toLowerCase();
    const normalizedSkillName = prefix === "/" ? `/${token}` : token;
    if (normalizedSkillNames.has(token)) skillMatches.add(token);
    if (normalizedSkillNames.has(normalizedSkillName)) skillMatches.add(normalizedSkillName);
  }
  for (const match of content.matchAll(/(?:^|[\s([{])\/\/([A-Za-z][A-Za-z0-9._:-]*)(?=$|[^A-Za-z0-9._:-])/g)) {
    const normalizedSkillName = `/${match[1]!.toLowerCase()}`;
    if (normalizedSkillNames.has(normalizedSkillName)) skillMatches.add(normalizedSkillName);
  }

  return { questMatches, sessionMatches, skillMatches };
}

export function computeRecentAutocompleteBoosts(
  messages: ChatMessage[],
  currentInput = "",
  skillNames: Iterable<string> = [],
): RecentAutocompleteBoosts {
  const questBoosts = new Map<string, number>();
  const sessionBoosts = new Map<number, number>();
  const skillBoosts = new Map<string, number>();
  const normalizedSkillNames = new Set(
    Array.from(skillNames, (skillName) => skillName.trim().toLowerCase()).filter(Boolean),
  );
  const contents = messages
    .map((message) => message?.content ?? "")
    .concat(currentInput)
    .filter(Boolean);

  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index]!;
    const recencyWeight = index + 1;
    const { questMatches, sessionMatches, skillMatches } = collectRecentAutocompleteMatches(
      content,
      normalizedSkillNames,
    );

    for (const questId of questMatches) {
      if (!questBoosts.has(questId)) questBoosts.set(questId, recencyWeight);
    }
    for (const sessionNum of sessionMatches) {
      if (!Number.isFinite(sessionNum) || sessionBoosts.has(sessionNum)) continue;
      sessionBoosts.set(sessionNum, recencyWeight);
    }
    for (const skillName of skillMatches) {
      if (!skillBoosts.has(skillName)) skillBoosts.set(skillName, recencyWeight);
    }
  }

  return { questBoosts, sessionBoosts, skillBoosts };
}

export function computeRecentReferenceBoosts(
  messages: ChatMessage[],
  currentInput = "",
): {
  questBoosts: Map<string, number>;
  sessionBoosts: Map<number, number>;
} {
  const { questBoosts, sessionBoosts } = computeRecentAutocompleteBoosts(messages, currentInput);
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
