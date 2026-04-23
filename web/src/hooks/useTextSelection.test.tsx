// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { useTextSelection } from "./useTextSelection.js";

type MockSelectionState = {
  text: string;
  anchorNode: Node | null;
  focusNode: Node | null;
  rect: DOMRect;
};

function SelectionHarness() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, setMounted] = useState(false);
  const selection = useTextSelection(containerRef);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div ref={containerRef} data-testid="container">
      <div data-message-id="assistant-1" data-message-role="assistant">
        <span data-testid="assistant-text">Selected assistant text</span>
      </div>
      <div data-testid="selection-active">{selection.isActive ? "true" : "false"}</div>
      <div data-testid="selection-text">{selection.plainText}</div>
      <div data-testid="selection-position">
        {selection.position ? `${selection.position.x},${selection.position.y}` : "none"}
      </div>
    </div>
  );
}

// jsdom selection support is too limited for this hook path, so these tests use
// a controlled mock that lets us model the cloned range and native clear behavior.
function createSelectionMock(state: MockSelectionState) {
  const range = {
    cloneRange: () => range,
    getBoundingClientRect: () => state.rect,
  } as unknown as Range;

  const removeAllRanges = vi.fn(() => {
    state.text = "";
    state.anchorNode = null;
    state.focusNode = null;
  });

  const selection = {
    get isCollapsed() {
      return state.text.length === 0;
    },
    get anchorNode() {
      return state.anchorNode;
    },
    get focusNode() {
      return state.focusNode;
    },
    toString: () => state.text,
    getRangeAt: () => range,
    removeAllRanges,
  } as unknown as Selection;

  return { selection, removeAllRanges };
}

describe("useTextSelection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Verifies the mobile regression fix: touch selection should keep Takode's
  // cached menu state alive even after the hook dismisses the native OS selection.
  it("keeps the app selection menu active on touch after dismissing the native DOM selection", () => {
    render(<SelectionHarness />);

    const container = screen.getByTestId("container");
    const textNode = screen.getByTestId("assistant-text").firstChild;
    if (!textNode) throw new Error("Missing assistant text node");

    const selectionState: MockSelectionState = {
      text: "Selected assistant text",
      anchorNode: textNode,
      focusNode: textNode,
      rect: {
        left: 40,
        top: 120,
        right: 220,
        bottom: 160,
        width: 180,
        height: 40,
        x: 40,
        y: 120,
        toJSON: () => ({}),
      } as DOMRect,
    };
    const { selection, removeAllRanges } = createSelectionMock(selectionState);
    vi.spyOn(window, "getSelection").mockReturnValue(selection);

    fireEvent.touchStart(container);

    act(() => {
      fireEvent.touchEnd(document);
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByTestId("selection-active").textContent).toBe("true");
    expect(screen.getByTestId("selection-text").textContent).toBe("Selected assistant text");
    expect(screen.getByTestId("selection-position").textContent).not.toBe("none");
    expect(removeAllRanges).toHaveBeenCalledOnce();
    expect(selectionState.text).toBe("");
  });

  // Verifies the desktop edge case: mouse selection still relies on the live DOM
  // selection and must not trigger the touch-only native-selection dismissal.
  it("preserves the native DOM selection on mouse interactions", () => {
    render(<SelectionHarness />);

    const container = screen.getByTestId("container");
    const textNode = screen.getByTestId("assistant-text").firstChild;
    if (!textNode) throw new Error("Missing assistant text node");

    const selectionState: MockSelectionState = {
      text: "Selected assistant text",
      anchorNode: textNode,
      focusNode: textNode,
      rect: {
        left: 40,
        top: 120,
        right: 220,
        bottom: 160,
        width: 180,
        height: 40,
        x: 40,
        y: 120,
        toJSON: () => ({}),
      } as DOMRect,
    };
    const { selection, removeAllRanges } = createSelectionMock(selectionState);
    vi.spyOn(window, "getSelection").mockReturnValue(selection);

    fireEvent.mouseDown(container);
    act(() => {
      fireEvent.mouseUp(document);
    });

    expect(screen.getByTestId("selection-active").textContent).toBe("true");
    expect(screen.getByTestId("selection-text").textContent).toBe("Selected assistant text");
    expect(selectionState.text).toBe("Selected assistant text");
    expect(removeAllRanges).not.toHaveBeenCalled();
  });
});
