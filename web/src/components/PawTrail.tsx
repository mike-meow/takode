import { createContext, useContext, useRef, useEffect, useState, useId } from "react";
import { CatPawLeft } from "./CatIcons.js";

/**
 * Counter state for sequential paw index assignment.
 * Uses a Map keyed by React useId() to make index assignment
 * idempotent — safe under StrictMode's double-invocation of
 * useState initializers.
 */
export type PawCounterState = {
  next: number;
  cache: Map<string, number>;
};

export const PawCounterContext = createContext<React.MutableRefObject<PawCounterState>>(
  { current: { next: 0, cache: new Map() } } as React.MutableRefObject<PawCounterState>,
);

/**
 * PawTrailAvatar — scroll-driven paw-to-dot morph.
 *
 * When a message scrolls into view from an edge, it briefly appears
 * as a paw print pressing in, then morphs into a dot as it moves
 * further into the viewport. The paw orientation follows the scroll
 * direction: toes point down when scrolling down (cat walking down),
 * toes point up when scrolling up (cat walking up).
 *
 * Animation speed is entirely driven by scroll position, not time.
 */
export function PawTrailAvatar({
  isStreaming,
}: {
  isStreaming?: boolean;
}) {
  const componentId = useId();
  const counter = useContext(PawCounterContext);
  const [index] = useState(() => {
    const { cache } = counter.current;
    const cached = cache.get(componentId);
    if (cached !== undefined) return cached;
    const idx = counter.current.next++;
    cache.set(componentId, idx);
    return idx;
  });

  const ref = useRef<HTMLDivElement>(null);
  // progress: 0 = full paw (just entered from edge), 1 = full dot (moved away)
  const [progress, setProgress] = useState(1);
  // true = toes down (scrolling down), false = toes up (scrolling up)
  const [facingDown, setFacingDown] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // JSDOM fallback for tests
    if (typeof getComputedStyle === "undefined") {
      setProgress(1);
      return;
    }

    // Find the nearest scrollable ancestor (the message feed container)
    let scrollParent: HTMLElement | null = el.parentElement;
    while (scrollParent) {
      const { overflowY } = getComputedStyle(scrollParent);
      if (overflowY === "auto" || overflowY === "scroll") break;
      scrollParent = scrollParent.parentElement;
    }
    if (!scrollParent) {
      setProgress(1);
      return;
    }

    let rafId: number;
    const sp = scrollParent;
    let lastScrollTop = sp.scrollTop;
    // Track scroll direction: true = scrolling down
    let dirDown = true;

    const update = () => {
      const currentScrollTop = sp.scrollTop;
      // Dead zone of 2px to avoid jitter on sub-pixel scrolls
      if (currentScrollTop > lastScrollTop + 2) {
        dirDown = true;
      } else if (currentScrollTop < lastScrollTop - 2) {
        dirDown = false;
      }
      lastScrollTop = currentScrollTop;

      const elRect = el.getBoundingClientRect();
      const parentRect = sp.getBoundingClientRect();
      const elCenter = elRect.top + elRect.height / 2;

      const morphRange = 400;
      let raw: number;

      if (dirDown) {
        // Scrolling down — morph zone at bottom edge
        const distFromBottom = parentRect.bottom - elCenter;
        raw = Math.min(1, Math.max(0, distFromBottom / morphRange));
      } else {
        // Scrolling up — morph zone at top edge
        const distFromTop = elCenter - parentRect.top;
        raw = Math.min(1, Math.max(0, distFromTop / morphRange));
      }

      // Quantize to ~5% steps to reduce React re-renders
      const quantized = Math.round(raw * 20) / 20;
      setProgress((prev) => (prev === quantized ? prev : quantized));
      setFacingDown((prev) => (prev === dirDown ? prev : dirDown));
    };

    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(update);
    };

    sp.addEventListener("scroll", onScroll, { passive: true });
    // Initial position check
    update();

    return () => {
      sp.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafId);
    };
  }, []);

  // Derive visual properties from scroll progress
  const pawOpacity = 1 - progress;
  const pawScale = 0.6 + 0.9 * (1 - progress); // 1.5 at edge → 0.6 away
  const dotOpacity = progress;
  const dotScale = 0.3 + 0.7 * progress; // 0.3 at edge → 1.0 away
  // CatPawLeft SVG has toes at top; rotate 180° when facing down
  const pawRotation = facingDown ? 180 : 0;

  // Left/right splay: slight rotation + horizontal offset, fades to 0 with morph
  const isLeft = index % 2 === 0;
  const splayAmount = 1 - progress; // 1 at edge (full splay) → 0 (aligned)
  // Negate splay when facing down — the 180° paw flip reverses visual direction
  const dir = facingDown ? -1 : 1;
  const splayRotate = (isLeft ? -12 : 12) * splayAmount * dir;
  const splayOffsetX = (isLeft ? -5 : 5) * splayAmount * dir;

  return (
    <div
      ref={ref}
      className="relative w-3.5 h-3.5 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-1.5"
      style={{
        transform: `translateX(${splayOffsetX}px) rotate(${splayRotate}deg)`,
        transition: "transform 0.1s ease-out",
      }}
    >
      {/* Paw print — alternates left/right, visible near edge of feed */}
      {pawOpacity > 0.02 && (
        <CatPawLeft
          className="absolute w-3 h-3 text-cc-primary pointer-events-none"
          style={{
            opacity: pawOpacity,
            transform: `scale(${pawScale}) ${isLeft ? "" : "scaleX(-1) "}rotate(${pawRotation}deg)`,
          }}
        />
      )}
      {/* Dot — grows in as paw fades out */}
      <div
        className="w-1.5 h-1.5 rounded-full bg-cc-primary/50 pointer-events-none"
        style={{
          opacity: dotOpacity,
          transform: `scale(${dotScale})`,
        }}
      />
    </div>
  );
}
