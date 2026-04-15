import type { HerdChangeEvent } from "../shared/herd-types.js";
import type { TakodeHerdReassignedEventData } from "./session-types.js";

interface HerdDispatcherHandle {
  onHerdChanged(orchId: string): void;
}

interface HerdBridgeHandle {
  emitTakodeEvent(
    sessionId: string,
    event: "herd_reassigned",
    data: TakodeHerdReassignedEventData,
    actorSessionId?: string,
  ): void;
  onHerdMembershipChanged(orchId: string): void;
}

interface HerdLauncherHandle {
  getSessionNum(sessionId: string): number | undefined;
  getSession(sessionId: string): { name?: string } | undefined;
}

function formatLeaderLabel(
  launcher: HerdLauncherHandle,
  getSessionName: (sessionId: string) => string | undefined,
  sessionId: string,
): string {
  const sessionNum = launcher.getSessionNum(sessionId);
  const sessionName = getSessionName(sessionId) || launcher.getSession(sessionId)?.name || sessionId.slice(0, 8);
  return sessionNum !== undefined ? `#${sessionNum} ${sessionName}` : sessionName;
}

export function createLauncherHerdChangeHandler(params: {
  dispatcher: HerdDispatcherHandle;
  wsBridge: HerdBridgeHandle;
  launcher: HerdLauncherHandle;
  getSessionName: (sessionId: string) => string | undefined;
}): (event: HerdChangeEvent) => void {
  const { dispatcher, wsBridge, launcher, getSessionName } = params;
  return (event: HerdChangeEvent) => {
    if (event.type === "membership_changed") {
      dispatcher.onHerdChanged(event.leaderId);
      wsBridge.onHerdMembershipChanged(event.leaderId);
      return;
    }

    wsBridge.emitTakodeEvent(
      event.workerId,
      "herd_reassigned",
      {
        fromLeaderSessionId: event.fromLeaderId,
        fromLeaderLabel: formatLeaderLabel(launcher, getSessionName, event.fromLeaderId),
        toLeaderSessionId: event.toLeaderId,
        toLeaderLabel: formatLeaderLabel(launcher, getSessionName, event.toLeaderId),
        ...(event.reviewerCount > 0 ? { reviewerCount: event.reviewerCount } : {}),
      },
      event.toLeaderId,
    );
  };
}
