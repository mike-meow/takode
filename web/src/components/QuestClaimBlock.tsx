import { useState } from "react";
import { api } from "../api.js";
import { Lightbox } from "./Lightbox.js";
import type { QuestImage, QuestVerificationItem } from "../types.js";

interface QuestClaimData {
  questId: string;
  title: string;
  description?: string;
  status: string;
  tags?: string[];
  images?: QuestImage[];
  verificationItems?: QuestVerificationItem[];
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  idea: { label: "Idea", color: "text-zinc-400" },
  refined: { label: "Refined", color: "text-blue-400" },
  in_progress: { label: "In Progress", color: "text-amber-400" },
  needs_verification: { label: "Verification", color: "text-purple-400" },
  done: { label: "Done", color: "text-green-400" },
};

/**
 * Collapsible block rendered in the chat feed when a quest is claimed by a session.
 * Follows the same visual pattern as ToolBlock — a bordered card with a clickable
 * header that toggles expanded content.
 */
export function QuestClaimBlock({ quest, variant = "claimed" }: { quest: QuestClaimData; variant?: "claimed" | "submitted" }) {
  const [open, setOpen] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const statusInfo = STATUS_LABELS[quest.status] || { label: quest.status, color: "text-cc-muted" };
  const isSubmitted = variant === "submitted";
  const headerLabel = isSubmitted ? "Quest Ready for Review" : "Quest Claimed";
  const borderColor = isSubmitted ? "border-purple-500/30" : "border-amber-500/30";
  const accentColor = isSubmitted ? "text-purple-400" : "text-amber-400";

  return (
    <div className={`border ${borderColor} rounded-[10px] overflow-hidden bg-cc-card`}>
      {/* Header — always visible */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        {/* Chevron */}
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        {/* Quest icon */}
        <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3.5 h-3.5 ${accentColor} shrink-0`}>
          <path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM4 5.75a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 014 5.75z" />
        </svg>
        <span className={`text-xs font-medium ${accentColor}`}>{headerLabel}</span>
        <span className="text-xs text-cc-fg truncate flex-1">{quest.title}</span>
        <span className="text-[10px] text-cc-muted shrink-0">{quest.questId}</span>
      </button>

      {/* Expanded content */}
      {open && (
        <div className="px-3 pb-3 pt-0 border-t border-cc-border space-y-2.5">
          {/* Title + status */}
          <div className="mt-2 flex items-center gap-2">
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-cc-hover ${statusInfo.color}`}>
              {statusInfo.label}
            </span>
            {quest.tags && quest.tags.length > 0 && quest.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted"
              >
                {tag}
              </span>
            ))}
          </div>

          {/* Description */}
          {quest.description && (
            <p className="text-sm text-cc-fg whitespace-pre-wrap">{quest.description}</p>
          )}

          {/* Verification items */}
          {quest.verificationItems && quest.verificationItems.length > 0 && (
            <div>
              <label className="block text-[11px] text-cc-muted mb-1">Verification</label>
              <div className="space-y-0.5">
                {quest.verificationItems.map((item, i) => (
                  <div key={i} className="flex items-start gap-2 py-0.5 px-2">
                    <span className="shrink-0 mt-0.5">
                      {item.checked ? (
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success">
                          <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-muted">
                          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      )}
                    </span>
                    <span className={`text-xs ${item.checked ? "text-cc-muted line-through" : "text-cc-fg"}`}>
                      {item.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Image thumbnails */}
          {quest.images && quest.images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {quest.images.map((img) => (
                <div
                  key={img.id}
                  className="relative group rounded-lg overflow-hidden border border-cc-border bg-cc-input-bg"
                >
                  <img
                    src={api.questImageUrl(img.id)}
                    alt={img.filename}
                    className="w-20 h-20 object-cover cursor-zoom-in hover:opacity-80 transition-opacity"
                    onClick={() => setLightboxSrc(api.questImageUrl(img.id))}
                    loading="lazy"
                    decoding="async"
                  />
                  <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
                    {img.filename}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* View in Questmaster link */}
          <a
            href="#/questmaster"
            className={`inline-flex items-center gap-1 text-[11px] ${accentColor} hover:underline`}
          >
            View in Questmaster
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path d="M4.646 1.646a.5.5 0 01.708 0l6 6a.5.5 0 010 .708l-6 6a.5.5 0 01-.708-.708L10.293 8 4.646 2.354a.5.5 0 010-.708z" />
            </svg>
          </a>
        </div>
      )}

      {/* Lightbox for full-size image viewing */}
      {lightboxSrc && (
        <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
    </div>
  );
}
