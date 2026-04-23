import { describe, it, expect } from "vitest";
import { _computeMatches, _messageMatches, _messageMatchesCategory } from "./useSessionSearch.js";

describe("messageMatches", () => {
  describe("strict mode", () => {
    it("matches case-insensitive substring", () => {
      expect(_messageMatches("Hello World", "hello", "strict")).toBe(true);
      expect(_messageMatches("Hello World", "WORLD", "strict")).toBe(true);
    });

    it("returns false when substring not found", () => {
      expect(_messageMatches("Hello World", "xyz", "strict")).toBe(false);
    });

    it("matches partial words", () => {
      expect(_messageMatches("authentication", "auth", "strict")).toBe(true);
    });
  });

  describe("fuzzy mode", () => {
    it("matches when all words present in any order", () => {
      expect(_messageMatches("the quick brown fox", "fox quick", "fuzzy")).toBe(true);
    });

    it("returns false when not all words present", () => {
      expect(_messageMatches("the quick brown fox", "fox cat", "fuzzy")).toBe(false);
    });

    it("matches case-insensitively", () => {
      expect(_messageMatches("Hello Beautiful World", "HELLO WORLD", "fuzzy")).toBe(true);
    });

    it("handles single-word fuzzy as substring match", () => {
      expect(_messageMatches("authentication system", "auth", "fuzzy")).toBe(true);
    });

    it("matches CamelCase tokens split at word boundaries", () => {
      // "plan mode" should match "ExitPlanMode" because CamelCase is expanded
      expect(_messageMatches("ExitPlanMode is the tool", "plan mode", "fuzzy")).toBe(true);
      expect(_messageMatches("Use BoardTable component", "board table", "fuzzy")).toBe(true);
    });

    it("matches CamelCase in strict mode", () => {
      // "plan mode" should match "ExitPlanMode" in strict mode too
      expect(_messageMatches("ExitPlanMode is the tool", "plan mode", "strict")).toBe(true);
    });
  });
});

describe("computeMatches", () => {
  const messages = [
    { id: "m1", role: "user" as const, content: "Hello world" },
    { id: "m2", role: "assistant" as const, content: "Goodbye world" },
    { id: "m3", role: "assistant" as const, content: "Hello again" },
    { id: "m4", role: "user" as const, content: "Hello from leader", agentSource: { sessionId: "leader-1" } },
    { id: "m5", role: "user" as const, content: "Hello from timer", agentSource: { sessionId: "timer:t1" } },
    { id: "m6", role: "system" as const, content: "Hello system event" },
    { id: "m7", role: "user" as const, content: "Hello from generic agent", agentSource: { sessionId: "agent-1" } },
  ];

  it("returns empty for empty query", () => {
    expect(_computeMatches(messages, "", "strict")).toEqual([]);
    expect(_computeMatches(messages, "  ", "strict")).toEqual([]);
  });

  it("finds all matching messages in strict mode", () => {
    const result = _computeMatches(messages, "hello", "strict");
    expect(result).toEqual([
      { messageId: "m1" },
      { messageId: "m3" },
      { messageId: "m4" },
      { messageId: "m5" },
      { messageId: "m6" },
      { messageId: "m7" },
    ]);
  });

  it("finds all matching messages in fuzzy mode", () => {
    // "hello world" should only match m1 (both words present)
    const result = _computeMatches(messages, "hello world", "fuzzy");
    expect(result).toEqual([{ messageId: "m1" }]);
  });

  it("returns messages in order", () => {
    const result = _computeMatches(messages, "world", "strict");
    expect(result).toEqual([{ messageId: "m1" }, { messageId: "m2" }]);
  });

  it("respects the selected message category", () => {
    // Filtered session search should respect semantic categories rather than
    // raw roles, so system-style injected pseudo-user messages move to Events.
    const assistantOnly = _computeMatches(messages, "hello", "strict", "assistant", "leader-1");
    expect(assistantOnly).toEqual([{ messageId: "m3" }]);

    const userOnly = _computeMatches(messages, "hello", "strict", "user", "leader-1");
    expect(userOnly).toEqual([{ messageId: "m1" }, { messageId: "m4" }]);

    const eventOnly = _computeMatches(messages, "hello", "strict", "event", "leader-1");
    expect(eventOnly).toEqual([{ messageId: "m5" }, { messageId: "m6" }, { messageId: "m7" }]);
  });

  it("skips messages with empty content", () => {
    const result = _computeMatches(messages, "hello", "strict");
    expect(result.find((m) => m.messageId === "missing")).toBeUndefined();
  });
});

describe("messageMatchesCategory", () => {
  it("accepts every role when the all filter is active", () => {
    expect(_messageMatchesCategory({ role: "user" }, "all")).toBe(true);
    expect(_messageMatchesCategory({ role: "assistant" }, "all")).toBe(true);
    expect(_messageMatchesCategory({ role: "system" }, "all")).toBe(true);
  });

  it("treats leader-authored user injections as user messages", () => {
    expect(_messageMatchesCategory({ role: "user", agentSource: { sessionId: "leader-1" } }, "user", "leader-1")).toBe(
      true,
    );
    expect(_messageMatchesCategory({ role: "user", agentSource: { sessionId: "leader-1" } }, "event", "leader-1")).toBe(
      false,
    );
  });

  it("routes timer, cron, herd, generic agent, and system messages to the event category", () => {
    expect(_messageMatchesCategory({ role: "user", agentSource: { sessionId: "timer:t1" } }, "event", "leader-1")).toBe(
      true,
    );
    expect(
      _messageMatchesCategory({ role: "user", agentSource: { sessionId: "cron:nightly" } }, "event", "leader-1"),
    ).toBe(true);
    expect(
      _messageMatchesCategory({ role: "user", agentSource: { sessionId: "herd-events" } }, "event", "leader-1"),
    ).toBe(true);
    expect(_messageMatchesCategory({ role: "user", agentSource: { sessionId: "agent-1" } }, "event", "leader-1")).toBe(
      true,
    );
    expect(_messageMatchesCategory({ role: "system" }, "event", "leader-1")).toBe(true);
  });

  it("keeps assistant messages in the assistant category only", () => {
    expect(_messageMatchesCategory({ role: "assistant" }, "assistant")).toBe(true);
    expect(_messageMatchesCategory({ role: "assistant" }, "user")).toBe(false);
    expect(_messageMatchesCategory({ role: "assistant" }, "event")).toBe(false);
  });
});
