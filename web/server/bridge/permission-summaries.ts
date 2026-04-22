import { NEVER_AUTO_APPROVE } from "./permission-pipeline.js";
import type { PendingCodexInputImageDraft } from "../session-types.js";

/** Tools whose approvals appear as chat messages (same set — interactive tools need visible records). */
export const NOTABLE_APPROVALS = NEVER_AUTO_APPROVE;

/** Build a concise human-readable summary for a denied permission. */
export function getDenialSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    const cmd = input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
    return `Denied: Bash \u2014 ${cmd}`;
  }
  if (typeof input.file_path === "string") {
    return `Denied: ${toolName} \u2014 ${input.file_path}`;
  }
  return `Denied: ${toolName}`;
}

/** Build a concise human-readable summary for an approved permission. */
export function getApprovalSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "ExitPlanMode") return "Plan approved";
  if (toolName === "Bash" && typeof input.command === "string") {
    const cmd = input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
    return `Approved: Bash \u2014 ${cmd}`;
  }
  if (typeof input.file_path === "string") {
    return `Approved: ${toolName} \u2014 ${input.file_path}`;
  }
  return `Approved: ${toolName}`;
}

/** Build a concise human-readable summary for an auto-approved permission.
 *  Prefers the human-readable description over raw command/file when available.
 *  Reason (LLM rationale) is kept separate — sent as its own field, not baked into summary. */
export function getAutoApprovalSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    // Prefer the human-readable description (set by Claude Code for Bash calls)
    if (typeof input.description === "string" && input.description.length > 0) {
      return `Auto-approved: ${input.description}`;
    }
    if (typeof input.command === "string") {
      const cmd = input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
      return `Auto-approved: Bash \u2014 ${cmd}`;
    }
  }
  if (typeof input.file_path === "string") {
    return `Auto-approved: ${toolName} \u2014 ${input.file_path}`;
  }
  return `Auto-approved: ${toolName}`;
}

/** MIME type to file extension mapping for image file path derivation (must match image-store.ts). */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
};

export function buildPendingCodexImageDrafts(
  images: { media_type: string; data: string }[] | undefined,
): PendingCodexInputImageDraft[] | undefined {
  if (!images?.length) return undefined;
  return images.map((img, idx) => ({
    name: `attachment-${idx + 1}.${MIME_TO_EXT[img.media_type] || "bin"}`,
    base64: img.data,
    mediaType: img.media_type,
  }));
}
