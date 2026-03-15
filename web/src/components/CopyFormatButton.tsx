import { useCallback, useMemo, useRef, useState } from "react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { copyRichText, markdownToPlainText, writeClipboardText } from "../utils/copy-utils.js";

export function CopyFormatButton({
  markdownText,
  getHtml,
  title = "Copy content",
}: {
  markdownText: string;
  getHtml?: () => string;
  title?: string;
}) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const plainText = useMemo(() => markdownToPlainText(markdownText), [markdownText]);

  const showFeedback = useCallback((label: string) => {
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  const handleCopyMarkdown = useCallback(() => {
    writeClipboardText(markdownText)
      .then(() => showFeedback("Markdown"))
      .catch(console.error);
  }, [markdownText, showFeedback]);

  const handleCopyPlainText = useCallback(() => {
    writeClipboardText(plainText)
      .then(() => showFeedback("Plain text"))
      .catch(console.error);
  }, [plainText, showFeedback]);

  const handleCopyRichText = useCallback(() => {
    const html = getHtml?.() ?? "";
    copyRichText(html, plainText)
      .then(() => showFeedback("Rich text"))
      .catch(console.error);
  }, [getHtml, plainText, showFeedback]);

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
    ],
    [handleCopyMarkdown, handleCopyRichText, handleCopyPlainText],
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="p-1 rounded hover:bg-cc-hover transition-all cursor-pointer opacity-100"
        title={title}
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
