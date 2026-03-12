import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "../session-types.js";

/** Metadata updates adapters can emit as they initialize or reconnect. */
export interface AdapterSessionMeta {
  cliSessionId?: string;
  model?: string;
  cwd?: string;
}

/**
 * Shared backend adapter contract consumed by ws-bridge.
 * Adapters translate between backend protocols and Browser* messages.
 */
export interface BackendAdapter<TMeta extends AdapterSessionMeta = AdapterSessionMeta> {
  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean;
  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void;
  onSessionMeta(cb: (meta: TMeta) => void): void;
  onDisconnect(cb: () => void): void;
  onInitError(cb: (error: string) => void): void;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}

export interface TurnStartFailedAwareAdapter {
  onTurnStartFailed(cb: (msg: BrowserOutgoingMessage) => void): void;
}

export interface TurnStartedAwareAdapter {
  onTurnStarted(cb: (turnId: string) => void): void;
}

export interface TurnSteeredAwareAdapter {
  onTurnSteered(cb: (turnId: string, pendingInputIds: string[]) => void): void;
}

export interface TurnSteerFailedAwareAdapter {
  onTurnSteerFailed(cb: (pendingInputIds: string[]) => void): void;
}

export interface PendingOutgoingAwareAdapter {
  drainPendingOutgoing(): BrowserOutgoingMessage[];
}

export interface CurrentTurnIdAwareAdapter {
  getCurrentTurnId(): string | null;
}

export interface RateLimitsAwareAdapter {
  getRateLimits(): {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  } | null;
}
