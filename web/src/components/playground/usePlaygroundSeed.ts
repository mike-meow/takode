import { useEffect } from "react";
import { useStore } from "../../store.js";
import type { SessionState } from "../../types.js";
import {
  MOCK_SESSION_ID,
  PLAYGROUND_BROKEN_SESSION_ID,
  PLAYGROUND_CODEX_PENDING_SESSION_ID,
  PLAYGROUND_CODEX_TERMINAL_SESSION_ID,
  PLAYGROUND_LOADING_SESSION_ID,
  PLAYGROUND_RECOVERING_SESSION_ID,
  PLAYGROUND_RESUMING_SESSION_ID,
  PLAYGROUND_SECTIONED_SESSION_ID,
  PLAYGROUND_STARTING_SESSION_ID,
  PLAYGROUND_THREAD_PANEL_SESSION_ID,
  MSG_ASSISTANT,
  MSG_ASSISTANT_TOOLS,
  MSG_TOOL_ERROR,
  MSG_USER,
  PERM_BASH,
  PERM_DYNAMIC,
  makePlaygroundMessage,
  makePlaygroundSectionedMessages,
} from "./fixtures.js";

export function usePlaygroundSeed() {
  useEffect(() => {
    const store = useStore.getState();
    const snapshot = useStore.getState();
    const sessionId = MOCK_SESSION_ID;
    const questInProgressId = "quest-in-progress";
    const questVerificationId = "quest-needs-verification";
    const demoSessionIds = [
      sessionId,
      PLAYGROUND_SECTIONED_SESSION_ID,
      PLAYGROUND_LOADING_SESSION_ID,
      PLAYGROUND_CODEX_TERMINAL_SESSION_ID,
      PLAYGROUND_CODEX_PENDING_SESSION_ID,
      PLAYGROUND_STARTING_SESSION_ID,
      PLAYGROUND_RESUMING_SESSION_ID,
      PLAYGROUND_BROKEN_SESSION_ID,
      PLAYGROUND_THREAD_PANEL_SESSION_ID,
      questInProgressId,
      questVerificationId,
    ];
    const prevSessions = new Map(demoSessionIds.map((id) => [id, snapshot.sessions.get(id)]));
    const prevMessages = new Map(demoSessionIds.map((id) => [id, snapshot.messages.get(id)]));
    const prevPerms = new Map(demoSessionIds.map((id) => [id, snapshot.pendingPermissions.get(id)]));
    const prevConn = new Map(demoSessionIds.map((id) => [id, snapshot.connectionStatus.get(id)]));
    const prevCli = new Map(demoSessionIds.map((id) => [id, snapshot.cliConnected.get(id)]));
    const prevCliEver = new Map(demoSessionIds.map((id) => [id, snapshot.cliEverConnected.get(id)]));
    const prevCliDisconnectReason = new Map(demoSessionIds.map((id) => [id, snapshot.cliDisconnectReason.get(id)]));
    const prevStatus = new Map(demoSessionIds.map((id) => [id, snapshot.sessionStatus.get(id)]));
    const prevStreaming = new Map(demoSessionIds.map((id) => [id, snapshot.streaming.get(id)]));
    const prevStreamingStartedAt = new Map(demoSessionIds.map((id) => [id, snapshot.streamingStartedAt.get(id)]));
    const prevStreamingOutputTokens = new Map(demoSessionIds.map((id) => [id, snapshot.streamingOutputTokens.get(id)]));
    const prevFeedScrollPositions = new Map(demoSessionIds.map((id) => [id, snapshot.feedScrollPosition.get(id)]));
    const prevHistoryLoading = new Map(demoSessionIds.map((id) => [id, snapshot.historyLoading.get(id)]));
    const prevSessionBoards = new Map(demoSessionIds.map((id) => [id, snapshot.sessionBoards.get(id)]));
    const prevPendingCodexInputs = new Map(demoSessionIds.map((id) => [id, snapshot.pendingCodexInputs.get(id)]));
    const prevToolProgress = new Map(demoSessionIds.map((id) => [id, snapshot.toolProgress.get(id)]));
    const prevToolResults = new Map(demoSessionIds.map((id) => [id, snapshot.toolResults.get(id)]));
    const prevToolStartTimestamps = new Map(demoSessionIds.map((id) => [id, snapshot.toolStartTimestamps.get(id)]));
    const prevQuestNamed = new Map([
      [questInProgressId, snapshot.questNamedSessions.has(questInProgressId)],
      [questVerificationId, snapshot.questNamedSessions.has(questVerificationId)],
    ]);
    const sidebarTimerDemoIds = ["leader-alpha"];
    const prevSessionTimers = new Map(sidebarTimerDemoIds.map((id) => [id, snapshot.sessionTimers.get(id)]));

    const session: SessionState = {
      session_id: sessionId,
      backend_type: "claude",
      model: "claude-sonnet-4-5",
      cwd: "/Users/stan/Dev/project",
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebSearch"],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: ["explain", "review", "fix"],
      skills: ["doc-coauthoring", "frontend-design"],
      total_cost_usd: 0.1847,
      num_turns: 14,
      context_used_percent: 62,
      is_compacting: false,
      git_branch: "feat/jwt-auth",
      is_worktree: false,
      is_containerized: true,
      repo_root: "/Users/stan/Dev/project",
      git_ahead: 3,
      git_behind: 0,
      total_lines_added: 142,
      total_lines_removed: 38,
    };

    store.addSession(session);
    store.setConnectionStatus(sessionId, "connected");
    store.setCliConnected(sessionId, true);
    store.setSessionStatus(sessionId, "running");
    store.setMessages(sessionId, [MSG_USER, MSG_ASSISTANT, MSG_ASSISTANT_TOOLS, MSG_TOOL_ERROR]);
    store.setStreaming(sessionId, "I'm updating tests and then I'll run the full suite.");
    store.setStreamingStats(sessionId, { startedAt: Date.now() - 12000, outputTokens: 1200 });
    store.addPermission(sessionId, PERM_BASH);
    store.addPermission(sessionId, PERM_DYNAMIC);

    const sectionedSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_SECTIONED_SESSION_ID,
      cwd: "/Users/stan/Dev/project/long-session",
      num_turns: 200,
      is_containerized: false,
    };
    store.addSession(sectionedSession);
    store.setConnectionStatus(PLAYGROUND_SECTIONED_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_SECTIONED_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_SECTIONED_SESSION_ID, "idle");
    store.setMessages(PLAYGROUND_SECTIONED_SESSION_ID, makePlaygroundSectionedMessages(4));
    store.setFeedScrollPosition(PLAYGROUND_SECTIONED_SESSION_ID, {
      scrollTop: 240,
      scrollHeight: 1600,
      isAtBottom: false,
      anchorTurnId: "playground-section-u1",
      anchorOffsetTop: 0,
    });

    const loadingSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_LOADING_SESSION_ID,
      cwd: "/Users/stan/Dev/project/cold-session",
      num_turns: 86,
      is_containerized: false,
    };
    store.addSession(loadingSession);
    store.setConnectionStatus(PLAYGROUND_LOADING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_LOADING_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_LOADING_SESSION_ID, "idle");
    store.setHistoryLoading(PLAYGROUND_LOADING_SESSION_ID, true);

    const threadPanelSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_THREAD_PANEL_SESSION_ID,
      backend_type: "codex",
      model: "gpt-5.5",
      cwd: "/Users/stan/Dev/takode/thread-panel",
      is_containerized: false,
      isOrchestrator: true,
    };
    store.addSession(threadPanelSession);
    store.setConnectionStatus(PLAYGROUND_THREAD_PANEL_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_THREAD_PANEL_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_THREAD_PANEL_SESSION_ID, "idle");
    store.setMessages(PLAYGROUND_THREAD_PANEL_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-thread-main",
        role: "user",
        content: "Coordinate the active Journey board.",
        timestamp: Date.now() - 180_000,
      }),
      makePlaygroundMessage({
        id: "playground-thread-q961",
        role: "assistant",
        content: "Implementation is underway.",
        timestamp: Date.now() - 120_000,
        metadata: { threadRefs: [{ threadKey: "q-961", questId: "q-961", source: "explicit" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q962",
        role: "assistant",
        content: "Queued until the dependency finishes.",
        timestamp: Date.now() - 90_000,
        metadata: { threadRefs: [{ threadKey: "q-962", questId: "q-962", source: "explicit" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q963",
        role: "assistant",
        content: "Waiting for a free worker before dispatch.",
        timestamp: Date.now() - 60_000,
        metadata: { threadRefs: [{ threadKey: "q-963", questId: "q-963", source: "explicit" }] },
      }),
    ]);
    store.setSessionBoard(PLAYGROUND_THREAD_PANEL_SESSION_ID, [
      {
        questId: "q-961",
        title: "Finish data-flow cleanup",
        status: "IMPLEMENTING",
        updatedAt: Date.now() - 120_000,
        createdAt: Date.now() - 240_000,
        journey: { mode: "active", phaseIds: ["alignment", "implement", "code-review"], currentPhaseId: "implement" },
      },
      {
        questId: "q-962",
        title: "Add queued thread wait chip",
        status: "QUEUED",
        waitFor: ["q-961"],
        updatedAt: Date.now() - 90_000,
        createdAt: Date.now() - 210_000,
        journey: { mode: "active", phaseIds: ["alignment", "implement", "code-review"] },
      },
      {
        questId: "q-963",
        title: "Dispatch follow-up worker",
        status: "QUEUED",
        waitFor: ["free-worker"],
        updatedAt: Date.now() - 60_000,
        createdAt: Date.now() - 180_000,
        journey: { mode: "active", phaseIds: ["alignment", "implement", "code-review"] },
      },
    ]);

    const codexTerminalSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_CODEX_TERMINAL_SESSION_ID,
      backend_type: "codex",
      model: "gpt-5.3-codex",
      cwd: "/Users/stan/Dev/project/codex-live-terminal",
      is_containerized: false,
      skill_metadata: [
        {
          name: "doc-coauthoring",
          path: "/Users/stan/.codex/skills/doc-coauthoring/SKILL.md",
          description: "Draft and edit design docs",
        },
        {
          name: "frontend-design",
          path: "/Users/stan/.codex/skills/frontend-design/SKILL.md",
          description: "Polish React UI states",
        },
      ],
      apps: [
        {
          id: "connector_google_drive",
          name: "Google Drive",
          description: "Search and edit Drive files",
        },
        {
          id: "connector_slack",
          name: "Slack",
          description: "Read and draft Slack updates",
        },
      ],
    };
    store.addSession(codexTerminalSession);
    store.setConnectionStatus(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "running");
    store.setMessages(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, [
      {
        id: "playground-codex-terminal-user",
        role: "user",
        content: "Run the flaky test shard and tell me why it stalls.",
        timestamp: Date.now() - 60_000,
      },
      {
        id: "playground-codex-terminal-bash",
        role: "assistant",
        content: "",
        timestamp: Date.now() - 55_000,
        model: "gpt-5.3-codex",
        contentBlocks: [
          {
            type: "tool_use",
            id: "playground-codex-live-bash",
            name: "Bash",
            input: {
              command: "bun test src/session/ws-bridge.test.ts --runInBand --reporter=verbose",
            },
          },
        ],
      },
      {
        id: "playground-codex-terminal-bash-complete",
        role: "assistant",
        content: "",
        timestamp: Date.now() - 25_000,
        model: "gpt-5.3-codex",
        contentBlocks: [
          {
            type: "tool_use",
            id: "playground-codex-complete-bash",
            name: "Bash",
            input: {
              command: "find src -name '*.test.ts' -maxdepth 3",
            },
          },
        ],
      },
    ]);
    store.setToolStartTimestamps(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, {
      "playground-codex-live-bash": Date.now() - 49_000,
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-live-bash", {
      toolName: "Bash",
      elapsedSeconds: 49,
      outputDelta: "RUN  src/session/ws-bridge.test.ts\n",
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-live-bash", {
      toolName: "Bash",
      elapsedSeconds: 50,
      outputDelta: "  ✓ keeps tool_result_preview tails idempotent\n",
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-live-bash", {
      toolName: "Bash",
      elapsedSeconds: 51,
      outputDelta: "  ... waiting on ws reconnect watchdog case ...\n",
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-complete-bash", {
      toolName: "Bash",
      elapsedSeconds: 14,
      outputDelta: "src/components/MessageFeed.test.tsx\nsrc/components/ToolBlock.test.tsx\n",
    });
    store.setToolResult(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-complete-bash", {
      tool_use_id: "playground-codex-complete-bash",
      content: "Terminal command completed, but no output was captured.",
      is_error: false,
      total_size: 53,
      is_truncated: false,
      duration_seconds: 14.1,
    });

    store.addSession({
      ...session,
      session_id: PLAYGROUND_CODEX_PENDING_SESSION_ID,
      backend_type: "codex",
      backend_state: "connected",
      backend_error: null,
      model: "gpt-5.4",
      num_turns: 3,
      context_used_percent: 38,
    });
    store.setConnectionStatus(PLAYGROUND_CODEX_PENDING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_CODEX_PENDING_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_CODEX_PENDING_SESSION_ID, "running");
    store.setMessages(PLAYGROUND_CODEX_PENDING_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-codex-pending-user",
        role: "user",
        content: "Inspect the auth flow and summarize what is broken.",
      }),
      makePlaygroundMessage({
        id: "playground-codex-pending-assistant",
        role: "assistant",
        content: "Searching the auth pipeline now.",
      }),
    ]);
    store.setPendingCodexInputs(PLAYGROUND_CODEX_PENDING_SESSION_ID, [
      {
        id: "playground-pending-codex-1",
        content: "Also check whether refresh-token rotation races with logout.",
        timestamp: Date.now(),
        cancelable: true,
        draftImages: [],
      },
      {
        id: "playground-pending-codex-2",
        content: "If you find a race, propose the smallest safe fix first.",
        timestamp: Date.now() + 1,
        cancelable: false,
        draftImages: [],
      },
    ]);

    // Mock tool results for ToolResultSection demo
    store.setToolResult(sessionId, "tu-1", {
      tool_use_id: "tu-1",
      content: "src/auth/middleware.ts\nsrc/auth/login.ts\nsrc/auth/session.ts",
      is_error: false,
      total_size: 58,
      is_truncated: false,
      duration_seconds: 0.3,
    });
    store.setToolResult(sessionId, "tu-2", {
      tool_use_id: "tu-2",
      content:
        'export function authMiddleware(req, res, next) {\n  if (!req.session.userId) {\n    return res.status(401).json({ error: "Unauthorized" });\n  }\n  next();\n}',
      is_error: false,
      total_size: 156,
      is_truncated: false,
      duration_seconds: 0.1,
    });
    store.setToolResult(sessionId, "tu-3", {
      tool_use_id: "tu-3",
      content: "FAIL src/auth/__tests__/middleware.test.ts\n  \u25CF Auth Middleware \u203A should reject expired toke",
      is_error: true,
      total_size: 185,
      is_truncated: false,
      duration_seconds: 12.4,
    });

    // Mock tool results with durations for standalone ToolBlock demos
    const toolDurations: Record<string, number> = {
      "tb-1": 3.2,
      "tb-2": 0.1,
      "tb-3": 0.4,
      "tb-4": 0.2,
      "tb-5": 0.8,
      "tb-6": 1.5,
      "tb-7": 2.1,
      "tb-8": 4.7,
      "tb-10": 0.0,
      "tb-11": 0.3,
      "tb-12": 0.1,
      "tb-14": 0.0,
      "tb-15": 0.0,
      "tb-image-lightbox": 0.2,
    };
    for (const [id, dur] of Object.entries(toolDurations)) {
      store.setToolResult(sessionId, id, {
        tool_use_id: id,
        content: "",
        is_error: false,
        total_size: 0,
        is_truncated: false,
        duration_seconds: dur,
      });
    }

    // Mock a running Codex Bash command with streamed output deltas.
    store.setToolStartTimestamps(sessionId, { "tb-live": Date.now() - 47_000 });
    store.setToolProgress(sessionId, "tb-live", {
      toolName: "Bash",
      elapsedSeconds: 47,
      outputDelta: "Collecting source shards...\n",
    });
    store.setToolProgress(sessionId, "tb-live", {
      toolName: "Bash",
      elapsedSeconds: 48,
      outputDelta: "Merged 128/512 files\n",
    });
    store.setToolProgress(sessionId, "tb-live", {
      toolName: "Bash",
      elapsedSeconds: 49,
      outputDelta: "Merged 256/512 files\n",
    });

    // Additional ChatView states used by the chat-flow Playground coverage.
    store.addSession({
      ...session,
      session_id: PLAYGROUND_STARTING_SESSION_ID,
      backend_type: "claude-sdk",
      backend_state: "initializing",
      backend_error: null,
    });
    store.setConnectionStatus(PLAYGROUND_STARTING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_STARTING_SESSION_ID, false);
    store.setSessionStatus(PLAYGROUND_STARTING_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_RESUMING_SESSION_ID,
      backend_type: "codex",
      backend_state: "resuming",
      backend_error: null,
      model: "gpt-5.3-codex",
    });
    store.setConnectionStatus(PLAYGROUND_RESUMING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_RESUMING_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_RESUMING_SESSION_ID);
    store.setSessionStatus(PLAYGROUND_RESUMING_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_RECOVERING_SESSION_ID,
      backend_type: "codex",
      backend_state: "recovering",
      backend_error: null,
      model: "gpt-5.3-codex",
    });
    store.setConnectionStatus(PLAYGROUND_RECOVERING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_RECOVERING_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_RECOVERING_SESSION_ID);
    store.setSessionStatus(PLAYGROUND_RECOVERING_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_BROKEN_SESSION_ID,
      backend_type: "codex",
      backend_state: "broken",
      backend_error: "Codex initialization failed: Transport closed",
      model: "gpt-5.3-codex",
    });
    store.setConnectionStatus(PLAYGROUND_BROKEN_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_BROKEN_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_BROKEN_SESSION_ID);
    store.setCliDisconnectReason(PLAYGROUND_BROKEN_SESSION_ID, "broken");
    store.setSessionStatus(PLAYGROUND_BROKEN_SESSION_ID, null);

    // Seed quest-named state for sidebar quest demo rows.
    // SessionItem reads isQuestNamed + claimedQuestStatus from the store.
    store.addSession({ ...session, session_id: questInProgressId, claimedQuestStatus: "in_progress" });
    store.addSession({
      ...session,
      session_id: questVerificationId,
      claimedQuestStatus: "done",
      claimedQuestVerificationInboxUnread: true,
    });
    store.markQuestNamed(questInProgressId);
    store.markQuestNamed(questVerificationId);
    store.setSessionTimers("leader-alpha", [
      {
        id: "sidebar-timer-1",
        sessionId: "leader-alpha",
        title: "Check worker queue",
        description: "Review the active herd backlog and redistribute work if needed.",
        type: "delay",
        originalSpec: "20m",
        nextFireAt: Date.now() + 1_200_000,
        createdAt: Date.now() - 240_000,
        fireCount: 0,
      },
    ]);

    return () => {
      useStore.setState((s) => {
        const sessions = new Map(s.sessions);
        const messages = new Map(s.messages);
        const pendingPermissions = new Map(s.pendingPermissions);
        const connectionStatus = new Map(s.connectionStatus);
        const cliConnected = new Map(s.cliConnected);
        const cliEverConnected = new Map(s.cliEverConnected);
        const sessionStatus = new Map(s.sessionStatus);
        const streaming = new Map(s.streaming);
        const streamingStartedAt = new Map(s.streamingStartedAt);
        const streamingOutputTokens = new Map(s.streamingOutputTokens);
        const cliDisconnectReason = new Map(s.cliDisconnectReason);
        const feedScrollPosition = new Map(s.feedScrollPosition);
        const historyLoading = new Map(s.historyLoading);
        const sessionBoards = new Map(s.sessionBoards);
        const pendingCodexInputs = new Map(s.pendingCodexInputs);
        const sessionTimers = new Map(s.sessionTimers);
        const toolProgress = new Map(s.toolProgress);
        const toolResults = new Map(s.toolResults);
        const toolStartTimestamps = new Map(s.toolStartTimestamps);
        const questNamedSessions = new Set(s.questNamedSessions);

        for (const demoId of demoSessionIds) {
          const prevSession = prevSessions.get(demoId);
          const prevMessageList = prevMessages.get(demoId);
          const prevPermissionMap = prevPerms.get(demoId);
          const prevConnection = prevConn.get(demoId);
          const prevCliConnected = prevCli.get(demoId);
          const prevCliSeen = prevCliEver.get(demoId);
          const prevDisconnectReason = prevCliDisconnectReason.get(demoId);
          const prevSessionState = prevStatus.get(demoId);
          const prevStream = prevStreaming.get(demoId);
          const prevStreamStarted = prevStreamingStartedAt.get(demoId);
          const prevStreamTokens = prevStreamingOutputTokens.get(demoId);
          const prevFeedScrollPosition = prevFeedScrollPositions.get(demoId);
          const prevLoading = prevHistoryLoading.get(demoId);
          const prevPendingCodex = prevPendingCodexInputs.get(demoId);
          const prevSessionToolProgress = prevToolProgress.get(demoId);
          const prevSessionToolResults = prevToolResults.get(demoId);
          const prevSessionToolStarts = prevToolStartTimestamps.get(demoId);

          if (prevSession) sessions.set(demoId, prevSession);
          else sessions.delete(demoId);
          if (prevMessageList) messages.set(demoId, prevMessageList);
          else messages.delete(demoId);
          if (prevPermissionMap) pendingPermissions.set(demoId, prevPermissionMap);
          else pendingPermissions.delete(demoId);
          if (prevConnection) connectionStatus.set(demoId, prevConnection);
          else connectionStatus.delete(demoId);
          if (typeof prevCliConnected === "boolean") cliConnected.set(demoId, prevCliConnected);
          else cliConnected.delete(demoId);
          if (typeof prevCliSeen === "boolean") cliEverConnected.set(demoId, prevCliSeen);
          else cliEverConnected.delete(demoId);
          if (prevDisconnectReason !== undefined) cliDisconnectReason.set(demoId, prevDisconnectReason);
          else cliDisconnectReason.delete(demoId);
          if (prevSessionState) sessionStatus.set(demoId, prevSessionState);
          else sessionStatus.delete(demoId);
          if (typeof prevStream === "string") streaming.set(demoId, prevStream);
          else streaming.delete(demoId);
          if (typeof prevStreamStarted === "number") streamingStartedAt.set(demoId, prevStreamStarted);
          else streamingStartedAt.delete(demoId);
          if (typeof prevStreamTokens === "number") streamingOutputTokens.set(demoId, prevStreamTokens);
          else streamingOutputTokens.delete(demoId);
          if (prevFeedScrollPosition) feedScrollPosition.set(demoId, prevFeedScrollPosition);
          else feedScrollPosition.delete(demoId);
          if (prevLoading) historyLoading.set(demoId, true);
          else historyLoading.delete(demoId);
          const prevBoard = prevSessionBoards.get(demoId);
          if (prevBoard) sessionBoards.set(demoId, prevBoard);
          else sessionBoards.delete(demoId);
          if (prevPendingCodex) pendingCodexInputs.set(demoId, prevPendingCodex);
          else pendingCodexInputs.delete(demoId);
          if (prevSessionToolProgress) toolProgress.set(demoId, prevSessionToolProgress);
          else toolProgress.delete(demoId);
          if (prevSessionToolResults) toolResults.set(demoId, prevSessionToolResults);
          else toolResults.delete(demoId);
          if (prevSessionToolStarts) toolStartTimestamps.set(demoId, prevSessionToolStarts);
          else toolStartTimestamps.delete(demoId);
        }
        for (const timerDemoId of sidebarTimerDemoIds) {
          const prevTimers = prevSessionTimers.get(timerDemoId);
          if (prevTimers) sessionTimers.set(timerDemoId, prevTimers);
          else sessionTimers.delete(timerDemoId);
        }
        for (const questId of [questInProgressId, questVerificationId]) {
          if (prevQuestNamed.get(questId)) questNamedSessions.add(questId);
          else questNamedSessions.delete(questId);
        }

        return {
          sessions,
          messages,
          pendingPermissions,
          connectionStatus,
          cliConnected,
          cliEverConnected,
          cliDisconnectReason,
          sessionStatus,
          streaming,
          streamingStartedAt,
          streamingOutputTokens,
          feedScrollPosition,
          historyLoading,
          sessionBoards,
          pendingCodexInputs,
          sessionTimers,
          toolProgress,
          toolResults,
          toolStartTimestamps,
          questNamedSessions,
        };
      });
    };
  }, []);
}
