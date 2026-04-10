import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * Minimum distance (px) between header and footer to show the collapse button.
 * Set high enough that the header would realistically be off-screen before the
 * footer appears (~half a typical viewport). Too low and every short tool
 * output gets a redundant "Collapse" button.
 */
const MIN_HEIGHT_FOR_FOOTER = 400;

/** Walk up the DOM to find the nearest scrollable ancestor. */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const { overflow, overflowY } = getComputedStyle(parent);
    if (overflow === "auto" || overflow === "scroll" || overflowY === "auto" || overflowY === "scroll") {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

/**
 * Collapse and adjust scroll so the header appears at the same viewport
 * position the collapse button occupied — feels like "folding up" into place.
 */
function collapseAndSnap(e: React.MouseEvent, headerRef: RefObject<HTMLElement | null>, onCollapse: () => void) {
  const buttonY = e.currentTarget.getBoundingClientRect().top;
  flushSync(() => onCollapse());
  const header = headerRef.current;
  if (!header) return;
  const headerY = header.getBoundingClientRect().top;
  const scrollParent = findScrollParent(header);
  if (scrollParent) {
    scrollParent.scrollTop += headerY - buttonY;
  }
}

/**
 * A compact collapse button rendered at the bottom of expanded content.
 * Only visible when the content is tall enough (header is far from footer),
 * but always occupies zero layout space when hidden to prevent jank.
 */
export function CollapseFooter({
  headerRef,
  onCollapse,
  label = "Collapse",
}: {
  headerRef: RefObject<HTMLElement | null>;
  onCollapse: () => void;
  label?: string;
}) {
  const footerRef = useRef<HTMLButtonElement>(null);
  const [tall, setTall] = useState(false);

  // One-shot measurement after mount. Content doesn't resize after expansion,
  // so we only need to check once. Running this on every render (missing deps)
  // causes a useLayoutEffect+setState loop that compounds with any parent
  // re-render into React error #185 (maximum update depth exceeded).
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot measurement on mount only
  useLayoutEffect(() => {
    const header = headerRef.current;
    const footer = footerRef.current;
    if (!header || !footer) return;
    const distance = footer.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    setTall(distance >= MIN_HEIGHT_FOR_FOOTER);
  }, []);

  if (!tall) {
    // Render an invisible placeholder so layout doesn't shift if content grows
    return <button ref={footerRef} className="h-0 w-0 overflow-hidden" aria-hidden />;
  }

  return (
    <button
      ref={footerRef}
      onClick={(e) => collapseAndSnap(e, headerRef, onCollapse)}
      className="w-full flex items-center justify-center gap-1 px-2 py-0.5 text-[10px] text-cc-muted/40 hover:text-cc-muted hover:bg-cc-hover/40 transition-colors cursor-pointer"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0">
        <path d="M4 10l4-4 4 4" />
      </svg>
      <span className="font-mono-code">{label}</span>
    </button>
  );
}

/**
 * A variant for turn-level collapse (matches the TurnCollapseBar style).
 * Always visible at the bottom of expanded turn entries.
 */
export function TurnCollapseFooter({
  headerRef,
  onCollapse,
}: {
  headerRef: RefObject<HTMLElement | null>;
  onCollapse: () => void;
}) {
  return (
    <button
      onClick={(e) => collapseAndSnap(e, headerRef, onCollapse)}
      className="w-full flex items-center justify-center gap-1 py-0.5 px-2 rounded hover:bg-cc-hover/40 transition-colors cursor-pointer text-[10px] text-cc-muted/40 hover:text-cc-muted font-mono-code"
      title="Collapse this turn"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0">
        <path d="M4 10l4-4 4 4" />
      </svg>
      <span>Collapse</span>
    </button>
  );
}
