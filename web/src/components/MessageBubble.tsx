import { useState, useMemo, useRef, useCallback, useContext, useLayoutEffect, memo } from "react";
import type { ChatMessage, ContentBlock } from "../types.js";
import { isSubagentToolName } from "../types.js";
import { ToolBlock, getToolIcon, getToolLabel, ToolIcon } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CollapseFooter } from "./CollapseFooter.js";
import { Lightbox } from "./Lightbox.js";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { getMessageMarkdown, getMessagePlainText, copyRichText, writeClipboardText } from "../utils/copy-utils.js";
import { useStore } from "../store.js";
import { formatVsCodeSelectionAttachmentLabel } from "../utils/vscode-context.js";
import { api } from "../api.js";
import { PawTrailAvatar, HidePawContext } from "./PawTrail.js";
import { QuestClaimBlock } from "./QuestClaimBlock.js";

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

function MessageTimestamp({
  timestamp,
  align = "left",
  turnDurationMs,
}: {
  timestamp: number;
  align?: "left" | "right";
  turnDurationMs?: number;
}) {
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
      className={`block mt-1 text-[11px] text-cc-muted/70 ${align === "right" ? "text-right" : "text-left"}`}
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
  if (message.role === "system") {
    if (message.variant === "error") {
      const isContextLimit = message.content.toLowerCase().includes("prompt is too long");
      return (
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-cc-error/8 border border-cc-error/20 animate-[fadeSlideIn_0.2s_ease-out]">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-error shrink-0 mt-0.5">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5zM8 11a1 1 0 100 2 1 1 0 000-2z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-cc-error">{message.content}</p>
            {isContextLimit && (
              <p className="text-xs text-cc-muted mt-1">
                Try <code className="px-1 py-0.5 rounded bg-cc-code-bg/30 text-[11px] font-mono-code">/compact</code> to reduce context, or start a new session.
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
            <svg className="w-3 h-3 text-red-400/60 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
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
              <svg className="w-3 h-3 text-green-400/60 shrink-0 mt-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
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
          <QuestClaimBlock quest={message.metadata.quest} variant={message.variant === "quest_submitted" ? "submitted" : "claimed"} />
        </div>
      );
    }
    // Expandable compact marker
    if (message.id.startsWith("compact-boundary-")) {
      return <CompactMarker message={message} />;
    }
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-cc-border" />
        <span className="text-[11px] text-cc-muted italic font-mono-code shrink-0 px-1">
          {message.content}
        </span>
        <div className="flex-1 h-px bg-cc-border" />
      </div>
    );
  }

  // Herd events: render as compact left-side notification (not a user bubble)
  if (message.role === "user" && message.agentSource?.sessionId === "herd-events") {
    return <HerdEventMessage message={message} showTimestamp={showTimestamp} />;
  }

  if (message.role === "user") {
    return <UserMessage message={message} sessionId={sessionId} showTimestamp={showTimestamp} />;
  }

  // Assistant message
  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <AssistantMessage message={message} sessionId={sessionId} showTimestamp={showTimestamp} />
    </div>
  );
});

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
      <div
        ref={contentRef}
        style={isCollapsed ? { maxHeight: COLLAPSE_THRESHOLD, overflow: "hidden" } : undefined}
      >
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
  const hasOpenableSession = !isCron && !isSystem;

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
        onClick: () => { window.location.hash = `#/sessions/${source.sessionId}`; },
      });
    }
    list.push({
      label: `ID: ${source.sessionId.slice(0, 12)}${source.sessionId.length > 12 ? "…" : ""}`,
      onClick: () => { writeClipboardText(source.sessionId).catch(console.error); },
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
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={items}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}

/** Compact inline rendering for herd event summaries — one line per event. */
function HerdEventMessage({ message }: { message: ChatMessage; showTimestamp: boolean }) {
  // The content is formatted by formatHerdEventBatch():
  // "N events from N sessions\n\n#34 Worker A | turn_end | ✓ 56.3s\n#35 Worker B | ..."
  // Extract individual event lines (skip the header and blank lines).
  const lines = message.content
    .split("\n")
    .filter((line) => line.trim().length > 0 && line.startsWith("#"));

  if (lines.length === 0) {
    // Fallback for unexpected format — render as simple muted text
    return (
      <div className="text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 animate-[fadeSlideIn_0.2s_ease-out]">
        {message.content}
      </div>
    );
  }

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out] space-y-0">
      {lines.map((line, i) => (
        <div key={i} className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 leading-snug">
          <span className="text-amber-500/60 shrink-0">◇</span>
          <span className="truncate">{line}</span>
        </div>
      ))}
    </div>
  );
}

function UserMessage({ message, sessionId, showTimestamp }: { message: ChatMessage; sessionId?: string; showTimestamp: boolean }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const isCodex = useStore((s) => s.sessions.get(sessionId ?? "")?.backend_type === "codex");
  const canRevert = !isCodex && !!sessionId;

  return (
    <div className="flex justify-end items-start gap-1 group/msg animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-[85%] sm:max-w-[80%] sm:min-w-[200px] px-3 sm:px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
        {message.agentSource && <AgentSourceBadge source={message.agentSource} />}
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
        {message.images && message.images.length > 0 && sessionId && (
          <div className="flex gap-2 flex-wrap mb-2">
            {message.images.map((img) => {
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
        <CollapsibleContent>
          <pre className="text-[13px] sm:text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
            {message.content}
          </pre>
        </CollapsibleContent>
        {showTimestamp && <MessageTimestamp timestamp={message.timestamp} align="right" />}
      </div>
      <UserMessageMenu message={message} sessionId={sessionId} canRevert={canRevert} />
      {lightboxSrc && (
        <Lightbox
          src={lightboxSrc}
          alt="attachment"
          onClose={() => setLightboxSrc(null)}
        />
      )}
    </div>
  );
}

/** Inline menu button for user messages — copy, revert, etc.
 *  Uses the ContextMenu component (proven to work on iOS Safari)
 *  which portals to document.body to escape overflow-hidden ancestors. */
function UserMessageMenu({ message, sessionId, canRevert }: { message: ChatMessage; sessionId?: string; canRevert: boolean }) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleCopy = useCallback(() => {
    writeClipboardText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(console.error);
  }, [message.content]);

  const handleRevert = useCallback(async () => {
    if (!sessionId || !message.id) return;
    try {
      await api.revertToMessage(sessionId, message.id);
      // Prefill the composer with the reverted message so the user can edit and resend
      useStore.getState().setComposerDraft(sessionId, { text: message.content, images: [] });
    } catch (err) {
      console.error("Revert failed:", err);
    }
  }, [sessionId, message.id, message.content]);

  const toggle = useCallback(() => {
    if (menuPos) {
      setMenuPos(null);
    } else {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ x: rect.left, y: rect.bottom + 4 });
    }
  }, [menuPos]);

  const items = useMemo(() => {
    const list: ContextMenuItem[] = [
      { label: "Copy message", onClick: handleCopy },
    ];
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
  }, [handleCopy, handleRevert, canRevert]);

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
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-success">
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
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={items}
          onClose={() => setMenuPos(null)}
        />
      )}
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

    if (block.type === "tool_use") {
      const last = groups[groups.length - 1];
      if (last?.kind === "tool_group" && last.name === block.name) {
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

const LEADER_TAG_SUFFIX_RE = /\s*@to\((?:user|self)\)\s*$/gm;

function stripLeaderAddressSuffix(text: string): string {
  return text.replace(LEADER_TAG_SUFFIX_RE, "");
}

function stripLeaderSuffixFromLastTextBlock(blocks: ContentBlock[]): ContentBlock[] {
  let changed = false;
  const result = blocks.map((block) => {
    if (block.type !== "text") return block;
    const stripped = stripLeaderAddressSuffix(block.text);
    if (stripped === block.text) return block;
    changed = true;
    return { ...block, text: stripped };
  });
  return changed ? result : blocks;
}

function LeaderUserAddressedMarker() {
  return (
    <div
      data-testid="leader-user-addressed-marker"
      className="mb-1.5 flex items-center text-[10px] font-mono-code tracking-[0.08em] text-cc-primary/80"
    >
      @to(user)
    </div>
  );
}

function AssistantMessage({ message, sessionId, showTimestamp }: { message: ChatMessage; sessionId?: string; showTimestamp: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const hidePaw = useContext(HidePawContext);
  const userAddressed = message.leaderUserAddressed === true;
  const userAddressedBodyClass = userAddressed ? "border-l-2 border-cc-primary/35 pl-3" : "";
  const displayMessage = useMemo(() => {
    const strippedContent = stripLeaderAddressSuffix(message.content);
    const originalBlocks = message.contentBlocks || [];
    const strippedBlocks = stripLeaderSuffixFromLastTextBlock(originalBlocks);

    const contentChanged = strippedContent !== message.content;
    const blocksChanged = strippedBlocks !== originalBlocks;
    if (!contentChanged && !blocksChanged) return message;
    return {
      ...message,
      content: strippedContent,
      contentBlocks: blocksChanged ? strippedBlocks : message.contentBlocks,
    };
  }, [message]);
  const blocks = displayMessage.contentBlocks || [];

  const grouped = useMemo(() => groupContentBlocks(blocks), [blocks]);
  const hasTextBlock = blocks.some((b) => b.type === "text" && b.text.trim().length > 0);
  const hasThinkingBlock = blocks.some((b) => b.type === "thinking" && b.thinking.trim().length > 0);
  const shouldRenderContentFallback = displayMessage.content.trim().length > 0 && !hasTextBlock && !hasThinkingBlock;

  // Only show copy-message button when there's actual text content to copy
  const hasTextContent = displayMessage.content
    || blocks.some((b) => b.type === "text" || b.type === "thinking");

  if (blocks.length === 0 && displayMessage.content) {
    return (
      <div className={`group/msg relative flex items-start ${hidePaw ? "" : "gap-3"}`}>
        {!hidePaw && <PawTrailAvatar />}
        <div
          ref={contentRef}
          data-testid={userAddressed ? "leader-user-addressed-body" : undefined}
          className={`flex-1 min-w-0 pr-6 ${userAddressedBodyClass}`}
        >
          {userAddressed && <LeaderUserAddressedMarker />}
          <MarkdownContent text={displayMessage.content} />
          {showTimestamp && <MessageTimestamp timestamp={displayMessage.timestamp} turnDurationMs={displayMessage.turnDurationMs} />}
        </div>
        <CopyMessageButton message={displayMessage} contentRef={contentRef} />
      </div>
    );
  }

  return (
    <div className={`group/msg relative flex items-start ${hidePaw ? "" : "gap-3"}`}>
      {!hidePaw && <PawTrailAvatar />}
      <div
        ref={contentRef}
        data-testid={userAddressed ? "leader-user-addressed-body" : undefined}
        className={`flex-1 min-w-0 space-y-3 pr-6 ${userAddressedBodyClass}`}
      >
        {userAddressed && <LeaderUserAddressedMarker />}
        {shouldRenderContentFallback && <MarkdownContent text={displayMessage.content} />}
        {grouped.map((group, i) => {
          if (group.kind === "content") {
            return <ContentBlockRenderer key={i} block={group.block} sessionId={sessionId} />;
          }
          // Single tool_use renders as before
          if (group.items.length === 1) {
            const item = group.items[0];
            return <ToolBlock key={i} name={item.name} input={item.input} toolUseId={item.id} sessionId={sessionId} />;
          }
          // Grouped tool_uses
          return <ToolGroupBlock key={i} name={group.name} items={group.items} sessionId={sessionId} />;
        })}
        {showTimestamp && <MessageTimestamp timestamp={displayMessage.timestamp} turnDurationMs={displayMessage.turnDurationMs} />}
      </div>
      {hasTextContent && <CopyMessageButton message={displayMessage} contentRef={contentRef} />}
    </div>
  );
}


/** Copy button for assistant messages.
 *  Uses the ContextMenu component (proven to work on iOS Safari)
 *  which portals to document.body to escape overflow-hidden ancestors. */
function CopyMessageButton({ message, contentRef }: { message: ChatMessage; contentRef: React.RefObject<HTMLDivElement | null> }) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const showFeedback = useCallback((label: string) => {
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  const handleCopyMarkdown = useCallback(() => {
    const md = getMessageMarkdown(message);
    writeClipboardText(md).then(() => showFeedback("Markdown")).catch(console.error);
  }, [message, showFeedback]);

  const handleCopyPlainText = useCallback(() => {
    const text = getMessagePlainText(message);
    writeClipboardText(text).then(() => showFeedback("Plain text")).catch(console.error);
  }, [message, showFeedback]);

  const handleCopyRichText = useCallback(() => {
    const html = contentRef.current?.innerHTML ?? "";
    const plain = getMessagePlainText(message);
    copyRichText(html, plain).then(() => showFeedback("Rich text")).catch(console.error);
  }, [message, contentRef, showFeedback]);

  const toggle = useCallback(() => {
    if (menuPos) {
      setMenuPos(null);
    } else {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ x: rect.left, y: rect.bottom + 4 });
    }
  }, [menuPos]);

  const items = useMemo<ContextMenuItem[]>(() => [
    { label: "Copy as Markdown", onClick: handleCopyMarkdown },
    { label: "Copy as Rich Text", onClick: handleCopyRichText },
    { label: "Copy as Plain Text", onClick: handleCopyPlainText },
  ], [handleCopyMarkdown, handleCopyRichText, handleCopyPlainText]);

  return (
    <div className="absolute top-0 right-0 shrink-0">
      <button
        ref={btnRef}
        onClick={toggle}
        className={`p-1 rounded hover:bg-cc-hover transition-all cursor-pointer ${
          menuPos || copied ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100"
        }`}
        title="Copy message"
      >
        {copied ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-success">
            <path d="M3 8.5l3.5 3.5 6.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-3.5 h-3.5 text-cc-muted hover:text-cc-fg">
            <rect x="5.5" y="5.5" width="7" height="8" rx="1" />
            <path d="M3.5 10.5V3a1 1 0 011-1h5.5" />
          </svg>
        )}
      </button>
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={items}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
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
        <svg className="w-3 h-3 text-green-400/60 shrink-0 mt-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M5.5 8.5l2 2 3.5-4" />
        </svg>
        <div className="min-w-0">
          <span className={expanded ? "" : "line-clamp-1"}>{content}</span>
          {reason && (
            <span className={`block text-[10px] text-green-400/40 mt-0.5 ${expanded ? "" : "line-clamp-1"}`}>{reason}</span>
          )}
        </div>
      </button>
    </div>
  );
}

function CompactMarker({ message }: { message: ChatMessage }) {
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
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3 shrink-0 opacity-60">
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
          <MarkdownContent text={message.content} />
        </div>
      )}
    </div>
  );
}

function ContentBlockRenderer({ block, sessionId }: { block: ContentBlock; sessionId?: string }) {
  const isCodex = useStore((s) => sessionId ? s.sessions.get(sessionId)?.backend_type === "codex" : false);

  if (block.type === "text") {
    return <MarkdownContent text={block.text} />;
  }

  if (block.type === "thinking") {
    return <ThinkingBlock text={block.thinking} thinkingTimeMs={block.thinking_time_ms} isCodex={isCodex} />;
  }

  if (block.type === "tool_use") {
    return <ToolBlock name={block.name} input={block.input} toolUseId={block.id} />;
  }

  if (block.type === "tool_result") {
    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    const isError = block.is_error;
    return (
      <div className={`text-xs font-mono-code rounded-lg px-3 py-2 border ${
        isError
          ? "bg-cc-error/5 border-cc-error/20 text-cc-error"
          : "bg-cc-card border-cc-border text-cc-muted"
      } max-h-40 overflow-y-auto whitespace-pre-wrap`}>
        {content}
      </div>
    );
  }

  return null;
}

function ToolGroupBlock({ name, items, sessionId }: { name: string; items: ToolGroupItem[]; sessionId?: string }) {
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
          <ToolBlock key={item.id || i} name={item.name} input={item.input} toolUseId={item.id} sessionId={sessionId} />
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
            <ToolBlock key={item.id || i} name={item.name} input={item.input} toolUseId={item.id} sessionId={sessionId} />
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

function ThinkingBlock({ text, thinkingTimeMs, isCodex }: { text: string; thinkingTimeMs?: number; isCodex: boolean }) {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLButtonElement>(null);

  if (isCodex) {
    const summaryText = normalizeCodexThinkingSummary(text);
    const isLongSummary = summaryText.length > CODEX_THINKING_PREVIEW_MAX_CHARS;
    const visibleSummary = isLongSummary && !open
      ? `${summaryText.slice(0, CODEX_THINKING_PREVIEW_MAX_CHARS).trimEnd()}`
      : summaryText;
    const timeSuffix = typeof thinkingTimeMs === "number" ? ` (${formatThinkingSeconds(thinkingTimeMs)} s)` : "";
    return (
      <div className="flex items-start gap-1.5 text-xs text-cc-muted leading-relaxed py-0.5">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-muted/80 shrink-0 mt-[1px]">
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
