export interface WsIncomingMessageContext {
  source: "live" | "event_replay";
  coldBufferedReplay?: boolean;
}
