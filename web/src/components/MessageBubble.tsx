import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import type { ChatMessage, ContentBlock } from "../types.js";
import { ToolBlock, getToolIcon, getToolLabel, ToolIcon } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { Lightbox } from "./Lightbox.js";
import { getMessageMarkdown, getMessagePlainText, copyRichText } from "../utils/copy-utils.js";

export function MessageBubble({ message, sessionId }: { message: ChatMessage; sessionId?: string }) {
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
            <div className="flex items-start gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-green-500/10 text-xs font-mono-code">
              <svg className="w-3 h-3 text-green-400/60 shrink-0 mt-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M5.5 8.5l2 2 3.5-4" />
              </svg>
              <div className="min-w-0">
                {answers.map((a, i) => (
                  <div key={i} className="text-cc-muted truncate">
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
      return (
        <div className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-green-500/10 text-xs text-green-400/80 font-mono-code">
            <svg className="w-3 h-3 text-green-400/60 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M5.5 8.5l2 2 3.5-4" />
            </svg>
            <span>{message.content}</span>
          </div>
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

  if (message.role === "user") {
    return <UserMessage message={message} />;
  }

  // Assistant message
  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <AssistantMessage message={message} sessionId={sessionId} />
    </div>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  return (
    <div className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-[85%] sm:max-w-[80%] px-3 sm:px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
        {message.images && message.images.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-2">
            {message.images.map((img, i) => {
              const src = `data:${img.media_type};base64,${img.data}`;
              return (
                <img
                  key={i}
                  src={src}
                  alt="attachment"
                  className="max-w-[150px] sm:max-w-[200px] max-h-[120px] sm:max-h-[150px] rounded-lg object-cover cursor-zoom-in hover:opacity-80 transition-opacity"
                  onClick={() => setLightboxSrc(src)}
                  data-testid="image-thumbnail"
                />
              );
            })}
          </div>
        )}
        <pre className="text-[13px] sm:text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
          {message.content}
        </pre>
      </div>
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

function AssistantMessage({ message, sessionId }: { message: ChatMessage; sessionId?: string }) {
  const blocks = message.contentBlocks || [];
  const contentRef = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => groupContentBlocks(blocks), [blocks]);

  if (blocks.length === 0 && message.content) {
    return (
      <div className="group/msg relative flex items-start gap-3">
        <AssistantAvatar />
        <div ref={contentRef} className="flex-1 min-w-0">
          <MarkdownContent text={message.content} />
        </div>
        <CopyMessageButton message={message} contentRef={contentRef} />
      </div>
    );
  }

  return (
    <div className="group/msg relative flex items-start gap-3">
      <AssistantAvatar />
      <div ref={contentRef} className="flex-1 min-w-0 space-y-3">
        {grouped.map((group, i) => {
          if (group.kind === "content") {
            return <ContentBlockRenderer key={i} block={group.block} />;
          }
          // Single tool_use renders as before
          if (group.items.length === 1) {
            const item = group.items[0];
            return <ToolBlock key={i} name={item.name} input={item.input} toolUseId={item.id} sessionId={sessionId} />;
          }
          // Grouped tool_uses
          return <ToolGroupBlock key={i} name={group.name} items={group.items} sessionId={sessionId} />;
        })}
      </div>
      <CopyMessageButton message={message} contentRef={contentRef} />
    </div>
  );
}

function AssistantAvatar() {
  return (
    <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary">
        <circle cx="8" cy="8" r="3" />
      </svg>
    </div>
  );
}

function CopyMessageButton({ message, contentRef }: { message: ChatMessage; contentRef: React.RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const showFeedback = useCallback((label: string) => {
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
    setOpen(false);
  }, []);

  const handleCopyMarkdown = useCallback(() => {
    const md = getMessageMarkdown(message);
    navigator.clipboard.writeText(md).then(() => showFeedback("Markdown")).catch(console.error);
  }, [message, showFeedback]);

  const handleCopyPlainText = useCallback(() => {
    const text = getMessagePlainText(message);
    navigator.clipboard.writeText(text).then(() => showFeedback("Plain text")).catch(console.error);
  }, [message, showFeedback]);

  const handleCopyRichText = useCallback(() => {
    const html = contentRef.current?.innerHTML ?? "";
    const plain = getMessagePlainText(message);
    copyRichText(html, plain).then(() => showFeedback("Rich text")).catch(console.error);
  }, [message, contentRef, showFeedback]);

  return (
    <div className="absolute top-0 right-0 shrink-0">
      <button
        ref={btnRef}
        onClick={() => setOpen(!open)}
        className={`p-1 rounded hover:bg-cc-hover transition-all cursor-pointer ${
          open || copied ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100"
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
      {open && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-1 z-50 min-w-[160px] bg-cc-card border border-cc-border rounded-lg shadow-lg py-1 overflow-hidden"
        >
          <button
            onClick={handleCopyMarkdown}
            className="w-full px-3 py-1.5 text-left text-[12px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            Copy as Markdown
          </button>
          <button
            onClick={handleCopyRichText}
            className="w-full px-3 py-1.5 text-left text-[12px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            Copy as Rich Text
          </button>
          <button
            onClick={handleCopyPlainText}
            className="w-full px-3 py-1.5 text-left text-[12px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            Copy as Plain Text
          </button>
        </div>
      )}
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

function ContentBlockRenderer({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return <MarkdownContent text={block.text} />;
  }

  if (block.type === "thinking") {
    return <ThinkingBlock text={block.thinking} />;
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
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);

  return (
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
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums">
          {items.length}
        </span>
      </button>

      {open && (
        <div className="border-t border-cc-border px-3 py-2 flex flex-col gap-1.5">
          {items.map((item, i) => (
            <ToolBlock key={item.id || i} name={item.name} input={item.input} toolUseId={item.id} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden">
      <button
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
        </div>
      )}
    </div>
  );
}
