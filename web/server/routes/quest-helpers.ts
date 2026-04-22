import type { WsBridge } from "../ws-bridge.js";
import type { BrowserIncomingMessage } from "../session-types.js";

export function broadcastQuestUpdate(wsBridge: WsBridge): void {
  const bridgeAny = wsBridge as any;
  if (typeof bridgeAny.broadcastToBrowsers === "function" && bridgeAny.sessions?.values) {
    for (const session of bridgeAny.sessions.values()) {
      bridgeAny.broadcastToBrowsers(session, { type: "quest_list_updated" } as BrowserIncomingMessage);
    }
    return;
  }
  bridgeAny.broadcastGlobal?.({ type: "quest_list_updated" } as BrowserIncomingMessage);
}
