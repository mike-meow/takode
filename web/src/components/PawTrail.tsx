import { createContext, useContext, useRef, useEffect, useState, useCallback, useMemo, useId } from "react";
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

// ─── Shared scroll manager ──────────────────────────────────────────────────
//
// Instead of N scroll listeners (one per PawTrailAvatar), a single listener
// on the feed container calls all registered update callbacks in one rAF.
// Each callback writes directly to its own DOM refs — no React re-renders.

/** Callback signature: receives the cached parent rect and current direction. */
type PawUpdateFn = (parentRect: DOMRect, dirDown: boolean) => void;

export const PawScrollContext = createContext<{
  register: (fn: PawUpdateFn) => () => void;
} | null>(null);

/**
 * Wraps the message feed and attaches a single scroll listener that drives
 * all PawTrailAvatar animations via direct DOM writes.
 */
export function PawScrollProvider({
  scrollRef,
  children,
}: {
  scrollRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const callbacks = useRef(new Set<PawUpdateFn>());
  const lastScrollTop = useRef(0);
  const dirDown = useRef(true);

  const register = useCallback((fn: PawUpdateFn) => {
    callbacks.current.add(fn);
    // Give the newly registered paw an immediate position update
    const el = scrollRef.current;
    if (el) {
      requestAnimationFrame(() => fn(el.getBoundingClientRect(), dirDown.current));
    }
    return () => { callbacks.current.delete(fn); };
  }, [scrollRef]);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    let rafId: number;
    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const currentScrollTop = scrollEl.scrollTop;
        // Dead zone of 2px to avoid jitter on sub-pixel scrolls
        if (currentScrollTop > lastScrollTop.current + 2) {
          dirDown.current = true;
        } else if (currentScrollTop < lastScrollTop.current - 2) {
          dirDown.current = false;
        }
        lastScrollTop.current = currentScrollTop;

        // Read parentRect ONCE per frame — avoid N redundant reads
        const parentRect = scrollEl.getBoundingClientRect();
        for (const cb of callbacks.current) {
          cb(parentRect, dirDown.current);
        }
      });
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });

    // Initial position for all paws already registered
    requestAnimationFrame(() => {
      const parentRect = scrollEl.getBoundingClientRect();
      for (const cb of callbacks.current) {
        cb(parentRect, dirDown.current);
      }
    });

    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafId);
    };
  }, [scrollRef]);

  const value = useMemo(() => ({ register }), [register]);
  return <PawScrollContext.Provider value={value}>{children}</PawScrollContext.Provider>;
}

// ─── PawTrailAvatar ─────────────────────────────────────────────────────────

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
 *
 * Performance: instead of each avatar attaching its own scroll listener
 * (N listeners for N messages), all avatars register with a shared
 * PawScrollProvider that drives updates via a single listener + rAF.
 * Style updates are written directly to DOM refs — no React re-renders.
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

  const outerRef = useRef<HTMLDivElement>(null);
  const pawRef = useRef<SVGSVGElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const isLeft = index % 2 === 0;

  const scrollCtx = useContext(PawScrollContext);

  useEffect(() => {
    // If no scroll context (tests, playground), fall back to dot state
    if (!scrollCtx) return;

    const updateFn: PawUpdateFn = (parentRect, dirDown) => {
      const el = outerRef.current;
      const pawEl = pawRef.current;
      const dotEl = dotRef.current;
      if (!el || !pawEl || !dotEl) return;

      const elRect = el.getBoundingClientRect();
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

      // Quantize to ~5% steps to reduce DOM writes
      const progress = Math.round(raw * 20) / 20;

      // Derive visual properties (same math as before)
      const pawOpacity = 1 - progress;
      const pawScale = 0.6 + 0.9 * (1 - progress);
      const dotOpacity = progress;
      const dotScale = 0.3 + 0.7 * progress;
      const pawRotation = dirDown ? 180 : 0;

      const splayAmount = 1 - progress;
      const dir = dirDown ? -1 : 1;
      const splayRotate = (isLeft ? -12 : 12) * splayAmount * dir;
      const splayOffsetX = (isLeft ? -5 : 5) * splayAmount * dir;

      // Write directly to DOM — no React state, no re-renders.
      // Use only transform/opacity/visibility (composite-friendly properties).
      // NEVER toggle `display` here — it invalidates layout and forces
      // synchronous relayout on every subsequent getBoundingClientRect() call,
      // causing N forced relayouts per frame with N paws (layout thrashing).
      el.style.transform = `translateX(${splayOffsetX}px) rotate(${splayRotate}deg)`;

      pawEl.style.opacity = String(pawOpacity);
      pawEl.style.transform = `scale(${pawScale}) ${isLeft ? "" : "scaleX(-1) "}rotate(${pawRotation}deg)`;
      pawEl.style.visibility = pawOpacity > 0.02 ? "" : "hidden";

      dotEl.style.opacity = String(dotOpacity);
      dotEl.style.transform = `scale(${dotScale})`;
    };

    return scrollCtx.register(updateFn);
  }, [scrollCtx, isLeft]);

  return (
    <div
      ref={outerRef}
      className="relative w-3.5 h-3.5 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-1.5"
      style={{ transition: "transform 0.1s ease-out" }}
    >
      {/* Paw print — alternates left/right, visible near edge of feed.
          Always mounted (display toggled by scroll manager) to avoid
          mount/unmount churn during scroll. */}
      <CatPawLeft
        ref={pawRef}
        className="absolute w-3 h-3 text-cc-primary pointer-events-none"
      />
      {/* Dot — grows in as paw fades out */}
      <div
        ref={dotRef}
        className="w-1.5 h-1.5 rounded-full bg-cc-primary/50 pointer-events-none"
      />
    </div>
  );
}
