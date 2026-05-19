// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { ChatMessage, SessionAttentionRecord } from "../types.js";
import { buildFeedModel, useFeedModel, summarizeHerdEvents } from "./use-feed-model.js";
import { buildFeedSections } from "../components/message-feed-sections.js";

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

function makeInjectedUserMessage(
  id: string,
  content: string,
  timestamp: number,
  sessionId: string,
  sessionLabel?: string,
): ChatMessage {
  return makeMessage({
    id,
    role: "user",
    content,
    timestamp,
    agentSource: { sessionId, ...(sessionLabel ? { sessionLabel } : {}) } as ChatMessage["agentSource"],
  });
}

function makeNotifyToolMessage(id: string, timestamp: number): ChatMessage {
  return makeMessage({
    id,
    role: "assistant",
    content: "",
    timestamp,
    contentBlocks: [
      {
        type: "tool_use",
        id: `${id}-tool`,
        name: "Bash",
        input: { command: 'takode notify needs-input "confirm proposal"' },
      },
    ],
  });
}

function makeVisibleLeaderMessage(id: string, content: string, timestamp: number): ChatMessage {
  return makeMessage({
    id,
    role: "assistant",
    content,
    timestamp,
    metadata: { leaderUserMessage: true },
  });
}

function makeAssistantMessage(id: string, content: string, timestamp: number): ChatMessage {
  return makeMessage({
    id,
    role: "assistant",
    content,
    timestamp,
    contentBlocks: [{ type: "text", text: content }],
  });
}

function makeJourneyFinishedRecord(overrides: Partial<SessionAttentionRecord> = {}): SessionAttentionRecord {
  const createdAt = overrides.createdAt ?? 4;
  return {
    id: "notification:n-journey-finished",
    leaderSessionId: "leader-1",
    type: "quest_completed_recent",
    source: { kind: "notification", id: "n-journey-finished", questId: "q-1151" },
    questId: "q-1151",
    threadKey: "q-1151",
    title: "Journey finished",
    summary: "Keep Journey chips anchored",
    actionLabel: "Open",
    priority: "review",
    state: "unresolved",
    createdAt,
    updatedAt: createdAt,
    route: { threadKey: "q-1151", questId: "q-1151" },
    chipEligible: false,
    ledgerEligible: true,
    dedupeKey: "notification:n-journey-finished",
    journeyLifecycleStatus: "completed",
    ...overrides,
  };
}

/** Helper to extract the message IDs from a turn's entries. */
function entryIds(entries: { kind: string; msg?: { id: string } }[]): string[] {
  return entries.filter((e) => e.kind === "message").map((e) => (e as { msg: { id: string } }).msg.id);
}

function collapsedEntryIds(turn: {
  collapsedEntries?: NonNullable<ReturnType<typeof buildFeedModel>["turns"][number]["collapsedEntries"]>;
}): string[] {
  return (turn.collapsedEntries ?? []).map((entry) => {
    if (entry.kind === "activity") return "activity";
    if (entry.entry.kind === "message") return entry.entry.msg.id;
    return entry.entry.kind;
  });
}

describe("leader mode raw deprecated tags", () => {
  it("keeps deprecated @to(user) text as private activity", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "do the thing", timestamp: 1 }),
      makeMessage({ id: "a-internal", role: "assistant", content: "Let me think about this...", timestamp: 2 }),
      makeMessage({ id: "a-touser", role: "assistant", content: "Here's the result @to(user)", timestamp: 3 }),
    ];

    const model = buildFeedModel(messages, true);
    expect(model.turns).toHaveLength(1);
    const turn = model.turns[0];

    expect(turn.responseEntry).toBeNull();
    expect(entryIds(turn.agentEntries)).toContain("a-internal");
    expect(entryIds(turn.agentEntries)).toContain("a-touser");
    expect(entryIds(turn.allEntries)).toContain("a-touser");
  });

  it("keeps earlier deprecated-tag messages inside agentEntries", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a-internal", role: "assistant", content: "Planning...", timestamp: 2 }),
      makeMessage({ id: "a-touser-1", role: "assistant", content: "First update @to(user)", timestamp: 3 }),
      makeMessage({ id: "a-internal2", role: "assistant", content: "More internal work...", timestamp: 4 }),
      makeMessage({ id: "a-touser-2", role: "assistant", content: "Final result @to(user)", timestamp: 5 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(turn.responseEntry).toBeNull();
    expect(entryIds(turn.agentEntries)).toContain("a-touser-2");
    expect(entryIds(turn.agentEntries)).toContain("a-touser-1");
    expect(entryIds(turn.agentEntries)).toContain("a-internal");
    expect(entryIds(turn.agentEntries)).toContain("a-internal2");
  });

  it("keeps deprecated @to(self) messages visible in leader mode", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a-self", role: "assistant", content: "Internal handoff @to(self)", timestamp: 2 }),
      makeMessage({ id: "a-touser", role: "assistant", content: "Done @to(user)", timestamp: 3 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(entryIds(turn.agentEntries)).toContain("a-self");
    expect(entryIds(turn.allEntries)).toContain("a-self");
  });

  it("counts deprecated-tagged messages like normal assistant messages", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a-int1", role: "assistant", content: "thinking...", timestamp: 2 }),
      makeMessage({ id: "a-int2", role: "assistant", content: "more thinking...", timestamp: 3 }),
      makeMessage({ id: "a-self", role: "assistant", content: "handoff @to(self)", timestamp: 4 }),
      makeMessage({ id: "a-touser", role: "assistant", content: "result @to(user)", timestamp: 5 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(turn.stats.messageCount).toBe(4);
  });
});

describe("leader mode collapsed preview without deprecated metadata", () => {
  it("keeps ordinary assistant messages private instead of promoting a responseEntry", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "work on task q-42", timestamp: 1 }),
      makeMessage({ id: "a1", role: "assistant", content: "Starting work on task q-42...", timestamp: 2 }),
      makeMessage({ id: "a2", role: "assistant", content: "I've completed the implementation.", timestamp: 3 }),
    ];

    const model = buildFeedModel(messages, true);
    expect(model.turns).toHaveLength(1);
    const turn = model.turns[0];

    expect(turn.responseEntry).toBeNull();
    expect(entryIds(turn.agentEntries)).toContain("a1");
    expect(entryIds(turn.agentEntries)).toContain("a2");
  });

  it("keeps @to(self) text private like ordinary leader output", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a-self", role: "assistant", content: "Internal coordination @to(self)", timestamp: 2 }),
      makeMessage({ id: "a-normal", role: "assistant", content: "Done with the task.", timestamp: 3 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(turn.responseEntry).toBeNull();
    expect(entryIds(turn.agentEntries)).toContain("a-self");
    expect(entryIds(turn.agentEntries)).toContain("a-normal");
    expect(entryIds(turn.allEntries)).toContain("a-self");
  });

  it("does not promote last assistant text over earlier deprecated-tagged messages", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a-touser", role: "assistant", content: "Status update @to(user)", timestamp: 2 }),
      makeMessage({ id: "a-final", role: "assistant", content: "All done, synced to main.", timestamp: 3 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(turn.responseEntry).toBeNull();
    expect(entryIds(turn.agentEntries)).toContain("a-touser");
    expect(entryIds(turn.agentEntries)).toContain("a-final");
  });

  it("shows explicit leader user-message entries in collapsed-visible entries", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "go", timestamp: 1 }),
      makeMessage({ id: "a-private", role: "assistant", content: "private coordination", timestamp: 2 }),
      makeMessage({
        id: "a-visible",
        role: "assistant",
        content: "Visible leader update",
        timestamp: 3,
        metadata: { leaderUserMessage: true },
      }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(turn.responseEntry).toBeNull();
    expect(entryIds(turn.notificationEntries)).toEqual(["a-visible"]);
    expect(entryIds(turn.agentEntries)).toContain("a-private");
    expect(turn.stats.messageCount).toBe(1);
  });

  it("keeps Journey-finished ledger rows in chronological collapsed-turn order", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "coordinate Journey work", timestamp: 1 }),
      makeMessage({
        id: "a-visible-before",
        role: "assistant",
        content: "Visible leader update before the Journey finishes.",
        timestamp: 2,
        metadata: { leaderUserMessage: true },
      }),
      makeMessage({ id: "a-private-before", role: "assistant", content: "private work before finish", timestamp: 3 }),
      makeMessage({
        id: "journey-finished",
        role: "system",
        content: "Open: Journey finished",
        timestamp: 4,
        variant: "info",
        metadata: { attentionRecord: makeJourneyFinishedRecord({ createdAt: 4, updatedAt: 4 }) },
      }),
      makeMessage({ id: "a-private-after", role: "assistant", content: "private work after finish", timestamp: 5 }),
      makeMessage({
        id: "a-visible-after",
        role: "assistant",
        content: "Visible leader update after the Journey finishes.",
        timestamp: 6,
        metadata: { leaderUserMessage: true },
      }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(entryIds(turn.systemEntries)).not.toContain("journey-finished");
    expect(entryIds(turn.notificationEntries)).toEqual(["a-visible-before", "journey-finished", "a-visible-after"]);
    expect(collapsedEntryIds(turn)).toEqual([
      "a-visible-before",
      "activity",
      "journey-finished",
      "activity",
      "a-visible-after",
    ]);
    expect(entryIds(turn.agentEntries)).toEqual(["a-private-before", "a-private-after"]);
  });
});

describe("leader mode segment-local needs-input preview selection", () => {
  it("preserves normal segment summaries when no needs-input notification is present", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "coordinate work", timestamp: 1 }),
      makeMessage({ id: "a-private", role: "assistant", content: "Checking the board before routing.", timestamp: 2 }),
      makeVisibleLeaderMessage("a-status", "Worker is dispatched and I’m waiting for the read-in.", 3),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(collapsedEntryIds(turn)).toEqual(["activity", "a-status"]);
    expect(entryIds(turn.notificationEntries)).toEqual(["a-status"]);
  });

  it("promotes the proposal immediately before a needs-input notify call", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "make a quest", timestamp: 1 }),
      makeMessage({
        id: "a-proposal",
        role: "assistant",
        content:
          "Proposed Quest\n\n- Title: Improve collapsed previews\n- Goal / Acceptance: keep proposals visible when confirmation is requested.",
        timestamp: 2,
      }),
      makeNotifyToolMessage("a-notify", 3),
      makeVisibleLeaderMessage("a-waiting", "Waiting on confirmation before creating the quest.", 4),
    ];

    const model = buildFeedModel(messages, true, 0, ["a-notify"]);
    const turn = model.turns[0];

    expect(collapsedEntryIds(turn)).toEqual(["a-proposal", "a-notify", "a-waiting"]);
    expect(entryIds(turn.agentEntries)).toEqual([]);
    expect(turn.stats.messageCount).toBe(0);
  });

  it("promotes the proposal immediately after a needs-input notify call", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "revise the proposal", timestamp: 1 }),
      makeNotifyToolMessage("a-notify", 2),
      makeMessage({
        id: "a-proposal",
        role: "assistant",
        content:
          "Proposed Quest\n\n- Title: Revised preview heuristic\n- Goal / Acceptance: implement the user-approved segment-local behavior.",
        timestamp: 3,
      }),
      makeVisibleLeaderMessage("a-waiting", "Approval notification `42` is open for the revised proposal.", 4),
    ];

    const model = buildFeedModel(messages, true, 0, ["a-notify"]);
    const turn = model.turns[0];

    expect(collapsedEntryIds(turn)).toEqual(["a-notify", "a-proposal", "a-waiting"]);
    expect(entryIds(turn.agentEntries)).toEqual([]);
  });

  it("promotes same-response text that also invokes a needs-input notify tool", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "confirm this plan", timestamp: 1 }),
      makeMessage({
        id: "a-mixed",
        role: "assistant",
        content:
          "Proposed Quest\n\n- Title: Same response proposal\n- Goal / Acceptance: keep text eligible even when the response also calls notify.",
        timestamp: 2,
        contentBlocks: [
          {
            type: "tool_use",
            id: "notify-tool",
            name: "Bash",
            input: { command: 'takode notify needs-input "approve same response proposal"' },
          },
        ],
      }),
      makeVisibleLeaderMessage("a-waiting", "Approval notification `43` is open for the same-response proposal.", 3),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(collapsedEntryIds(turn)).toEqual(["a-mixed", "a-waiting"]);
    expect(entryIds(turn.agentEntries)).toEqual([]);
  });

  it("finds the proposal across intervening tool activity before the notify call", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "investigate CI", timestamp: 1 }),
      makeMessage({
        id: "a-proposal",
        role: "assistant",
        content:
          "Checkpoint for [q-1335](quest:q-1335):\n\nFindings:\n- The failing job is macOS `bun run test`.\n- The user must choose the fix scope.",
        timestamp: 2,
      }),
      makeMessage({
        id: "a-board-tool",
        role: "assistant",
        content: "",
        timestamp: 3,
        contentBlocks: [
          { type: "tool_use", id: "board-tool", name: "Bash", input: { command: "takode board detail q-1335" } },
        ],
      }),
      makeNotifyToolMessage("a-notify", 4),
      makeMessage({
        id: "a-set-tool",
        role: "assistant",
        content: "",
        timestamp: 5,
        contentBlocks: [
          { type: "tool_use", id: "set-tool", name: "Bash", input: { command: "takode board set q-1335" } },
        ],
      }),
      makeVisibleLeaderMessage(
        "a-waiting",
        "Published the checkpoint and linked [q-1335](quest:q-1335) to needs-input `215`.",
        6,
      ),
    ];

    const model = buildFeedModel(messages, true, 0, ["a-notify"]);
    const turn = model.turns[0];

    expect(collapsedEntryIds(turn)).toEqual(["a-proposal", "activity", "a-notify", "activity", "a-waiting"]);
    expect(entryIds(turn.agentEntries)).toEqual([]);
  });

  it("uses the successful retry context when a prior needs-input notify attempt was orphaned", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "change this icon", timestamp: 1 }),
      makeMessage({
        id: "a-proposal",
        role: "assistant",
        content:
          "Proposed Quest\n\n- Title: Replace Memory tab icon with a brain icon\n- Goal / Acceptance: preserve navigation behavior and layout stability.",
        timestamp: 2,
      }),
      makeNotifyToolMessage("a-orphaned-notify", 3),
      makeNotifyToolMessage("a-retry-notify", 4),
      makeVisibleLeaderMessage(
        "a-waiting",
        "Approval notification `390` is open for the Memory tab brain icon quest.",
        5,
      ),
    ];

    const model = buildFeedModel(messages, true, 0, ["a-retry-notify"]);
    const turn = model.turns[0];

    expect(collapsedEntryIds(turn)).toEqual(["a-proposal", "activity", "a-retry-notify", "a-waiting"]);
    expect(entryIds(turn.agentEntries)).toEqual([]);
  });

  it("falls back to the existing short status when the segment has no substantive proposal", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "open a decision prompt", timestamp: 1 }),
      makeNotifyToolMessage("a-notify", 2),
      makeVisibleLeaderMessage("a-waiting", "Waiting on confirmation before dispatch.", 3),
    ];

    const model = buildFeedModel(messages, true, 0, ["a-notify"]);
    const turn = model.turns[0];

    expect(collapsedEntryIds(turn)).toEqual(["a-notify", "a-waiting"]);
    expect(entryIds(turn.agentEntries)).toEqual([]);
  });
});

describe("sub-conclusions in collapsed turns", () => {
  // Sub-conclusions are assistant messages immediately preceding herd event injections.
  // They represent intermediate progress worth showing when a turn is collapsed.

  it("does not extract sub-conclusions from private leader output", () => {
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

    expect(turn.subConclusions).toHaveLength(0);
    expect(turn.responseEntry).toBeNull();
    expect(entryIds(turn.agentEntries)).toContain("a1");
    expect(entryIds(turn.agentEntries)).toContain("a2");
    expect(entryIds(turn.agentEntries)).toContain("a3");
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

    expect(
      summarizeHerdEvents([
        { kind: "message", msg: makeHerdEvent("summary-h1", "#264 | turn_end | ✓ 5s", 3) },
        { kind: "message", msg: makeHerdEvent("summary-h2", "#267 | turn_end | ✓ 8s", 4) },
      ]),
    ).toBe("Herd: #264 turn_end, #267 turn_end");
    expect(turn.subConclusions).toHaveLength(0);
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

  it("keeps delayed herd events in the same Claude leader turn after a completed response", () => {
    // q-358: Claude leaders should now keep all herd/timer/notification-style
    // updates inside the same agent turn until a real human user message
    // arrives. Delayed herd activity no longer starts a synthetic extra turn.
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "what is the prompt limit?", timestamp: 1_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "It's 56K tokens.", timestamp: 10_000 }),
      makeHerdEvent("h1", "#193 | turn_end | ✓ 1m 38s", 185_000),
      makeMessage({ id: "a2", role: "assistant", content: "Routine update from #193. @to(self)", timestamp: 190_000 }),
      makeHerdEvent("h2", "#449 | turn_end | ✓ 33.0s", 320_000),
      makeMessage({ id: "a3", role: "assistant", content: "Routine update from #449. @to(self)", timestamp: 325_000 }),
    ];

    const model = buildFeedModel(messages, true);

    expect(model.turns).toHaveLength(1);
    expect(model.turns[0].userEntry?.kind).toBe("message");
    expect((model.turns[0].userEntry as { msg: ChatMessage }).msg.id).toBe("u1");
    expect(model.turns[0].responseEntry).toBeNull();
    expect(model.turns[0].stats.herdEventCount).toBe(2);
    expect(entryIds(model.turns[0].allEntries)).toContain("h1");
    expect(entryIds(model.turns[0].allEntries)).toContain("h2");
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

    expect(turn.responseEntry).toBeNull();
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
    expect(turn.responseEntry).toBeNull();
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

    expect(turn.subConclusions).toHaveLength(0);
  });

  it("does not duplicate a notification-bearing assistant message as a sub-conclusion", () => {
    // q-524: a notification-bearing assistant message can remain visible in the
    // collapsed turn, but it must not also be promoted into subConclusions when
    // a herd event follows it.
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "what changed?", timestamp: 1 }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "q-514 is complete and q-521 is unblocked.",
        timestamp: 2,
        notification: {
          category: "review",
          summary: "q-521 can be dispatched now",
          timestamp: 2,
        },
      }),
      makeHerdEvent("h1", "#514 | wait_for_resolved | ✓ q-521 unblocked", 3),
      makeMessage({ id: "u2", role: "user", content: "next", timestamp: 4 }),
    ];

    const model = buildFeedModel(messages, true);
    const turn = model.turns[0];

    expect(turn.notificationEntries).toHaveLength(1);
    expect((turn.notificationEntries[0] as { kind: "message"; msg: ChatMessage }).msg.id).toBe("a1");
    expect(turn.subConclusions).toHaveLength(0);
    expect(turn.responseEntry).toBeNull();
  });

  it("keeps a tool-only assistant message out of tool grouping when the store already has an anchored notification", () => {
    // q-568: during the lag window, the inbox notification can already be
    // anchored to the message before `msg.notification` lands on the assistant
    // payload. The feed model must preserve the assistant message so the richer
    // notification UI can render, rather than flattening it into a tool group.
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "Tell me when the fix is ready.", timestamp: 1 }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 2,
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-review",
            name: "Bash",
            input: { command: 'TAKODE_API_PORT=3455 takode notify review "q-568 ready"' },
          },
        ],
      }),
    ];

    const model = buildFeedModel(messages, false, 0, ["a1"]);

    expect(model.entries).toHaveLength(2);
    expect(model.entries[1]?.kind).toBe("message");
    expect((model.entries[1] as { kind: "message"; msg: ChatMessage }).msg.id).toBe("a1");
    expect(model.turns[0]?.notificationEntries).toHaveLength(1);
    expect((model.turns[0]?.notificationEntries[0] as { kind: "message"; msg: ChatMessage }).msg.id).toBe("a1");
    expect(model.turns[0]?.agentEntries).toHaveLength(0);
  });

  it("keeps source message ids on grouped terminal tool items", () => {
    // q-612: MessageFeed renders grouped terminal tools outside the original
    // assistant message component, so each item must retain its message id for
    // authoritative notification lookup and done-state rendering.
    const messages: ChatMessage[] = [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 1,
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-notify",
            name: "Bash",
            input: { command: 'takode notify needs-input "Need a decision"' },
          },
        ],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        timestamp: 2,
        contentBlocks: [{ type: "tool_use", id: "tu-send", name: "Bash", input: { command: "takode send 942" } }],
      }),
    ];

    const model = buildFeedModel(messages, false);
    const group = model.entries[0];

    expect(group?.kind).toBe("tool_msg_group");
    if (group?.kind !== "tool_msg_group") throw new Error("expected a grouped terminal entry");
    expect(group.items.map((item) => item.messageId)).toEqual(["a1", "a2"]);
  });
});

describe("worker leader-source turn boundaries", () => {
  it("uses current herding leader messages as worker feed turn boundaries", () => {
    const messages: ChatMessage[] = [];
    for (let index = 1; index <= 12; index++) {
      messages.push(
        makeInjectedUserMessage(`leader-${index}`, `Leader instruction ${index}`, index * 10, "leader-session"),
        makeAssistantMessage(`assistant-${index}`, `Worker response ${index}`, index * 10 + 1),
      );
    }

    const model = buildFeedModel(messages, false, 0, undefined, "leader-session");

    expect(model.turns).toHaveLength(12);
    expect(model.turns.map((turn) => (turn.userEntry?.kind === "message" ? turn.userEntry.msg.id : null))).toEqual(
      Array.from({ length: 12 }, (_, index) => `leader-${index + 1}`),
    );
    expect(buildFeedSections(model.turns, 5)).toHaveLength(3);
  });

  it("does not turn injected user-shaped messages or leader-visible assistant rows into worker boundaries", () => {
    const messages: ChatMessage[] = [
      makeInjectedUserMessage("leader-1", "Leader instruction 1", 1, "leader-session"),
      makeAssistantMessage("assistant-1", "Worker response 1", 2),
      makeInjectedUserMessage("timer-1", "Timer fired", 3, "timer:t1", "Timer"),
      makeHerdEvent("herd-1", "#100 | turn_end | done", 4),
      makeInjectedUserMessage(
        "compaction-1",
        "Context was compacted. Before continuing, recover enough context from your own session history to safely resume work:",
        5,
        "system:compaction-recovery",
        "Compaction Recovery",
      ),
      makeInjectedUserMessage("system-1", "System reminder", 6, "system:tag-reminder", "System"),
      makeMessage({
        id: "kickoff-1",
        role: "user",
        content: "[System] You are a leader session. Historical kickoff without source metadata.",
        timestamp: 7,
      }),
      makeVisibleLeaderMessage("leader-visible-1", "Visible leader note", 8),
      makeInjectedUserMessage("leader-2", "Leader instruction 2", 9, "leader-session"),
      makeAssistantMessage("assistant-2", "Worker response 2", 10),
    ];

    const model = buildFeedModel(messages, false, 0, undefined, "leader-session");

    expect(model.turns).toHaveLength(2);
    expect(model.turns.map((turn) => (turn.userEntry?.kind === "message" ? turn.userEntry.msg.id : null))).toEqual([
      "leader-1",
      "leader-2",
    ]);
    expect(entryIds(model.turns[0].allEntries)).toEqual([
      "assistant-1",
      "timer-1",
      "herd-1",
      "compaction-1",
      "system-1",
      "kickoff-1",
      "leader-visible-1",
    ]);
  });

  it("keeps leader-source boundaries source-aware for unherded sessions", () => {
    const messages: ChatMessage[] = [
      makeInjectedUserMessage("leader-1", "Leader instruction 1", 1, "leader-session"),
      makeAssistantMessage("assistant-1", "Worker response 1", 2),
      makeInjectedUserMessage("leader-2", "Leader instruction 2", 3, "leader-session"),
      makeAssistantMessage("assistant-2", "Worker response 2", 4),
    ];

    expect(buildFeedModel(messages, false).turns).toHaveLength(1);
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

  it("keeps a delayed herd batch merged across the frozen/active boundary", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "what is the prompt limit?", timestamp: 1_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "It's 56K tokens.", timestamp: 10_000 }),
      makeHerdEvent("h1", "#193 | turn_end | ✓ 1m 38s", 185_000),
      makeMessage({ id: "a2", role: "assistant", content: "Routine update from #193. @to(self)", timestamp: 190_000 }),
    ];

    const full = buildFeedModel(messages, true);
    expect(full.turns).toHaveLength(1);

    const { result } = renderHook(() =>
      useFeedModel(messages, { leaderMode: true, frozenCount: 2, frozenRevision: 0 }),
    );

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns.map((turn) => turn.id)).toEqual(full.turns.map((turn) => turn.id));
    expect(result.current.turns[0].stats.herdEventCount).toBe(1);
    expect(entryIds(result.current.turns[0].allEntries)).toContain("h1");
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

  it("does not create extra turns for generated user-shaped messages between real user turns", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", content: "real user request", timestamp: 1_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "working on it", timestamp: 2_000 }),
      makeHerdEvent("h1", "#490 | turn_end | ✓ 5s", 3_000),
      makeInjectedUserMessage("t1", "[⏰ Timer tm-1] check progress", 4_000, "timer:tm-1", "Timer tm-1"),
      makeInjectedUserMessage(
        "s1",
        "[System reminder] tag your response",
        4_500,
        "system:leader-tag-enforcer",
        "System",
      ),
      makeInjectedUserMessage("w1", "Worker status update", 4_750, "worker-1", "#2 worker"),
      makeMessage({ id: "a2", role: "assistant", content: "still same agent turn", timestamp: 5_000 }),
      makeMessage({ id: "u2", role: "user", content: "human follow-up", timestamp: 6_000 }),
      makeMessage({ id: "a3", role: "assistant", content: "new turn response", timestamp: 7_000 }),
    ];

    const model = buildFeedModel(messages, true);
    expect(model.turns).toHaveLength(2);
    expect((model.turns[0].userEntry as { msg: ChatMessage }).msg.id).toBe("u1");
    expect(entryIds(model.turns[0].allEntries)).toEqual(["a1", "h1", "t1", "s1", "w1", "a2"]);
    expect((model.turns[1].userEntry as { msg: ChatMessage }).msg.id).toBe("u2");
    expect(entryIds(model.turns[1].allEntries)).toEqual(["a3"]);
  });
});
