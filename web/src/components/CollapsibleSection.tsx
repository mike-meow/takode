import { useState, type ReactNode, type FormEvent } from "react";

// ── Collapse state persistence ──────────────────────────────────────────────
// Stored as a JSON array of collapsed section IDs in localStorage.
// Registered as a GLOBAL_KEY in scoped-storage.ts (UI preference, not server-specific).

const STORAGE_KEY = "cc-settings-collapsed";

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function writeCollapsed(set: Set<string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
}

// ── Component ───────────────────────────────────────────────────────────────

interface CollapsibleSectionProps {
  /** Unique key used for persisting collapse state */
  id: string;
  /** Section title shown in the header */
  title: string;
  /** Optional description shown below the title (only when expanded) */
  description?: string;
  /** Render as a <form> instead of <div> (for sections with submit handlers) */
  as?: "div" | "form";
  /** Form onSubmit handler (only when as="form") */
  onSubmit?: (e: FormEvent) => void;
  children: ReactNode;
}

export function CollapsibleSection({
  id,
  title,
  description,
  as: Tag = "div",
  onSubmit,
  children,
}: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed().has(id));

  function toggle() {
    setCollapsed((prev) => {
      const set = readCollapsed();
      if (prev) set.delete(id);
      else set.add(id);
      writeCollapsed(set);
      return !prev;
    });
  }

  return (
    <Tag
      {...(Tag === "form" ? { onSubmit } : {})}
      className="bg-cc-card border border-cc-border rounded-xl overflow-hidden"
    >
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between p-4 sm:p-5 cursor-pointer hover:bg-cc-hover/50 transition-colors"
      >
        <h2 className="text-sm font-semibold text-cc-fg">{title}</h2>
        <svg
          className={`w-3.5 h-3.5 text-cc-muted transition-transform duration-200 ${collapsed ? "" : "rotate-90"}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 3l5 5-5 5" />
        </svg>
      </button>

      {!collapsed && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-3">
          {description && <p className="text-xs text-cc-muted">{description}</p>}
          {children}
        </div>
      )}
    </Tag>
  );
}
