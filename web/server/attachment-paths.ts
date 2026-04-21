import { join } from "node:path";
import { homedir } from "node:os";
import type { ImageRef } from "./image-store.js";
import { MIME_TO_EXT } from "./image-store.js";

export function deriveAttachmentPaths(sessionId: string, imageRefs: ImageRef[]): string[] {
  const imgDir = join(homedir(), ".companion", "images", sessionId);
  return imageRefs.map((ref) => {
    const ext = MIME_TO_EXT[ref.media_type] || "bin";
    return join(imgDir, `${ref.imageId}.orig.${ext}`);
  });
}

export function formatAttachmentPathAnnotation(paths: string[]): string {
  if (paths.length === 0) return "";
  const numbered = paths.map((path, idx) => `Attachment ${idx + 1}: ${path}`).join("\n");
  return `\n[📎 Image attachments -- read these files with the Read tool before responding:\n${numbered}]`;
}
