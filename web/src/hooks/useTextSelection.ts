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
  /** Hides Takode's selection menu without changing the browser selection */
  dismiss: () => void;
}

const EMPTY_STATE: Omit<TextSelectionState, "clear" | "dismiss"> = {
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

/** Walk up from a node to find an explicit chat-selection Markdown scope. */
function findChatSelectionScope(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement && current.dataset.chatSelectionScope === "true") {
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
    // Touch: keep the DOM selection intact and move Takode's menu away from
    // the native callout zone around the selected text.
    const edgeGap = Math.max(12, GAP);
    const selectionMidpoint = rect.top + rect.height / 2;
    const y =
      selectionMidpoint < window.innerHeight / 2 ? window.innerHeight - MENU_HEIGHT_ESTIMATE - edgeGap : edgeGap;
    return { x, y: Math.max(4, Math.min(y, window.innerHeight - MENU_HEIGHT_ESTIMATE - 4)) };
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
  const [state, setState] = useState<Omit<TextSelectionState, "clear" | "dismiss">>(EMPTY_STATE);
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

  const suppressSelectionChanges = useCallback((callback: () => void) => {
    suppressRef.current = true;
    callback();
    requestAnimationFrame(() => {
      setTimeout(() => {
        suppressRef.current = false;
      }, 0);
    });
  }, []);

  const clear = useCallback(() => {
    setState(EMPTY_STATE);
    suppressSelectionChanges(() => {
      window.getSelection()?.removeAllRanges();
    });
  }, [suppressSelectionChanges]);

  const dismiss = useCallback(() => {
    setState(EMPTY_STATE);
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

      const anchorScope = findChatSelectionScope(sel.anchorNode);
      const focusScope = findChatSelectionScope(sel.focusNode);

      if (!anchorScope || !focusScope || anchorScope !== focusScope) {
        setState(EMPTY_STATE);
        return;
      }

      const anchorMsg = findMessageAncestor(anchorScope);
      const focusMsg = findMessageAncestor(focusScope);

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

      const nextState = {
        isActive: true,
        plainText: sel.toString(),
        range: range.cloneRange(),
        position: computeMenuPosition(rect, isTouchInteractionRef.current),
      };

      setState(nextState);
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
  }, [container, suppressSelectionChanges]);

  return { ...state, clear, dismiss };
}
