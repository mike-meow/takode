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
      type: "review_ready",
      actionLabel: "Review",
      priority: "review",
      route: { threadKey: "q-984", questId: "q-984", messageId: "m-2" },
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

  it("distinguishes dismissed, resolved, reopened, and superseded chip eligibility", () => {
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
