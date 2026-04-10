import { useMemo, useCallback } from "react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { useStore } from "../store.js";
import { copyRichText, writeClipboardText } from "../utils/copy-utils.js";
import { htmlFragmentToMarkdown } from "../utils/html-to-markdown.js";
import type { TextSelectionState } from "../hooks/useTextSelection.js";

interface SelectionContextMenuProps {
  selection: TextSelectionState;
  sessionId: string;
  onClose: () => void;
}

/**
 * Floating context menu shown when the user selects text in an assistant message.
 * Offers "Quote selected" (injects blockquote into composer) and a "Copy" submenu
 * with three formats: rich text, markdown, and plain text.
 */
export function SelectionContextMenu({ selection, sessionId, onClose }: SelectionContextMenuProps) {
  const handleQuote = useCallback(() => {
    const text = selection.plainText;
    if (!text.trim()) return;

    const blockquote = text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

    const store = useStore.getState();
    const currentDraft = store.composerDrafts.get(sessionId);
    const currentText = currentDraft?.text ?? "";
    const separator = currentText.length > 0 ? "\n\n" : "";
    const newText = currentText + separator + blockquote + "\n\n";

    store.setComposerDraft(sessionId, {
      text: newText,
      images: currentDraft?.images ?? [],
    });

    // Signal the Composer to focus
    store.focusComposer();

    // Clear both the menu and the browser selection
    selection.clear();
    onClose();
  }, [selection, sessionId, onClose]);

  const handleCopyRichText = useCallback(() => {
    if (!selection.range) return;
    const fragment = selection.range.cloneContents();
    const tempDiv = document.createElement("div");
    tempDiv.appendChild(fragment);
    const html = tempDiv.innerHTML;
    const plainText = selection.plainText;
    copyRichText(html, plainText).catch(console.error);
    onClose();
  }, [selection, onClose]);

  const handleCopyMarkdown = useCallback(() => {
    if (!selection.range) return;
    const markdown = htmlFragmentToMarkdown(selection.range);
    writeClipboardText(markdown).catch(console.error);
    onClose();
  }, [selection, onClose]);

  const handleCopyPlainText = useCallback(() => {
    writeClipboardText(selection.plainText).catch(console.error);
    onClose();
  }, [selection, onClose]);

  const items = useMemo<ContextMenuItem[]>(
    () => [
      { label: "Quote selected", onClick: handleQuote },
      {
        label: "Copy",
        onClick: () => {},
        children: [
          { label: "Rich text", onClick: handleCopyRichText },
          { label: "Markdown", onClick: handleCopyMarkdown },
          { label: "Plain text", onClick: handleCopyPlainText },
        ],
      },
    ],
    [handleQuote, handleCopyRichText, handleCopyMarkdown, handleCopyPlainText],
  );

  if (!selection.isActive || !selection.position) return null;

  return <ContextMenu x={selection.position.x} y={selection.position.y} items={items} onClose={onClose} />;
}
