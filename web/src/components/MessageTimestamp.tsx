function formatMessageTime(timestamp: number): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 100) return "<0.1s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

export function MessageTimestamp({ timestamp, turnDurationMs }: { timestamp: number; turnDurationMs?: number }) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  const timeText = formatMessageTime(timestamp);
  if (!timeText) return null;
  const durationText = typeof turnDurationMs === "number" ? formatTurnDuration(turnDurationMs) : "";
  return (
    <time
      data-testid="message-timestamp"
      dateTime={d.toISOString()}
      title={d.toLocaleString()}
      className="inline-block ml-2 text-[11px] text-cc-muted/70"
    >
      {durationText ? `${timeText} · ${durationText}` : timeText}
    </time>
  );
}
