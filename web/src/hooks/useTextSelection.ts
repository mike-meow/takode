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

/** Calculate menu position: bottom-aligned above the selection rect so the menu
 *  doesn't obscure the highlighted text. Falls back to below if no space above. */
function computeMenuPosition(rect: DOMRect): { x: number; y: number } {
  const MENU_WIDTH_ESTIMATE = 180;
  const MENU_HEIGHT_ESTIMATE = 68; // 2 items ~28px each + 8px padding + 4px border
  const GAP = 6;

  let x = rect.left + rect.width / 2 - MENU_WIDTH_ESTIMATE / 2;
  // Clamp to viewport horizontal bounds
  x = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH_ESTIMATE - 8));

  // Place the menu's bottom edge above the selection top, so the selection stays visible.
  // If there isn't enough room above, flip to below the selection.
  const aboveY = rect.top - GAP - MENU_HEIGHT_ESTIMATE;
  let y: number;
  if (aboveY >= 4) {
    y = aboveY;
  } else {
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
  // Track mouse-down state so we only show the menu after mouseup, not mid-drag
  const mouseDownRef = useRef(false);

  const clear = useCallback(() => {
    setState(EMPTY_STATE);
    suppressRef.current = true;
    window.getSelection()?.removeAllRanges();
    // Reset suppress after both a RAF and a microtask to ensure all pending
    // selectionchange handlers have fired before we start listening again
    requestAnimationFrame(() => {
      setTimeout(() => {
        suppressRef.current = false;
      }, 0);
    });
  }, []);

  // Capture the element on every render so the effect re-runs when it transitions
  // from null (e.g. during a loading state) to a real DOM node.
  const container = containerRef.current;

  useEffect(() => {
    // Skip on touch-only devices -- mobile has native selection UI
    if (!window.matchMedia("(pointer: fine)").matches) return;

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

      // Must be within our container (non-null: effect only registers when container exists)
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

    function scheduleEvaluation() {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(evaluateSelection);
    }

    function handleMouseDown() {
      mouseDownRef.current = true;
    }

    // Only show the menu after the user releases the mouse (drag complete).
    // Listens on document (not container) so the flag resets even if mouseup
    // fires outside the container (e.g., user drags out of the message area).
    function handleMouseUp() {
      mouseDownRef.current = false;
      scheduleEvaluation();
    }

    // selectionchange fires continuously during drag -- only use it to detect
    // deselection (collapse) or keyboard-driven selection changes AFTER mouseup.
    function handleSelectionChange() {
      if (suppressRef.current) return;
      if (mouseDownRef.current) return; // Don't activate mid-drag
      scheduleEvaluation();
    }

    // Dismiss on scroll -- the menu position becomes stale
    function handleScroll() {
      if (suppressRef.current) return;
      cancelAnimationFrame(rafRef.current);
      setState(EMPTY_STATE);
    }

    container.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
      container.removeEventListener("scroll", handleScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [container]);

  return { ...state, clear };
}
