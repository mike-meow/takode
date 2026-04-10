import { useState, useEffect, useCallback, useRef, type RefObject } from "react";

export interface TextSelectionState {
  /** Whether there's an active, non-empty selection within an assistant message */
  isActive: boolean;
  /** The plain text of the selection */
  plainText: string;
  /** The Selection Range object (for extracting HTML) */
  range: Range | null;
  /** Position for the floating menu (x, y relative to viewport) */
  position: { x: number; y: number } | null;
  /** Clears the selection and resets state */
  clear: () => void;
}

const EMPTY_STATE: Omit<TextSelectionState, "clear"> = {
  isActive: false,
  plainText: "",
  range: null,
  position: null,
};

/** Walk up from a node to find the nearest ancestor with a `data-message-id` attribute. */
function findMessageAncestor(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement && current.dataset.messageId) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

/** Calculate menu position: centered above the selection rect, flipped below if no space. */
function computeMenuPosition(rect: DOMRect): { x: number; y: number } {
  const MENU_WIDTH_ESTIMATE = 180;
  const GAP = 8;

  let x = rect.left + rect.width / 2 - MENU_WIDTH_ESTIMATE / 2;
  // Clamp to viewport horizontal bounds
  x = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH_ESTIMATE - 8));

  // Prefer above the selection; flip below if not enough space
  let y = rect.top - GAP;
  if (y < 40) {
    y = rect.bottom + GAP;
  }

  return { x, y };
}

/**
 * Detects text selection within assistant message content inside the given container.
 *
 * Returns selection state with position data for rendering a floating context menu.
 * Only activates for non-empty selections fully within a single assistant message.
 * Skipped on touch-only devices (mobile has native copy/paste UI).
 */
export function useTextSelection(containerRef: RefObject<HTMLElement | null>): TextSelectionState {
  const [state, setState] = useState<Omit<TextSelectionState, "clear">>(EMPTY_STATE);
  const rafRef = useRef<number>(0);
  // Track whether we should suppress the next selectionchange (after programmatic clear)
  const suppressRef = useRef(false);

  const clear = useCallback(() => {
    setState(EMPTY_STATE);
    suppressRef.current = true;
    window.getSelection()?.removeAllRanges();
    // Reset suppress after a tick so future natural selectionchange events are processed
    requestAnimationFrame(() => {
      suppressRef.current = false;
    });
  }, []);

  useEffect(() => {
    // Skip on touch-only devices -- mobile has native selection UI
    if (!window.matchMedia("(pointer: fine)").matches) return;

    const container = containerRef.current;
    if (!container) return;

    function evaluateSelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setState(EMPTY_STATE);
        return;
      }

      const anchorMsg = findMessageAncestor(sel.anchorNode);
      const focusMsg = findMessageAncestor(sel.focusNode);

      // Both endpoints must be within a message, and the same message
      if (!anchorMsg || !focusMsg || anchorMsg !== focusMsg) {
        setState(EMPTY_STATE);
        return;
      }

      // Must be within our container
      if (!container!.contains(anchorMsg)) {
        setState(EMPTY_STATE);
        return;
      }

      // Only assistant messages
      if (anchorMsg.dataset.messageRole !== "assistant") {
        setState(EMPTY_STATE);
        return;
      }

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setState(EMPTY_STATE);
        return;
      }

      setState({
        isActive: true,
        plainText: sel.toString(),
        range: range.cloneRange(),
        position: computeMenuPosition(rect),
      });
    }

    function handleMouseUp() {
      // Delay evaluation to let browser finalize the selection
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(evaluateSelection);
    }

    function handleSelectionChange() {
      if (suppressRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setState(EMPTY_STATE);
      }
    }

    container.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    // Dismiss on scroll -- the menu position becomes stale when the container scrolls
    container.addEventListener("scroll", handleSelectionChange, { passive: true });

    return () => {
      container.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
      container.removeEventListener("scroll", handleSelectionChange);
      cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef]);

  return { ...state, clear };
}
