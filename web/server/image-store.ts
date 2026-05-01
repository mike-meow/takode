import { mkdirSync } from "node:fs";
import { mkdir, writeFile, readdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  AGENT_QUALITY,
  buildStoredImageFilename,
  MIME_TO_EXT,
  optimizeImageBufferForStore,
  requireSharp,
  resetSharpLoaderForTest,
  resizeImageBufferForStore,
  setSharpLoaderForTest,
  SHARP_UNAVAILABLE_MESSAGE,
  SharpUnavailableError,
  STORE_MAX_DIM,
  isSharpUnavailableError,
  isTakodeAgentOptimizedPath,
  wasImageBufferProcessed,
} from "./image-optimizer.js";

export {
  AGENT_QUALITY,
  buildStoredImageFilename,
  MIME_TO_EXT,
  resetSharpLoaderForTest,
  setSharpLoaderForTest,
  SHARP_UNAVAILABLE_MESSAGE,
  SharpUnavailableError,
  STORE_MAX_DIM,
  isSharpUnavailableError,
};

export interface ImageRef {
  imageId: string;
  media_type: string;
  optimized?: boolean;
  sourceName?: string;
}

export function getImageUploadSourceName(input: { filename?: unknown }): string | undefined {
  return typeof input.filename === "string" ? input.filename : undefined;
}

const DEFAULT_BASE_DIR = join(homedir(), ".companion", "images");

const THUMB_MAX_DIM = 300;
const THUMB_QUALITY = 80;

/**
 * Downscale raster images that would exceed the Read tool's 2000px limit.
 * SVG images pass through unchanged. Falls back to the original buffer
 * if sharp can't process the input.
 */
export async function resizeForStore(data: Buffer, mimeType: string, maxDim = STORE_MAX_DIM): Promise<Buffer> {
  return resizeImageBufferForStore(data, mimeType, maxDim);
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
  async store(sessionId: string, base64Data: string, mediaType: string, sourceName?: string): Promise<ImageRef> {
    const sharp = await requireSharp("store session images");
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });

    const imageId = `${Date.now()}-${this.counter++}-${randomBytes(3).toString("hex")}`;
    const thumbPath = join(dir, `${imageId}.thumb.jpeg`);

    const raw = Buffer.from(base64Data, "base64");
    const alreadyOptimized = sourceName ? isTakodeAgentOptimizedPath(sourceName) : false;
    const optimized = alreadyOptimized
      ? { data: raw, mediaType, resized: false, convertedToJpeg: false }
      : await optimizeImageBufferForStore(raw, mediaType, { jpegQuality: AGENT_QUALITY });
    const buffer = optimized.data;
    const actualMediaType = optimized.mediaType;
    const storedAsOptimized = alreadyOptimized || wasImageBufferProcessed(optimized);

    const originalPath = join(
      dir,
      buildStoredImageFilename(imageId, actualMediaType, { optimized: storedAsOptimized }),
    );
    await writeFile(originalPath, buffer);

    // Thumbnails are for browser previews only, so generate them off the
    // critical user-send path. Backend delivery only needs the original file.
    void sharp(buffer)
      .rotate()
      .resize({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM, fit: "inside" })
      .jpeg({ quality: THUMB_QUALITY })
      .toFile(thumbPath)
      .catch((err: unknown) => {
        console.warn(`[image-store] Failed to generate thumbnail for ${imageId}:`, err);
      });

    return {
      imageId,
      media_type: actualMediaType,
      ...(storedAsOptimized ? { optimized: true } : {}),
      ...(sourceName ? { sourceName } : {}),
    };
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
    const match =
      files.find((f) => f.startsWith(`${imageId}.takode-agent.`)) ??
      files.find((f) => f.startsWith(`${imageId}.orig.`));
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
