import { mkdirSync } from "node:fs";
import { mkdir, writeFile, readdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import sharp from "sharp";

export interface ImageRef {
  imageId: string;
  media_type: string;
}

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

/** Formats supported by Claude/Codex vision APIs. */
const API_SUPPORTED_FORMATS = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);

const DEFAULT_BASE_DIR = join(homedir(), ".companion", "images");

const THUMB_MAX_DIM = 300;
const THUMB_QUALITY = 80;

/**
 * Maximum base64 characters before we compress for transport.
 * ~375KB of raw image data → ~500KB base64. Keeps the JSON-RPC
 * turn/start payload (including JSON wrapper and data: URL) well
 * under 1MB to prevent event loop blocks and Codex process crashes.
 */
const TRANSPORT_MAX_BASE64_CHARS = 500_000;
const TRANSPORT_MAX_DIM = 1536;
const TRANSPORT_JPEG_QUALITY = 80;

export class ImageStore {
  private baseDir: string;
  private counter = 0;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || DEFAULT_BASE_DIR;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private sessionDir(sessionId: string): string {
    return join(this.baseDir, sessionId);
  }

  /** Store a base64 image to disk and generate a JPEG thumbnail. */
  async store(sessionId: string, base64Data: string, mediaType: string): Promise<ImageRef> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });

    const ext = MIME_TO_EXT[mediaType] || "bin";
    const imageId = `${Date.now()}-${this.counter++}-${randomBytes(3).toString("hex")}`;
    const originalPath = join(dir, `${imageId}.orig.${ext}`);
    const thumbPath = join(dir, `${imageId}.thumb.jpeg`);
    const transportPath = join(dir, `${imageId}.transport.jpeg`);

    const buffer = Buffer.from(base64Data, "base64");
    await writeFile(originalPath, buffer);

    // Generate thumbnail — fall back gracefully if sharp can't process
    try {
      await sharp(buffer)
        .rotate()
        .resize({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM, fit: "inside" })
        .jpeg({ quality: THUMB_QUALITY })
        .toFile(thumbPath);
    } catch (err) {
      console.warn(`[image-store] Failed to generate thumbnail for ${imageId}:`, err);
    }

    // Generate a normalized transport image for Codex localImage turns:
    // JPEG + bounded dimensions to avoid decoder/runtime instability with
    // high-resolution originals and varied source formats.
    try {
      await sharp(buffer)
        .rotate()
        .resize({ width: TRANSPORT_MAX_DIM, height: TRANSPORT_MAX_DIM, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: TRANSPORT_JPEG_QUALITY })
        .toFile(transportPath);
    } catch (err) {
      console.warn(`[image-store] Failed to generate transport image for ${imageId}:`, err);
    }

    return { imageId, media_type: mediaType };
  }

  /** Get the disk path for an original image, or null if not found. */
  async getOriginalPath(sessionId: string, imageId: string): Promise<string | null> {
    const dir = this.sessionDir(sessionId);
    try {
      await access(dir);
    } catch {
      return null;
    }
    const files = await readdir(dir);
    const match = files.find((f) => f.startsWith(`${imageId}.orig.`));
    return match ? join(dir, match) : null;
  }

  /** Get the disk path for a thumbnail, or null if not found. */
  async getThumbnailPath(sessionId: string, imageId: string): Promise<string | null> {
    const path = join(this.sessionDir(sessionId), `${imageId}.thumb.jpeg`);
    try {
      await access(path);
      return path;
    } catch {
      return null;
    }
  }

  /** Get the normalized transport image path, or null if unavailable. */
  async getTransportPath(sessionId: string, imageId: string): Promise<string | null> {
    const path = join(this.sessionDir(sessionId), `${imageId}.transport.jpeg`);
    try {
      await access(path);
      return path;
    } catch {
      return null;
    }
  }

  /**
   * Compress large images to a transport-safe size.
   * Codex receives messages on stdin as single NDJSON lines — multi-MB
   * base64 images block the event loop and can crash the Codex process.
   * SDK sessions can handle larger payloads (~1MB) through stdio.
   * Images below the threshold are returned unchanged.
   */
  async compressForTransport(
    base64Data: string,
    mediaType: string,
    maxBase64Chars = TRANSPORT_MAX_BASE64_CHARS,
  ): Promise<{ base64: string; mediaType: string }> {
    if (base64Data.length <= maxBase64Chars) {
      return { base64: base64Data, mediaType };
    }
    try {
      const buffer = Buffer.from(base64Data, "base64");
      const compressed = await sharp(buffer)
        .rotate()
        .resize({ width: TRANSPORT_MAX_DIM, height: TRANSPORT_MAX_DIM, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: TRANSPORT_JPEG_QUALITY })
        .toBuffer();
      const compressedBase64 = compressed.toString("base64");
      const reduction = ((1 - compressedBase64.length / base64Data.length) * 100).toFixed(0);
      console.log(
        `[image-store] Compressed image for transport: ${(base64Data.length / 1024).toFixed(0)}KB → ${(compressedBase64.length / 1024).toFixed(0)}KB base64 (${reduction}% reduction)`,
      );
      return { base64: compressedBase64, mediaType: "image/jpeg" };
    } catch (err) {
      console.warn("[image-store] Failed to compress image for transport:", err);
      return { base64: base64Data, mediaType };
    }
  }

  /** Convert unsupported image formats to JPEG for the Claude/Codex API. */
  async convertForApi(base64Data: string, mediaType: string): Promise<{ base64: string; mediaType: string }> {
    if (API_SUPPORTED_FORMATS.has(mediaType)) return { base64: base64Data, mediaType };
    try {
      const buffer = Buffer.from(base64Data, "base64");
      const converted = await sharp(buffer)
        .rotate()
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 90 })
        .toBuffer();
      return { base64: converted.toString("base64"), mediaType: "image/jpeg" };
    } catch (err) {
      console.warn("[image-store] Failed to convert image:", err);
      return { base64: base64Data, mediaType };
    }
  }

  /** Delete all images for a session. */
  async removeSession(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  }
}
