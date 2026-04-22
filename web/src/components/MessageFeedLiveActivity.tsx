import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useStore } from "../store.js";
import type { ChatMessage } from "../types.js";
import type { FeedEntry, Turn } from "../hooks/use-feed-model.js";
import { ToolBlock, ToolIcon, formatDuration, getPreview } from "./ToolBlock.js";

const LIVE_ACTIVITY_RAIL_DWELL_MS = 5_000;
const CODEX_TERMINAL_INSPECTOR_MARGIN_PX = 16;
const CODEX_TERMINAL_INSPECTOR_MIN_WIDTH_PX = 320;
const CODEX_TERMINAL_INSPECTOR_MIN_HEIGHT_PX = 240;
const CODEX_TERMINAL_INSPECTOR_DEFAULT_WIDTH_PX = 512;
const CODEX_TERMINAL_INSPECTOR_DEFAULT_HEIGHT_PX = 360;

type CodexTerminalInspectorViewport = {
  width: number;
  height: number;
};

type CodexTerminalInspectorLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CodexTerminalInspectorInteraction = {
  mode: "drag" | "resize";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLayout: CodexTerminalInspectorLayout;
};

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function getCodexTerminalInspectorViewport(element: HTMLElement | null): CodexTerminalInspectorViewport | null {
  if (!element) return null;
  const width = Math.round(element.clientWidth || element.getBoundingClientRect().width);
  const height = Math.round(element.clientHeight || element.getBoundingClientRect().height);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function clampCodexTerminalInspectorLayout(
  layout: CodexTerminalInspectorLayout,
  viewport: CodexTerminalInspectorViewport,
): CodexTerminalInspectorLayout {
  const maxWidth = Math.max(180, viewport.width - CODEX_TERMINAL_INSPECTOR_MARGIN_PX * 2);
  const maxHeight = Math.max(180, viewport.height - CODEX_TERMINAL_INSPECTOR_MARGIN_PX * 2);
  const minWidth = Math.min(CODEX_TERMINAL_INSPECTOR_MIN_WIDTH_PX, maxWidth);
  const minHeight = Math.min(CODEX_TERMINAL_INSPECTOR_MIN_HEIGHT_PX, maxHeight);
  const width = clampNumber(layout.width, minWidth, maxWidth);
  const height = clampNumber(layout.height, minHeight, maxHeight);
  const x = clampNumber(
    layout.x,
    CODEX_TERMINAL_INSPECTOR_MARGIN_PX,
    viewport.width - CODEX_TERMINAL_INSPECTOR_MARGIN_PX - width,
  );
  const y = clampNumber(
    layout.y,
    CODEX_TERMINAL_INSPECTOR_MARGIN_PX,
    viewport.height - CODEX_TERMINAL_INSPECTOR_MARGIN_PX - height,
  );
  return { x, y, width, height };
}

function createDefaultCodexTerminalInspectorLayout(
  viewport: CodexTerminalInspectorViewport,
): CodexTerminalInspectorLayout {
  return clampCodexTerminalInspectorLayout(
    {
      x: CODEX_TERMINAL_INSPECTOR_MARGIN_PX,
      y: viewport.height - CODEX_TERMINAL_INSPECTOR_MARGIN_PX - CODEX_TERMINAL_INSPECTOR_DEFAULT_HEIGHT_PX,
      width: CODEX_TERMINAL_INSPECTOR_DEFAULT_WIDTH_PX,
      height: CODEX_TERMINAL_INSPECTOR_DEFAULT_HEIGHT_PX,
    },
    viewport,
  );
}

export function LiveDurationBadge({
  finalDurationSeconds,
  progressElapsedSeconds,
  startTimestamp,
  isComplete,
}: {
  finalDurationSeconds?: number;
  progressElapsedSeconds?: number;
  startTimestamp?: number;
  isComplete: boolean;
}) {
  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (finalDurationSeconds != null || isComplete) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setLiveSeconds(null);
      return;
    }

    if (startTimestamp == null) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setLiveSeconds(null);
      return;
    }

    const tick = () => {
      const elapsed = Math.max(0, Math.round((Date.now() - startTimestamp) / 1000));
      setLiveSeconds(elapsed);
    };
    tick();
    intervalRef.current = setInterval(tick, 1000);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [finalDurationSeconds, isComplete, startTimestamp]);

  const liveElapsed = liveSeconds ?? progressElapsedSeconds ?? null;
  const displaySeconds = finalDurationSeconds ?? (isComplete ? null : liveElapsed);
  if (displaySeconds == null) return null;

  const isLive = finalDurationSeconds == null;
  return (
    <span className={`text-[10px] tabular-nums shrink-0 ${isLive ? "text-cc-primary" : "text-cc-muted"}`}>
      {formatDuration(displaySeconds)}
    </span>
  );
}

export interface CodexTerminalEntry {
  toolUseId: string;
  input: Record<string, unknown>;
  timestamp: number;
  preview: string;
  result: {
    content: string;
    is_error: boolean;
    is_truncated: boolean;
    duration_seconds?: number;
  } | null;
  progress: {
    elapsedSeconds?: number;
    output?: string;
  } | null;
  startTimestamp?: number;
}

export interface LiveSubagentEntry {
  taskToolUseId: string;
  label: string;
  agentType: string;
  isBackground: boolean;
  turnId: string;
  startTimestamp?: number;
  progressElapsedSeconds?: number;
  freshnessToken: string;
}

function getLiveActivityStartedAt(
  now: number,
  startTimestamp?: number,
  progressElapsedSeconds?: number,
  fallbackTimestamp?: number,
): number {
  if (startTimestamp != null) return startTimestamp;
  if (progressElapsedSeconds != null) return now - progressElapsedSeconds * 1000;
  if (fallbackTimestamp != null) return fallbackTimestamp;
  return now;
}

function getLiveActivityRevealAt(startedAt: number): number {
  return startedAt + LIVE_ACTIVITY_RAIL_DWELL_MS;
}

export function getCodexTerminalRevealAt(entry: CodexTerminalEntry, now: number): number {
  return getLiveActivityRevealAt(
    getLiveActivityStartedAt(now, entry.startTimestamp, entry.progress?.elapsedSeconds, entry.timestamp),
  );
}

export function getLiveSubagentRevealAt(entry: LiveSubagentEntry, now: number): number {
  return getLiveActivityRevealAt(getLiveActivityStartedAt(now, entry.startTimestamp, entry.progressElapsedSeconds));
}

export function collectLiveSubagentEntries(
  turns: Turn[],
  sessionStatus: "idle" | "running" | "compacting" | "reverting" | null,
  toolResults?: Map<
    string,
    {
      content: string;
      is_error: boolean;
      is_truncated: boolean;
      duration_seconds?: number;
    }
  >,
  toolProgress?: Map<
    string,
    {
      toolName: string;
      elapsedSeconds: number;
      output?: string;
    }
  >,
  toolStartTimestamps?: Map<string, number>,
  backgroundAgentNotifs?: Map<
    string,
    {
      status: string;
      outputFile?: string;
      summary?: string;
    }
  >,
  parentStreamingByToolUseId?: Map<string, string>,
): LiveSubagentEntry[] {
  const entries: LiveSubagentEntry[] = [];
  const seen = new Set<string>();

  const getEntrySignature = (feedEntries: FeedEntry[]): { count: number; lastKey: string } => {
    let count = 0;
    let lastKey = "";
    for (const feedEntry of feedEntries) {
      if (feedEntry.kind === "message") {
        count++;
        lastKey = feedEntry.msg.id;
        continue;
      }
      if (feedEntry.kind === "tool_msg_group") {
        count += Math.max(1, feedEntry.items.length);
        lastKey = feedEntry.firstId || feedEntry.items[feedEntry.items.length - 1]?.id || feedEntry.toolName;
        continue;
      }
      if (feedEntry.kind === "subagent") {
        count++;
        lastKey = feedEntry.taskToolUseId;
        const child = getEntrySignature(feedEntry.children);
        count += child.count;
        if (child.lastKey) lastKey = child.lastKey;
        continue;
      }
      if (feedEntry.kind === "subagent_batch") {
        for (const subagent of feedEntry.subagents) {
          count++;
          lastKey = subagent.taskToolUseId;
          const child = getEntrySignature(subagent.children);
          count += child.count;
          if (child.lastKey) lastKey = child.lastKey;
        }
      }
    }
    return { count, lastKey };
  };

  const visitEntries = (feedEntries: FeedEntry[], turnId: string) => {
    for (const entry of feedEntries) {
      if (entry.kind === "subagent") {
        const resultPreview = toolResults?.get(entry.taskToolUseId);
        const bgNotif = backgroundAgentNotifs?.get(entry.taskToolUseId);
        const isEffectivelyComplete = entry.isBackground ? bgNotif != null : resultPreview != null || bgNotif != null;
        const isAbandoned = !isEffectivelyComplete && sessionStatus !== "running" && !entry.isBackground;
        if (!isEffectivelyComplete && !isAbandoned && !seen.has(entry.taskToolUseId)) {
          seen.add(entry.taskToolUseId);
          const childSignature = getEntrySignature(entry.children);
          const rawStreamingText = parentStreamingByToolUseId?.get(entry.taskToolUseId) || "";
          entries.push({
            taskToolUseId: entry.taskToolUseId,
            label: entry.description || "Subagent",
            agentType: entry.agentType,
            isBackground: entry.isBackground,
            turnId,
            startTimestamp: toolStartTimestamps?.get(entry.taskToolUseId),
            progressElapsedSeconds: toolProgress?.get(entry.taskToolUseId)?.elapsedSeconds,
            freshnessToken: `${childSignature.count}:${childSignature.lastKey}:${rawStreamingText.length}`,
          });
        }
        visitEntries(entry.children, turnId);
        continue;
      }

      if (entry.kind === "subagent_batch") {
        for (const subagent of entry.subagents) {
          visitEntries([subagent], turnId);
        }
      }
    }
  };

  for (const turn of turns) {
    visitEntries(turn.allEntries, turn.id);
  }

  return entries;
}

export function getTerminalChipLabel(input: Record<string, unknown>): string {
  const commandValue = input.command;
  const command = Array.isArray(commandValue)
    ? commandValue.map((part) => String(part)).join(" ")
    : typeof commandValue === "string"
      ? commandValue
      : "";
  const firstToken = command.trim().split(/\s+/)[0] || "";
  if (!firstToken) return "cmd";
  const normalized = firstToken.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() || normalized;
  return basename || "cmd";
}

export function collectCodexTerminalEntries(
  messages: ChatMessage[],
  toolResults?: Map<
    string,
    {
      content: string;
      is_error: boolean;
      is_truncated: boolean;
      duration_seconds?: number;
    }
  >,
  toolProgress?: Map<
    string,
    {
      toolName: string;
      elapsedSeconds: number;
      output?: string;
    }
  >,
  toolStartTimestamps?: Map<string, number>,
): CodexTerminalEntry[] {
  const entries = new Map<string, CodexTerminalEntry>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const blocks = msg.contentBlocks || [];
    for (const block of blocks) {
      if (block.type !== "tool_use" || block.name !== "Bash") continue;
      if (!block.id || entries.has(block.id)) continue;

      entries.set(block.id, {
        toolUseId: block.id,
        input: block.input,
        timestamp: msg.timestamp,
        preview: getPreview("Bash", block.input) || "Terminal command",
        result: toolResults?.get(block.id) ?? null,
        progress: toolProgress?.get(block.id) ?? null,
        startTimestamp: toolStartTimestamps?.get(block.id),
      });
    }
  }

  return Array.from(entries.values()).sort((a, b) => {
    const aTs = a.startTimestamp ?? a.timestamp;
    const bTs = b.startTimestamp ?? b.timestamp;
    return bTs - aTs;
  });
}

export function LiveCodexTerminalStub({
  sessionId,
  toolUseId,
  input,
  onInspect,
}: {
  sessionId: string;
  toolUseId: string;
  input: Record<string, unknown>;
  onInspect?: () => void;
}) {
  const progress = useStore((s) => s.toolProgress.get(sessionId)?.get(toolUseId));
  const startTimestamp = useStore((s) => s.toolStartTimestamps.get(sessionId)?.get(toolUseId));
  const preview = getPreview("Bash", input) || "Terminal command";

  return (
    <div className="border border-cc-border rounded-[10px] bg-cc-card/70 px-3 py-2">
      <div className="flex items-center gap-2">
        <ToolIcon type="terminal" />
        <span className="min-w-0 flex-1 truncate text-xs font-mono-code text-cc-fg">{preview}</span>
        <LiveDurationBadge
          progressElapsedSeconds={progress?.elapsedSeconds}
          startTimestamp={startTimestamp}
          isComplete={false}
        />
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-cc-muted">
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cc-primary animate-pulse" />
          Live terminal
        </span>
        {onInspect && (
          <button
            type="button"
            onClick={onInspect}
            data-testid="codex-live-terminal-stub-inspect"
            className="ml-auto text-cc-primary hover:underline cursor-pointer"
          >
            Inspect
          </button>
        )}
      </div>
    </div>
  );
}

export function LiveActivityRail({
  terminals,
  subagents,
  selectedToolUseId,
  onSelect,
  onSelectSubagent,
  onDismissSubagent,
}: {
  terminals: CodexTerminalEntry[];
  subagents: LiveSubagentEntry[];
  selectedToolUseId: string | null;
  onSelect: (toolUseId: string) => void;
  onSelectSubagent: (taskToolUseId: string, turnId: string) => void;
  onDismissSubagent: (taskToolUseId: string, freshnessToken: string) => void;
}) {
  const visibleEntries = [
    ...terminals.map((terminal) => ({
      kind: "terminal" as const,
      key: terminal.toolUseId,
      sortTs: terminal.startTimestamp ?? terminal.timestamp,
      terminal,
    })),
    ...subagents.map((subagent) => ({
      kind: "subagent" as const,
      key: subagent.taskToolUseId,
      sortTs: subagent.startTimestamp ?? 0,
      subagent,
    })),
  ].sort((a, b) => b.sortTs - a.sortTs);

  if (visibleEntries.length === 0) return null;

  return (
    <div
      data-testid="live-activity-rail"
      className="pointer-events-none absolute inset-x-2 top-2 z-10 flex justify-center sm:top-3 sm:inset-x-3"
    >
      <div className="pointer-events-auto flex w-full max-w-3xl justify-start">
        <div className="flex max-w-full items-center gap-1 overflow-x-auto scrollbar-hide rounded-[18px] border border-cc-border/80 bg-cc-bg/96 px-1.5 py-1 shadow-lg backdrop-blur-sm">
          {visibleEntries.map((entry) => {
            if (entry.kind === "terminal") {
              const terminal = entry.terminal;
              const isSelected = selectedToolUseId === terminal.toolUseId;
              return (
                <button
                  key={terminal.toolUseId}
                  type="button"
                  onClick={() => onSelect(terminal.toolUseId)}
                  data-testid="codex-live-terminal-chip"
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    isSelected
                      ? "border-cc-primary/40 bg-cc-card text-cc-fg"
                      : "border-cc-border bg-cc-card text-cc-fg hover:bg-cc-hover"
                  }`}
                  title={terminal.preview}
                  aria-label={`Open live terminal for ${terminal.preview}`}
                >
                  <ToolIcon type="terminal" />
                  <span className="shrink-0 text-xs font-mono-code">{getTerminalChipLabel(terminal.input)}</span>
                  <LiveDurationBadge
                    progressElapsedSeconds={terminal.progress?.elapsedSeconds}
                    startTimestamp={terminal.startTimestamp}
                    isComplete={false}
                  />
                </button>
              );
            }

            const subagent = entry.subagent;
            return (
              <div
                key={subagent.taskToolUseId}
                className="flex shrink-0 items-center gap-1 rounded-full border border-cc-border bg-cc-card pr-1 text-cc-fg"
              >
                <button
                  type="button"
                  onClick={() => onSelectSubagent(subagent.taskToolUseId, subagent.turnId)}
                  data-testid="live-subagent-chip"
                  className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-left text-cc-fg transition-colors hover:bg-cc-hover cursor-pointer"
                  title={subagent.label}
                  aria-label={`Jump to live subagent ${subagent.label}`}
                >
                  <ToolIcon type="agent" />
                  <span className="min-w-0 flex-1 truncate text-xs">{subagent.label}</span>
                  <LiveDurationBadge
                    progressElapsedSeconds={subagent.progressElapsedSeconds}
                    startTimestamp={subagent.startTimestamp}
                    isComplete={false}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => onDismissSubagent(subagent.taskToolUseId, subagent.freshnessToken)}
                  data-testid="live-subagent-chip-dismiss"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
                  aria-label={`Dismiss live subagent ${subagent.label}`}
                  title="Dismiss"
                >
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                    <path d="M3 3l6 6M9 3L3 9" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function CodexTerminalInspector({
  sessionId,
  terminal,
  onClose,
  viewportRef,
}: {
  sessionId: string;
  terminal: CodexTerminalEntry;
  onClose: () => void;
  viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const statusLabel = terminal.result ? (terminal.result.is_error ? "error" : "complete") : "running";
  const statusClass = terminal.result
    ? terminal.result.is_error
      ? "bg-cc-error/10 text-cc-error"
      : "bg-cc-success/10 text-cc-success"
    : "bg-cc-primary/10 text-cc-primary";
  const [layout, setLayout] = useState<CodexTerminalInspectorLayout | null>(null);
  const layoutRef = useRef<CodexTerminalInspectorLayout | null>(null);
  const viewportSizeRef = useRef<CodexTerminalInspectorViewport | null>(null);
  const activeInteractionRef = useRef<CodexTerminalInspectorInteraction | null>(null);
  const previousToolUseIdRef = useRef<string | null>(null);
  const teardownInteractionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const stopInteraction = useCallback(() => {
    activeInteractionRef.current = null;
    teardownInteractionRef.current?.();
    teardownInteractionRef.current = null;
  }, []);

  useEffect(() => stopInteraction, [stopInteraction]);

  useLayoutEffect(() => {
    const updateViewport = () => {
      const nextViewport = getCodexTerminalInspectorViewport(viewportRef.current);
      viewportSizeRef.current = nextViewport;
      if (!nextViewport) return;
      setLayout((current) => {
        if (previousToolUseIdRef.current !== terminal.toolUseId || current == null) {
          previousToolUseIdRef.current = terminal.toolUseId;
          return createDefaultCodexTerminalInspectorLayout(nextViewport);
        }
        return clampCodexTerminalInspectorLayout(current, nextViewport);
      });
    };

    updateViewport();
    const viewportElement = viewportRef.current;
    if (!viewportElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateViewport();
    });
    observer.observe(viewportElement);
    return () => observer.disconnect();
  }, [terminal.toolUseId, viewportRef]);

  const beginInteraction = useCallback(
    (event: ReactPointerEvent<HTMLElement>, mode: CodexTerminalInspectorInteraction["mode"]) => {
      if (event.button !== 0) return;
      const currentLayout = layoutRef.current;
      const currentViewport = viewportSizeRef.current;
      if (!currentLayout || !currentViewport) return;
      event.preventDefault();

      const interaction: CodexTerminalInspectorInteraction = {
        mode,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLayout: currentLayout,
      };
      activeInteractionRef.current = interaction;

      const handleMove = (moveEvent: PointerEvent) => {
        const active = activeInteractionRef.current;
        const viewport = viewportSizeRef.current;
        if (!active || !viewport || moveEvent.pointerId !== active.pointerId) return;
        const dx = moveEvent.clientX - active.startClientX;
        const dy = moveEvent.clientY - active.startClientY;
        const nextLayout =
          active.mode === "drag"
            ? {
                ...active.startLayout,
                x: active.startLayout.x + dx,
                y: active.startLayout.y + dy,
              }
            : {
                ...active.startLayout,
                width: active.startLayout.width + dx,
                height: active.startLayout.height + dy,
              };
        setLayout(clampCodexTerminalInspectorLayout(nextLayout, viewport));
      };

      const handleEnd = (endEvent: PointerEvent) => {
        if (endEvent.pointerId !== interaction.pointerId) return;
        stopInteraction();
      };

      teardownInteractionRef.current?.();
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleEnd);
      window.addEventListener("pointercancel", handleEnd);
      teardownInteractionRef.current = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleEnd);
        window.removeEventListener("pointercancel", handleEnd);
      };
    },
    [stopInteraction],
  );

  const handleHeaderPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, input, textarea, select, summary, [role='button']")) return;
      beginInteraction(event, "drag");
    },
    [beginInteraction],
  );

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      beginInteraction(event, "resize");
    },
    [beginInteraction],
  );

  if (!layout) return null;

  return (
    <div data-testid="codex-terminal-inspector-layer" className="pointer-events-none absolute inset-0 z-20">
      <div
        data-testid="codex-terminal-inspector"
        className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-2xl border border-cc-border bg-cc-bg/98 shadow-2xl backdrop-blur-sm"
        style={{
          left: `${layout.x}px`,
          top: `${layout.y}px`,
          width: `${layout.width}px`,
          height: `${layout.height}px`,
          maxWidth: `calc(100% - ${CODEX_TERMINAL_INSPECTOR_MARGIN_PX * 2}px)`,
          maxHeight: `calc(100% - ${CODEX_TERMINAL_INSPECTOR_MARGIN_PX * 2}px)`,
        }}
      >
        <div
          data-testid="codex-terminal-inspector-header"
          onPointerDown={handleHeaderPointerDown}
          className="flex cursor-grab items-center gap-2 border-b border-cc-border px-4 py-3 active:cursor-grabbing"
          style={{ touchAction: "none" }}
        >
          <ToolIcon type="terminal" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-cc-fg">Terminal transcript</div>
            <div className="truncate text-[11px] font-mono-code text-cc-muted">{terminal.preview}</div>
          </div>
          <span className={`rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-wide ${statusClass}`}>
            {statusLabel}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[11px] text-cc-muted hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
          >
            Minimize
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <ToolBlock name="Bash" input={terminal.input} toolUseId={terminal.toolUseId} sessionId={sessionId} defaultOpen />
        </div>
        <button
          type="button"
          data-testid="codex-terminal-inspector-resize"
          aria-label="Resize terminal transcript"
          onPointerDown={handleResizePointerDown}
          className="absolute bottom-0 right-0 h-7 w-7 cursor-se-resize rounded-tl-lg text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
          style={{ touchAction: "none" }}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="ml-auto mt-auto h-4 w-4"
          >
            <path d="M5 11l6-6M8 11l3-3M11 11l0 0" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
