import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { navigateTo } from "../utils/navigation.js";
import { getQuestStatusTheme } from "../utils/quest-status-theme.js";
import { timeAgo, verificationProgress, getQuestOwnerSessionId, CopyableQuestId } from "../utils/quest-helpers.js";
import { SessionNumChip } from "./SessionNumChip.js";
import { Lightbox } from "./Lightbox.js";
import { MarkdownContent } from "./MarkdownContent.js";
import type { QuestVerificationItem, QuestFeedbackEntry, QuestImage } from "../types.js";

// ─── Main component ──────────────────────────────────────────────────────────

/**
 * Global read-only quest detail modal.
 *
 * Driven by `questOverlayId` in the Zustand store. Any component can open it
 * via `openQuestOverlay(questId)`. Shows quest details (description, images,
 * verification items, feedback) without navigating away from the current view.
 *
 * For full editing, the "Open in Questmaster" footer button navigates to the
 * QuestmasterPage with the quest expanded.
 */
export function QuestDetailModal() {
  const questOverlayId = useStore((s) => s.questOverlayId);
  const closeQuestOverlay = useStore((s) => s.closeQuestOverlay);
  const quests = useStore((s) => s.quests);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const quest = useMemo(
    () => (questOverlayId ? quests.find((q) => q.questId === questOverlayId) ?? null : null),
    [quests, questOverlayId],
  );

  // Close on Escape (lightbox-first priority)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (lightboxSrc) {
        setLightboxSrc(null);
        return;
      }
      closeQuestOverlay();
    },
    [lightboxSrc, closeQuestOverlay],
  );

  useEffect(() => {
    if (!questOverlayId) return;
    document.addEventListener("keydown", handleKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prev;
    };
  }, [questOverlayId, handleKeyDown]);

  if (!quest || !questOverlayId) return null;

  const cfg = getQuestStatusTheme(quest.status);
  const isCancelled = "cancelled" in quest && !!(quest as { cancelled?: boolean }).cancelled;
  const description = "description" in quest ? quest.description : undefined;
  const questSessionId = getQuestOwnerSessionId(quest);
  const questNotes = "notes" in quest ? (quest as { notes?: string }).notes : undefined;
  const hasVerification = "verificationItems" in quest && quest.verificationItems?.length > 0;
  const vProgress = hasVerification ? verificationProgress(quest.verificationItems) : null;
  const feedbackEntries: QuestFeedbackEntry[] =
    "feedback" in quest ? ((quest as { feedback?: QuestFeedbackEntry[] }).feedback ?? []) : [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-3 py-4"
      onClick={closeQuestOverlay}
      data-testid="quest-detail-backdrop"
    >
      <div
        className="w-[min(720px,100%)] max-h-[85dvh] bg-cc-card border border-cc-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={`Quest details: ${quest.title}`}
        onClick={(e) => e.stopPropagation()}
        data-testid="quest-detail-modal"
      >
        {/* ─── Header ─── */}
        <div className="shrink-0 flex items-start justify-between gap-3 px-4 py-3 border-b border-cc-border">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${isCancelled ? "bg-red-400" : cfg.dot}`} />
              <span
                className={`text-xs font-medium px-1.5 py-0.5 rounded-full border ${cfg.border} ${cfg.bg} ${cfg.text}`}
              >
                {cfg.label}
              </span>
              <CopyableQuestId questId={quest.questId} />
            </div>
            <div className="flex items-center gap-2 mt-1 min-w-0">
              <div className="text-sm font-semibold text-cc-fg truncate">{quest.title}</div>
              {quest.parentId && (
                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted shrink-0">
                  sub:{quest.parentId}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              {questSessionId && <SessionNumChip sessionId={questSessionId} />}
              {vProgress && (
                <span className="text-[10px] text-cc-muted flex items-center gap-1">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm11.354-1.646a.5.5 0 00-.708-.708L7 9.293 5.354 7.646a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" />
                  </svg>
                  {vProgress.checked}/{vProgress.total}
                </span>
              )}
              <span className="text-[10px] text-cc-muted/50">
                {timeAgo((quest as { updatedAt?: number }).updatedAt ?? quest.createdAt)}
              </span>
            </div>
            {quest.tags && quest.tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {quest.tags.map((tag) => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted">
                    {tag.toLowerCase()}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={closeQuestOverlay}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer shrink-0"
            aria-label="Close quest details"
            data-testid="quest-detail-close"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* ─── Scrollable body ─── */}
        <div className="overflow-y-auto px-4 pb-4 pt-3 space-y-3">
          {/* Description */}
          {description && <MarkdownContent text={description} size="sm" />}

          {/* Images */}
          {quest.images && quest.images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {quest.images.map((img: QuestImage) => (
                <div key={img.id} className="relative group rounded-lg overflow-hidden border border-cc-border bg-cc-input-bg">
                  <img
                    src={api.questImageUrl(img.id)}
                    alt={img.filename}
                    className="w-20 h-20 object-cover cursor-zoom-in"
                    onClick={() => setLightboxSrc(api.questImageUrl(img.id))}
                  />
                  <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
                    {img.filename}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Verification checklist (read-only) */}
          {hasVerification && (
            <div>
              <label className="block text-[11px] text-cc-muted mb-1">Verification</label>
              <div className="space-y-0.5">
                {quest.verificationItems.map((item: QuestVerificationItem, i: number) => (
                  <div key={i} className="flex items-start gap-2 py-1 px-2 rounded-md">
                    <input type="checkbox" checked={item.checked} readOnly className="mt-0.5 accent-cc-primary pointer-events-none" />
                    <span className={`text-xs ${item.checked ? "text-cc-muted line-through" : "text-cc-fg"}`}>
                      {item.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Feedback thread (read-only) */}
          {feedbackEntries.length > 0 && (
            <div>
              <label className="block text-xs text-cc-muted mb-1">Feedback</label>
              <div className="space-y-2">
                {feedbackEntries.map((entry, i) => {
                  const feedbackSessionId = entry.author === "agent" ? entry.authorSessionId : undefined;
                  return (
                    <div
                      key={i}
                      className={`px-2.5 py-2 rounded-lg text-sm ${
                        entry.author === "human"
                          ? entry.addressed
                            ? "bg-amber-500/5 border border-amber-500/10 text-amber-300/50"
                            : "bg-amber-500/8 border border-amber-500/15 text-amber-300/90"
                          : "bg-cc-input-bg border border-cc-border text-cc-fg/80 ml-4"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-0.5">
                        {feedbackSessionId ? (
                          <SessionNumChip
                            sessionId={feedbackSessionId}
                            className="text-xs font-medium font-mono text-cc-primary hover:text-cc-primary-hover cursor-pointer"
                          />
                        ) : (
                          <span
                            className={`text-xs font-medium ${entry.author === "human" ? "text-amber-400/70" : "text-cc-muted"}`}
                          >
                            {entry.author}
                          </span>
                        )}
                        <span className="text-[11px] text-cc-muted/40">{timeAgo(entry.ts)}</span>
                        {entry.author === "human" && entry.addressed && (
                          <span className="text-[11px] text-green-500/60 font-medium">addressed</span>
                        )}
                      </div>
                      <MarkdownContent text={entry.text} size="sm" />
                      {entry.images && entry.images.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {entry.images.map((img) => (
                            <img
                              key={img.id}
                              src={api.questImageUrl(img.id)}
                              alt={img.filename}
                              className="w-16 h-16 object-cover rounded cursor-zoom-in border border-cc-border"
                              onClick={() => setLightboxSrc(api.questImageUrl(img.id))}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Notes (done quests) */}
          {questNotes && (
            <div>
              <label className="block text-[11px] text-cc-muted mb-1">Notes</label>
              <MarkdownContent text={questNotes} size="sm" />
            </div>
          )}
        </div>

        {/* ─── Footer ─── */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-2.5 border-t border-cc-border">
          <button
            type="button"
            onClick={() => {
              closeQuestOverlay();
              navigateTo(`/questmaster?quest=${encodeURIComponent(quest.questId)}`);
            }}
            className="px-3 py-1.5 text-xs font-medium text-cc-primary hover:text-cc-primary-hover hover:bg-cc-hover rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
            data-testid="quest-detail-open-questmaster"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M3.75 2h3.5a.75.75 0 010 1.5H4.5v8h8V8.75a.75.75 0 011.5 0v3.5A1.75 1.75 0 0112.25 14h-8.5A1.75 1.75 0 012 12.25v-8.5C2 2.784 2.784 2 3.75 2zm6.44-.28a.75.75 0 011.06 0l3 3a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-.53.22H5.75a.75.75 0 01-.75-.75V8.28a.75.75 0 01.22-.53l5.5-5.5z" />
            </svg>
            Open in Questmaster
          </button>
        </div>
      </div>

      {/* Lightbox for full-size image preview */}
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>,
    document.body,
  );
}
