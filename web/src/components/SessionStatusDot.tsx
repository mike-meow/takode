/**
 * SessionStatusDot — a small yarn-ball indicator showing the current state of a session.
 *
 * Status priority (highest to lowest):
 *   1. archived          -> gray yarn ball, no glow
 *   2. permission         -> amber yarn ball, breathing glow (needs user action)
 *   3. disconnected       -> red yarn ball, no glow
 *   4. running            -> green yarn ball, breathing glow (agent actively working)
 *   5. compacting         -> green yarn ball, breathing glow (context compaction)
 *   6. completed_unread   -> blue yarn ball, no glow (agent finished, user hasn't checked)
 *   7. idle               -> gray yarn ball, no glow
 */

import { YarnBallDot } from "./CatIcons.js";

export type SessionVisualStatus =
  | "archived"
  | "permission"
  | "disconnected"
  | "running"
  | "compacting"
  | "completed_unread"
  | "idle";

export interface SessionStatusDotProps {
  /** Whether the session is archived */
  archived?: boolean;
  /** Number of pending permission requests */
  permCount: number;
  /** Whether the CLI process is connected */
  isConnected: boolean;
  /** SDK process state */
  sdkState: "starting" | "connected" | "running" | "exited" | null;
  /** Session activity status */
  status: "idle" | "running" | "compacting" | "reverting" | null;
  /** Whether the session has unread results the user hasn't seen */
  hasUnread?: boolean;
}

/**
 * Derives the visual status from session state fields.
 * Exported for testability.
 */
export function deriveSessionStatus(props: SessionStatusDotProps): SessionVisualStatus {
  const { archived, permCount, isConnected, sdkState, status, hasUnread } = props;

  if (archived) return "archived";
  if (permCount > 0) return "permission";
  // Disconnected: CLI not connected and not still starting up.
  // isConnected is accurate for all sessions (active via WebSocket, non-active via REST fallback).
  if (!isConnected && sdkState !== "starting") return "disconnected";
  if (status === "running") return "running";
  if (status === "compacting" || status === "reverting") return "compacting";
  if (hasUnread) return "completed_unread";
  return "idle";
}

/** Maps visual status to the yarn ball's text color class (used with fill=currentColor) */
const DOT_COLOR: Record<SessionVisualStatus, string> = {
  archived: "text-cc-muted/40",
  permission: "text-cc-warning",
  disconnected: "text-cc-error",
  running: "text-cc-success",
  compacting: "text-cc-success",
  completed_unread: "text-blue-500",
  idle: "text-cc-muted/40",
};

/** Maps visual status to whether the dot should have a breathing glow */
const SHOULD_GLOW: Record<SessionVisualStatus, boolean> = {
  archived: false,
  permission: true,
  disconnected: false,
  running: true,
  compacting: true,
  completed_unread: false,
  idle: false,
};

/**
 * Maps visual status to the CSS color for drop-shadow glow.
 * Only entries where SHOULD_GLOW is true need a value.
 */
const GLOW_COLOR: Record<SessionVisualStatus, string> = {
  archived: "",
  permission: "rgba(245, 158, 11, 0.6)",   // amber
  disconnected: "",
  running: "rgba(34, 197, 94, 0.6)",       // green
  compacting: "rgba(34, 197, 94, 0.6)",    // green
  completed_unread: "",
  idle: "",
};

/** Maps visual status to an accessible label */
const STATUS_LABEL: Record<SessionVisualStatus, string> = {
  archived: "Archived",
  permission: "Waiting for permission",
  disconnected: "Disconnected",
  running: "Running",
  compacting: "Compacting context",
  completed_unread: "Completed — needs review",
  idle: "Idle",
};

export function SessionStatusDot(props: SessionStatusDotProps) {
  const visualStatus = deriveSessionStatus(props);
  const dotColor = DOT_COLOR[visualStatus];
  const showGlow = SHOULD_GLOW[visualStatus];
  const glowColor = GLOW_COLOR[visualStatus];
  const label = STATUS_LABEL[visualStatus];

  // Use CSS filter drop-shadow for glow — follows the circular shape of the yarn ball
  const glowStyle: React.CSSProperties | undefined = showGlow
    ? {
        ["--glow-color" as string]: glowColor,
        animation: "yarn-glow-breathe 2s ease-in-out infinite",
      }
    : undefined;

  return (
    <div className="relative shrink-0 mt-[7px]" title={label} aria-label={label} data-testid="session-status-dot" data-status={visualStatus} style={glowStyle}>
      <YarnBallDot
        className={`block w-2.5 h-2.5 ${dotColor}`}
      />
    </div>
  );
}
