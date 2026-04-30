import { backendAttached, backendConnected } from "./bridge/session-registry-controller.js";
import { sessionTag } from "./session-tag.js";

type BackendTypeLike = "claude" | "codex" | "claude-sdk" | string;

export interface UnavailableOrchestratorSessionLike {
  id: string;
  backendType: BackendTypeLike;
  isGenerating?: boolean;
  state?: { backend_state?: string };
  backendSocket?: unknown;
  codexAdapter?: { isConnected?: () => boolean } | null;
  claudeSdkAdapter?: { isConnected?: () => boolean } | null;
}

export interface UnavailableOrchestratorLauncherInfo {
  isOrchestrator?: boolean;
  archived?: boolean;
  killedByIdleManager?: boolean;
}

export interface UnavailableOrchestratorRecoveryDeps {
  getSession: (sessionId: string) => UnavailableOrchestratorSessionLike | undefined;
  getLauncherSessionInfo: (sessionId: string) => UnavailableOrchestratorLauncherInfo | undefined;
  requestCodexAutoRecovery: (session: UnavailableOrchestratorSessionLike, reason: string) => boolean;
  requestCliRelaunch?: (sessionId: string) => void;
  recoveryDedupeMs?: number;
}

export function shouldWakeUnavailableOrchestratorForPendingEvents(
  session: UnavailableOrchestratorSessionLike | undefined,
  deps: Pick<UnavailableOrchestratorRecoveryDeps, "getLauncherSessionInfo">,
): boolean {
  if (!session) return false;
  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  if (!launcherInfo?.isOrchestrator) return false;
  if (launcherInfo.archived || launcherInfo.killedByIdleManager) return false;
  if (session.isGenerating) return false;
  if (session.state?.backend_state === "broken") return false;
  if (backendAttached(session) || backendConnected(session)) return false;
  return true;
}

export function createUnavailableOrchestratorRecoveryWake(
  deps: UnavailableOrchestratorRecoveryDeps,
): (sessionId: string, reason: string) => boolean {
  const pendingRecovery = new Set<string>();
  const recoveryDedupeMs = deps.recoveryDedupeMs ?? 30_000;

  return (sessionId: string, reason: string): boolean => {
    const session = deps.getSession(sessionId);
    if (!shouldWakeUnavailableOrchestratorForPendingEvents(session, deps)) {
      if (session && backendAttached(session)) {
        pendingRecovery.delete(sessionId);
      }
      return false;
    }
    if (pendingRecovery.has(sessionId)) return false;

    pendingRecovery.add(sessionId);
    const clearRecoveryRequest = setTimeout(() => {
      pendingRecovery.delete(sessionId);
    }, recoveryDedupeMs);
    if (clearRecoveryRequest.unref) clearRecoveryRequest.unref();

    let requested = false;
    if (session!.backendType === "codex") {
      requested = deps.requestCodexAutoRecovery(session!, reason);
    } else if (deps.requestCliRelaunch) {
      console.log(
        `[ws-bridge] Requesting unavailable orchestrator relaunch for session ${sessionTag(sessionId)} (${reason})`,
      );
      deps.requestCliRelaunch(sessionId);
      requested = true;
    }

    if (!requested) {
      clearTimeout(clearRecoveryRequest);
      pendingRecovery.delete(sessionId);
    }
    return requested;
  };
}
