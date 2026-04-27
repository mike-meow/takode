import type {
  BoardRow,
  BoardRowSessionStatus,
  BrowserIncomingMessage,
  CLIResultMessage,
  SessionNotification,
} from "./session-types.js";
import type { QuestmasterTask } from "./quest-types.js";
import { findTurnBoundaries } from "./takode-messages.js";
import {
  QUEST_JOURNEY_HINTS,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  type QuestJourneyPhase,
} from "../shared/quest-journey.js";

type ParticipantRole = "worker" | "reviewer";
type ParticipantStatus = "running" | "idle" | "disconnected" | "archived" | "missing";

export interface LeaderContextResumeSessionRef {
  sessionId: string;
  sessionNum: number | null;
  name?: string | null;
}

export interface LeaderContextResumeMessageSource extends LeaderContextResumeSessionRef {
  messageIndex: number;
  timestamp: number;
}

export interface LeaderContextResumeParticipant extends LeaderContextResumeSessionRef {
  role: ParticipantRole;
  status: ParticipantStatus;
  claimedQuestId?: string | null;
  claimedQuestStatus?: string | null;
  messageHistory: BrowserIncomingMessage[];
}

export interface LeaderContextResumeInput {
  leader: LeaderContextResumeSessionRef & {
    isOrchestrator: boolean;
    messageHistory: BrowserIncomingMessage[];
    notifications: SessionNotification[];
    board: BoardRow[];
  };
  rowSessionStatuses: Record<string, BoardRowSessionStatus>;
  participants: Map<string, LeaderContextResumeParticipant>;
  loadQuest: (questId: string) => Promise<QuestmasterTask | null>;
}

export interface LeaderContextResumeNotificationObservation {
  notificationId: string;
  category: "needs-input" | "review";
  summary: string;
  source?: LeaderContextResumeMessageSource;
}

export interface LeaderContextResumeParticipantObservation {
  sessionId: string;
  sessionNum: number | null;
  name?: string | null;
  role: ParticipantRole;
  status: ParticipantStatus;
}

export interface LeaderContextResumeInstructionObservation {
  participantRole: ParticipantRole;
  participantSessionId: string;
  participantSessionNum: number | null;
  phaseId?: string;
  summary: string;
  source: LeaderContextResumeMessageSource;
}

export interface LeaderContextResumeResultObservation {
  participantRole: ParticipantRole;
  participantSessionId: string;
  participantSessionNum: number | null;
  phaseId?: string;
  summary: string;
  source: LeaderContextResumeMessageSource;
}

export interface LeaderContextResumeQuestObservation {
  questId: string;
  title: string;
  currentBoardPhase: string;
  worker?: LeaderContextResumeParticipantObservation;
  reviewer?: LeaderContextResumeParticipantObservation;
  questStatus?: string | null;
  questOwnerSessionId?: string | null;
  rowUpdatedAt: number;
  lastRelevantLeaderInstruction?: LeaderContextResumeInstructionObservation;
  latestCurrentPhaseResult?: LeaderContextResumeResultObservation;
  latestSupportingResult?: LeaderContextResumeResultObservation;
}

export interface LeaderContextResumeQuestSynthesis {
  questId: string;
  whyHere: string;
  whyHereSource?: LeaderContextResumeMessageSource;
  latestMeaningfulResult?: string;
  latestMeaningfulResultSource?: LeaderContextResumeMessageSource;
  nextLeaderAction: string;
  mismatchNote?: string;
  warnings: string[];
}

export interface LeaderContextResumeModel {
  leader: LeaderContextResumeSessionRef;
  observed: {
    unresolvedUserDecisions: LeaderContextResumeNotificationObservation[];
    unresolvedNotifications: LeaderContextResumeNotificationObservation[];
    activeBoardQuests: LeaderContextResumeQuestObservation[];
    warnings: string[];
  };
  synthesized: {
    activeBoardQuests: LeaderContextResumeQuestSynthesis[];
    warnings: string[];
    suggestedCommands: string[];
  };
}

type LeaderDirectedTurn = {
  participant: LeaderContextResumeParticipant;
  startIndex: number;
  endIndex: number;
  startTimestamp: number;
  endTimestamp: number;
  content: string;
  phaseIds: string[];
  resultSummary: string;
  resultSource?: LeaderContextResumeMessageSource;
  startSource: LeaderContextResumeMessageSource;
};

const PHASE_KEYWORDS: Record<string, string[]> = {
  alignment: ["alignment", "planning", "read-in"],
  explore: ["explore", "exploration", "findings"],
  implement: ["implement", "implementation"],
  "code-review": ["code-review", "code review", "reviewer-groom", "skeptic-review", "review"],
  "mental-simulation": ["mental-simulation", "mental simulation", "scenario review"],
  execute: ["execute", "execution"],
  "outcome-review": ["outcome-review", "outcome review"],
  bookkeeping: ["bookkeeping", "state-update", "stream-update"],
  port: ["port", "porting"],
};

function truncate(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function extractTimestamp(message: BrowserIncomingMessage | undefined): number {
  if (!message) return 0;
  switch (message.type) {
    case "user_message":
    case "compact_marker":
    case "permission_approved":
    case "permission_denied":
      return message.timestamp || 0;
    case "assistant":
      return message.timestamp || 0;
    default:
      return 0;
  }
}

function extractAssistantText(message: Extract<BrowserIncomingMessage, { type: "assistant" }>): string {
  const blocks = message.message?.content ?? [];
  return blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function deriveTurnResultSummary(messages: BrowserIncomingMessage[], startIndex: number, endIndex: number): string {
  let lastAssistantText = "";
  for (let index = startIndex; index <= endIndex; index += 1) {
    const message = messages[index];
    if (message?.type === "assistant") {
      const text = extractAssistantText(message);
      if (text) lastAssistantText = text;
      continue;
    }
    if (message?.type === "result") {
      const resultText = message.data.result?.trim();
      if (resultText) return truncate(resultText);
      if (lastAssistantText) return truncate(lastAssistantText);
      if (message.data.is_error && message.data.errors?.length) {
        return truncate(message.data.errors.join("; "));
      }
    }
  }
  return truncate(lastAssistantText);
}

function phaseIdsForMessage(content: string): string[] {
  const normalized = content.toLowerCase();
  const matches: string[] = [];
  for (const [phaseId, keywords] of Object.entries(PHASE_KEYWORDS)) {
    if (keywords.some((keyword) => normalized.includes(keyword))) matches.push(phaseId);
  }
  return matches;
}

function isQuestRelevant(content: string, questId: string, participant: LeaderContextResumeParticipant): boolean {
  if (content.toLowerCase().includes(questId.toLowerCase())) return true;
  return participant.claimedQuestId === questId;
}

function makeMessageSource(
  session: LeaderContextResumeSessionRef,
  messageIndex: number,
  timestamp: number,
): LeaderContextResumeMessageSource {
  return {
    sessionId: session.sessionId,
    sessionNum: session.sessionNum,
    name: session.name,
    messageIndex,
    timestamp,
  };
}

function collectLeaderDirectedTurns(
  participant: LeaderContextResumeParticipant,
  leaderSessionId: string,
  questId: string,
): LeaderDirectedTurn[] {
  const turns = findTurnBoundaries(participant.messageHistory);
  const collected: LeaderDirectedTurn[] = [];
  for (const turn of turns) {
    const startMessage = participant.messageHistory[turn.startIdx];
    if (startMessage?.type !== "user_message") continue;
    if (startMessage.agentSource?.sessionId !== leaderSessionId) continue;
    if (!isQuestRelevant(startMessage.content || "", questId, participant)) continue;
    const phaseIds = phaseIdsForMessage(startMessage.content || "");
    const endIndex = turn.endIdx >= 0 ? turn.endIdx : participant.messageHistory.length - 1;
    const resultMessage =
      turn.endIdx >= 0 && participant.messageHistory[turn.endIdx]?.type === "result"
        ? (participant.messageHistory[turn.endIdx] as Extract<BrowserIncomingMessage, { type: "result" }>)
        : null;
    const startTimestamp = extractTimestamp(startMessage);
    const endTimestamp = resultMessage
      ? startTimestamp + (((resultMessage.data as CLIResultMessage).duration_ms as number | undefined) ?? 0)
      : startTimestamp;
    collected.push({
      participant,
      startIndex: turn.startIdx,
      endIndex: turn.endIdx,
      startTimestamp,
      endTimestamp,
      content: startMessage.content || "",
      phaseIds,
      resultSummary:
        turn.endIdx >= 0 ? deriveTurnResultSummary(participant.messageHistory, turn.startIdx, endIndex) : "",
      resultSource: turn.endIdx >= 0 ? makeMessageSource(participant, turn.endIdx, endTimestamp) : undefined,
      startSource: makeMessageSource(participant, turn.startIdx, startTimestamp),
    });
  }
  return collected;
}

function phaseDispatchLabel(phase: QuestJourneyPhase | null): string {
  if (!phase) return "dispatch";
  return phase.id.replace(/-/g, "_").toUpperCase();
}

function buildParticipantObservation(
  participant: LeaderContextResumeParticipant | undefined,
  rowStatusParticipant: BoardRowSessionStatus["worker"] | BoardRowSessionStatus["reviewer"],
  role: ParticipantRole,
): LeaderContextResumeParticipantObservation | undefined {
  if (participant) {
    return {
      sessionId: participant.sessionId,
      sessionNum: participant.sessionNum,
      name: participant.name,
      role,
      status: participant.status,
    };
  }
  if (!rowStatusParticipant) return undefined;
  return {
    sessionId: rowStatusParticipant.sessionId,
    sessionNum: rowStatusParticipant.sessionNum ?? null,
    name: rowStatusParticipant.name,
    role,
    status: rowStatusParticipant.status ?? "missing",
  };
}

function linkSession(session: LeaderContextResumeSessionRef | undefined): string {
  if (!session) return "unknown session";
  if (session.sessionNum != null) return `[#${session.sessionNum}](session:${session.sessionNum})`;
  return session.name?.trim() || session.sessionId.slice(0, 8);
}

function linkMessage(source: LeaderContextResumeMessageSource | undefined): string {
  if (!source) return "unknown source";
  if (source.sessionNum != null)
    return `[#${source.sessionNum} msg ${source.messageIndex}](session:${source.sessionNum}:${source.messageIndex})`;
  return `${source.sessionId.slice(0, 8)} msg ${source.messageIndex}`;
}

function formatNotificationId(notificationId: string): string {
  const match = /^n-(\d+)$/i.exec(notificationId);
  return match ? match[1] : notificationId;
}

function buildMismatchNote(
  quest: QuestmasterTask | null,
  workerParticipant: LeaderContextResumeParticipant | undefined,
  participants: Map<string, LeaderContextResumeParticipant>,
): string | undefined {
  if (!quest) return "quest details are unavailable";
  const notes: string[] = [];
  if (quest.status !== "in_progress") {
    notes.push(`quest lifecycle is \`${quest.status}\` while the board row is still active`);
  }
  if (
    "sessionId" in quest &&
    typeof quest.sessionId === "string" &&
    workerParticipant &&
    quest.sessionId !== workerParticipant.sessionId
  ) {
    const owner = participants.get(quest.sessionId);
    notes.push(
      `quest owner is ${linkSession(owner ?? { sessionId: quest.sessionId, sessionNum: null })} but board worker is ${linkSession(workerParticipant)}`,
    );
  }
  return notes.length > 0 ? notes.join("; ") : undefined;
}

function buildWhyHere(
  currentInstruction: LeaderDirectedTurn | undefined,
  supportingResult: LeaderDirectedTurn | undefined,
  phase: QuestJourneyPhase | null,
): { summary: string; source?: LeaderContextResumeMessageSource } {
  if (supportingResult?.resultSource && supportingResult.resultSummary) {
    return {
      summary: `${supportingResult.participant.role} result "${supportingResult.resultSummary}"`,
      source: supportingResult.resultSource,
    };
  }
  if (currentInstruction) {
    return {
      summary: `explicit \`${phaseDispatchLabel(phase)}\` dispatch`,
      source: currentInstruction.startSource,
    };
  }
  return { summary: "current board phase has no matched phase-explicit dispatch in recent participant history" };
}

function buildNextLeaderAction(args: {
  row: BoardRow;
  phase: QuestJourneyPhase | null;
  currentInstruction?: LeaderDirectedTurn;
  latestCurrentPhaseResult?: LeaderDirectedTurn;
  worker?: LeaderContextResumeParticipantObservation;
  reviewer?: LeaderContextResumeParticipantObservation;
}): string {
  const { row, phase, currentInstruction, latestCurrentPhaseResult, worker, reviewer } = args;
  if ((row.waitForInput ?? []).length > 0) {
    return `wait for same-session user input ${row.waitForInput!.map((notificationId) => formatNotificationId(notificationId)).join(", ")}`;
  }
  if (phase?.assigneeRole === "reviewer" && !reviewer) {
    return "attach or inspect the reviewer for this row";
  }
  if (phase?.assigneeRole !== "reviewer" && !worker) {
    return "attach or inspect the worker for this row";
  }
  if (latestCurrentPhaseResult?.resultSummary) {
    if (phase?.id === "port" && /\b(sync|synced|sha|commit|ported)\b/i.test(latestCurrentPhaseResult.resultSummary)) {
      return "remove the row and send the final quest handoff";
    }
    if (phase?.assigneeRole === "reviewer") {
      return "read the reviewer result and either send rework or advance";
    }
    return "read the worker report and choose the next phase";
  }
  if (currentInstruction) {
    const participant = currentInstruction.participant;
    const sessionLabel = linkSession(participant);
    if (participant.status === "disconnected" || participant.status === "archived") {
      return `inspect ${sessionLabel}; current phase is waiting on that report`;
    }
    return `wait for the ${participant.role} report from ${sessionLabel}`;
  }
  return (
    row.journey?.nextLeaderAction ??
    (row.status ? QUEST_JOURNEY_HINTS[row.status] : "inspect the row history and decide the next orchestration step")
  );
}

function commandForSource(source: LeaderContextResumeMessageSource | undefined): string | null {
  if (!source || source.sessionNum == null) return null;
  return `takode read ${source.sessionNum} ${source.messageIndex}`;
}

function peekCommandForParticipant(participant: LeaderContextResumeParticipantObservation | undefined): string | null {
  if (!participant || participant.sessionNum == null) return null;
  return `takode peek ${participant.sessionNum}`;
}

export async function buildLeaderContextResume(input: LeaderContextResumeInput): Promise<LeaderContextResumeModel> {
  if (input.leader.isOrchestrator !== true) {
    throw new Error("Session is not recognized as a leader/orchestrator session");
  }

  const leaderMessageIndexes = new Map<string, number>();
  for (let index = input.leader.messageHistory.length - 1; index >= 0; index -= 1) {
    const message = input.leader.messageHistory[index];
    if (message?.type === "assistant" && message.message?.id && !leaderMessageIndexes.has(message.message.id)) {
      leaderMessageIndexes.set(message.message.id, index);
    }
  }

  const unresolvedNotifications = input.leader.notifications
    .filter((notification) => notification.done !== true)
    .map((notification) => ({
      notificationId: notification.id,
      category: notification.category,
      summary: notification.summary?.trim() || "(no summary)",
      source:
        notification.messageId && leaderMessageIndexes.has(notification.messageId)
          ? makeMessageSource(
              input.leader,
              leaderMessageIndexes.get(notification.messageId)!,
              extractTimestamp(input.leader.messageHistory[leaderMessageIndexes.get(notification.messageId)!]),
            )
          : undefined,
    }))
    .sort((left, right) => left.notificationId.localeCompare(right.notificationId, undefined, { numeric: true }));

  const observedQuests: LeaderContextResumeQuestObservation[] = [];
  const synthesizedQuests: LeaderContextResumeQuestSynthesis[] = [];
  const warnings = new Set<string>();
  const suggestedCommands: string[] = [];

  for (const row of input.leader.board) {
    const rowStatus = input.rowSessionStatuses[row.questId];
    const workerId = row.worker || rowStatus?.worker?.sessionId;
    const reviewerId = rowStatus?.reviewer?.sessionId;
    const workerParticipant = workerId ? input.participants.get(workerId) : undefined;
    const reviewerParticipant = reviewerId ? input.participants.get(reviewerId) : undefined;
    const workerObservation = buildParticipantObservation(workerParticipant, rowStatus?.worker, "worker");
    const reviewerObservation = buildParticipantObservation(reviewerParticipant, rowStatus?.reviewer, "reviewer");
    const quest = await input.loadQuest(row.questId);
    const phase = getQuestJourneyPhase(row.journey?.currentPhaseId) ?? getQuestJourneyPhaseForState(row.status);
    const relevantTurns = [workerParticipant, reviewerParticipant]
      .filter((participant): participant is LeaderContextResumeParticipant => !!participant)
      .flatMap((participant) => collectLeaderDirectedTurns(participant, input.leader.sessionId, row.questId))
      .sort((left, right) => right.startTimestamp - left.startTimestamp || right.startIndex - left.startIndex);

    const phaseParticipantRole = phase?.assigneeRole;
    const currentInstruction =
      relevantTurns.find(
        (turn) =>
          !!phase?.id &&
          turn.phaseIds.includes(phase.id) &&
          (!phaseParticipantRole || turn.participant.role === phaseParticipantRole),
      ) ??
      relevantTurns.find((turn) => !!phase?.id && turn.phaseIds.includes(phase.id)) ??
      relevantTurns[0];

    const latestCurrentPhaseResult =
      currentInstruction && currentInstruction.resultSource && currentInstruction.resultSummary
        ? currentInstruction
        : undefined;

    const supportingResult = relevantTurns.find((turn) => {
      if (!turn.resultSource || !turn.resultSummary) return false;
      if (
        currentInstruction &&
        turn.startIndex === currentInstruction.startIndex &&
        turn.participant.sessionId === currentInstruction.participant.sessionId
      ) {
        return false;
      }
      if (currentInstruction) return turn.endTimestamp <= currentInstruction.startTimestamp;
      return true;
    });

    const mismatchNote = buildMismatchNote(quest, workerParticipant, input.participants);
    if (mismatchNote) warnings.add(`${row.questId}: ${mismatchNote}`);

    const rowWarnings: string[] = [];
    if (!currentInstruction) {
      rowWarnings.push("no matched phase-explicit leader dispatch found");
    }
    if (phase?.assigneeRole === "reviewer" && !reviewerObservation) {
      rowWarnings.push("current review phase has no reviewer session");
    }
    if (phase?.assigneeRole !== "reviewer" && !workerObservation) {
      rowWarnings.push("current worker phase has no worker session");
    }
    for (const warning of rowWarnings) warnings.add(`${row.questId}: ${warning}`);

    const whyHere = buildWhyHere(currentInstruction, supportingResult, phase);
    const nextLeaderAction = buildNextLeaderAction({
      row,
      phase,
      currentInstruction,
      latestCurrentPhaseResult,
      worker: workerObservation,
      reviewer: reviewerObservation,
    });

    observedQuests.push({
      questId: row.questId,
      title: row.title || quest?.title || row.questId,
      currentBoardPhase: row.status || phase?.boardState || "UNKNOWN",
      ...(workerObservation ? { worker: workerObservation } : {}),
      ...(reviewerObservation ? { reviewer: reviewerObservation } : {}),
      questStatus: quest?.status ?? null,
      questOwnerSessionId: quest && "sessionId" in quest ? (quest.sessionId ?? null) : null,
      rowUpdatedAt: row.updatedAt,
      ...(currentInstruction
        ? {
            lastRelevantLeaderInstruction: {
              participantRole: currentInstruction.participant.role,
              participantSessionId: currentInstruction.participant.sessionId,
              participantSessionNum: currentInstruction.participant.sessionNum,
              phaseId: currentInstruction.phaseIds[0],
              summary: `explicit \`${phaseDispatchLabel(phase)}\` dispatch`,
              source: currentInstruction.startSource,
            },
          }
        : {}),
      ...(latestCurrentPhaseResult
        ? {
            latestCurrentPhaseResult: {
              participantRole: latestCurrentPhaseResult.participant.role,
              participantSessionId: latestCurrentPhaseResult.participant.sessionId,
              participantSessionNum: latestCurrentPhaseResult.participant.sessionNum,
              phaseId: latestCurrentPhaseResult.phaseIds[0],
              summary: latestCurrentPhaseResult.resultSummary,
              source: latestCurrentPhaseResult.resultSource!,
            },
          }
        : {}),
      ...(supportingResult
        ? {
            latestSupportingResult: {
              participantRole: supportingResult.participant.role,
              participantSessionId: supportingResult.participant.sessionId,
              participantSessionNum: supportingResult.participant.sessionNum,
              phaseId: supportingResult.phaseIds[0],
              summary: supportingResult.resultSummary,
              source: supportingResult.resultSource!,
            },
          }
        : {}),
    });

    synthesizedQuests.push({
      questId: row.questId,
      whyHere: whyHere.summary,
      ...(whyHere.source ? { whyHereSource: whyHere.source } : {}),
      ...(latestCurrentPhaseResult?.resultSummary
        ? {
            latestMeaningfulResult: latestCurrentPhaseResult.resultSummary,
            latestMeaningfulResultSource: latestCurrentPhaseResult.resultSource,
          }
        : {}),
      nextLeaderAction,
      ...(mismatchNote ? { mismatchNote } : {}),
      warnings: rowWarnings,
    });

    const sourceCommand = commandForSource(latestCurrentPhaseResult?.resultSource ?? supportingResult?.resultSource);
    if (sourceCommand && !suggestedCommands.includes(sourceCommand)) suggestedCommands.push(sourceCommand);
    const peekCommand = peekCommandForParticipant(
      phase?.assigneeRole === "reviewer"
        ? (reviewerObservation ?? workerObservation)
        : (workerObservation ?? reviewerObservation),
    );
    if (peekCommand && !suggestedCommands.includes(peekCommand)) suggestedCommands.push(peekCommand);
  }

  if (unresolvedNotifications.some((notification) => notification.category === "needs-input")) {
    suggestedCommands.unshift("takode notify list");
  }

  return {
    leader: {
      sessionId: input.leader.sessionId,
      sessionNum: input.leader.sessionNum,
      name: input.leader.name,
    },
    observed: {
      unresolvedUserDecisions: unresolvedNotifications.filter(
        (notification) => notification.category === "needs-input",
      ),
      unresolvedNotifications,
      activeBoardQuests: observedQuests,
      warnings: [...warnings],
    },
    synthesized: {
      activeBoardQuests: synthesizedQuests,
      warnings: [...warnings],
      suggestedCommands: suggestedCommands.slice(0, 5),
    },
  };
}

export function renderLeaderContextResumeText(model: LeaderContextResumeModel): string {
  const lines: string[] = [];
  lines.push(`Recovery for ${linkSession(model.leader)}`);

  const unresolvedUserDecisions = model.observed.unresolvedUserDecisions;
  if (unresolvedUserDecisions.length === 0) {
    lines.push("- unresolved user decisions: none");
  } else {
    lines.push(`- unresolved user decisions: ${unresolvedUserDecisions.length}`);
    for (const notification of unresolvedUserDecisions) {
      const sourceSuffix = notification.source ? ` from ${linkMessage(notification.source)}` : "";
      lines.push(`  - ${formatNotificationId(notification.notificationId)}: ${notification.summary}${sourceSuffix}`);
    }
  }

  const extraNotifications = model.observed.unresolvedNotifications.filter(
    (notification) => notification.category !== "needs-input",
  );
  if (extraNotifications.length === 0) {
    lines.push("- unresolved same-session notifications: none");
  } else {
    lines.push(`- unresolved same-session notifications: ${extraNotifications.length}`);
    for (const notification of extraNotifications) {
      const sourceSuffix = notification.source ? ` from ${linkMessage(notification.source)}` : "";
      lines.push(`  - ${notification.category}: ${notification.summary}${sourceSuffix}`);
    }
  }

  lines.push("");
  lines.push(`Active quests: ${model.observed.activeBoardQuests.length}`);
  if (model.observed.activeBoardQuests.length === 0) {
    lines.push("- none");
  }

  for (const [index, observedQuest] of model.observed.activeBoardQuests.entries()) {
    const synthesizedQuest = model.synthesized.activeBoardQuests[index];
    const workerSummary = observedQuest.worker
      ? `${linkSession(observedQuest.worker)} ${observedQuest.worker.status}`
      : "no worker";
    const reviewerSummary = observedQuest.reviewer
      ? `${linkSession(observedQuest.reviewer)} ${observedQuest.reviewer.status}`
      : "no reviewer";
    lines.push("");
    lines.push(`[${observedQuest.questId}](quest:${observedQuest.questId}) -- ${observedQuest.currentBoardPhase}`);
    lines.push(`- worker/reviewer: ${workerSummary} / ${reviewerSummary}`);
    lines.push(
      `- why here: ${synthesizedQuest.whyHere}${synthesizedQuest.whyHereSource ? ` from ${linkMessage(synthesizedQuest.whyHereSource)}` : ""}`,
    );
    if (observedQuest.lastRelevantLeaderInstruction) {
      lines.push(
        `- last leader instruction: ${observedQuest.lastRelevantLeaderInstruction.summary} from ${linkMessage(observedQuest.lastRelevantLeaderInstruction.source)}`,
      );
    } else {
      lines.push("- last leader instruction: none found");
    }
    if (synthesizedQuest.latestMeaningfulResult && synthesizedQuest.latestMeaningfulResultSource) {
      lines.push(
        `- latest result: "${synthesizedQuest.latestMeaningfulResult}" from ${linkMessage(synthesizedQuest.latestMeaningfulResultSource)}`,
      );
    } else {
      lines.push("- latest result: none since that instruction");
    }
    lines.push(`- next leader action: ${synthesizedQuest.nextLeaderAction}`);
    if (synthesizedQuest.mismatchNote) {
      lines.push(`- note: ${synthesizedQuest.mismatchNote}`);
    }
  }

  lines.push("");
  lines.push("Warnings");
  if (model.synthesized.warnings.length === 0) {
    lines.push("- none");
  } else {
    for (const warning of model.synthesized.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("");
  lines.push("Suggested commands");
  if (model.synthesized.suggestedCommands.length === 0) {
    lines.push("- none");
  } else {
    for (const command of model.synthesized.suggestedCommands) {
      lines.push(`- \`${command}\``);
    }
  }

  return lines.join("\n");
}
