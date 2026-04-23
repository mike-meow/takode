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

export const MIME_TO_EXT: Record<string, string> = {
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

const DEFAULT_BASE_DIR = join(homedir(), ".companion", "images");

const THUMB_MAX_DIM = 300;
const THUMB_QUALITY = 80;
/** JPEG quality for lossless-to-JPEG conversion (q-230 confirmed no visible quality loss at 85). */
const AGENT_QUALITY = 85;

/** Lossless formats that benefit from lossy JPEG conversion on ingest. */
const JPEG_ELIGIBLE_MIMES = new Set(["image/png", "image/bmp", "image/tiff"]);

/**
 * Max pixel dimension for stored images. Claude Code's Read tool rejects
 * images exceeding 2000x2000px, so we cap at 1920px to leave headroom.
 * Applied once at storage time for both session images and quest images.
 */
export const STORE_MAX_DIM = 1920;

/**
 * Downscale raster images that would exceed the Read tool's 2000px limit.
 * SVG images pass through unchanged. Falls back to the original buffer
 * if sharp can't process the input.
 */
export async function resizeForStore(data: Buffer, mimeType: string, maxDim = STORE_MAX_DIM): Promise<Buffer> {
  if (mimeType === "image/svg+xml") return data;
  try {
    const meta = await sharp(data).metadata();
    if (!meta.width || !meta.height) return data;
    if (meta.width <= maxDim && meta.height <= maxDim) return data;
    return await sharp(data)
      .rotate()
      .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
      .toBuffer();
  } catch (err) {
    console.warn("[image-store] Failed to resize image, saving original:", err);
    return data;
  }
}

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

  /**
   * Store a base64 image to disk (resized to 1920px max, converted to JPEG q85
   * for lossless formats) and generate a JPEG thumbnail.
   *
   * The returned `media_type` reflects the actual stored format, which may
   * differ from the input when lossless-to-JPEG conversion succeeds.
   */
  async store(sessionId: string, base64Data: string, mediaType: string): Promise<ImageRef> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });

    let actualMediaType = mediaType;
    const imageId = `${Date.now()}-${this.counter++}-${randomBytes(3).toString("hex")}`;
    const thumbPath = join(dir, `${imageId}.thumb.jpeg`);

    const raw = Buffer.from(base64Data, "base64");
    let buffer = await resizeForStore(raw, mediaType);

    // Convert lossless formats (PNG, BMP, TIFF) to JPEG for ~22% size savings
    if (JPEG_ELIGIBLE_MIMES.has(mediaType)) {
      try {
        buffer = await sharp(buffer).jpeg({ quality: AGENT_QUALITY }).toBuffer();
        actualMediaType = "image/jpeg";
      } catch (err) {
        console.warn(`[image-store] JPEG conversion failed for ${imageId}, keeping original format:`, err);
      }
    }

    const ext = MIME_TO_EXT[actualMediaType] || "bin";
    const originalPath = join(dir, `${imageId}.orig.${ext}`);
    await writeFile(originalPath, buffer);

    // Thumbnails are for browser previews only, so generate them off the
    // critical user-send path. Backend delivery only needs the original file.
    void sharp(buffer)
      .rotate()
      .resize({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM, fit: "inside" })
      .jpeg({ quality: THUMB_QUALITY })
      .toFile(thumbPath)
      .catch((err) => {
        console.warn(`[image-store] Failed to generate thumbnail for ${imageId}:`, err);
      });

    return { imageId, media_type: actualMediaType };
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

  /** Delete a single stored image and its thumbnail. */
  async removeImage(sessionId: string, imageId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    try {
      await access(dir);
    } catch {
      return;
    }
    const files = await readdir(dir);
    await Promise.all(
      files.filter((file) => file.startsWith(`${imageId}.`)).map((file) => rm(join(dir, file), { force: true })),
    );
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
