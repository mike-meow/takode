import { sessionTag } from "../session-tag.js";

export interface ClaudeSdkAdapterLifecycleDeps {
  getOrCreateSession: (sessionId: string, backendType: "claude-sdk") => any;
  getLauncherSessionInfo: (sessionId: string) => any;
  onOrchestratorTurnEnd: (sessionId: string) => void;
  touchActivity: (sessionId: string) => void;
  clearOptimisticRunningTimer: (session: any, reason: string) => void;
  hasPendingForceCompact: (session: any) => boolean;
  broadcastToBrowsers: (session: any, msg: Record<string, unknown>) => void;
  handleToolResultMessage: (session: any, msg: any) => void;
  refreshGitInfoThenRecomputeDiff: (session: any, options: { notifyPoller: boolean }) => void;
  persistSession: (session: any) => void;
  handleSdkPermissionRequest: (session: any, request: any) => Promise<void> | void;
  handleAssistantMessage: (session: any, msg: any) => void;
  handleResultMessage: (session: any, msg: any) => void;
  hasTaskNotificationReplay: (session: any, taskId: string, toolUseId: string) => boolean;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  freezeHistoryThroughCurrentTail: (session: any) => void;
  injectCompactionRecovery: (session: any) => void;
  hasCompactBoundaryReplay: (session: any, cliUuid: string | undefined, meta: unknown) => boolean;
  setCliSessionId: (sessionId: string, cliSessionId: string) => void;
  markTurnInterrupted: (session: any, source: "user" | "leader" | "system") => void;
  setGenerating: (session: any, generating: boolean, reason: string) => void;
  requestCliRelaunch?: (sessionId: string) => void;
  isCurrentSession: (sessionId: string, session: any) => boolean;
  maxAdapterRelaunchFailures: number;
  adapterFailureResetWindowMs: number;
}

export function attachClaudeSdkAdapterLifecycle(sessionId: string, adapter: any, deps: ClaudeSdkAdapterLifecycleDeps): void {
  const session = deps.getOrCreateSession(sessionId, "claude-sdk");
  session.backendType = "claude-sdk";
  session.state.backend_type = "claude-sdk";
  if (session.claudeSdkAdapter && session.claudeSdkAdapter !== adapter) {
    const pendingAware = session.claudeSdkAdapter as any;
    if (typeof pendingAware.drainPendingOutgoing === "function") {
      for (const queuedMsg of pendingAware.drainPendingOutgoing()) {
        const raw = JSON.stringify(queuedMsg);
        const alreadyQueued = session.pendingMessages.some((queued: string) => queued === raw);
        if (!alreadyQueued) {
          session.pendingMessages.push(raw);
        }
      }
    }
    session.claudeSdkAdapter.disconnect().catch(() => {});
  }
  const launcherInfo = deps.getLauncherSessionInfo(sessionId);
  if (launcherInfo?.isWorktree) {
    session.state.is_worktree = true;
    if (launcherInfo.repoRoot) session.state.repo_root = launcherInfo.repoRoot;
  }
  if (launcherInfo?.model && !session.state.model) {
    session.state.model = launcherInfo.model;
  }
  session.claudeSdkAdapter = adapter;
  session.cliInitReceived = true;

  if (!!launcherInfo?.cliSessionId && session.messageHistory.length > 0) {
    if (session.cliResumingClearTimer) {
      clearTimeout(session.cliResumingClearTimer);
      session.cliResumingClearTimer = null;
    }
    session.cliResuming = true;
  }

  if (!session.cliResuming && session.pendingMessages.length > 0) {
    console.log(
      `[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) on SDK adapter attach for session ${sessionTag(sessionId)}`,
    );
    const queued = session.pendingMessages.splice(0);
    for (const raw of queued) {
      try {
        adapter.sendBrowserMessage(JSON.parse(raw));
      } catch {
        console.warn(
          `[ws-bridge] Skipping corrupt queued message for session ${sessionTag(sessionId)}: ${raw.substring(0, 80)}`,
        );
      }
    }
  }

  if (!session.cliResuming) {
    const orchInfo = deps.getLauncherSessionInfo(session.id);
    if (orchInfo?.isOrchestrator) {
      deps.onOrchestratorTurnEnd(session.id);
    }
  }

  adapter.onBrowserMessage((msg: any) => {
    deps.touchActivity(session.id);
    session.lastCliMessageAt = Date.now();
    deps.clearOptimisticRunningTimer(session, `sdk_output:${msg.type}`);

    if (session.cliResuming) {
      if (session.cliResumingClearTimer) clearTimeout(session.cliResumingClearTimer);
      session.cliResumingClearTimer = setTimeout(() => {
        session.cliResumingClearTimer = null;
        session.cliResuming = false;
        console.log(`[ws-bridge] cliResuming cleared for SDK session ${sessionTag(session.id)} — replay done`);
        const compactPending = deps.hasPendingForceCompact(session);
        session.forceCompactPending = compactPending;
        session.state.is_compacting = compactPending;
        session.awaitingCompactSummary = false;
        session.compactedDuringTurn = false;
        if (compactPending) {
          deps.broadcastToBrowsers(session, { type: "status_change", status: "compacting" });
        }
        if (session.pendingMessages.length > 0) {
          console.log(
            `[ws-bridge] Flushing ${session.pendingMessages.length} deferred message(s) after SDK replay done for session ${sessionTag(session.id)}`,
          );
          const queued = session.pendingMessages.splice(0);
          for (const raw of queued) {
            try {
              adapter.sendBrowserMessage(JSON.parse(raw));
            } catch {
              console.warn(
                `[ws-bridge] Skipping corrupt deferred message for session ${sessionTag(session.id)}: ${raw.substring(0, 80)}`,
              );
            }
          }
        }
        const launcherInfoAfterReplay = deps.getLauncherSessionInfo(session.id);
        if (launcherInfoAfterReplay?.isOrchestrator) {
          deps.onOrchestratorTurnEnd(session.id);
        }
      }, 2000);
    }

    if (msg.type === "result") {
      session.consecutiveAdapterFailures = 0;
      session.lastAdapterFailureAt = null;
      if (session.queuedTurnStarts > 0) {
        console.log(
          `[ws-bridge] Draining ${session.queuedTurnStarts} queued turn(s) for SDK session ${sessionTag(session.id)} — CLI already processed them inline`,
        );
        session.queuedTurnStarts = 0;
        session.queuedTurnReasons = [];
        session.queuedTurnUserMessageIds = [];
        session.queuedTurnInterruptSources = [];
      }
    }

    if ((msg as any).type === "user") {
      deps.handleToolResultMessage(session, msg as any);
    }

    if (msg.type === "session_init") {
      const initMsg = msg as any;
      if (initMsg.session) {
        const companionSessionId = session.state.session_id;
        const launchCwd = session.state.cwd;
        const launchPermissionMode = session.state.permissionMode;
        session.state = { ...session.state, ...initMsg.session, backend_type: "claude-sdk" };
        session.state.session_id = companionSessionId;
        if (launchCwd) {
          session.state.cwd = launchCwd;
        }
        if (launchPermissionMode) {
          session.state.permissionMode = launchPermissionMode;
        }
        if (session.state.permissionMode) {
          session.state.uiMode = session.state.permissionMode === "plan" ? "plan" : "agent";
        }
        initMsg.session = { ...initMsg.session, session_id: companionSessionId, backend_type: "claude-sdk" };
        if (launchCwd) {
          initMsg.session.cwd = launchCwd;
        }
        if (launchPermissionMode) {
          initMsg.session.permissionMode = launchPermissionMode;
        }
        if (session.state.uiMode) {
          initMsg.session.uiMode = session.state.uiMode;
        }
      }
      session.cliInitReceived = true;
      deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
      deps.persistSession(session);
      const launcherInfoAfterInit = deps.getLauncherSessionInfo(session.id);
      if (launcherInfoAfterInit?.isOrchestrator) {
        deps.onOrchestratorTurnEnd(session.id);
      }
    }

    if (msg.type === "permission_request") {
      const maybe = deps.handleSdkPermissionRequest(session, (msg as any).request);
      if (maybe instanceof Promise) {
        void maybe.catch((err) => {
          console.error(`[ws-bridge] SDK auto-approval error for session ${sessionTag(session.id)}:`, err);
        });
      }
      return;
    }

    if (msg.type === "assistant") {
      deps.handleAssistantMessage(session, msg);
      return;
    }

    if (msg.type === "result") {
      deps.handleResultMessage(session, (msg as any).data ?? (msg as any));
      return;
    }

    if (msg.type === "task_notification") {
      const taskMsg = msg as any;
      if (
        taskMsg.task_id &&
        taskMsg.tool_use_id &&
        deps.hasTaskNotificationReplay(session, taskMsg.task_id, taskMsg.tool_use_id)
      ) {
        return;
      }
      session.messageHistory.push(msg);
      deps.broadcastToBrowsers(session, msg);
      deps.persistSession(session);
      return;
    }

    if (msg.type === "status_change") {
      const newStatus = (msg as any).status;
      const wasCompacting = session.state.is_compacting;
      const forceCompactPending = session.forceCompactPending;
      session.state.is_compacting = newStatus === "compacting";
      const enteringCompacting = newStatus === "compacting" && (!wasCompacting || forceCompactPending);
      if (newStatus === "compacting") {
        session.forceCompactPending = false;
      }

      if (enteringCompacting && !session.cliResuming) {
        session.compactedDuringTurn = true;
        deps.emitTakodeEvent(session.id, "compaction_started", {
          ...(typeof session.state.context_used_percent === "number"
            ? { context_used_percent: session.state.context_used_percent }
            : {}),
        });
        const ts = Date.now();
        const markerId = `compact-boundary-${ts}`;
        session.messageHistory.push({
          type: "compact_marker",
          timestamp: ts,
          id: markerId,
        });
        deps.freezeHistoryThroughCurrentTail(session);
        session.awaitingCompactSummary = true;
        deps.broadcastToBrowsers(session, {
          type: "compact_boundary",
          id: markerId,
          timestamp: ts,
        });
      }
      if (wasCompacting && newStatus !== "compacting" && !session.cliResuming) {
        deps.emitTakodeEvent(session.id, "compaction_finished", {
          ...(typeof session.state.context_used_percent === "number"
            ? { context_used_percent: session.state.context_used_percent }
            : {}),
        });
        deps.injectCompactionRecovery(session);
      }
      deps.persistSession(session);
      if (session.cliResuming) return;
    }

    if ((msg as any).type === "system" && (msg as any).subtype === "compact_boundary") {
      if (session.cliResuming) return;
      const cliUuid = (msg as any).uuid;
      const meta = (msg as any).compact_metadata;
      if (deps.hasCompactBoundaryReplay(session, cliUuid, meta)) return;
      const existingMarker = session.messageHistory.findLast((message: any) => message.type === "compact_marker");
      if (existingMarker && existingMarker.type === "compact_marker" && !existingMarker.cliUuid) {
        existingMarker.cliUuid = cliUuid;
        existingMarker.trigger = meta?.trigger;
        existingMarker.preTokens = meta?.pre_tokens;
        deps.persistSession(session);
        return;
      }
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
      session.compactedDuringTurn = true;
      deps.broadcastToBrowsers(session, {
        type: "compact_boundary",
        id: markerId,
        timestamp: ts,
        trigger: meta?.trigger,
        preTokens: meta?.pre_tokens,
      });
      deps.persistSession(session);
      return;
    }

    if ((msg as any).type === "user" && session.awaitingCompactSummary && !session.cliResuming) {
      const content = (msg as any).message?.content;
      let summaryText: string | undefined;
      if (typeof content === "string" && content.length > 0) {
        summaryText = content;
      } else if (Array.isArray(content)) {
        const textBlock = content.find((block: any) => block.type === "text") as { text: string } | undefined;
        summaryText = textBlock?.text;
      }
      if (summaryText) {
        session.awaitingCompactSummary = false;
        const marker = session.messageHistory.findLast((message: any) => message.type === "compact_marker");
        if (marker && marker.type === "compact_marker") {
          marker.summary = summaryText;
        }
        deps.broadcastToBrowsers(session, { type: "compact_summary", summary: summaryText });
        deps.persistSession(session);
      } else {
        session.awaitingCompactSummary = false;
      }
    }

    deps.broadcastToBrowsers(session, msg);
  });

  adapter.onSessionMeta((meta: any) => {
    if (meta.cliSessionId) {
      deps.setCliSessionId(sessionId, meta.cliSessionId);
    }
    if (meta.model) session.state.model = meta.model;
  });

  adapter.onDisconnect(() => {
    const idleKilled = deps.getLauncherSessionInfo(sessionId)?.killedByIdleManager;
    const now = Date.now();
    if (session.lastAdapterFailureAt !== null && now - session.lastAdapterFailureAt > deps.adapterFailureResetWindowMs) {
      session.consecutiveAdapterFailures = 0;
    }
    session.lastAdapterFailureAt = now;
    session.consecutiveAdapterFailures++;
    console.log(
      `[ws-bridge] Claude SDK adapter disconnected for session ${sessionTag(sessionId)}${idleKilled ? " (idle limit)" : ""} (consecutive failures: ${session.consecutiveAdapterFailures})`,
    );
    session.claudeSdkAdapter = null;
    session.cliInitReceived = false;
    deps.markTurnInterrupted(session, "system");
    deps.setGenerating(session, false, "sdk_disconnect");
    deps.broadcastToBrowsers(session, {
      type: "backend_disconnected",
      ...(idleKilled ? { reason: "idle_limit" } : {}),
    });
    deps.broadcastToBrowsers(session, { type: "status_change", status: "idle" });

    if (
      !idleKilled &&
      deps.requestCliRelaunch &&
      session.browserSockets.size > 0 &&
      deps.isCurrentSession(sessionId, session) &&
      session.consecutiveAdapterFailures <= deps.maxAdapterRelaunchFailures
    ) {
      console.log(
        `[ws-bridge] SDK adapter disconnected for active browser; requesting relaunch for session ${sessionTag(sessionId)} (attempt ${session.consecutiveAdapterFailures}/${deps.maxAdapterRelaunchFailures})`,
      );
      deps.requestCliRelaunch(sessionId);
    } else if (session.consecutiveAdapterFailures > deps.maxAdapterRelaunchFailures) {
      console.error(
        `[ws-bridge] SDK adapter for session ${sessionTag(sessionId)} exceeded ${deps.maxAdapterRelaunchFailures} consecutive failures — stopping auto-relaunch`,
      );
      deps.broadcastToBrowsers(session, {
        type: "error",
        message: `Session stopped after ${deps.maxAdapterRelaunchFailures} consecutive launch failures. Use the relaunch button to try again.`,
      });
    }
  });

  adapter.onInitError((error: string) => {
    console.error(`[ws-bridge] Claude SDK adapter init failed for session ${sessionTag(sessionId)}: ${error}`);
    session.claudeSdkAdapter = null;
    deps.setGenerating(session, false, "sdk_init_error");
    deps.broadcastToBrowsers(session, { type: "backend_disconnected" });
    deps.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
  });

  deps.broadcastToBrowsers(session, { type: "backend_connected" });
  console.log(`[ws-bridge] Claude SDK adapter attached for session ${sessionTag(sessionId)}`);
}
