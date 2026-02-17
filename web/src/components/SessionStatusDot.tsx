/**
 * SessionStatusDot — a small colored indicator showing the current state of a session.
 *
 * Status priority (highest to lowest):
 *   1. archived       -> gray dot, no pulse
 *   2. permission      -> amber dot, pulsing (needs user action)
 *   3. disconnected    -> red dot, no pulse (CLI exited or WS disconnected)
 *   4. running         -> green dot, pulsing (agent actively working)
 *   5. compacting      -> amber dot, pulsing (context compaction)
 *   6. idle            -> dim green dot, no pulse (connected, waiting for input)
 */

export type SessionVisualStatus =
  | "archived"
  | "permission"
  | "disconnected"
  | "running"
  | "compacting"
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
  status: "idle" | "running" | "compacting" | null;
}

/**
 * Derives the visual status from session state fields.
 * Exported for testability.
 */
export function deriveSessionStatus(props: SessionStatusDotProps): SessionVisualStatus {
  const { archived, permCount, isConnected, sdkState, status } = props;

  if (archived) return "archived";
  if (permCount > 0) return "permission";
  // Disconnected: CLI process exited, or not connected and not still starting up
  if (sdkState === "exited" || (!isConnected && sdkState !== "starting")) return "disconnected";
  if (status === "running") return "running";
  if (status === "compacting") return "compacting";
  return "idle";
}

/** Maps visual status to the dot's background color class */
const DOT_COLOR: Record<SessionVisualStatus, string> = {
  archived: "bg-cc-muted/40",
  permission: "bg-cc-warning",
  disconnected: "bg-cc-error",
  running: "bg-cc-success",
  compacting: "bg-cc-warning",
  idle: "bg-cc-success/60",
};

/** Maps visual status to whether the dot should pulse */
const SHOULD_PULSE: Record<SessionVisualStatus, boolean> = {
  archived: false,
  permission: true,
  disconnected: false,
  running: true,
  compacting: true,
  idle: false,
};

/** Maps visual status to the pulse ring color class */
const PULSE_COLOR: Record<SessionVisualStatus, string> = {
  archived: "",
  permission: "bg-cc-warning/40",
  disconnected: "",
  running: "bg-cc-success/40",
  compacting: "bg-cc-warning/40",
  idle: "",
};

/** Maps visual status to an accessible label */
const STATUS_LABEL: Record<SessionVisualStatus, string> = {
  archived: "Archived",
  permission: "Waiting for permission",
  disconnected: "Disconnected",
  running: "Running",
  compacting: "Compacting context",
  idle: "Idle",
};

export function SessionStatusDot(props: SessionStatusDotProps) {
  const visualStatus = deriveSessionStatus(props);
  const dotColor = DOT_COLOR[visualStatus];
  const showPulse = SHOULD_PULSE[visualStatus];
  const pulseColor = PULSE_COLOR[visualStatus];
  const label = STATUS_LABEL[visualStatus];

  return (
    <div className="relative shrink-0 mt-[7px]" title={label} aria-label={label}>
      <span
        className={`block w-2 h-2 rounded-full ${dotColor}`}
        data-testid="session-status-dot"
        data-status={visualStatus}
      />
      {showPulse && (
        <span
          className={`absolute inset-0 w-2 h-2 rounded-full ${pulseColor} animate-[pulse-ring_1.5s_ease-out_infinite]`}
          data-testid="session-status-pulse"
        />
      )}
    </div>
  );
}
