import { describe, expect, it, vi } from "vitest";
import {
  THREAD_OUTCOME_REMINDER_SOURCE_ID,
  THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
} from "../../shared/thread-outcome-reminder.js";
import type { LeaderThreadStatus } from "../../shared/thread-status-marker.js";
import type { BrowserIncomingMessage, SessionNotification } from "../session-types.js";
import type { ThreadRouteMetadata } from "../thread-routing-metadata.js";
import { validateLeaderThreadOutcomes, type LeaderThreadOutcomeTurnSource } from "./leader-thread-outcome-validator.js";

function assistantMessage({
  id,
  text,
  timestamp,
  threadKey = "main",
}: {
  id: string;
  text: string;
  timestamp: number;
  threadKey?: string;
}): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    timestamp,
    threadKey,
    ...(threadKey !== "main"
      ? {
          questId: threadKey,
          threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }],
        }
      : {}),
  };
}

function threadStatus({
  kind,
  timestamp,
  threadKey = "main",
  messageId = `a-${timestamp}`,
}: {
  kind: LeaderThreadStatus["kind"];
  timestamp: number;
  threadKey?: string;
  messageId?: string;
}): LeaderThreadStatus {
  return {
    kind,
    label: kind === "waiting" ? "Thread Waiting" : "Thread Ready",
    threadKey,
    ...(threadKey !== "main" ? { questId: threadKey } : {}),
    summary: kind === "waiting" ? "waiting on reviewer" : "ready for review",
    messageId,
    timestamp,
    updatedAt: timestamp,
  };
}

function systemUserMessage({
  id,
  timestamp,
  threadKey = "main",
}: {
  id: string;
  timestamp: number;
  threadKey?: string;
}) {
  return {
    type: "user_message",
    id,
    content: "Thread outcome reminder",
    timestamp,
    agentSource: {
      sessionId: THREAD_OUTCOME_REMINDER_SOURCE_ID,
      sessionLabel: THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
    },
    threadKey,
    ...(threadKey !== "main"
      ? {
          questId: threadKey,
          threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }],
        }
      : {}),
  } satisfies BrowserIncomingMessage;
}

function notification({
  category,
  timestamp,
  threadKey = "main",
  done = false,
}: {
  category: SessionNotification["category"];
  timestamp: number;
  threadKey?: string;
  done?: boolean;
}): SessionNotification {
  return {
    id: `n-${timestamp}`,
    category,
    summary: category,
    timestamp,
    messageId: null,
    threadKey,
    ...(threadKey !== "main" ? { questId: threadKey } : {}),
    done,
  };
}

function makeDeps(isLeaderSession = true, turnSource: LeaderThreadOutcomeTurnSource = "leader") {
  return {
    isLeaderSession: vi.fn(() => isLeaderSession),
    getTurnSource: vi.fn(() => turnSource),
    injectUserMessage: vi.fn(
      (
        _sessionId: string,
        _content: string,
        _agentSource: { sessionId: string; sessionLabel?: string },
        _threadRoute?: ThreadRouteMetadata,
      ) => "sent" as const,
    ),
    persistSession: vi.fn(),
  };
}

describe("validateLeaderThreadOutcomes", () => {
  it("does not enforce outcome markers for non-leader sessions", () => {
    const session = {
      id: "worker",
      messageHistory: [assistantMessage({ id: "a1", text: "Visible worker text", timestamp: 20 })],
      notifications: [],
      leaderThreadOutcomeValidatedHistoryLength: undefined as number | undefined,
    };
    const deps = makeDeps(false);

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: false, reason: "not_leader" });
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
    expect(session.leaderThreadOutcomeValidatedHistoryLength).toBeUndefined();
  });

  it("accepts a same-thread waiting marker newer than the touched leader output", () => {
    const session = {
      id: "leader",
      messageHistory: [assistantMessage({ id: "a1", text: "Waiting on reviewer", timestamp: 20 })],
      notifications: [notification({ category: "waiting", timestamp: 25 })],
      leaderThreadOutcomeValidatedHistoryLength: 0,
    };
    const deps = makeDeps();

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: true, missing: [], injected: false });
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
    expect(session.leaderThreadOutcomeValidatedHistoryLength).toBe(1);
  });

  it("accepts a same-thread needs-input notification as the user-blocking outcome", () => {
    const session = {
      id: "leader",
      messageHistory: [assistantMessage({ id: "a1", text: "Approve this quest?", timestamp: 20 })],
      notifications: [notification({ category: "needs-input", timestamp: 25 })],
      leaderThreadOutcomeValidatedHistoryLength: 0,
    };
    const deps = makeDeps();

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: true, missing: [], injected: false });
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("rejects resolved needs-input notifications as active outcomes", () => {
    const session = {
      id: "leader",
      messageHistory: [assistantMessage({ id: "a1", text: "Approve this quest?", timestamp: 20 })],
      notifications: [notification({ category: "needs-input", timestamp: 25, done: true })],
      leaderThreadOutcomeValidatedHistoryLength: 0,
    };
    const deps = makeDeps();

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: true, missing: ["main"], injected: true });
  });

  it("accepts a fresh inline Thread Waiting marker from server status state", () => {
    const session = {
      id: "leader",
      messageHistory: [assistantMessage({ id: "a1", text: "Waiting on reviewer", timestamp: 20, threadKey: "q-42" })],
      notifications: [],
      state: { leaderThreadStatuses: { "q-42": threadStatus({ kind: "waiting", timestamp: 25, threadKey: "q-42" }) } },
      leaderThreadOutcomeValidatedHistoryLength: 0,
    };
    const deps = makeDeps();

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: true, missing: [], injected: false });
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("accepts a fresh inline Thread Ready marker from server status state", () => {
    const session = {
      id: "leader",
      messageHistory: [assistantMessage({ id: "a1", text: "Review complete", timestamp: 20, threadKey: "q-42" })],
      notifications: [],
      state: { leaderThreadStatuses: { "q-42": threadStatus({ kind: "ready", timestamp: 25, threadKey: "q-42" }) } },
      leaderThreadOutcomeValidatedHistoryLength: 0,
    };
    const deps = makeDeps();

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: true, missing: [], injected: false });
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("rejects stale inline status markers when leader output is newer", () => {
    const session = {
      id: "leader",
      messageHistory: [
        assistantMessage({ id: "a1", text: "Old update", timestamp: 20, threadKey: "q-42" }),
        assistantMessage({ id: "a2", text: "New update without outcome", timestamp: 40, threadKey: "q-42" }),
      ],
      notifications: [],
      state: { leaderThreadStatuses: { "q-42": threadStatus({ kind: "ready", timestamp: 30, threadKey: "q-42" }) } },
      leaderThreadOutcomeValidatedHistoryLength: 1,
    };
    const deps = makeDeps();

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: true, missing: ["q-42"], injected: true });
  });

  it("rejects stale same-thread markers when leader output is newer", () => {
    const session = {
      id: "leader",
      messageHistory: [
        assistantMessage({ id: "a1", text: "Old update", timestamp: 20, threadKey: "q-42" }),
        assistantMessage({ id: "a2", text: "New update without outcome", timestamp: 40, threadKey: "q-42" }),
      ],
      notifications: [notification({ category: "waiting", timestamp: 30, threadKey: "q-42" })],
      leaderThreadOutcomeValidatedHistoryLength: 1,
    };
    const deps = makeDeps();

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: true, missing: ["q-42"], injected: true });
    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "leader",
      expect.stringContaining("Missing outcome marker for: q-42."),
      expect.objectContaining({
        sessionId: THREAD_OUTCOME_REMINDER_SOURCE_ID,
        sessionLabel: THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
      }),
      expect.objectContaining({ threadKey: "q-42" }),
    );
    expect(session.leaderThreadOutcomeValidatedHistoryLength).toBe(2);
  });

  it("does not repeat reminders when unchanged history was already validated", () => {
    const session = {
      id: "leader",
      messageHistory: [assistantMessage({ id: "a1", text: "Update without outcome", timestamp: 20 })],
      notifications: [],
      leaderThreadOutcomeValidatedHistoryLength: 0,
    };
    const deps = makeDeps();

    const firstResult = validateLeaderThreadOutcomes(session, deps);
    const secondResult = validateLeaderThreadOutcomes(session, deps);

    expect(firstResult).toEqual({ checked: true, missing: ["main"], injected: true });
    expect(secondResult).toEqual({ checked: false, reason: "no_new_history" });
    expect(deps.injectUserMessage).toHaveBeenCalledTimes(1);
    expect(deps.persistSession).toHaveBeenCalledTimes(1);
    expect(session.leaderThreadOutcomeValidatedHistoryLength).toBe(1);
  });

  it("accepts a same-turn waiting marker even when a final acknowledgement is newer", () => {
    const session = {
      id: "leader",
      messageHistory: [
        assistantMessage({ id: "a1", text: "Marking q-1255 as waiting", timestamp: 20, threadKey: "q-1255" }),
        assistantMessage({ id: "a2", text: "Waiting marker refreshed", timestamp: 40, threadKey: "q-1255" }),
      ],
      notifications: [notification({ category: "waiting", timestamp: 30, threadKey: "q-1255" })],
      leaderThreadOutcomeValidatedHistoryLength: 0,
    };
    const deps = makeDeps();

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: true, missing: [], injected: false });
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
    expect(session.leaderThreadOutcomeValidatedHistoryLength).toBe(2);
  });

  it("does not self-loop on system-triggered reminder recovery turns", () => {
    const session = {
      id: "leader",
      messageHistory: [
        systemUserMessage({ id: "u-reminder", timestamp: 10, threadKey: "q-1255" }),
        assistantMessage({ id: "a1", text: "Re-marking q-1255 as waiting", timestamp: 20, threadKey: "q-1255" }),
        assistantMessage({ id: "a2", text: "Marked again", timestamp: 40, threadKey: "q-1255" }),
      ],
      notifications: [notification({ category: "waiting", timestamp: 30, threadKey: "q-1255" })],
      leaderThreadOutcomeValidatedHistoryLength: 1,
    };
    const deps = makeDeps(true, "system");

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: false, reason: "system_turn" });
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
    expect(deps.persistSession).toHaveBeenCalledWith(session);
    expect(session.leaderThreadOutcomeValidatedHistoryLength).toBe(3);
  });

  it("does not repeat a reminder after the leader marks the thread waiting", () => {
    const session = {
      id: "leader",
      messageHistory: [
        assistantMessage({ id: "a1", text: "q-1255 is in Code Review", timestamp: 10, threadKey: "q-1255" }),
      ],
      notifications: [] as SessionNotification[],
      leaderThreadOutcomeValidatedHistoryLength: 0,
    };
    const deps = makeDeps();
    deps.injectUserMessage.mockImplementation((sessionId, content, agentSource, threadRoute) => {
      session.messageHistory.push(
        systemUserMessage({
          id: `u-${sessionId}-${session.messageHistory.length}`,
          timestamp: 15,
          threadKey: threadRoute?.threadKey ?? "main",
        }),
      );
      expect(content).toContain("Missing outcome marker for: q-1255.");
      expect(agentSource.sessionId).toBe(THREAD_OUTCOME_REMINDER_SOURCE_ID);
      expect(agentSource.sessionLabel).toBe(THREAD_OUTCOME_REMINDER_SOURCE_LABEL);
      return "sent";
    });

    const firstResult = validateLeaderThreadOutcomes(session, deps);
    session.messageHistory.push(
      assistantMessage({ id: "a2", text: "Re-marking q-1255 as waiting", timestamp: 20, threadKey: "q-1255" }),
      assistantMessage({ id: "a3", text: "Marked again", timestamp: 40, threadKey: "q-1255" }),
    );
    session.notifications.push(notification({ category: "waiting", timestamp: 30, threadKey: "q-1255" }));
    const secondResult = validateLeaderThreadOutcomes(session, deps);

    expect(firstResult).toEqual({ checked: true, missing: ["q-1255"], injected: true });
    expect(secondResult).toEqual({ checked: true, missing: [], injected: false });
    expect(deps.injectUserMessage).toHaveBeenCalledTimes(1);
    expect(session.leaderThreadOutcomeValidatedHistoryLength).toBe(4);
  });

  it("checks freshness independently per touched thread", () => {
    const session = {
      id: "leader",
      messageHistory: [
        assistantMessage({ id: "a-main", text: "Main update", timestamp: 20 }),
        assistantMessage({ id: "a-quest", text: "Quest update", timestamp: 30, threadKey: "q-77" }),
      ],
      notifications: [notification({ category: "needs-input", timestamp: 35, threadKey: "q-77" })],
    };
    const deps = makeDeps();

    const result = validateLeaderThreadOutcomes(session, deps);

    expect(result).toEqual({ checked: true, missing: ["main"], injected: true });
    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "leader",
      expect.stringContaining("Missing outcome marker for: Main."),
      expect.anything(),
      expect.objectContaining({ threadKey: "main" }),
    );
  });
});
