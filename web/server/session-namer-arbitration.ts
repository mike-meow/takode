export const NAMER_TRIGGER_SOURCES = ["user_message", "turn_completed", "agent_paused"] as const;

export type NamerTriggerSource = (typeof NAMER_TRIGGER_SOURCES)[number];

export interface NamerMutationRecord {
  source: NamerTriggerSource;
  action: "name" | "revise" | "new";
  nextName: string;
  timestamp: number;
}

export const USER_OVERRIDE_WINDOW_MS = 60_000;

/**
 * Decide whether a user-message naming result should override a fresh-name
 * mismatch caused by a recent agent-triggered REVISE.
 */
export function shouldAllowUserMessageOverrideOnNameMismatch(
  freshName: string | null | undefined,
  lastMutation: NamerMutationRecord | undefined,
  now = Date.now(),
): boolean {
  if (!freshName || !lastMutation) return false;
  const isAgentTriggered = lastMutation.source === "turn_completed" || lastMutation.source === "agent_paused";
  if (!isAgentTriggered || lastMutation.action !== "revise") return false;
  if (now - lastMutation.timestamp > USER_OVERRIDE_WINDOW_MS) return false;
  return lastMutation.nextName === freshName;
}
