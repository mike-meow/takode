import type { ChatMessage, CodexAppReference, CodexSkillReference, QuestmasterTask, SdkSessionInfo } from "../types.js";

export const AUTOCOMPLETE_RECENCY_MAX_RECENT_TURNS = 24;
export const AUTOCOMPLETE_RECENCY_MAX_SCANNED_MESSAGES = 120;
export const AUTOCOMPLETE_RECENCY_MAX_CHARS = 64_000;

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

export interface QuestReferenceSuggestionsResult {
  suggestions: ReferenceSuggestion[];
  scannedQuestCount: number;
  candidateCount: number;
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

function normalizeAutocompleteThreadKey(threadKey: string | null | undefined): string {
  const normalized = threadKey?.trim().toLowerCase();
  return normalized || "main";
}

function isMainAutocompleteThread(threadKey: string): boolean {
  return normalizeAutocompleteThreadKey(threadKey) === "main";
}

function isAllAutocompleteThread(threadKey: string): boolean {
  return normalizeAutocompleteThreadKey(threadKey) === "all";
}

function messageAutocompleteRouteKeys(message: ChatMessage): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = normalizeAutocompleteThreadKey(value);
    if (!normalized || normalized === "main") return;
    keys.add(normalized);
  };

  const metadata = message.metadata;
  add(metadata?.threadKey);
  add(metadata?.questId);
  for (const ref of metadata?.threadRefs ?? []) {
    if (ref.source === "backfill") continue;
    add(ref.threadKey);
    add(ref.questId);
  }
  return keys;
}

function messageMatchesAutocompleteThread(message: ChatMessage, threadKey: string): boolean {
  const normalizedThreadKey = normalizeAutocompleteThreadKey(threadKey);
  if (isAllAutocompleteThread(normalizedThreadKey)) return true;
  const routeKeys = messageAutocompleteRouteKeys(message);
  if (isMainAutocompleteThread(normalizedThreadKey)) return routeKeys.size === 0;
  return routeKeys.has(normalizedThreadKey);
}

function compactAutocompleteContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headChars = Math.floor(maxChars / 2);
  return `${content.slice(0, headChars)}\n${content.slice(content.length - (maxChars - headChars))}`;
}

export function selectBoundedRecentAutocompleteContents(
  messages: readonly ChatMessage[],
  {
    threadKey = "main",
    maxRecentTurns = AUTOCOMPLETE_RECENCY_MAX_RECENT_TURNS,
    maxScannedMessages = AUTOCOMPLETE_RECENCY_MAX_SCANNED_MESSAGES,
    maxChars = AUTOCOMPLETE_RECENCY_MAX_CHARS,
  }: {
    threadKey?: string;
    maxRecentTurns?: number;
    maxScannedMessages?: number;
    maxChars?: number;
  } = {},
): string[] {
  const selected: string[] = [];
  let includedTurns = 0;
  let includedChars = 0;
  let scannedMessages = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (scannedMessages >= maxScannedMessages) break;
    if (includedTurns >= maxRecentTurns) break;
    if (includedChars >= maxChars) break;
    scannedMessages += 1;

    const message = messages[index];
    if (!message || !messageMatchesAutocompleteThread(message, threadKey)) continue;
    const rawContent = message.content ?? "";
    if (!rawContent.trim()) continue;

    const remainingChars = Math.max(0, maxChars - includedChars);
    if (remainingChars === 0) break;
    const content = compactAutocompleteContent(rawContent, remainingChars);
    selected.push(content);
    includedChars += content.length;
    if (message.role === "user") includedTurns += 1;
  }

  return selected.reverse();
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
  return computeRecentAutocompleteBoostsFromContents(
    messages.map((message) => message?.content ?? "").filter(Boolean),
    skillNames,
  );
}

export function computeRecentAutocompleteBoostsFromContents(
  contents: readonly string[],
  skillNames: Iterable<string> = [],
): RecentAutocompleteBoosts {
  const boosts: RecentAutocompleteBoosts = {
    questBoosts: new Map<string, number>(),
    sessionBoosts: new Map<number, number>(),
    skillBoosts: new Map<string, number>(),
    nextRecencyWeight: 1,
  };
  const normalizedSkillNames = normalizeSkillNames(skillNames);

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

function compareReferenceSuggestions(left: ReferenceSuggestion, right: ReferenceSuggestion, fullQuery: string): number {
  const leftExact = Number(left.rawRef.toLowerCase() === fullQuery);
  const rightExact = Number(right.rawRef.toLowerCase() === fullQuery);
  if (leftExact !== rightExact) return rightExact - leftExact;
  if (left.recentBoost !== right.recentBoost) return right.recentBoost - left.recentBoost;
  return right.tieBreaker - left.tieBreaker;
}

export function buildQuestReferenceSuggestions(
  quests: readonly QuestmasterTask[],
  referenceQuery: string,
  questBoosts: ReadonlyMap<string, number>,
  limit = REFERENCE_MENU_LIMIT,
): QuestReferenceSuggestionsResult {
  const fullQuery = `q-${referenceQuery}`.toLowerCase();
  const suggestions: ReferenceSuggestion[] = [];
  let candidateCount = 0;

  for (const quest of quests) {
    const questId = quest.questId.toLowerCase();
    if (referenceQuery !== "" && !questId.startsWith(fullQuery)) continue;
    candidateCount += 1;
    const suggestion: ReferenceSuggestion = {
      key: quest.questId,
      kind: "quest",
      rawRef: quest.questId,
      preview: quest.title,
      insertText: quest.questId,
      searchText: `${quest.questId} ${quest.title}`.toLowerCase(),
      recentBoost: questBoosts.get(questId) ?? 0,
      tieBreaker: Number.parseInt(quest.questId.replace(/^q-/, ""), 10) || 0,
    };

    const insertAt = suggestions.findIndex(
      (existing) => compareReferenceSuggestions(suggestion, existing, fullQuery) < 0,
    );
    if (insertAt === -1) suggestions.push(suggestion);
    else suggestions.splice(insertAt, 0, suggestion);
    if (suggestions.length > limit) suggestions.pop();
  }

  return {
    suggestions,
    scannedQuestCount: quests.length,
    candidateCount,
  };
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
