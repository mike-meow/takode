export type QuestLifecycleStatus = "in_progress" | "needs_verification" | "done";

export type QuestDetectionInput = { kind: "command"; text: string } | { kind: "result"; text: string };

export interface DetectedQuestEvent {
  questId?: string;
  title?: string;
  status?: QuestLifecycleStatus;
  targetStatus?: QuestLifecycleStatus;
}

function normalizeQuestStatus(value: string | undefined): QuestLifecycleStatus | undefined {
  if (!value) return undefined;
  const s = value.toLowerCase();
  if (s === "in_progress") return "in_progress";
  if (s === "needs_verification" || s === "verification") return "needs_verification";
  if (s === "done") return "done";
  return undefined;
}

function normalizeQuestId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/\b(q-\d+)\b/i);
  return match?.[1]?.toLowerCase();
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function detectFromCommand(command: string): DetectedQuestEvent | null {
  const match = command.match(/(?:^|[\s;|&])\/?quest\s+([a-z_]+)\s+(q-\d+)\b/i);
  if (!match) return null;

  const subcommand = match[1]?.toLowerCase();
  const questId = match[2];
  if (!subcommand || !questId) return null;

  if (subcommand === "claim") return { questId, targetStatus: "in_progress" };
  if (subcommand === "complete") return { questId, targetStatus: "needs_verification" };
  if (subcommand === "done" || subcommand === "cancel") return { questId, targetStatus: "done" };
  if (subcommand === "transition") {
    const statusMatch = command.match(/--status\s+([a-z_]+)/i);
    return { questId, targetStatus: normalizeQuestStatus(statusMatch?.[1]) };
  }

  return null;
}

function detectFromResult(resultText: string): DetectedQuestEvent | null {
  const trimmed = resultText.trim();
  if (!trimmed) return null;

  const parseCandidate = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const questId = normalizeQuestId(
        typeof parsed.questId === "string" ? parsed.questId : typeof parsed.id === "string" ? parsed.id : undefined,
      );
      const title = typeof parsed.title === "string" ? parsed.title : undefined;
      const status = normalizeQuestStatus(typeof parsed.status === "string" ? parsed.status : undefined);
      if (!questId && !title && !status) return null;
      return { questId, title, status };
    } catch {
      return null;
    }
  };

  const whole = parseCandidate(trimmed);
  if (whole) return whole;

  const jsonCandidates = extractJsonObjectCandidates(trimmed);
  for (let i = jsonCandidates.length - 1; i >= 0; i--) {
    const parsed = parseCandidate(jsonCandidates[i]);
    if (parsed) return parsed;
  }

  const claimLine = trimmed.match(/Claimed\s+(q-\d+)\s+"([^"]+)"/i);
  if (claimLine) {
    return { questId: claimLine[1], title: claimLine[2], status: "in_progress" };
  }

  const completeLine = trimmed.match(/Completed\s+(q-\d+)\s+"([^"]+)"/i);
  if (completeLine) {
    return { questId: completeLine[1], title: completeLine[2], status: "needs_verification" };
  }

  const doneLine = trimmed.match(/(?:Marked done|Cancelled)\s+(q-\d+)\s+"([^"]+)"/i);
  if (doneLine) {
    return { questId: doneLine[1], title: doneLine[2], status: "done" };
  }

  const transitionLine = trimmed.match(/Transitioned\s+(q-\d+)\s+to\s+([a-z_]+)/i);
  if (transitionLine) {
    return {
      questId: transitionLine[1],
      status: normalizeQuestStatus(transitionLine[2]),
    };
  }

  return null;
}

export function detectQuestEvent(input: QuestDetectionInput): DetectedQuestEvent | null {
  if (input.kind === "command") return detectFromCommand(input.text);
  return detectFromResult(input.text);
}
