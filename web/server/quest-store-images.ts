import { randomBytes } from "node:crypto";
import { readdir, readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { QuestImage, QuestmasterTask } from "./quest-types.js";

type QuestImageStoreDeps<TStore> = {
  getLiveQuestById: (store: TStore, questId: string) => QuestmasterTask | null;
  getQuest: (questId: string) => Promise<QuestmasterTask | null>;
  liveQuestmasterDir: string;
  mutateLiveQuestStore: <T>(
    fn: (store: TStore) => Promise<{ store: TStore; result: T }> | { store: TStore; result: T },
  ) => Promise<T>;
  normalizeLiveQuest: (quest: QuestmasterTask) => QuestmasterTask;
  readLiveQuestStore: () => Promise<TStore | null>;
  upsertLiveQuest: (store: TStore, quest: QuestmasterTask) => TStore;
  writeQuest: (quest: QuestmasterTask) => Promise<void>;
};

// Map quest MIME types to file extensions. Uses image-store's map for common
// types but also supports .svg via a local lookup since IMAGE_MIME_TO_EXT
// values don't include the leading dot that quest filenames use.
const QUEST_MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

export async function saveQuestImageFile(args: {
  data: Buffer;
  ensureLiveImagesDir: () => Promise<void>;
  filename: string;
  liveImagesDir: string;
  mimeType: string;
}): Promise<QuestImage> {
  await args.ensureLiveImagesDir();
  const id = randomBytes(8).toString("hex");
  const ext = QUEST_MIME_TO_EXT[args.mimeType] || extname(args.filename) || ".bin";
  const diskName = `${id}${ext}`;
  const diskPath = join(args.liveImagesDir, diskName);
  const { resizeForStore } = await import("./image-store.js");
  const finalData = await resizeForStore(args.data, args.mimeType);
  await writeFile(diskPath, finalData);
  return { id, filename: args.filename, mimeType: args.mimeType, path: diskPath };
}

export async function addQuestImagesToStore<TStore>(
  questId: string,
  images: QuestImage[],
  deps: QuestImageStoreDeps<TStore>,
): Promise<QuestmasterTask | null> {
  const liveStore = await deps.readLiveQuestStore();
  if (liveStore) {
    return deps.mutateLiveQuestStore(async (store) => {
      const current = deps.getLiveQuestById(store, questId);
      if (!current) return { store, result: null };

      const existing = current.images ?? [];
      const updated = {
        ...current,
        images: [...existing, ...images],
        updatedAt: Date.now(),
      } as QuestmasterTask;
      return { store: deps.upsertLiveQuest(store, updated), result: deps.normalizeLiveQuest(updated) };
    });
  }

  const current = await deps.getQuest(questId);
  if (!current) return null;

  const existing = current.images ?? [];
  (current as { images: QuestImage[] }).images = [...existing, ...images];
  (current as { updatedAt?: number }).updatedAt = Date.now();
  await deps.writeQuest(current);
  return current;
}

export async function removeQuestImageFromStore<TStore>(
  questId: string,
  imageId: string,
  deps: QuestImageStoreDeps<TStore>,
): Promise<QuestmasterTask | null> {
  const liveStore = await deps.readLiveQuestStore();
  if (liveStore) {
    const result = await deps.mutateLiveQuestStore(async (store) => {
      const current = deps.getLiveQuestById(store, questId);
      if (!current)
        return { store, result: { quest: null as QuestmasterTask | null, imagePath: undefined as string | undefined } };
      if (!current.images?.length) return { store, result: { quest: current, imagePath: undefined } };

      const image = current.images.find((img) => img.id === imageId);
      const updated = {
        ...current,
        images: current.images.filter((img) => img.id !== imageId),
        updatedAt: Date.now(),
      } as QuestmasterTask;
      return {
        store: deps.upsertLiveQuest(store, updated),
        result: { quest: deps.normalizeLiveQuest(updated), imagePath: image?.path },
      };
    });

    if (result.imagePath && isManagedLiveQuestPath(result.imagePath, deps.liveQuestmasterDir)) {
      await unlink(result.imagePath).catch(() => {});
    }
    return result.quest;
  }

  const current = await deps.getQuest(questId);
  if (!current) return null;
  if (!current.images?.length) return current;

  const image = current.images.find((img) => img.id === imageId);
  (current as { images: QuestImage[] }).images = current.images.filter((img) => img.id !== imageId);
  (current as { updatedAt?: number }).updatedAt = Date.now();
  await deps.writeQuest(current);

  if (image?.path && isManagedLiveQuestPath(image.path, deps.liveQuestmasterDir)) {
    await unlink(image.path).catch(() => {});
  }

  return current;
}

export async function readQuestImageFileFromDirs(
  imageId: string,
  imageDirs: string[],
): Promise<{ data: Buffer; mimeType: string } | null> {
  for (const imageDir of imageDirs) {
    try {
      await mkdir(imageDir, { recursive: true });
      const files = await readdir(imageDir);
      const file = files.find((f) => f.startsWith(imageId));
      if (!file) continue;
      const fullPath = join(imageDir, file);
      const data = (await readFile(fullPath)) as Buffer;
      const ext = extname(file).toLowerCase();
      const mimeType = Object.entries(QUEST_MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
      return { data, mimeType };
    } catch {
      // Try the next known image directory.
    }
  }
  return null;
}

function isManagedLiveQuestPath(path: string, liveQuestmasterDir: string): boolean {
  return path === liveQuestmasterDir || path.startsWith(`${liveQuestmasterDir}/`);
}
