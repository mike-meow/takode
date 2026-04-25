import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types.js";
import {
  useStore,
  getSessionSearchState,
  computeSessionSearchMatches,
  sessionSearchMessageMatchesCategory,
  sessionSearchTextMatches,
  type SearchMatch,
  type SessionSearchCategory,
} from "../store.js";

/**
 * Hook that computes search matches whenever the query, mode, category, or messages change.
 * Writes results back to the store via setSessionSearchResults.
 *
 * Should be called once per active session (in ChatView).
 */
export function useSessionSearch(sessionId: string, enabled = true): void {
  const messages = useStore((s) => s.messages.get(sessionId));
  const leaderSessionId = useStore((s) => s.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.herdedBy);
  const searchState = useStore((s) => getSessionSearchState(s, sessionId));
  const setSearchResults = useStore((s) => s.setSessionSearchResults);

  const { query, mode, category, isOpen } = searchState;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (!isOpen || !query.trim()) {
      setSearchResults(sessionId, []);
      return;
    }

    // Debounce the computation
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const msgs = messages ?? [];
      const matches = computeMatches(msgs, query, mode, category, leaderSessionId);
      setSearchResults(sessionId, matches);
    }, 200);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, query, mode, category, isOpen, messages, leaderSessionId, sessionId, setSearchResults]);
}

/**
 * Compute which messages match the search query.
 * Returns one SearchMatch per matching message, in message order.
 */
function computeMatches(
  messages: Pick<ChatMessage, "id" | "content" | "role" | "agentSource">[],
  query: string,
  mode: "strict" | "fuzzy",
  category: SessionSearchCategory = "all",
  leaderSessionId?: string,
): SearchMatch[] {
  return computeSessionSearchMatches(messages, query, mode, category, leaderSessionId);
}

function messageMatchesCategory(
  message: Pick<ChatMessage, "role" | "agentSource">,
  category: SessionSearchCategory,
  leaderSessionId?: string,
): boolean {
  return sessionSearchMessageMatchesCategory(message, category, leaderSessionId);
}

/** Check if a message's text matches the query in the given mode. */
function messageMatches(text: string, query: string, mode: "strict" | "fuzzy"): boolean {
  return sessionSearchTextMatches(text, query, mode);
}

// Export pure functions for testing
export {
  computeMatches as _computeMatches,
  messageMatches as _messageMatches,
  messageMatchesCategory as _messageMatchesCategory,
};
