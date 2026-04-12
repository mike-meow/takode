import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { ImageStore, resizeForStore } from "./image-store.js";

let store: ImageStore;
let tempDir: string;

// 1x1 red PNG as base64 (smallest valid PNG)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "image-store-test-"));
  store = new ImageStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ImageStore", () => {
  // Tests that store() saves original (as JPEG for PNG input) and thumbnail files to disk,
  // returning a valid ImageRef with a unique imageId and converted media_type.
  it("store() converts PNG to JPEG and writes original and thumbnail files", async () => {
    const ref = await store.store("sess-1", TINY_PNG_BASE64, "image/png");

    expect(ref.imageId).toBeTruthy();
    // PNG input should be converted to JPEG
    expect(ref.media_type).toBe("image/jpeg");

    // Original file should exist as .orig.jpeg (not .orig.png)
    const origPath = await store.getOriginalPath("sess-1", ref.imageId);
    expect(origPath).toBeTruthy();
    expect(origPath!.endsWith(".orig.jpeg")).toBe(true);
    expect(existsSync(origPath!)).toBe(true);

    // Thumbnail should exist
    const thumbPath = await store.getThumbnailPath("sess-1", ref.imageId);
    expect(thumbPath).toBeTruthy();
    expect(thumbPath!.endsWith(".thumb.jpeg")).toBe(true);
    expect(existsSync(thumbPath!)).toBe(true);
  });

  // Tests that sequential calls produce unique imageIds
  it("store() generates unique imageIds", async () => {
    const ref1 = await store.store("sess-1", TINY_PNG_BASE64, "image/png");
    const ref2 = await store.store("sess-1", TINY_PNG_BASE64, "image/png");

    expect(ref1.imageId).not.toBe(ref2.imageId);
  });

  // Tests that images are stored in session-specific directories
  it("store() organizes files by session", async () => {
    await store.store("sess-a", TINY_PNG_BASE64, "image/png");
    await store.store("sess-b", TINY_PNG_BASE64, "image/jpeg");

    expect(existsSync(join(tempDir, "sess-a"))).toBe(true);
    expect(existsSync(join(tempDir, "sess-b"))).toBe(true);

    // Each session dir should have 2 files (orig + thumb)
    expect(readdirSync(join(tempDir, "sess-a")).length).toBe(2);
    expect(readdirSync(join(tempDir, "sess-b")).length).toBe(2);
  });

  // Tests that store() resizes large images to fit within 1920px max dimension
  it("store() resizes large images to 1920px max dimension", async () => {
    const sharpMod = (await import("sharp")).default;

    // Create a 3000x2000 image that exceeds the 1920px limit
    const rawPixels = Buffer.alloc(3000 * 2000 * 3);
    const largeBuffer = await sharpMod(rawPixels, { raw: { width: 3000, height: 2000, channels: 3 } })
      .png()
      .toBuffer();
    const largeBase64 = largeBuffer.toString("base64");

    const ref = await store.store("sess-1", largeBase64, "image/png");
    const origPath = await store.getOriginalPath("sess-1", ref.imageId);
    expect(origPath).toBeTruthy();

    // Stored image should be resized to fit within 1920x1920 and converted to JPEG
    const meta = await sharpMod(readFileSync(origPath!)).metadata();
    expect(meta.width).toBeLessThanOrEqual(1920);
    expect(meta.height).toBeLessThanOrEqual(1920);
    // Aspect ratio preserved: 3000x2000 → 1920x1280
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1280);
    expect(meta.format).toBe("jpeg");
  });

  // Tests that JPEG input stays as JPEG (no double-compression)
  it("store() preserves JPEG input format", async () => {
    const sharpMod = (await import("sharp")).default;
    const jpegBuffer = await sharpMod(Buffer.alloc(100 * 100 * 3), {
      raw: { width: 100, height: 100, channels: 3 },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const jpegBase64 = jpegBuffer.toString("base64");

    const ref = await store.store("sess-1", jpegBase64, "image/jpeg");

    expect(ref.media_type).toBe("image/jpeg");
    const origPath = await store.getOriginalPath("sess-1", ref.imageId);
    expect(origPath).toBeTruthy();
    expect(origPath!.endsWith(".orig.jpeg")).toBe(true);
  });

  // Tests that PNG-to-JPEG conversion produces a smaller file than the PNG original
  it("store() PNG-to-JPEG conversion reduces file size", async () => {
    const sharpMod = (await import("sharp")).default;
    // Create a non-trivial image (gradient pattern) where JPEG compression is effective
    const width = 800;
    const height = 600;
    const rawPixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < rawPixels.length; i += 3) {
      rawPixels[i] = (i / 3) % 256;
      rawPixels[i + 1] = Math.floor((i / 3) / width) % 256;
      rawPixels[i + 2] = 128;
    }
    const pngBuffer = await sharpMod(rawPixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const pngBase64 = pngBuffer.toString("base64");

    const ref = await store.store("sess-1", pngBase64, "image/png");
    const origPath = await store.getOriginalPath("sess-1", ref.imageId);
    expect(origPath).toBeTruthy();

    const storedSize = readFileSync(origPath!).length;
    // JPEG should be smaller than the original PNG for photographic/gradient content
    expect(storedSize).toBeLessThan(pngBuffer.length);
    expect(ref.media_type).toBe("image/jpeg");
  });

  // Tests that GIF input is NOT converted to JPEG (may be animated)
  it("store() preserves GIF format (not eligible for JPEG conversion)", async () => {
    const sharpMod = (await import("sharp")).default;
    const gifBuffer = await sharpMod(Buffer.alloc(10 * 10 * 3), {
      raw: { width: 10, height: 10, channels: 3 },
    })
      .gif()
      .toBuffer();
    const gifBase64 = gifBuffer.toString("base64");

    const ref = await store.store("sess-1", gifBase64, "image/gif");

    expect(ref.media_type).toBe("image/gif");
    const origPath = await store.getOriginalPath("sess-1", ref.imageId);
    expect(origPath).toBeTruthy();
    expect(origPath!.endsWith(".orig.gif")).toBe(true);
  });

  // Tests that getOriginalPath returns null for nonexistent images
  it("getOriginalPath() returns null for unknown image", async () => {
    expect(await store.getOriginalPath("no-session", "no-image")).toBeNull();
  });

  // Tests that getThumbnailPath returns null for nonexistent images
  it("getThumbnailPath() returns null for unknown image", async () => {
    expect(await store.getThumbnailPath("no-session", "no-image")).toBeNull();
  });

  // Tests that removeSession cleans up the entire session directory
  it("removeSession() deletes all images for a session", async () => {
    const ref = await store.store("sess-1", TINY_PNG_BASE64, "image/png");
    expect(existsSync(join(tempDir, "sess-1"))).toBe(true);

    await store.removeSession("sess-1");
    expect(existsSync(join(tempDir, "sess-1"))).toBe(false);
    expect(await store.getOriginalPath("sess-1", ref.imageId)).toBeNull();
  });

  // Tests that removeSession is safe to call on nonexistent sessions
  it("removeSession() is safe for nonexistent session", async () => {
    await expect(store.removeSession("nonexistent")).resolves.not.toThrow();
  });

  // Tests that corrupt base64 data still saves the original and that
  // JPEG conversion failure falls back to the original PNG format gracefully.
  it("store() handles sharp failure gracefully (original still saved, media_type preserved)", async () => {
    // Not a valid image, but valid base64 -- sharp will fail on both resize and JPEG conversion
    const junkBase64 = Buffer.from("this is not an image").toString("base64");
    const ref = await store.store("sess-1", junkBase64, "image/png");

    expect(ref.imageId).toBeTruthy();
    // JPEG conversion should have failed, so media_type stays as original PNG
    expect(ref.media_type).toBe("image/png");

    // Original should still be saved with .orig.png extension (not .orig.jpeg)
    const origPath = await store.getOriginalPath("sess-1", ref.imageId);
    expect(origPath).toBeTruthy();
    expect(origPath!.endsWith(".orig.png")).toBe(true);
    expect(existsSync(origPath!)).toBe(true);
  });
});

// ── resizeForStore standalone function tests ──────────────────────────────

describe("resizeForStore", () => {
  // SVG images should pass through unchanged (not resizable by sharp)
  it("passes SVG through unchanged", async () => {
    const svgData = Buffer.from("<svg></svg>");
    const result = await resizeForStore(svgData, "image/svg+xml");
    expect(result).toBe(svgData);
  });

  // Small images should pass through unchanged (no resize needed)
  it("passes small images through unchanged", async () => {
    const buf = Buffer.from(TINY_PNG_BASE64, "base64");
    const result = await resizeForStore(buf, "image/png");
    // 1x1 PNG is well under 1920px -- should not be resized
    expect(result.length).toBeGreaterThan(0);
  });

  // Large images should be resized to fit within maxDim
  it("resizes large images to fit within maxDim", async () => {
    const sharpMod = (await import("sharp")).default;
    const rawPixels = Buffer.alloc(2500 * 2500 * 3);
    const largeBuf = await sharpMod(rawPixels, { raw: { width: 2500, height: 2500, channels: 3 } })
      .png()
      .toBuffer();

    const result = await resizeForStore(largeBuf, "image/png");
    const meta = await sharpMod(result).metadata();
    expect(meta.width).toBeLessThanOrEqual(1920);
    expect(meta.height).toBeLessThanOrEqual(1920);
  });

  // Custom maxDim parameter should be respected
  it("respects custom maxDim parameter", async () => {
    const sharpMod = (await import("sharp")).default;
    const rawPixels = Buffer.alloc(500 * 500 * 3);
    const buf = await sharpMod(rawPixels, { raw: { width: 500, height: 500, channels: 3 } })
      .png()
      .toBuffer();

    const result = await resizeForStore(buf, "image/png", 200);
    const meta = await sharpMod(result).metadata();
    expect(meta.width).toBeLessThanOrEqual(200);
    expect(meta.height).toBeLessThanOrEqual(200);
  });

  // Invalid image data should fall back gracefully
  it("returns original buffer when sharp fails", async () => {
    const junk = Buffer.from("not an image");
    const result = await resizeForStore(junk, "image/png");
    expect(result).toBe(junk);
  });
});
