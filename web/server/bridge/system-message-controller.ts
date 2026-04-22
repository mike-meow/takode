import type {
  BrowserIncomingMessage,
  CLISystemCompactBoundaryMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLISystemTaskNotificationMessage,
  SessionState,
} from "../session-types.js";
import { inferContextWindowFromModel } from "./context-usage.js";
import { sessionTag } from "../session-tag.js";

type SystemMessage =
  | CLISystemInitMessage
  | CLISystemStatusMessage
  | CLISystemCompactBoundaryMessage
  | CLISystemTaskNotificationMessage;

export interface SystemMessageSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  cliInitReceived: boolean;
  cliResuming: boolean;
  cliResumingClearTimer: ReturnType<typeof setTimeout> | null;
  forceCompactPending: boolean;
  compactedDuringTurn: boolean;
  awaitingCompactSummary?: boolean;
  claudeCompactBoundarySeen?: boolean;
  seamlessReconnect: boolean;
  disconnectWasGenerating: boolean;
  isGenerating: boolean;
  generationStartedAt?: number | null;
  lastOutboundUserNdjson: string | null;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  state: SessionState;
}

interface BroadcastOptions {
  skipBuffer?: boolean;
}

interface SystemMessageDeps {
  onCLISessionId?: (sessionId: string, cliSessionId: string) => void;
  cacheSlashCommands: (projectKey: string, data: { slash_commands: string[]; skills: string[] }) => void;
  backfillSlashCommands: (projectKey: string, sourceSessionId: string) => void;
  refreshGitInfoThenRecomputeDiff: (
    session: SystemMessageSessionLike,
    options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
  ) => void;
  getLauncherSessionInfo: (sessionId: string) => { isOrchestrator?: boolean } | null | undefined;
  broadcastToBrowsers: (
    session: SystemMessageSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: SystemMessageSessionLike) => void;
  hasPendingForceCompact: (session: SystemMessageSessionLike) => boolean;
  flushQueuedCliMessages: (session: SystemMessageSessionLike, reason: string) => void;
  onOrchestratorTurnEnd: (sessionId: string) => void;
  isCliUserMessagePayload: (ndjson: string) => boolean;
  markTurnInterrupted: (session: SystemMessageSessionLike, source: "system") => void;
  setGenerating: (session: SystemMessageSessionLike, generating: boolean, reason: string) => void;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  injectCompactionRecovery: (session: SystemMessageSessionLike) => void;
  hasCompactBoundaryReplay: (
    session: SystemMessageSessionLike,
    cliUuid: string | undefined,
    meta: CLISystemCompactBoundaryMessage["compact_metadata"],
  ) => boolean;
  freezeHistoryThroughCurrentTail: (session: SystemMessageSessionLike) => void;
  hasTaskNotificationReplay: (session: SystemMessageSessionLike, taskId: string, toolUseId: string) => boolean;
  stuckGenerationThresholdMs: number;
}

export function handleSystemMessage(
  session: SystemMessageSessionLike,
  msg: SystemMessage,
  deps: SystemMessageDeps,
): void {
  if (msg.subtype === "init") {
    handleSystemInit(session, msg, deps);
    return;
  }
  if (msg.subtype === "status") {
    handleSystemStatus(session, msg, deps);
    return;
  }
  if (msg.subtype === "compact_boundary") {
    handleCompactBoundary(session, msg, deps);
    return;
  }
  if (msg.subtype === "task_notification") {
    handleTaskNotification(session, msg, deps);
  }
}

function handleSystemInit(
  session: SystemMessageSessionLike,
  msg: CLISystemInitMessage,
  deps: SystemMessageDeps,
): void {
  session.cliInitReceived = true;

  if (msg.session_id && deps.onCLISessionId) {
    deps.onCLISessionId(session.id, msg.session_id);
  }

  session.state.model = msg.model;
  const inferredContextWindow = inferContextWindowFromModel(msg.model);
  if (inferredContextWindow && !session.state.claude_token_details) {
    session.state.claude_token_details = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      modelContextWindow: inferredContextWindow,
    };
  }
  if (!session.state.is_containerized) {
    session.state.cwd = msg.cwd;
  }
  session.state.tools = msg.tools;
  const isResume = session.messageHistory.length > 0;
  if (!isResume) {
    session.state.permissionMode = msg.permissionMode;
  }
  session.state.claude_code_version = msg.claude_code_version;

  if (session.cliResuming) {
    if (session.cliResumingClearTimer) clearTimeout(session.cliResumingClearTimer);
    session.cliResumingClearTimer = setTimeout(() => {
      session.cliResumingClearTimer = null;
      session.cliResuming = false;
      console.log(
        `[revert] cliResuming cleared for session ${session.id.slice(0, 8)} — replay done. Final historyLen=${session.messageHistory.length}`,
      );
      const compactPending = deps.hasPendingForceCompact(session);
      session.forceCompactPending = compactPending;
      session.state.is_compacting = compactPending;
      session.awaitingCompactSummary = false;
      session.claudeCompactBoundarySeen = false;
      if (compactPending) {
        deps.broadcastToBrowsers(session, { type: "status_change", status: "compacting" });
      }
      if (session.pendingMessages.length > 0) {
        deps.flushQueuedCliMessages(session, "after replay done");
      }
      const launcherInfo = deps.getLauncherSessionInfo(session.id);
      if (launcherInfo?.isOrchestrator) {
        deps.onOrchestratorTurnEnd(session.id);
      }
    }, 2000);
  } else {
    session.state.is_compacting = false;
  }

  session.state.mcp_servers = msg.mcp_servers;
  session.state.agents = msg.agents ?? [];
  session.state.slash_commands = msg.slash_commands ?? [];
  session.state.skills = msg.skills ?? [];
  session.state.skill_metadata = [];
  session.state.apps = [];

  const projectKey = session.state.repo_root || session.state.cwd;
  if (projectKey && (msg.slash_commands?.length || msg.skills?.length)) {
    deps.cacheSlashCommands(projectKey, {
      slash_commands: msg.slash_commands ?? [],
      skills: msg.skills ?? [],
    });
    deps.backfillSlashCommands(projectKey, session.id);
  }

  deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });

  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  deps.broadcastToBrowsers(session, {
    type: "session_init",
    session: {
      ...session.state,
      isOrchestrator: launcherInfo?.isOrchestrator === true,
    },
  });
  deps.persistSession(session);

  const generationAge = session.generationStartedAt ? Date.now() - session.generationStartedAt : 0;
  const seamlessButStuck = session.seamlessReconnect && generationAge >= deps.stuckGenerationThresholdMs;
  if (seamlessButStuck) {
    console.warn(
      `[ws-bridge] Seamless reconnect with stale generation (${Math.round(generationAge / 1000)}s) for session ${sessionTag(session.id)} — treating as relaunch`,
    );
  }
  if (session.isGenerating && (!session.seamlessReconnect || seamlessButStuck)) {
    const hasInFlightUserDispatch =
      typeof session.lastOutboundUserNdjson === "string" && deps.isCliUserMessagePayload(session.lastOutboundUserNdjson);
    if (hasInFlightUserDispatch) {
      console.log(
        `[ws-bridge] Preserving running state on system.init for in-flight user dispatch in session ${sessionTag(session.id)}`,
      );
    } else {
      console.log(
        `[ws-bridge] Force-clearing stale isGenerating on system.init for session ${sessionTag(session.id)}${seamlessButStuck ? " (seamless but stuck)" : ""}`,
      );
      deps.markTurnInterrupted(session, "system");
      deps.setGenerating(session, false, "system_init_reset");
      deps.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
    }
  }
  session.seamlessReconnect = false;
  session.disconnectWasGenerating = false;

  if (!session.cliResuming) {
    if (session.pendingMessages.length > 0) {
      deps.flushQueuedCliMessages(session, "after init");
    }
    if (launcherInfo?.isOrchestrator) {
      deps.onOrchestratorTurnEnd(session.id);
    }
  } else if (session.pendingMessages.length > 0) {
    console.log(
      `[ws-bridge] ${session.pendingMessages.length} queued message(s) deferred until replay done for session ${sessionTag(session.id)}`,
    );
  }
  deps.onSessionActivityStateChanged(session.id, "system_init");
}

function handleSystemStatus(
  session: SystemMessageSessionLike,
  msg: CLISystemStatusMessage,
  deps: SystemMessageDeps,
): void {
  const wasCompacting = session.state.is_compacting;
  const forceCompactPending = session.forceCompactPending;
  session.state.is_compacting = msg.status === "compacting";
  const enteringCompacting = msg.status === "compacting" && (!wasCompacting || forceCompactPending);
  if (msg.status === "compacting") {
    session.forceCompactPending = false;
  }
  if (enteringCompacting && session.backendType === "claude") {
    session.claudeCompactBoundarySeen = false;
  }
  if (enteringCompacting && !session.cliResuming) {
    session.compactedDuringTurn = true;
    deps.emitTakodeEvent(session.id, "compaction_started", {
      ...(typeof session.state.context_used_percent === "number"
        ? { context_used_percent: session.state.context_used_percent }
        : {}),
    });
  }
  if (wasCompacting && msg.status !== "compacting" && !session.cliResuming) {
    deps.emitTakodeEvent(session.id, "compaction_finished", {
      ...(typeof session.state.context_used_percent === "number"
        ? { context_used_percent: session.state.context_used_percent }
        : {}),
    });
    if (session.backendType !== "claude" || session.claudeCompactBoundarySeen) {
      deps.injectCompactionRecovery(session);
    }
  }
  if (wasCompacting && msg.status !== "compacting" && session.backendType === "claude") {
    session.claudeCompactBoundarySeen = false;
  }

  if (msg.permissionMode) {
    session.state.permissionMode = msg.permissionMode;
    if (!session.cliResuming) {
      const uiMode = msg.permissionMode === "plan" ? "plan" : "agent";
      session.state.uiMode = uiMode;
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { permissionMode: msg.permissionMode, uiMode },
      });
    } else {
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { permissionMode: msg.permissionMode },
      });
    }
  }

  if (!session.cliResuming) {
    deps.broadcastToBrowsers(session, {
      type: "status_change",
      status: msg.status ?? null,
    });
    deps.onSessionActivityStateChanged(session.id, "system_status");
  }
}

function handleCompactBoundary(
  session: SystemMessageSessionLike,
  msg: CLISystemCompactBoundaryMessage,
  deps: SystemMessageDeps,
): void {
  if (session.cliResuming) return;

  const cliUuid = msg.uuid;
  const meta = msg.compact_metadata;

  if (session.backendType === "claude") {
    session.claudeCompactBoundarySeen = true;
  }
  if (deps.hasCompactBoundaryReplay(session, cliUuid, meta)) return;

  const ts = Date.now();
  const markerId = `compact-boundary-${ts}`;
  session.messageHistory.push({
    type: "compact_marker",
    timestamp: ts,
    id: markerId,
    cliUuid,
    trigger: meta?.trigger,
    preTokens: meta?.pre_tokens,
  });
  deps.freezeHistoryThroughCurrentTail(session);
  session.awaitingCompactSummary = true;
  deps.broadcastToBrowsers(session, {
    type: "compact_boundary",
    id: markerId,
    timestamp: ts,
    trigger: meta?.trigger,
    preTokens: meta?.pre_tokens,
  });
  deps.persistSession(session);
}

function handleTaskNotification(
  session: SystemMessageSessionLike,
  msg: CLISystemTaskNotificationMessage,
  deps: SystemMessageDeps,
): void {
  const browserMsg = {
    type: "task_notification" as const,
    task_id: msg.task_id,
    tool_use_id: msg.tool_use_id,
    status: msg.status,
    output_file: msg.output_file,
    summary: msg.summary,
  };
  if (msg.task_id && msg.tool_use_id && deps.hasTaskNotificationReplay(session, msg.task_id, msg.tool_use_id)) {
    return;
  }
  session.messageHistory.push(browserMsg);
  deps.broadcastToBrowsers(session, browserMsg);
  deps.persistSession(session);
}
