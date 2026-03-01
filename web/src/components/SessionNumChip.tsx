/**
 * SessionNumChip — a compact clickable session reference showing "#N".
 * On hover, displays a tooltip with the session name, status, model, and backend.
 * Clicking navigates to the session.
 */

import { useState, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { navigateToSession } from "../utils/routing.js";

interface SessionNumChipProps {
  sessionId: string;
  /** Optional className override for the chip button */
  className?: string;
}

export function SessionNumChip({ sessionId, className }: SessionNumChipProps) {
  const sdkSession = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const sessionName = useStore((s) => s.sessionNames.get(sessionId));
  const [hovered, setHovered] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const num = sdkSession?.sessionNum;
  const label = num != null ? `#${num}` : sessionId.slice(0, 6);

  const handleMouseEnter = useCallback(() => {
    hoverTimer.current = setTimeout(() => {
      if (chipRef.current) {
        const rect = chipRef.current.getBoundingClientRect();
        setTooltipPos({ x: rect.left, y: rect.bottom + 4 });
      }
      setHovered(true);
    }, 300);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHovered(false);
    setTooltipPos(null);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigateToSession(sessionId);
  }, [sessionId]);

  const defaultClass = "text-[11px] font-mono px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary hover:bg-cc-primary/20 cursor-pointer transition-colors";

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={className || defaultClass}
        aria-label={sessionName || label}
      >
        {label}
      </button>
      {hovered && tooltipPos && sdkSession && (
        <SessionChipTooltip
          sdkSession={sdkSession}
          sessionName={sessionName}
          pos={tooltipPos}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={handleMouseLeave}
        />
      )}
    </>
  );
}

// ─── Tooltip ────────────────────────────────────────────────────────────────

function SessionChipTooltip({
  sdkSession,
  sessionName,
  pos,
  onMouseEnter,
  onMouseLeave,
}: {
  sdkSession: { sessionNum?: number | null; state: string; model?: string; backendType?: string; cliConnected?: boolean; isOrchestrator?: boolean; herdedBy?: string; gitBranch?: string; cwd: string };
  sessionName: string | undefined;
  pos: { x: number; y: number };
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Clamp to viewport
  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = `${pos.y - rect.height - 8}px`;
    }
  }, [pos]);

  const name = sessionName || "(unnamed)";
  const num = sdkSession.sessionNum != null ? `#${sdkSession.sessionNum}` : "";
  const model = sdkSession.model?.replace(/-\d{8}$/, "") || "";
  const backend = sdkSession.backendType === "codex" ? "Codex" : "Claude";
  const isConnected = sdkSession.cliConnected;
  const statusColor = !isConnected ? "bg-cc-muted/40"
    : sdkSession.state === "running" ? "bg-cc-success"
    : "bg-cc-muted/60";
  const branch = sdkSession.gitBranch || "";

  return createPortal(
    <div
      ref={ref}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[9999] pointer-events-auto animate-[fadeIn_0.1s_ease-out]"
    >
      <div className="bg-cc-card border border-cc-border rounded-lg shadow-xl p-2.5 min-w-[180px] max-w-[280px]">
        {/* Header: name + num + status dot */}
        <div className="flex items-center gap-1.5">
          <span className={`shrink-0 w-2 h-2 rounded-full ${statusColor}`} />
          <span className="text-[12px] font-medium text-cc-fg truncate">{name}</span>
          {num && <span className="text-[10px] font-mono text-cc-muted/60 shrink-0">{num}</span>}
        </div>
        {/* Meta: backend + model + branch */}
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className="text-[9px] font-medium px-1 rounded-full leading-[14px] text-cc-muted bg-cc-muted/10">{backend}</span>
          {model && <span className="text-[9px] text-cc-muted truncate">{model}</span>}
          {sdkSession.isOrchestrator && (
            <span className="text-[9px] font-medium px-1 rounded-full leading-[14px] text-amber-500 bg-amber-500/10">leader</span>
          )}
        </div>
        {branch && (
          <div className="mt-1 text-[9px] text-cc-muted/70 truncate">
            <span className="opacity-60">⑂</span> {branch}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
