import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  confirm?: {
    title: string;
    description: string;
    confirmLabel: string;
    destructive?: boolean;
  };
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmingItem, setConfirmingItem] = useState<ContextMenuItem | null>(null);

  useEffect(() => {
    function handleDismiss(e: Event) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (confirmingItem) {
          setConfirmingItem(null);
        } else {
          onClose();
        }
      }
    }
    document.addEventListener("mousedown", handleDismiss);
    document.addEventListener("touchstart", handleDismiss);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDismiss);
      document.removeEventListener("touchstart", handleDismiss);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, confirmingItem]);

  // Clamp to viewport bounds
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const el = menuRef.current;
    if (rect.right > window.innerWidth) {
      el.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  }, [x, y, confirmingItem]);

  // Portal to document.body so the menu escapes overflow-hidden ancestors
  // and the CSS transform containing block on the root layout div.
  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[120px] bg-cc-card border border-cc-border rounded-lg shadow-lg overflow-hidden"
      style={{ left: x, top: y }}
    >
      {confirmingItem ? (
        <div className="p-3 w-56">
          <p className="text-xs text-cc-fg mb-1 font-medium">{confirmingItem.confirm!.title}</p>
          <p className="text-[11px] text-cc-muted mb-3 leading-relaxed">{confirmingItem.confirm!.description}</p>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setConfirmingItem(null)}
              className="px-2.5 py-1 text-[11px] rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                confirmingItem.onClick();
                onClose();
              }}
              className={`px-2.5 py-1 text-[11px] rounded-md transition-colors cursor-pointer font-medium ${
                confirmingItem.confirm!.destructive
                  ? "bg-red-500/15 text-red-500 hover:bg-red-500/25"
                  : "bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25"
              }`}
            >
              {confirmingItem.confirm!.confirmLabel}
            </button>
          </div>
        </div>
      ) : (
        <div className="py-1">
          {items.map((item, idx) =>
            item.disabled ? (
              <div
                key={`${item.label}-${idx}`}
                className="w-full px-2.5 py-1.5 text-left text-[11px] text-cc-muted font-mono-code break-all leading-relaxed"
              >
                {item.label}
              </div>
            ) : (
              <button
                key={`${item.label}-${idx}`}
                onClick={() => {
                  if (item.confirm) {
                    setConfirmingItem(item);
                  } else {
                    try {
                      item.onClick();
                    } catch (e) {
                      console.error("Menu action error:", e);
                    }
                    onClose();
                  }
                }}
                className="w-full px-2.5 py-1.5 text-left text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
