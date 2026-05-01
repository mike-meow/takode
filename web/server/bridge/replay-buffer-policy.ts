import type {
  BrowserIncomingMessage,
  BufferedBrowserEvent,
  ReplayableBrowserIncomingMessage,
} from "../session-types.js";

const NON_REPLAYABLE_BROWSER_EVENT_TYPES = new Set<string>([
  "session_init",
  "message_history",
  "event_replay",
  "leader_group_idle",
  "quest_list_updated",
  "session_quest_claimed",
  "session_name_update",
  "tree_groups_update",
  "leader_projection_snapshot",
]);

export function shouldBufferForReplay(msg: BrowserIncomingMessage): msg is ReplayableBrowserIncomingMessage {
  return !NON_REPLAYABLE_BROWSER_EVENT_TYPES.has(msg.type);
}

export function isReplayableBufferedEvent(event: unknown): event is BufferedBrowserEvent {
  if (!event || typeof event !== "object") return false;
  const maybeEvent = event as { seq?: unknown; message?: unknown };
  if (typeof maybeEvent.seq !== "number") return false;
  if (!maybeEvent.message || typeof maybeEvent.message !== "object") return false;
  const maybeMessage = maybeEvent.message as { type?: unknown };
  return typeof maybeMessage.type === "string" && shouldBufferForReplay(maybeMessage as BrowserIncomingMessage);
}
