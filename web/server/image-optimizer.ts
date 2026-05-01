import { access, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export const STORE_MAX_DIM = 1920;
export const AGENT_QUALITY = 85;
export const TAKODE_AGENT_IMAGE_MARKER = ".takode-agent.";

export const SHARP_UNAVAILABLE_MESSAGE =
  "Image processing unavailable because sharp failed to load its native runtime.";

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

export interface ImageDimensions {
  width?: number;
  height?: number;
  format?: string;
  bytes: number;
}

export interface BufferOptimizationResult {
  data: Buffer;
  mediaType: string;
  before?: ImageDimensions;
  after?: ImageDimensions;
  resized: boolean;
  convertedToJpeg: boolean;
}

export interface FileOptimizationResult {
  inputPath: string;
  outputPath: string;
  alreadyOptimized: boolean;
  wroteOutput: boolean;
  resized: boolean;
  convertedToJpeg: boolean;
  before?: ImageDimensions;
  after?: ImageDimensions;
}

interface OptimizeOptions {
  jpegQuality?: number;
  maxDim?: number;
}

interface OptimizeFileOptions extends OptimizeOptions {
  outputPath?: string;
}

export class SharpUnavailableError extends Error {
  constructor(feature: string) {
    super(`${SHARP_UNAVAILABLE_MESSAGE} (${feature})`);
    this.name = "SharpUnavailableError";
  }
}

export function isSharpUnavailableError(error: unknown): error is SharpUnavailableError {
  return error instanceof SharpUnavailableError;
}

export function setSharpLoaderForTest(loader: (() => Promise<SharpModule>) | null): void {
  sharpLoader = loader ?? defaultSharpLoader;
  sharpModulePromise = null;
  sharpLoadFailureLogged = false;
}

export function resetSharpLoaderForTest(): void {
  setSharpLoaderForTest(null);
}

export async function resizeImageBufferForStore(
  data: Buffer,
  mimeType: string,
  maxDim = STORE_MAX_DIM,
): Promise<Buffer> {
  if (mimeType === "image/svg+xml") return data;
  const sharp = await requireSharp("resize images");
  return resizeRasterForStore(data, sharp, maxDim);
}

export async function optimizeImageBufferForStore(
  data: Buffer,
  mimeType: string,
  options: OptimizeOptions = {},
): Promise<BufferOptimizationResult> {
  if (mimeType === "image/svg+xml") {
    return {
      data,
      mediaType: mimeType,
      resized: false,
      convertedToJpeg: false,
      before: { bytes: data.length, format: "svg" },
      after: { bytes: data.length, format: "svg" },
    };
  }

  const sharp = await requireSharp("optimize images");
  const maxDim = options.maxDim ?? STORE_MAX_DIM;
  const jpegQuality = options.jpegQuality ?? AGENT_QUALITY;

  try {
    const meta = await sharp(data).metadata();
    const before = dimensionsFromMetadata(meta, data.length);
    const actualMediaType = mimeTypeFromSharpFormat(meta.format) ?? mimeType;
    const shouldResize = exceedsMaxDim(meta, maxDim);
    const shouldConvertToJpeg = meta.format ? isJpegEligibleFormat(meta.format) : isJpegEligibleMime(mimeType);

    if (!shouldResize && !shouldConvertToJpeg) {
      return {
        data,
        mediaType: actualMediaType,
        before,
        after: before,
        resized: false,
        convertedToJpeg: false,
      };
    }

    let pipeline = sharp(data).rotate();
    if (shouldResize) {
      pipeline = pipeline.resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true });
    }

    const optimized = shouldConvertToJpeg
      ? await pipeline.jpeg({ quality: jpegQuality }).toBuffer()
      : await pipeline.toBuffer();
    const afterMeta = await sharp(optimized).metadata();
    return {
      data: optimized,
      mediaType: shouldConvertToJpeg ? "image/jpeg" : (mimeTypeFromSharpFormat(afterMeta.format) ?? actualMediaType),
      before,
      after: dimensionsFromMetadata(afterMeta, optimized.length),
      resized: shouldResize,
      convertedToJpeg: shouldConvertToJpeg,
    };
  } catch (err) {
    console.warn("[image-optimizer] Failed to optimize image buffer, keeping original:", err);
    return {
      data,
      mediaType: mimeType,
      resized: false,
      convertedToJpeg: false,
      before: { bytes: data.length },
      after: { bytes: data.length },
    };
  }
}

export async function optimizeAgentImageFile(
  inputPath: string,
  options: OptimizeFileOptions = {},
): Promise<FileOptimizationResult> {
  const fileStat = await stat(inputPath);

  if (isTakodeAgentOptimizedPath(inputPath)) {
    return {
      inputPath,
      outputPath: inputPath,
      alreadyOptimized: true,
      wroteOutput: false,
      resized: false,
      convertedToJpeg: false,
      before: { bytes: fileStat.size },
      after: { bytes: fileStat.size },
    };
  }

  const original = (await readFile(inputPath)) as Buffer;
  const sharp = await requireSharp("optimize image files");
  let meta: SharpMetadata;
  try {
    meta = await sharp(original).metadata();
  } catch (err) {
    throw new Error(`Could not read image metadata for ${inputPath}: ${(err as Error).message}`);
  }

  const inputMimeType = mimeTypeFromSharpFormat(meta.format) ?? mimeTypeFromExtension(inputPath);
  const optimized = await optimizeImageBufferForStore(original, inputMimeType, options);
  const outputPath = options.outputPath ?? buildTakodeAgentImagePath(inputPath, optimized.mediaType);

  if (outputPath === inputPath) {
    return {
      inputPath,
      outputPath,
      alreadyOptimized: true,
      wroteOutput: false,
      resized: optimized.resized,
      convertedToJpeg: optimized.convertedToJpeg,
      before: optimized.before,
      after: optimized.after,
    };
  }

  await writeFile(outputPath, optimized.data);
  return {
    inputPath,
    outputPath,
    alreadyOptimized: false,
    wroteOutput: true,
    resized: optimized.resized,
    convertedToJpeg: optimized.convertedToJpeg,
    before: optimized.before,
    after: optimized.after,
  };
}

export function buildTakodeAgentImagePath(inputPath: string, mediaType = "image/jpeg"): string {
  const ext = MIME_TO_EXT[mediaType] ?? (extname(inputPath).replace(/^\./, "") || "bin");
  const inputBase = basename(inputPath);
  const inputExt = extname(inputBase);
  const baseWithoutExt = inputExt ? inputBase.slice(0, -inputExt.length) : inputBase;
  return join(dirname(inputPath), `${baseWithoutExt}.takode-agent.${ext}`);
}

export function buildStoredImageFilename(imageId: string, mediaType: string, options: { optimized: boolean }): string {
  const ext = MIME_TO_EXT[mediaType] ?? "bin";
  return options.optimized ? `${imageId}.takode-agent.${ext}` : `${imageId}.orig.${ext}`;
}

export function isTakodeAgentOptimizedPath(path: string): boolean {
  return basename(path).includes(TAKODE_AGENT_IMAGE_MARKER);
}

export function wasImageBufferProcessed(
  result: Pick<BufferOptimizationResult, "resized" | "convertedToJpeg">,
): boolean {
  return result.resized || result.convertedToJpeg;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function requireSharp(feature: string): Promise<SharpModule> {
  const sharp = await loadSharp();
  if (!sharp) {
    throw new SharpUnavailableError(feature);
  }
  return sharp;
}

interface SharpMetadata {
  width?: number;
  height?: number;
  format?: string;
}

interface SharpPipeline {
  metadata(): Promise<SharpMetadata>;
  rotate(): SharpPipeline;
  resize(options: { width: number; height: number; fit: "inside"; withoutEnlargement?: boolean }): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
  toFile(path: string): Promise<unknown>;
}

export type SharpModule = (input: Buffer) => SharpPipeline;

const JPEG_ELIGIBLE_MIMES = new Set(["image/png", "image/bmp", "image/tiff"]);
const JPEG_ELIGIBLE_FORMATS = new Set(["png", "bmp", "tiff", "tif"]);

const defaultSharpLoader = async (): Promise<SharpModule> => {
  const module = (await import("sharp")) as { default?: SharpModule };
  const sharp = module.default;
  if (!sharp) {
    throw new Error("sharp module did not expose a default export");
  }
  return sharp;
};

let sharpLoader: () => Promise<SharpModule> = defaultSharpLoader;
let sharpModulePromise: Promise<SharpModule | null> | null = null;
let sharpLoadFailureLogged = false;

async function resizeRasterForStore(data: Buffer, sharp: SharpModule, maxDim = STORE_MAX_DIM): Promise<Buffer> {
  try {
    const meta = await sharp(data).metadata();
    if (!meta.width || !meta.height) return data;
    if (meta.width <= maxDim && meta.height <= maxDim) return data;
    return await sharp(data)
      .rotate()
      .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
      .toBuffer();
  } catch (err) {
    console.warn("[image-optimizer] Failed to resize image, saving original:", err);
    return data;
  }
}

async function loadSharp(): Promise<SharpModule | null> {
  if (!sharpModulePromise) {
    sharpModulePromise = sharpLoader().catch((err) => {
      if (!sharpLoadFailureLogged) {
        sharpLoadFailureLogged = true;
        console.warn("[image-optimizer] sharp unavailable, image processing disabled:", err);
      }
      return null;
    });
  }
  return sharpModulePromise;
}

function dimensionsFromMetadata(meta: SharpMetadata, bytes: number): ImageDimensions {
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    bytes,
  };
}

function exceedsMaxDim(meta: SharpMetadata, maxDim: number): boolean {
  return Boolean(meta.width && meta.height && (meta.width > maxDim || meta.height > maxDim));
}

function isJpegEligibleFormat(format: string | undefined): boolean {
  return Boolean(format && JPEG_ELIGIBLE_FORMATS.has(format));
}

function isJpegEligibleMime(mimeType: string): boolean {
  return JPEG_ELIGIBLE_MIMES.has(mimeType);
}

function mimeTypeFromSharpFormat(format: string | undefined): string | undefined {
  if (!format) return undefined;
  if (format === "jpg") return "image/jpeg";
  if (format === "svg") return "image/svg+xml";
  return `image/${format}`;
}

function mimeTypeFromExtension(path: string): string {
  const ext = extname(path).toLowerCase().replace(/^\./, "");
  const match = Object.entries(MIME_TO_EXT).find(([, value]) => value === ext);
  return match?.[0] ?? "application/octet-stream";
}
