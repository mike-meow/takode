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

/** Calculate menu position: above the selection on desktop, below on touch
 *  (where the native iOS callout and handles appear above). */
function computeMenuPosition(rect: DOMRect, preferBelow: boolean): { x: number; y: number } {
  const MENU_WIDTH_ESTIMATE = 180;
  const MENU_HEIGHT_ESTIMATE = 68;
  const GAP = 6;

  let x = rect.left + rect.width / 2 - MENU_WIDTH_ESTIMATE / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH_ESTIMATE - 8));

  if (preferBelow) {
    // Touch: place below selection to avoid overlapping native iOS callout above
    const belowY = rect.bottom + GAP;
    const aboveY = rect.top - GAP - MENU_HEIGHT_ESTIMATE;
    return { x, y: belowY + MENU_HEIGHT_ESTIMATE > window.innerHeight - 4 ? Math.max(4, aboveY) : belowY };
  }

  // Desktop: place above selection so the highlighted text stays visible
  const aboveY = rect.top - GAP - MENU_HEIGHT_ESTIMATE;
  const y = aboveY >= 4 ? aboveY : rect.bottom + GAP;
  return { x, y };
}

/**
 * Detects text selection within assistant message content inside the given container.
 *
 * Returns selection state with position data for rendering a floating context menu.
 * Only activates for non-empty selections fully within a single assistant message.
 * On touch devices, delays evaluation to let the native selection UI finalize.
 */
export function useTextSelection(containerRef: RefObject<HTMLElement | null>): TextSelectionState {
  const [state, setState] = useState<Omit<TextSelectionState, "clear">>(EMPTY_STATE);
  const rafRef = useRef<number>(0);
  const touchDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether we should suppress the next selectionchange (after programmatic clear)
  const suppressRef = useRef(false);
  // Track mouse-down state so we only show the menu after mouseup, not mid-drag
  const mouseDownRef = useRef(false);
  // Track touch state so we only show the menu after touchend, not mid-drag
  const touchActiveRef = useRef(false);
  // Whether the current interaction started with touch (affects menu position)
  const isTouchInteractionRef = useRef(false);

  const clear = useCallback(() => {
    setState(EMPTY_STATE);
    suppressRef.current = true;
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => {
      setTimeout(() => {
        suppressRef.current = false;
      }, 0);
    });
  }, []);

  const container = containerRef.current;

  useEffect(() => {
    if (!container) return;

    function evaluateSelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setState(EMPTY_STATE);
        return;
      }

      const anchorMsg = findMessageAncestor(sel.anchorNode);
      const focusMsg = findMessageAncestor(sel.focusNode);

      if (!anchorMsg || !focusMsg || anchorMsg !== focusMsg) {
        setState(EMPTY_STATE);
        return;
      }

      if (!container!.contains(anchorMsg)) {
        setState(EMPTY_STATE);
        return;
      }

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
        position: computeMenuPosition(rect, isTouchInteractionRef.current),
      });
    }

    function scheduleEvaluation() {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(evaluateSelection);
    }

    // ─── Mouse handlers (desktop) ────────────────────────────────────
    function handleMouseDown() {
      mouseDownRef.current = true;
      isTouchInteractionRef.current = false;
    }

    function handleMouseUp() {
      mouseDownRef.current = false;
      scheduleEvaluation();
    }

    // ─── Touch handlers (iOS / mobile) ───────────────────────────────
    function handleTouchStart() {
      touchActiveRef.current = true;
      isTouchInteractionRef.current = true;
    }

    function handleTouchEnd() {
      touchActiveRef.current = false;
      // Delay evaluation to let iOS finalize the selection via native handles.
      // Without this, getSelection() may return stale or incomplete results.
      if (touchDelayRef.current) clearTimeout(touchDelayRef.current);
      touchDelayRef.current = setTimeout(scheduleEvaluation, 300);
    }

    // selectionchange fires during drag and after iOS handle adjustments.
    // Only evaluate after the pointer/touch is released.
    function handleSelectionChange() {
      if (suppressRef.current) return;
      if (mouseDownRef.current || touchActiveRef.current) return;
      scheduleEvaluation();
    }

    function handleScroll() {
      if (suppressRef.current) return;
      cancelAnimationFrame(rafRef.current);
      setState(EMPTY_STATE);
    }

    container.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("selectionchange", handleSelectionChange);
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
      container.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("selectionchange", handleSelectionChange);
      container.removeEventListener("scroll", handleScroll);
      cancelAnimationFrame(rafRef.current);
      if (touchDelayRef.current) clearTimeout(touchDelayRef.current);
    };
  }, [container]);

  return { ...state, clear };
}
