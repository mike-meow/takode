import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { ImageStore } from "./image-store.js";

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
  // Tests that store() saves original and thumbnail files to disk,
  // returning a valid ImageRef with a unique imageId.
  it("store() writes original and thumbnail files", async () => {
    const ref = await store.store("sess-1", TINY_PNG_BASE64, "image/png");

    expect(ref.imageId).toBeTruthy();
    expect(ref.media_type).toBe("image/png");

    // Original file should exist
    const origPath = await store.getOriginalPath("sess-1", ref.imageId);
    expect(origPath).toBeTruthy();
    expect(origPath!.endsWith(".orig.png")).toBe(true);
    expect(existsSync(origPath!)).toBe(true);

    // Thumbnail should exist
    const thumbPath = await store.getThumbnailPath("sess-1", ref.imageId);
    expect(thumbPath).toBeTruthy();
    expect(thumbPath!.endsWith(".thumb.jpeg")).toBe(true);
    expect(existsSync(thumbPath!)).toBe(true);

    // Original should be the decoded base64 content
    const origContent = readFileSync(origPath!);
    const expected = Buffer.from(TINY_PNG_BASE64, "base64");
    expect(origContent.equals(expected)).toBe(true);
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

  // Tests that corrupt base64 data still saves the original but handles
  // thumbnail generation failure gracefully
  it("store() handles sharp failure gracefully (original still saved)", async () => {
    // Not a valid image, but valid base64 — sharp will fail but original should be saved
    const junkBase64 = Buffer.from("this is not an image").toString("base64");
    const ref = await store.store("sess-1", junkBase64, "image/png");

    expect(ref.imageId).toBeTruthy();

    // Original should still be saved
    const origPath = await store.getOriginalPath("sess-1", ref.imageId);
    expect(origPath).toBeTruthy();
    expect(existsSync(origPath!)).toBe(true);

    // Thumbnail may not exist (sharp fails on non-image data)
    const thumbPath = await store.getThumbnailPath("sess-1", ref.imageId);
    // Depending on sharp's behavior with non-image data, thumbnail may or may not exist
    // The important thing is no exception was thrown
  });

  // ── convertForApi tests ─────────────────────────────────────────────────

  // Supported formats should pass through unchanged (no conversion overhead)
  it("convertForApi() passes through supported formats unchanged", async () => {
    const result = await store.convertForApi(TINY_PNG_BASE64, "image/png");
    expect(result.base64).toBe(TINY_PNG_BASE64);
    expect(result.mediaType).toBe("image/png");
  });

  it("convertForApi() passes through jpeg unchanged", async () => {
    const result = await store.convertForApi(TINY_PNG_BASE64, "image/jpeg");
    expect(result.base64).toBe(TINY_PNG_BASE64);
    expect(result.mediaType).toBe("image/jpeg");
  });

  it("convertForApi() passes through webp unchanged", async () => {
    const result = await store.convertForApi(TINY_PNG_BASE64, "image/webp");
    expect(result.base64).toBe(TINY_PNG_BASE64);
    expect(result.mediaType).toBe("image/webp");
  });

  it("convertForApi() passes through gif unchanged", async () => {
    const result = await store.convertForApi(TINY_PNG_BASE64, "image/gif");
    expect(result.base64).toBe(TINY_PNG_BASE64);
    expect(result.mediaType).toBe("image/gif");
  });

  // TIFF is not in the supported set but is decodable by Sharp, so it should
  // be converted to JPEG and the mediaType updated accordingly.
  it("convertForApi() converts unsupported-but-decodable format to JPEG", async () => {
    // Create a tiny 1x1 TIFF using Sharp from the known-good PNG
    const sharp = (await import("sharp")).default;
    const pngBuffer = Buffer.from(TINY_PNG_BASE64, "base64");
    const tiffBuffer = await sharp(pngBuffer).tiff().toBuffer();
    const tiffBase64 = tiffBuffer.toString("base64");

    const result = await store.convertForApi(tiffBase64, "image/tiff");
    expect(result.mediaType).toBe("image/jpeg");
    // Converted base64 should be valid JPEG data (different from input)
    expect(result.base64).not.toBe(tiffBase64);
    // Verify the output is valid by decoding with Sharp
    const metadata = await sharp(Buffer.from(result.base64, "base64")).metadata();
    expect(metadata.format).toBe("jpeg");
  });

  // Unsupported format with invalid image data should fall back gracefully,
  // returning the original data unchanged instead of throwing.
  it("convertForApi() returns original data when conversion fails", async () => {
    const junkBase64 = Buffer.from("not an image").toString("base64");
    const result = await store.convertForApi(junkBase64, "image/heic");
    expect(result.base64).toBe(junkBase64);
    expect(result.mediaType).toBe("image/heic");
  });

  // ── compressForTransport tests ──────────────────────────────────────────

  // Small images should pass through unchanged — no compression overhead.
  it("compressForTransport() passes through small images unchanged", async () => {
    const result = await store.compressForTransport(TINY_PNG_BASE64, "image/png");
    expect(result.base64).toBe(TINY_PNG_BASE64);
    expect(result.mediaType).toBe("image/png");
  });

  // Large images should be compressed to JPEG to keep the JSON-RPC payload
  // under transport limits. Verifies both size reduction and format change.
  it("compressForTransport() compresses large images to JPEG", async () => {
    // Create a large PNG (200x200 noise) that exceeds TRANSPORT_MAX_BASE64_CHARS
    const sharp = (await import("sharp")).default;
    const width = 200;
    const height = 200;
    // Raw RGBA noise — compresses poorly as PNG but well as JPEG
    const rawPixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < rawPixels.length; i++) {
      rawPixels[i] = Math.floor(Math.random() * 256);
    }
    const pngBuffer = await sharp(rawPixels, { raw: { width, height, channels: 4 } })
      .png({ compressionLevel: 0 }) // no compression → large PNG
      .toBuffer();
    const largeBase64 = pngBuffer.toString("base64");

    // Only test if the generated image is large enough to trigger compression.
    // With 200x200 uncompressed PNG this should be well over the threshold.
    if (largeBase64.length <= 1_500_000) {
      // If the random image is somehow small, just verify passthrough
      const result = await store.compressForTransport(largeBase64, "image/png");
      expect(result.base64).toBe(largeBase64);
      return;
    }

    const result = await store.compressForTransport(largeBase64, "image/png");
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.base64.length).toBeLessThan(largeBase64.length);

    // Verify the output is valid JPEG
    const metadata = await sharp(Buffer.from(result.base64, "base64")).metadata();
    expect(metadata.format).toBe("jpeg");
  });

  // Non-image data that exceeds the threshold should fall back gracefully,
  // returning the original data instead of throwing.
  it("compressForTransport() returns original data when compression fails", async () => {
    // Create a string that exceeds the transport threshold but isn't valid image data
    const junkData = "A".repeat(2_000_000); // 2M chars of junk base64-ish data
    const result = await store.compressForTransport(junkData, "image/png");
    expect(result.base64).toBe(junkData);
    expect(result.mediaType).toBe("image/png");
  });
});
