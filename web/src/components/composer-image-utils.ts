export interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

export function nextPendingUploadId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `pending-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getImageFiles(files: ArrayLike<File> | Iterable<File> | null | undefined): File[] {
  if (!files) return [];
  return Array.from(files).filter((file) => file.type.startsWith("image/"));
}

export function getPastedImageFiles(e: React.ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export function hasDraggedImageFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    return Array.from(dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith("image/"));
  }
  return getImageFiles(dataTransfer.files).length > 0;
}

export function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const API_SUPPORTED_IMAGE_FORMATS = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Convert unsupported image formats to JPEG via Canvas (browser-native). */
export async function ensureSupportedFormat(
  base64: string,
  mediaType: string,
): Promise<{ base64: string; mediaType: string }> {
  if (API_SUPPORTED_IMAGE_FORMATS.has(mediaType)) return { base64, mediaType };
  try {
    const blob = await fetch(`data:${mediaType};base64,${base64}`).then((r) => r.blob());
    const img = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    const converted = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    const arrayBuf = await converted.arrayBuffer();
    return {
      base64: btoa(String.fromCharCode(...new Uint8Array(arrayBuf))),
      mediaType: "image/jpeg",
    };
  } catch {
    return { base64, mediaType };
  }
}
