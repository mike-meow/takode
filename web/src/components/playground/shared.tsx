import { createContext, useContext, useEffect, useState } from "react";
import { api } from "../../api.js";
import { useStore } from "../../store.js";
import type { ChatMessage, McpServerDetail, TaskItem } from "../../types.js";
import { BoardBlock } from "../BoardBlock.js";
import { CatPawAvatar, YarnBallSpinner } from "../CatIcons.js";
import { ClaudeMdEditor } from "../ClaudeMdEditor.js";
import { FolderPicker } from "../FolderPicker.js";
import { Lightbox } from "../Lightbox.js";
import { MarkdownContent } from "../MarkdownContent.js";
import { MessageBubble, NotificationMarker, HerdEventMessage } from "../MessageBubble.js";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu.js";
import { PawTrailAvatar } from "../PawTrail.js";
import { StatusCountDots } from "../SessionItem.js";
import { CodexRateLimitsSection, CodexTokenDetailsSection } from "../TaskPanel.js";
import { TimerModal } from "../TimerWidget.js";
import { ToolBlock, getToolIcon, getToolLabel, getPreview, ToolIcon, formatDuration } from "../ToolBlock.js";
import { PLAYGROUND_SESSION_ROWS } from "./fixtures.js";
import { getPlaygroundSectionId, type PlaygroundSectionGroupId } from "./navigation.js";
import {
  THREAD_ROUTING_REMINDER_SOURCE_ID,
  THREAD_ROUTING_REMINDER_SOURCE_LABEL,
} from "../../../shared/thread-routing-reminder.js";
import {
  QUEST_THREAD_REMINDER_SOURCE_ID,
  QUEST_THREAD_REMINDER_SOURCE_LABEL,
} from "../../../shared/quest-thread-reminder.js";

const PlaygroundSectionGroupContext = createContext<PlaygroundSectionGroupId | null>(null);
const NEEDS_INPUT_REMINDER_SOURCE = {
  sessionId: "system:needs-input-reminder",
  sessionLabel: "Needs Input Reminder",
};

export function PlaygroundSectionGroup({
  groupId,
  children,
}: {
  groupId: PlaygroundSectionGroupId;
  children: React.ReactNode;
}) {
  return <PlaygroundSectionGroupContext.Provider value={groupId}>{children}</PlaygroundSectionGroupContext.Provider>;
}

export function PlaygroundHerdSummaryBar({ isExpanded }: { isExpanded: boolean }) {
  return (
    <div className="w-full flex items-center gap-1.5 px-3 py-1 border-t border-cc-border/30 text-[10px] text-cc-muted">
      <StatusCountDots counts={{ running: 2, permission: 1, unread: 0 }} />
      <span className="flex items-center gap-0.5 text-cc-muted/50">
        1
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-muted/30" />
      </span>
      <span className="ml-auto text-cc-muted/50 shrink-0">4 workers</span>
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        className={`w-3 h-3 text-cc-muted/40 shrink-0 ${isExpanded ? "rotate-180" : ""}`}
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    </div>
  );
}

export function PlaygroundBoardWithOriginalCommand() {
  useEffect(() => {
    const sessionResults = new Map();
    const resultContent = [
      JSON.stringify(
        {
          __takode_board__: true,
          board: [{ questId: "q-412", title: "Debug board command output", updatedAt: Date.now() - 15000 }],
          operation: "set q-412",
        },
        null,
        2,
      ),
      "",
      "Quest   Title                     Worker  State",
      "q-412   Debug board command output  --      Planning",
    ].join("\n");
    sessionResults.set("playground-board-original", {
      content: resultContent,
      is_error: false,
      is_truncated: false,
      total_size: resultContent.length,
    });
    const toolResults = new Map(useStore.getState().toolResults);
    toolResults.set("playground-board-original-session", sessionResults);
    useStore.setState({ toolResults });

    return () => {
      const nextToolResults = new Map(useStore.getState().toolResults);
      nextToolResults.delete("playground-board-original-session");
      useStore.setState({ toolResults: nextToolResults });
    };
  }, []);

  return (
    <BoardBlock
      board={[{ questId: "q-412", title: "Debug board command output", updatedAt: Date.now() - 15000 }]}
      operation="set q-412"
      toolUseId="playground-board-original"
      sessionId="playground-board-original-session"
      originalToolName="Bash"
      originalInput={{ command: "takode board show --json" }}
      originalCommand="takode board show --json"
      defaultShowOriginalCommand
    />
  );
}

export function PlaygroundCompletedViewImageTool() {
  useEffect(() => {
    const toolResults = new Map(useStore.getState().toolResults);
    const sessionResults = new Map(toolResults.get("playground-view-image-session") || []);
    sessionResults.set("tb-view-image", {
      tool_use_id: "tb-view-image",
      content: "/Users/stan/Dev/project/docs/bug-screenshot.png",
      is_error: false,
      is_truncated: false,
      total_size: 41,
      duration_seconds: 0.4,
    });
    toolResults.set("playground-view-image-session", sessionResults);
    useStore.setState({ toolResults });

    return () => {
      const nextToolResults = new Map(useStore.getState().toolResults);
      nextToolResults.delete("playground-view-image-session");
      useStore.setState({ toolResults: nextToolResults });
    };
  }, []);

  return (
    <ToolBlock
      name="view_image"
      input={{ path: "/Users/stan/Dev/project/docs/bug-screenshot.png" }}
      toolUseId="tb-view-image"
      sessionId="playground-view-image-session"
    />
  );
}

export function PlaygroundFolderPicker() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-xs font-medium rounded-md bg-cc-primary text-white hover:bg-cc-primary/90 transition-colors cursor-pointer"
      >
        Open Folder Picker
      </button>
      {selected && <p className="text-xs text-cc-muted font-mono-code">Selected: {selected}</p>}
      {open && (
        <FolderPicker
          initialPath={selected || ""}
          onSelect={(path) => setSelected(path)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const groupId = useContext(PlaygroundSectionGroupContext);
  const sectionId = groupId ? getPlaygroundSectionId(groupId, title) : undefined;

  return (
    <section id={sectionId} data-playground-section-id={sectionId} className="scroll-mt-28">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-cc-fg">{title}</h2>
        <p className="text-xs text-cc-muted mt-0.5">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card">
      <div className="px-3 py-1.5 bg-cc-hover/50 border-b border-cc-border">
        <span className="text-[10px] text-cc-muted font-mono-code uppercase tracking-wider">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─── Inline Tool Group (mirrors MessageFeed's ToolMessageGroup) ─────────────

export interface ToolItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export function PlaygroundToolGroup({ toolName, items }: { toolName: string; items: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(toolName);
  const label = getToolLabel(toolName);
  const count = items.length;

  if (count === 1) {
    const item = items[0];
    return (
      <div className="flex items-start gap-3">
        <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <CatPawAvatar className="w-3 h-3 text-cc-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
            <button
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
              <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
                {getPreview(item.name, item.input)}
              </span>
            </button>
            {open && (
              <div className="px-3 pb-3 pt-0 border-t border-cc-border mt-0">
                <pre className="mt-2 text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                  {JSON.stringify(item.input, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <CatPawAvatar className="w-3 h-3 text-cc-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          <button
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
            <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums font-medium">
              {count}
            </span>
          </button>
          {open && (
            <div className="border-t border-cc-border px-3 py-1.5">
              {items.map((item, i) => {
                const preview = getPreview(item.name, item.input);
                return (
                  <div
                    key={item.id || i}
                    className="flex items-center gap-2 py-1 text-xs text-cc-muted font-mono-code truncate"
                  >
                    <span className="w-1 h-1 rounded-full bg-cc-muted/40 shrink-0" />
                    <span className="truncate">{preview || JSON.stringify(item.input).slice(0, 80)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Inline Subagent Group (mirrors MessageFeed's SubagentContainer) ────────

export function PlaygroundSubagentGroup({
  description,
  agentType,
  items,
  resultText,
  prompt,
  durationSeconds,
  liveStartedAt,
  interrupted,
}: {
  description: string;
  agentType: string;
  items: ToolItem[];
  resultText?: string;
  prompt?: string;
  durationSeconds?: number;
  liveStartedAt?: number;
  interrupted?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [promptOpen, setPromptOpen] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!liveStartedAt || durationSeconds != null) {
      setLiveSeconds(null);
      return;
    }
    const tick = () => {
      setLiveSeconds(Math.max(0, Math.round((Date.now() - liveStartedAt) / 1000)));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [liveStartedAt, durationSeconds]);

  const displayDurationSeconds = durationSeconds ?? liveSeconds;

  return (
    <div className="flex items-start gap-3">
      <PawTrailAvatar />
      <div className="flex-1 min-w-0">
        <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          {/* Header */}
          <button
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
            <ToolIcon type="agent" />
            <span className="text-xs font-medium text-cc-fg truncate">{description}</span>
            {agentType && (
              <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">
                {agentType}
              </span>
            )}
            {!open && resultText && (
              <span className="text-[11px] text-cc-muted truncate ml-1 font-mono-code">
                {resultText.length > 120 ? resultText.slice(0, 120) + "..." : resultText}
              </span>
            )}
            {displayDurationSeconds != null && (
              <span
                className={`text-[10px] tabular-nums shrink-0 ${durationSeconds != null ? "text-cc-muted" : "text-cc-primary"}`}
              >
                {formatDuration(displayDurationSeconds)}
              </span>
            )}
            <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
              {items.length > 0 ? items.length : interrupted ? "—" : "0"}
            </span>
          </button>

          {/* Expanded content */}
          {open && (
            <div className="border-t border-cc-border">
              {/* Collapsible prompt section */}
              {prompt && (
                <div className="border-b border-cc-border/50">
                  <button
                    onClick={() => setPromptOpen(!promptOpen)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${promptOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-medium text-cc-muted">Prompt</span>
                  </button>
                  {promptOpen && (
                    <div className="px-3 pb-2">
                      <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                        {prompt}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {/* Child activities */}
              {items.length > 0 && (
                <div className="border-b border-cc-border/50">
                  <button
                    onClick={() => setActivitiesOpen(!activitiesOpen)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${activitiesOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-medium text-cc-muted">Activities</span>
                  </button>
                  {activitiesOpen && (
                    <div className="px-3 pb-2 space-y-3">
                      <PlaygroundToolGroup toolName={items[0]?.name || "Grep"} items={items} />
                    </div>
                  )}
                </div>
              )}

              {/* No children yet indicator */}
              {items.length === 0 && !resultText && !interrupted && (
                <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-cc-muted">
                  <YarnBallSpinner className="w-3.5 h-3.5" />
                  <span>Agent starting...</span>
                </div>
              )}

              {/* Interrupted subagent — session ended without completion */}
              {items.length === 0 && interrupted && (
                <div className="px-3 py-2 text-[11px] text-cc-muted">Agent interrupted</div>
              )}

              {/* Result */}
              {resultText && (
                <div className="border-t border-cc-border/50">
                  <button
                    onClick={() => setResultOpen(!resultOpen)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${resultOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-medium text-cc-muted">Result</span>
                  </button>
                  {resultOpen && (
                    <div className="px-3 pb-2">
                      <div className="text-sm max-h-96 overflow-y-auto">
                        <MarkdownContent text={resultText} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Codex Session Demo (injects mock Codex data into a temp session) ────────

export const CODEX_DEMO_SESSION = "codex-playground-demo";

export function CodexPlaygroundDemo() {
  useEffect(() => {
    const store = useStore.getState();
    const prev = store.sessions.get(CODEX_DEMO_SESSION);

    // Create a fake Codex session with rate limits and token details
    store.addSession({
      session_id: CODEX_DEMO_SESSION,
      backend_type: "codex",
      model: "o3",
      cwd: "/Users/demo/project",
      tools: [],
      permissionMode: "bypassPermissions",
      claude_code_version: "0.1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 8,
      context_used_percent: 45,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/Users/demo/project",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      codex_rate_limits: {
        primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: Date.now() + 2 * 3_600_000 },
        secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: Date.now() + 5 * 86_400_000 },
      },
      codex_token_details: {
        inputTokens: 84_230,
        outputTokens: 12_450,
        cachedInputTokens: 41_200,
        reasoningOutputTokens: 8_900,
        modelContextWindow: 200_000,
      },
    });

    return () => {
      useStore.setState((s) => {
        const sessions = new Map(s.sessions);
        if (prev) sessions.set(CODEX_DEMO_SESSION, prev);
        else sessions.delete(CODEX_DEMO_SESSION);
        return { sessions };
      });
    };
  }, []);

  return (
    <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
      <CodexRateLimitsSection sessionId={CODEX_DEMO_SESSION} />
      <CodexTokenDetailsSection sessionId={CODEX_DEMO_SESSION} />
    </div>
  );
}

export function PlaygroundHerdEventDemo({ id, content }: { id: string; content: string }) {
  useEffect(() => {
    const prevSdkSessions = useStore.getState().sdkSessions;
    const prevSessionNames = useStore.getState().sessionNames;

    useStore.setState({
      sdkSessions: [
        ...prevSdkSessions.filter((session) => session.sessionId !== "worker-alpha"),
        {
          sessionId: "worker-alpha",
          sessionNum: 8,
          createdAt: 1,
          cwd: "/Users/stan/Dev/takode",
          state: "running",
          model: "gpt-5.4-mini",
          backendType: "codex",
          cliConnected: true,
        },
      ],
      sessionNames: new Map(prevSessionNames).set("worker-alpha", "Worker Alpha"),
    });

    return () => {
      useStore.setState({
        sdkSessions: prevSdkSessions,
        sessionNames: prevSessionNames,
      });
    };
  }, []);

  return (
    <HerdEventMessage
      showTimestamp={false}
      message={{
        id,
        role: "user",
        content,
        timestamp: Date.now(),
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      }}
    />
  );
}

// ─── Inline ClaudeMd Button (opens the real editor modal) ───────────────────

export function PlaygroundClaudeMdButton() {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("/tmp");

  useEffect(() => {
    api
      .getHome()
      .then((res) => setCwd(res.cwd))
      .catch(() => {});
  }, []);

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-hover border border-cc-border hover:bg-cc-active transition-colors cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-primary">
          <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
        </svg>
        <span className="text-xs font-medium text-cc-fg">Edit CLAUDE.md</span>
      </button>
      <span className="text-[11px] text-cc-muted">Click to open the editor modal (uses server working directory)</span>
      <ClaudeMdEditor cwd={cwd} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

export function PlaygroundReviewNotificationMarker({ summary }: { summary?: string }) {
  const [done, setDone] = useState(false);

  return (
    <NotificationMarker
      category="review"
      summary={summary}
      doneOverride={done}
      onToggleDone={() => setDone((prev) => !prev)}
      showReplyAction={false}
    />
  );
}

export function PlaygroundSuggestedAnswerNotificationMarker() {
  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set("playground-suggested-notify", [
      {
        id: "n-suggested-1",
        category: "needs-input",
        timestamp: Date.now() - 30_000,
        messageId: "playground-suggested-notify-msg",
        summary: "Approve the rollout?",
        suggestedAnswers: ["yes", "no"],
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, []);

  return (
    <NotificationMarker
      category="needs-input"
      summary="Approve the rollout?"
      sessionId="playground-suggested-notify"
      messageId="playground-suggested-notify-msg"
      notificationId="n-suggested-1"
    />
  );
}

export function PlaygroundAddressedSuggestedAnswerNotificationMarker() {
  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set("playground-addressed-suggested-notify", [
      {
        id: "n-addressed-suggested-1",
        category: "needs-input",
        timestamp: Date.now() - 30_000,
        messageId: "playground-addressed-suggested-notify-msg",
        summary: "Approve the rollout?",
        suggestedAnswers: ["yes", "no"],
        done: true,
      },
    ]);
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, []);

  return (
    <NotificationMarker
      category="needs-input"
      summary="Approve the rollout?"
      sessionId="playground-addressed-suggested-notify"
      messageId="playground-addressed-suggested-notify-msg"
      notificationId="n-addressed-suggested-1"
    />
  );
}

export function PlaygroundDedupedNotificationMessage() {
  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set("playground-dedup-notify", [
      {
        id: "playground-dedup-notif-1",
        category: "review",
        timestamp: Date.now() - 15_000,
        messageId: "playground-dedup-msg",
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, []);

  const message: ChatMessage = {
    id: "playground-dedup-msg",
    role: "assistant",
    content: "I have the result. I'll send the notification summary and then give you the exact observed behavior.",
    timestamp: Date.now() - 15_000,
    contentBlocks: [
      {
        type: "tool_use",
        id: "playground-dedup-tool",
        name: "Bash",
        input: { command: 'TAKODE_API_PORT=3455 takode notify review "Async command experiment finished"' },
      },
    ],
    notification: {
      category: "review",
      timestamp: Date.now() - 15_000,
      summary: "Async command experiment finished",
    },
  };

  return (
    <div className="p-3">
      <p className="mb-3 text-xs text-cc-muted">
        Same-message dedupe: the authoritative notification marker stays visible, while the matching `takode notify`
        tool-use in the same assistant message does not render a second chip.
      </p>
      <MessageBubble message={message} sessionId="playground-dedup-notify" showTimestamp={false} />
    </div>
  );
}

export function PlaygroundAddressedNotifyToolBlock() {
  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set("playground-addressed-notify", [
      {
        id: "playground-addressed-notif-1",
        category: "needs-input",
        timestamp: Date.now() - 20_000,
        messageId: "playground-addressed-msg",
        summary: "Confirm scope before continuing",
        done: true,
      },
    ]);
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, []);

  return (
    <ToolBlock
      name="Bash"
      input={{ command: 'takode notify needs-input "Confirm scope before continuing"' }}
      toolUseId="playground-addressed-notify-tool"
      sessionId="playground-addressed-notify"
      parentMessageId="playground-addressed-msg"
    />
  );
}

export function PlaygroundNeedsInputReminderMessage({ variant }: { variant: "resolved" | "active" | "partial" }) {
  const sessionId = `playground-needs-input-reminder-${variant}`;
  const isPartial = variant === "partial";
  const message: ChatMessage = {
    id: `playground-needs-input-reminder-${variant}-msg`,
    role: "user",
    content: isPartial
      ? [
          "[Needs-input reminder]",
          "Unresolved same-session needs-input notifications: 4. Showing newest 3.",
          "  6. Newest pending question",
          "  5. Second newest pending question",
          "  3. Third newest pending question",
          "Review or resolve these before assuming the user's latest message answered them.",
        ].join("\n")
      : [
          "[Needs-input reminder]",
          "Unresolved same-session needs-input notifications: 1.",
          "  17. Confirm rollout scope",
          "Review or resolve these before assuming the user's latest message answered them.",
        ].join("\n"),
    timestamp: Date.now() - 30_000,
    agentSource: NEEDS_INPUT_REMINDER_SOURCE,
  };

  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set(
      sessionId,
      isPartial
        ? [
            {
              id: "n-6",
              category: "needs-input",
              timestamp: Date.now() - 60_000,
              messageId: null,
              summary: "Newest pending question",
              done: true,
            },
            {
              id: "n-5",
              category: "needs-input",
              timestamp: Date.now() - 70_000,
              messageId: null,
              summary: "Second newest pending question",
              done: true,
            },
            {
              id: "n-3",
              category: "needs-input",
              timestamp: Date.now() - 80_000,
              messageId: null,
              summary: "Third newest pending question",
              done: true,
            },
          ]
        : [
            {
              id: "n-17",
              category: "needs-input",
              timestamp: Date.now() - 45_000,
              messageId: null,
              summary: "Confirm rollout scope",
              done: variant === "resolved",
            },
          ],
    );
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, [isPartial, sessionId, variant]);

  return <MessageBubble message={message} sessionId={sessionId} showTimestamp={false} />;
}

export function PlaygroundThreadRoutingReminderMessage() {
  const message: ChatMessage = {
    id: "playground-thread-routing-reminder-msg",
    role: "user",
    content: [
      "[Thread routing reminder]",
      "Missing thread marker. Your previous leader response was not assigned to a thread.",
      "Resend user-visible leader text with `[thread:main]` or `[thread:q-N]` as the first line.",
      "For leader shell commands, put `# thread:main` or `# thread:q-N` as the first non-empty command line.",
    ].join("\n"),
    timestamp: Date.now() - 20_000,
    agentSource: {
      sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID,
      sessionLabel: THREAD_ROUTING_REMINDER_SOURCE_LABEL,
    },
    metadata: { threadKey: "q-970", questId: "q-970" },
  };

  return <MessageBubble message={message} sessionId="playground-thread-routing-reminder" showTimestamp={false} />;
}

export function PlaygroundQuestThreadReminderMessage() {
  const message: ChatMessage = {
    id: "playground-quest-thread-reminder-msg",
    role: "user",
    content:
      "Thread reminder: attach any prior messages that clearly belong to [q-1025](quest:q-1025) with `takode thread attach`.",
    timestamp: Date.now() - 18_000,
    agentSource: {
      sessionId: QUEST_THREAD_REMINDER_SOURCE_ID,
      sessionLabel: QUEST_THREAD_REMINDER_SOURCE_LABEL,
    },
    metadata: { threadKey: "q-1025", questId: "q-1025" },
  };

  return <MessageBubble message={message} sessionId="playground-quest-thread-reminder" showTimestamp={false} />;
}

// ─── Inline MCP Server Row (static preview, no WebSocket) ──────────────────

export function PlaygroundMcpRow({ server }: { server: McpServerDetail }) {
  const [expanded, setExpanded] = useState(false);
  const statusMap: Record<string, { label: string; cls: string; dot: string }> = {
    connected: { label: "Connected", cls: "text-cc-success bg-cc-success/10", dot: "bg-cc-success" },
    connecting: { label: "Connecting", cls: "text-cc-warning bg-cc-warning/10", dot: "bg-cc-warning animate-pulse" },
    failed: { label: "Failed", cls: "text-cc-error bg-cc-error/10", dot: "bg-cc-error" },
    disabled: { label: "Disabled", cls: "text-cc-muted bg-cc-hover", dot: "bg-cc-muted opacity-40" },
  };
  const badge = statusMap[server.status] || statusMap.disabled;

  return (
    <div className="rounded-lg border border-cc-border bg-cc-bg">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${badge.dot}`} />
        <button onClick={() => setExpanded(!expanded)} className="flex-1 min-w-0 text-left cursor-pointer">
          <span className="text-[12px] font-medium text-cc-fg truncate block">{server.name}</span>
        </button>
        <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5 border-t border-cc-border pt-2">
          <div className="text-[11px] text-cc-muted space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Type:</span>
              <span>{server.config.type}</span>
            </div>
            {server.config.command && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">Cmd:</span>
                <span className="font-mono text-[10px] break-all">
                  {server.config.command}
                  {server.config.args?.length ? ` ${server.config.args.join(" ")}` : ""}
                </span>
              </div>
            )}
            {server.config.url && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">URL:</span>
                <span className="font-mono text-[10px] break-all">{server.config.url}</span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Scope:</span>
              <span>{server.scope}</span>
            </div>
          </div>
          {server.error && (
            <div className="text-[11px] text-cc-error bg-cc-error/5 rounded px-2 py-1">{server.error}</div>
          )}
          {server.tools && server.tools.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-cc-muted uppercase tracking-wider">Tools ({server.tools.length})</span>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((tool) => (
                  <span key={tool.name} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cc-hover text-cc-fg">
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Timer Modal Demo ────────────────────────────────────────────────────────

export function PlaygroundHoverCrossLinkDemo({ text }: { text: string }) {
  useEffect(() => {
    useStore.setState((state) => {
      const nextSdkSessions = [...state.sdkSessions];
      if (!nextSdkSessions.some((session) => session.sessionId === "playground-hover-leader")) {
        nextSdkSessions.push({
          sessionId: "playground-hover-leader",
          state: "running",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 180000,
          sessionNum: 565,
          cliConnected: true,
          backendType: "codex",
          model: "gpt-5.4",
          repoRoot: "/Users/stan/Dev/takode",
          isOrchestrator: true,
        });
      }
      if (!nextSdkSessions.some((session) => session.sessionId === "playground-hover-worker")) {
        nextSdkSessions.push({
          sessionId: "playground-hover-worker",
          state: "running",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 120000,
          sessionNum: 566,
          cliConnected: true,
          backendType: "codex",
          model: "gpt-5.4-mini",
          repoRoot: "/Users/stan/Dev/takode",
          herdedBy: "playground-hover-leader",
        });
      }
      if (!nextSdkSessions.some((session) => session.sessionId === "playground-hover-reviewer")) {
        nextSdkSessions.push({
          sessionId: "playground-hover-reviewer",
          state: "connected",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 90000,
          sessionNum: 567,
          cliConnected: true,
          backendType: "codex",
          model: "gpt-5.4",
          repoRoot: "/Users/stan/Dev/takode",
        });
      }

      const nextSessionNames = new Map(state.sessionNames);
      nextSessionNames.set("playground-hover-leader", "Leader Hover Demo");
      nextSessionNames.set("playground-hover-worker", "Worker Hover Demo");
      nextSessionNames.set("playground-hover-reviewer", "Reviewer Hover Demo");

      const nextQuests = [...state.quests];
      const hoverQuest = {
        id: "q-418-v2",
        questId: "q-418",
        version: 2,
        title: "Improve quest link preview layout and orchestration details",
        status: "in_progress" as const,
        description: "Keep quest hover previews spacious while surfacing orchestration context.",
        createdAt: Date.now() - 240000,
        sessionId: "playground-hover-worker",
        claimedAt: Date.now() - 180000,
        leaderSessionId: "playground-hover-leader",
        tags: ["ui", "quests", "links", "journey"],
      };
      const existingQuestIndex = nextQuests.findIndex((quest) => quest.questId === "q-418");
      if (existingQuestIndex >= 0) {
        nextQuests[existingQuestIndex] = { ...nextQuests[existingQuestIndex], ...hoverQuest };
      } else {
        nextQuests.push(hoverQuest);
      }

      const nextSessionBoards = new Map(state.sessionBoards);
      const leaderBoard = (nextSessionBoards.get("playground-hover-leader") ?? []).filter(
        (row) => row.questId !== "q-418",
      );
      nextSessionBoards.set("playground-hover-leader", [
        {
          questId: "q-418",
          title: hoverQuest.title,
          worker: "playground-hover-worker",
          workerNum: 566,
          status: "IMPLEMENTING",
          updatedAt: Date.now() - 60000,
          journey: {
            mode: "active",
            phaseIds: ["alignment", "implement", "code-review"],
            currentPhaseId: "implement",
          },
        },
        ...leaderBoard,
      ]);
      const nextSessionBoardRowStatuses = new Map(state.sessionBoardRowStatuses);
      nextSessionBoardRowStatuses.set("playground-hover-leader", {
        ...(nextSessionBoardRowStatuses.get("playground-hover-leader") ?? {}),
        "q-418": {
          worker: {
            sessionId: "playground-hover-worker",
            sessionNum: 566,
            name: "Worker Hover Demo",
            status: "running",
          },
          reviewer: {
            sessionId: "playground-hover-reviewer",
            sessionNum: 567,
            name: "Reviewer Hover Demo",
            status: "idle",
          },
        },
      });

      return {
        ...state,
        sdkSessions: nextSdkSessions,
        sessionNames: nextSessionNames,
        quests: nextQuests,
        sessionBoards: nextSessionBoards,
        sessionBoardRowStatuses: nextSessionBoardRowStatuses,
      };
    });
  }, []);

  return (
    <div className="space-y-2 p-3">
      <div className="rounded-xl border border-cc-border bg-cc-card/40 px-3 py-2.5">
        <MarkdownContent text={text} />
      </div>
    </div>
  );
}

export function PlaygroundMessageLinkHoverDemo() {
  useEffect(() => {
    useStore.setState((state) => {
      const nextSdkSessions = [...state.sdkSessions];
      if (!nextSdkSessions.some((session) => session.sessionId === "playground-hover-worker")) {
        nextSdkSessions.push({
          sessionId: "playground-hover-worker",
          state: "running",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 120000,
          sessionNum: 566,
          cliConnected: true,
          backendType: "codex",
          model: "gpt-5.4-mini",
          repoRoot: "/Users/stan/Dev/takode",
        });
      }

      const nextSessionNames = new Map(state.sessionNames);
      nextSessionNames.set("playground-hover-worker", "Worker Hover Demo");

      return {
        ...state,
        sdkSessions: nextSdkSessions,
        sessionNames: nextSessionNames,
      };
    });

    const originalFetchMessagePreview = api.fetchMessagePreview;
    api.fetchMessagePreview = async (sessionId: string, messageIndex: number) => {
      if (sessionId === "playground-hover-worker" && messageIndex === 212) {
        return {
          id: "playground-hover-message-212",
          role: "assistant",
          content: "The actual linked message renders here with the same message bubble primitives as chat.",
          contentBlocks: [
            {
              type: "text",
              text: "The actual linked message renders here with the same message bubble primitives as chat.",
            },
          ],
          timestamp: Date.now() - 60000,
        };
      }
      return originalFetchMessagePreview(sessionId, messageIndex);
    };

    return () => {
      api.fetchMessagePreview = originalFetchMessagePreview;
    };
  }, []);

  return (
    <div className="space-y-2 p-3">
      <div className="text-xs text-cc-muted">
        Hover the message link to preview the referenced message with reduced session chrome.
      </div>
      <div className="rounded-xl border border-cc-border bg-cc-card/40 px-3 py-2.5">
        <MarkdownContent text="Hover [#566 msg 212](session:566:212) to preview the linked message instead of a generic session summary." />
      </div>
    </div>
  );
}

export function TimerModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium px-3 py-1.5 rounded-md bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 transition-colors cursor-pointer"
      >
        Open timer modal
      </button>
      {open && <TimerModal sessionId="playground-timers" onClose={() => setOpen(false)} />}
    </>
  );
}

// ─── Inline Lightbox Demo ───────────────────────────────────────────────────

export function PlaygroundLightboxDemo() {
  const [open, setOpen] = useState(false);
  // A small gradient placeholder image — enough to demonstrate the lightbox
  const demoSrc =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#ec4899"/>' +
        "</linearGradient></defs>" +
        '<rect width="800" height="600" fill="url(#g)"/>' +
        '<text x="400" y="300" text-anchor="middle" fill="white" font-size="32" font-family="sans-serif">Full-size preview</text>' +
        "</svg>",
    );

  return (
    <div>
      <p className="text-xs text-cc-muted mb-2">Click the image below to open the lightbox:</p>
      <img
        src={demoSrc}
        alt="Lightbox demo"
        className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-zoom-in hover:opacity-80 transition-opacity border border-cc-border"
        onClick={() => setOpen(true)}
        data-testid="playground-lightbox-trigger"
      />
      {open && <Lightbox src={demoSrc} alt="Lightbox demo" onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * Playground demo for the Selection Context Menu.
 * Shows a mock assistant message with simulated highlighted text and a static context menu.
 */
export function PlaygroundSelectionContextMenu() {
  const [menuOpen, setMenuOpen] = useState(true);

  // Static menu items matching the real SelectionContextMenu
  const menuItems: ContextMenuItem[] = [
    { label: "Quote selected", onClick: () => setMenuOpen(false) },
    {
      label: "Copy",
      onClick: () => {},
      children: [
        { label: "Rich text", onClick: () => {} },
        { label: "Markdown", onClick: () => {} },
        { label: "Plain text", onClick: () => {} },
      ],
    },
  ];

  return (
    <div className="relative" style={{ minHeight: 180 }}>
      {/* Mock assistant message with simulated text selection */}
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0">
          <div className="markdown-body text-[14px] text-cc-fg leading-relaxed">
            <p className="mb-3">Here are the key design principles for the new architecture:</p>
            <p className="mb-3">
              1.{" "}
              <mark
                style={{
                  background: "rgba(56, 132, 244, 0.3)",
                  borderRadius: 2,
                  padding: "1px 0",
                }}
              >
                Leader has zero extra indentation -- no toggle arrow before it. It looks exactly like a standalone
                session.
              </mark>
            </p>
            <p className="mb-3 last:mb-0">2. Herd summary bar sits directly below the leader.</p>
          </div>
        </div>
      </div>

      {/* Static context menu positioned above the "selected" text */}
      {menuOpen && <ContextMenu x={100} y={4} items={menuItems} onClose={() => setMenuOpen(false)} />}

      {/* Re-open button if closed */}
      {!menuOpen && (
        <button
          onClick={() => setMenuOpen(true)}
          className="mt-3 text-xs text-cc-primary hover:underline cursor-pointer"
        >
          Show menu again
        </button>
      )}
    </div>
  );
}

// ─── Inline TaskRow (avoids store dependency from TaskPanel) ────────────────

export function TaskRow({ task }: { task: TaskItem }) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div className={`px-2.5 py-2 rounded-lg ${isCompleted ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 flex items-center justify-center w-4 h-4 mt-px">
          {isInProgress ? (
            <svg className="w-4 h-4 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none">
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
          ) : isCompleted ? (
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-success">
              <path
                fillRule="evenodd"
                d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4 text-cc-muted">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </span>
        <span
          className={`text-[13px] leading-snug flex-1 ${isCompleted ? "text-cc-muted line-through" : "text-cc-fg"}`}
        >
          {task.subject}
        </span>
      </div>
      {isInProgress && task.activeForm && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted italic truncate">{task.activeForm}</p>
      )}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 shrink-0">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}</span>
        </p>
      )}
    </div>
  );
}
