import type { AdapterBrowserRoutingDeps } from "./bridge/adapter-browser-routing-controller.js";
import { routeBrowserMessage as routeBrowserMessageController } from "./bridge/adapter-browser-routing-controller.js";
import type { Session } from "./bridge/ws-bridge-session.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "./session-types.js";
import { buildSlackThreadSeedPrompt, updateSlackThreadRecordFromChildHistory } from "./slack-thread-branches.js";

export interface SlackThreadBridgeDeps {
  sessions: Map<string, Session>;
  getBrowserRoutingDeps: () => AdapterBrowserRoutingDeps;
  broadcastToBrowsers: (session: Session, msg: BrowserIncomingMessage) => void;
  persistSession: (session: Session) => void;
}

export function syncSlackThreadRecord(deps: SlackThreadBridgeDeps, rootSessionId: string, threadId: string): boolean {
  const root = deps.sessions.get(rootSessionId);
  if (!root?.state.slackThreads?.[threadId]) return false;
  const record = root.state.slackThreads[threadId];
  const child = deps.sessions.get(record.childSessionId);
  if (!child) return false;
  root.state.slackThreads = {
    ...root.state.slackThreads,
    [threadId]: updateSlackThreadRecordFromChildHistory(record, child.messageHistory),
  };
  deps.broadcastToBrowsers(root, { type: "session_update", session: { slackThreads: root.state.slackThreads } });
  deps.persistSession(root);
  return true;
}

export function syncSlackThreadRecordForChild(deps: SlackThreadBridgeDeps, childSession: Session): boolean {
  const child = childSession.state.slackThreadChild;
  if (!child) return false;
  return syncSlackThreadRecord(deps, child.rootSessionId, child.threadId);
}

export async function routeSlackThreadUserMessage(
  deps: SlackThreadBridgeDeps,
  rootSessionId: string,
  threadId: string,
  content: string,
  options?: { clientMsgId?: string },
): Promise<{ ok: true; childSessionId: string } | { ok: false; error: string }> {
  const root = deps.sessions.get(rootSessionId);
  if (!root) return { ok: false, error: "Root session not found" };
  const record = root.state.slackThreads?.[threadId];
  if (!record) return { ok: false, error: "Thread not found" };
  const child = deps.sessions.get(record.childSessionId);
  if (!child) return { ok: false, error: "Hidden thread session not found" };

  const seed = record.seeded
    ? null
    : buildSlackThreadSeedPrompt(root.messageHistory, record.anchorHistoryIndex, record.anchorMessageId);
  const msg: BrowserOutgoingMessage = {
    type: "user_message",
    content,
    ...(seed ? { deliveryContent: `${seed}\n\nUser thread message:\n${content}` } : {}),
    ...(options?.clientMsgId ? { client_msg_id: options.clientMsgId } : {}),
    slackThreadId: threadId,
  };

  await routeBrowserMessageController(child, msg, undefined, deps.getBrowserRoutingDeps());

  const latest = root.state.slackThreads?.[threadId];
  if (latest) {
    root.state.slackThreads = {
      ...root.state.slackThreads,
      [threadId]: updateSlackThreadRecordFromChildHistory({ ...latest, seeded: true }, child.messageHistory),
    };
    deps.broadcastToBrowsers(root, { type: "session_update", session: { slackThreads: root.state.slackThreads } });
    deps.persistSession(root);
  }
  return { ok: true, childSessionId: child.id };
}
