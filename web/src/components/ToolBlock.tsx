import { useState, useEffect, useRef, memo } from "react";
import { isSubagentToolName } from "../types.js";
import { DiffViewer } from "./DiffViewer.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CodeCopyButton } from "./CodeCopyButton.js";
import { CollapseFooter } from "./CollapseFooter.js";
import { CopyFormatButton } from "./CopyFormatButton.js";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { parseEditToolInput, parseWriteToolInput } from "../utils/tool-rendering.js";
import { isEmbeddedInVsCode } from "../utils/embed-context.js";
import { openFileInEmbeddedVsCode, resolveEmbeddedVsCodePath } from "../utils/vscode-bridge.js";

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
  // Tool result preview (present once the tool has completed)
  const toolResult = useStore((s) =>
    s.toolResults.get(sessionId)?.get(toolUseId)
  );
  const finalDuration = toolResult?.duration_seconds;
  const progressElapsedSeconds = useStore((s) =>
    s.toolProgress.get(sessionId)?.get(toolUseId)?.elapsedSeconds
  );
  // Server start timestamp (from tool_start_times on the assistant message)
  const startTimestamp = useStore((s) =>
    s.toolStartTimestamps.get(sessionId)?.get(toolUseId)
  );

  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // If we have the final duration or the tool has completed (result exists
    // but duration_seconds is missing — e.g. server restarted mid-tool and
    // lost the transient start time), no need for a live timer.
    if (finalDuration != null || toolResult != null) {
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
  }, [finalDuration, startTimestamp, toolResult]);

  // Show final duration (static) or live timer
  const liveElapsedSeconds = liveSeconds ?? progressElapsedSeconds ?? null;
  const displaySeconds = finalDuration ?? (toolResult == null ? liveElapsedSeconds : null);
  if (displaySeconds == null) return null;

  const isLive = finalDuration == null;
  return (
    <span className={`text-[10px] tabular-nums shrink-0 ${isLive ? "text-cc-primary" : "text-cc-muted"}`}>
      {formatDuration(displaySeconds)}
    </span>
  );
}

export const ToolBlock = memo(function ToolBlock({
  name,
  input,
  toolUseId,
  sessionId,
}: {
  name: string;
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId?: string;
}) {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLButtonElement>(null);
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);

  // Extract the most useful preview
  const preview = getPreview(name, input);

  // TodoWrite: flat inline view with status icon + active task + count
  if (name === "TodoWrite" && Array.isArray((input as Record<string, unknown>).todos)) {
    return <TodoWriteInline input={input} />;
  }

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <button
        ref={headerRef}
        onClick={() => setOpen(!open)}
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
        <span className="text-xs font-medium text-cc-fg">{label}</span>
        {preview && (
          <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
            {preview}
          </span>
        )}
        {sessionId && <ToolDurationBadge toolUseId={toolUseId} sessionId={sessionId} />}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-0 border-t border-cc-border">
          <div className="mt-2">
            <ToolDetail name={name} input={input} sessionId={sessionId} />
          </div>
          {sessionId && !isSubagentToolName(name) && (
            <ToolResultSection
              toolUseId={toolUseId}
              sessionId={sessionId}
              toolName={name}
              input={input}
            />
          )}
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
        <span className="text-xs leading-snug truncate text-cc-fg">
          {label}
        </span>
        <span className="text-[11px] text-cc-muted shrink-0 tabular-nums">
          ({todos.length} tasks)
        </span>
      </div>
    );
  }

  // Subsequent calls: show the last completed item with a checkmark
  const lastCompleted = [...todos].reverse().find((t) => t.status === "completed");
  const highlightText = lastCompleted?.content || lastCompleted?.activeForm || "Task";

  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success shrink-0">
        <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
      </svg>
      <span className="text-xs leading-snug truncate text-cc-muted line-through">
        {highlightText}
      </span>
      <span className="text-[11px] text-cc-muted shrink-0 tabular-nums">
        ({completed}/{todos.length})
      </span>
    </div>
  );
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
  const directCandidates = [
    input.file_path,
    input.path,
    input.filePath,
    input.filename,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && isLikelyImagePath(candidate)) return candidate;
  }

  // Codex often maps file reads to Bash commandExecution. If the command clearly
  // targets an image path, use that for the preview thumbnail.
  if (toolName === "Bash" && typeof input.command === "string") {
    const match = input.command.match(/(?:^|[\s'"])([^\s'"]+\.(?:png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|heif|tiff?))/i);
    if (match?.[1]) return match[1];
  }
  return null;
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
  const preview = useStore((s) => s.toolResults.get(sessionId)?.get(toolUseId));
  const progress = useStore((s) => s.toolProgress.get(sessionId)?.get(toolUseId));
  const imagePath = extractImagePathForPreview(toolName, input);
  const isReadImage = !!imagePath;
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const liveOutput = progress?.output || "";

  // Suppress the result section for web search when the result just echoes the
  // query or is a generic placeholder — the query is already shown in ToolDetail.
  if (
    preview
    && !preview.is_error
    && (toolName === "WebSearch" || toolName === "web_search")
  ) {
    const query = extractWebSearchQuery(input);
    const content = preview.content.trim();
    if (!content || content === query || content === "Web search completed") {
      return null;
    }
  }

  // Suppress the result section for successful Edit/Write calls — the diff
  // already shows the edit succeeded, and the "file has been updated" message
  // is redundant. Only show the result section when the edit failed.
  if (
    preview
    && !preview.is_error
    && (toolName === "Edit" || toolName === "Write")
  ) {
    return null;
  }

  if (!preview) {
    if (!progress) return null;
    return (
      <div className="mt-2 pt-2 border-t border-cc-border/50">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-medium text-cc-muted uppercase tracking-wider">Live output</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary font-medium">running</span>
          {progress.outputTruncated && (
            <span className="text-[10px] text-cc-muted">showing latest 12KB</span>
          )}
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
    return (
      <div className="mt-2 pt-2 border-t border-cc-border/50">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-medium text-cc-muted uppercase tracking-wider">Result</span>
          <span className="text-[10px] text-cc-muted">image preview</span>
        </div>
        <div className="rounded-lg border border-cc-border bg-cc-code-bg/40 p-2">
          <img
            src={api.getFsImageUrl(imagePath)}
            alt={imagePath}
            className="max-h-48 w-auto rounded border border-cc-border/70 bg-black/10"
          />
          <div className="mt-1 text-[10px] text-cc-muted">Binary image output hidden.</div>
        </div>
      </div>
    );
  }

  const displayContent = fullContent ?? preview.content;
  const showExpandButton = preview.is_truncated && fullContent === null;

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
        <pre className={`text-[11px] font-mono-code whitespace-pre leading-relaxed rounded-lg px-2.5 py-2 ${
          fullContent === null ? "max-h-40" : "max-h-96"
        } overflow-y-auto overflow-x-auto ${
          preview.is_error
            ? "bg-cc-error/5 border border-cc-error/20 text-cc-error"
            : "bg-cc-code-bg text-cc-muted"
        }`}>
          {showExpandButton ? "..." : ""}{displayContent}
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

function getFirstChangedLineFromEditPayload(parsed: ReturnType<typeof parseEditToolInput>): number {
  const firstHunkMatch = parsed.unifiedDiff.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/m);
  if (firstHunkMatch) {
    const nextLine = Number.parseInt(firstHunkMatch[1], 10);
    if (Number.isFinite(nextLine) && nextLine > 0) {
      return nextLine;
    }
  }
  return 1;
}

function EmbeddedDiffOpenFileButton({
  filePath,
  sessionId,
  line,
}: {
  filePath: string;
  sessionId?: string;
  line: number;
}) {
  const sessionCwd = useStore((s) => {
    if (!sessionId) return null;
    return s.sessions.get(sessionId)?.cwd ?? s.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd ?? null;
  });
  const isEmbedded = isEmbeddedInVsCode();
  const absolutePath = resolveEmbeddedVsCodePath(filePath, sessionCwd);
  if (!isEmbedded || !absolutePath) return null;

  return (
    <button
      type="button"
      className="diff-file-action-btn"
      onClick={() => {
        openFileInEmbeddedVsCode({
          absolutePath,
          line,
          column: 1,
        });
      }}
      title="Open this file in VS Code"
    >
      Open File
    </button>
  );
}

function BashDetail({ input }: { input: Record<string, unknown> }) {
  const command = String(input.command || "");
  return (
    <div className="space-y-1.5">
      {!!input.description && (
        <div className="text-[11px] text-cc-muted italic">{String(input.description)}</div>
      )}
      <div className="group/code relative rounded-lg overflow-hidden">
        <div className="absolute top-1.5 right-1.5 z-10">
          <CodeCopyButton text={command} />
        </div>
        <pre className="px-3 py-2 rounded-lg bg-cc-code-bg text-cc-code-fg text-[12px] font-mono-code leading-relaxed overflow-x-auto">
          <span className="text-cc-muted select-none">$ </span>
          {command}
        </pre>
      </div>
      {!!input.timeout && (
        <div className="text-[10px] text-cc-muted">timeout: {String(input.timeout)}ms</div>
      )}
    </div>
  );
}

function EditToolDetail({ input, sessionId }: { input: Record<string, unknown>; sessionId?: string }) {
  const {
    filePath,
    oldText: oldStr,
    newText: newStr,
    changes,
    unifiedDiff,
  } = parseEditToolInput(input);
  const openFileButton = <EmbeddedDiffOpenFileButton filePath={filePath} sessionId={sessionId} line={getFirstChangedLineFromEditPayload({ filePath, oldText: oldStr, newText: newStr, changes, unifiedDiff })} />;

  if (!oldStr && !newStr && unifiedDiff) {
    return <DiffViewer unifiedDiff={unifiedDiff} fileName={filePath} mode="full" headerActions={openFileButton} />;
  }

  if (!oldStr && !newStr && changes.length > 0) {
    return (
      <div className="space-y-1.5">
        {openFileButton}
        <div className="text-[10px] text-cc-muted uppercase tracking-wider">Applied changes</div>
        <div className="space-y-1">
          {changes.map((change, i) => (
            <div
              key={`${typeof change.path === "string" ? change.path : "file"}-${i}`}
              className="text-[11px] text-cc-muted font-mono-code"
            >
              {(typeof change.kind === "string" ? change.kind : "modify")}: {typeof change.path === "string" ? change.path : (filePath || "(unknown file)")}
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
      <DiffViewer oldText={oldStr} newText={newStr} fileName={filePath} mode="full" headerActions={openFileButton} />
    </div>
  );
}

function WriteToolDetail({ input, sessionId }: { input: Record<string, unknown>; sessionId?: string }) {
  const { filePath, content } = parseWriteToolInput(input);
  const openFileButton = <EmbeddedDiffOpenFileButton filePath={filePath} sessionId={sessionId} line={1} />;

  return <DiffViewer newText={content} fileName={filePath} mode="full" headerActions={openFileButton} />;
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
          <span>path: <span className="font-mono-code">{String(input.path)}</span></span>
        )}
        {!!input.glob && (
          <span>glob: <span className="font-mono-code">{String(input.glob)}</span></span>
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
      {domains.length > 0 && (
        <div className="text-[10px] text-cc-muted">
          domains: {domains.join(", ")}
        </div>
      )}
    </div>
  );
}

function WebFetchDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      {!!input.url && (
        <div className="text-xs font-mono-code text-cc-primary truncate">{String(input.url)}</div>
      )}
      {!!input.prompt && (
        <div className="text-[11px] text-cc-muted italic line-clamp-2">{String(input.prompt)}</div>
      )}
    </div>
  );
}

function TaskDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1.5">
      {!!input.description && (
        <div className="text-xs text-cc-fg font-medium">{String(input.description)}</div>
      )}
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
                  <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
                </svg>
              ) : status === "in_progress" ? (
                <svg className="w-3.5 h-3.5 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-muted">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              )}
            </span>
            <span className={`text-[11px] leading-snug ${status === "completed" ? "text-cc-muted line-through" : "text-cc-fg"}`}>
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
      {!!input.content && (
        <div className="text-xs text-cc-fg whitespace-pre-wrap">{String(input.content)}</div>
      )}
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
              <div key={i} className="flex items-center gap-2 text-[11px] font-mono-code bg-cc-code-bg/30 rounded-lg px-2.5 py-1.5">
                <span className="text-cc-muted shrink-0">{String(p.tool || "")}</span>
                <span className="text-cc-fg">{String(p.prompt || "")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!plan && allowedPrompts.length === 0 && (
        <div className="text-xs text-cc-muted">Plan approval requested</div>
      )}
    </div>
  );
}

function AskUserQuestionDetail({ input }: { input: Record<string, unknown> }) {
  const questions = Array.isArray(input.questions) ? input.questions as Record<string, unknown>[] : [];

  return (
    <div className="space-y-2">
      {questions.map((q, i) => {
        const header = typeof q.header === "string" ? q.header : "";
        const question = typeof q.question === "string" ? q.question : "";
        const options = Array.isArray(q.options) ? q.options as Record<string, unknown>[] : [];
        return (
          <div key={i} className="space-y-1.5">
            {header && (
              <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary">
                {header}
              </span>
            )}
            {question && (
              <div className="text-xs text-cc-fg font-medium">{question}</div>
            )}
            {options.length > 0 && (
              <div className="space-y-1">
                {options.map((opt, j) => {
                  const label = typeof opt.label === "string" ? opt.label : "";
                  const desc = typeof opt.description === "string" ? opt.description : "";
                  return (
                    <div key={j} className="flex items-start gap-2 text-[11px] bg-cc-code-bg/30 rounded-lg px-2.5 py-1.5">
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
    const path = String(input.file_path);
    return path.split("/").slice(-2).join("/");
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
