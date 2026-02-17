import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface LightboxProps {
  /** The full-size image URL (e.g., data URI or http URL) */
  src: string;
  /** Alt text for the image */
  alt?: string;
  /** Called when the lightbox should close */
  onClose: () => void;
}

/**
 * Full-screen image lightbox modal.
 *
 * Renders as a portal on document.body. The image is displayed at its natural
 * size, constrained to fit the viewport. Click the backdrop or press Escape to
 * close.
 */
export function Lightbox({ src, alt = "Full-size image", onClose }: LightboxProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    // Prevent body scroll while lightbox is open
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prev;
    };
  }, [handleKeyDown]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
      onClick={onClose}
      data-testid="lightbox-backdrop"
    >
      {/* Close button in top-right corner */}
      <button
        className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close lightbox"
        data-testid="lightbox-close"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>

      {/* Image — click on the image itself also closes, since the backdrop handles it */}
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl select-none"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
        data-testid="lightbox-image"
      />
    </div>,
    document.body,
  );
}
