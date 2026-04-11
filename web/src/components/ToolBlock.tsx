import {
  useState,
  useEffect,
  useRef,
  useMemo,
  memo,
  Component,
  type ReactNode,
  type ErrorInfo,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { isSubagentToolName } from "../types.js";
import { DiffViewer, formatFileHeaderPath } from "./DiffViewer.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CodeCopyButton } from "./CodeCopyButton.js";
import { Lightbox } from "./Lightbox.js";
import { CollapseFooter } from "./CollapseFooter.js";
import { CopyFormatButton } from "./CopyFormatButton.js";
import { BoardBlock, type BoardRowData } from "./BoardBlock.js";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { getChangePatch, parseEditToolInput, parseWriteToolInput } from "../utils/tool-rendering.js";
import {
  openFileWithEditorPreference,
  resolveEmbeddedVsCodePath,
  showEditorOpenError,
} from "../utils/vscode-bridge.js";

/**
 * Lightweight error boundary that wraps the expanded content inside each ToolBlock.
 * If any child (DiffViewer, ToolDetail, ToolResultSection) throws during render,
 * this catches it and shows a graceful inline error instead of crashing the whole app.
 *
 * Also used as an outer wrapper around the entire ToolBlock component to catch
 * errors that occur outside the expanded section (e.g. infinite re-render loops
 * in store selectors or hooks that React detects at the component level).
 *
 * Auto-recovery: if the error was transient (e.g. a timing-related re-render
 * storm), the boundary retries rendering after a short delay. After MAX_RETRIES
 * consecutive failures it stays in error state permanently to avoid infinite retry loops.
 */

const ERROR_BOUNDARY_RETRY_DELAY_MS = 2000;
const ERROR_BOUNDARY_MAX_RETRIES = 3;

class ToolBlockErrorBoundary extends Component<
  { children: ReactNode; toolName: string; variant?: "inner" | "outer" },
  { error: Error | null; retryCount: number }
> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: { children: ReactNode; toolName: string; variant?: "inner" | "outer" }) {
    super(props);
    this.state = { error: null, retryCount: 0 };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ToolBlock] Render error in ${this.props.toolName}:`, error, info.componentStack);

    // Clear any pending retry before scheduling a new one
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    // Auto-retry transient errors (up to MAX_RETRIES attempts)
    if (this.state.retryCount < ERROR_BOUNDARY_MAX_RETRIES) {
      this.retryTimer = setTimeout(() => {
        this.setState((prev) => ({ error: null, retryCount: prev.retryCount + 1 }));
      }, ERROR_BOUNDARY_RETRY_DELAY_MS);
    }
  }

  componentWillUnmount() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  render() {
    if (this.state.error) {
      const isOuter = this.props.variant === "outer";
      const isPermanent = this.state.retryCount >= ERROR_BOUNDARY_MAX_RETRIES;
      return (
        <div
          className={`text-[11px] text-cc-error/80 bg-cc-error/5 border border-cc-error/20 ${
            isOuter ? "rounded-[10px] px-3 py-2.5" : "rounded-md px-3 py-2"
          }`}
        >
          <span className="font-medium">Failed to render {isOuter ? "tool block" : "tool content"}</span>
          <span className="text-cc-muted ml-1">
            ({this.state.error.message})
            {!isPermanent && " -- retrying..."}
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}

/** localStorage key for the Edit/Write blocks default-expanded preference. */
export const EDIT_BLOCKS_EXPANDED_KEY = "cc-edit-blocks-expanded";

/** Read whether Edit/Write tool blocks should default to expanded. Defaults to true. */
function getEditBlocksExpanded(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(EDIT_BLOCKS_EXPANDED_KEY);
  if (stored !== null) return stored !== "false";
  return true;
}

const TOOL_ICONS: Record<string, string> = {
  Bash: "terminal",
  Read: "file",
  Write: "file-plus",
  Edit: "file-edit",
  Glob: "search",
  Grep: "search",
  WebFetch: "globe",
  WebSearch: "globe",
  NotebookEdit: "notebook",
  Task: "agent",
  Agent: "agent",
  TodoWrite: "checklist",
  TaskCreate: "list",
  TaskUpdate: "list",
  SendMessage: "message",
  EnterPlanMode: "plan",
  ExitPlanMode: "plan",
  AskUserQuestion: "question",
  // Codex tool types (mapped by codex-adapter)
  web_search: "globe",
  mcp_tool_call: "tool",
};

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] || "tool";
}

export function getToolLabel(name: string): string {
  if (name === "Bash") return "Terminal";
  if (name === "Read") return "Read File";
  if (name === "Write") return "Write File";
  if (name === "Edit") return "Edit File";
  if (name === "Glob") return "Find Files";
  if (name === "Grep") return "Search Content";
  if (name === "WebSearch") return "Web Search";
  if (name === "WebFetch") return "Web Fetch";
  if (name === "Task" || name === "Agent") return "Subagent";
  if (name === "TodoWrite") return "Tasks";
  if (name === "NotebookEdit") return "Notebook";
  if (name === "SendMessage") return "Message";
  if (name === "EnterPlanMode") return "Enter Plan Mode";
  if (name === "ExitPlanMode") return "Plan";
  if (name === "AskUserQuestion") return "Question";
  if (name === "web_search") return "Web Search";
  if (name === "mcp_tool_call") return "MCP Tool";
  // Codex MCP tools come as "mcp:server:tool"
  if (name.startsWith("mcp:")) return name.split(":").slice(1).join(":");
  return name;
}

export function formatDuration(seconds: number): string {
  if (seconds < 0.1) return "<0.1s";
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m${secs}s`;
}

/** Live duration badge — shows a counting timer while the tool runs,
 *  then switches to the server-reported ground-truth duration on completion. */
function ToolDurationBadge({ toolUseId, sessionId }: { toolUseId: string; sessionId: string }) {
  // Subscribe to primitive fields only. Using the full ToolResultPreview object
  // as a selector return or useEffect dependency causes re-render storms when the
  // object reference changes (e.g. during history replay), potentially cascading
  // into React error #185 (maximum update depth exceeded).
  const finalDuration = useStore((s) => s.toolResults.get(sessionId)?.get(toolUseId)?.duration_seconds);
  const hasToolResult = useStore((s) => s.toolResults.get(sessionId)?.get(toolUseId) != null);
  const progressElapsedSeconds = useStore((s) => s.toolProgress.get(sessionId)?.get(toolUseId)?.elapsedSeconds);
  // Server start timestamp (from tool_start_times on the assistant message)
  const startTimestamp = useStore((s) => s.toolStartTimestamps.get(sessionId)?.get(toolUseId));

  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // If we have the final duration or the tool has completed (result exists
    // but duration_seconds is missing -- e.g. server restarted mid-tool and
    // lost the transient start time), no need for a live timer.
    if (finalDuration != null || hasToolResult) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setLiveSeconds(null);
      return;
    }

    // If we have a start timestamp but no final duration, run a live timer
    if (startTimestamp != null) {
      const tick = () => {
        const elapsed = Math.round((Date.now() - startTimestamp) / 1000);
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
    }
  }, [finalDuration, startTimestamp, hasToolResult]);

  // Show final duration (static) or live timer
  const liveElapsedSeconds = liveSeconds ?? progressElapsedSeconds ?? null;
  const displaySeconds = finalDuration ?? (!hasToolResult ? liveElapsedSeconds : null);
  if (displaySeconds == null) return null;

  const isLive = finalDuration == null;
  return (
    <span className={`text-[10px] tabular-nums shrink-0 ${isLive ? "text-cc-primary" : "text-cc-muted"}`}>
      {formatDuration(displaySeconds)}
    </span>
  );
}

interface ToolBlockProps {
  name: string;
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId?: string;
  hideLabel?: boolean;
  defaultOpen?: boolean;
}

/** Public ToolBlock: wraps the inner implementation in an error boundary so that
 *  any crash (including infinite re-render loops detected by React) shows an
 *  inline error message instead of taking down the entire page. */
export const ToolBlock = memo(function ToolBlock(props: ToolBlockProps) {
  return (
    <ToolBlockErrorBoundary toolName={props.name} variant="outer">
      <ToolBlockInner {...props} />
    </ToolBlockErrorBoundary>
  );
});

const ToolBlockInner = memo(function ToolBlockInner({
  name,
  input,
  toolUseId,
  sessionId,
  hideLabel = false,
  defaultOpen,
}: ToolBlockProps) {
  const [open, setOpen] = useState(() => {
    if (defaultOpen !== undefined) return defaultOpen;
    // Edit/Write blocks respect the user's expand preference; others start collapsed
    if (name === "Edit" || name === "Write") return getEditBlocksExpanded();
    return false;
  });
  const headerRef = useRef<HTMLDivElement>(null);
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);
  // Subscribe to a boolean primitive instead of the full ToolResultPreview object.
  // The object reference can change during history replay (re-deserialization),
  // which defeats Zustand's Object.is check and causes unnecessary re-renders.
  // The header only needs to know *whether* a result exists, not its contents.
  const hasResult = useStore((s) =>
    sessionId ? s.toolResults.get(sessionId)?.get(toolUseId) != null : false,
  );
  // Only subscribe to the toolName field (a primitive string) instead of the
  // entire progress object. This prevents re-renders from progress.output or
  // progress.elapsedSeconds updates that don't affect the header badge.
  const retainedProgressToolName = useStore((s) =>
    sessionId ? s.toolProgress.get(sessionId)?.get(toolUseId)?.toolName : undefined,
  );
  const showCompletedLiveBadge = name === "Bash" && hasResult && retainedProgressToolName === "Bash";

  // Extract the most useful preview
  const preview = getPreview(name, input);
  const hideHeaderLabel = hideLabel || name === "Bash";
  // File-operation tools show smart-truncated path + Open File button in the header
  const isFileTool = (name === "Read" || name === "Write" || name === "Edit") && !!input.file_path;
  const filePath = isFileTool ? String(input.file_path) : "";
  const filePathParts = isFileTool ? formatFileHeaderPath(filePath) : null;

  // Session cwd for the header Open File button (only subscribed for file tools)
  const sessionCwd = useStore((s) => {
    if (!isFileTool || !sessionId) return null;
    return s.sessions.get(sessionId)?.cwd ?? s.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd ?? null;
  });

  // TodoWrite: flat inline view with status icon + active task + count
  if (name === "TodoWrite" && Array.isArray((input as Record<string, unknown>).todos)) {
    return <TodoWriteInline input={input} />;
  }

  // takode board: render board card instead of terminal block.
  // Tool result previews are truncated to 300 chars by the server, which breaks
  // JSON parsing for boards with several rows. We fetch the full result if needed.
  const isBoardCommand = name === "Bash" && isTakodeBoardCommand(String(input.command || ""));
  const parsedBoard = useBoardData(isBoardCommand, sessionId, toolUseId);
  if (isBoardCommand && parsedBoard) {
    return (
      <BoardBlock
        board={parsedBoard.board}
        operation={parsedBoard.operation}
        toolUseId={toolUseId}
        sessionId={sessionId ?? undefined}
      />
    );
  }

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <div
        ref={headerRef}
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type={iconType} />
        {!hideHeaderLabel && <span className="text-xs font-medium text-cc-fg">{label}</span>}
        {isFileTool && filePathParts ? (
          <span
            className="text-xs truncate flex-1 font-mono-code"
            title={filePath}
          >
            {filePathParts.dirLabel && <span className="text-cc-muted">{filePathParts.dirLabel}</span>}
            <span className="font-semibold text-cc-fg">{filePathParts.baseLabel}</span>
          </span>
        ) : preview ? (
          <span
            className={`text-xs truncate flex-1 font-mono-code ${hideHeaderLabel ? "text-cc-fg/90" : "text-cc-muted"}`}
          >
            {preview}
          </span>
        ) : null}
        {/* Open File in header for file tools. Uses line=1 because the header doesn't
            have access to the parsed diff data needed to compute the first changed line.
            The expanded diff view still shows all changes with line numbers. */}
        {isFileTool && (
          <span onClick={(e) => e.stopPropagation()}>
            <DiffOpenFileButton filePath={filePath} cwd={sessionCwd} line={1} />
          </span>
        )}
        {showCompletedLiveBadge && (
          <span
            className="shrink-0 rounded-full bg-cc-hover px-1.5 py-0.5 text-[10px] font-medium text-cc-muted"
            data-testid="completed-live-badge"
          >
            live
          </span>
        )}
        {sessionId && <ToolDurationBadge toolUseId={toolUseId} sessionId={sessionId} />}
      </div>

      {open && (
        <div className="px-3 pb-3 pt-0 border-t border-cc-border">
          <ToolBlockErrorBoundary toolName={name}>
            <div className="mt-2">
              <ToolDetail name={name} input={input} sessionId={sessionId} />
            </div>
            {sessionId && !isSubagentToolName(name) && (
              <ToolResultSection toolUseId={toolUseId} sessionId={sessionId} toolName={name} input={input} />
            )}
          </ToolBlockErrorBoundary>
          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
});

/** Flat inline view for TodoWrite — shows the highlighted item with status icon and count */
function TodoWriteInline({ input }: { input: Record<string, unknown> }) {
  const todos = input.todos as Array<{ content?: string; activeForm?: string; status?: string }>;
  const completed = todos.filter((t) => t.status === "completed").length;

  // Initial creation (0 completed): show neutral "Starting: <first task>" label
  if (completed === 0) {
    const first = todos.find((t) => t.status === "in_progress") || todos[0];
    const label = first?.activeForm || first?.content || "Tasks";
    return (
      <div className="flex items-center gap-2 px-3 py-1.5">
        <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-muted shrink-0">
          <path d="M4 4.5h8M4 8h8M4 11.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="text-xs leading-snug truncate text-cc-fg">{label}</span>
        <span className="text-[11px] text-cc-muted shrink-0 tabular-nums">({todos.length} tasks)</span>
      </div>
    );
  }

  // Subsequent calls: show the last completed item with a checkmark
  const lastCompleted = [...todos].reverse().find((t) => t.status === "completed");
  const highlightText = lastCompleted?.content || lastCompleted?.activeForm || "Task";

  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success shrink-0">
        <path
          fillRule="evenodd"
          d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z"
          clipRule="evenodd"
        />
      </svg>
      <span className="text-xs leading-snug truncate text-cc-muted line-through">{highlightText}</span>
      <span className="text-[11px] text-cc-muted shrink-0 tabular-nums">
        ({completed}/{todos.length})
      </span>
    </div>
  );
}

/** Detect `takode board` commands (display, add, set, rm). */
function isTakodeBoardCommand(command: string): boolean {
  return /\btakode\s+board\b/.test(command);
}

/**
 * Hook: parse board data from a tool result preview, fetching the full result
 * from the server when the preview is truncated (>300 chars).
 *
 * Uses two primitive selectors (content string, truncated boolean) to avoid
 * creating a new object on every render, which would defeat Zustand's
 * Object.is equality check and cause infinite re-renders.
 */
function useBoardData(
  isBoardCommand: boolean,
  sessionId: string | null | undefined,
  toolUseId: string,
): ParsedBoardResult | null {
  const previewContent = useStore((s) => {
    if (!isBoardCommand || !sessionId) return undefined;
    return s.toolResults.get(sessionId)?.get(toolUseId)?.content;
  });
  const isTruncated = useStore((s) => {
    if (!isBoardCommand || !sessionId) return false;
    return s.toolResults.get(sessionId)?.get(toolUseId)?.is_truncated ?? false;
  });

  const [boardData, setBoardData] = useState<ParsedBoardResult | null>(null);
  useEffect(() => {
    if (!isBoardCommand || !sessionId || previewContent === undefined) {
      setBoardData(null);
      return;
    }
    if (!isTruncated) {
      setBoardData(parseBoardFromResult(previewContent));
      return;
    }
    // Server truncated the preview -- fetch full result to get complete JSON
    let cancelled = false;
    api
      .getToolResult(sessionId, toolUseId)
      .then((full) => {
        if (!cancelled) setBoardData(parseBoardFromResult(full?.content));
      })
      .catch(() => {
        if (!cancelled) setBoardData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isBoardCommand, sessionId, toolUseId, previewContent, isTruncated]);

  return boardData;
}

/**
 * Parse board JSON from a tool result string. Returns the board rows or null.
 *
 * The CLI always emits the JSON marker first, but may append a human-readable
 * text table after it (when not in --json mode). We extract the first top-level
 * JSON object via brace counting so the trailing text doesn't break parsing.
 */
export interface ParsedBoardResult {
  board: BoardRowData[];
  operation?: string;
}

export function parseBoardFromResult(resultContent: string | undefined): ParsedBoardResult | null {
  if (!resultContent) return null;
  const jsonStr = extractFirstJsonObject(resultContent);
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed?.__takode_board__ === true && Array.isArray(parsed.board)) {
      return {
        board: parsed.board,
        operation: typeof parsed.operation === "string" ? parsed.operation : undefined,
      };
    }
  } catch {
    // Malformed JSON
  }
  return null;
}

/** Extract the first balanced `{ ... }` block from a string, skipping strings. */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isLikelyImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|heif|tiff?)$/i.test(path);
}

function extractImagePathForPreview(toolName: string, input: Record<string, unknown>): string | null {
  const directCandidates = [input.file_path, input.path, input.filePath, input.filename];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && isLikelyImagePath(candidate)) return candidate;
  }

  // Codex often maps file reads to Bash commandExecution. If the command clearly
  // targets an image path, use that for the preview thumbnail.
  if (toolName === "Bash" && typeof input.command === "string") {
    const match = input.command.match(
      /(?:^|[\s'"])([^\s'"]+\.(?:png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|heif|tiff?))/i,
    );
    if (match?.[1]) return match[1];
  }
  return null;
}

function shouldPreferLiveTerminalTranscript(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return /terminal command (completed|failed|was interrupted).*?(no output was captured|before the final tool result was delivered)/i.test(
    trimmed,
  );
}

function ToolResultSection({
  toolUseId,
  sessionId,
  toolName,
  input,
}: {
  toolUseId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
}) {
  // Use shallow equality instead of Object.is for the tool result preview.
  // During history replay, the same tool result can be deserialized twice
  // (from history sync and reconnect replay), creating a new object reference
  // with identical primitive fields. Default Object.is would re-render on every
  // such reference change -- combined with CollapseFooter's useLayoutEffect,
  // this cascades into React error #185 (maximum update depth exceeded).
  // shallow() compares each field individually, so identical content = no re-render.
  const preview = useStore(useShallow((s) => s.toolResults.get(sessionId)?.get(toolUseId)));

  // Subscribe to individual primitive fields instead of the full progress object.
  // The progress object changes on every output chunk and elapsed-seconds tick,
  // creating a new reference each time. Subscribing to the whole object would
  // cause Zustand to trigger a re-render on every update (fails Object.is),
  // which under load can cascade into React error #185 (maximum update depth).
  const liveOutput = useStore((s) => s.toolProgress.get(sessionId)?.get(toolUseId)?.output ?? "");
  const progressToolName = useStore((s) => s.toolProgress.get(sessionId)?.get(toolUseId)?.toolName);
  const progressOutputTruncated = useStore(
    (s) => s.toolProgress.get(sessionId)?.get(toolUseId)?.outputTruncated ?? false,
  );
  const imagePath = extractImagePathForPreview(toolName, input);
  const isReadImage = !!imagePath;
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const isCompletedLiveTerminal = toolName === "Bash" && progressToolName === "Bash";
  const shouldUseLiveTranscriptFallback =
    !!preview &&
    isCompletedLiveTerminal &&
    liveOutput.length > 0 &&
    shouldPreferLiveTerminalTranscript(preview.content);

  // Suppress the result section for web search when the result just echoes the
  // query or is a generic placeholder -- the query is already shown in ToolDetail.
  if (preview && !preview.is_error && (toolName === "WebSearch" || toolName === "web_search")) {
    const query = extractWebSearchQuery(input);
    const content = preview.content.trim();
    if (!content || content === query || content === "Web search completed") {
      return null;
    }
  }

  // Suppress the result section for successful Edit/Write calls -- the diff
  // already shows the edit succeeded, and the "file has been updated" message
  // is redundant. Only show the result section when the edit failed.
  if (preview && !preview.is_error && (toolName === "Edit" || toolName === "Write")) {
    return null;
  }

  if (!preview) {
    if (!progressToolName?.trim()) return null;
    return (
      <div className="mt-2 pt-2 border-t border-cc-border/50">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-medium text-cc-muted uppercase tracking-wider">Live output</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary font-medium">
            running
          </span>
          {progressOutputTruncated && <span className="text-[10px] text-cc-muted">showing latest 12KB</span>}
        </div>
        {liveOutput ? (
          <div className="group/code relative rounded-lg overflow-hidden">
            <div className="absolute top-1.5 right-1.5 z-10">
              <CodeCopyButton text={liveOutput} />
            </div>
            <pre className="text-[11px] font-mono-code whitespace-pre leading-relaxed rounded-lg px-2.5 py-2 max-h-64 overflow-y-auto overflow-x-auto bg-cc-code-bg text-cc-muted">
              {liveOutput}
            </pre>
          </div>
        ) : (
          <div className="text-[11px] text-cc-muted italic">Waiting for command output...</div>
        )}
      </div>
    );
  }

  if (isReadImage && !preview.is_error) {
    const imgUrl = api.getFsImageUrl(imagePath);
    return (
      <div className="mt-2 pt-2 border-t border-cc-border/50">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-medium text-cc-muted uppercase tracking-wider">Result</span>
          <span className="text-[10px] text-cc-muted">image preview</span>
        </div>
        <div className="rounded-lg border border-cc-border bg-cc-code-bg/40 p-2">
          <img
            src={imgUrl}
            alt={imagePath}
            className="max-h-48 w-auto rounded border border-cc-border/70 bg-black/10 cursor-zoom-in hover:opacity-80 transition-opacity"
            onClick={() => setLightboxSrc(imgUrl)}
          />
          <div className="mt-1 text-[10px] text-cc-muted">Binary image output hidden.</div>
        </div>
        {lightboxSrc && <Lightbox src={lightboxSrc} alt={imagePath} onClose={() => setLightboxSrc(null)} />}
      </div>
    );
  }

  const displayContent = shouldUseLiveTranscriptFallback ? liveOutput : (fullContent ?? preview.content);
  const showExpandButton = !shouldUseLiveTranscriptFallback && preview.is_truncated && fullContent === null;

  const fetchFull = async () => {
    setLoading(true);
    try {
      const result = await api.getToolResult(sessionId, toolUseId);
      setFullContent(result.content);
    } catch {
      setFullContent("[Failed to load full result]");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-cc-border/50">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-medium text-cc-muted uppercase tracking-wider">Result</span>
        {preview.is_error && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-error/10 text-cc-error font-medium">error</span>
        )}
        {isCompletedLiveTerminal && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary font-medium">
            previously live
          </span>
        )}
        {shouldUseLiveTranscriptFallback && (
          <span className="text-[10px] text-cc-muted">showing captured transcript</span>
        )}
        {preview.is_truncated && fullContent === null && (
          <span className="text-[10px] text-cc-muted">{formatBytes(preview.total_size)}</span>
        )}
      </div>
      {showExpandButton && (
        <button
          onClick={fetchFull}
          disabled={loading}
          className="mb-1 text-[10px] text-cc-primary hover:underline cursor-pointer disabled:opacity-50"
        >
          {loading ? "Loading..." : `Show full result (${formatBytes(preview.total_size)})`}
        </button>
      )}
      <div className="group/code relative rounded-lg overflow-hidden">
        <div className="absolute top-1.5 right-1.5 z-10">
          <CodeCopyButton text={displayContent} />
        </div>
        <pre
          className={`text-[11px] font-mono-code whitespace-pre leading-relaxed rounded-lg px-2.5 py-2 ${
            fullContent === null ? "max-h-40" : "max-h-96"
          } overflow-y-auto overflow-x-auto ${
            preview.is_error ? "bg-cc-error/5 border border-cc-error/20 text-cc-error" : "bg-cc-code-bg text-cc-muted"
          }`}
        >
          {showExpandButton ? "..." : ""}
          {displayContent}
        </pre>
      </div>
    </div>
  );
}

/** Route to custom detail renderer per tool type */
function ToolDetail({ name, input, sessionId }: { name: string; input: Record<string, unknown>; sessionId?: string }) {
  switch (name) {
    case "Bash":
      return <BashDetail input={input} />;
    case "Edit":
      return <EditToolDetail input={input} sessionId={sessionId} />;
    case "Write":
      return <WriteToolDetail input={input} sessionId={sessionId} />;
    case "Read":
      return <ReadToolDetail input={input} />;
    case "Glob":
      return <GlobDetail input={input} />;
    case "Grep":
      return <GrepDetail input={input} />;
    case "WebSearch":
    case "web_search":
      return <WebSearchDetail input={input} />;
    case "WebFetch":
      return <WebFetchDetail input={input} />;
    case "Task":
    case "Agent":
      return <TaskDetail input={input} />;
    case "TodoWrite":
      return <TodoWriteDetail input={input} />;
    case "NotebookEdit":
      return <NotebookEditDetail input={input} />;
    case "SendMessage":
      return <SendMessageDetail input={input} />;
    case "ExitPlanMode":
      return <ExitPlanModeDetail input={input} />;
    case "EnterPlanMode":
      return <div className="text-xs text-cc-muted">Entering plan mode...</div>;
    case "AskUserQuestion":
      return <AskUserQuestionDetail input={input} />;
    default:
      return (
        <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      );
  }
}

// ─── Per-tool detail components ─────────────────────────────────────────────

function normalizeDiffFilePath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^(?:[ab]\/)+/, "");
}

function getFirstChangedLineFromPatch(diffText: string): number {
  const firstHunkMatch = diffText.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/m);
  if (firstHunkMatch) {
    const nextLine = Number.parseInt(firstHunkMatch[1], 10);
    if (Number.isFinite(nextLine) && nextLine > 0) {
      return nextLine;
    }
  }
  return 1;
}

function getFirstChangedLineFromEditPayload(parsed: ReturnType<typeof parseEditToolInput>): number {
  return getFirstChangedLineFromPatch(parsed.unifiedDiff);
}

function changePathMatchesDiffFile(change: Record<string, unknown>, filePath: string): boolean {
  const normalizedTarget = normalizeDiffFilePath(filePath);
  if (!normalizedTarget) return false;

  const rawChangePath = typeof change.path === "string" ? change.path : "";
  const normalizedChangePath = normalizeDiffFilePath(rawChangePath);
  if (
    normalizedChangePath &&
    (normalizedChangePath === normalizedTarget ||
      normalizedChangePath.endsWith(`/${normalizedTarget}`) ||
      normalizedTarget.endsWith(`/${normalizedChangePath}`))
  ) {
    return true;
  }

  const patch = getChangePatch(change);
  if (!patch) return false;
  const escapedPath = normalizedTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\+\\+\\+\\s+(?:b/)?${escapedPath}$`, "m").test(patch);
}

function getFirstChangedLineForEditFile(parsed: ReturnType<typeof parseEditToolInput>, filePath: string): number {
  const matchingChange = parsed.changes.find((change) => changePathMatchesDiffFile(change, filePath));
  if (matchingChange) {
    return getFirstChangedLineFromPatch(getChangePatch(matchingChange));
  }

  if (parsed.filePath && changePathMatchesDiffFile({ path: parsed.filePath }, filePath)) {
    return getFirstChangedLineFromEditPayload(parsed);
  }

  return 1;
}

/** Memoized pure component for "Open File" buttons in diff headers.
 *  Accepts `cwd` as a prop instead of reading it from the Zustand store.
 *  This is critical: DiffViewer calls `renderHeaderActions` during its render
 *  phase, so any component returned by that callback must NOT subscribe to the
 *  store -- otherwise Zustand notifications during render create an infinite
 *  re-render cascade (React error #185, maximum update depth exceeded). */
const DiffOpenFileButton = memo(function DiffOpenFileButton({
  filePath,
  cwd,
  line,
}: {
  filePath: string;
  cwd?: string | null;
  line: number;
}) {
  const absolutePath = resolveEmbeddedVsCodePath(filePath, cwd);
  if (!absolutePath) return null;

  return (
    <button
      type="button"
      className="diff-file-action-btn"
      onClick={async () => {
        try {
          const settings = await api.getSettings();
          await openFileWithEditorPreference(
            {
              absolutePath,
              line,
              column: 1,
            },
            settings.editorConfig?.editor ?? "none",
          );
        } catch (error) {
          showEditorOpenError(error instanceof Error ? error.message : String(error));
        }
      }}
      title="Open this file in the configured editor"
    >
      Open File
    </button>
  );
});

function BashDetail({ input }: { input: Record<string, unknown> }) {
  const command = String(input.command || "");
  return (
    <div className="space-y-1.5">
      {!!input.description && <div className="text-[11px] text-cc-muted italic">{String(input.description)}</div>}
      <div className="group/code relative rounded-lg overflow-hidden">
        <div className="absolute top-1.5 right-1.5 z-10">
          <CodeCopyButton text={command} />
        </div>
        <pre className="px-3 py-2 rounded-lg bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code leading-relaxed overflow-x-auto">
          <span className="text-cc-muted select-none">$ </span>
          {command}
        </pre>
      </div>
      {!!input.timeout && <div className="text-[10px] text-cc-muted">timeout: {String(input.timeout)}ms</div>}
    </div>
  );
}

function EditToolDetail({ input, sessionId }: { input: Record<string, unknown>; sessionId?: string }) {
  const parsed = useMemo(() => parseEditToolInput(input), [input]);
  const { filePath, oldText: oldStr, newText: newStr, changes, unifiedDiff } = parsed;

  // Session cwd for the changes-list Open File buttons (the main header Open File
  // button is now in ToolBlockInner, so this is only needed for the multi-change path).
  const sessionCwd = useStore((s) => {
    if (!sessionId) return null;
    return s.sessions.get(sessionId)?.cwd ?? s.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd ?? null;
  });

  // File path and Open File button are now in the ToolBlock header, so DiffViewer
  // no longer needs fileName or renderHeaderActions for single-file edits.

  if (!oldStr && !newStr && unifiedDiff) {
    return <DiffViewer unifiedDiff={unifiedDiff} mode="full" />;
  }

  if (!oldStr && !newStr && changes.length > 0) {
    return (
      <div className="space-y-1.5">
        <div className="text-[10px] text-cc-muted uppercase tracking-wider">Applied changes</div>
        <div className="space-y-1">
          {changes.map((change, i) => (
            <div
              key={`${typeof change.path === "string" ? change.path : "file"}-${i}`}
              className="flex items-center justify-between gap-3 rounded-md border border-cc-border/70 px-2 py-1.5"
            >
              <span className="min-w-0 text-[11px] text-cc-muted font-mono-code">
                {typeof change.kind === "string" ? change.kind : "modify"}:{" "}
                {typeof change.path === "string" ? change.path : filePath || "(unknown file)"}
              </span>
              {typeof change.path === "string" && (
                <DiffOpenFileButton
                  filePath={change.path}
                  cwd={sessionCwd}
                  line={getFirstChangedLineForEditFile(parsed, change.path)}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {!!input.replace_all && (
        <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-warning/10 text-cc-warning">
          replace all
        </span>
      )}
      <DiffViewer oldText={oldStr} newText={newStr} mode="full" />
    </div>
  );
}

function WriteToolDetail({ input, sessionId }: { input: Record<string, unknown>; sessionId?: string }) {
  const { filePath, content, changes, unifiedDiff } = useMemo(() => parseWriteToolInput(input), [input]);

  // Session cwd for the changes-list Open File buttons only
  const sessionCwd = useStore((s) => {
    if (!sessionId) return null;
    return s.sessions.get(sessionId)?.cwd ?? s.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd ?? null;
  });

  // File path and Open File button are now in the ToolBlock header

  if (!content && unifiedDiff) {
    return <DiffViewer unifiedDiff={unifiedDiff} mode="full" />;
  }

  if (!content && changes.length > 0) {
    return (
      <div className="space-y-1.5">
        <div className="text-[10px] text-cc-muted uppercase tracking-wider">Applied changes</div>
        <div className="space-y-1">
          {changes.map((change, i) => (
            <div
              key={`${typeof change.path === "string" ? change.path : "file"}-${i}`}
              className="flex items-center justify-between gap-3 rounded-md border border-cc-border/70 px-2 py-1.5"
            >
              <span className="min-w-0 text-[11px] text-cc-muted font-mono-code">
                {typeof change.kind === "string" ? change.kind : "create"}:{" "}
                {typeof change.path === "string" ? change.path : filePath || "(unknown file)"}
              </span>
              {typeof change.path === "string" && (
                <DiffOpenFileButton filePath={change.path} cwd={sessionCwd} line={1} />
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <DiffViewer newText={content} mode="full" />;
}

function ReadToolDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || input.path || "");
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;

  return (
    <div className="space-y-1">
      <div className="text-xs text-cc-muted font-mono-code">{filePath}</div>
      {(offset != null || limit != null) && (
        <div className="flex gap-2 text-[10px] text-cc-muted">
          {offset != null && <span>offset: {offset}</span>}
          {limit != null && <span>limit: {limit}</span>}
        </div>
      )}
    </div>
  );
}

function GlobDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-mono-code text-cc-code-fg">{String(input.pattern || "")}</div>
      {!!input.path && (
        <div className="text-[10px] text-cc-muted">
          in: <span className="font-mono-code">{String(input.path)}</span>
        </div>
      )}
    </div>
  );
}

function GrepDetail({ input }: { input: Record<string, unknown> }) {
  const pattern = String(input.pattern || "");
  return (
    <div className="space-y-1">
      <div className="group/code relative rounded overflow-hidden">
        <div className="absolute top-1 right-1 z-10">
          <CodeCopyButton text={pattern} />
        </div>
        <pre className="px-2 py-1.5 rounded bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code overflow-x-auto">
          {pattern}
        </pre>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-cc-muted">
        {!!input.path && (
          <span>
            path: <span className="font-mono-code">{String(input.path)}</span>
          </span>
        )}
        {!!input.glob && (
          <span>
            glob: <span className="font-mono-code">{String(input.glob)}</span>
          </span>
        )}
        {!!input.output_mode && <span>mode: {String(input.output_mode)}</span>}
        {!!input.context && <span>context: {String(input.context)}</span>}
        {!!input.head_limit && <span>limit: {String(input.head_limit)}</span>}
      </div>
    </div>
  );
}

function extractWebSearchQuery(input: Record<string, unknown>): string {
  if (typeof input.query === "string" && input.query.trim()) return input.query.trim();
  if (typeof input.q === "string" && input.q.trim()) return input.q.trim();

  const searchQuery = input.search_query;
  if (Array.isArray(searchQuery)) {
    for (const entry of searchQuery) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.q === "string" && rec.q.trim()) return rec.q.trim();
      if (typeof rec.query === "string" && rec.query.trim()) return rec.query.trim();
    }
  }

  const action = input.action;
  if (action && typeof action === "object") {
    const actionRec = action as Record<string, unknown>;
    if (typeof actionRec.query === "string" && actionRec.query.trim()) return actionRec.query.trim();
    if (typeof actionRec.q === "string" && actionRec.q.trim()) return actionRec.q.trim();
    if (typeof actionRec.pattern === "string" && actionRec.pattern.trim()) return actionRec.pattern.trim();
  }

  return "";
}

function extractWebSearchDomains(input: Record<string, unknown>): string[] {
  const directDomains = input.allowed_domains;
  if (Array.isArray(directDomains)) {
    const domains = directDomains.filter((d): d is string => typeof d === "string" && d.trim().length > 0);
    if (domains.length > 0) return domains;
  }

  const searchQuery = input.search_query;
  if (Array.isArray(searchQuery)) {
    for (const entry of searchQuery) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const recDomains = rec.domains;
      if (!Array.isArray(recDomains)) continue;
      const domains = recDomains.filter((d): d is string => typeof d === "string" && d.trim().length > 0);
      if (domains.length > 0) return domains;
    }
  }

  return [];
}

function WebSearchDetail({ input }: { input: Record<string, unknown> }) {
  const query = extractWebSearchQuery(input);
  const domains = extractWebSearchDomains(input);

  return (
    <div className="space-y-1">
      {query ? <div className="text-xs text-cc-fg font-medium">{query}</div> : null}
      {domains.length > 0 && <div className="text-[10px] text-cc-muted">domains: {domains.join(", ")}</div>}
    </div>
  );
}

function WebFetchDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      {!!input.url && <div className="text-xs font-mono-code text-cc-primary truncate">{String(input.url)}</div>}
      {!!input.prompt && <div className="text-[11px] text-cc-muted italic line-clamp-2">{String(input.prompt)}</div>}
    </div>
  );
}

function TaskDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1.5">
      {!!input.description && <div className="text-xs text-cc-fg font-medium">{String(input.description)}</div>}
      {!!input.subagent_type && (
        <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary">
          {String(input.subagent_type)}
        </span>
      )}
      {!!input.prompt && (
        <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
          {String(input.prompt)}
        </pre>
      )}
    </div>
  );
}

function TodoWriteDetail({ input }: { input: Record<string, unknown> }) {
  const todos = input.todos as Array<{ content?: string; status?: string; activeForm?: string }> | undefined;
  if (!Array.isArray(todos)) {
    return (
      <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
        {JSON.stringify(input, null, 2)}
      </pre>
    );
  }

  return (
    <div className="space-y-0.5">
      {todos.map((todo, i) => {
        const status = todo.status || "pending";
        return (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className="shrink-0 mt-0.5">
              {status === "completed" ? (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success">
                  <path
                    fillRule="evenodd"
                    d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : status === "in_progress" ? (
                <svg className="w-3.5 h-3.5 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="28"
                    strokeDashoffset="8"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-muted">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              )}
            </span>
            <span
              className={`text-[11px] leading-snug ${status === "completed" ? "text-cc-muted line-through" : "text-cc-fg"}`}
            >
              {todo.content || "Task"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function NotebookEditDetail({ input }: { input: Record<string, unknown> }) {
  const path = String(input.notebook_path || "");
  const cellType = input.cell_type as string | undefined;
  const editMode = input.edit_mode as string | undefined;

  return (
    <div className="space-y-1">
      <div className="text-xs font-mono-code text-cc-muted">{path}</div>
      <div className="flex gap-2 text-[10px] text-cc-muted">
        {cellType && <span>type: {cellType}</span>}
        {editMode && <span>mode: {editMode}</span>}
        {input.cell_number != null && <span>cell: {String(input.cell_number)}</span>}
      </div>
      {!!input.new_source && (
        <div className="group/code relative rounded overflow-hidden">
          <div className="absolute top-1 right-1 z-10">
            <CodeCopyButton text={String(input.new_source)} />
          </div>
          <pre className="px-2 py-1.5 rounded bg-cc-code-bg text-cc-code-fg text-[11px] font-mono-code leading-relaxed max-h-40 overflow-y-auto">
            {String(input.new_source)}
          </pre>
        </div>
      )}
    </div>
  );
}

function SendMessageDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      {!!input.recipient && (
        <div className="text-[11px] text-cc-muted">
          to: <span className="font-medium text-cc-fg">{String(input.recipient)}</span>
        </div>
      )}
      {!!input.content && <div className="text-xs text-cc-fg whitespace-pre-wrap">{String(input.content)}</div>}
    </div>
  );
}

function ExitPlanModeDetail({ input }: { input: Record<string, unknown> }) {
  const plan = typeof input.plan === "string" ? input.plan : "";
  const allowedPrompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];
  const planContentRef = useRef<HTMLDivElement>(null);

  return (
    <div className="space-y-2">
      {plan && (
        <div className="relative max-h-96 overflow-y-auto">
          <div className="absolute top-0 right-0 z-10">
            <CopyFormatButton
              markdownText={plan}
              getHtml={() => planContentRef.current?.innerHTML ?? ""}
              title="Copy plan"
            />
          </div>
          <div ref={planContentRef} className="pr-7">
            <MarkdownContent text={plan} size="sm" />
          </div>
        </div>
      )}
      {allowedPrompts.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-cc-muted uppercase tracking-wider">Requested permissions</div>
          <div className="space-y-1">
            {allowedPrompts.map((p: Record<string, unknown>, i: number) => (
              <div
                key={i}
                className="flex items-center gap-2 text-[11px] font-mono-code bg-cc-code-bg/30 rounded-lg px-2.5 py-1.5"
              >
                <span className="text-cc-muted shrink-0">{String(p.tool || "")}</span>
                <span className="text-cc-fg">{String(p.prompt || "")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!plan && allowedPrompts.length === 0 && <div className="text-xs text-cc-muted">Plan approval requested</div>}
    </div>
  );
}

function AskUserQuestionDetail({ input }: { input: Record<string, unknown> }) {
  const questions = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];

  return (
    <div className="space-y-2">
      {questions.map((q, i) => {
        const header = typeof q.header === "string" ? q.header : "";
        const question = typeof q.question === "string" ? q.question : "";
        const options = Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [];
        return (
          <div key={i} className="space-y-1.5">
            {header && (
              <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary">
                {header}
              </span>
            )}
            {question && <div className="text-xs text-cc-fg font-medium">{question}</div>}
            {options.length > 0 && (
              <div className="space-y-1">
                {options.map((opt, j) => {
                  const label = typeof opt.label === "string" ? opt.label : "";
                  const desc = typeof opt.description === "string" ? opt.description : "";
                  return (
                    <div
                      key={j}
                      className="flex items-start gap-2 text-[11px] bg-cc-code-bg/30 rounded-lg px-2.5 py-1.5"
                    >
                      <span className="text-cc-fg font-medium shrink-0">{label}</span>
                      {desc && <span className="text-cc-muted">{desc}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Preview ────────────────────────────────────────────────────────────────

export function getPreview(name: string, input: Record<string, unknown>): string {
  if (name === "Bash" && typeof input.command === "string") {
    // Prefer description if short enough, otherwise show command
    if (input.description && typeof input.description === "string" && input.description.length <= 60) {
      return input.description;
    }
    return input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
  }
  if ((name === "Read" || name === "Write" || name === "Edit") && input.file_path) {
    return String(input.file_path);
  }
  if (name === "Glob" && input.pattern) return String(input.pattern);
  if (name === "Grep" && input.pattern) {
    const p = String(input.pattern);
    const suffix = input.path ? ` in ${String(input.path).split("/").slice(-2).join("/")}` : "";
    const full = p + suffix;
    return full.length > 60 ? full.slice(0, 60) + "..." : full;
  }
  if (name === "WebSearch" || name === "web_search") {
    return extractWebSearchQuery(input);
  }
  if (name === "WebFetch" && input.url) {
    try {
      const u = new URL(String(input.url));
      return u.hostname + u.pathname;
    } catch {
      return String(input.url).slice(0, 60);
    }
  }
  if (isSubagentToolName(name) && input.description) return String(input.description);
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    const todos = input.todos as Array<{ content?: string; activeForm?: string; status?: string }>;
    const completed = todos.filter((t) => t.status === "completed").length;
    const inProgress = todos.find((t) => t.status === "in_progress");
    const label = inProgress?.activeForm || inProgress?.content;
    if (label) {
      const remaining = todos.length - completed;
      const short = label.length > 45 ? label.slice(0, 45) + "..." : label;
      return `${short} (${remaining} left)`;
    }
    return `${completed}/${todos.length} done`;
  }
  if (name === "NotebookEdit" && input.notebook_path) {
    return String(input.notebook_path).split("/").pop() || "";
  }
  if (name === "SendMessage" && input.recipient) {
    return `\u2192 ${String(input.recipient)}`;
  }
  if (name === "ExitPlanMode") {
    const plan = typeof input.plan === "string" ? input.plan : "";
    if (plan) {
      const firstLine = plan.split("\n").find((l: string) => l.trim()) || "";
      return firstLine.length > 60 ? firstLine.slice(0, 60) + "..." : firstLine;
    }
    return "Plan approval";
  }
  if (name === "EnterPlanMode") return "Entering plan mode";
  if (name === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    if (questions.length > 0) {
      const q = (questions[0] as Record<string, unknown>).question;
      if (typeof q === "string") return q.length > 60 ? q.slice(0, 60) + "..." : q;
    }
    return "Question";
  }
  return "";
}

// ─── Icons ──────────────────────────────────────────────────────────────────

export function ToolIcon({ type }: { type: string }) {
  const cls = "w-3.5 h-3.5 text-cc-primary shrink-0";

  if (type === "terminal") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <polyline points="3 11 6 8 3 5" />
        <line x1="8" y1="11" x2="13" y2="11" />
      </svg>
    );
  }
  if (type === "file" || type === "file-plus" || type === "file-edit") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
        <polyline points="9 1 9 5 13 5" />
      </svg>
    );
  }
  if (type === "search") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="7" cy="7" r="4" />
        <path d="M13 13l-3-3" />
      </svg>
    );
  }
  if (type === "globe") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 2 3 4 3 6s-1 4-3 6c-2-2-3-4-3-6s1-4 3-6z" />
      </svg>
    );
  }
  if (type === "message") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M14 10a1 1 0 01-1 1H5l-3 3V3a1 1 0 011-1h10a1 1 0 011 1v7z" />
      </svg>
    );
  }
  if (type === "list") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M3 4h10M3 8h10M3 12h6" />
      </svg>
    );
  }
  if (type === "agent") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="8" cy="5" r="3" />
        <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "checklist") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M3 4l1.5 1.5L7 3M3 8l1.5 1.5L7 7M3 12l1.5 1.5L7 11" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 4h4M9 8h4M9 12h4" />
      </svg>
    );
  }
  if (type === "notebook") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <rect x="3" y="1" width="10" height="14" rx="1" />
        <path d="M6 1v14M3 5h3M3 9h3M3 13h3" />
      </svg>
    );
  }
  if (type === "plan") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <rect x="3" y="2" width="10" height="12" rx="1" />
        <path d="M6 5h4M6 8h4M6 11h2" />
      </svg>
    );
  }
  if (type === "question") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="8" cy="8" r="6" />
        <path d="M6.5 6.5a1.5 1.5 0 012.6 1c0 1-1.6 1-1.6 2" strokeLinecap="round" />
        <circle cx="8" cy="12" r="0.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  // Default tool icon
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
      <path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8z" />
    </svg>
  );
}
