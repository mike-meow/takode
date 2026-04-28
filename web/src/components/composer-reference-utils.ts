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
  nextRecencyWeight: number;
}

export type PlainTakodeReferenceSegment =
  | { kind: "text"; text: string }
  | { kind: "quest"; text: string; questId: string }
  | { kind: "session"; text: string; sessionNum: number };

export type PlainTakodeReference =
  | { kind: "quest"; text: string; questId: string }
  | { kind: "session"; text: string; sessionNum: number };

function getPathTail(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function getSessionSuggestionPreview(session: SdkSessionInfo, sessionName: string | undefined): string {
  const explicitName = sessionName?.trim() || session.name?.trim();
  if (explicitName) return explicitName;
  return getPathTail(session.cwd) || `Session ${session.sessionNum ?? ""}`.trim();
}

export function splitPlainTakodeReferences(text: string): PlainTakodeReferenceSegment[] {
  if (!text) return [{ kind: "text", text }];

  const segments: PlainTakodeReferenceSegment[] = [];
  let pendingTextStart = 0;
  let index = 0;

  const pushPendingText = (end: number) => {
    if (end <= pendingTextStart) return;
    segments.push({ kind: "text", text: text.slice(pendingTextStart, end) });
  };

  while (index < text.length) {
    const reference = readPlainTakodeReferenceAt(text, index);
    if (!reference) {
      index += 1;
      continue;
    }

    pushPendingText(index);
    segments.push(reference.segment);
    index = reference.end;
    pendingTextStart = reference.end;
  }

  pushPendingText(text.length);
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

export function collectPlainTakodeReferences(text: string): PlainTakodeReference[] {
  const references: PlainTakodeReference[] = [];
  const seen = new Set<string>();

  for (const segment of splitPlainTakodeReferences(text)) {
    if (segment.kind === "text") continue;
    const key = segment.kind === "quest" ? `quest:${segment.questId}` : `session:${segment.sessionNum}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(segment);
  }

  return references;
}

function isPlainReferenceBoundary(ch: string | undefined): boolean {
  return ch == null || !/[A-Za-z0-9_#:/-]/.test(ch);
}

function readPlainTakodeReferenceAt(
  text: string,
  start: number,
): { segment: Exclude<PlainTakodeReferenceSegment, { kind: "text" }>; end: number } | null {
  if (!isPlainReferenceBoundary(text[start - 1])) return null;

  if (text[start] === "#") {
    let end = start + 1;
    while (end < text.length && /\d/.test(text[end]!)) end += 1;
    if (end === start + 1 || !isPlainReferenceBoundary(text[end])) return null;

    const sessionNum = Number.parseInt(text.slice(start + 1, end), 10);
    if (!Number.isFinite(sessionNum)) return null;
    return {
      segment: { kind: "session", text: text.slice(start, end), sessionNum },
      end,
    };
  }

  if ((text[start] === "q" || text[start] === "Q") && text[start + 1] === "-") {
    let end = start + 2;
    while (end < text.length && /\d/.test(text[end]!)) end += 1;
    if (end === start + 2 || !isPlainReferenceBoundary(text[end])) return null;

    const questId = text.slice(start, end).toLowerCase();
    return {
      segment: { kind: "quest", text: text.slice(start, end), questId },
      end,
    };
  }

  return null;
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

function normalizeSkillNames(skillNames: Iterable<string>): Set<string> {
  return new Set(Array.from(skillNames, (skillName) => skillName.trim().toLowerCase()).filter(Boolean));
}

function cloneRecentAutocompleteBoosts(boosts: RecentAutocompleteBoosts): RecentAutocompleteBoosts {
  return {
    questBoosts: new Map(boosts.questBoosts),
    sessionBoosts: new Map(boosts.sessionBoosts),
    skillBoosts: new Map(boosts.skillBoosts),
    nextRecencyWeight: boosts.nextRecencyWeight,
  };
}

function applyAutocompleteMatches(
  boosts: RecentAutocompleteBoosts,
  recencyWeight: number,
  matches: ReturnType<typeof collectRecentAutocompleteMatches>,
): void {
  const { questMatches, sessionMatches, skillMatches } = matches;

  for (const questId of questMatches) {
    boosts.questBoosts.set(questId, recencyWeight);
  }
  for (const sessionNum of sessionMatches) {
    if (!Number.isFinite(sessionNum)) continue;
    boosts.sessionBoosts.set(sessionNum, recencyWeight);
  }
  for (const skillName of skillMatches) {
    boosts.skillBoosts.set(skillName, recencyWeight);
  }
}

export function computeRecentAutocompleteBoosts(
  messages: ChatMessage[],
  skillNames: Iterable<string> = [],
): RecentAutocompleteBoosts {
  const boosts: RecentAutocompleteBoosts = {
    questBoosts: new Map<string, number>(),
    sessionBoosts: new Map<number, number>(),
    skillBoosts: new Map<string, number>(),
    nextRecencyWeight: 1,
  };
  const normalizedSkillNames = normalizeSkillNames(skillNames);
  const contents = messages.map((message) => message?.content ?? "").filter(Boolean);

  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index]!;
    const recencyWeight = index + 1;
    const matches = collectRecentAutocompleteMatches(content, normalizedSkillNames);
    for (const questId of matches.questMatches) {
      if (!boosts.questBoosts.has(questId)) boosts.questBoosts.set(questId, recencyWeight);
    }
    for (const sessionNum of matches.sessionMatches) {
      if (!Number.isFinite(sessionNum) || boosts.sessionBoosts.has(sessionNum)) continue;
      boosts.sessionBoosts.set(sessionNum, recencyWeight);
    }
    for (const skillName of matches.skillMatches) {
      if (!boosts.skillBoosts.has(skillName)) boosts.skillBoosts.set(skillName, recencyWeight);
    }
  }

  boosts.nextRecencyWeight = contents.length + 1;
  return boosts;
}

export function overlayCurrentAutocompleteBoosts(
  historyBoosts: RecentAutocompleteBoosts,
  currentInput: string,
  skillNames: Iterable<string> = [],
): RecentAutocompleteBoosts {
  if (!currentInput.trim()) return historyBoosts;

  const boosts = cloneRecentAutocompleteBoosts(historyBoosts);
  const normalizedSkillNames = normalizeSkillNames(skillNames);
  const matches = collectRecentAutocompleteMatches(currentInput, normalizedSkillNames);
  applyAutocompleteMatches(boosts, historyBoosts.nextRecencyWeight, matches);
  return boosts;
}

export function computeRecentReferenceBoosts(
  messages: ChatMessage[],
  currentInput = "",
): {
  questBoosts: Map<string, number>;
  sessionBoosts: Map<number, number>;
} {
  const { questBoosts, sessionBoosts } = overlayCurrentAutocompleteBoosts(
    computeRecentAutocompleteBoosts(messages),
    currentInput,
  );
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
