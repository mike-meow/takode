import { describe, expect, it } from "vitest";
import {
  computeSessionSearchMatches,
  getSessionSearchState,
  sessionSearchMessageMatchesCategory,
} from "./store-session-search.js";

describe("store session search helpers", () => {
  it("returns default state for sessions without local search state", () => {
    // Fresh sessions should start with a closed, empty search model instead of
    // inheriting stale state from a previous tab or test run.
    expect(getSessionSearchState({ sessionSearch: new Map() }, "s1")).toMatchObject({
      query: "",
      isOpen: false,
      matches: [],
      currentMatchIndex: -1,
    });
  });

  it("matches strict searches by normalized substring", () => {
    // Strict mode still normalizes punctuation/casing so copied snippets from
    // rendered markdown remain searchable in the raw message text.
    expect(
      computeSessionSearchMatches(
        [{ id: "m1", role: "assistant", content: "Fix ws-bridge replay handling" }],
        "replay handling",
        "strict",
      ),
    ).toEqual([{ messageId: "m1" }]);
  });

  it("matches fuzzy searches by requiring every query token", () => {
    // Fuzzy mode is intentionally forgiving on spacing/order but still requires
    // all meaningful tokens so broad queries do not over-highlight the feed.
    expect(
      computeSessionSearchMatches(
        [{ id: "m1", role: "assistant", content: "Refactor message feed scroll anchoring" }],
        "feed anchor",
        "fuzzy",
      ),
    ).toEqual([{ messageId: "m1" }]);
  });

  it("classifies injected pseudo-user messages as events for category filtering", () => {
    expect(
      computeSessionSearchMatches(
        [
          { id: "m1", role: "user", content: "real user request" },
          { id: "m2", role: "user", content: "timer fired", agentSource: { sessionId: "timer:t1" } },
          { id: "m3", role: "system", content: "permission approved" },
          { id: "m4", role: "user", content: "agent reminder", agentSource: { sessionId: "agent-1" } },
        ],
        "r",
        "strict",
        "event",
        "leader-1",
      ),
    ).toEqual([{ messageId: "m2" }, { messageId: "m3" }, { messageId: "m4" }]);
  });

  it("keeps only the active leader injection in the user category", () => {
    expect(
      sessionSearchMessageMatchesCategory({ role: "user", agentSource: { sessionId: "leader-1" } }, "user", "leader-1"),
    ).toBe(true);
    expect(
      sessionSearchMessageMatchesCategory(
        { role: "user", agentSource: { sessionId: "leader-1" } },
        "event",
        "leader-1",
      ),
    ).toBe(false);
    expect(
      sessionSearchMessageMatchesCategory({ role: "user", agentSource: { sessionId: "agent-1" } }, "user", "leader-1"),
    ).toBe(false);
    expect(
      sessionSearchMessageMatchesCategory({ role: "user", agentSource: { sessionId: "agent-1" } }, "event", "leader-1"),
    ).toBe(true);
  });
});
