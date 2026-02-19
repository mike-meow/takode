import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
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
};

const DEFAULT_BASE_DIR = join(homedir(), ".companion", "images");

const THUMB_MAX_DIM = 300;
const THUMB_QUALITY = 80;

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
    mkdirSync(dir, { recursive: true });

    const ext = MIME_TO_EXT[mediaType] || "bin";
    const imageId = `${Date.now()}-${this.counter++}-${randomBytes(3).toString("hex")}`;
    const originalPath = join(dir, `${imageId}.orig.${ext}`);
    const thumbPath = join(dir, `${imageId}.thumb.jpeg`);

    const buffer = Buffer.from(base64Data, "base64");
    writeFileSync(originalPath, buffer);

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

    return { imageId, media_type: mediaType };
  }

  /** Get the disk path for an original image, or null if not found. */
  getOriginalPath(sessionId: string, imageId: string): string | null {
    const dir = this.sessionDir(sessionId);
    if (!existsSync(dir)) return null;
    const match = readdirSync(dir).find((f) => f.startsWith(`${imageId}.orig.`));
    return match ? join(dir, match) : null;
  }

  /** Get the disk path for a thumbnail, or null if not found. */
  getThumbnailPath(sessionId: string, imageId: string): string | null {
    const path = join(this.sessionDir(sessionId), `${imageId}.thumb.jpeg`);
    return existsSync(path) ? path : null;
  }

  /** Delete all images for a session. */
  removeSession(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  }
}
