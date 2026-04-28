import { describe, expect, it } from "vitest";
import type { QuestmasterTask } from "./quest-types.js";
import type { BoardRowSessionStatus, BrowserIncomingMessage, SessionNotification } from "./session-types.js";
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

function makeReviewNotification(
  id: string,
  questId: string,
  title: string,
  timestamp: number,
  messageId: string | null = `review-${id}`,
): SessionNotification {
  return {
    id,
    category: "review",
    summary: `${questId} ready for review: ${title}`,
    timestamp,
    messageId,
    done: false,
  };
}

function makeVerificationQuest(
  questId: string,
  title: string,
  overrides: Partial<QuestmasterTask> = {},
): QuestmasterTask {
  return {
    id: `${questId}-v1`,
    questId,
    version: 1,
    title,
    description: `${title} description.`,
    status: "needs_verification",
    sessionId: `session-${questId}`,
    claimedAt: 1_000,
    createdAt: 900,
    verificationItems: [
      { text: "Verify primary behavior.", checked: false },
      { text: "Verify regression coverage.", checked: false },
      { text: "Verify handoff notes.", checked: false },
    ],
    verificationInboxUnread: true,
    commitShas: ["abc123", "def456"],
    feedback: [{ author: "agent", text: `Summary: ${title} landed and is ready for verification.`, ts: 1_500 }],
    ...overrides,
  } as QuestmasterTask;
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
    expect(model.synthesized.activeBoardQuests[0]?.whyHere).toContain("supporting earlier `EXPLORE` worker result");
    expect(model.synthesized.activeBoardQuests[0]?.whyHereSource?.messageIndex).toBe(2);
    expect(model.synthesized.activeBoardQuests[0]?.latestMeaningfulResult).toBeUndefined();
    expect(model.synthesized.activeBoardQuests[0]?.nextLeaderAction).toContain("wait for the worker report");

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered).toContain("Recovery for [#1132](session:1132)");
    expect(rendered).toContain("[q-773](quest:q-773) -- IMPLEMENTING");
    expect(rendered).toContain("why here: supporting earlier `EXPLORE` worker result");
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
    expect(synthesizedQuest.latestMeaningfulResult).toContain("supporting earlier `ALIGNMENT` worker result");
    expect(synthesizedQuest.nextLeaderAction).toContain("inspect [#1128](session:1128)");
    expect(synthesizedQuest.nextLeaderAction).toContain("resend the `EXPLORE` instruction");

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered).toContain("no matched current-phase dispatch");
    expect(rendered).toContain("supporting earlier `ALIGNMENT` worker result");
    expect(rendered).toContain("resend the `EXPLORE` instruction");
    expect(rendered).not.toContain("explicit `EXPLORE` dispatch");
    expect(rendered).not.toContain("read the worker report and choose the next phase");
  });

  it("fails closed for reviewer-owned phases when only ambiguous worker wording and non-literal reviewer wording exist", async () => {
    // This locks down the reviewer transition from [#1146 msg 62](session:1146:62):
    // the board is CODE_REVIEWING, the worker implement prompt mentions "review"
    // generically, and the reviewer brief is quest-relevant but does not literally
    // say "code review". The resume command must not fabricate an explicit review
    // dispatch/result from either turn.
    const workerHistory: BrowserIncomingMessage[] = [
      makeUserMessage(
        "Perform the approved IMPLEMENT phase for [q-918](quest:q-918). While you implement it, review the current diff shape and keep the output contract tight.",
        2_000,
        {
          sessionId: "leader-session",
          sessionLabel: "#1132 Leader",
        },
      ),
      makeAssistant("The implementation is in place and the compact recovery output is stable.", 2_010),
      makeResult("Implemented the leader recovery command and tightened the text rendering.", 20),
    ];
    const reviewerHistory: BrowserIncomingMessage[] = [
      makeUserMessage(
        "Pressure-test edge cases for [q-918](quest:q-918) and tell me whether the recovery view stays trustworthy after the reviewer handoff.",
        3_000,
        {
          sessionId: "leader-session",
          sessionLabel: "#1132 Leader",
        },
      ),
    ];

    const model = await buildLeaderContextResume({
      leader: {
        sessionId: "leader-session",
        sessionNum: 1132,
        name: "Leader",
        isOrchestrator: true,
        messageHistory: [],
        notifications: [],
        board: [
          {
            questId: "q-918",
            title: "Design takode leader-context-resume for leader post-compaction recovery",
            worker: "worker-session",
            status: "CODE_REVIEWING",
            journey: {
              phaseIds: ["alignment", "explore", "implement", "mental-simulation", "code-review", "port"],
              currentPhaseId: "code-review",
              nextLeaderAction: "read the reviewer findings and decide whether to request rework or advance",
            },
            createdAt: 1_500,
            updatedAt: 3_000,
          },
        ],
      },
      rowSessionStatuses: {
        "q-918": {
          worker: {
            sessionId: "worker-session",
            sessionNum: 1143,
            name: "q-918 implement worker",
            status: "idle",
          },
          reviewer: {
            sessionId: "reviewer-session",
            sessionNum: 1146,
            name: "q-918 reviewer",
            status: "idle",
          },
        },
      },
      participants: new Map([
        [
          "worker-session",
          makeParticipant({
            sessionId: "worker-session",
            sessionNum: 1143,
            name: "q-918 implement worker",
            role: "worker",
            status: "idle",
            claimedQuestId: "q-918",
            claimedQuestStatus: "in_progress",
            messageHistory: workerHistory,
          }),
        ],
        [
          "reviewer-session",
          makeParticipant({
            sessionId: "reviewer-session",
            sessionNum: 1146,
            name: "q-918 reviewer",
            role: "reviewer",
            status: "idle",
            claimedQuestId: "q-918",
            claimedQuestStatus: "in_progress",
            messageHistory: reviewerHistory,
          }),
        ],
      ]),
      loadQuest: async () => ({
        id: "q-918-v1",
        questId: "q-918",
        version: 1,
        title: "Design takode leader-context-resume for leader post-compaction recovery",
        description: "Reviewer transition regression fixture.",
        status: "in_progress",
        sessionId: "worker-session",
        claimedAt: 1_500,
        createdAt: 1_400,
      }),
    });

    const observedQuest = model.observed.activeBoardQuests[0]!;
    const synthesizedQuest = model.synthesized.activeBoardQuests[0]!;

    expect(observedQuest.currentPhaseInstructionMatched).toBe(false);
    expect(observedQuest.currentPhaseResultMatched).toBe(false);
    expect(observedQuest.lastRelevantLeaderInstruction).toBeUndefined();
    expect(observedQuest.latestCurrentPhaseResult).toBeUndefined();
    expect(observedQuest.latestFallbackLeaderInstruction).toMatchObject({
      participantRole: "reviewer",
      participantSessionId: "reviewer-session",
      phaseId: undefined,
      summary: "earlier quest-relevant leader turn",
    });
    expect(observedQuest.latestSupportingResult).toMatchObject({
      participantRole: "worker",
      participantSessionId: "worker-session",
      phaseId: "implement",
      summary: "Implemented the leader recovery command and tightened the text rendering.",
    });

    expect(synthesizedQuest.whyHere).toContain("no matched `CODE_REVIEW` dispatch");
    expect(synthesizedQuest.whyHere).toContain("supporting earlier `IMPLEMENT` worker result");
    expect(synthesizedQuest.latestMeaningfulResult).toContain("supporting earlier `IMPLEMENT` worker result");
    expect(synthesizedQuest.nextLeaderAction).toContain("inspect [#1146](session:1146)");
    expect(synthesizedQuest.nextLeaderAction).toContain("resend the `CODE_REVIEW` instruction");

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered).toContain("[q-918](quest:q-918) -- CODE_REVIEWING");
    expect(rendered).toContain("no matched current-phase dispatch");
    expect(rendered).toContain("earlier quest-relevant leader turn");
    expect(rendered).toContain("supporting earlier `IMPLEMENT` worker result");
    expect(rendered).toContain("inspect [#1146](session:1146)");
    expect(rendered).toContain("resend the `CODE_REVIEW` instruction");
    expect(rendered).not.toContain("explicit `CODE_REVIEW` dispatch");
    expect(rendered).not.toContain("read the reviewer result and either send rework or advance");
  });

  it("labels supporting earlier reviewer context by the earliest mentioned phase instead of pattern order", async () => {
    const workerHistory: BrowserIncomingMessage[] = [
      makeUserMessage("Perform the approved IMPLEMENT phase for [q-918](quest:q-918).", 4_000, {
        sessionId: "leader-session",
        sessionLabel: "#1132 Leader",
      }),
    ];
    const reviewerHistory: BrowserIncomingMessage[] = [
      makeUserMessage(
        "Perform the approved CODE-REVIEW phase for [q-918](quest:q-918). Review the IMPLEMENT rework and pressure-test edge cases before you report back.",
        3_000,
        {
          sessionId: "leader-session",
          sessionLabel: "#1132 Leader",
        },
      ),
      makeAssistant(
        "The phase matching looks narrower, but the supporting context wording still needs one more pass.",
        3_010,
      ),
      makeResult("The review found supporting-context labeling drift around multi-phase prompts.", 25),
    ];

    const model = await buildLeaderContextResume({
      leader: {
        sessionId: "leader-session",
        sessionNum: 1132,
        name: "Leader",
        isOrchestrator: true,
        messageHistory: [],
        notifications: [],
        board: [
          {
            questId: "q-918",
            title: "Design takode leader-context-resume for leader post-compaction recovery",
            worker: "worker-session",
            status: "IMPLEMENTING",
            journey: {
              phaseIds: ["implement", "code-review", "port"],
              currentPhaseId: "implement",
              nextLeaderAction: "wait for the worker report and choose the next phase",
            },
            createdAt: 1_500,
            updatedAt: 4_000,
          },
        ],
      },
      rowSessionStatuses: {
        "q-918": {
          worker: {
            sessionId: "worker-session",
            sessionNum: 1143,
            name: "q-918 implement worker",
            status: "idle",
          },
          reviewer: {
            sessionId: "reviewer-session",
            sessionNum: 1146,
            name: "q-918 reviewer",
            status: "idle",
          },
        },
      },
      participants: new Map([
        [
          "worker-session",
          makeParticipant({
            sessionId: "worker-session",
            sessionNum: 1143,
            name: "q-918 implement worker",
            role: "worker",
            status: "idle",
            claimedQuestId: "q-918",
            claimedQuestStatus: "in_progress",
            messageHistory: workerHistory,
          }),
        ],
        [
          "reviewer-session",
          makeParticipant({
            sessionId: "reviewer-session",
            sessionNum: 1146,
            name: "q-918 reviewer",
            role: "reviewer",
            status: "idle",
            claimedQuestId: "q-918",
            claimedQuestStatus: "in_progress",
            messageHistory: reviewerHistory,
          }),
        ],
      ]),
      loadQuest: async () => ({
        id: "q-918-v2",
        questId: "q-918",
        version: 2,
        title: "Design takode leader-context-resume for leader post-compaction recovery",
        description: "Multi-phase reviewer wording regression fixture.",
        status: "in_progress",
        sessionId: "worker-session",
        claimedAt: 1_500,
        createdAt: 1_400,
      }),
    });

    const observedQuest = model.observed.activeBoardQuests[0]!;
    const synthesizedQuest = model.synthesized.activeBoardQuests[0]!;

    expect(observedQuest.currentPhaseInstructionMatched).toBe(true);
    expect(observedQuest.latestSupportingResult).toMatchObject({
      participantRole: "reviewer",
      participantSessionId: "reviewer-session",
      phaseId: "code-review",
      summary: "The review found supporting-context labeling drift around multi-phase prompts.",
    });
    expect(synthesizedQuest.whyHere).toContain(
      "supporting earlier reviewer result from a `CODE_REVIEW` turn that also mentions `IMPLEMENT`",
    );
    expect(synthesizedQuest.whyHere).not.toContain("supporting earlier `IMPLEMENT` reviewer result");

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered).toContain(
      "supporting earlier reviewer result from a `CODE_REVIEW` turn that also mentions `IMPLEMENT`",
    );
    expect(rendered).not.toContain("supporting earlier `IMPLEMENT` reviewer result");
  });

  it("uses the substantive assistant finding as the supporting-result source when the result wrapper is empty", async () => {
    const workerHistory: BrowserIncomingMessage[] = [
      makeUserMessage("Perform the approved IMPLEMENT phase for [q-918](quest:q-918).", 4_000, {
        sessionId: "leader-session",
        sessionLabel: "#1132 Leader",
      }),
    ];
    const reviewerHistory: BrowserIncomingMessage[] = [
      makeUserMessage("Perform the approved CODE-REVIEW phase for [q-918](quest:q-918).", 3_000, {
        sessionId: "leader-session",
        sessionLabel: "#1132 Leader",
      }),
      makeAssistant(
        "**Findings**\n\n1. The substantive reviewer finding is here, not in the empty result shell.",
        3_010,
      ),
      makeResult("", 25),
    ];

    const model = await buildLeaderContextResume({
      leader: {
        sessionId: "leader-session",
        sessionNum: 1132,
        name: "Leader",
        isOrchestrator: true,
        messageHistory: [],
        notifications: [],
        board: [
          {
            questId: "q-918",
            title: "Design takode leader-context-resume for leader post-compaction recovery",
            worker: "worker-session",
            status: "IMPLEMENTING",
            journey: {
              phaseIds: ["implement", "code-review", "port"],
              currentPhaseId: "implement",
              nextLeaderAction: "wait for the worker report and choose the next phase",
            },
            createdAt: 1_500,
            updatedAt: 4_000,
          },
        ],
      },
      rowSessionStatuses: {
        "q-918": {
          worker: {
            sessionId: "worker-session",
            sessionNum: 1143,
            name: "q-918 implement worker",
            status: "idle",
          },
          reviewer: {
            sessionId: "reviewer-session",
            sessionNum: 1146,
            name: "q-918 reviewer",
            status: "idle",
          },
        },
      },
      participants: new Map([
        [
          "worker-session",
          makeParticipant({
            sessionId: "worker-session",
            sessionNum: 1143,
            name: "q-918 implement worker",
            role: "worker",
            status: "idle",
            claimedQuestId: "q-918",
            claimedQuestStatus: "in_progress",
            messageHistory: workerHistory,
          }),
        ],
        [
          "reviewer-session",
          makeParticipant({
            sessionId: "reviewer-session",
            sessionNum: 1146,
            name: "q-918 reviewer",
            role: "reviewer",
            status: "idle",
            claimedQuestId: "q-918",
            claimedQuestStatus: "in_progress",
            messageHistory: reviewerHistory,
          }),
        ],
      ]),
      loadQuest: async () => ({
        id: "q-918-v3",
        questId: "q-918",
        version: 3,
        title: "Design takode leader-context-resume for leader post-compaction recovery",
        description: "Assistant-derived result provenance regression fixture.",
        status: "in_progress",
        sessionId: "worker-session",
        claimedAt: 1_500,
        createdAt: 1_400,
      }),
    });

    const observedQuest = model.observed.activeBoardQuests[0]!;
    const synthesizedQuest = model.synthesized.activeBoardQuests[0]!;

    expect(observedQuest.latestSupportingResult?.source.messageIndex).toBe(1);
    expect(observedQuest.latestSupportingResult?.summary).toContain("The substantive reviewer finding is here");
    expect(synthesizedQuest.whyHereSource?.messageIndex).toBe(1);
    expect(synthesizedQuest.whyHere).toContain("supporting earlier `CODE_REVIEW` reviewer result");
    expect(model.synthesized.suggestedCommands).toContain("takode read 1146 1");

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered).toContain("from [#1146 msg 1](session:1146:1)");
    expect(rendered).not.toContain("from [#1146 msg 2](session:1146:2)");
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

  it("surfaces verification-ready quests from review notifications before active board state", async () => {
    // This covers the human feedback on q-918: after restart/compaction, the
    // leader must not see "Active quests: 0" before learning that review
    // notifications map to quests waiting in the verification inbox.
    const leaderHistory = [
      makeAssistant("q-720 is ready for review.", 10_000),
      makeAssistant("q-924 is ready for review.", 11_000),
      makeAssistant("q-720 emitted an older duplicate review notification.", 9_000),
    ];
    const notifications = [
      makeReviewNotification(
        "n-18",
        "q-720",
        "Add lightweight Journey scheduling data and phase notes",
        10_000,
        "assistant-10000",
      ),
      makeReviewNotification(
        "n-20",
        "q-924",
        "Render proposed and active Quest Journey UI from board data",
        11_000,
        "assistant-11000",
      ),
      makeReviewNotification(
        "n-17",
        "q-720",
        "Add lightweight Journey scheduling data and phase notes",
        9_000,
        "assistant-9000",
      ),
    ];
    const quests = new Map<string, QuestmasterTask>([
      [
        "q-720",
        makeVerificationQuest("q-720", "Add lightweight Journey scheduling data and phase notes", {
          commitShas: ["3db7132b", "31b14d90", "9ff233f9", "edcb72e0", "56ca7bdb"],
        }),
      ],
      [
        "q-924",
        makeVerificationQuest("q-924", "Render proposed and active Quest Journey UI from board data", {
          commitShas: ["22c891c3", "4fa5ec9b"],
        }),
      ],
    ]);

    const model = await buildLeaderContextResume({
      leader: {
        sessionId: "leader-session",
        sessionNum: 1132,
        name: "Leader",
        isOrchestrator: true,
        messageHistory: leaderHistory,
        notifications,
        board: [],
      },
      rowSessionStatuses: {},
      participants: new Map(),
      loadQuest: async (questId) => quests.get(questId) ?? null,
    });

    expect(model.observed.activeBoardQuests).toHaveLength(0);
    expect(model.observed.reviewNotificationQuests.map((quest) => quest.questId)).toEqual(["q-924", "q-720"]);
    expect(model.observed.reviewNotificationQuests[1]).toMatchObject({
      questId: "q-720",
      questStatus: "needs_verification",
      verificationInboxUnread: true,
      verificationCheckedCount: 0,
      verificationTotalCount: 3,
      commitCount: 5,
      notificationCount: 2,
    });
    expect(model.observed.reviewNotificationQuests[1]?.latestNotification.source?.messageIndex).toBe(0);
    expect(model.synthesized.reviewNotificationQuests[0]).toMatchObject({
      questId: "q-924",
      statusSummary: "verification; unread inbox; verification 0/3; commits 2",
      nextLeaderAction: "human verification inbox review",
      warnings: [],
    });

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered.indexOf("Review notifications / verification-ready quests")).toBeLessThan(
      rendered.indexOf("Active quests: 0"),
    );
    expect(rendered).toContain("[q-924](quest:q-924) -- Render proposed and active Quest Journey UI from board data");
    expect(rendered).toContain("- status: verification; unread inbox; verification 0/3; commits 2");
    expect(rendered).toContain("from [#1132 msg 1](session:1132:1)");
    expect(rendered).toContain(
      "- latest summary: #0 Summary: Render proposed and active Quest Journey UI from board data landed",
    );
    expect(rendered).toContain("- next leader action: human verification inbox review");
    expect(rendered).toContain("Active quests: 0");
  });

  it("extracts every quest from aggregate review notifications", async () => {
    // Board completion can emit one aggregate notification for multiple quests.
    // The recovery view must surface every referenced quest, not just the first
    // q-N match, or later quests disappear before the active-board summary.
    const notification: SessionNotification = {
      id: "n-aggregate",
      category: "review",
      summary: "2 quests ready for review: q-1, q-2",
      timestamp: 12_000,
      messageId: "assistant-12000",
      done: false,
    };
    const quests = new Map<string, QuestmasterTask>([
      ["q-1", makeVerificationQuest("q-1", "First aggregate quest")],
      ["q-2", makeVerificationQuest("q-2", "Second aggregate quest")],
    ]);

    const model = await buildLeaderContextResume({
      leader: {
        sessionId: "leader-session",
        sessionNum: 1132,
        name: "Leader",
        isOrchestrator: true,
        messageHistory: [makeAssistant("2 quests ready for review: q-1, q-2", 12_000)],
        notifications: [notification],
        board: [],
      },
      rowSessionStatuses: {},
      participants: new Map(),
      loadQuest: async (questId) => quests.get(questId) ?? null,
    });

    expect(model.observed.reviewNotificationQuests.map((quest) => quest.questId)).toEqual(["q-1", "q-2"]);
    expect(model.observed.reviewNotificationQuests[0]).toMatchObject({
      questId: "q-1",
      latestNotification: { notificationId: "n-aggregate" },
      notificationIds: ["n-aggregate"],
    });
    expect(model.observed.reviewNotificationQuests[1]).toMatchObject({
      questId: "q-2",
      latestNotification: { notificationId: "n-aggregate" },
      notificationIds: ["n-aggregate"],
    });

    const rendered = renderLeaderContextResumeText(model);
    expect(rendered).toContain("Review notifications / verification-ready quests: 2 quests from 1 notification");
    expect(rendered).toContain("[q-1](quest:q-1) -- First aggregate quest");
    expect(rendered).toContain("[q-2](quest:q-2) -- Second aggregate quest");
    expect(rendered).not.toContain("Other unresolved same-session notifications");
    expect(rendered.indexOf("[q-2](quest:q-2)")).toBeLessThan(rendered.indexOf("Active quests: 0"));
  });

  it("keeps aggregate review notifications in Other unresolved when a referenced quest is not represented", () => {
    const rendered = renderLeaderContextResumeText({
      leader: { sessionId: "leader-session", sessionNum: 1132, name: "Leader" },
      observed: {
        unresolvedUserDecisions: [],
        unresolvedNotifications: [
          {
            notificationId: "n-aggregate",
            category: "review",
            summary: "2 quests ready for review: q-1, q-2",
            timestamp: 12_000,
          },
        ],
        reviewNotificationQuests: [
          {
            questId: "q-1",
            title: "First aggregate quest",
            questStatus: "needs_verification",
            verificationInboxUnread: true,
            verificationCheckedCount: 0,
            verificationTotalCount: 1,
            commitCount: 1,
            latestNotification: {
              notificationId: "n-aggregate",
              category: "review",
              summary: "2 quests ready for review: q-1, q-2",
              timestamp: 12_000,
            },
            notificationIds: ["n-aggregate"],
            notificationCount: 1,
            activeBoardQuest: false,
          },
        ],
        activeBoardQuests: [],
        warnings: [],
      },
      synthesized: {
        reviewNotificationQuests: [
          {
            questId: "q-1",
            statusSummary: "verification; unread inbox; verification 0/1; commits 1",
            nextLeaderAction: "human verification inbox review",
            warnings: [],
          },
        ],
        activeBoardQuests: [],
        warnings: [],
        suggestedCommands: [],
      },
    });

    expect(rendered).toContain("Other unresolved same-session notifications: 1");
    expect(rendered).toContain("2 quests ready for review: q-1, q-2");
  });

  it("bounds large review-notification output while keeping newest verification-ready quests visible", async () => {
    // This prevents 50+ stale review notifications from burying the currently
    // actionable verification inbox work in post-compaction recovery output.
    const notifications: SessionNotification[] = [
      makeReviewNotification(
        "n-200",
        "q-924",
        "Render proposed and active Quest Journey UI from board data",
        20_000,
        null,
      ),
      makeReviewNotification("n-199", "q-720", "Add lightweight Journey scheduling data and phase notes", 19_000, null),
    ];
    const quests = new Map<string, QuestmasterTask>([
      ["q-924", makeVerificationQuest("q-924", "Render proposed and active Quest Journey UI from board data")],
      ["q-720", makeVerificationQuest("q-720", "Add lightweight Journey scheduling data and phase notes")],
    ]);
    for (let index = 0; index < 55; index += 1) {
      const questId = `q-${800 + index}`;
      notifications.push(
        makeReviewNotification(`n-${index}`, questId, `Older reviewed quest ${index}`, 1_000 + index, null),
      );
      quests.set(
        questId,
        makeVerificationQuest(questId, `Older reviewed quest ${index}`, {
          status: "done",
          verificationInboxUnread: undefined,
          completedAt: 2_000 + index,
          notes: "Already completed.",
        }),
      );
    }

    const model = await buildLeaderContextResume({
      leader: {
        sessionId: "leader-session",
        sessionNum: 1132,
        name: "Leader",
        isOrchestrator: true,
        messageHistory: [],
        notifications,
        board: [],
      },
      rowSessionStatuses: {},
      participants: new Map(),
      loadQuest: async (questId) => quests.get(questId) ?? null,
    });

    const rendered = renderLeaderContextResumeText(model);
    expect(model.observed.reviewNotificationQuests).toHaveLength(57);
    expect(rendered).toContain("Review notifications / verification-ready quests: 57 quests from 57 notifications");
    expect(rendered).toContain("[q-924](quest:q-924) -- Render proposed and active Quest Journey UI from board data");
    expect(rendered).toContain("[q-720](quest:q-720) -- Add lightweight Journey scheduling data and phase notes");
    expect(rendered).toContain("omitted 49 older/lower-priority review quests");
    expect(rendered).not.toContain("[q-800](quest:q-800)");
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
