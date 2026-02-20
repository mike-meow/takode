import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Hook that tracks whether an element is visible in the viewport.
 * Uses IntersectionObserver for efficient, passive detection.
 */
export function useIsVisible(ref: RefObject<HTMLElement | null>) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return isVisible;
}

/**
 * A subtle collapse button that appears at the bottom of expanded content
 * when the header (toggle) has scrolled out of view. Clicking it collapses
 * the section and scrolls the header back into view.
 *
 * Usage:
 *   const headerRef = useRef<HTMLButtonElement>(null);
 *   // ... <button ref={headerRef} onClick={...}>Header</button> ...
 *   // ... expanded content ...
 *   <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
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
  const headerVisible = useIsVisible(headerRef);

  if (headerVisible) return null;

  return (
    <button
      onClick={() => {
        onCollapse();
        headerRef.current?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }}
      className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] text-cc-muted/50 hover:text-cc-muted hover:bg-cc-hover/40 transition-colors cursor-pointer border-t border-cc-border/30"
    >
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        className="w-3 h-3 shrink-0"
      >
        <path d="M4 10l4-4 4 4" />
      </svg>
      <span className="font-mono-code">{label}</span>
    </button>
  );
}

/**
 * A variant for turn-level collapse (matches the TurnCollapseBar style).
 * Appears at the bottom of expanded turn entries when the top bar scrolls away.
 */
export function TurnCollapseFooter({
  headerRef,
  onCollapse,
}: {
  headerRef: RefObject<HTMLElement | null>;
  onCollapse: () => void;
}) {
  const headerVisible = useIsVisible(headerRef);

  if (headerVisible) return null;

  return (
    <button
      onClick={() => {
        onCollapse();
        headerRef.current?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }}
      className="w-full flex items-center justify-center gap-1.5 py-1 px-2 rounded hover:bg-cc-hover/40 transition-colors cursor-pointer text-[11px] text-cc-muted/50 hover:text-cc-muted font-mono-code"
      title="Collapse this turn"
    >
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        className="w-3 h-3 shrink-0"
      >
        <path d="M4 10l4-4 4 4" />
      </svg>
      <span>Collapse</span>
    </button>
  );
}
