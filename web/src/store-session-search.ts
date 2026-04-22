import { normalizeForSearch } from "../shared/search-utils.js";
import type { ChatMessage } from "./types.js";

export interface SearchMatch {
  messageId: string;
}

export type SessionSearchCategory = "all" | ChatMessage["role"];

export interface SessionSearchState {
  query: string;
  isOpen: boolean;
  mode: "strict" | "fuzzy";
  category: SessionSearchCategory;
  matches: SearchMatch[];
  currentMatchIndex: number;
}

export const DEFAULT_SEARCH_STATE: SessionSearchState = {
  query: "",
  isOpen: false,
  mode: "strict",
  category: "all",
  matches: [],
  currentMatchIndex: -1,
};

type SessionSearchStateOwner = {
  sessionSearch: Map<string, SessionSearchState>;
};

export function getSessionSearchState(state: SessionSearchStateOwner, sessionId: string): SessionSearchState {
  return state.sessionSearch.get(sessionId) ?? DEFAULT_SEARCH_STATE;
}

function sessionSearchRoleMatchesCategory(role: ChatMessage["role"], category: SessionSearchCategory): boolean {
  return category === "all" || role === category;
}

function sessionSearchTextMatches(text: string, query: string, mode: "strict" | "fuzzy"): boolean {
  const normalizedText = normalizeForSearch(text);
  const normalizedQuery = normalizeForSearch(query);
  if (mode === "strict") return normalizedText.includes(normalizedQuery);
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  return words.every((word) => normalizedText.includes(word));
}

export function computeSessionSearchMatches(
  messages: Pick<ChatMessage, "id" | "content" | "role">[],
  query: string,
  mode: "strict" | "fuzzy",
  category: SessionSearchCategory = "all",
): SearchMatch[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const matches: SearchMatch[] = [];
  for (const msg of messages) {
    if (!sessionSearchRoleMatchesCategory(msg.role, category)) continue;
    if (!msg.content) continue;
    if (sessionSearchTextMatches(msg.content, trimmed, mode)) {
      matches.push({ messageId: msg.id });
    }
  }
  return matches;
}
