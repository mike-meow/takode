import { Hono } from "hono";
import { access as accessAsync } from "node:fs/promises";
import * as questStore from "../quest-store.js";
import * as sessionNames from "../session-names.js";
import { buildPeekResponse, buildPeekDefault, buildPeekRange, buildReadResponse } from "../takode-messages.js";
import type { RouteContext } from "./context.js";

export function createTakodeRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, wsBridge, authenticateTakodeCaller, resolveId } = ctx;

  const resolveReportedPermissionMode = (
    launcherMode: string | undefined,
    bridgeMode: string | null | undefined,
  ): string | null => {
    if (typeof bridgeMode === "string" && bridgeMode.trim() && bridgeMode !== "default") {
      return bridgeMode;
    }
    if (typeof launcherMode === "string" && launcherMode.trim()) {
      return launcherMode;
    }
    return bridgeMode || null;
  };

  const buildEnrichedSessions = async (filterFn?: (s: ReturnType<typeof launcher.listSessions>[number]) => boolean) => {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const bridgeStates = wsBridge.getAllSessions();
    const bridgeMap = new Map(bridgeStates.map((state) => [state.session_id, state]));
    const pool = filterFn ? sessions.filter(filterFn) : sessions;
    return Promise.all(
      pool.map(async (s) => {
        try {
          const { sessionAuthToken: _token, ...safeSession } = s;
          const bridgeSession = wsBridge.getSession(s.sessionId);
          if (bridgeSession?.state?.is_worktree && !safeSession.archived) {
            await wsBridge.refreshWorktreeGitStateForSnapshot(s.sessionId, {
              broadcastUpdate: true,
              notifyPoller: true,
            });
          }
          const bridge = wsBridge.getSession(s.sessionId)?.state ?? bridgeMap.get(s.sessionId);
          const cliConnected = wsBridge.isBackendConnected(s.sessionId);
          const effectiveState = cliConnected && bridgeSession?.isGenerating ? "running" : safeSession.state;
          return {
            ...safeSession,
            state: effectiveState,
            sessionNum: launcher.getSessionNum(s.sessionId) ?? null,
            name: names[s.sessionId] ?? s.name,
            gitBranch: bridge?.git_branch || "",
            gitDefaultBranch: bridge?.git_default_branch || "",
            diffBaseBranch: bridge?.diff_base_branch || "",
            gitAhead: bridge?.git_ahead || 0,
            gitBehind: bridge?.git_behind || 0,
            totalLinesAdded: bridge?.total_lines_added || 0,
            totalLinesRemoved: bridge?.total_lines_removed || 0,
            lastMessagePreview: wsBridge.getLastUserMessage(s.sessionId) || "",
            cliConnected,
            taskHistory: wsBridge.getSessionTaskHistory(s.sessionId),
            keywords: wsBridge.getSessionKeywords(s.sessionId),
            claimedQuestId: bridge?.claimedQuestId ?? null,
            claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
            ...(wsBridge.getSessionAttentionState(s.sessionId) ?? {}),
            ...(s.isWorktree && s.archived
              ? await (async () => {
                  let exists = false;
                  try {
                    await accessAsync(s.cwd);
                    exists = true;
                  } catch {
                    /* not found */
                  }
                  return { worktreeExists: exists };
                })()
              : {}),
          };
        } catch (e) {
          console.warn(`[routes] Failed to enrich session ${s.sessionId}:`, e);
          return { ...s, name: names[s.sessionId] ?? s.name };
        }
      }),
    );
  };

  api.get("/takode/me", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    return c.json({
      sessionId: auth.callerId,
      sessionNum: launcher.getSessionNum(auth.callerId) ?? null,
      isOrchestrator: auth.caller.isOrchestrator === true,
      state: auth.caller.state,
      backendType: auth.caller.backendType || "claude",
    });
  });

  api.get("/takode/sessions", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    const enriched = await buildEnrichedSessions();
    return c.json(enriched);
  });

  // ─── Takode: Session Info ──────────────────────────────────

  api.get("/sessions/:id/info", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const bridgeStates = wsBridge.getAllSessions();
    const bridgeSession = wsBridge.getSession(sessionId);
    if (bridgeSession?.state?.is_worktree && !session.archived) {
      await wsBridge.refreshWorktreeGitStateForSnapshot(sessionId, {
        broadcastUpdate: true,
        notifyPoller: true,
      });
    }
    const bridge =
      wsBridge.getSession(sessionId)?.state ?? bridgeStates.find((state) => state.session_id === sessionId);
    const names = sessionNames.getAllNames();
    const { sessionAuthToken: _token, ...safeSession } = session;

    return c.json({
      ...safeSession,
      sessionNum: launcher.getSessionNum(sessionId) ?? null,
      name: names[sessionId] ?? session.name ?? null,
      cliConnected: wsBridge.isBackendConnected(sessionId),
      isGenerating: wsBridge.isSessionBusy(sessionId),
      // Bridge-derived state
      gitBranch: bridge?.git_branch || null,
      gitHeadSha: bridge?.git_head_sha || null,
      gitDefaultBranch: bridge?.git_default_branch || null,
      diffBaseBranch: bridge?.diff_base_branch || null,
      gitAhead: bridge?.git_ahead || 0,
      gitBehind: bridge?.git_behind || 0,
      totalLinesAdded: bridge?.total_lines_added || 0,
      totalLinesRemoved: bridge?.total_lines_removed || 0,
      totalCostUsd: bridge?.total_cost_usd || 0,
      numTurns: bridge?.num_turns || 0,
      contextUsedPercent: bridge?.context_used_percent || 0,
      isCompacting: bridge?.is_compacting || false,
      permissionMode: resolveReportedPermissionMode(session.permissionMode, bridge?.permissionMode),
      tools: bridge?.tools || [],
      mcpServers: bridge?.mcp_servers || [],
      claudeCodeVersion: bridge?.claude_code_version || null,
      claimedQuestId: bridge?.claimedQuestId ?? null,
      claimedQuestTitle: bridge?.claimedQuestTitle ?? null,
      claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
      uiMode: bridge?.uiMode ?? null,
      ...(wsBridge.getSessionAttentionState(sessionId) ?? {}),
      taskHistory: wsBridge.getSessionTaskHistory(sessionId),
      keywords: wsBridge.getSessionKeywords(sessionId),
    });
  });

  // ─── Takode: Message Peek & Read ────────────────────────────

  api.get("/sessions/:id/messages", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const history = wsBridge.getMessageHistory(sessionId);
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const sessionNum = launcher.getSessionNum(sessionId) ?? -1;
    const sessionName = sessionNames.getName(sessionId) || sessionId.slice(0, 8);
    const cliConnected = wsBridge.isBackendConnected(sessionId);

    // Derive status: check bridge session for generation state
    const bridgeSession = wsBridge.getSession(sessionId);
    let status: "idle" | "running" | "disconnected" = "disconnected";
    if (cliConnected) {
      status = bridgeSession?.isGenerating ? "running" : "idle";
    }

    // Quest info from the bridge session state (set via quest claiming)
    const sessionState = bridgeSession?.state;
    const quest = sessionState?.claimedQuestId
      ? {
          id: sessionState.claimedQuestId,
          title: sessionState.claimedQuestTitle || "",
          status: sessionState.claimedQuestStatus || "",
        }
      : null;

    const base = { sessionId, sessionNum, sessionName, status, quest };

    // ── Mode detection ──
    const fromParam = c.req.query("from");
    const untilParam = c.req.query("until");
    const detail = c.req.query("detail") === "true";

    if (fromParam !== undefined || untilParam !== undefined) {
      // Range browsing mode: page forward from `from`, backward from `until`,
      // or browse an explicit inclusive range when both are present.
      const from = fromParam !== undefined ? parseInt(fromParam, 10) : undefined;
      const until = untilParam !== undefined ? parseInt(untilParam, 10) : undefined;
      const count = parseInt(c.req.query("count") ?? "30", 10);
      return c.json({ ...base, ...buildPeekRange(history, { from, until, count }, sessionId) });
    }

    if (detail) {
      // Detail mode: legacy full-detail behavior
      const turns = parseInt(c.req.query("turns") ?? "1", 10);
      const since = parseInt(c.req.query("since") ?? "0", 10);
      const full = c.req.query("full") === "true";
      return c.json({
        ...base,
        ...{ mode: "detail" as const, turns: buildPeekResponse(history, { turns, since, full }, sessionId) },
      });
    }

    // Default mode: smart overview (collapsed recent turns + expanded last turn)
    const collapsedCount = parseInt(c.req.query("collapsed") ?? "5", 10);
    const expandLimit = parseInt(c.req.query("expand") ?? "10", 10);
    return c.json({ ...base, ...buildPeekDefault(history, { collapsedCount, expandLimit }, sessionId) });
  });

  api.get("/sessions/:id/messages/:idx", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const idx = parseInt(c.req.param("idx"), 10);
    if (isNaN(idx)) return c.json({ error: "Invalid message index" }, 400);

    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = parseInt(c.req.query("limit") ?? "200", 10);

    const history = wsBridge.getMessageHistory(sessionId);
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const result = buildReadResponse(
      history,
      idx,
      {
        offset,
        limit,
        getToolResult: (toolUseId) => wsBridge.getToolResult(sessionId, toolUseId),
      },
      sessionId,
    );
    if (!result) {
      return c.json({ error: `Message index ${idx} out of range (0-${history.length - 1})` }, 404);
    }

    return c.json(result);
  });

  // ─── Cross-session messaging ───────────────────────────────────────

  api.post("/sessions/:id/message", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    // Allow exited/disconnected sessions (including idle-killed ones) —
    // injectUserMessage will queue the message, clear killedByIdleManager,
    // and trigger a relaunch, matching the browser chat UI behavior.
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    // Validate optional agentSource label from callers.
    let sessionLabel: string | undefined;
    if (body.agentSource && typeof body.agentSource === "object") {
      if (typeof body.agentSource.sessionId === "string" && body.agentSource.sessionId.trim()) {
        const claimed = resolveId(body.agentSource.sessionId.trim());
        if (!claimed || claimed !== auth.callerId) {
          return c.json({ error: "agentSource.sessionId does not match authenticated caller" }, 403);
        }
      }
      if (typeof body.agentSource.sessionLabel === "string" && body.agentSource.sessionLabel.trim()) {
        sessionLabel = body.agentSource.sessionLabel;
      }
    }
    const agentSource = { sessionId: auth.callerId, ...(sessionLabel ? { sessionLabel } : {}) };

    // Herd guard: if the target session is herded, only its leader can send messages.
    if (session.herdedBy) {
      if (auth.callerId !== session.herdedBy) {
        return c.json({ error: "Session is herded — only its leader can send messages" }, 403);
      }
    }
    const delivery = wsBridge.injectUserMessage(id, body.content, agentSource);
    if (delivery === "no_session") return c.json({ error: "Session not found in bridge" }, 404);
    return c.json({ ok: true, sessionId: id, delivery });
  });

  // ─── Cat herding (orchestrator→worker relationships) ──────────────

  api.post("/sessions/:id/herd", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const orch = launcher.getSession(orchId);
    if (!orch) return c.json({ error: "Orchestrator session not found" }, 404);

    // Server-side role check: only orchestrators can herd
    if (!orch.isOrchestrator) {
      return c.json({ error: "Session is not an orchestrator" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    if (!Array.isArray(body.workerIds) || body.workerIds.length === 0) {
      return c.json({ error: "workerIds array is required" }, 400);
    }
    // Resolve each worker ref (supports #N, UUID, prefix)
    const resolved: string[] = [];
    const notFound: string[] = [];
    for (const ref of body.workerIds) {
      const wid = resolveId(String(ref));
      if (wid) {
        resolved.push(wid);
      } else {
        notFound.push(String(ref));
      }
    }
    const result = launcher.herdSessions(orchId, resolved);
    return c.json({
      herded: result.herded,
      notFound: [...notFound, ...result.notFound],
      conflicts: result.conflicts,
      ...(result.leaders.length > 0 ? { leaders: result.leaders } : {}),
    });
  });

  api.delete("/sessions/:id/herd/:workerId", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const workerId = resolveId(c.req.param("workerId"));
    if (!workerId) return c.json({ error: "Worker session not found" }, 404);
    const removed = launcher.unherdSession(orchId, workerId);
    return c.json({ ok: true, removed });
  });

  api.get("/sessions/:id/herd", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const herded = launcher.getHerdedSessions(orchId);
    return c.json(
      herded.map((s) => ({
        sessionId: s.sessionId,
        sessionNum: s.sessionNum,
        name: sessionNames.getName(s.sessionId),
        state: s.state,
        cwd: s.cwd,
        backendType: s.backendType,
        cliConnected: wsBridge.isBackendConnected(s.sessionId),
        isOrchestrator: s.isOrchestrator,
        herdedBy: s.herdedBy,
      })),
    );
  });

  // ─── Leader answer (resolve AskUserQuestion / ExitPlanMode) ─────────

  /** Answerable tool names — tool permissions (can_use_tool) are human-only */
  const ANSWERABLE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

  api.get("/sessions/:id/pending", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (workerInfo.herdedBy !== auth.callerId) {
      return c.json({ error: "Only the leader who herded this session can view pending prompts" }, 403);
    }
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const pending = [];
    for (const [, perm] of session.pendingPermissions) {
      if (!ANSWERABLE_TOOLS.has(perm.tool_name)) continue;
      // Find the message index in history so the leader can `takode read <session> <idx>`
      let msg_index: number | undefined;
      for (let i = session.messageHistory.length - 1; i >= 0; i--) {
        const entry = session.messageHistory[i] as { type?: string; request?: { request_id?: string } };
        if (entry.type === "permission_request" && entry.request?.request_id === perm.request_id) {
          msg_index = i;
          break;
        }
      }
      pending.push({
        request_id: perm.request_id,
        tool_name: perm.tool_name,
        timestamp: perm.timestamp,
        ...(msg_index !== undefined ? { msg_index } : {}),
        ...(perm.tool_name === "AskUserQuestion" ? { questions: perm.input.questions } : {}),
        ...(perm.tool_name === "ExitPlanMode"
          ? { plan: perm.input.plan, allowedPrompts: perm.input.allowedPrompts }
          : {}),
      });
    }
    return c.json({ pending });
  });

  api.post("/sessions/:id/answer", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const response = typeof body.response === "string" ? body.response : "";
    if (
      typeof body.callerSessionId === "string" &&
      body.callerSessionId.trim() &&
      body.callerSessionId.trim() !== auth.callerId
    ) {
      return c.json({ error: "callerSessionId does not match authenticated caller" }, 403);
    }
    const callerSessionId = auth.callerId;

    // Herd guard: only the leader can answer
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (!callerSessionId || workerInfo.herdedBy !== callerSessionId) {
      return c.json({ error: "Only the leader who herded this session can answer" }, 403);
    }

    // Find the first answerable pending permission
    let target: { request_id: string; tool_name: string; input: Record<string, unknown> } | null = null;
    for (const [, perm] of session.pendingPermissions) {
      if (ANSWERABLE_TOOLS.has(perm.tool_name)) {
        target = perm;
        break;
      }
    }
    if (!target) return c.json({ error: "No pending question or plan to answer" }, 404);

    // Build the permission_response based on tool type
    if (target.tool_name === "AskUserQuestion") {
      // Parse response: number = pick option, otherwise free text
      const questions = target.input.questions as Array<{ options?: Array<{ label: string }> }> | undefined;
      const optIdx = parseInt(response, 10);
      let answerValue: string;
      if (!isNaN(optIdx) && questions?.[0]?.options && optIdx >= 1 && optIdx <= questions[0].options.length) {
        answerValue = questions[0].options[optIdx - 1].label; // 1-indexed
      } else {
        answerValue = response; // free text
      }

      wsBridge.routeExternalPermissionResponse(session, {
        type: "permission_response",
        request_id: target.request_id,
        behavior: "allow",
        updated_input: { ...target.input, answers: { "0": answerValue } },
      });
      return c.json({ ok: true, tool_name: target.tool_name, answer: answerValue });
    }

    if (target.tool_name === "ExitPlanMode") {
      const isApprove = response.toLowerCase().startsWith("approve");
      if (isApprove) {
        wsBridge.routeExternalPermissionResponse(session, {
          type: "permission_response",
          request_id: target.request_id,
          behavior: "allow",
          updated_input: target.input,
        });
        return c.json({ ok: true, tool_name: target.tool_name, action: "approved" });
      } else {
        // "reject" or "reject: feedback text"
        const feedback = response.replace(/^reject:?\s*/i, "").trim() || "Rejected by leader";
        wsBridge.routeExternalPermissionResponse(session, {
          type: "permission_response",
          request_id: target.request_id,
          behavior: "deny",
          message: feedback,
        });
        return c.json({ ok: true, tool_name: target.tool_name, action: "rejected", feedback });
      }
    }

    return c.json({ error: "Unsupported tool type" }, 400);
  });

  // ─── Herd diagnostics ────────────────────────────────────────────────

  api.get("/sessions/:id/herd-diagnostics", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);

    const bridgeDiag = wsBridge.getHerdDiagnostics(id);
    const herded = info.isOrchestrator ? launcher.getHerdedSessions(id) : [];

    return c.json({
      sessionId: id,
      sessionNum: info.sessionNum,
      isOrchestrator: info.isOrchestrator || false,
      herdedBy: info.herdedBy,
      herdedWorkers: herded.map((s) => ({
        sessionId: s.sessionId,
        sessionNum: s.sessionNum,
        name: sessionNames.getName(s.sessionId),
        state: s.state,
        cliConnected: wsBridge.isBackendConnected(s.sessionId),
      })),
      ...(bridgeDiag || {}),
    });
  });

  // ─── Branch management ─────────────────────────────────────────────

  /**
   * Trigger a git info refresh for the caller's own session.
   * Agents call this after git checkout / branch / rebase so the server
   * picks up the new HEAD and recomputes ahead/behind stats.
   */
  api.post("/sessions/:id/refresh-branch", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    await wsBridge.refreshGitInfoPublic(id, { broadcastUpdate: true, notifyPoller: true, force: true });

    const state = wsBridge.getSession(id)?.state;
    return c.json({
      ok: true,
      gitBranch: state?.git_branch || null,
      gitDefaultBranch: state?.git_default_branch || null,
      diffBaseBranch: state?.diff_base_branch || null,
      gitAhead: state?.git_ahead || 0,
      gitBehind: state?.git_behind || 0,
    });
  });

  /**
   * Get branch info for the caller's session.
   * Returns current branch, base branch, default branch, HEAD SHA, and ahead/behind counts.
   */
  api.get("/sessions/:id/branch/status", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const state = session.state;
    return c.json({
      ok: true,
      gitBranch: state.git_branch || null,
      diffBaseBranch: state.diff_base_branch || null,
      gitDefaultBranch: state.git_default_branch || null,
      gitHeadSha: state.git_head_sha || null,
      gitAhead: state.git_ahead || 0,
      gitBehind: state.git_behind || 0,
      totalLinesAdded: state.total_lines_added || 0,
      totalLinesRemoved: state.total_lines_removed || 0,
      isWorktree: state.is_worktree || false,
    });
  });

  /**
   * Set the diff base branch for the caller's session.
   * This is the same operation as changing it in the DiffPanel UI.
   */
  api.post("/sessions/:id/branch/set-base", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const body = await c.req.json<{ branch?: string }>().catch(() => ({}) as { branch?: string });
    const branch = body.branch?.trim();
    if (!branch) return c.json({ error: "Missing 'branch' parameter" }, 400);
    if (branch.length > 255) return c.json({ error: "Branch name too long (max 255)" }, 400);

    const success = wsBridge.setDiffBaseBranch(id, branch);
    if (!success) return c.json({ error: "Failed to set base branch" }, 500);

    const state = wsBridge.getSession(id)?.state;
    return c.json({
      ok: true,
      diffBaseBranch: state?.diff_base_branch || null,
      gitBranch: state?.git_branch || null,
      gitAhead: state?.git_ahead || 0,
      gitBehind: state?.git_behind || 0,
    });
  });

  return api;
}
