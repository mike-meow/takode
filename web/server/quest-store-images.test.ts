import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";

let tempDir: string;
let questStore: typeof import("./quest-store.js");
let imageStoreModule: typeof import("./image-store.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "quest-image-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  questStore = await import("./quest-store.js");
  imageStoreModule = await import("./image-store.js");
});

afterEach(() => {
  imageStoreModule.resetSharpLoaderForTest();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("saveQuestImage", () => {
  it("fails clearly for raster uploads when sharp is unavailable", async () => {
    imageStoreModule.setSharpLoaderForTest(async () => {
      throw new Error("missing native module");
    });
    const image = await sharp({
      create: { width: 800, height: 600, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();

    await expect(questStore.saveQuestImage("small.png", image, "image/png")).rejects.toBeInstanceOf(
      imageStoreModule.SharpUnavailableError,
    );
  });

  it("resizes and converts images exceeding 1920px to the shared JPEG policy", async () => {
    // Claude Code's Read tool rejects images >2000x2000px. saveQuestImage
    // should downscale at upload time so workers can read quest screenshots.
    const bigImage = await sharp({
      create: { width: 2500, height: 2000, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const result = await questStore.saveQuestImage("big.png", bigImage, "image/png");
    const saved = await readFile(result.path);
    const meta = await sharp(saved).metadata();
    expect(meta.width).toBeLessThanOrEqual(1920);
    expect(meta.height).toBeLessThanOrEqual(1920);
    // Aspect ratio preserved: 2500x2000 -> 1920x1536
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1536);
    expect(meta.format).toBe("jpeg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("big.png");
    expect(result.path.endsWith(".takode-agent.jpeg")).toBe(true);
  });

  it("converts small eligible images without resizing", async () => {
    // Images already within the limit should keep their dimensions but still
    // share the chat upload lossless-to-JPEG compression behavior.
    const smallImage = await sharp({
      create: { width: 800, height: 600, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const result = await questStore.saveQuestImage("small.png", smallImage, "image/png");
    const saved = await readFile(result.path);
    const meta = await sharp(saved).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
    expect(meta.format).toBe("jpeg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("small.png");
    expect(result.path.endsWith(".takode-agent.jpeg")).toBe(true);
  });

  it("preserves unchanged JPEG uploads under the legacy original name", async () => {
    const image = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 20, g: 80, b: 160 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const result = await questStore.saveQuestImage("photo.jpg", image, "image/jpeg");
    const saved = await readFile(result.path);
    const meta = await sharp(saved).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
    expect(meta.format).toBe("jpeg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("photo.jpg");
    expect(result.path.endsWith(".orig.jpeg")).toBe(true);
  });

  it("no-ops already optimized uploads and keeps the .takode-agent convention", async () => {
    const image = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 40, b: 50 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();

    const result = await questStore.saveQuestImage("capture.takode-agent.jpeg", image, "image/jpeg");
    const saved = await readFile(result.path);
    expect(saved).toEqual(image);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("capture.takode-agent.jpeg");
    expect(result.path.endsWith(".takode-agent.jpeg")).toBe(true);
  });

  it("skips resize for SVG images", async () => {
    // SVG is vector -- no pixel dimensions to resize.
    const svgData = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="3000"><rect fill="red" width="3000" height="3000"/></svg>',
    );
    const result = await questStore.saveQuestImage("icon.svg", svgData, "image/svg+xml");
    const saved = await readFile(result.path);
    expect(saved.toString()).toContain("3000");
  });
});
