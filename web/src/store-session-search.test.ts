import { describe, expect, it } from "vitest";
import { computeSessionSearchMatches, getSessionSearchState } from "./store-session-search.js";

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
});
