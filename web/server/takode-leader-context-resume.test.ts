import { describe, expect, it } from "vitest";
import type { BoardRowSessionStatus, BrowserIncomingMessage } from "./session-types.js";
import {
  buildLeaderContextResume,
  renderLeaderContextResumeText,
  type LeaderContextResumeInput,
  type LeaderContextResumeParticipant,
} from "./takode-leader-context-resume.js";

function makeUserMessage(
  content: string,
  timestamp: number,
  agentSource?: { sessionId: string; sessionLabel?: string },
): Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return {
    type: "user_message",
    content,
    timestamp,
    ...(agentSource ? { agentSource } : {}),
  };
}

function makeAssistant(text: string, timestamp: number): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    timestamp,
    parent_tool_use_id: null,
    message: {
      id: `assistant-${timestamp}`,
      type: "message",
      role: "assistant",
      model: "gpt-5.4",
      content: [{ type: "text", text }],
      stop_reason: null,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
    uuid: `assistant-${timestamp}`,
  };
}

function makeResult(result: string, durationMs: number): Extract<BrowserIncomingMessage, { type: "result" }> {
  return {
    type: "result",
    data: {
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      duration_ms: durationMs,
      duration_api_ms: durationMs,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: "end_turn",
      uuid: `result-${durationMs}`,
      session_id: "worker-session",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

function makeParticipant(
  overrides: Partial<LeaderContextResumeParticipant> &
    Pick<LeaderContextResumeParticipant, "sessionId" | "sessionNum" | "role">,
): LeaderContextResumeParticipant {
  return {
    name: null,
    status: "idle",
    claimedQuestId: null,
    claimedQuestStatus: null,
    messageHistory: [],
    ...overrides,
  };
}

describe("takode leader-context-resume", () => {
  it("builds observed and synthesized recovery output for the synthetic #1132 compaction replay", async () => {
    // This models the quest's primary replay example: a leader compacts after an
    // explore result, sends IMPLEMENT, and later needs a compact recovery view.
    const leaderHistory: BrowserIncomingMessage[] = [
      makeUserMessage("Check the latest board state before recovery.", 1_000),
      {
        type: "compact_marker",
        timestamp: 1_050,
        summary: "Compacted after the q-773 phase-boundary handoff.",
        trigger: "auto",
      },
    ];
    const workerHistory: BrowserIncomingMessage[] = [
      makeUserMessage("Perform the approved EXPLORE phase for [q-773](quest:q-773).", 2_000, {
        sessionId: "leader-session",
        sessionLabel: "#1132 Leader",
      }),
      makeAssistant("Exploration found the loader mismatch is narrow and contained.", 2_010),
      makeResult("Within scope: proceed to implement the leader-context-resume reconstruction.", 25),
      makeUserMessage("Perform the approved IMPLEMENT phase for [q-773](quest:q-773).", 3_000, {
        sessionId: "leader-session",
        sessionLabel: "#1132 Leader",
      }),
    ];

    const rowSessionStatuses: Record<string, BoardRowSessionStatus> = {
      "q-773": {
        worker: {
          sessionId: "worker-session",
          sessionNum: 1128,
          name: "q-773 implement worker",
          status: "idle",
        },
        reviewer: null,
      },
    };

    const input: LeaderContextResumeInput = {
      leader: {
        sessionId: "leader-session",
        sessionNum: 1132,
        name: "Leader",
        isOrchestrator: true,
        messageHistory: leaderHistory,
        notifications: [],
        board: [
          {
            questId: "q-773",
            title: "Recover leader context after compaction",
            worker: "worker-session",
            status: "IMPLEMENTING",
            journey: {
              phaseIds: ["alignment", "explore", "implement", "mental-simulation", "code-review", "port"],
              currentPhaseId: "implement",
              nextLeaderAction: "wait for the worker report and choose the next phase",
            },
            createdAt: 1_500,
            updatedAt: 3_000,
          },
        ],
      },
      rowSessionStatuses,
      participants: new Map([
        [
          "worker-session",
          makeParticipant({
            sessionId: "worker-session",
            sessionNum: 1128,
            name: "q-773 implement worker",
            role: "worker",
            status: "idle",
            claimedQuestId: "q-773",
            claimedQuestStatus: "in_progress",
            messageHistory: workerHistory,
          }),
        ],
      ]),
      loadQuest: async () => ({
        id: "q-773-v1",
        questId: "q-773",
        version: 1,
        title: "Recover leader context after compaction",
        description: "Synthetic replay fixture.",
        status: "in_progress",
        sessionId: "worker-session",
        claimedAt: 1_500,
        createdAt: 1_400,
      }),
    };

    const model = await buildLeaderContextResume(input);

    expect(model.observed.activeBoardQuests).toHaveLength(1);
    expect(model.observed.activeBoardQuests[0]?.currentBoardPhase).toBe("IMPLEMENTING");
    expect(model.observed.activeBoardQuests[0]?.lastRelevantLeaderInstruction?.source.messageIndex).toBe(3);
    expect(model.observed.activeBoardQuests[0]?.latestSupportingResult?.source.messageIndex).toBe(2);
    expect(model.synthesized.activeBoardQuests[0]?.whyHere).toContain("worker result");
    expect(model.synthesized.activeBoardQuests[0]?.whyHereSource?.messageIndex).toBe(2);
    expect(model.synthesized.activeBoardQuests[0]?.latestMeaningfulResult).toBeUndefined();
    expect(model.synthesized.activeBoardQuests[0]?.nextLeaderAction).toContain("wait for the worker report");

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered).toContain("Recovery for [#1132](session:1132)");
    expect(rendered).toContain("[q-773](quest:q-773) -- IMPLEMENTING");
    expect(rendered).toContain("why here: worker result");
    expect(rendered).toContain("latest result: none since that instruction");
    expect(rendered).toContain("`takode peek 1128`");
  });

  it("keeps observed facts and synthesized interpretation separated in json output", async () => {
    const model = await buildLeaderContextResume({
      leader: {
        sessionId: "leader-session",
        sessionNum: 41,
        name: "Leader",
        isOrchestrator: true,
        messageHistory: [
          {
            type: "assistant",
            timestamp: 2_000,
            parent_tool_use_id: null,
            message: {
              id: "assistant-notif",
              type: "message",
              role: "assistant",
              model: "gpt-5.4",
              content: [{ type: "text", text: "Need user approval before proceeding." }],
              stop_reason: null,
              usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
            },
            uuid: "assistant-notif",
          },
        ],
        notifications: [
          {
            id: "n-3",
            category: "needs-input",
            summary: "Choose the rollout path.",
            timestamp: 2_000,
            messageId: "assistant-notif",
            done: false,
          },
        ],
        board: [],
      },
      rowSessionStatuses: {},
      participants: new Map(),
      loadQuest: async () => null,
    });

    expect(model.observed.unresolvedUserDecisions[0]?.notificationId).toBe("n-3");
    expect(model.observed.unresolvedUserDecisions[0]?.source?.messageIndex).toBe(0);
    expect(model.synthesized.suggestedCommands).toContain("takode notify list");
    expect(Array.isArray(model.observed.activeBoardQuests)).toBe(true);
    expect(Array.isArray(model.synthesized.activeBoardQuests)).toBe(true);
  });

  it("rejects non-leader target sessions", async () => {
    await expect(
      buildLeaderContextResume({
        leader: {
          sessionId: "worker-session",
          sessionNum: 8,
          name: "Worker",
          isOrchestrator: false,
          messageHistory: [],
          notifications: [],
          board: [],
        },
        rowSessionStatuses: {},
        participants: new Map(),
        loadQuest: async () => null,
      }),
    ).rejects.toThrow("Session is not recognized as a leader/orchestrator session");
  });
});
