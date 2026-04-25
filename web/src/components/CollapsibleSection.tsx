import { useEffect, type ReactNode, type FormEvent } from "react";
import { settingsSectionDomId } from "./settings-search.js";

export function isCollapsibleSectionCollapsed(id: string): boolean {
  void id;
  return false;
}

// ── Component ───────────────────────────────────────────────────────────────

interface CollapsibleSectionProps {
  /** Unique key used for persisting collapse state */
  id: string;
  /** Section title shown in the header */
  title: string;
  /** Optional description shown below the title (only when expanded) */
  description?: string;
  /** Render as a <form> instead of <section> (for sections with submit handlers) */
  as?: "section" | "div" | "form";
  /** Form onSubmit handler (only when as="form") */
  onSubmit?: (e: FormEvent) => void;
  /** Optional callback when persisted collapsed state changes */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Hide this section when Settings search excludes it */
  hidden?: boolean;
  /** Active search query, used only to expose match count text */
  searchQuery?: string;
  /** Number of matches in this section while search is active */
  matchCount?: number;
  children: ReactNode;
}

export function CollapsibleSection({
  id,
  title,
  description,
  as: Tag = "section",
  onSubmit,
  onCollapsedChange,
  hidden = false,
  searchQuery = "",
  matchCount = 0,
  children,
}: CollapsibleSectionProps) {
  useEffect(() => {
    onCollapsedChange?.(false);
  }, [onCollapsedChange]);

  const hasSearch = searchQuery.trim().length > 0;

  return (
    <Tag
      {...(Tag === "form" ? { onSubmit } : {})}
      id={settingsSectionDomId(id)}
      data-settings-section-id={id}
      hidden={hidden}
      className="bg-cc-card border border-cc-border rounded-xl overflow-hidden"
    >
      <div className="flex items-start justify-between gap-3 border-b border-cc-border/70 p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-cc-fg">{title}</h2>
        {hasSearch && (
          <span className="shrink-0 rounded-full bg-cc-hover px-2 py-0.5 text-[11px] text-cc-muted">
            {matchCount} {matchCount === 1 ? "match" : "matches"}
          </span>
        )}
      </div>

      <div className="px-4 sm:px-5 pb-4 sm:pb-5 pt-4 space-y-3">
        {description && <p className="text-xs text-cc-muted">{description}</p>}
        {children}
      </div>
    </Tag>
  );
}
