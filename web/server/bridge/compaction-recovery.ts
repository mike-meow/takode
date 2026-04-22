import type { BrowserIncomingMessage } from "../session-types.js";
import { sessionTag } from "../session-tag.js";

// Injected into leader sessions after context compaction so they reload
// orchestration skills and recover enough self-history before making decisions.
export const LEADER_COMPACTION_RECOVERY_PROMPT = `Context was compacted. Before continuing, recover enough context to safely resume orchestration:

1. Load skills: /takode-orchestration, /leader-dispatch, and /quest
2. Run: takode board show && takode list
3. Key rules:
   - Inspect your own session history with Takode tools before resuming. Start with \`takode scan <your-session-number>\` and keep digging until you recover enough earlier context for the current orchestration state
   - Use \`takode spawn\` to create workers (never Agent tool)
   - Invoke /leader-dispatch before every dispatch
   - Follow quest-journey.md for lifecycle transitions
   - Update the board (\`takode board set/advance\`) at every stage transition
   - Make worker instructions stage-explicit: plan only, implement and stop, reviewer-groom/rework and report back, port only when explicitly told
   - Never implement non-trivial changes yourself -- delegate to workers`;

// Injected into non-leader Takode sessions after context compaction so they
// recover enough self-history before resuming their current role.
export const STANDARD_COMPACTION_RECOVERY_PROMPT = `Context was compacted. Before continuing, recover enough context from your own session history to safely resume work:

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
  messageHistory: BrowserIncomingMessage[];
};

export function getCompactionRecoveryPrompt(role: "leader" | "standard"): string {
  return role === "leader" ? LEADER_COMPACTION_RECOVERY_PROMPT : STANDARD_COMPACTION_RECOVERY_PROMPT;
}

export function isCompactionRecoveryPrompt(content: string): boolean {
  return content === LEADER_COMPACTION_RECOVERY_PROMPT || content === STANDARD_COMPACTION_RECOVERY_PROMPT;
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
  const prompt = getCompactionRecoveryPrompt(role);
  console.log(`[ws-bridge] Injecting ${role} compaction recovery for session ${sessionTag(session.id)}`);
  deps.injectUserMessage(session.id, prompt, {
    sessionId: "system",
    sessionLabel: "System",
  });
}
