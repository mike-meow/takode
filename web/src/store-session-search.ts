import { normalizeForSearch } from "../shared/search-utils.js";
import type { ChatMessage } from "./types.js";

export interface SearchMatch {
  messageId: string;
}

export type SessionSearchCategory = "all" | "user" | "assistant" | "event";

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

function isSessionSearchEventSource(agentSource: ChatMessage["agentSource"]): boolean {
  const sourceId = agentSource?.sessionId;
  if (!sourceId) return false;
  return (
    sourceId === "herd-events" ||
    sourceId === "system" ||
    sourceId.startsWith("system:") ||
    sourceId.startsWith("timer:") ||
    sourceId.startsWith("cron:")
  );
}

export function sessionSearchMessageMatchesCategory(
  message: Pick<ChatMessage, "role" | "agentSource">,
  category: SessionSearchCategory,
  leaderSessionId?: string,
): boolean {
  if (category === "all") return true;
  if (message.role === "assistant") return category === "assistant";
  if (message.role === "system") return category === "event";
  const sourceId = message.agentSource?.sessionId;
  const semanticCategory =
    !sourceId || (leaderSessionId !== undefined && sourceId === leaderSessionId)
      ? "user"
      : isSessionSearchEventSource(message.agentSource) || sourceId.length > 0
        ? "event"
        : "user";
  return category === semanticCategory;
}

export function sessionSearchTextMatches(text: string, query: string, mode: "strict" | "fuzzy"): boolean {
  const normalizedText = normalizeForSearch(text);
  const normalizedQuery = normalizeForSearch(query);
  if (mode === "strict") return normalizedText.includes(normalizedQuery);
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  return words.every((word) => normalizedText.includes(word));
}

export function computeSessionSearchMatches(
  messages: Pick<ChatMessage, "id" | "content" | "role" | "agentSource">[],
  query: string,
  mode: "strict" | "fuzzy",
  category: SessionSearchCategory = "all",
  leaderSessionId?: string,
): SearchMatch[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const matches: SearchMatch[] = [];
  for (const msg of messages) {
    if (!sessionSearchMessageMatchesCategory(msg, category, leaderSessionId)) continue;
    if (!msg.content) continue;
    if (sessionSearchTextMatches(msg.content, trimmed, mode)) {
      matches.push({ messageId: msg.id });
    }
  }
  return matches;
}
