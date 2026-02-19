import { useState, useCallback } from "react";
import { writeClipboardText } from "../utils/copy-utils.js";

/**
 * A small copy-to-clipboard button for code blocks. Renders a clipboard icon
 * that shows a checkmark for 1.5s after a successful copy. Designed to be
 * placed inside a `group/code` container so it reveals on hover.
 *
 * Pass `text` for static content, or `getText` for lazy evaluation (e.g. reading from a ref).
 */
export function CodeCopyButton({ text, getText }: { text?: string; getText?: () => string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const content = getText ? getText() : (text ?? "");
    writeClipboardText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(console.error);
  }, [text, getText]);

  return (
    <button
      onClick={handleCopy}
      className="opacity-100 sm:opacity-0 sm:group-hover/code:opacity-100 transition-opacity p-1 rounded hover:bg-white/10 cursor-pointer"
      title={copied ? "Copied!" : "Copy code"}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-success">
          <path d="M3 8.5l3.5 3.5 6.5-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-3.5 h-3.5 text-cc-muted hover:text-cc-code-fg">
          <rect x="5.5" y="5.5" width="7" height="8" rx="1" />
          <path d="M3.5 10.5V3a1 1 0 011-1h5.5" />
        </svg>
      )}
    </button>
  );
}
