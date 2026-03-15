import type React from "react";

/**
 * Cat-themed SVG icon components used throughout the Takode UI.
 * All icons use `fill="currentColor"` or `stroke="currentColor"` to inherit
 * Tailwind text-* color classes from parent elements.
 */

/** Cat paw print — main pad + 4 toe beans. Used as the assistant message avatar.
 * Coordinates programmatically converted from 552x516 viewBox → 16x16
 * via web/scripts/convert-paw-svg.ts */
export function CatPawAvatar({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M 8.1 6 C 8.4 6 8.5 6 8.7 6.1 C 8.9 6.1 9.2 6.3 9.3 6.4 C 9.5 6.5 9.6 6.6 9.8 6.9 C 10 7.2 10.2 8 10.5 8.3 C 10.8 8.7 11.1 8.7 11.4 9 C 11.7 9.2 12 9.6 12.1 9.9 C 12.2 10.1 12.3 10.3 12.3 10.5 C 12.3 10.8 12.3 11.1 12.2 11.4 C 12.1 11.7 12 12 11.8 12.2 C 11.7 12.4 11.5 12.6 11.2 12.7 C 10.8 12.8 10.4 13 9.9 12.9 C 9.3 12.9 8.6 12.4 8.1 12.4 C 7.7 12.3 7.4 12.8 7.1 12.9 C 6.7 13 6.4 13 6.1 12.9 C 5.8 12.9 5.4 12.8 5.1 12.6 C 4.8 12.4 4.5 12.1 4.4 11.7 C 4.2 11.4 4.2 10.9 4.2 10.5 C 4.3 10.1 4.4 9.8 4.7 9.5 C 4.9 9.1 5.6 8.8 6 8.4 C 6.3 8 6.5 7.3 6.7 6.9 C 6.9 6.6 7 6.5 7.2 6.4 C 7.4 6.2 7.9 6.1 8.1 6 Z" />
      <ellipse cx="6.2" cy="3.9" rx="1.5" ry="1.9" />
      <ellipse cx="10.2" cy="3.9" rx="1.5" ry="1.9" />
      <ellipse cx="3.7" cy="7.1" rx="1.6" ry="1.9" />
      <ellipse cx="12.8" cy="7.1" rx="1.6" ry="1.9" />
    </svg>
  );
}

/**
 * Downward-facing left paw print — heart-shaped main pad + 4 oval toe beans.
 * Toes fan slightly left for a natural walking splay.
 * Designed to look like a real cat pawprint at small sizes (12–16px).
 */
export function CatPawLeft({
  className = "w-3 h-3",
  style,
  ref,
}: {
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<SVGSVGElement>;
}) {
  return (
    <svg ref={ref} viewBox="0 0 16 16" fill="currentColor" className={className} style={style}>
      <path d="M 8.1 6 C 8.4 6 8.5 6 8.7 6.1 C 8.9 6.1 9.2 6.3 9.3 6.4 C 9.5 6.5 9.6 6.6 9.8 6.9 C 10 7.2 10.2 8 10.5 8.3 C 10.8 8.7 11.1 8.7 11.4 9 C 11.7 9.2 12 9.6 12.1 9.9 C 12.2 10.1 12.3 10.3 12.3 10.5 C 12.3 10.8 12.3 11.1 12.2 11.4 C 12.1 11.7 12 12 11.8 12.2 C 11.7 12.4 11.5 12.6 11.2 12.7 C 10.8 12.8 10.4 13 9.9 12.9 C 9.3 12.9 8.6 12.4 8.1 12.4 C 7.7 12.3 7.4 12.8 7.1 12.9 C 6.7 13 6.4 13 6.1 12.9 C 5.8 12.9 5.4 12.8 5.1 12.6 C 4.8 12.4 4.5 12.1 4.4 11.7 C 4.2 11.4 4.2 10.9 4.2 10.5 C 4.3 10.1 4.4 9.8 4.7 9.5 C 4.9 9.1 5.6 8.8 6 8.4 C 6.3 8 6.5 7.3 6.7 6.9 C 6.9 6.6 7 6.5 7.2 6.4 C 7.4 6.2 7.9 6.1 8.1 6 Z" />
      <ellipse cx="6.2" cy="3.9" rx="1.5" ry="1.9" />
      <ellipse cx="10.2" cy="3.9" rx="1.5" ry="1.9" />
      <ellipse cx="3.7" cy="7.1" rx="1.6" ry="1.9" />
      <ellipse cx="12.8" cy="7.1" rx="1.6" ry="1.9" />
    </svg>
  );
}

/**
 * Downward-facing right paw print — mirror of CatPawLeft.
 * Toes fan slightly right. Heart-shaped main pad + 4 oval toe beans.
 */
export function CatPawRight({ className = "w-3 h-3", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} style={style}>
      <path d="M 7.9 6 C 7.6 6 7.5 6 7.3 6.1 C 7.1 6.1 6.8 6.3 6.7 6.4 C 6.5 6.5 6.4 6.6 6.2 6.9 C 6 7.2 5.8 8 5.5 8.3 C 5.2 8.7 4.9 8.7 4.6 9 C 4.3 9.2 4 9.6 3.9 9.9 C 3.8 10.1 3.7 10.3 3.7 10.5 C 3.7 10.8 3.7 11.1 3.8 11.4 C 3.9 11.7 4 12 4.2 12.2 C 4.3 12.4 4.5 12.6 4.8 12.7 C 5.2 12.8 5.6 13 6.1 12.9 C 6.7 12.9 7.4 12.4 7.9 12.4 C 8.3 12.3 8.6 12.8 8.9 12.9 C 9.3 13 9.6 13 9.9 12.9 C 10.2 12.9 10.6 12.8 10.9 12.6 C 11.2 12.4 11.5 12.1 11.6 11.7 C 11.8 11.4 11.8 10.9 11.8 10.5 C 11.7 10.1 11.6 9.8 11.3 9.5 C 11.1 9.1 10.4 8.8 10 8.4 C 9.7 8 9.5 7.3 9.3 6.9 C 9.1 6.6 9 6.5 8.8 6.4 C 8.6 6.2 8.1 6.1 7.9 6 Z" />
      <ellipse cx="9.8" cy="3.9" rx="1.5" ry="1.9" />
      <ellipse cx="5.8" cy="3.9" rx="1.5" ry="1.9" />
      <ellipse cx="12.3" cy="7.1" rx="1.6" ry="1.9" />
      <ellipse cx="3.2" cy="7.1" rx="1.6" ry="1.9" />
    </svg>
  );
}

/** Tiny yarn ball status indicator — round ball with visible thread wraps and a trailing strand. */
export function YarnBallDot({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 14 12" fill="currentColor" style={style} className={`inline-block w-3 h-2.5 ${className}`}>
      {/* Ball body */}
      <circle cx="6" cy="6" r="5" />
      {/* Thread grooves — background-colored to carve texture into the ball */}
      <path d="M1.5 4 Q6 7.5 10.5 4" stroke="var(--cc-bg, #1a1a1a)" strokeWidth="0.7" opacity="0.45" fill="none" />
      <path d="M1.5 7.5 Q6 4 10.5 7.5" stroke="var(--cc-bg, #1a1a1a)" strokeWidth="0.7" opacity="0.45" fill="none" />
      <path d="M4 1.2 Q8 6 4 10.8" stroke="var(--cc-bg, #1a1a1a)" strokeWidth="0.6" opacity="0.35" fill="none" />
      {/* Thread strand trailing out */}
      <path d="M9.5 2.5 Q11 1.5 12.5 2.5 Q13.5 3.5 12.5 4" stroke="currentColor" strokeWidth="0.8" fill="none" />
    </svg>
  );
}

/** Power plug indicator — shown for disconnected sessions instead of the yarn ball. */
export function PowerPlugDot({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" style={style} className={`inline-block ${className}`}>
      {/* Two prongs */}
      <rect x="5" y="1" width="1.5" height="4" rx="0.5" />
      <rect x="9.5" y="1" width="1.5" height="4" rx="0.5" />
      {/* Plug body */}
      <rect x="4" y="4.5" width="8" height="4" rx="1.5" />
      {/* Cord */}
      <path
        d="M8 8.5 L8 11 Q8 12.5 9.5 13 Q11 13.5 11 15"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Yarn ball spinner — circle with crossed thread lines. Drop-in replacement for animate-spin spinners. */
export function YarnBallSpinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      {/* Yarn ball outline */}
      <circle cx="12" cy="12" r="10" strokeWidth="2" opacity="0.25" />
      {/* Thread lines crossing the ball */}
      <path d="M5 8 Q12 14 19 8" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
      <path d="M5 16 Q12 10 19 16" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
      <path d="M8 4 Q14 12 8 20" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
      {/* Visible arc segment (like a spinner quarter-circle) */}
      <path d="M4 12a8 8 0 018-8" strokeWidth="2.5" strokeLinecap="round" opacity="0.85" />
    </svg>
  );
}

/** Curled-up sleeping cat illustration for empty states — kawaii style. */
export function SleepingCat({ className = "w-28 h-20" }: { className?: string }) {
  return (
    <svg viewBox="0 0 140 90" fill="none" className={className}>
      {/* Curled body — organic bean shape */}
      <path
        d="M28 62 Q18 38 48 32 Q72 27 95 34 Q115 42 108 60 Q102 74 72 78 Q42 80 28 62 Z"
        fill="currentColor"
        className="text-cc-muted/15"
      />
      {/* Head — round and large for cuteness */}
      <circle cx="98" cy="38" r="18" fill="currentColor" className="text-cc-muted/20" />
      {/* Outer ears */}
      <path d="M85 24 L80 8 L93 20 Z" fill="currentColor" className="text-cc-muted/25" />
      <path d="M107 22 L114 7 L117 22 Z" fill="currentColor" className="text-cc-muted/25" />
      {/* Inner ears (pink tint) */}
      <path d="M86 23 L83 12 L91 21 Z" fill="currentColor" className="text-cc-primary/15" />
      <path d="M108 21 L113 11 L115 22 Z" fill="currentColor" className="text-cc-primary/15" />
      {/* Closed eyes — happy curved arcs */}
      <path
        d="M90 37 Q93 33 96 37"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="text-cc-muted/45"
        fill="none"
      />
      <path
        d="M102 36 Q105 32 108 36"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="text-cc-muted/45"
        fill="none"
      />
      {/* Tiny nose */}
      <ellipse cx="99" cy="41" rx="1.2" ry="0.8" fill="currentColor" className="text-cc-primary/25" />
      {/* Mouth — small W */}
      <path
        d="M97 42.5 Q96 44.5 94 43.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        className="text-cc-muted/25"
        fill="none"
      />
      <path
        d="M101 42.5 Q102 44.5 104 43.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        className="text-cc-muted/25"
        fill="none"
      />
      {/* Rosy cheeks */}
      <ellipse cx="88" cy="42" rx="3" ry="1.5" fill="currentColor" className="text-cc-primary/8" />
      <ellipse cx="110" cy="41" rx="3" ry="1.5" fill="currentColor" className="text-cc-primary/8" />
      {/* Front paws tucked under chin */}
      <ellipse cx="82" cy="58" rx="7" ry="4.5" fill="currentColor" className="text-cc-muted/18" />
      <ellipse cx="96" cy="59" rx="7" ry="4.5" fill="currentColor" className="text-cc-muted/18" />
      {/* Tail curling around */}
      <path
        d="M28 58 Q14 42 28 28 Q42 20 44 35"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        className="text-cc-muted/18"
        fill="none"
      />
      {/* Tail tip */}
      <circle cx="44" cy="35" r="3" fill="currentColor" className="text-cc-muted/18" />
      {/* Zzz — floating above */}
      <text
        x="120"
        y="22"
        fill="currentColor"
        className="text-cc-muted/30"
        fontSize="12"
        fontFamily="ui-monospace"
        fontWeight="bold"
      >
        z
      </text>
      <text
        x="127"
        y="13"
        fill="currentColor"
        className="text-cc-muted/22"
        fontSize="9"
        fontFamily="ui-monospace"
        fontWeight="bold"
      >
        z
      </text>
      <text
        x="132"
        y="7"
        fill="currentColor"
        className="text-cc-muted/15"
        fontSize="7"
        fontFamily="ui-monospace"
        fontWeight="bold"
      >
        z
      </text>
    </svg>
  );
}

/** Small cat silhouette sitting on a line — used on sidebar dividers. */
export function SidebarCat({ className = "w-5 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 16" fill="currentColor" className={`${className} text-cc-muted/30`}>
      {/* Body sitting */}
      <ellipse cx="10" cy="13" rx="5" ry="3" />
      {/* Head */}
      <circle cx="10" cy="7" r="3.5" />
      {/* Left ear */}
      <path d="M7 5 L5.5 1 L8.5 4 Z" />
      {/* Right ear */}
      <path d="M12 4 L14.5 1 L13 5 Z" />
      {/* Tail */}
      <path d="M15 12 Q18 8 17 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** Larger paw stamp for the approval animation overlay.
 * Coordinates programmatically converted from 552x516 viewBox → 32x32
 * via web/scripts/convert-paw-svg.ts */
export function PawStamp({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="currentColor" className={className}>
      <path d="M 16.3 12 C 16.8 11.9 17.1 12 17.4 12.1 C 17.8 12.3 18.3 12.5 18.7 12.8 C 19 13.1 19.2 13.1 19.6 13.8 C 20 14.4 20.5 16 21 16.7 C 21.6 17.4 22.2 17.4 22.8 17.9 C 23.3 18.5 23.9 19.3 24.2 19.8 C 24.5 20.3 24.5 20.5 24.6 21 C 24.6 21.6 24.6 22.3 24.4 22.8 C 24.3 23.4 24 23.9 23.7 24.3 C 23.3 24.8 23 25.2 22.3 25.4 C 21.7 25.7 20.7 26 19.7 25.9 C 18.7 25.8 17.2 24.8 16.2 24.7 C 15.3 24.7 14.8 25.5 14.1 25.7 C 13.5 25.9 12.8 26 12.2 25.9 C 11.5 25.8 10.8 25.5 10.2 25.1 C 9.6 24.7 9.1 24.1 8.8 23.4 C 8.5 22.7 8.4 21.7 8.5 21 C 8.6 20.2 8.7 19.7 9.3 19 C 9.9 18.2 11.3 17.6 12 16.8 C 12.7 15.9 13 14.5 13.4 13.9 C 13.8 13.2 13.9 13.1 14.4 12.8 C 14.9 12.5 15.8 12.1 16.3 12 Z" />
      <ellipse cx="12.5" cy="7.7" rx="3.1" ry="3.7" />
      <ellipse cx="20.5" cy="7.7" rx="3.1" ry="3.7" />
      <ellipse cx="7.3" cy="14.3" rx="3.1" ry="3.7" />
      <ellipse cx="25.6" cy="14.3" rx="3.1" ry="3.7" />
    </svg>
  );
}
