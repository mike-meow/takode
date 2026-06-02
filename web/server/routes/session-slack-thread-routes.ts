import type { Hono } from "hono";
import * as sessionNames from "../session-names.js";
import { getSettings } from "../settings-manager.js";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { BackendType } from "../session-types.js";
import { createSlackThreadId, findRootAssistantAnchor } from "../slack-thread-branches.js";

export function registerSessionSlackThreadRoutes(
  api: Hono,
  deps: {
    launcher: CliLauncher;
    wsBridge: WsBridge;
    resolveId: (id: string) => string | null;
  },
): void {
  const { launcher, wsBridge, resolveId } = deps;

  api.post("/sessions/:id/slack-threads", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const root = wsBridge.getSession(id);
    const rootInfo = launcher.getSession(id);
    if (!root || !rootInfo) return c.json({ error: "Session not found" }, 404);
    if (root.state.slackThreadChild || rootInfo.hidden) {
      return c.json({ error: "Threads can only start from a root session" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const anchorMessageId = typeof body.anchorMessageId === "string" ? body.anchorMessageId.trim() : "";
    if (!anchorMessageId) return c.json({ error: "anchorMessageId is required" }, 400);

    const existing = Object.values(root.state.slackThreads ?? {}).find(
      (thread) => thread.anchorMessageId === anchorMessageId,
    );
    if (existing) {
      wsBridge.syncSlackThreadRecord(id, existing.id);
      return c.json({ ok: true, thread: root.state.slackThreads?.[existing.id] ?? existing });
    }

    const anchor = findRootAssistantAnchor(root.messageHistory, anchorMessageId);
    if (!anchor) return c.json({ error: "Anchor must be a root assistant message" }, 400);

    const threadId = createSlackThreadId();
    const backend = (rootInfo.backendType || root.state.backend_type || "claude") as BackendType;
    const binarySettings = getSettings();
    const child = await launcher.launch({
      backendType: backend,
      cwd: root.state.cwd || rootInfo.cwd,
      model: root.state.model || rootInfo.model,
      permissionMode: "default",
      askPermission: true,
      uiMode: "agent",
      claudeBinary: binarySettings.claudeBinary || undefined,
      codexBinary: binarySettings.codexBinary || undefined,
      codexSandbox: backend === "codex" ? "read-only" : undefined,
      codexInternetAccess: backend === "codex" ? rootInfo.codexInternetAccess === true : undefined,
      codexReasoningEffort: backend === "codex" ? rootInfo.codexReasoningEffort : undefined,
      memorySessionSpaceSlug: root.state.memorySessionSpaceSlug,
      hidden: true,
      parentSessionId: id,
      slackThreadId: threadId,
      slackThreadAnchorMessageId: anchorMessageId,
      slackThreadAnchorHistoryIndex: anchor.historyIndex,
      slackThreadReadOnly: true,
    });

    child.hidden = true;
    child.parentSessionId = id;
    child.slackThreadId = threadId;
    child.slackThreadAnchorMessageId = anchorMessageId;
    child.slackThreadAnchorHistoryIndex = anchor.historyIndex;
    child.slackThreadReadOnly = true;
    child.noAutoName = true;
    launcher.touchActivity(child.sessionId);

    const childSession = wsBridge.getOrCreateSession(child.sessionId, backend);
    childSession.state.hidden = true;
    childSession.state.slackThreadChild = {
      rootSessionId: id,
      threadId,
      anchorMessageId,
      anchorHistoryIndex: anchor.historyIndex,
      readOnly: true,
    };
    childSession.state.permissionMode = "default";
    childSession.state.cwd = root.state.cwd || rootInfo.cwd;
    childSession.state.model = root.state.model || rootInfo.model || "";
    childSession.state.treeGroupId = root.state.treeGroupId ?? "default";
    childSession.state.memorySessionSpaceSlug = root.state.memorySessionSpaceSlug;
    wsBridge.persistSessionById(child.sessionId);
    sessionNames.setName(child.sessionId, `Thread: ${anchor.preview || anchorMessageId}`);

    const now = Date.now();
    const thread = {
      id: threadId,
      rootSessionId: id,
      childSessionId: child.sessionId,
      anchorMessageId,
      anchorHistoryIndex: anchor.historyIndex,
      anchorPreview: anchor.preview,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      seeded: false,
    };
    root.state.slackThreads = { ...(root.state.slackThreads ?? {}), [threadId]: thread };
    wsBridge.broadcastToSession(id, {
      type: "session_update",
      session: { slackThreads: root.state.slackThreads },
    } as never);
    wsBridge.persistSessionById(id);
    return c.json({ ok: true, thread });
  });

  api.post("/sessions/:id/slack-threads/:threadId/message", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const threadId = c.req.param("threadId");
    const body = await c.req.json().catch(() => ({}));
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) return c.json({ error: "content is required" }, 400);
    const routed = await wsBridge.routeSlackThreadUserMessage(id, threadId, content, {
      clientMsgId: typeof body.clientMsgId === "string" ? body.clientMsgId : undefined,
    });
    if (!routed.ok) return c.json({ error: routed.error }, 400);
    const root = wsBridge.getSession(id);
    const thread = root?.state.slackThreads?.[threadId];
    if (thread) wsBridge.syncSlackThreadRecord(id, threadId);
    return c.json({
      ok: true,
      thread: root?.state.slackThreads?.[threadId] ?? thread,
      childSessionId: routed.childSessionId,
    });
  });
}
