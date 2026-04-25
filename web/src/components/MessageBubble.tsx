import { useState, useMemo, useRef, useCallback, useContext, useLayoutEffect, useEffect, memo } from "react";
import type { ChatMessage, ComposerDraftImage, ContentBlock, SdkSessionInfo } from "../types.js";
import { isSubagentToolName } from "../types.js";
import { ToolBlock, getToolIcon, getToolLabel, ToolIcon } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { HighlightedText } from "./HighlightedText.js";
import { CollapseFooter } from "./CollapseFooter.js";
import { Lightbox } from "./Lightbox.js";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { getMessageMarkdown, getMessagePlainText, copyRichText, writeClipboardText } from "../utils/copy-utils.js";
import { EVENT_HEADER_RE, HERD_CHIP_BASE, HERD_CHIP_INTERACTIVE, parseHerdEvents } from "../utils/herd-event-parser.js";
import { useStore, getSessionSearchState, countUserPermissions } from "../store.js";
import { formatVsCodeSelectionAttachmentLabel } from "../utils/vscode-context.js";
import { absoluteUrlForHash, navigateToSession, routeSessionRefForId, sessionMessageHash } from "../utils/routing.js";
import { api } from "../api.js";
import { PawTrailAvatar, HidePawContext } from "./PawTrail.js";
import { QuestClaimBlock } from "./QuestClaimBlock.js";
import { generateReplyPreview } from "../utils/reply-preview.js";
import { parseReplyContext } from "../utils/reply-context.js";
import { getSingleAnchoredNotification } from "../utils/anchored-notifications.js";
import { FILE_TOOL_NAMES, isToolHiddenFromChat } from "../hooks/use-feed-model.js";
import { SessionHoverCard } from "./SessionHoverCard.js";
import type { SidebarSessionItem as SessionItemType } from "../utils/sidebar-session-item.js";
import { createComposerDraftImage } from "./composer-image-utils.js";

const EMPTY_MESSAGES: ChatMessage[] = [];

/** Detect assistant messages with no visible content (empty text, no blocks, no notification).
 *  Used to skip rendering empty bubbles that would show only a timestamp. */
export function isEmptyAssistantMessage(msg: ChatMessage): boolean {
  return (
    msg.role === "assistant" && !msg.content?.trim() && (msg.contentBlocks || []).length === 0 && !msg.notification
  );
}

/**
 * Per-message search highlight info, derived from the session search state.
 * Returns null when no search is active (zero overhead path).
 */
function useMessageSearchHighlight(sessionId: string | undefined, messageId: string, messageRole: ChatMessage["role"]) {
  const query = useStore((s) => (sessionId ? getSessionSearchState(s, sessionId).query : ""));
  const mode = useStore((s) => (sessionId ? getSessionSearchState(s, sessionId).mode : ("strict" as const)));
  const category = useStore((s) => (sessionId ? getSessionSearchState(s, sessionId).category : "all"));
  const isCurrent = useStore((s) => {
    if (!sessionId) return false;
    const ss = getSessionSearchState(s, sessionId);
    if (ss.matches.length === 0 || ss.currentMatchIndex < 0) return false;
    return ss.matches[ss.currentMatchIndex]?.messageId === messageId;
  });
  const roleMatchesCategory = category === "all" || category === messageRole;
  if (!roleMatchesCategory) return null;
  if (!query.trim()) return null;
  return { query, mode, isCurrent };
}

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

function buildCopyMessageLink(sessionId: string | undefined, message: ChatMessage, sdkSessions: SdkSessionInfo[]) {
  if (!sessionId) return null;
  const messageIndex =
    message.historyIndex ??
    useStore
      .getState()
      .messages.get(sessionId)
      ?.findIndex((msg) => msg.id === message.id) ??
    -1;
  if (messageIndex < 0) return null;
  const sessionRef = routeSessionRefForId(sessionId, sdkSessions);
  return absoluteUrlForHash(sessionMessageHash(sessionRef, messageIndex));
}

function buildDraftImageName(mediaType: string, index: number): string {
  const ext = mediaType.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "bin";
  return `attachment-${index + 1}.${ext}`;
}

async function restoreMessageImagesToDraft(
  sessionId: string,
  images: NonNullable<ChatMessage["images"]>,
): Promise<ComposerDraftImage[]> {
  const restored = await Promise.all(
    images.map(async (img, idx) => {
      const res = await fetch(`/api/images/${encodeURIComponent(sessionId)}/${encodeURIComponent(img.imageId)}/full`);
      if (!res.ok) throw new Error(`Failed to fetch image ${img.imageId}: ${res.statusText}`);
      const blob = await res.blob();
      const arrayBuf = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        ...createComposerDraftImage(
          {
            name: buildDraftImageName(img.media_type, idx),
            base64: btoa(binary),
            mediaType: blob.type || img.media_type,
          },
          { status: "uploading" },
        ),
      };
    }),
  );
  return restored;
}

function MessageTimestamp({ timestamp, turnDurationMs }: { timestamp: number; turnDurationMs?: number }) {
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

export const MessageBubble = memo(function MessageBubble({
  message,
  sessionId,
  showTimestamp = true,
}: {
  message: ChatMessage;
  sessionId?: string;
  showTimestamp?: boolean;
}) {
  // Search highlight state -- must be called unconditionally (hooks can't be after early returns)
  const searchHighlight = useMessageSearchHighlight(sessionId, message.id, message.role);

  if (message.role === "system") {
    if (message.variant === "error") {
      const isContextLimit = shouldShowCompactGuidance(message.content);
      return (
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-cc-error/8 border border-cc-error/20 animate-[fadeSlideIn_0.2s_ease-out]">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-error shrink-0 mt-0.5">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5zM8 11a1 1 0 100 2 1 1 0 000-2z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-cc-error">{message.content}</p>
            {isContextLimit && (
              <p className="text-xs text-cc-muted mt-1">
                Try <code className="px-1 py-0.5 rounded bg-cc-code-bg/30 text-[11px] font-mono-code">/compact</code> to
                shrink retained context before retrying, or start a new session.
              </p>
            )}
          </div>
        </div>
      );
    }
    if (message.variant === "denied") {
      return (
        <div className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-red-500/10 text-xs text-red-400/80 font-mono-code">
            <svg
              className="w-3 h-3 text-red-400/60 shrink-0"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="8" cy="8" r="6.5" />
              <line x1="4" y1="12" x2="12" y2="4" />
            </svg>
            <span>{message.content}</span>
          </div>
        </div>
      );
    }
    if (message.variant === "approved") {
      const answers = message.metadata?.answers;
      if (answers?.length) {
        return (
          <div className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]">
            <div className="flex items-start gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-green-500/10 text-xs font-mono-code max-w-[85%]">
              <svg
                className="w-3 h-3 text-green-400/60 shrink-0 mt-0.5"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="8" cy="8" r="6.5" />
                <path d="M5.5 8.5l2 2 3.5-4" />
              </svg>
              <div className="min-w-0">
                {answers.map((a, i) => (
                  <div key={i} className="text-cc-muted">
                    <span className="text-cc-fg/70">{a.question}</span>
                    <span className="text-cc-muted/60"> → </span>
                    <span className="text-green-400/80">{a.answer}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      }
      return <AutoApprovedChip content={message.content} reason={message.metadata?.autoApprovalReason} />;
    }
    // Quest lifecycle blocks — rendered as collapsible cards in the feed
    if ((message.variant === "quest_claimed" || message.variant === "quest_submitted") && message.metadata?.quest) {
      return (
        <div className="animate-[fadeSlideIn_0.2s_ease-out]">
          <QuestClaimBlock
            quest={message.metadata.quest}
            variant={message.variant === "quest_submitted" ? "submitted" : "claimed"}
          />
        </div>
      );
    }
    // Background task completion — lightweight chip showing what async work
    // finished. Helps the user understand why the model auto-started a new turn.
    if (message.variant === "task_completed") {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 leading-snug animate-[fadeSlideIn_0.2s_ease-out]">
          <span className="text-blue-400/60 shrink-0">◆</span>
          <span className="truncate">{message.content}</span>
        </div>
      );
    }
    // Expandable compact marker
    if (message.id.startsWith("compact-boundary-")) {
      return <CompactMarker message={message} sessionId={sessionId} />;
    }
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-cc-border" />
        <span className="text-[11px] text-cc-muted italic font-mono-code shrink-0 px-1">{message.content}</span>
        <div className="flex-1 h-px bg-cc-border" />
      </div>
    );
  }

  // Herd events: render as compact left-side notification (not a user bubble)
  if (message.role === "user" && message.agentSource?.sessionId === "herd-events") {
    return <HerdEventMessage message={message} showTimestamp={showTimestamp} />;
  }

  // Timer events: render as compact expandable cards instead of normal user bubbles.
  if (message.role === "user" && message.agentSource?.sessionId?.startsWith("timer:")) {
    return (
      <TimerMessage
        message={message}
        sessionId={sessionId}
        showTimestamp={showTimestamp}
        searchHighlight={searchHighlight}
      />
    );
  }

  if (message.role === "user") {
    return (
      <UserMessage
        message={message}
        sessionId={sessionId}
        showTimestamp={showTimestamp}
        searchHighlight={searchHighlight}
      />
    );
  }

  // Hide empty assistant messages: no text content, no content blocks, no notification.
  // These are silent turns (e.g. processing a herd event with no visible output) that
  // would otherwise render as empty bubbles showing only a timestamp.
  // Safe: streaming messages always have contentBlocks being populated in real-time.
  if (isEmptyAssistantMessage(message)) {
    return null;
  }

  // Assistant message
  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <AssistantMessage
        message={message}
        sessionId={sessionId}
        showTimestamp={showTimestamp}
        searchHighlight={searchHighlight}
      />
    </div>
  );
});

function shouldShowCompactGuidance(content: string): boolean {
  const normalized = content.toLowerCase();
  if (normalized.includes("prompt is too long")) return true;
  if (normalized.includes("payload too large")) return true;
  if (normalized.includes("request too large")) return true;
  if (normalized.includes("failed to parse request") && normalized.includes("payload")) return true;
  return normalized.includes("413") && (normalized.includes("payload") || normalized.includes("request"));
}

/** Auto-collapse content that exceeds a height threshold.
 *  Shows a gradient fade and "Show more" pill when collapsed. */
const COLLAPSE_THRESHOLD = 300;

function CollapsibleContent({ children }: { children: React.ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setNeedsCollapse(el.scrollHeight > COLLAPSE_THRESHOLD);
  }, [children]);

  const isCollapsed = needsCollapse && collapsed;

  return (
    <div className="relative">
      <div ref={contentRef} style={isCollapsed ? { maxHeight: COLLAPSE_THRESHOLD, overflow: "hidden" } : undefined}>
        {children}
      </div>
      {isCollapsed && (
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-cc-user-bubble to-transparent pointer-events-none" />
      )}
      {needsCollapse && (
        <div className={`flex justify-center ${isCollapsed ? "-mt-3 relative z-10" : "mt-1"}`}>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-[11px] text-cc-muted hover:text-cc-fg bg-cc-user-bubble border border-cc-border/30 px-3 py-0.5 rounded-full cursor-pointer transition-colors"
          >
            {collapsed ? "Show more" : "Show less"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Badge shown on user messages injected by an agent (via takode CLI or cron).
 *  Displays a bolt icon + sender label. Click to see details / navigate to source session. */
function AgentSourceBadge({ source }: { source: { sessionId: string; sessionLabel?: string } }) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const label = source.sessionLabel || source.sessionId.slice(0, 8);
  const isCron = source.sessionId.startsWith("cron:");
  const isSystem = source.sessionId === "system" || source.sessionId.startsWith("system:");
  const isTimer = source.sessionId.startsWith("timer:");
  const hasOpenableSession = !isCron && !isSystem && !isTimer;

  const toggle = useCallback(() => {
    if (menuPos) {
      setMenuPos(null);
    } else {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ x: rect.left, y: rect.bottom + 4 });
    }
  }, [menuPos]);

  const items = useMemo(() => {
    const list: ContextMenuItem[] = [];
    if (hasOpenableSession) {
      list.push({
        label: `Open session`,
        onClick: () => {
          window.location.hash = `#/sessions/${source.sessionId}`;
        },
      });
    }
    list.push({
      label: `ID: ${source.sessionId.slice(0, 12)}${source.sessionId.length > 12 ? "…" : ""}`,
      onClick: () => {
        writeClipboardText(source.sessionId).catch(console.error);
      },
    });
    return list;
  }, [source.sessionId, hasOpenableSession]);

  return (
    <div className="mb-1.5">
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center gap-1 text-[10px] text-cc-muted/70 hover:text-cc-muted transition-colors cursor-pointer"
        title="Sent by an agent"
        data-testid="agent-source-badge"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 text-cc-primary/60 shrink-0">
          <path d="M9.5 2L3 9.5h5L6.5 14l7.5-7.5h-5L9.5 2z" />
        </svg>
        <span className="font-mono-code">via {label}</span>
      </button>
      {menuPos && <ContextMenu x={menuPos.x} y={menuPos.y} items={items} onClose={() => setMenuPos(null)} />}
    </div>
  );
}

type ParsedTimerMessage = {
  kind: "fired" | "cancelled" | "unknown";
  title: string;
  description: string;
  timerId: string | null;
};

function parseTimerMessageContent(content: string): ParsedTimerMessage {
  const trimmed = content.trim();
  const parts = trimmed.split(/\n{2,}/);
  const header = parts[0]?.trim() ?? "";
  const description = parts.slice(1).join("\n\n").trim();
  const cancelledMatch = header.match(/^\[⏰ Timer ([^\]\s]+) cancelled\]\s*(.*)$/);
  if (cancelledMatch) {
    return {
      kind: "cancelled",
      timerId: cancelledMatch[1],
      title: (cancelledMatch[2] || header).trim(),
      description,
    };
  }

  const firedMatch = header.match(/^\[⏰ Timer ([^\]\s]+)\]\s*(.*)$/);
  if (firedMatch) {
    return {
      kind: "fired",
      timerId: firedMatch[1],
      title: (firedMatch[2] || header).trim(),
      description,
    };
  }

  const reminderMatch = header.match(/^\[⏰ Timer ([^\]\s]+) reminder\]\s*(.*)$/);
  if (reminderMatch) {
    return {
      kind: "fired",
      timerId: reminderMatch[1],
      title: (reminderMatch[2] || header).trim(),
      description,
    };
  }

  const fallbackMatch = header.match(/^\[[^\]]+\]\s*(.*)$/);
  const title = (fallbackMatch?.[1] ?? header).trim();
  return {
    kind: "unknown",
    timerId: null,
    title: title || trimmed,
    description,
  };
}

function TimerEventIcon({ muted = false }: { muted?: boolean }) {
  return (
    <span aria-hidden="true" className={`shrink-0 text-[13px] leading-none ${muted ? "opacity-50" : ""}`}>
      ⏰
    </span>
  );
}

function TimerMessage({
  message,
  sessionId,
  showTimestamp,
  searchHighlight,
}: {
  message: ChatMessage;
  sessionId?: string;
  showTimestamp: boolean;
  searchHighlight?: SearchHighlightInfo;
}) {
  const { title, description, timerId, kind } = useMemo(
    () => parseTimerMessageContent(message.content),
    [message.content],
  );
  const [expanded, setExpanded] = useState(false);
  const hasDescription = description.length > 0;
  const timerLabel = timerId ?? message.agentSource?.sessionLabel ?? "timer";
  const fullTimerLabel = message.agentSource?.sessionLabel ?? (timerId ? `Timer ${timerId}` : timerLabel);
  const titleClassName = kind === "cancelled" ? "text-cc-muted/85" : "text-cc-fg/95";
  const normalizedQuery = searchHighlight?.query.trim().toLowerCase() ?? "";
  const shouldShowFullTimerLabel =
    normalizedQuery.length > 0 &&
    searchHighlight?.mode === "strict" &&
    !timerLabel.toLowerCase().includes(normalizedQuery) &&
    fullTimerLabel.toLowerCase().includes(normalizedQuery);
  const visibleTimerLabel = shouldShowFullTimerLabel ? fullTimerLabel : timerLabel;

  const renderedTimerLabel = searchHighlight?.query ? (
    <HighlightedText
      text={visibleTimerLabel}
      query={searchHighlight.query}
      mode={searchHighlight.mode}
      isCurrent={searchHighlight.isCurrent}
    />
  ) : (
    visibleTimerLabel
  );

  const renderedTitle = searchHighlight?.query ? (
    <HighlightedText
      text={title}
      query={searchHighlight.query}
      mode={searchHighlight.mode}
      isCurrent={searchHighlight.isCurrent}
    />
  ) : (
    title
  );

  return (
    <div className="pl-9 py-0.5 animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-3xl">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {hasDescription && kind !== "cancelled" ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? "Collapse timer description" : "Expand timer description"}
                className="flex w-full min-w-0 items-start gap-2 text-left cursor-pointer"
              >
                <TimerEventIcon />
                <span className="shrink-0 pt-0.5 font-mono-code text-[11px] leading-none text-orange-300/85">
                  {renderedTimerLabel}
                </span>
                <span className={`min-w-0 flex-1 break-words text-[13px] font-medium leading-snug ${titleClassName}`}>
                  {renderedTitle}
                </span>
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className={`mt-0.5 h-3 w-3 shrink-0 text-cc-muted/45 transition-transform ${expanded ? "rotate-90" : ""}`}
                >
                  <path d="M6 3l5 5-5 5V3z" />
                </svg>
              </button>
            ) : (
              <div className="flex min-w-0 items-start gap-2">
                <TimerEventIcon muted={kind === "cancelled"} />
                <span
                  className={`shrink-0 pt-0.5 font-mono-code text-[11px] leading-none ${
                    kind === "cancelled" ? "text-cc-muted/60" : "text-orange-300/85"
                  }`}
                >
                  {renderedTimerLabel}
                </span>
                {kind === "cancelled" && (
                  <span className="shrink-0 pt-[1px] text-[10px] uppercase tracking-[0.18em] text-cc-muted/45">
                    cancelled
                  </span>
                )}
                <span className={`min-w-0 flex-1 break-words text-[13px] font-medium leading-snug ${titleClassName}`}>
                  {renderedTitle}
                </span>
              </div>
            )}
            {expanded && hasDescription && kind !== "cancelled" && (
              <div className="ml-6 mt-2 rounded-2xl border border-cc-border/20 bg-cc-card/45 px-3 py-2.5">
                <MarkdownContent
                  text={description}
                  variant="conservative"
                  sessionId={sessionId}
                  searchHighlight={searchHighlight}
                />
              </div>
            )}
          </div>
          {showTimestamp && <MessageTimestamp timestamp={message.timestamp} />}
        </div>
      </div>
    </div>
  );
}

/** Compact inline rendering for herd event summaries — collapsed by default.
 *  Shows one-line event headers (#N | turn_end | ...) with a toggle chevron.
 *  Expanding reveals the full injected peek-style activity content. */
export function HerdEventMessage({ message }: { message: ChatMessage; showTimestamp: boolean }) {
  // The content is formatted by formatHerdEventBatch():
  // "N events from N sessions\n\n#34 | turn_end | ✓ 56.3s\n  [120] user: ...\n  [121] asst: ...\n#35 | ..."
  // Parse into events: each starts with a #N line (header) followed by indented activity lines.
  const events = useMemo(() => parseHerdEvents(message.content), [message.content]);

  if (events.length === 0) {
    // Fallback for unexpected format — render as simple muted text
    return (
      <div className="text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 animate-[fadeSlideIn_0.2s_ease-out]">
        {message.content}
      </div>
    );
  }

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out] space-y-1">
      {events.map((evt, i) => (
        <HerdEventEntry key={i} header={evt.header} activity={evt.activity} />
      ))}
    </div>
  );
}

function splitHerdEventHeader(header: string): { sessionLabel: string | null; remainder: string } {
  const match = header.match(/^(#\d+)(.*)$/);
  if (!match) return { sessionLabel: null, remainder: header };
  return { sessionLabel: match[1], remainder: match[2] || "" };
}

/** A single herd event rendered as a compact expandable chip.
 *  Every event is clickable. Collapsed: inline pill showing the event header
 *  (e.g. "#287 | turn_end | ✓ 53.6s"). Expanded: full content -- activity lines
 *  for turn_end events, or the untruncated header for other event types. */
function HerdEventEntry({ header, activity }: { header: string; activity: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasActivity = activity.some((line) => line.trim().length > 0);
  const { sessionLabel, remainder } = useMemo(() => splitHerdEventHeader(header), [header]);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessionNames = useStore((s) => s.sessionNames);
  const sessionPreviews = useStore((s) => s.sessionPreviews);
  const sessionTaskHistory = useStore((s) => s.sessionTaskHistory);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const askPermission = useStore((s) => s.askPermission);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    },
    [],
  );

  const sessionNum = useMemo(() => {
    if (!sessionLabel) return null;
    const raw = sessionLabel.slice(1);
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }, [sessionLabel]);
  const sdkInfo = useMemo(
    () => (sessionNum == null ? null : (sdkSessions.find((session) => session.sessionNum === sessionNum) ?? null)),
    [sdkSessions, sessionNum],
  );
  const resolvedSessionId = sdkInfo?.sessionId ?? null;
  const sessionItem = useMemo<SessionItemType | null>(() => {
    if (!resolvedSessionId) return null;

    const bridgeState = sessions.get(resolvedSessionId);
    const sdkGitAhead = sdkInfo?.gitAhead ?? 0;
    const sdkGitBehind = sdkInfo?.gitBehind ?? 0;
    const gitAhead =
      bridgeState?.git_ahead === 0 && sdkGitAhead > 0 ? sdkGitAhead : (bridgeState?.git_ahead ?? sdkGitAhead);
    const gitBehind =
      bridgeState?.git_behind === 0 && sdkGitBehind > 0 ? sdkGitBehind : (bridgeState?.git_behind ?? sdkGitBehind);

    return {
      id: resolvedSessionId,
      model: bridgeState?.model || sdkInfo?.model || "",
      cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
      gitBranch: bridgeState?.git_branch || sdkInfo?.gitBranch || "",
      isContainerized: bridgeState?.is_containerized || !!sdkInfo?.containerId || false,
      gitAhead,
      gitBehind,
      linesAdded: bridgeState?.total_lines_added ?? sdkInfo?.totalLinesAdded ?? 0,
      linesRemoved: bridgeState?.total_lines_removed ?? sdkInfo?.totalLinesRemoved ?? 0,
      isConnected: cliConnected.get(resolvedSessionId) ?? sdkInfo?.cliConnected ?? false,
      status: sessionStatus.get(resolvedSessionId) ?? null,
      sdkState: sdkInfo?.state ?? null,
      createdAt: sdkInfo?.createdAt ?? 0,
      archived: sdkInfo?.archived ?? false,
      archivedAt: sdkInfo?.archivedAt,
      backendType: bridgeState?.backend_type || sdkInfo?.backendType || "claude",
      repoRoot: bridgeState?.repo_root || sdkInfo?.repoRoot || "",
      permCount: countUserPermissions(pendingPermissions.get(resolvedSessionId)),
      cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
      cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
      isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
      worktreeExists: sdkInfo?.worktreeExists,
      worktreeDirty: sdkInfo?.worktreeDirty,
      worktreeCleanupStatus: sdkInfo?.worktreeCleanupStatus,
      worktreeCleanupError: sdkInfo?.worktreeCleanupError,
      askPermission: askPermission.get(resolvedSessionId),
      idleKilled: cliDisconnectReason.get(resolvedSessionId) === "idle_limit",
      lastActivityAt: sdkInfo?.lastActivityAt,
      isOrchestrator: sdkInfo?.isOrchestrator || false,
      herdedBy: sdkInfo?.herdedBy,
      sessionNum: sdkInfo?.sessionNum ?? null,
    };
  }, [
    askPermission,
    cliConnected,
    cliDisconnectReason,
    pendingPermissions,
    resolvedSessionId,
    sdkInfo,
    sessionStatus,
    sessions,
  ]);

  const toggleExpanded = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggleExpanded();
    },
    [toggleExpanded],
  );

  const handleSessionClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (!resolvedSessionId) return;
      navigateToSession(resolvedSessionId);
    },
    [resolvedSessionId],
  );

  const handleSessionKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.stopPropagation();
    }
  }, []);

  const handleSessionMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!sessionItem) return;
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
      setHoverRect(e.currentTarget.getBoundingClientRect());
    },
    [sessionItem],
  );

  const handleSessionMouseLeave = useCallback(() => {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    hideHoverTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }, []);

  const handleHoverCardEnter = useCallback(() => {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
  }, []);

  const handleHoverCardLeave = useCallback(() => {
    setHoverRect(null);
  }, []);

  return (
    <div className="pl-9">
      <div
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={handleContainerKeyDown}
        aria-expanded={expanded}
        className={`${HERD_CHIP_BASE} ${HERD_CHIP_INTERACTIVE}`}
      >
        <span className="text-amber-500/50 shrink-0 text-[10px]">◇</span>
        {sessionLabel ? (
          resolvedSessionId ? (
            <button
              type="button"
              onClick={handleSessionClick}
              onKeyDown={handleSessionKeyDown}
              onMouseEnter={handleSessionMouseEnter}
              onMouseLeave={handleSessionMouseLeave}
              className="shrink-0 rounded-sm font-mono-code text-amber-400 hover:text-amber-300 hover:underline decoration-dotted underline-offset-2 cursor-pointer focus-visible:outline-none focus-visible:text-amber-300 focus-visible:underline focus-visible:decoration-dotted focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-cc-card"
              aria-label={`Open session ${sessionLabel}`}
              title={`Open session ${sessionLabel}`}
            >
              {sessionLabel}
            </button>
          ) : (
            <span className="shrink-0">{sessionLabel}</span>
          )
        ) : null}
        <span className={expanded ? "break-words min-w-0" : "truncate min-w-0 max-w-[60ch]"}>
          {sessionLabel ? remainder : header}
        </span>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 shrink-0 text-cc-muted/40 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 3l5 5-5 5V3z" />
        </svg>
      </div>
      {resolvedSessionId && sessionItem && hoverRect && (
        <SessionHoverCard
          session={sessionItem}
          sessionName={sessionNames.get(resolvedSessionId)}
          sessionPreview={sessionPreviews.get(resolvedSessionId)}
          taskHistory={sessionTaskHistory.get(resolvedSessionId)}
          sessionState={sessions.get(resolvedSessionId)}
          cliSessionId={sdkInfo?.cliSessionId}
          anchorRect={hoverRect}
          onMouseEnter={handleHoverCardEnter}
          onMouseLeave={handleHoverCardLeave}
        />
      )}
      {expanded && hasActivity && (
        <pre
          className="mt-1 ml-1 px-2.5 py-2 rounded-md border border-cc-border/20 bg-cc-card/30
          text-[10px] text-cc-muted/80 font-mono-code leading-relaxed
          whitespace-pre-wrap break-words overflow-x-auto max-h-[400px] overflow-y-auto"
        >
          {activity.join("\n")}
        </pre>
      )}
    </div>
  );
}

// Re-export herd event parsing utilities for backward compatibility
export { EVENT_HEADER_RE, parseHerdEvents } from "../utils/herd-event-parser.js";

type SearchHighlightInfo = { query: string; mode: "strict" | "fuzzy"; isCurrent: boolean } | null;

/** Compact marker rendered inline for notification tool calls.
 *  When sessionId and messageId are provided, shows the checkbox affordance immediately
 *  and resolves the backing notification lazily for done-state toggles. */
export function NotificationMarker({
  category,
  summary,
  sessionId,
  messageId,
  doneOverride,
  onToggleDone,
  showReplyAction = true,
}: {
  category: "needs-input" | "review";
  summary?: string;
  sessionId?: string;
  messageId?: string;
  doneOverride?: boolean;
  onToggleDone?: () => void;
  showReplyAction?: boolean;
}) {
  const isAction = category === "needs-input";
  const label = summary || (isAction ? "Needs input" : "Ready for review");

  // Find the matching notification in the store to enable interactive controls
  const notif = useStore((s) => {
    if (!sessionId) return null;
    const notifications = s.sessionNotifications?.get(sessionId);
    if (!notifications || !messageId) return null;
    return notifications.find((n) => n.messageId === messageId && n.category === category) ?? null;
  });

  const canToggleDone = !!onToggleDone || (!!sessionId && !!messageId);
  const isDone = doneOverride ?? notif?.done ?? false;
  const isToggleReady = !!onToggleDone || !!notif;
  const toggleLabel =
    category === "review"
      ? isDone
        ? "Mark as not reviewed"
        : "Mark as reviewed"
      : isDone
        ? "Mark unhandled"
        : "Mark handled";

  const toggleDone = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onToggleDone) {
        onToggleDone();
        return;
      }
      if (!sessionId || !messageId) return;
      const liveNotif =
        useStore
          .getState()
          .sessionNotifications.get(sessionId)
          ?.find((n) => n.messageId === messageId && n.category === category) ?? null;
      if (!liveNotif) return;
      api.markNotificationDone(sessionId, liveNotif.id, !liveNotif.done).catch(() => {});
    },
    [sessionId, messageId, category, onToggleDone],
  );

  const handleReply = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!sessionId || !messageId) return;
      const previewText = label;
      useStore.getState().setReplyContext(sessionId, { messageId, previewText });
    },
    [sessionId, messageId, label],
  );

  return (
    <div
      className={`inline-flex items-center gap-1.5 mt-2 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-opacity ${
        isDone
          ? "border-cc-border bg-cc-hover/30 text-cc-muted opacity-60"
          : isAction
            ? "border-amber-500/20 bg-amber-500/5 text-amber-400"
            : "border-emerald-500/20 bg-emerald-500/5 text-cc-muted"
      }`}
    >
      {/* Checkbox (shown as soon as the marker has a message anchor) */}
      {canToggleDone && (
        <button
          onClick={toggleDone}
          className="shrink-0 cursor-pointer hover:opacity-80 transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
          title={isToggleReady ? toggleLabel : "Waiting for notification sync"}
          aria-label={toggleLabel}
          disabled={!isToggleReady}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            {isDone ? (
              <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm11.354-1.646a.5.5 0 00-.708-.708L7 9.293 5.354 7.646a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" />
            ) : (
              <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8z" />
            )}
          </svg>
        </button>
      )}

      {/* Bell icon (used for both categories) */}
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
        <path d="M8 1.5A3.5 3.5 0 004.5 5v2.5c0 .78-.26 1.54-.73 2.16L3 10.66V11.5h10v-.84l-.77-1A3.49 3.49 0 0111.5 7.5V5A3.5 3.5 0 008 1.5zM6.5 13a1.5 1.5 0 003 0h-3z" />
      </svg>

      {/* Label */}
      <span className={isDone ? "line-through" : ""}>{label}</span>

      {/* Reply button (only when interactive) */}
      {showReplyAction && notif && sessionId && messageId && (
        <button
          onClick={handleReply}
          className="shrink-0 ml-0.5 cursor-pointer hover:opacity-80 transition-opacity"
          title="Reply to this notification"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M6.78 1.97a.75.75 0 010 1.06L3.81 6h6.44A4.75 4.75 0 0115 10.75v1.5a.75.75 0 01-1.5 0v-1.5a3.25 3.25 0 00-3.25-3.25H3.81l2.97 2.97a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Read-only reply chip shown above user message bubbles when the user replied to a specific assistant message. */
export function UserReplyChip({ previewText, messageId }: { previewText: string; messageId?: string }) {
  const handleClick = useCallback(() => {
    if (!messageId) return;
    const target = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    // Brief highlight flash
    target.classList.add("reply-highlight-flash");
    setTimeout(() => target.classList.remove("reply-highlight-flash"), 1500);
  }, [messageId]);

  return (
    <div
      className={`flex items-center gap-1.5 mb-1.5 text-[11px] text-cc-muted/80 max-w-full min-w-0${messageId ? " cursor-pointer hover:text-cc-muted transition-colors" : ""}`}
      onClick={messageId ? handleClick : undefined}
      role={messageId ? "button" : undefined}
      title={messageId ? "Scroll to original message" : undefined}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        className="w-3 h-3 shrink-0 text-cc-primary/60"
      >
        <path d="M6 3L2 7l4 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 7h7a4 4 0 014 4v1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="truncate">{previewText}</span>
    </div>
  );
}

function UserMessage({
  message,
  sessionId,
  showTimestamp,
  searchHighlight,
}: {
  message: ChatMessage;
  sessionId?: string;
  showTimestamp: boolean;
  searchHighlight?: SearchHighlightInfo;
}) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const isCodex = useStore((s) => s.sessions.get(sessionId ?? "")?.backend_type === "codex");
  const messagesBySession = useStore((s) => s.messages);
  const sessionMessages = sessionId ? (messagesBySession.get(sessionId) ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
  const canRevert = useMemo(() => {
    if (!sessionId) return false;
    if (!isCodex) return true;
    const idx = sessionMessages.findIndex((m) => m.id === message.id);
    if (idx < 0) return true;
    for (let i = idx - 1; i >= 0; i--) {
      const prior = sessionMessages[i];
      if (prior?.role !== "user") return true;
      return false;
    }
    return true;
  }, [sessionId, isCodex, sessionMessages, message.id]);

  // Parse reply-to context from message content (display only -- raw text still goes to assistant)
  const replyContext = useMemo(() => parseReplyContext(message.content), [message.content]);
  const displayContent = replyContext ? replyContext.userMessage : message.content;
  const localImageEntries = message.localImages ?? [];
  const remoteImageEntries = message.images ?? [];
  const pendingLabel =
    message.pendingState === "uploading"
      ? "Uploading image…"
      : message.pendingState === "delivering"
        ? "Sending…"
        : message.pendingState === "failed"
          ? message.pendingError || "Upload failed"
          : null;

  return (
    <div className="flex justify-end items-start gap-1 group/msg animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-[85%] sm:max-w-[80%] sm:min-w-[200px] px-3 sm:px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
        {message.agentSource && <AgentSourceBadge source={message.agentSource} />}
        {replyContext && <UserReplyChip previewText={replyContext.previewText} messageId={replyContext.messageId} />}
        {message.metadata?.vscodeSelection && (
          <div className="mb-2 flex">
            <div
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-cc-border/80 bg-cc-hover/70 px-2 py-1 text-[11px] text-cc-muted"
              title={message.metadata.vscodeSelection.relativePath}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0 opacity-70">
                <path d="M3.75 1.5A2.25 2.25 0 001.5 3.75v8.5A2.25 2.25 0 003.75 14.5h8.5a2.25 2.25 0 002.25-2.25v-5a.75.75 0 00-1.5 0v5A.75.75 0 0112.25 13h-8.5a.75.75 0 01-.75-.75v-8.5A.75.75 0 013.75 3h5a.75.75 0 000-1.5h-5z" />
                <path d="M9.53 1.47a.75.75 0 011.06 0l3.94 3.94a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-.33.2l-2.5.63a.75.75 0 01-.91-.91l.63-2.5a.75.75 0 01.2-.33l5.5-5.5z" />
              </svg>
              <span className="truncate font-mono-code">
                {formatVsCodeSelectionAttachmentLabel(message.metadata.vscodeSelection)}
              </span>
            </div>
          </div>
        )}
        {localImageEntries.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-2">
            {localImageEntries.map((img, idx) => {
              const src = `data:${img.mediaType};base64,${img.base64}`;
              return (
                <img
                  key={`${img.name}-${idx}`}
                  src={src}
                  alt={img.name || "attachment"}
                  className="max-w-[150px] sm:max-w-[200px] max-h-[120px] sm:max-h-[150px] rounded-lg object-cover cursor-zoom-in hover:opacity-80 transition-opacity"
                  onClick={() => setLightboxSrc(src)}
                  loading="lazy"
                  decoding="async"
                  data-testid="image-thumbnail"
                />
              );
            })}
          </div>
        )}
        {localImageEntries.length === 0 && remoteImageEntries.length > 0 && sessionId && (
          <div className="flex gap-2 flex-wrap mb-2">
            {remoteImageEntries.map((img) => {
              const thumbSrc = `/api/images/${sessionId}/${img.imageId}/thumb`;
              const fullSrc = `/api/images/${sessionId}/${img.imageId}/full`;
              return (
                <img
                  key={img.imageId}
                  src={thumbSrc}
                  alt="attachment"
                  className="max-w-[150px] sm:max-w-[200px] max-h-[120px] sm:max-h-[150px] rounded-lg object-cover cursor-zoom-in hover:opacity-80 transition-opacity"
                  onClick={() => setLightboxSrc(fullSrc)}
                  loading="lazy"
                  decoding="async"
                  data-testid="image-thumbnail"
                />
              );
            })}
          </div>
        )}
        {pendingLabel && <div className="mb-2 text-[11px] text-cc-muted/80 font-mono-code">{pendingLabel}</div>}
        <CollapsibleContent>
          <MarkdownContent
            text={displayContent}
            variant="conservative"
            sessionId={sessionId}
            searchHighlight={searchHighlight}
          />
        </CollapsibleContent>
        {showTimestamp && <MessageTimestamp timestamp={message.timestamp} />}
      </div>
      {!message.pendingState && (
        <UserMessageMenu message={message} sessionId={sessionId} canRevert={canRevert} isCodex={isCodex} />
      )}
      {lightboxSrc && <Lightbox src={lightboxSrc} alt="attachment" onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}

/** Inline menu button for user messages — copy, revert, etc.
 *  Uses the ContextMenu component (proven to work on iOS Safari)
 *  which portals to document.body to escape overflow-hidden ancestors. */
function UserMessageMenu({
  message,
  sessionId,
  canRevert,
  isCodex,
}: {
  message: ChatMessage;
  sessionId?: string;
  canRevert: boolean;
  isCodex: boolean;
}) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const sdkSessions = useStore((s) => s.sdkSessions);

  const showCopied = useCallback(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  const handleCopy = useCallback(() => {
    writeClipboardText(message.content).then(showCopied).catch(console.error);
  }, [message.content, showCopied]);

  const handleCopyLink = useCallback(() => {
    const link = buildCopyMessageLink(sessionId, message, sdkSessions);
    if (!link) return;
    writeClipboardText(link).then(showCopied).catch(console.error);
  }, [message, sdkSessions, sessionId, showCopied]);

  const handleRevert = useCallback(async () => {
    if (!sessionId || !message.id) return;
    try {
      await api.revertToMessage(sessionId, message.id);
      // Prefill the composer with the reverted message so the user can edit and resend
      const store = useStore.getState();
      store.setComposerDraft(sessionId, { text: message.content, images: [] });
      if (message.images?.length) {
        try {
          const images = await restoreMessageImagesToDraft(sessionId, message.images);
          store.setComposerDraft(sessionId, { text: message.content, images });
        } catch (imageErr) {
          console.error("Failed to restore images after revert:", imageErr);
        }
      }
    } catch (err) {
      console.error("Revert failed:", err);
    }
  }, [sessionId, message.id, message.content, message.images]);

  const toggle = useCallback(() => {
    if (menuPos) {
      setMenuPos(null);
    } else {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ x: rect.left, y: rect.bottom + 4 });
    }
  }, [menuPos]);

  const items = useMemo(() => {
    const list: ContextMenuItem[] = [{ label: "Copy message", onClick: handleCopy }];
    if (sessionId) {
      list.push({ label: "Copy message link", onClick: handleCopyLink });
    }
    if (canRevert) {
      list.push({
        label: "Revert to here",
        onClick: handleRevert,
        confirm: {
          title: "Revert to here?",
          description: "All messages after this point will be removed.",
          confirmLabel: "Revert",
          destructive: true,
        },
      });
    }
    return list;
  }, [canRevert, handleCopy, handleCopyLink, handleRevert, sessionId]);

  return (
    <div className="shrink-0 self-start mt-1">
      <button
        ref={btnRef}
        onClick={toggle}
        className={`p-1 rounded hover:bg-cc-hover transition-all cursor-pointer ${
          menuPos || copied ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100"
        }`}
        title="Message options"
      >
        {copied ? (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-3.5 h-3.5 text-cc-success"
          >
            <path d="M3 8.5l3.5 3.5 6.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted">
            <circle cx="3" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="13" cy="8" r="1.5" />
          </svg>
        )}
      </button>
      {menuPos && <ContextMenu x={menuPos.x} y={menuPos.y} items={items} onClose={() => setMenuPos(null)} />}
    </div>
  );
}

interface ToolGroupItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type GroupedBlock =
  | { kind: "content"; block: ContentBlock }
  | { kind: "tool_group"; name: string; items: ToolGroupItem[] };

function groupContentBlocks(blocks: ContentBlock[]): GroupedBlock[] {
  const groups: GroupedBlock[] = [];

  for (const block of blocks) {
    // Skip Task blocks — they render as SubagentContainers in MessageFeed,
    // not as standalone ToolBlocks. Without this filter, every subagent would
    // appear twice: once as an inline Agent chip (SubagentContainer) and once
    // as a "Subagent" ToolBlock chip.
    if (block.type === "tool_use" && isSubagentToolName(block.name)) continue;
    if (block.type === "tool_use" && isToolHiddenFromChat(block.name)) continue;

    if (block.type === "tool_use") {
      const last = groups[groups.length - 1];
      // Never merge file-operation tools -- each gets its own standalone chip
      if (!FILE_TOOL_NAMES.has(block.name) && last?.kind === "tool_group" && last.name === block.name) {
        last.items.push({ id: block.id, name: block.name, input: block.input });
      } else {
        groups.push({
          kind: "tool_group",
          name: block.name,
          items: [{ id: block.id, name: block.name, input: block.input }],
        });
      }
    } else {
      groups.push({ kind: "content", block });
    }
  }

  return groups;
}

function AssistantMessage({
  message,
  sessionId,
  showTimestamp,
  searchHighlight,
}: {
  message: ChatMessage;
  sessionId?: string;
  showTimestamp: boolean;
  searchHighlight?: SearchHighlightInfo;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const hidePaw = useContext(HidePawContext);
  const blocks = (message.contentBlocks || []).filter(
    (block) => !(block.type === "tool_use" && isToolHiddenFromChat(block.name)),
  );

  const grouped = useMemo(() => groupContentBlocks(blocks), [blocks]);
  const hasTextBlock = blocks.some((b) => b.type === "text" && b.text.trim().length > 0);
  const hasThinkingBlock = blocks.some((b) => b.type === "thinking" && b.thinking.trim().length > 0);
  const shouldRenderContentFallback = message.content.trim().length > 0 && !hasTextBlock && !hasThinkingBlock;
  const inboxAnchoredNotification = useStore((s) => {
    if (!sessionId || message.notification || !message.id) return null;
    return getSingleAnchoredNotification(s.sessionNotifications?.get(sessionId), message.id);
  });
  const resolvedNotification = message.notification ?? inboxAnchoredNotification;
  const suppressToolNotificationMarker = !!resolvedNotification;

  // Only show copy-message button when there's actual text content to copy
  const hasTextContent = message.content || blocks.some((b) => b.type === "text" || b.type === "thinking");

  if (blocks.length === 0 && !message.content.trim() && !resolvedNotification) {
    return null;
  }

  if (blocks.length === 0 && message.content) {
    return (
      <div className={`group/msg relative flex items-start ${hidePaw ? "" : "gap-3"}`}>
        {!hidePaw && <PawTrailAvatar />}
        <div ref={contentRef} className="flex-1 min-w-0 pr-6">
          <MarkdownContent text={message.content} sessionId={sessionId} searchHighlight={searchHighlight} />
          {resolvedNotification && (
            <NotificationMarker
              category={resolvedNotification.category}
              summary={resolvedNotification.summary}
              sessionId={sessionId}
              messageId={message.id}
            />
          )}
          {showTimestamp && <MessageTimestamp timestamp={message.timestamp} turnDurationMs={message.turnDurationMs} />}
        </div>
        <MessageActionBar message={message} contentRef={contentRef} sessionId={sessionId} />
      </div>
    );
  }

  return (
    <div className={`group/msg relative flex items-start ${hidePaw ? "" : "gap-3"}`}>
      {!hidePaw && <PawTrailAvatar />}
      <div ref={contentRef} className="flex-1 min-w-0 space-y-3 pr-6">
        {shouldRenderContentFallback && (
          <MarkdownContent text={message.content} sessionId={sessionId} searchHighlight={searchHighlight} />
        )}
        {grouped.map((group, i) => {
          if (group.kind === "content") {
            return (
              <ContentBlockRenderer
                key={i}
                block={group.block}
                sessionId={sessionId}
                searchHighlight={searchHighlight}
                suppressNotificationMarker={suppressToolNotificationMarker}
              />
            );
          }
          // Single tool_use renders as before
          if (group.items.length === 1) {
            const item = group.items[0];
            return (
              <ToolBlock
                key={i}
                name={item.name}
                input={item.input}
                toolUseId={item.id}
                sessionId={sessionId}
                parentMessageId={message.id}
                suppressNotificationMarker={suppressToolNotificationMarker}
              />
            );
          }
          // Grouped tool_uses
          return (
            <ToolGroupBlock
              key={i}
              name={group.name}
              items={group.items}
              sessionId={sessionId}
              parentMessageId={message.id}
              suppressNotificationMarker={suppressToolNotificationMarker}
            />
          );
        })}
        {resolvedNotification && (
          <NotificationMarker
            category={resolvedNotification.category}
            summary={resolvedNotification.summary}
            sessionId={sessionId}
            messageId={message.id}
          />
        )}
        {showTimestamp && <MessageTimestamp timestamp={message.timestamp} turnDurationMs={message.turnDurationMs} />}
      </div>
      {hasTextContent && <MessageActionBar message={message} contentRef={contentRef} sessionId={sessionId} />}
    </div>
  );
}

/** Action bar for assistant messages -- groups reply + copy buttons with shared hover visibility. */
function MessageActionBar({
  message,
  contentRef,
  sessionId,
}: {
  message: ChatMessage;
  contentRef: React.RefObject<HTMLDivElement | null>;
  sessionId?: string;
}) {
  return (
    <div className="absolute top-0 right-0 shrink-0 flex items-center opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100 transition-opacity">
      {sessionId && <ReplyButton message={message} sessionId={sessionId} />}
      <CopyMessageButton message={message} contentRef={contentRef} sessionId={sessionId} />
    </div>
  );
}

/** Reply button -- sets the reply context in the store so the Composer shows a reply chip. */
function ReplyButton({ message, sessionId }: { message: ChatMessage; sessionId: string }) {
  const handleClick = useCallback(() => {
    const store = useStore.getState();
    const allMessages = store.messages.get(sessionId) ?? [];
    const otherContents = allMessages
      .filter((m) => m.role === "assistant" && m.id !== message.id)
      .map((m) => m.content);
    const previewText = generateReplyPreview(message.content, otherContents);
    store.setReplyContext(sessionId, { messageId: message.id, previewText });
  }, [message, sessionId]);

  return (
    <button
      onClick={handleClick}
      className="p-1 rounded hover:bg-cc-hover transition-all cursor-pointer"
      title="Reply to this message"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        className="w-3.5 h-3.5 text-cc-muted hover:text-cc-fg"
      >
        <path d="M6 3L2 7l4 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 7h7a4 4 0 014 4v1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** Copy button for assistant messages.
 *  Uses the ContextMenu component (proven to work on iOS Safari)
 *  which portals to document.body to escape overflow-hidden ancestors. */
function CopyMessageButton({
  message,
  contentRef,
  sessionId,
}: {
  message: ChatMessage;
  contentRef: React.RefObject<HTMLDivElement | null>;
  sessionId?: string;
}) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const sdkSessions = useStore((s) => s.sdkSessions);

  const showFeedback = useCallback((label: string) => {
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  const handleCopyMarkdown = useCallback(() => {
    const md = getMessageMarkdown(message);
    writeClipboardText(md)
      .then(() => showFeedback("Markdown"))
      .catch(console.error);
  }, [message, showFeedback]);

  const handleCopyPlainText = useCallback(() => {
    const text = getMessagePlainText(message);
    writeClipboardText(text)
      .then(() => showFeedback("Plain text"))
      .catch(console.error);
  }, [message, showFeedback]);

  const handleCopyRichText = useCallback(() => {
    const html = contentRef.current?.innerHTML ?? "";
    const plain = getMessagePlainText(message);
    copyRichText(html, plain)
      .then(() => showFeedback("Rich text"))
      .catch(console.error);
  }, [message, contentRef, showFeedback]);

  const handleCopyLink = useCallback(() => {
    const link = buildCopyMessageLink(sessionId, message, sdkSessions);
    if (!link) return;
    writeClipboardText(link)
      .then(() => showFeedback("Link"))
      .catch(console.error);
  }, [message, sdkSessions, sessionId, showFeedback]);

  const toggle = useCallback(() => {
    if (menuPos) {
      setMenuPos(null);
    } else {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ x: rect.left, y: rect.bottom + 4 });
    }
  }, [menuPos]);

  const items = useMemo<ContextMenuItem[]>(
    () => [
      { label: "Copy as Markdown", onClick: handleCopyMarkdown },
      { label: "Copy as Rich Text", onClick: handleCopyRichText },
      { label: "Copy as Plain Text", onClick: handleCopyPlainText },
      ...(sessionId ? [{ label: "Copy message link", onClick: handleCopyLink }] : []),
    ],
    [handleCopyLink, handleCopyMarkdown, handleCopyPlainText, handleCopyRichText, sessionId],
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="p-1 rounded hover:bg-cc-hover transition-all cursor-pointer"
        title="Copy message"
      >
        {copied ? (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-3.5 h-3.5 text-cc-success"
          >
            <path d="M3 8.5l3.5 3.5 6.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            className="w-3.5 h-3.5 text-cc-muted hover:text-cc-fg"
          >
            <rect x="5.5" y="5.5" width="7" height="8" rx="1" />
            <path d="M3.5 10.5V3a1 1 0 011-1h5.5" />
          </svg>
        )}
      </button>
      {menuPos && <ContextMenu x={menuPos.x} y={menuPos.y} items={items} onClose={() => setMenuPos(null)} />}
    </>
  );
}

/** Auto-approved chip — shows what was approved on line 1, LLM rationale on line 2 in muted text. */
function AutoApprovedChip({ content, reason }: { content: string; reason?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-start gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-green-500/10 text-xs text-green-400/80 font-mono-code max-w-[85%] text-left cursor-pointer hover:bg-green-500/15 transition-colors"
      >
        <svg
          className="w-3 h-3 text-green-400/60 shrink-0 mt-0.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path d="M5.5 8.5l2 2 3.5-4" />
        </svg>
        <div className="min-w-0">
          <span className={expanded ? "" : "line-clamp-1"}>{content}</span>
          {reason && (
            <span className={`block text-[10px] text-green-400/40 mt-0.5 ${expanded ? "" : "line-clamp-1"}`}>
              {reason}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}

function CompactMarker({ message, sessionId }: { message: ChatMessage; sessionId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasSummary = message.content && message.content !== "Conversation compacted";

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-cc-border" />
        <button
          onClick={() => hasSummary && setExpanded(!expanded)}
          className={`flex items-center gap-1.5 text-[11px] text-cc-muted italic font-mono-code shrink-0 px-2 py-0.5 rounded-md transition-colors ${
            hasSummary ? "hover:bg-cc-hover cursor-pointer" : ""
          }`}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-3 h-3 shrink-0 opacity-60"
          >
            <path d="M2 4h12M4 8h8M6 12h4" strokeLinecap="round" />
          </svg>
          <span>Conversation compacted</span>
          {hasSummary && (
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          )}
        </button>
        <div className="flex-1 h-px bg-cc-border" />
      </div>
      {expanded && hasSummary && (
        <div className="mt-2 mx-4 max-h-96 overflow-y-auto rounded-lg border border-cc-border bg-cc-card p-3">
          <MarkdownContent text={message.content} sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}

function ContentBlockRenderer({
  block,
  sessionId,
  searchHighlight,
  suppressNotificationMarker = false,
}: {
  block: ContentBlock;
  sessionId?: string;
  searchHighlight?: { query: string; mode: "strict" | "fuzzy"; isCurrent: boolean } | null;
  suppressNotificationMarker?: boolean;
}) {
  const isCodex = useStore((s) => (sessionId ? s.sessions.get(sessionId)?.backend_type === "codex" : false));

  if (block.type === "text") {
    return <MarkdownContent text={block.text} sessionId={sessionId} searchHighlight={searchHighlight} />;
  }

  if (block.type === "thinking") {
    return <ThinkingBlock text={block.thinking} thinkingTimeMs={block.thinking_time_ms} isCodex={isCodex} />;
  }

  if (block.type === "tool_use") {
    return (
      <ToolBlock
        name={block.name}
        input={block.input}
        toolUseId={block.id}
        suppressNotificationMarker={suppressNotificationMarker}
      />
    );
  }

  if (block.type === "tool_result") {
    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    const isError = block.is_error;
    return (
      <div
        className={`text-xs font-mono-code rounded-lg px-3 py-2 border ${
          isError ? "bg-cc-error/5 border-cc-error/20 text-cc-error" : "bg-cc-card border-cc-border text-cc-muted"
        } max-h-40 overflow-y-auto whitespace-pre-wrap`}
      >
        {content}
      </div>
    );
  }

  return null;
}

function ToolGroupBlock({
  name,
  items,
  sessionId,
  parentMessageId,
  suppressNotificationMarker = false,
}: {
  name: string;
  items: ToolGroupItem[];
  sessionId?: string;
  parentMessageId?: string;
  suppressNotificationMarker?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const headerRef = useRef<HTMLButtonElement>(null);
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);

  // Edit/Write groups: flat stack of inline diffs, no group card wrapper.
  // Each ToolBlock renders as EditInline (flat diff) via its own early return.
  if (name === "Edit" || name === "Write") {
    return (
      <div className="flex flex-col gap-2">
        {items.map((item, i) => (
          <ToolBlock
            key={item.id || i}
            name={item.name}
            input={item.input}
            toolUseId={item.id}
            sessionId={sessionId}
            parentMessageId={parentMessageId}
            suppressNotificationMarker={suppressNotificationMarker}
          />
        ))}
      </div>
    );
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
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums">
          {items.length}
        </span>
      </button>

      {open && (
        <div className="border-t border-cc-border px-3 py-2 flex flex-col gap-1.5">
          {items.map((item, i) => (
            <ToolBlock
              key={item.id || i}
              name={item.name}
              input={item.input}
              toolUseId={item.id}
              sessionId={sessionId}
              parentMessageId={parentMessageId}
              hideLabel={name === "Bash"}
              suppressNotificationMarker={suppressNotificationMarker}
            />
          ))}
          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function formatThinkingSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0";
  return (ms / 1000).toFixed(1).replace(/\.0$/, "");
}

function normalizeCodexThinkingSummary(text: string): string {
  const trimmed = text.trim();
  const wrapped = trimmed.match(/^\*\*([\s\S]+?)\*\*$/);
  return wrapped ? wrapped[1].trim() : text;
}

const CODEX_THINKING_PREVIEW_MAX_CHARS = 80;

export function CodexThinkingInline({ text, thinkingTimeMs }: { text: string; thinkingTimeMs?: number }) {
  const [open, setOpen] = useState(false);
  const summaryText = normalizeCodexThinkingSummary(text);
  const isLongSummary = summaryText.length > CODEX_THINKING_PREVIEW_MAX_CHARS;
  const visibleSummary =
    isLongSummary && !open ? `${summaryText.slice(0, CODEX_THINKING_PREVIEW_MAX_CHARS).trimEnd()}` : summaryText;
  const timeSuffix = typeof thinkingTimeMs === "number" ? ` (${formatThinkingSeconds(thinkingTimeMs)} s)` : "";

  return (
    <div className="flex items-start gap-1.5 text-xs text-cc-muted leading-relaxed py-0.5">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="w-3.5 h-3.5 text-cc-muted/80 shrink-0 mt-[1px]"
      >
        <path d="M8 2.5a4 4 0 014 4c0 1.4-.7 2.5-1.7 3.2-.5.3-.8.9-.8 1.5V12H6.5v-.8c0-.6-.3-1.2-.8-1.5A3.9 3.9 0 014 6.5a4 4 0 014-4z" />
        <path d="M6.2 13.5h3.6M6.7 15h2.6" strokeLinecap="round" />
      </svg>
      <p className="whitespace-pre-wrap break-words">
        {visibleSummary}
        {timeSuffix}
        {isLongSummary && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="inline-flex items-center ml-1 text-cc-muted/80 hover:text-cc-fg transition-colors cursor-pointer align-baseline"
            aria-label={open ? "Collapse thinking summary" : "Expand thinking summary"}
            title={open ? "Collapse" : "Expand"}
          >
            …
          </button>
        )}
      </p>
    </div>
  );
}

function ThinkingBlock({ text, thinkingTimeMs, isCodex }: { text: string; thinkingTimeMs?: number; isCodex: boolean }) {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLButtonElement>(null);

  if (isCodex) {
    return <CodexThinkingInline text={text} thinkingTimeMs={thinkingTimeMs} />;
  }

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden">
      <button
        ref={headerRef}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-cc-muted hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="font-medium">Thinking</span>
        <span className="text-cc-muted/60">{text.length} chars</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0">
          <pre className="text-xs text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
            {text}
          </pre>
          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
