import { randomUUID } from "node:crypto";
import type { BrowserIncomingMessage, CLIControlResponseMessage, CLIMessage } from "../session-types.js";
import { getTrafficMessageType, trafficStats } from "../traffic-stats.js";
import { sessionTag } from "../session-tag.js";
import type { UserDispatchTurnTarget } from "./generation-lifecycle.js";

type CliSocketLike = {
  send(data: string): void;
  close(): void;
};

export interface PendingControlRequestLike {
  subtype: string;
  resolve: (response: unknown) => void;
}

export interface ClaudeCliTransportLauncherInfoLike {
  cliSessionId?: string;
  injectedSystemPrompt?: string;
  isOrchestrator?: boolean;
  killedByIdleManager?: boolean;
}

export interface ClaudeCliTransportSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  backendSocket: CliSocketLike | null;
  state: {
    cwd: string;
    session_id?: string;
  };
  pendingMessages: string[];
  messageHistory: BrowserIncomingMessage[];
  pendingPermissions: Map<string, unknown>;
  pendingControlRequests: Map<string, PendingControlRequestLike>;
  assistantAccumulator: { clear(): void };
  disconnectGraceTimer: ReturnType<typeof setTimeout> | null;
  disconnectWasGenerating: boolean;
  relaunchPending: boolean;
  cliInitializeSent: boolean;
  seamlessReconnect: boolean;
  cliResumingClearTimer: ReturnType<typeof setTimeout> | null;
  cliResuming: boolean;
  cliInitReceived: boolean;
  lastCliMessageAt: number | null;
  lastCliPingAt: number | null;
  lastOutboundUserNdjson: string | null;
  isGenerating: boolean;
}

export interface ClaudeCliTransportDeps {
  broadcastToBrowsers: (session: ClaudeCliTransportSessionLike, msg: BrowserIncomingMessage) => void;
  refreshGitInfoThenRecomputeDiff: (
    session: ClaudeCliTransportSessionLike,
    options: { notifyPoller: boolean },
  ) => void;
  getLauncherSessionInfo: (sessionId: string) => ClaudeCliTransportLauncherInfoLike | null | undefined;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  routeCLIMessage: (session: ClaudeCliTransportSessionLike, msg: CLIMessage) => void;
  recordIncomingRaw: (sessionId: string, data: string, backendType: string, cwd: string) => void;
  recordOutgoingRaw: (sessionId: string, data: string, backendType: string, cwd: string) => void;
  markTurnInterrupted: (session: ClaudeCliTransportSessionLike, source: "user" | "leader" | "system") => void;
  setGenerating: (session: ClaudeCliTransportSessionLike, generating: boolean, reason: string) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  setAttentionError: (session: ClaudeCliTransportSessionLike) => void;
  persistSession: (session: ClaudeCliTransportSessionLike) => void;
  onOrchestratorDisconnect: (sessionId: string) => void;
  requestCliRelaunch?: (sessionId: string) => void;
  markRunningFromUserDispatch: (
    session: ClaudeCliTransportSessionLike,
    reason: string,
  ) => UserDispatchTurnTarget | null;
  isCliUserMessagePayload: (ndjson: string) => boolean;
}

export function handleCLIOpen(
  session: ClaudeCliTransportSessionLike,
  sessionId: string,
  ws: CliSocketLike,
  deps: ClaudeCliTransportDeps,
): void {
  session.backendSocket = ws;

  if (session.disconnectGraceTimer) {
    clearTimeout(session.disconnectGraceTimer);
    session.disconnectGraceTimer = null;
    if (session.relaunchPending) {
      console.log(
        `[ws-bridge] CLI connected after relaunch for session ${sessionTag(sessionId)} (not seamless, wasGenerating=${session.disconnectWasGenerating})`,
      );
      session.relaunchPending = false;
      session.cliInitializeSent = false;
    } else {
      session.seamlessReconnect = true;
      console.log(
        `[ws-bridge] CLI reconnected within grace period for session ${sessionTag(sessionId)} (seamless, wasGenerating=${session.disconnectWasGenerating})`,
      );
    }
  }

  if (session.messageHistory.length > 0) {
    if (session.cliResumingClearTimer) {
      clearTimeout(session.cliResumingClearTimer);
      session.cliResumingClearTimer = null;
    }
    session.cliResuming = true;
  }
  console.log(
    `[ws-bridge] CLI connected for session ${sessionTag(sessionId)}${session.cliResuming ? " (resuming)" : ""}`,
  );
  deps.broadcastToBrowsers(session, { type: "backend_connected" });
  deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });

  if (session.backendType === "claude" && !session.cliInitializeSent) {
    const launcherInfoForInit = deps.getLauncherSessionInfo(sessionId);
    const instructions = launcherInfoForInit?.injectedSystemPrompt;
    if (instructions) {
      sendControlRequest(
        session,
        {
          subtype: "initialize",
          appendSystemPrompt: instructions,
        },
        undefined,
        deps,
      );
      session.cliInitializeSent = true;
      console.log(
        `[ws-bridge] Sent initialize control_request with appendSystemPrompt for session ${sessionTag(sessionId)} (${instructions.length} chars)`,
      );
    }
  }

  const launcherInfo = deps.getLauncherSessionInfo(sessionId);
  const isResuming = !!launcherInfo?.cliSessionId;
  if (session.pendingMessages.length > 0 && !isResuming) {
    flushQueuedCliMessages(session, "on CLI connect", deps);
  } else if (session.pendingMessages.length > 0) {
    console.log(
      `[ws-bridge] ${session.pendingMessages.length} queued message(s) deferred until init for session ${sessionTag(sessionId)} (resuming)`,
    );
  }
  deps.onSessionActivityStateChanged(session.id, "cli_open");
}

export function processCLIMessageBatch(
  session: ClaudeCliTransportSessionLike,
  sessionId: string,
  data: string,
  deps: ClaudeCliTransportDeps,
): string {
  deps.recordIncomingRaw(sessionId, data, session.backendType, session.state.cwd);
  const lines = data.split("\n").filter((line) => line.trim());
  let firstType: string | undefined;
  for (const line of lines) {
    let msg: CLIMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      trafficStats.record({
        sessionId,
        channel: "cli",
        direction: "in",
        messageType: "invalid_json",
        payloadBytes: Buffer.byteLength(line, "utf-8"),
      });
      console.warn(`[ws-bridge] Failed to parse CLI message: ${line.substring(0, 200)}`);
      continue;
    }
    trafficStats.record({
      sessionId,
      channel: "cli",
      direction: "in",
      messageType: getTrafficMessageType(msg),
      payloadBytes: Buffer.byteLength(line, "utf-8"),
    });
    firstType ??= msg.type;
    deps.routeCLIMessage(session, msg);
  }
  return firstType ?? "unknown";
}

export function handleCLIClose(
  session: ClaudeCliTransportSessionLike,
  sessionId: string,
  deps: ClaudeCliTransportDeps & { recentCliDisconnects: number[] },
  code?: number,
  reason?: string,
): void {
  const now = Date.now();
  const wasGenerating = session.isGenerating;
  session.backendSocket = null;
  session.cliInitReceived = false;
  if (session.cliResumingClearTimer) {
    clearTimeout(session.cliResumingClearTimer);
    session.cliResumingClearTimer = null;
  }
  deps.onSessionActivityStateChanged(session.id, "cli_close");
  const idleKilled = deps.getLauncherSessionInfo(sessionId)?.killedByIdleManager;
  const sinceLastMsg = session.lastCliMessageAt ? now - session.lastCliMessageAt : -1;
  const sinceLastPing = session.lastCliPingAt ? now - session.lastCliPingAt : -1;
  console.log(
    `[ws-bridge] CLI disconnected for session ${sessionTag(sessionId)}${idleKilled ? " (idle limit)" : ""}` +
      ` | code=${code ?? "?"} reason=${JSON.stringify(reason || "")}` +
      ` wasGenerating=${wasGenerating}` +
      ` sinceLastMsg=${sinceLastMsg > 0 ? `${(sinceLastMsg / 1000).toFixed(1)}s` : "n/a"}` +
      ` sinceLastPing=${sinceLastPing > 0 ? `${(sinceLastPing / 1000).toFixed(1)}s` : "n/a"}`,
  );

  deps.recentCliDisconnects.push(now);
  while (deps.recentCliDisconnects.length > 0 && now - deps.recentCliDisconnects[0] > 2000) {
    deps.recentCliDisconnects.shift();
  }
  if (deps.recentCliDisconnects.length >= 3) {
    const span = now - deps.recentCliDisconnects[0];
    console.warn(
      `[ws-bridge] ⚠ Mass CLI disconnect: ${deps.recentCliDisconnects.length} CLIs dropped in ${span}ms` +
        ` — likely a network event, not a per-session issue`,
    );
  }

  if (idleKilled) {
    runFullDisconnect(session, sessionId, wasGenerating, idleKilled, deps, reason);
    return;
  }

  if (deps.getLauncherSessionInfo(sessionId)?.isOrchestrator) {
    deps.onOrchestratorDisconnect(sessionId);
  }

  session.disconnectWasGenerating = session.disconnectWasGenerating || wasGenerating;
  if (session.disconnectGraceTimer) clearTimeout(session.disconnectGraceTimer);
  session.disconnectGraceTimer = setTimeout(() => {
    session.disconnectGraceTimer = null;
    if (!session.backendSocket) {
      console.log(`[ws-bridge] Grace period expired for session ${sessionTag(sessionId)}, running full disconnect`);
      runFullDisconnect(session, sessionId, session.disconnectWasGenerating, false, deps, reason);
    }
  }, 15_000);
  console.log(`[ws-bridge] Grace period started for session ${sessionTag(sessionId)} (15s, expecting reconnect)`);
}

export function runFullDisconnect(
  session: ClaudeCliTransportSessionLike,
  sessionId: string,
  wasGenerating: boolean,
  idleKilled: boolean | undefined,
  deps: ClaudeCliTransportDeps,
  reason?: string,
): void {
  if (session.isGenerating) {
    deps.markTurnInterrupted(session, "system");
    deps.setGenerating(session, false, "cli_disconnect");
  }

  deps.broadcastToBrowsers(session, {
    type: "backend_disconnected",
    ...(idleKilled ? { reason: "idle_limit" } : {}),
  });
  deps.emitTakodeEvent(sessionId, "session_disconnected", {
    wasGenerating,
    reason: idleKilled ? "idle_limit" : reason || "unknown",
  });
  deps.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
  if (wasGenerating && !idleKilled) {
    deps.setAttentionError(session);
  }

  for (const [reqId] of session.pendingPermissions) {
    deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
  }
  session.pendingPermissions.clear();
  session.assistantAccumulator.clear();
  deps.onSessionActivityStateChanged(session.id, "full_disconnect");

  if (wasGenerating && !idleKilled) {
    if (session.lastOutboundUserNdjson) {
      const alreadyQueued = session.pendingMessages.some((message) => message === session.lastOutboundUserNdjson);
      if (!alreadyQueued) {
        console.log(
          `[ws-bridge] Re-queuing in-flight user message for session ${sessionTag(sessionId)} (will re-send after reconnect)`,
        );
        session.pendingMessages.push(session.lastOutboundUserNdjson);
      }
      session.lastOutboundUserNdjson = null;
    } else if (session.pendingMessages.length === 0) {
      const nudgeContent = "[CLI disconnected and relaunched. Please continue your work from where you left off.]";
      const nudge = JSON.stringify({
        type: "user",
        message: { role: "user", content: nudgeContent },
        parent_tool_use_id: null,
        session_id: session.state.session_id || "",
      });
      console.log(
        `[ws-bridge] Queuing continue-nudge for session ${sessionTag(sessionId)} (was generating, no user message in flight)`,
      );
      session.pendingMessages.push(nudge);
      session.messageHistory.push({
        type: "user_message",
        content: nudgeContent,
        timestamp: Date.now(),
        id: `nudge-${Date.now()}`,
      } as BrowserIncomingMessage);
    }
  }

  deps.persistSession(session);
  if (!idleKilled && deps.requestCliRelaunch) {
    deps.requestCliRelaunch(sessionId);
  }
}

export function sendControlRequest(
  session: ClaudeCliTransportSessionLike,
  request: Record<string, unknown>,
  onResponse: PendingControlRequestLike | undefined,
  deps: ClaudeCliTransportDeps,
): void {
  const requestId = randomUUID();
  if (onResponse) {
    session.pendingControlRequests.set(requestId, onResponse);
  }
  sendToCLI(
    session,
    JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    }),
    undefined,
    deps,
  );
}

export function handleControlResponse(
  session: ClaudeCliTransportSessionLike,
  msg: CLIControlResponseMessage,
): void {
  const reqId = msg.response.request_id;
  const pending = session.pendingControlRequests.get(reqId);
  if (!pending) return;
  session.pendingControlRequests.delete(reqId);

  if (msg.response.subtype === "error") {
    console.warn(`[ws-bridge] Control request ${pending.subtype} failed: ${msg.response.error}`);
    return;
  }

  pending.resolve(msg.response.response ?? {});
}

export function sendToCLI(
  session: ClaudeCliTransportSessionLike,
  ndjson: string,
  opts:
    | {
        deferUntilCliReady?: boolean;
        skipUserDispatchLifecycle?: boolean;
      }
    | undefined,
  deps: ClaudeCliTransportDeps,
): UserDispatchTurnTarget | null {
  let turnTarget: UserDispatchTurnTarget | null = null;
  if (!opts?.skipUserDispatchLifecycle && deps.isCliUserMessagePayload(ndjson)) {
    turnTarget = deps.markRunningFromUserDispatch(session, "user_message_dispatch");
  }
  if (!session.backendSocket) {
    console.log(`[ws-bridge] CLI not yet connected for session ${sessionTag(session.id)}, queuing message`);
    session.pendingMessages.push(ndjson);
    return turnTarget;
  }
  if (opts?.deferUntilCliReady && (!session.cliInitReceived || session.cliResuming)) {
    console.log(
      `[ws-bridge] CLI not ready for injected herd event in session ${sessionTag(session.id)}, queuing until init/replay completes`,
    );
    session.pendingMessages.push(ndjson);
    return turnTarget;
  }
  deps.recordOutgoingRaw(session.id, ndjson, session.backendType, session.state.cwd);
  try {
    session.backendSocket.send(ndjson + "\n");
    trafficStats.record({
      sessionId: session.id,
      channel: "cli",
      direction: "out",
      messageType: getTrafficMessageType(JSON.parse(ndjson) as Record<string, unknown>),
      payloadBytes: Buffer.byteLength(ndjson + "\n", "utf-8"),
    });
  } catch (err) {
    console.warn(
      `[ws-bridge] CLI send failed for session ${sessionTag(session.id)}, re-queuing message and closing dead socket:`,
      err,
    );
    session.pendingMessages.push(ndjson);
    try {
      session.backendSocket.close();
    } catch {}
  }
  return turnTarget;
}

export function flushQueuedCliMessages(
  session: ClaudeCliTransportSessionLike,
  reason: string,
  deps: ClaudeCliTransportDeps,
): void {
  if (session.pendingMessages.length === 0) return;
  console.log(
    `[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) ${reason} for session ${sessionTag(session.id)}`,
  );
  const queued = session.pendingMessages.splice(0);
  for (const ndjson of queued) {
    sendToCLI(session, ndjson, { skipUserDispatchLifecycle: true }, deps);
  }
}
