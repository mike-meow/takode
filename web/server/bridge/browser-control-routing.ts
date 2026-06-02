import type { AdapterBrowserRoutingDeps } from "./adapter-browser-routing-controller.js";
import { routeBrowserMessage as routeBrowserMessageController } from "./adapter-browser-routing-controller.js";
import type { Session } from "./ws-bridge-session.js";

type InterruptSource = "user" | "leader" | "system";

export async function setSessionPermissionMode(
  sessions: Map<string, Session>,
  browserRoutingDeps: AdapterBrowserRoutingDeps,
  sessionId: string,
  mode: string,
): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  await routeBrowserMessageController(session, { type: "set_permission_mode", mode }, undefined, browserRoutingDeps);
  return true;
}

export async function interruptSession(
  sessions: Map<string, Session>,
  browserRoutingDeps: AdapterBrowserRoutingDeps,
  sessionId: string,
  source: InterruptSource,
  options?: { interruptOrigin?: "restart_prep"; restartPrepOperationId?: string },
): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (options?.interruptOrigin === "restart_prep" && session.isGenerating) {
    session.restartPrepInterruptOrigin = "restart_prep";
    session.restartPrepInterruptOperationId = options.restartPrepOperationId ?? null;
  }
  await routeBrowserMessageController(
    session,
    { type: "interrupt", interruptSource: source },
    undefined,
    browserRoutingDeps,
  );
  return true;
}
