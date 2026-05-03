import { describe, expect, it } from "vitest";
import type { ChatMessage, SessionAttentionRecord, SessionNotification } from "../types.js";
import { buildAttentionRecords, selectAttentionChipRecords, selectMainLedgerRecords } from "./attention-records.js";

function notification(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: "n-1",
    category: "needs-input",
    summary: "Choose the next phase",
    suggestedAnswers: ["Proceed"],
    timestamp: 100,
    messageId: "m-1",
    threadKey: "q-983",
    questId: "q-983",
    done: false,
    ...overrides,
  };
}

function explicitRecord(overrides: Partial<SessionAttentionRecord> = {}): SessionAttentionRecord {
  return {
    id: "manual:1",
    leaderSessionId: "leader-1",
    type: "needs_input",
    source: { kind: "manual", id: "manual:1" },
    questId: "q-983",
    threadKey: "q-983",
    title: "Manual attention",
    summary: "Manual attention summary",
    actionLabel: "Answer",
    priority: "needs_input",
    state: "unresolved",
    createdAt: 100,
    updatedAt: 100,
    route: { threadKey: "q-983", questId: "q-983", messageId: "m-1" },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: "manual:1",
    ...overrides,
  };
}

describe("attention records", () => {
  it("normalizes needs-input and review notifications into routed records", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      notifications: [
        notification(),
        notification({
          id: "n-2",
          category: "review",
          summary: "q-984 ready for review",
          messageId: "m-2",
          threadKey: "q-984",
          questId: "q-984",
          timestamp: 200,
        }),
      ],
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: "notification:n-1",
      type: "needs_input",
      actionLabel: "Answer",
      priority: "needs_input",
      state: "unresolved",
      route: { threadKey: "q-983", questId: "q-983", messageId: "m-1" },
    });
    expect(records[1]).toMatchObject({
      id: "notification:n-2",
      type: "quest_completed_recent",
      title: "Journey finished",
      summary: "",
      actionLabel: "Open",
      priority: "review",
      route: { threadKey: "q-984", questId: "q-984", messageId: "m-2" },
    });
  });

  it("converts ready-for-review notification copy into compact finished ledger display", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      notifications: [
        notification({
          id: "n-review",
          category: "review",
          summary: "q-984 ready for review: Compact notification inbox copy",
          threadKey: "q-984",
          questId: "q-984",
        }),
        notification({
          id: "n-batch",
          category: "review",
          summary: "2 quests ready for review: q-1, q-2",
          threadKey: "main",
          questId: undefined,
          timestamp: 200,
        }),
      ],
    });

    expect(records[0]).toMatchObject({
      type: "quest_completed_recent",
      title: "Journey finished",
      summary: "Compact notification inbox copy",
      questId: "q-984",
    });
    expect(records[1]).toMatchObject({
      id: "notification:n-batch:q-1",
      type: "quest_completed_recent",
      title: "Journey finished",
      summary: "2 quests finished",
      questId: "q-1",
      route: { threadKey: "q-1", questId: "q-1" },
    });
    expect(records[2]).toMatchObject({
      id: "notification:n-batch:q-2",
      type: "quest_completed_recent",
      questId: "q-2",
      route: { threadKey: "q-2", questId: "q-2" },
    });
  });

  it("keeps resolved notifications in the ledger but removes them from active chips", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      notifications: [notification({ done: true })],
    });

    expect(selectMainLedgerRecords(records)).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: "resolved", resolvedAt: 100 });
    expect(selectAttentionChipRecords(records)).toHaveLength(0);
  });

  it("keeps active needs-input notifications out of the Main ledger", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      notifications: [notification()],
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "needs_input", state: "unresolved" });
    expect(selectMainLedgerRecords(records)).toHaveLength(0);
    expect(selectAttentionChipRecords(records)).toHaveLength(1);
  });

  it("deduplicates repeated source signatures and lets the latest source state win", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      notifications: [notification({ timestamp: 100 }), notification({ timestamp: 300, done: true })],
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      dedupeKey: "notification:n-1",
      createdAt: 100,
      updatedAt: 300,
      state: "resolved",
    });
  });

  it("keeps server-authoritative lifecycle states in the ledger while selecting only active chip states", () => {
    // Persisted attention records are the source for lifecycle states that do
    // not come from notifications or board rows, including user-visible seen,
    // dismissed, reopened, and superseded state.
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      records: [
        explicitRecord({ id: "manual:dismissed", state: "dismissed", dedupeKey: "manual:dismissed" }),
        explicitRecord({ id: "manual:resolved", state: "resolved", dedupeKey: "manual:resolved" }),
        explicitRecord({ id: "manual:reopened", state: "reopened", dedupeKey: "manual:reopened", updatedAt: 300 }),
        explicitRecord({ id: "manual:superseded", state: "superseded", dedupeKey: "manual:superseded" }),
        explicitRecord({ id: "manual:seen", state: "seen", dedupeKey: "manual:seen", updatedAt: 200 }),
      ],
    });

    expect(selectMainLedgerRecords(records)).toHaveLength(5);
    expect(selectAttentionChipRecords(records).map((record) => record.state)).toEqual(["reopened", "seen"]);
  });

  it("creates a low-priority rework milestone from routed quest-thread user feedback", () => {
    // Mirrors the Mental Simulation scenario from #1132 msg 9248: routed user
    // feedback saying the result needs fixing should surface in Main as a
    // ledger milestone without becoming an active chip.
    const messages: ChatMessage[] = [
      {
        id: "msg-9248",
        role: "user",
        content:
          "This looks horrible. Please ask the agent to fix this. All consecutive hidden activities should be merged.",
        timestamp: 9248,
        metadata: {
          threadRefs: [{ threadKey: "q-975", questId: "q-975", source: "explicit" }],
        },
      },
    ];

    const records = buildAttentionRecords({ leaderSessionId: "leader-1", messages });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "message-rework:msg-9248",
      type: "quest_reopened_or_rework",
      priority: "milestone",
      state: "reopened",
      questId: "q-975",
      threadKey: "q-975",
      route: { threadKey: "q-975", questId: "q-975", messageId: "msg-9248" },
      chipEligible: false,
      ledgerEligible: true,
    });
    expect(selectMainLedgerRecords(records)).toHaveLength(1);
    expect(selectAttentionChipRecords(records)).toHaveLength(0);
  });

  it("does not create rework attention from routine quest-thread implementation steering", () => {
    const messages: ChatMessage[] = [
      {
        id: "steering-fix-this",
        role: "user",
        content: "Please fix this edge case while you are in the implementation.",
        timestamp: 9300,
        metadata: {
          threadRefs: [{ threadKey: "q-975", questId: "q-975", source: "explicit" }],
        },
      },
      {
        id: "steering-change-this",
        role: "user",
        content: "Change this to keep moved-message markers separate from grouped activity.",
        timestamp: 9301,
        metadata: {
          threadRefs: [{ threadKey: "q-975", questId: "q-975", source: "explicit" }],
        },
      },
      {
        id: "steering-reopen",
        role: "user",
        content: "Reopen the details section when the user asks for it.",
        timestamp: 9302,
        metadata: {
          threadRefs: [{ threadKey: "q-975", questId: "q-975", source: "explicit" }],
        },
      },
    ];

    expect(buildAttentionRecords({ leaderSessionId: "leader-1", messages })).toHaveLength(0);
  });

  it("does not create rework attention from implementation status text in quest threads", () => {
    // Mirrors #1132 msg 9344 style implementation steering/status. These rows
    // are useful quest-thread context, not Main attention milestones.
    const messages: ChatMessage[] = [
      {
        id: "msg-9344-style",
        role: "assistant",
        content:
          "For q-975, I’m answering the worker’s boundary question directly: moved-message markers should break hidden-activity groups.",
        timestamp: 9344,
        metadata: {
          threadRefs: [{ threadKey: "q-975", questId: "q-975", source: "explicit" }],
        },
      },
    ];

    expect(buildAttentionRecords({ leaderSessionId: "leader-1", messages })).toHaveLength(0);
  });

  it("creates blocker attention only for explicit board wait-for-input state", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      boardRows: [
        {
          questId: "q-983",
          title: "Implement Main attention ledger rows",
          waitForInput: ["n-missing"],
          updatedAt: 300,
        },
        {
          questId: "q-984",
          title: "Implement compact chips",
          waitFor: ["free-worker"],
          updatedAt: 400,
        },
      ],
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "board-needs-input:q-983:n-missing",
      type: "needs_input",
      actionLabel: "Answer",
      summary: "Waiting for input: n-missing",
    });
  });

  it("does not duplicate board wait-for-input rows already covered by notifications", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      notifications: [notification({ id: "n-covered" })],
      boardRows: [{ questId: "q-983", waitForInput: ["n-covered"], updatedAt: 200 }],
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.source.kind).toBe("notification");
  });

  it("keeps completed board rows conservative until a review source exists", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      completedBoardRows: [{ questId: "q-968", title: "Clean threads", updatedAt: 100, completedAt: 120 }],
    });

    expect(records).toHaveLength(0);
  });

  it("uses server-authoritative Journey finish records instead of duplicating matching review notifications", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      records: [
        explicitRecord({
          id: "board-journey-finished:q-984:200",
          type: "quest_completed_recent",
          source: { kind: "board", id: "q-984", questId: "q-984", signature: "finished:200" },
          questId: "q-984",
          threadKey: "q-984",
          title: "Finished",
          summary: "Compact notification inbox copy",
          actionLabel: "Open",
          priority: "review",
          state: "unresolved",
          createdAt: 200,
          updatedAt: 200,
          route: { threadKey: "q-984", questId: "q-984" },
          chipEligible: false,
          ledgerEligible: true,
          dedupeKey: "board-journey-finished:q-984:200",
        }),
      ],
      notifications: [
        notification({
          id: "n-review",
          category: "review",
          summary: "q-984 ready for review: Compact notification inbox copy",
          threadKey: "q-984",
          questId: "q-984",
        }),
      ],
    });

    expect(selectMainLedgerRecords(records)).toHaveLength(1);
    expect(records.find((record) => record.id === "notification:n-review")).toMatchObject({
      type: "quest_completed_recent",
      ledgerEligible: false,
      chipEligible: false,
    });
  });

  it("marks only the matching completed Journey start as completed for repeated runs", () => {
    const records = buildAttentionRecords({
      leaderSessionId: "leader-1",
      records: [
        explicitRecord({
          id: "started:first",
          type: "quest_journey_started",
          questId: "q-984",
          threadKey: "q-984",
          title: "Journey started",
          priority: "created",
          state: "resolved",
          createdAt: 100,
          updatedAt: 100,
          route: { threadKey: "q-984", questId: "q-984" },
          chipEligible: false,
          dedupeKey: "started:first",
        }),
        explicitRecord({
          id: "finished:first",
          type: "quest_completed_recent",
          questId: "q-984",
          threadKey: "q-984",
          title: "Finished",
          priority: "review",
          state: "unresolved",
          createdAt: 200,
          updatedAt: 200,
          route: { threadKey: "q-984", questId: "q-984" },
          chipEligible: false,
          dedupeKey: "finished:first",
        }),
        explicitRecord({
          id: "started:second",
          type: "quest_journey_started",
          questId: "q-984",
          threadKey: "q-984",
          title: "Journey started",
          priority: "created",
          state: "resolved",
          createdAt: 300,
          updatedAt: 300,
          route: { threadKey: "q-984", questId: "q-984" },
          chipEligible: false,
          dedupeKey: "started:second",
        }),
      ],
    });

    expect(records.find((record) => record.id === "started:first")).toMatchObject({
      journeyLifecycleStatus: "completed",
    });
    expect(records.find((record) => record.id === "finished:first")).toMatchObject({
      title: "Journey finished",
      journeyLifecycleStatus: "completed",
    });
    expect(records.find((record) => record.id === "started:second")).toMatchObject({
      journeyLifecycleStatus: "active",
    });
  });

  it("keeps persisted thread-open records out of the visible Main ledger", () => {
    const threadOpened = explicitRecord({
      id: "thread-opened:q-984",
      type: "quest_thread_created",
      source: { kind: "manual", id: "q-984", questId: "q-984", signature: "thread-opened" },
      title: "Thread opened",
      priority: "created",
      state: "resolved",
      chipEligible: false,
      dedupeKey: "thread-opened:q-984",
    });
    const needsInput = explicitRecord({ id: "manual:needs-input", dedupeKey: "manual:needs-input" });

    const records = buildAttentionRecords({ leaderSessionId: "leader-1", records: [threadOpened, needsInput] });

    expect(records.map((record) => record.type)).toContain("quest_thread_created");
    expect(selectMainLedgerRecords(records).map((record) => record.type)).toEqual(["needs_input"]);
  });

  it("does not turn hidden cross-thread activity markers into attention", () => {
    const messages: ChatMessage[] = [
      {
        id: "cross-thread-activity:q-975:m-1",
        role: "system",
        content: "2 activities in thread:q-975",
        timestamp: 100,
        ephemeral: true,
        metadata: {
          threadKey: "q-975",
          questId: "q-975",
          crossThreadActivityMarker: {
            threadKey: "q-975",
            questId: "q-975",
            count: 2,
            firstMessageId: "m-1",
            lastMessageId: "m-2",
            startedAt: 90,
            updatedAt: 100,
          },
        },
      },
    ];

    expect(buildAttentionRecords({ leaderSessionId: "leader-1", messages })).toHaveLength(0);
  });
});
