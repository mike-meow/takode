// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { ChatMessage } from "../types.js";
import { buildFeedModel, useFeedModel, summarizeHerdEvents } from "./use-feed-model.js";

function makeMessage(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"] }): ChatMessage {
  return {
    content: "",
    timestamp: 1,
    ...overrides,
  };
}

/** Create a herd event user message (injected by the herd dispatcher). */
function makeHerdEvent(id: string, content: string, timestamp = 1): ChatMessage {
  return makeMessage({
    id,
    role: "user",
    content,
    timestamp,
    agentSource: { sessionId: "herd-events" } as ChatMessage["agentSource"],
  });
}

/** Helper to extract the message IDs from a turn's entries. */
function entryIds(entries: { kind: string; msg?: { id: string } }[]): string[] {
  return entries.filter((e) => e.kind === "message").map((e) => (e as { msg: { id: string } }).msg.id);
}

describe("leader mode promotion", () => {
  // A turn with: user message, internal monologue, @to(self), @to(user) response.
  // Only @to(user) messages should be promoted; internal text stays in agentEntries;
  // @to(self) is hidden from both.
  it("promotes only @to(user) messages, keeps internal text in agentEntries", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "do the thing", timestamp: 1 }),
      makeMessage({ id: "a-internal", role: "assistant", content: "Let me think about this...", timestamp: 2 }),
      makeMessage({
        id: "a-touser",
        role: "assistant",
        content: "Here's the result @to(user)",
        leaderUserAddressed: true,
        timestamp: 3,
      }),
    ];

    const model = buildFeedModel(messages, true);
    expect(model.turns).toHaveLength(1);
    const turn = model.turns[0];

    // @to(user) should be the response (last user-addressed message)
    expect(turn.responseEntry?.kind).toBe("message");
    expect((turn.responseEntry as { msg: ChatMessage }).msg.id).toBe("a-touser");

    // Internal monologue stays in agentEntries (visible expanded, hidden collapsed)
    expect(entryIds(turn.agentEntries)).toContain("a-internal");

    // Nothing promoted (the only @to(user) became responseEntry)
    expect(turn.promotedEntries).toHaveLength(0);
  });

  it("promotes earlier @to(user) messages when multiple exist", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a-internal", role: "assistant", content: "Planning...", timestamp: 2 }),
      makeMessage({
        id: "a-touser-1",
        role: "assistant",
        content: "First update @to(user)",
        leaderUserAddressed: true,
        timestamp: 3,
      }),
      makeMessage({ id: "a-internal2", role: "assistant", content: "More internal work...", timestamp: 4 }),
      makeMessage({
        id: "a-touser-2",
        role: "assistant",
        content: "Final result @to(user)",
        leaderUserAddressed: true,
        timestamp: 5,
      }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    // Last @to(user) is the response
    expect((turn.responseEntry as { msg: ChatMessage }).msg.id).toBe("a-touser-2");

    // Earlier @to(user) is promoted
    expect(entryIds(turn.promotedEntries)).toEqual(["a-touser-1"]);

    // Internal messages stay in agentEntries
    expect(entryIds(turn.agentEntries)).toContain("a-internal");
    expect(entryIds(turn.agentEntries)).toContain("a-internal2");
  });

  it("hides @to(self) messages from both agentEntries and promotedEntries", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({
        id: "a-self",
        role: "assistant",
        content: "Internal handoff @to(self)",
        leaderUserAddressed: false,
        timestamp: 2,
      }),
      makeMessage({
        id: "a-touser",
        role: "assistant",
        content: "Done @to(user)",
        leaderUserAddressed: true,
        timestamp: 3,
      }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    // @to(self) should be excluded from everything
    expect(entryIds(turn.agentEntries)).not.toContain("a-self");
    expect(entryIds(turn.promotedEntries)).not.toContain("a-self");
    expect(entryIds(turn.allEntries)).not.toContain("a-self");
  });

  it("counts internal messages in stats.messageCount", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a-int1", role: "assistant", content: "thinking...", timestamp: 2 }),
      makeMessage({ id: "a-int2", role: "assistant", content: "more thinking...", timestamp: 3 }),
      makeMessage({
        id: "a-self",
        role: "assistant",
        content: "handoff @to(self)",
        timestamp: 4,
      }),
      makeMessage({
        id: "a-touser",
        role: "assistant",
        content: "result @to(user)",
        leaderUserAddressed: true,
        timestamp: 5,
      }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    // 4 total assistant messages. Subtract: 1 response + 0 promoted + 1 @to(self) = 2 remaining
    expect(turn.stats.messageCount).toBe(2);
  });
});

describe("leader mode collapsed preview without @to tags", () => {
  // When leader sessions use `takode notify` instead of @to(user) tags,
  // messages won't have leaderUserAddressed set. The collapsed view should
  // still show the last assistant text as responseEntry.
  it("shows last assistant message as responseEntry even without leaderUserAddressed", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "work on task q-42", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "Starting work on task q-42...", timestamp: 2 }),
      makeMessage({ id: "a2", role: "assistant", content: "I've completed the implementation.", timestamp: 3 }),
    ];

    const model = buildFeedModel(messages, true);
    expect(model.turns).toHaveLength(1);
    const turn = model.turns[0];

    // Last assistant message should be the response (collapsed preview)
    expect(turn.responseEntry?.kind).toBe("message");
    expect((turn.responseEntry as { msg: ChatMessage }).msg.id).toBe("a2");

    // Earlier assistant message stays in agentEntries
    expect(entryIds(turn.agentEntries)).toContain("a1");

    // No promoted entries since no @to(user) flags
    expect(turn.promotedEntries).toHaveLength(0);
  });

  it("still hides @to(self) even without any @to(user) messages", () => {
    // Backward compat: old sessions may still have @to(self) tags without
    // any corresponding @to(user) messages.
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({
        id: "a-self",
        role: "assistant",
        content: "Internal coordination @to(self)",
        timestamp: 2,
      }),
      makeMessage({ id: "a-normal", role: "assistant", content: "Done with the task.", timestamp: 3 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    // Normal message is the response
    expect(turn.responseEntry?.kind).toBe("message");
    expect((turn.responseEntry as { msg: ChatMessage }).msg.id).toBe("a-normal");

    // @to(self) is hidden from all entry lists
    expect(entryIds(turn.agentEntries)).not.toContain("a-self");
    expect(entryIds(turn.allEntries)).not.toContain("a-self");
  });

  it("prefers last assistant text over earlier @to(user) for responseEntry", () => {
    // Mixed scenario: some old @to(user) messages plus newer unmarked messages.
    // responseEntry should be the last assistant text regardless of @to(user) flag.
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({
        id: "a-touser",
        role: "assistant",
        content: "Status update @to(user)",
        leaderUserAddressed: true,
        timestamp: 2,
      }),
      makeMessage({ id: "a-final", role: "assistant", content: "All done, synced to main.", timestamp: 3 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    // Last assistant text becomes responseEntry (regardless of @to flag)
    expect((turn.responseEntry as { msg: ChatMessage }).msg.id).toBe("a-final");

    // Earlier @to(user) is promoted
    expect(entryIds(turn.promotedEntries)).toEqual(["a-touser"]);
  });
});

describe("sub-conclusions in collapsed turns", () => {
  // Sub-conclusions are assistant messages immediately preceding herd event injections.
  // They represent intermediate progress worth showing when a turn is collapsed.

  it("extracts sub-conclusions before herd events in leader mode", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "orchestrate workers", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "Dispatched #5 to work on q-42.", timestamp: 2 }),
      makeHerdEvent("h1", "1 events from 1 sessions\n\n#5 | turn_end | ✓ 15.3s\n  [42] asst: Done", 3),
      makeMessage({ id: "a2", role: "assistant", content: "q-42 complete! Starting q-43.", timestamp: 4 }),
      makeHerdEvent("h2", "1 events from 1 sessions\n\n#6 | turn_end | ✓ 8.1s\n  [50] asst: Finished", 5),
      makeMessage({ id: "a3", role: "assistant", content: "All tasks complete.", timestamp: 6 }),
    ];

    const model = buildFeedModel(messages, true);
    expect(model.turns).toHaveLength(1);
    const turn = model.turns[0];

    // Should have 2 sub-conclusions (a1 before h1, a2 before h2)
    expect(turn.subConclusions).toHaveLength(2);
    expect((turn.subConclusions[0].entry as { msg: ChatMessage }).msg.id).toBe("a1");
    expect(turn.subConclusions[0].herdSummary).toContain("#5 turn_end");
    expect((turn.subConclusions[1].entry as { msg: ChatMessage }).msg.id).toBe("a2");
    expect(turn.subConclusions[1].herdSummary).toContain("#6 turn_end");

    // Final assistant message is the responseEntry, not a sub-conclusion
    expect(turn.responseEntry?.kind).toBe("message");
    expect((turn.responseEntry as { msg: ChatMessage }).msg.id).toBe("a3");

    // Sub-conclusions should not duplicate the responseEntry
    const subIds = turn.subConclusions.map((sc) => (sc.entry as { msg: ChatMessage }).msg.id);
    expect(subIds).not.toContain("a3");
  });

  it("groups consecutive herd events into a single summary", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "Started workers.", timestamp: 2 }),
      // Two consecutive herd events (common when multiple workers finish at once)
      makeHerdEvent("h1", "#264 | turn_end | ✓ 5s", 3),
      makeHerdEvent("h2", "#267 | turn_end | ✓ 8s", 4),
      makeMessage({ id: "a2", role: "assistant", content: "Both done.", timestamp: 5 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(turn.subConclusions).toHaveLength(1);
    expect(turn.subConclusions[0].herdSummary).toBe("Herd: #264 turn_end, #267 turn_end");
  });

  it("returns empty subConclusions when no herd events exist", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "do something", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "Working on it...", timestamp: 2 }),
      makeMessage({ id: "a2", role: "assistant", content: "Done.", timestamp: 3 }),
    ];

    const model = buildFeedModel(messages, true);
    expect(model.turns[0].subConclusions).toHaveLength(0);
  });

  it("returns empty subConclusions for non-leader mode too (consistent interface)", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "hello", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "hi", timestamp: 2 }),
    ];

    const model = buildFeedModel(messages, false);
    expect(model.turns[0].subConclusions).toHaveLength(0);
  });

  it("starts a new synthetic leader turn for delayed herd events after a completed response", () => {
    // q-321: in session #222 the herd dispatcher was delivering updates, but
    // they were arriving minutes after the leader had already answered the
    // user's question. Keeping those delayed herd events in the older user turn
    // made them look like a queued backlog in the UI.
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "what is the prompt limit?", timestamp: 1_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "It's 56K tokens.", timestamp: 10_000 }),
      makeHerdEvent("h1", "#193 | turn_end | ✓ 1m 38s", 185_000),
      makeMessage({ id: "a2", role: "assistant", content: "Routine update from #193. @to(self)", timestamp: 190_000 }),
      makeHerdEvent("h2", "#449 | turn_end | ✓ 33.0s", 320_000),
      makeMessage({ id: "a3", role: "assistant", content: "Routine update from #449. @to(self)", timestamp: 325_000 }),
    ];

    const model = buildFeedModel(messages, true);

    // Original user question remains its own turn.
    expect(model.turns).toHaveLength(3);
    expect(model.turns[0].userEntry?.kind).toBe("message");
    expect((model.turns[0].userEntry as { msg: ChatMessage }).msg.id).toBe("u1");
    expect((model.turns[0].responseEntry as { msg: ChatMessage }).msg.id).toBe("a1");
    expect(model.turns[0].stats.herdEventCount).toBe(0);

    // Each delayed herd batch becomes its own synthetic turn instead of
    // visually piling under the older user request.
    expect(model.turns[1].userEntry).toBeNull();
    expect(model.turns[1].stats.herdEventCount).toBe(1);
    expect(entryIds(model.turns[1].allEntries)).toContain("h1");

    expect(model.turns[2].userEntry).toBeNull();
    expect(model.turns[2].stats.herdEventCount).toBe(1);
    expect(entryIds(model.turns[2].allEntries)).toContain("h2");
  });

  it("keeps delayed herd events in the same turn when the leader only sent an in-progress status update", () => {
    // A single assistant status message ("let me check") should not be
    // treated as a completed answer. In that case, a later herd event still
    // belongs to the same orchestration turn.
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "what's happening?", timestamp: 1_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "Let me check that for you.", timestamp: 2_000 }),
      makeHerdEvent("h1", "#193 | turn_end | ✓ 1m 38s", 185_000),
      makeMessage({ id: "a2", role: "assistant", content: "Routine update from #193. @to(self)", timestamp: 190_000 }),
    ];

    const model = buildFeedModel(messages, true);

    expect(model.turns).toHaveLength(1);
    expect((model.turns[0].userEntry as { msg: ChatMessage }).msg.id).toBe("u1");
    expect(model.turns[0].stats.herdEventCount).toBe(1);
    expect(entryIds(model.turns[0].allEntries)).toContain("h1");
  });

  it("does not count responseEntry as a sub-conclusion when it precedes a herd event", () => {
    // Edge case: the last assistant message before a herd event at the end of the turn.
    // If the turn ends with: assistant → herd → (no more assistant), the last assistant
    // is both the responseEntry and the sub-conclusion candidate. It should only appear
    // as responseEntry.
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "Only message before herd.", timestamp: 2 }),
      makeHerdEvent("h1", "#10 | turn_end | ✓ 2s", 3),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    // a1 becomes responseEntry (last assistant text)
    expect(turn.responseEntry?.kind).toBe("message");
    expect((turn.responseEntry as { msg: ChatMessage }).msg.id).toBe("a1");

    // No sub-conclusions since the only candidate is the responseEntry
    expect(turn.subConclusions).toHaveLength(0);
  });

  it("does not bridge across tool results between assistant and herd event", () => {
    // When a tool_use result sits between the assistant message and the herd event,
    // the assistant should NOT become a sub-conclusion (the sequence is broken).
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "Checking status...", timestamp: 2 }),
      // Tool result message (role=assistant, no text content, only tool_use blocks)
      makeMessage({
        id: "tool1",
        role: "assistant",
        content: "",
        timestamp: 3,
        contentBlocks: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
      }),
      makeMessage({ id: "r1", role: "system", content: "file1.ts\nfile2.ts", timestamp: 4 }),
      makeHerdEvent("h1", "#5 | turn_end | ✓ 3s", 5),
      makeMessage({ id: "a2", role: "assistant", content: "All done.", timestamp: 6 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    // a1 should NOT be a sub-conclusion because a tool result intervened
    expect(turn.subConclusions).toHaveLength(0);
    expect((turn.responseEntry as { msg: ChatMessage }).msg.id).toBe("a2");
  });

  it("picks only the last of consecutive assistant messages before a herd event", () => {
    // When two assistant messages appear in a row before a herd event,
    // only the second (immediately preceding) becomes the sub-conclusion.
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "First thought.", timestamp: 2 }),
      makeMessage({ id: "a2", role: "assistant", content: "Second thought.", timestamp: 3 }),
      makeHerdEvent("h1", "#5 | turn_end | ✓ 3s", 4),
      makeMessage({ id: "a3", role: "assistant", content: "Done.", timestamp: 5 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(turn.subConclusions).toHaveLength(1);
    // a2 is the immediately preceding assistant, not a1
    expect((turn.subConclusions[0].entry as { msg: ChatMessage }).msg.id).toBe("a2");
  });
});

describe("summarizeHerdEvents", () => {
  it("parses session number and event type from header lines", () => {
    const entry = {
      kind: "message" as const,
      msg: makeHerdEvent("h1", "1 events from 1 sessions\n\n#5 | turn_end | ✓ 15.3s\n  [42] asst: Done"),
    };
    const result = summarizeHerdEvents([entry]);
    expect(result).toBe("Herd: #5 turn_end");
  });

  it("combines multiple events from different messages", () => {
    const entries = [
      { kind: "message" as const, msg: makeHerdEvent("h1", "#264 | turn_end | ✓ 5s") },
      { kind: "message" as const, msg: makeHerdEvent("h2", "#267 | permission_request | pending") },
    ];
    const result = summarizeHerdEvents(entries);
    expect(result).toBe("Herd: #264 turn_end, #267 permission_request");
  });

  it("returns fallback for empty input", () => {
    expect(summarizeHerdEvents([])).toBe("Herd event");
  });
});

describe("useFeedModel", () => {
  it("matches the full feed model when given a frozen prefix and active tail", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "one", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "reply one", timestamp: 2 }),
      makeMessage({ id: "u2", role: "user", content: "two", timestamp: 3 }),
      makeMessage({ id: "a2", role: "assistant", content: "reply two", timestamp: 4 }),
    ];

    const full = buildFeedModel(messages);
    const { result } = renderHook(() => useFeedModel(messages, { frozenCount: 2, frozenRevision: 0 }));

    expect(result.current.turns.map((turn) => turn.id)).toEqual(full.turns.map((turn) => turn.id));
    expect(result.current.turns.map((turn) => turn.stats)).toEqual(full.turns.map((turn) => turn.stats));
  });

  it("keeps matching the full model when the frozen boundary advances after a completed turn", () => {
    const firstTurn: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "one", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "reply one", timestamp: 2 }),
    ];
    const secondTurn: ChatMessage[] = [
      makeMessage({ id: "u2", role: "user", content: "two", timestamp: 3 }),
      makeMessage({ id: "a2", role: "assistant", content: "reply two", timestamp: 4 }),
    ];
    const allMessages = [...firstTurn, ...secondTurn];

    const { result, rerender } = renderHook(
      ({ messages, frozenCount }) => useFeedModel(messages, { frozenCount, frozenRevision: 0 }),
      { initialProps: { messages: allMessages, frozenCount: 2 } },
    );

    expect(result.current.turns.map((turn) => turn.id)).toEqual(
      buildFeedModel(allMessages).turns.map((turn) => turn.id),
    );

    rerender({ messages: allMessages, frozenCount: 4 });

    expect(result.current.turns.map((turn) => turn.id)).toEqual(
      buildFeedModel(allMessages).turns.map((turn) => turn.id),
    );
    expect(
      result.current.turns.map((turn) => (turn.responseEntry?.kind === "message" ? turn.responseEntry.msg.id : null)),
    ).toEqual(
      buildFeedModel(allMessages).turns.map((turn) =>
        turn.responseEntry?.kind === "message" ? turn.responseEntry.msg.id : null,
      ),
    );
  });

  it("does not re-merge a delayed synthetic herd turn across the frozen/active boundary", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "what is the prompt limit?", timestamp: 1_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "It's 56K tokens.", timestamp: 10_000 }),
      makeHerdEvent("h1", "#193 | turn_end | ✓ 1m 38s", 185_000),
      makeMessage({ id: "a2", role: "assistant", content: "Routine update from #193. @to(self)", timestamp: 190_000 }),
    ];

    const full = buildFeedModel(messages, true);
    expect(full.turns).toHaveLength(2);

    const { result } = renderHook(() =>
      useFeedModel(messages, { leaderMode: true, frozenCount: 2, frozenRevision: 0 }),
    );

    expect(result.current.turns).toHaveLength(2);
    expect(result.current.turns.map((turn) => turn.id)).toEqual(full.turns.map((turn) => turn.id));
    expect(result.current.turns[1].userEntry).toBeNull();
    expect(result.current.turns[1].stats.herdEventCount).toBe(1);
  });

  it("re-merges same-turn Codex leader activity with herd events across the frozen/active boundary", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "review the worker state", timestamp: 1_000 }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "The prompt survived, and #496 already completed the planning turn.",
        timestamp: 4_000,
      }),
      makeHerdEvent("h1", "#496 | turn_end | ✓ 17s", 8_000),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 9_000,
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/tmp/q-352.md" } }],
      }),
      makeMessage({
        id: "a3",
        role: "assistant",
        content: "It returned a plan after reading the new feedback.",
        timestamp: 10_000,
      }),
    ];

    const full = buildFeedModel(messages, true);
    expect(full.turns).toHaveLength(1);

    const { result } = renderHook(() =>
      useFeedModel(messages, { leaderMode: true, frozenCount: 2, frozenRevision: 0 }),
    );

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns.map((turn) => turn.id)).toEqual(full.turns.map((turn) => turn.id));
    expect(entryIds(result.current.turns[0].allEntries)).toEqual(entryIds(full.turns[0].allEntries));
    expect(result.current.turns[0].stats.herdEventCount).toBe(1);
    expect(result.current.turns[0].stats.toolCount).toBe(1);
  });
});
