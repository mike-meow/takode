import { getSettings } from "../settings-manager.js";
import type { CreationStepId } from "../session-types.js";
import type { OptionalAuthResult } from "./context.js";

export type SessionBackend = "claude" | "codex" | "claude-sdk";
export type SessionPreparationStatus = 400 | 503;

export function getActorSessionId(auth: OptionalAuthResult): string | undefined {
  return auth && "callerId" in auth ? auth.callerId : undefined;
}

export function getArchiveSource(
  actorSessionId?: string,
): import("../session-types.js").TakodeSessionArchivedEventData["archive_source"] {
  return actorSessionId ? "leader" : "user";
}

export class SessionPreparationError extends Error {
  constructor(
    message: string,
    public status: SessionPreparationStatus,
    public step?: CreationStepId,
  ) {
    super(message);
    this.name = "SessionPreparationError";
  }
}

export function resolveBackend(raw: unknown): SessionBackend | null {
  if (raw === "claude" || raw === "codex" || raw === "claude-sdk") return raw;
  return null;
}

export function applyDefaultClaudeBackend(backend: SessionBackend): SessionBackend {
  if (backend !== "claude") return backend;
  const configured = getSettings().defaultClaudeBackend;
  return configured === "claude-sdk" ? "claude-sdk" : "claude";
}

export function throwPreparationError(message: string, status: SessionPreparationStatus, step?: CreationStepId): never {
  throw new SessionPreparationError(message, status, step);
}

export function markOrchestratorSessionAfterConnect(
  deps: {
    launcher: { getSession(sessionId: string): { state?: string } | undefined };
    wsBridge: { injectUserMessage(sessionId: string, prompt: string): void };
  },
  sessionId: string,
  prompt: string,
): void {
  (async () => {
    const maxWait = 30_000;
    const pollMs = 200;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const info = deps.launcher.getSession(sessionId);
      if (info && (info.state === "connected" || info.state === "running")) {
        deps.wsBridge.injectUserMessage(sessionId, prompt);
        return;
      }
      if (info?.state === "exited") return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  })().catch((e) => console.error(`[routes] Failed to inject orchestrator message:`, e));
}

export function buildCodexTurnSegments(
  messageHistory: Array<{ type: string; id?: string }>,
): Array<{ startIdx: number; userMessageIds: string[] }> {
  const segments: Array<{ startIdx: number; userMessageIds: string[] }> = [];
  let startIdx: number | null = null;
  let userMessageIds: string[] = [];

  for (let idx = 0; idx < messageHistory.length; idx++) {
    const msg = messageHistory[idx];
    if (msg.type === "user_message") {
      if (startIdx === null) startIdx = idx;
      if (typeof msg.id === "string") userMessageIds.push(msg.id);
    }
    if (msg.type === "result" && startIdx !== null) {
      segments.push({ startIdx, userMessageIds: [...userMessageIds] });
      startIdx = null;
      userMessageIds = [];
    }
  }

  if (startIdx !== null) {
    segments.push({ startIdx, userMessageIds: [...userMessageIds] });
  }

  return segments;
}

export function computeCodexRevertPlan(
  session: {
    messageHistory: Array<{ type: string; id?: string }>;
  },
  messageId: string,
): { truncateIdx: number; numTurns: number; exactTurnBoundary: boolean } | null {
  const segments = buildCodexTurnSegments(session.messageHistory);
  const targetTurnIndex = segments.findIndex((segment) => segment.userMessageIds.includes(messageId));
  if (targetTurnIndex < 0) return null;

  const targetSegment = segments[targetTurnIndex]!;
  return {
    truncateIdx: targetSegment.startIdx,
    numTurns: segments.length - targetTurnIndex,
    exactTurnBoundary: targetSegment.userMessageIds[0] === messageId,
  };
}
