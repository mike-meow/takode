import type { BrowserIncomingMessage } from "../session-types.js";
import { sessionTag } from "../session-tag.js";
import { getKnownSessionNum } from "../cli-launcher.js";

// Injected into leader sessions after context compaction so they reload
// orchestration skills and recover enough self-history before making decisions.
const LEADER_COMPACTION_RECOVERY_PREFIX =
  "Context was compacted. Before continuing, recover enough context to safely resume orchestration:";

const STANDARD_COMPACTION_RECOVERY_PREFIX =
  "Context was compacted. Before continuing, recover enough context from your own session history to safely resume work:";

export const LEGACY_LEADER_COMPACTION_RECOVERY_PROMPT = `${LEADER_COMPACTION_RECOVERY_PREFIX}

1. Load skills: /takode-orchestration, /leader-dispatch, and /quest
2. Run the preferred leader recovery summary: \`takode leader-context-resume <your-session-number>\`
3. Key rules:
   - Treat the recovery summary as the first pass, then use manual follow-ups when the summary is stale, insufficient, or leaves phase history or user intent unclear
   - Hard stop: if the summary or notifications show unresolved user decisions or \`needs-input\` prompts, do not dispatch, advance quests, or answer on the user's behalf until the decision is resolved
   - Use \`takode scan <your-session-number>\` to inspect your own session history and recover enough earlier context before acting
   - Use \`takode board show\` to verify active Journey state and \`takode list\` to reconcile herd/session state when board or worker context matters
   - Use \`takode spawn\` to create workers (never Agent tool)
   - Invoke /leader-dispatch before every dispatch
   - Follow quest-journey.md for lifecycle transitions
   - Update the board (\`takode board set/advance\`) at every phase transition
   - Make worker instructions phase-explicit: plan only, perform the approved next phase and stop, review/rework and report back, port only when explicitly told
   - Never implement non-trivial changes yourself -- delegate to workers`;

// Injected into non-leader Takode sessions after context compaction so they
// recover enough self-history before resuming their current role.
export const LEGACY_STANDARD_COMPACTION_RECOVERY_PROMPT = `${STANDARD_COMPACTION_RECOVERY_PREFIX}

1. Inspect your own session history with Takode tools. Start with \`takode scan <your-session-number>\`
2. If you still need detail, inspect your own session further with Takode tools such as \`takode peek <your-session-number>\` or \`takode read <your-session-number>\`
3. Re-read the quest or latest assignment only after you have recovered enough earlier context from your own session
4. Keep your current role. If you are a worker or reviewer, continue the assigned task and do not switch into leader/orchestration behavior`;

/** Extract structured Q&A pairs from an AskUserQuestion approval. */
export function extractAskUserAnswers(
  originalInput: Record<string, unknown>,
  updatedInput?: Record<string, unknown>,
): { question: string; answer: string }[] | undefined {
  const answers = updatedInput?.answers as Record<string, string> | undefined;
  const questions = Array.isArray(originalInput.questions)
    ? (originalInput.questions as Record<string, unknown>[])
    : [];
  if (!answers || !questions.length) return undefined;

  const pairs: { question: string; answer: string }[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const questionText = typeof q.question === "string" ? q.question : "";
    const answer = answers[String(i)] ?? (questionText ? answers[questionText] : undefined);
    if (questionText && answer) {
      pairs.push({ question: questionText, answer });
    }
  }
  return pairs.length ? pairs : undefined;
}

type CompactionRecoverySessionLike = {
  id: string;
  sessionNum?: number | null;
  messageHistory: BrowserIncomingMessage[];
};

export function getCompactionRecoveryPrompt(role: "leader" | "standard", sessionRef: string): string {
  return role === "leader"
    ? `${LEADER_COMPACTION_RECOVERY_PREFIX}

1. Load skills: /takode-orchestration, /leader-dispatch, and /quest
2. Run the preferred leader recovery summary: \`takode leader-context-resume ${sessionRef}\`
3. Key rules:
   - Treat the recovery summary as the first pass, then use manual follow-ups when the summary is stale, insufficient, or leaves phase history or user intent unclear
   - Hard stop: if the summary or notifications show unresolved user decisions or \`needs-input\` prompts, do not dispatch, advance quests, or answer on the user's behalf until the decision is resolved
   - Use \`takode scan ${sessionRef}\` to inspect your own session history and recover enough earlier context before acting
   - Use \`takode board show\` to verify active Journey state and \`takode list\` to reconcile herd/session state when board or worker context matters
   - Use \`takode spawn\` to create workers (never Agent tool)
   - Invoke /leader-dispatch before every dispatch
   - Follow quest-journey.md for lifecycle transitions
   - Update the board (\`takode board set/advance\`) at every phase transition
   - Make worker instructions phase-explicit: plan only, perform the approved next phase and stop, review/rework and report back, port only when explicitly told
   - Never implement non-trivial changes yourself -- delegate to workers`
    : `${STANDARD_COMPACTION_RECOVERY_PREFIX}

1. Inspect your own session history with Takode tools. Start with \`takode scan ${sessionRef}\`
2. If you still need detail, inspect your own session further with Takode tools such as \`takode peek ${sessionRef}\` or \`takode read ${sessionRef}\`
3. Re-read the quest or latest assignment only after you have recovered enough earlier context from your own session
4. Keep your current role. If you are a worker or reviewer, continue the assigned task and do not switch into leader/orchestration behavior`;
}

export function isCompactionRecoveryPrompt(content: string): boolean {
  return (
    content === LEGACY_LEADER_COMPACTION_RECOVERY_PROMPT ||
    content === LEGACY_STANDARD_COMPACTION_RECOVERY_PROMPT ||
    content.startsWith(LEADER_COMPACTION_RECOVERY_PREFIX) ||
    content.startsWith(STANDARD_COMPACTION_RECOVERY_PREFIX)
  );
}

export function hasCompactionRecoveryAfterLatestMarker(
  session: CompactionRecoverySessionLike,
  deps: { isSystemSourceTag: (agentSource: { sessionId: string; sessionLabel?: string } | undefined) => boolean },
): boolean {
  let latestCompactIdx = -1;
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    if (session.messageHistory[i]?.type === "compact_marker") {
      latestCompactIdx = i;
      break;
    }
  }
  if (latestCompactIdx < 0) return false;

  for (let i = latestCompactIdx + 1; i < session.messageHistory.length; i++) {
    const entry = session.messageHistory[i] as
      | {
          type?: string;
          content?: string;
          agentSource?: { sessionId: string; sessionLabel?: string };
        }
      | undefined;
    if (entry?.type !== "user_message") continue;
    if (typeof entry.content !== "string" || !isCompactionRecoveryPrompt(entry.content)) continue;
    if (!deps.isSystemSourceTag(entry.agentSource)) continue;
    return true;
  }
  return false;
}

export function injectCompactionRecovery(
  session: CompactionRecoverySessionLike,
  deps: {
    isLeaderSession: (session: CompactionRecoverySessionLike) => boolean;
    isSystemSourceTag: (agentSource: { sessionId: string; sessionLabel?: string } | undefined) => boolean;
    injectUserMessage: (
      sessionId: string,
      content: string,
      agentSource?: { sessionId: string; sessionLabel?: string },
    ) => void;
  },
): void {
  if (hasCompactionRecoveryAfterLatestMarker(session, deps)) return;
  const role = deps.isLeaderSession(session) ? "leader" : "standard";
  const sessionRef = String(getKnownSessionNum(session.id) ?? session.sessionNum ?? session.id);
  const prompt = getCompactionRecoveryPrompt(role, sessionRef);
  console.log(`[ws-bridge] Injecting ${role} compaction recovery for session ${sessionTag(session.id)}`);
  deps.injectUserMessage(session.id, prompt, {
    sessionId: "system",
    sessionLabel: "System",
  });
}
