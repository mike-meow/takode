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
    expect(model.observed.activeBoardQuests[0]?.currentPhaseInstructionMatched).toBe(true);
    expect(model.observed.activeBoardQuests[0]?.currentPhaseResultMatched).toBe(false);
    expect(model.observed.activeBoardQuests[0]?.lastRelevantLeaderInstruction?.source.messageIndex).toBe(3);
    expect(model.observed.activeBoardQuests[0]?.latestSupportingResult?.source.messageIndex).toBe(2);
    expect(model.synthesized.activeBoardQuests[0]?.whyHere).toContain("supporting prior-phase worker result");
    expect(model.synthesized.activeBoardQuests[0]?.whyHereSource?.messageIndex).toBe(2);
    expect(model.synthesized.activeBoardQuests[0]?.latestMeaningfulResult).toBeUndefined();
    expect(model.synthesized.activeBoardQuests[0]?.nextLeaderAction).toContain("wait for the worker report");

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered).toContain("Recovery for [#1132](session:1132)");
    expect(rendered).toContain("[q-773](quest:q-773) -- IMPLEMENTING");
    expect(rendered).toContain("why here: supporting prior-phase worker result");
    expect(rendered).toContain("latest result: none since that instruction");
    expect(rendered).toContain("`takode peek 1128`");
  });

  it("does not mislabel a prior alignment turn as the active explore dispatch in the q-773 compaction edge", async () => {
    // Shape based on [#1132 msg 631](session:1132:631) -> [#1132 msg 636](session:1132:636) -> [#1132 msg 655](session:1132:655):
    // the board says EXPLORING, but compaction hits before an actual explore brief is ever sent.
    const leaderHistory: BrowserIncomingMessage[] = [
      {
        type: "assistant",
        timestamp: 631,
        parent_tool_use_id: null,
        message: {
          id: "leader-631",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [
            {
              type: "text",
              text: "The [q-773](quest:q-773) alignment read-in is within scope and I am revising it into EXPLORING now.",
            },
          ],
          stop_reason: null,
          usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
        },
        uuid: "leader-631",
      },
      {
        type: "compact_marker",
        timestamp: 636,
        summary: "[Context compacted]",
        trigger: "auto",
      },
      makeUserMessage("Recover enough context to safely resume orchestration.", 655, {
        sessionId: "system",
        sessionLabel: "System",
      }),
    ];
    const workerHistory: BrowserIncomingMessage[] = [
      makeUserMessage("Return the alignment read-in for [q-773](quest:q-773).", 620, {
        sessionId: "leader-session",
        sessionLabel: "#1132 Leader",
      }),
      makeAssistant("The startup-path unknowns are real and worth exploring.", 621),
      makeResult("Within scope for exploration once the leader sends the bounded explore brief.", 10),
    ];

    const model = await buildLeaderContextResume({
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
            status: "EXPLORING",
            journey: {
              phaseIds: ["alignment", "explore", "implement", "mental-simulation", "code-review", "port"],
              currentPhaseId: "explore",
              nextLeaderAction:
                "read the explore leader brief, then wait for the findings summary and decide whether to revise the Journey, advance, or escalate",
            },
            createdAt: 600,
            updatedAt: 631,
          },
        ],
      },
      rowSessionStatuses: {
        "q-773": {
          worker: {
            sessionId: "worker-session",
            sessionNum: 1128,
            name: "q-773 explore worker",
            status: "idle",
          },
          reviewer: null,
        },
      },
      participants: new Map([
        [
          "worker-session",
          makeParticipant({
            sessionId: "worker-session",
            sessionNum: 1128,
            name: "q-773 explore worker",
            role: "worker",
            status: "idle",
            claimedQuestId: "q-773",
            claimedQuestStatus: "in_progress",
            messageHistory: workerHistory,
          }),
        ],
      ]),
      loadQuest: async () => ({
        id: "q-773-v2",
        questId: "q-773",
        version: 2,
        title: "Recover leader context after compaction",
        description: "Synthetic replay fixture for the compaction edge.",
        status: "in_progress",
        sessionId: "worker-session",
        claimedAt: 600,
        createdAt: 590,
      }),
    });

    const observedQuest = model.observed.activeBoardQuests[0]!;
    const synthesizedQuest = model.synthesized.activeBoardQuests[0]!;

    expect(observedQuest.currentPhaseInstructionMatched).toBe(false);
    expect(observedQuest.currentPhaseResultMatched).toBe(false);
    expect(observedQuest.lastRelevantLeaderInstruction).toBeUndefined();
    expect(observedQuest.latestFallbackLeaderInstruction?.summary).toContain("ALIGNMENT");
    expect(observedQuest.latestSupportingResult?.source.messageIndex).toBe(2);

    expect(synthesizedQuest.whyHere).toContain("no matched `EXPLORE` dispatch");
    expect(synthesizedQuest.latestMeaningfulResult).toContain("supporting prior-phase worker result");
    expect(synthesizedQuest.nextLeaderAction).toContain("inspect [#1128](session:1128)");
    expect(synthesizedQuest.nextLeaderAction).toContain("resend the `EXPLORE` instruction");

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered).toContain("no matched current-phase dispatch");
    expect(rendered).toContain("supporting prior-phase worker result");
    expect(rendered).toContain("resend the `EXPLORE` instruction");
    expect(rendered).not.toContain("explicit `EXPLORE` dispatch");
    expect(rendered).not.toContain("read the worker report and choose the next phase");
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
