import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { extname } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  QuestmasterTask,
  QuestStatus,
  QuestCreateInput,
  QuestPatchInput,
  QuestTransitionInput,
  QuestVerificationItem,
  QuestImage,
  QuestIdea,
  QuestRefined,
  QuestInProgress,
  QuestNeedsVerification,
  QuestDone,
} from "./quest-types.js";

// ─── Paths ───────────────────────────────────────────────────────────────────

const QUESTMASTER_DIR = join(homedir(), ".companion", "questmaster");
const IMAGES_DIR = join(QUESTMASTER_DIR, "images");
const COUNTER_FILE = join(QUESTMASTER_DIR, "_quest_counter.json");

function ensureDir(): void {
  mkdirSync(QUESTMASTER_DIR, { recursive: true });
}

function ensureImagesDir(): void {
  mkdirSync(IMAGES_DIR, { recursive: true });
}

function filePath(id: string): string {
  return join(QUESTMASTER_DIR, `${id}.json`);
}

// ─── Counter ─────────────────────────────────────────────────────────────────

function readCounter(): number {
  ensureDir();
  try {
    const raw = readFileSync(COUNTER_FILE, "utf-8");
    const data = JSON.parse(raw) as { next: number };
    if (typeof data.next !== "number" || Number.isNaN(data.next) || data.next < 1) {
      return 1;
    }
    return data.next;
  } catch {
    return 1;
  }
}

function writeCounter(next: number): void {
  ensureDir();
  writeFileSync(COUNTER_FILE, JSON.stringify({ next }), "utf-8");
}

function nextQuestId(): string {
  const n = readCounter();
  writeCounter(n + 1);
  return `q-${n}`;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function readQuest(id: string): QuestmasterTask | null {
  ensureDir();
  try {
    const raw = readFileSync(filePath(id), "utf-8");
    return JSON.parse(raw) as QuestmasterTask;
  } catch {
    return null;
  }
}

function writeQuest(quest: QuestmasterTask): void {
  ensureDir();
  writeFileSync(filePath(quest.id), JSON.stringify(quest, null, 2), "utf-8");
}

/** Read all version files, grouped by questId. */
function readAllVersions(): Map<string, QuestmasterTask[]> {
  ensureDir();
  const groups = new Map<string, QuestmasterTask[]>();
  try {
    const files = readdirSync(QUESTMASTER_DIR).filter(
      (f) => f.endsWith(".json") && !f.startsWith("_"),
    );
    for (const file of files) {
      try {
        const raw = readFileSync(join(QUESTMASTER_DIR, file), "utf-8");
        const quest = JSON.parse(raw) as QuestmasterTask;
        const arr = groups.get(quest.questId) || [];
        arr.push(quest);
        groups.set(quest.questId, arr);
      } catch {
        // Skip corrupt files
      }
    }
  } catch {
    // Directory might not exist yet
  }
  return groups;
}

/** Get the latest version for a questId from a list of versions. */
function latestVersion(versions: QuestmasterTask[]): QuestmasterTask {
  return versions.reduce((a, b) => (a.version > b.version ? a : b));
}

/** Build the next version ID for a questId. */
function nextVersionId(questId: string, currentVersion: number): string {
  return `${questId}-v${currentVersion + 1}`;
}

// ─── Status ordering (for carrying forward fields) ───────────────────────────

const STATUS_ORDER: Record<QuestStatus, number> = {
  idea: 0,
  refined: 1,
  in_progress: 2,
  needs_verification: 3,
  done: 4,
};

// ─── Public API ──────────────────────────────────────────────────────────────

/** List the latest version of every quest. */
export function listQuests(): QuestmasterTask[] {
  const groups = readAllVersions();
  const result: QuestmasterTask[] = [];
  for (const versions of groups.values()) {
    result.push(latestVersion(versions));
  }
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result;
}

/** Get the latest version of a quest by questId. */
export function getQuest(questId: string): QuestmasterTask | null {
  const groups = readAllVersions();
  const versions = groups.get(questId);
  if (!versions || versions.length === 0) return null;
  return latestVersion(versions);
}

/** Get a specific version by full version id (e.g., "q-1-v3"). */
export function getQuestVersion(id: string): QuestmasterTask | null {
  return readQuest(id);
}

/** Get all versions of a quest, ordered oldest → newest. */
export function getQuestHistory(questId: string): QuestmasterTask[] {
  const groups = readAllVersions();
  const versions = groups.get(questId);
  if (!versions) return [];
  return versions.sort((a, b) => a.version - b.version);
}

/** Create a new quest. Returns the initial version. */
export function createQuest(input: QuestCreateInput): QuestmasterTask {
  if (!input.title?.trim()) {
    throw new Error("Quest title is required");
  }

  const questId = nextQuestId();
  const id = `${questId}-v1`;
  const now = Date.now();
  const status = input.status || "idea";

  const base = {
    id,
    questId,
    version: 1,
    title: input.title.trim(),
    createdAt: now,
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
  };

  let quest: QuestmasterTask;

  switch (status) {
    case "idea":
      quest = {
        ...base,
        status: "idea",
        ...(input.description ? { description: input.description } : {}),
      } as QuestIdea;
      break;
    case "refined":
      if (!input.description?.trim()) {
        throw new Error("Description is required for refined status");
      }
      quest = {
        ...base,
        status: "refined",
        description: input.description,
      } as QuestRefined;
      break;
    default:
      // For simplicity, only idea and refined are valid initial statuses
      throw new Error(`Cannot create a quest directly in "${status}" status`);
  }

  writeQuest(quest);
  return quest;
}

/** Same-stage edit. Mutates the latest version in place, no new version. */
export function patchQuest(
  questId: string,
  patch: QuestPatchInput,
): QuestmasterTask | null {
  const current = getQuest(questId);
  if (!current) return null;

  const updated = { ...current, createdAt: Date.now() } as QuestmasterTask;
  if (patch.title !== undefined) (updated as { title: string }).title = patch.title.trim();
  if (patch.description !== undefined) {
    (updated as { description?: string }).description = patch.description.trim();
  }
  if (patch.tags !== undefined) {
    (updated as { tags?: string[] }).tags = patch.tags;
  }

  writeQuest(updated);
  return updated;
}

/** Delete a quest and all its versions. */
export function deleteQuest(questId: string): boolean {
  const versions = getQuestHistory(questId);
  if (versions.length === 0) return false;
  for (const v of versions) {
    try {
      unlinkSync(filePath(v.id));
    } catch {
      // ok
    }
  }
  return true;
}

/**
 * Generic status transition. Creates a new version linked to the previous.
 * Carries forward fields from the current version and adds new required fields.
 */
export function transitionQuest(
  questId: string,
  input: QuestTransitionInput,
): QuestmasterTask | null {
  const current = getQuest(questId);
  if (!current) return null;

  const targetStatus = input.status;

  // Guard against no-op transitions (same status with no new fields)
  if (targetStatus === current.status && !input.description && !input.sessionId && !input.verificationItems && !input.notes && !input.cancelled) {
    return current;
  }
  const now = Date.now();
  const newVersion = current.version + 1;
  const newId = nextVersionId(questId, current.version);

  const base = {
    id: newId,
    questId,
    version: newVersion,
    prevId: current.id,
    title: current.title,
    createdAt: now,
    ...(current.tags?.length ? { tags: current.tags } : {}),
    ...(current.parentId ? { parentId: current.parentId } : {}),
    ...(current.images?.length ? { images: current.images } : {}),
  };

  let quest: QuestmasterTask;

  switch (targetStatus) {
    case "idea": {
      quest = {
        ...base,
        status: "idea",
        ...("description" in current && current.description
          ? { description: current.description }
          : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      } as QuestIdea;
      break;
    }

    case "refined": {
      const description =
        input.description ??
        ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for refined status");
      }
      quest = {
        ...base,
        status: "refined",
        description,
      } as QuestRefined;
      break;
    }

    case "in_progress": {
      const description =
        input.description ??
        ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for in_progress status");
      }
      const sessionId =
        input.sessionId ??
        ("sessionId" in current ? (current as QuestInProgress).sessionId : undefined);
      if (!sessionId) {
        throw new Error("sessionId is required for in_progress status");
      }
      quest = {
        ...base,
        status: "in_progress",
        description,
        sessionId,
        claimedAt: now,
      } as QuestInProgress;
      break;
    }

    case "needs_verification": {
      const description =
        input.description ??
        ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for needs_verification status");
      }
      const sessionId =
        input.sessionId ??
        ("sessionId" in current ? (current as QuestInProgress).sessionId : undefined);
      if (!sessionId) {
        throw new Error("sessionId is required for needs_verification status");
      }
      const verificationItems =
        input.verificationItems ??
        ("verificationItems" in current
          ? (current as QuestNeedsVerification).verificationItems
          : undefined);
      if (!verificationItems || verificationItems.length === 0) {
        throw new Error("verificationItems are required for needs_verification status");
      }
      quest = {
        ...base,
        status: "needs_verification",
        description,
        sessionId,
        claimedAt:
          "claimedAt" in current
            ? (current as QuestInProgress).claimedAt
            : now,
        verificationItems,
      } as QuestNeedsVerification;
      break;
    }

    case "done": {
      const description =
        input.description ??
        ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for done status");
      }
      const sessionId =
        "sessionId" in current
          ? (current as QuestInProgress).sessionId
          : undefined;
      if (!sessionId) {
        throw new Error("sessionId is required for done status");
      }
      const verificationItems =
        "verificationItems" in current
          ? (current as QuestNeedsVerification).verificationItems
          : undefined;
      if (!verificationItems || verificationItems.length === 0) {
        throw new Error("verificationItems are required for done status");
      }
      quest = {
        ...base,
        status: "done",
        description,
        sessionId,
        claimedAt:
          "claimedAt" in current
            ? (current as QuestInProgress).claimedAt
            : now,
        verificationItems,
        completedAt: now,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.cancelled ? { cancelled: true } : {}),
      } as QuestDone;
      break;
    }

    default:
      throw new Error(`Unknown status: ${targetStatus}`);
  }

  writeQuest(quest);
  return quest;
}

/** Convenience: claim a quest (transition to in_progress). */
export function claimQuest(
  questId: string,
  sessionId: string,
): QuestmasterTask | null {
  const current = getQuest(questId);
  if (!current) return null;

  // Check if already claimed by a different session
  if (
    current.status === "in_progress" &&
    "sessionId" in current &&
    (current as QuestInProgress).sessionId !== sessionId
  ) {
    throw new Error(
      `Quest ${questId} is already claimed by session ${(current as QuestInProgress).sessionId}`,
    );
  }

  return transitionQuest(questId, {
    status: "in_progress",
    sessionId,
  });
}

/** Convenience: complete a quest (transition to needs_verification). */
export function completeQuest(
  questId: string,
  items: QuestVerificationItem[],
): QuestmasterTask | null {
  return transitionQuest(questId, {
    status: "needs_verification",
    verificationItems: items,
  });
}

/** Convenience: mark a quest as done (or cancelled). */
export function markDone(
  questId: string,
  opts?: { notes?: string; cancelled?: boolean },
): QuestmasterTask | null {
  return transitionQuest(questId, {
    status: "done",
    ...(opts?.notes ? { notes: opts.notes } : {}),
    ...(opts?.cancelled ? { cancelled: true } : {}),
  });
}

/** Toggle a verification item checkbox (in-place, no new version). */
export function checkVerificationItem(
  questId: string,
  index: number,
  checked: boolean,
): QuestmasterTask | null {
  const current = getQuest(questId);
  if (!current) return null;

  if (!("verificationItems" in current)) {
    throw new Error("Quest does not have verification items");
  }

  const items = (current as QuestNeedsVerification).verificationItems;
  if (index < 0 || index >= items.length) {
    throw new Error(`Verification item index ${index} out of range`);
  }

  items[index].checked = checked;
  (current as { createdAt: number }).createdAt = Date.now();
  writeQuest(current);
  return current;
}

// ─── Image management ────────────────────────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

/** Save an image to disk and return image metadata. */
export function saveQuestImage(
  filename: string,
  data: Buffer,
  mimeType: string,
): QuestImage {
  ensureImagesDir();
  const id = randomBytes(8).toString("hex");
  const ext = MIME_TO_EXT[mimeType] || extname(filename) || ".bin";
  const diskName = `${id}${ext}`;
  const diskPath = join(IMAGES_DIR, diskName);
  writeFileSync(diskPath, data);
  return { id, filename, mimeType, path: diskPath };
}

/** Add images to a quest (in-place patch, no new version). */
export function addQuestImages(
  questId: string,
  images: QuestImage[],
): QuestmasterTask | null {
  const current = getQuest(questId);
  if (!current) return null;

  const existing = current.images ?? [];
  (current as { images: QuestImage[] }).images = [...existing, ...images];
  (current as { createdAt: number }).createdAt = Date.now();
  writeQuest(current);
  return current;
}

/** Remove an image from a quest and delete the file. */
export function removeQuestImage(
  questId: string,
  imageId: string,
): QuestmasterTask | null {
  const current = getQuest(questId);
  if (!current) return null;
  if (!current.images?.length) return current;

  const image = current.images.find((img) => img.id === imageId);
  (current as { images: QuestImage[] }).images = current.images.filter(
    (img) => img.id !== imageId,
  );
  (current as { createdAt: number }).createdAt = Date.now();
  writeQuest(current);

  // Delete the file
  if (image) {
    try {
      unlinkSync(image.path);
    } catch {
      // File may already be deleted
    }
  }

  return current;
}

/** Read an image file from disk. Returns null if not found. */
export function readQuestImageFile(
  imageId: string,
): { data: Buffer; mimeType: string } | null {
  ensureImagesDir();
  try {
    const files = readdirSync(IMAGES_DIR);
    const file = files.find((f) => f.startsWith(imageId));
    if (!file) return null;
    const fullPath = join(IMAGES_DIR, file);
    const data = readFileSync(fullPath) as Buffer;
    // Derive MIME from extension
    const ext = extname(file).toLowerCase();
    const mimeType =
      Object.entries(MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ??
      "application/octet-stream";
    return { data, mimeType };
  } catch {
    return null;
  }
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Reset the store directory. Only for tests. */
export function _resetForTests(): void {
  ensureDir();
  try {
    const files = readdirSync(QUESTMASTER_DIR);
    for (const file of files) {
      try {
        unlinkSync(join(QUESTMASTER_DIR, file));
      } catch {
        // ok
      }
    }
  } catch {
    // ok
  }
}
