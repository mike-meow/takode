import { join } from "node:path";
import { homedir } from "node:os";
import type { ImageRef } from "./image-store.js";
import { buildStoredImageFilename } from "./image-store.js";

export function deriveAttachmentPaths(sessionId: string, imageRefs: ImageRef[]): string[] {
  const imgDir = join(homedir(), ".companion", "images", sessionId);
  return imageRefs.map((ref) => {
    return join(imgDir, buildStoredImageFilename(ref.imageId, ref.media_type, { optimized: ref.optimized === true }));
  });
}

export function formatAttachmentPathAnnotation(paths: string[]): string {
  if (paths.length === 0) return "";
  const numbered = paths.map((path, idx) => `Attachment ${idx + 1}: ${path}`).join("\n");
  return `\n[📎 Image attachments -- read these files with the Read tool before responding:\n${numbered}]`;
}
