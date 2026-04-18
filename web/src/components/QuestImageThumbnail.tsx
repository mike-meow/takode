import type { KeyboardEvent, ReactNode } from "react";
import { api } from "../api.js";
import type { QuestImage } from "../types.js";

interface QuestImageThumbnailProps {
  image: QuestImage;
  onOpen: (src: string) => void;
  frameClassName?: string;
  imageClassName?: string;
  showFilenameOverlay?: boolean;
  overlayClassName?: string;
  loading?: "eager" | "lazy";
  decoding?: "async" | "auto" | "sync";
  title?: string;
  dataTestId?: string;
  onRemove?: (imageId: string) => void;
  removeButtonClassName?: string;
  removeLabel?: string;
  removeTitle?: string;
  removeContent?: ReactNode;
}

export function QuestImageThumbnail({
  image,
  onOpen,
  frameClassName = "relative group rounded-lg overflow-hidden border border-cc-border bg-cc-input-bg",
  imageClassName = "w-20 h-20 object-cover cursor-zoom-in hover:opacity-80 transition-opacity",
  showFilenameOverlay = false,
  overlayClassName = "absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity",
  loading,
  decoding,
  title,
  dataTestId,
  onRemove,
  removeButtonClassName,
  removeLabel,
  removeTitle,
  removeContent,
}: QuestImageThumbnailProps) {
  const src = api.questImageUrl(image.id);

  function handleKeyDown(e: KeyboardEvent<HTMLImageElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(src);
    }
  }

  return (
    <div className={frameClassName}>
      <img
        src={src}
        alt={image.filename}
        title={title}
        className={imageClassName}
        onClick={() => onOpen(src)}
        onKeyDown={handleKeyDown}
        loading={loading}
        decoding={decoding}
        draggable={false}
        role="button"
        tabIndex={0}
        data-testid={dataTestId}
      />
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(image.id);
          }}
          className={removeButtonClassName}
          aria-label={removeLabel ?? `Remove image ${image.filename}`}
          title={removeTitle}
        >
          {removeContent ?? "x"}
        </button>
      )}
      {showFilenameOverlay && <div className={overlayClassName}>{image.filename}</div>}
    </div>
  );
}
