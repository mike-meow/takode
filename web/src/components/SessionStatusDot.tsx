/**
 * SessionStatusDot — a small colored indicator showing the current state of a session.
 *
 * Status priority (highest to lowest):
 *   1. archived       -> gray dot, no glow
 *   2. permission      -> amber dot, breathing glow (needs user action)
 *   3. disconnected    -> red dot, no glow
 *   4. running         -> green dot, breathing glow (agent actively working)
 *   5. compacting      -> amber dot, breathing glow (context compaction)
 *   6. idle            -> dim green dot, no glow
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

/** Maps visual status to whether the dot should have a breathing glow */
const SHOULD_GLOW: Record<SessionVisualStatus, boolean> = {
  archived: false,
  permission: true,
  disconnected: false,
  running: true,
  compacting: true,
  idle: false,
};

/**
 * Maps visual status to the RGB triplet for --glow-color.
 * Only entries where SHOULD_GLOW is true need a value.
 */
const GLOW_RGB: Record<SessionVisualStatus, string> = {
  archived: "",
  permission: "245, 158, 11",   // amber
  disconnected: "",
  running: "34, 197, 94",       // green
  compacting: "245, 158, 11",   // amber
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
  const showGlow = SHOULD_GLOW[visualStatus];
  const glowRgb = GLOW_RGB[visualStatus];
  const label = STATUS_LABEL[visualStatus];

  const glowStyle: React.CSSProperties | undefined = showGlow
    ? {
        ["--glow-color" as string]: glowRgb,
        animation: "glow-breathe 2s ease-in-out infinite",
      }
    : undefined;

  return (
    <div className="relative shrink-0 mt-[7px]" title={label} aria-label={label}>
      <span
        className={`block w-2 h-2 rounded-full ${dotColor}`}
        data-testid="session-status-dot"
        data-status={visualStatus}
        style={glowStyle}
      />
    </div>
  );
}
