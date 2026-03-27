// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { ChatMessage } from "../types.js";
import { buildFeedModel, useFeedModel } from "./use-feed-model.js";

function makeMessage(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"] }): ChatMessage {
  return {
    content: "",
    timestamp: 1,
    ...overrides,
  };
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
});
