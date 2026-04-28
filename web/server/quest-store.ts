import { mkdirSync } from "node:fs";
import { readdir, readFile, writeFile, unlink, mkdir, rm, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type {
  QuestmasterTask,
  QuestCreateInput,
  QuestPatchInput,
  QuestTransitionInput,
  QuestFeedbackEntry,
  QuestImage,
  QuestVerificationItem,
  QuestIdea,
  QuestRefined,
  QuestInProgress,
  QuestDone,
  QuestHistoryView,
  QuestStoreMigrationReport,
} from "./quest-types.js";
import { hasQuestReviewMetadata } from "./quest-types.js";
import { getName } from "./session-names.js";
import { normalizeTldr } from "./quest-tldr.js";
import {
  getActiveSessionId,
  getPreviousOwnerSessionIds,
  normalizeCommitShas,
  normalizeQuestOwnership,
  normalizeVerificationItems,
  shouldMarkVerificationInboxUnreadFromFeedbackPatch,
} from "./quest-store-helpers.js";
import {
  addQuestImagesToStore,
  readQuestImageFileFromDirs,
  removeQuestImageFromStore,
  saveQuestImageFile,
} from "./quest-store-images.js";

// ─── Paths ───────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const QUESTMASTER_DIR = join(COMPANION_DIR, "questmaster");
const IMAGES_DIR = join(QUESTMASTER_DIR, "images");
const LIVE_QUESTMASTER_DIR = join(COMPANION_DIR, "questmaster-live");
const LIVE_IMAGES_DIR = join(LIVE_QUESTMASTER_DIR, "images");
const COUNTER_FILE = join(QUESTMASTER_DIR, "_quest_counter.json");
const CREATE_LOCK_DIR = join(QUESTMASTER_DIR, "_create.lock");
const LATEST_SNAPSHOT_FILE = join(QUESTMASTER_DIR, "_latest_snapshot.json");
const LATEST_SNAPSHOT_LOCK_DIR = join(QUESTMASTER_DIR, "_latest_snapshot.lock");
const LEGACY_COLOCATED_LIVE_STORE_FILE = join(QUESTMASTER_DIR, "store.json");
const LIVE_STORE_FILE = join(LIVE_QUESTMASTER_DIR, "store.json");
const LIVE_STORE_LOCK_DIR = join(LIVE_QUESTMASTER_DIR, "_store.lock");
const CREATE_LOCK_STALE_MS = 30_000;
const CREATE_LOCK_RETRY_MS = 10;
const LATEST_SNAPSHOT_LOCK_STALE_MS = 120_000;
const LIVE_STORE_LOCK_STALE_MS = 120_000;

let pendingCreate: Promise<unknown> = Promise.resolve();
let pendingLiveStoreWrite: Promise<unknown> = Promise.resolve();

type LatestQuestSnapshot = {
  activeQuestBySessionId: Record<string, string>;
  latestFileStateByQuestId: Record<string, LatestQuestFileState>;
  latestVersionByQuestId: Record<string, number>;
  quests: QuestmasterTask[];
  updatedAt: number;
  version: 3;
};

type LatestQuestFileState = {
  mtimeMs: number;
  size: number;
  version: number;
};

type QuestVersionFile = {
  file: string;
  questId: string;
  version: number;
};

type LiveQuestStore = {
  format: "mutable_current_record";
  version: 1;
  nextQuestNumber: number;
  quests: QuestmasterTask[];
  legacyBackupDir?: string;
  updatedAt: number;
};

type LegacyQuestLoadResult = {
  questId: string;
  files: string[];
  readable: QuestmasterTask[];
  unreadable: { file: string; error: string }[];
};

type QuestStoreMigrationPreparation = {
  report: QuestStoreMigrationReport;
  store: LiveQuestStore;
  backupDir: string;
  canActivate: boolean;
};

type QuestStoreBootstrapResult =
  | {
      mode: "preferred_live";
      legacyBackupDir?: string;
      liveStoreFile: string;
    }
  | {
      mode: "migrated_existing_live";
      legacyBackupDir: string;
      liveStoreFile: string;
    }
  | {
      mode: "migrated_legacy";
      legacyBackupDir: string;
      liveStoreFile: string;
      report: QuestStoreMigrationReport;
    }
  | {
      mode: "no_data";
      liveStoreFile: string;
    };

// Cold-path: synchronous mkdir at module load is fine
mkdirSync(QUESTMASTER_DIR, { recursive: true });

async function ensureDir(): Promise<void> {
  await mkdir(QUESTMASTER_DIR, { recursive: true });
}

async function ensureLiveDir(): Promise<void> {
  await mkdir(LIVE_QUESTMASTER_DIR, { recursive: true });
}

async function ensureLiveImagesDir(): Promise<void> {
  await mkdir(LIVE_IMAGES_DIR, { recursive: true });
}

function latestSnapshotTempPath(): string {
  return `${LATEST_SNAPSHOT_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

function filePath(id: string): string {
  return join(QUESTMASTER_DIR, `${id}.json`);
}

// ─── Counter ─────────────────────────────────────────────────────────────────

async function readCounter(): Promise<number> {
  await ensureDir();
  try {
    const raw = await readFile(COUNTER_FILE, "utf-8");
    const data = JSON.parse(raw) as { next: number };
    if (typeof data.next !== "number" || Number.isNaN(data.next) || data.next < 1) {
      return 1;
    }
    return data.next;
  } catch {
    return 1;
  }
}

async function writeCounter(next: number): Promise<void> {
  await ensureDir();
  await writeFile(COUNTER_FILE, JSON.stringify({ next }), "utf-8");
}

/** Allocate the next quest ID. Must be called while holding the create lock. */
async function nextQuestId(): Promise<string> {
  let n = await readCounter();

  // Reconcile: scan existing quest files to find the max numeric ID.
  // The counter file can fall behind (e.g. corruption, manual edits, or
  // quests created by a different process). Without this, create would
  // silently overwrite existing quests.
  try {
    const files = await readdir(QUESTMASTER_DIR);
    for (const f of files) {
      const m = f.match(/^q-(\d+)-v\d+\.json$/);
      if (m) {
        const existing = Number(m[1]);
        if (existing >= n) n = existing + 1;
      }
    }
  } catch {
    // Directory might not exist yet — fine, n stays as-is
  }

  await writeCounter(n + 1);
  return `q-${n}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isCreateLockStale(): Promise<boolean> {
  try {
    const lockStat = await stat(CREATE_LOCK_DIR);
    return Date.now() - lockStat.mtimeMs > CREATE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function acquireCreateFilesystemLock(): Promise<() => Promise<void>> {
  await ensureDir();
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(CREATE_LOCK_DIR);
      return async () => {
        await rm(CREATE_LOCK_DIR, { recursive: true, force: true });
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw err;

      if (await isCreateLockStale()) {
        await rm(CREATE_LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }

      if (Date.now() - startedAt > CREATE_LOCK_STALE_MS * 2) {
        throw new Error("Timed out waiting for quest create lock");
      }

      await sleep(CREATE_LOCK_RETRY_MS);
    }
  }
}

async function withCreateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const release = await acquireCreateFilesystemLock();
    try {
      return await fn();
    } finally {
      await release();
    }
  };

  const result = pendingCreate.catch(() => {}).then(run);
  pendingCreate = result.catch(() => {});
  return result;
}

function buildActiveQuestBySessionId(quests: QuestmasterTask[]): Record<string, string> {
  const activeQuestBySessionId: Record<string, string> = {};
  for (const quest of quests) {
    if (quest.status !== "in_progress") continue;
    const sessionId = getActiveSessionId(quest);
    if (!sessionId) continue;
    activeQuestBySessionId[sessionId] = quest.questId;
  }
  return activeQuestBySessionId;
}

function getQuestRecencyTs(quest: QuestmasterTask): number {
  return Math.max(quest.createdAt, (quest as { updatedAt?: number }).updatedAt ?? 0, quest.statusChangedAt ?? 0);
}

function sortLatestQuests(quests: QuestmasterTask[]): QuestmasterTask[] {
  return [...quests].sort((a, b) => getQuestRecencyTs(b) - getQuestRecencyTs(a));
}

function extractQuestNumber(questId: string): number {
  const match = questId.match(/^q-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function computeNextQuestNumber(quests: QuestmasterTask[]): number {
  return quests.reduce((maxNumber, quest) => Math.max(maxNumber, extractQuestNumber(quest.questId)), 0) + 1;
}

function computeNextQuestNumberFromQuestIds(questIds: string[]): number {
  return questIds.reduce((maxNumber, questId) => Math.max(maxNumber, extractQuestNumber(questId)), 0) + 1;
}

function normalizeLiveQuest(quest: QuestmasterTask): QuestmasterTask {
  const normalized = normalizeQuestOwnership({ ...quest }) as QuestmasterTask & {
    id: string;
    createdAt: number;
    questId: string;
    prevId?: string;
    statusChangedAt?: number;
    version: number;
  };
  normalized.id = normalized.questId;
  delete normalized.prevId;
  normalized.createdAt = normalized.createdAt || Date.now();
  normalized.version = Number.isInteger(normalized.version) && normalized.version > 0 ? normalized.version : 1;
  normalized.statusChangedAt =
    typeof normalized.statusChangedAt === "number" && normalized.statusChangedAt > 0
      ? normalized.statusChangedAt
      : normalized.createdAt;
  return normalized;
}

function normalizeLiveQuestStore(value: unknown): LiveQuestStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Live quest store must be an object");
  }
  const parsed = value as {
    format?: unknown;
    legacyBackupDir?: unknown;
    nextQuestNumber?: unknown;
    quests?: unknown;
    updatedAt?: unknown;
    version?: unknown;
  };
  if (parsed.format !== "mutable_current_record" || parsed.version !== 1 || !Array.isArray(parsed.quests)) {
    throw new Error("Live quest store has an unsupported format");
  }
  const quests = sortLatestQuests(parsed.quests.map((quest) => normalizeLiveQuest(quest as QuestmasterTask)));
  const computedNext = computeNextQuestNumber(quests);
  const nextQuestNumber =
    typeof parsed.nextQuestNumber === "number" &&
    Number.isInteger(parsed.nextQuestNumber) &&
    parsed.nextQuestNumber >= computedNext
      ? parsed.nextQuestNumber
      : computedNext;
  return {
    format: "mutable_current_record",
    version: 1,
    quests,
    nextQuestNumber,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    ...(typeof parsed.legacyBackupDir === "string" && parsed.legacyBackupDir.trim()
      ? { legacyBackupDir: parsed.legacyBackupDir }
      : {}),
  };
}

function emptyLiveQuestStore(): LiveQuestStore {
  return {
    format: "mutable_current_record",
    version: 1,
    nextQuestNumber: 1,
    quests: [],
    updatedAt: Date.now(),
  };
}

function liveStoreTempPath(): string {
  return `${LIVE_STORE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

async function readLiveQuestStore(): Promise<LiveQuestStore | null> {
  const preferred = await readLiveQuestStoreAtPath(LIVE_STORE_FILE, ensureLiveDir);
  if (preferred) return preferred;
  return readLiveQuestStoreAtPath(LEGACY_COLOCATED_LIVE_STORE_FILE, ensureDir);
}

async function readLiveQuestStoreAtPath(
  path: string,
  ensureParentDir: () => Promise<void>,
): Promise<LiveQuestStore | null> {
  await ensureParentDir();
  try {
    const raw = await readFile(path, "utf-8");
    return normalizeLiveQuestStore(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function writeLiveQuestStore(store: LiveQuestStore): Promise<void> {
  await ensureLiveDir();
  const tempPath = liveStoreTempPath();
  const normalized = {
    ...store,
    quests: sortLatestQuests(store.quests.map((quest) => normalizeLiveQuest(quest))),
    nextQuestNumber: Math.max(store.nextQuestNumber, computeNextQuestNumber(store.quests)),
    updatedAt: Date.now(),
  } satisfies LiveQuestStore;
  await writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf-8");
  await rename(tempPath, LIVE_STORE_FILE);
}

async function isLiveStoreLockStale(): Promise<boolean> {
  try {
    const lockStat = await stat(LIVE_STORE_LOCK_DIR);
    return Date.now() - lockStat.mtimeMs > LIVE_STORE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function acquireLiveStoreFilesystemLock(): Promise<() => Promise<void>> {
  await ensureLiveDir();
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(LIVE_STORE_LOCK_DIR);
      return async () => {
        await rm(LIVE_STORE_LOCK_DIR, { recursive: true, force: true });
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw err;

      if (await isLiveStoreLockStale()) {
        await rm(LIVE_STORE_LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }

      if (Date.now() - startedAt > LIVE_STORE_LOCK_STALE_MS * 2) {
        throw new Error("Timed out waiting for live quest store lock");
      }

      await sleep(CREATE_LOCK_RETRY_MS);
    }
  }
}

async function withLiveStoreWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const release = await acquireLiveStoreFilesystemLock();
    try {
      return await fn();
    } finally {
      await release();
    }
  };

  const result = pendingLiveStoreWrite.catch(() => {}).then(run);
  pendingLiveStoreWrite = result.catch(() => {});
  return result;
}

async function mutateLiveQuestStore<T>(
  fn: (store: LiveQuestStore) => Promise<{ store: LiveQuestStore; result: T }> | { store: LiveQuestStore; result: T },
): Promise<T> {
  return withLiveStoreWriteLock(async () => {
    const current = (await readLiveQuestStore()) ?? emptyLiveQuestStore();
    const { store, result } = await fn(current);
    await writeLiveQuestStore(store);
    return result;
  });
}

function deriveLatestVersionByQuestId(quests: QuestmasterTask[]): Record<string, number> {
  return Object.fromEntries(quests.map((quest) => [quest.questId, quest.version]));
}

function normalizeLatestVersionByQuestId(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized: Record<string, number> = {};
  for (const [questId, version] of Object.entries(value as Record<string, unknown>)) {
    if (!/^q-\d+$/.test(questId)) return null;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
    normalized[questId] = version;
  }
  return normalized;
}

function normalizeLatestFileStateByQuestId(value: unknown): Record<string, LatestQuestFileState> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized: Record<string, LatestQuestFileState> = {};
  for (const [questId, state] of Object.entries(value as Record<string, unknown>)) {
    if (!/^q-\d+$/.test(questId)) return null;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    const mtimeMs = (state as { mtimeMs?: unknown }).mtimeMs;
    const size = (state as { size?: unknown }).size;
    const version = (state as { version?: unknown }).version;
    if (
      typeof mtimeMs !== "number" ||
      Number.isNaN(mtimeMs) ||
      mtimeMs < 0 ||
      typeof size !== "number" ||
      Number.isNaN(size) ||
      size < 0 ||
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1
    ) {
      return null;
    }
    normalized[questId] = { mtimeMs, size, version };
  }
  return normalized;
}

function latestVersionByQuestIdEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) return false;
  return aEntries.every(([questId, version]) => b[questId] === version);
}

function latestFileStateByQuestIdEqual(
  a: Record<string, LatestQuestFileState>,
  b: Record<string, LatestQuestFileState>,
): boolean {
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) return false;
  return aEntries.every(([questId, state]) => {
    const other = b[questId];
    return (
      other !== undefined &&
      other.version === state.version &&
      other.size === state.size &&
      other.mtimeMs === state.mtimeMs
    );
  });
}

function buildLatestVersionByQuestId(versionFilesByQuest: Map<string, QuestVersionFile[]>): Record<string, number> {
  return Object.fromEntries(
    [...versionFilesByQuest.entries()]
      .filter(([, versionFiles]) => versionFiles.length > 0)
      .map(([questId, versionFiles]) => [questId, versionFiles[0].version]),
  );
}

async function buildLatestFileStateByQuestId(
  versionFilesByQuest: Map<string, QuestVersionFile[]>,
): Promise<Record<string, LatestQuestFileState>> {
  const entries = await Promise.all(
    [...versionFilesByQuest.entries()].map(async ([questId, versionFiles]) => {
      const latestFile = versionFiles[0];
      if (!latestFile) return null;
      try {
        const fileStats = await stat(join(QUESTMASTER_DIR, latestFile.file));
        return [
          questId,
          {
            version: latestFile.version,
            size: fileStats.size,
            mtimeMs: fileStats.mtimeMs,
          },
        ] as const;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, LatestQuestFileState] => entry !== null),
  );
}

function buildLatestSnapshot(
  quests: QuestmasterTask[],
  latestVersionByQuestId: Record<string, number> = deriveLatestVersionByQuestId(quests),
  latestFileStateByQuestId: Record<string, LatestQuestFileState> = {},
): LatestQuestSnapshot {
  const normalized = sortLatestQuests(quests.map((quest) => normalizeQuestOwnership(quest)));
  return {
    version: 3,
    quests: normalized,
    activeQuestBySessionId: buildActiveQuestBySessionId(normalized),
    latestFileStateByQuestId,
    latestVersionByQuestId,
    updatedAt: Date.now(),
  };
}

async function writeLatestSnapshot(snapshot: LatestQuestSnapshot): Promise<void> {
  const tempPath = latestSnapshotTempPath();
  await writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf-8");
  await rename(tempPath, LATEST_SNAPSHOT_FILE);
}

async function readLatestSnapshotFile(): Promise<LatestQuestSnapshot | null> {
  await ensureDir();
  try {
    const raw = await readFile(LATEST_SNAPSHOT_FILE, "utf-8");
    const parsed = JSON.parse(raw) as {
      latestFileStateByQuestId?: Record<string, LatestQuestFileState>;
      latestVersionByQuestId?: Record<string, number>;
      quests?: QuestmasterTask[];
      updatedAt?: number;
      version?: number;
    };
    const latestFileStateByQuestId = normalizeLatestFileStateByQuestId(parsed.latestFileStateByQuestId);
    const latestVersionByQuestId = normalizeLatestVersionByQuestId(parsed.latestVersionByQuestId);
    if (
      parsed.version !== 3 ||
      !Array.isArray(parsed.quests) ||
      latestVersionByQuestId === null ||
      latestFileStateByQuestId === null
    ) {
      return null;
    }
    const quests = sortLatestQuests(parsed.quests.map((quest) => normalizeQuestOwnership(quest)));
    return {
      version: 3,
      quests,
      activeQuestBySessionId: buildActiveQuestBySessionId(quests),
      latestFileStateByQuestId,
      latestVersionByQuestId,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

async function isLatestSnapshotLockStale(): Promise<boolean> {
  try {
    const lockStat = await stat(LATEST_SNAPSHOT_LOCK_DIR);
    return Date.now() - lockStat.mtimeMs > LATEST_SNAPSHOT_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function acquireLatestSnapshotFilesystemLock(): Promise<() => Promise<void>> {
  await ensureDir();
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(LATEST_SNAPSHOT_LOCK_DIR);
      return async () => {
        await rm(LATEST_SNAPSHOT_LOCK_DIR, { recursive: true, force: true });
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw err;

      if (await isLatestSnapshotLockStale()) {
        await rm(LATEST_SNAPSHOT_LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }

      if (Date.now() - startedAt > LATEST_SNAPSHOT_LOCK_STALE_MS * 2) {
        throw new Error("Timed out waiting for latest quest snapshot lock");
      }

      await sleep(CREATE_LOCK_RETRY_MS);
    }
  }
}

async function withLatestSnapshotLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireLatestSnapshotFilesystemLock();
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function listQuestVersionFilesByQuest(): Promise<Map<string, QuestVersionFile[]>> {
  await ensureDir();
  const versionFilesByQuest = new Map<string, QuestVersionFile[]>();
  try {
    const files = await readdir(QUESTMASTER_DIR);
    for (const file of files) {
      const match = file.match(/^(q-\d+)-v(\d+)\.json$/);
      if (!match) continue;
      const questId = match[1];
      const version = Number(match[2]);
      const current = versionFilesByQuest.get(questId) ?? [];
      current.push({ file, questId, version });
      versionFilesByQuest.set(questId, current);
    }
  } catch {
    return new Map();
  }
  for (const versionFiles of versionFilesByQuest.values()) {
    versionFiles.sort((a, b) => b.version - a.version);
  }
  return versionFilesByQuest;
}

async function readLatestReadableQuestFromVersionFiles(
  versionFiles: QuestVersionFile[],
): Promise<QuestmasterTask | null> {
  for (const { file } of versionFiles) {
    const quest = await readQuestAtPath(join(QUESTMASTER_DIR, file));
    if (quest) return quest;
  }
  return null;
}

async function buildLatestSnapshotFromDisk(
  versionFilesByQuest?: Map<string, QuestVersionFile[]>,
): Promise<LatestQuestSnapshot> {
  const resolvedVersionFilesByQuest = versionFilesByQuest ?? (await listQuestVersionFilesByQuest());
  if (resolvedVersionFilesByQuest.size === 0) {
    return buildLatestSnapshot([], {}, {});
  }
  const latestVersionByQuestId = buildLatestVersionByQuestId(resolvedVersionFilesByQuest);
  const latestFileStateByQuestId = await buildLatestFileStateByQuestId(resolvedVersionFilesByQuest);
  const quests = await Promise.all(
    [...resolvedVersionFilesByQuest.values()].map((versionFiles) =>
      readLatestReadableQuestFromVersionFiles(versionFiles),
    ),
  );
  return buildLatestSnapshot(
    quests.filter((quest): quest is QuestmasterTask => quest !== null),
    latestVersionByQuestId,
    latestFileStateByQuestId,
  );
}

async function readFreshLatestSnapshot(
  versionFilesByQuest: Map<string, QuestVersionFile[]>,
): Promise<LatestQuestSnapshot | null> {
  const cached = await readLatestSnapshotFile();
  if (!cached) return null;
  const latestVersionByQuestId = buildLatestVersionByQuestId(versionFilesByQuest);
  if (!latestVersionByQuestIdEqual(cached.latestVersionByQuestId, latestVersionByQuestId)) {
    return null;
  }
  const latestFileStateByQuestId = await buildLatestFileStateByQuestId(versionFilesByQuest);
  return latestFileStateByQuestIdEqual(cached.latestFileStateByQuestId, latestFileStateByQuestId) ? cached : null;
}

async function readFreshLatestSnapshotOrRebuild(
  versionFilesByQuest: Map<string, QuestVersionFile[]>,
): Promise<LatestQuestSnapshot> {
  return (await readFreshLatestSnapshot(versionFilesByQuest)) ?? buildLatestSnapshotFromDisk(versionFilesByQuest);
}

async function loadLatestSnapshot(): Promise<LatestQuestSnapshot> {
  const currentVersionFilesByQuest = await listQuestVersionFilesByQuest();
  const cached = await readFreshLatestSnapshot(currentVersionFilesByQuest);
  if (cached) {
    return cached;
  }

  return withLatestSnapshotLock(async () => {
    const lockedVersionFilesByQuest = await listQuestVersionFilesByQuest();
    const afterLock = await readFreshLatestSnapshot(lockedVersionFilesByQuest);
    if (afterLock) {
      return afterLock;
    }
    const rebuilt = await buildLatestSnapshotFromDisk(lockedVersionFilesByQuest);
    await writeLatestSnapshot(rebuilt);
    return rebuilt;
  });
}

async function updateLatestSnapshotWithQuest(quest: QuestmasterTask): Promise<void> {
  await withLatestSnapshotLock(async () => {
    const currentVersionFilesByQuest = await listQuestVersionFilesByQuest();
    const current = await readFreshLatestSnapshotOrRebuild(currentVersionFilesByQuest);
    const nextQuest = normalizeQuestOwnership(quest);
    const remaining = current.quests.filter((existing) => existing.questId !== nextQuest.questId);
    const nextSnapshot = buildLatestSnapshot(
      [...remaining, nextQuest],
      {
        ...current.latestVersionByQuestId,
        [nextQuest.questId]: nextQuest.version,
      },
      current.latestFileStateByQuestId,
    );
    await writeLatestSnapshot(nextSnapshot);
  });
}

async function removeQuestFromLatestSnapshot(questId: string): Promise<void> {
  await withLatestSnapshotLock(async () => {
    const currentVersionFilesByQuest = await listQuestVersionFilesByQuest();
    const current = await readFreshLatestSnapshotOrRebuild(currentVersionFilesByQuest);
    const nextLatestVersionByQuestId = { ...current.latestVersionByQuestId };
    const nextLatestFileStateByQuestId = { ...current.latestFileStateByQuestId };
    delete nextLatestVersionByQuestId[questId];
    delete nextLatestFileStateByQuestId[questId];
    const nextSnapshot = buildLatestSnapshot(
      current.quests.filter((quest) => quest.questId !== questId),
      nextLatestVersionByQuestId,
      nextLatestFileStateByQuestId,
    );
    await writeLatestSnapshot(nextSnapshot);
  });
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function readQuest(id: string): Promise<QuestmasterTask | null> {
  await ensureDir();
  try {
    const raw = await readFile(filePath(id), "utf-8");
    return normalizeQuestOwnership(JSON.parse(raw) as QuestmasterTask);
  } catch {
    return null;
  }
}

async function readQuestAtPath(path: string): Promise<QuestmasterTask | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return normalizeQuestOwnership(JSON.parse(raw) as QuestmasterTask);
  } catch {
    return null;
  }
}

async function writeQuest(quest: QuestmasterTask): Promise<void> {
  await ensureDir();
  const normalized = normalizeQuestOwnership(quest);
  await writeFile(filePath(normalized.id), JSON.stringify(normalized, null, 2), "utf-8");
  await updateLatestSnapshotWithQuest(normalized);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listQuestVersionFiles(questId: string): Promise<{ file: string; version: number }[]> {
  await ensureDir();
  const matcher = new RegExp(`^${escapeRegExp(questId)}-v(\\d+)\\.json$`);
  try {
    const files = await readdir(QUESTMASTER_DIR);
    return files
      .map((file) => {
        const match = file.match(matcher);
        if (!match) return null;
        return { file, version: Number(match[1]) };
      })
      .filter((entry): entry is { file: string; version: number } => entry !== null);
  } catch {
    return [];
  }
}

async function readQuestHistoryForId(questId: string): Promise<QuestmasterTask[]> {
  const versionFiles = await listQuestVersionFiles(questId);
  if (versionFiles.length === 0) return [];
  const versions = await Promise.all(
    versionFiles.sort((a, b) => a.version - b.version).map(({ file }) => readQuestAtPath(join(QUESTMASTER_DIR, file))),
  );
  return versions.filter((quest): quest is QuestmasterTask => quest !== null);
}

async function readLatestQuestVersionForId(questId: string): Promise<QuestmasterTask | null> {
  const versionFiles = await listQuestVersionFiles(questId);
  if (versionFiles.length === 0) return null;
  const candidates = versionFiles.sort((a, b) => b.version - a.version);
  for (const { file } of candidates) {
    const quest = await readQuestAtPath(join(QUESTMASTER_DIR, file));
    if (quest) return quest;
  }
  return null;
}

/** Build the next version ID for a questId. */
function nextVersionId(questId: string, currentVersion: number): string {
  return `${questId}-v${currentVersion + 1}`;
}

async function listQuestVersionFilesInDir(dir: string, questId?: string): Promise<QuestVersionFile[]> {
  try {
    const files = await readdir(dir);
    return files
      .map((file) => {
        const match = file.match(/^(q-\d+)-v(\d+)\.json$/);
        if (!match) return null;
        if (questId && match[1] !== questId) return null;
        return {
          file,
          questId: match[1],
          version: Number(match[2]),
        } satisfies QuestVersionFile;
      })
      .filter((entry): entry is QuestVersionFile => entry !== null)
      .sort((a, b) => a.questId.localeCompare(b.questId) || a.version - b.version);
  } catch {
    return [];
  }
}

async function readQuestAtPathWithError(path: string): Promise<{ quest: QuestmasterTask | null; error?: string }> {
  try {
    const raw = await readFile(path, "utf-8");
    return { quest: normalizeQuestOwnership(JSON.parse(raw) as QuestmasterTask) };
  } catch (error) {
    return { quest: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readQuestVersionFromDir(dir: string, id: string): Promise<QuestmasterTask | null> {
  const path = join(dir, `${id}.json`);
  const { quest } = await readQuestAtPathWithError(path);
  return quest;
}

async function readQuestHistoryForIdFromDir(dir: string, questId: string): Promise<QuestmasterTask[]> {
  const versionFiles = await listQuestVersionFilesInDir(dir, questId);
  if (versionFiles.length === 0) return [];
  const versions = await Promise.all(versionFiles.map(({ file }) => readQuestAtPath(join(dir, file))));
  return versions.filter((quest): quest is QuestmasterTask => quest !== null);
}

async function loadLegacyQuestResults(dir: string): Promise<LegacyQuestLoadResult[]> {
  const versionFiles = await listQuestVersionFilesInDir(dir);
  const grouped = new Map<string, QuestVersionFile[]>();
  for (const versionFile of versionFiles) {
    const current = grouped.get(versionFile.questId) ?? [];
    current.push(versionFile);
    grouped.set(versionFile.questId, current);
  }

  const results: LegacyQuestLoadResult[] = [];
  for (const [questId, files] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const readable: QuestmasterTask[] = [];
    const unreadable: { file: string; error: string }[] = [];
    const sortedFiles = [...files].sort((a, b) => a.version - b.version);
    for (const versionFile of sortedFiles) {
      const { quest, error } = await readQuestAtPathWithError(join(dir, versionFile.file));
      if (quest) readable.push(quest);
      else unreadable.push({ file: versionFile.file, error: error ?? "Unknown error" });
    }
    results.push({
      questId,
      files: sortedFiles.map((file) => file.file),
      readable,
      unreadable,
    });
  }
  return results;
}

function buildLiveQuestFromLegacy(result: LegacyQuestLoadResult): QuestmasterTask | null {
  if (result.readable.length === 0) return null;
  const oldest = result.readable[0]!;
  const latest = result.readable[result.readable.length - 1]!;
  const updatedAt = (latest as { updatedAt?: number }).updatedAt;
  return normalizeLiveQuest({
    ...latest,
    id: latest.questId,
    createdAt: oldest.createdAt,
    ...(typeof updatedAt === "number" ? { updatedAt } : {}),
    statusChangedAt: latest.createdAt,
    prevId: undefined,
  });
}

async function readLatestSnapshotStatusAtPath(snapshotPath: string): Promise<{
  count: number;
  error?: string;
  questIds: string[];
  latestVersionByQuestId: Record<string, number>;
  status: QuestStoreMigrationReport["snapshotStatus"];
}> {
  try {
    const raw = await readFile(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      latestVersionByQuestId?: unknown;
      quests?: Array<{ questId?: string; version?: unknown }>;
    };
    if (!Array.isArray(parsed.quests)) {
      return {
        count: 0,
        questIds: [],
        latestVersionByQuestId: {},
        status: "unreadable",
        error: "Snapshot is missing a quests array",
      };
    }
    const questIds: string[] = [];
    const fallbackLatestVersionByQuestId: Record<string, number> = {};
    for (const quest of parsed.quests) {
      if (typeof quest?.questId !== "string") continue;
      questIds.push(quest.questId);
      if (typeof quest.version === "number" && Number.isInteger(quest.version) && quest.version >= 1) {
        fallbackLatestVersionByQuestId[quest.questId] = quest.version;
      }
    }
    const latestVersionByQuestId =
      normalizeLatestVersionByQuestId(parsed.latestVersionByQuestId) ?? fallbackLatestVersionByQuestId;
    return { count: questIds.length, questIds, latestVersionByQuestId, status: "readable" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { count: 0, questIds: [], latestVersionByQuestId: {}, status: "missing" };
    }
    return {
      count: 0,
      questIds: [],
      latestVersionByQuestId: {},
      status: "unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function defaultLegacyBackupDirName(now = new Date()): string {
  const safeIso = now.toISOString().replace(/[:.]/g, "-");
  return join(QUESTMASTER_DIR, `legacy-backup-${safeIso}`);
}

export async function prepareLiveQuestStoreMigration(): Promise<QuestStoreMigrationPreparation> {
  return prepareLiveQuestStoreMigrationForSource({
    legacyDir: QUESTMASTER_DIR,
    preservedLegacyDir: defaultLegacyBackupDirName(),
    snapshotPath: LATEST_SNAPSHOT_FILE,
  });
}

async function prepareLiveQuestStoreMigrationForSource(options: {
  legacyDir: string;
  preservedLegacyDir: string;
  snapshotPath: string;
}): Promise<QuestStoreMigrationPreparation> {
  const legacyResults = await loadLegacyQuestResults(options.legacyDir);
  const liveQuests = legacyResults
    .map((result) => buildLiveQuestFromLegacy(result))
    .filter((quest): quest is QuestmasterTask => quest !== null);
  const snapshot = await readLatestSnapshotStatusAtPath(options.snapshotPath);
  const legacyQuestIds = legacyResults.map((result) => result.questId);
  const legacyLatestReadableVersionByQuestId = Object.fromEntries(
    legacyResults
      .map((result) => {
        const latestReadable = result.readable[result.readable.length - 1];
        return latestReadable ? ([result.questId, latestReadable.version] as const) : null;
      })
      .filter((entry): entry is readonly [string, number] => entry !== null),
  );
  const snapshotMismatchQuestIds = [...new Set([...legacyQuestIds, ...snapshot.questIds])]
    .filter((questId) => {
      const membershipMismatch = legacyQuestIds.includes(questId) !== snapshot.questIds.includes(questId);
      if (membershipMismatch) return true;
      const legacyVersion = legacyLatestReadableVersionByQuestId[questId];
      if (legacyVersion === undefined || !snapshot.questIds.includes(questId)) return false;
      return snapshot.latestVersionByQuestId[questId] !== legacyVersion;
    })
    .sort((a, b) => a.localeCompare(b));
  const unreadableFiles = legacyResults.flatMap((result) =>
    result.unreadable.map((entry) => ({
      file: entry.file,
      questId: result.questId,
      error: entry.error,
    })),
  );
  const blockedQuests = legacyResults
    .filter((result) => result.readable.length === 0)
    .map((result) => ({
      questId: result.questId,
      files: result.files,
      errors: result.unreadable.map((entry) => entry.error),
    }));
  const store = {
    format: "mutable_current_record",
    version: 1,
    quests: sortLatestQuests(liveQuests),
    nextQuestNumber: computeNextQuestNumberFromQuestIds(legacyQuestIds),
    updatedAt: Date.now(),
    legacyBackupDir: options.preservedLegacyDir,
  } satisfies LiveQuestStore;
  const report: QuestStoreMigrationReport = {
    legacyQuestCount: legacyQuestIds.length,
    migratedQuestCount: liveQuests.length,
    snapshotQuestCount: snapshot.count,
    snapshotStatus: snapshot.status,
    ...(snapshot.error ? { snapshotError: snapshot.error } : {}),
    snapshotMismatchQuestIds,
    unreadableFiles,
    blockedQuests,
  };
  return {
    report,
    store,
    backupDir: store.legacyBackupDir!,
    canActivate: blockedQuests.length === 0,
  };
}

function formatQuestIdList(questIds: string[], limit = 10): string {
  if (questIds.length <= limit) return questIds.join(", ");
  return `${questIds.slice(0, limit).join(", ")} (+${questIds.length - limit} more)`;
}

function normalizeBootstrapLiveStore(store: LiveQuestStore, legacyBackupDir: string): LiveQuestStore {
  return normalizeLiveQuestStore({
    ...store,
    legacyBackupDir,
  });
}

export async function bootstrapQuestStore(options?: {
  log?: (message: string) => void;
}): Promise<QuestStoreBootstrapResult> {
  const log = options?.log;
  const preferred = await readLiveQuestStoreAtPath(LIVE_STORE_FILE, ensureLiveDir);
  if (preferred) {
    log?.(`[quest-store] Using preferred live store at ${LIVE_STORE_FILE}`);
    return {
      mode: "preferred_live",
      liveStoreFile: LIVE_STORE_FILE,
      ...(preferred.legacyBackupDir ? { legacyBackupDir: preferred.legacyBackupDir } : {}),
    };
  }

  const legacyLive = await readLiveQuestStoreAtPath(LEGACY_COLOCATED_LIVE_STORE_FILE, ensureDir);
  if (legacyLive) {
    const migrated = normalizeBootstrapLiveStore(legacyLive, QUESTMASTER_DIR);
    await withLiveStoreWriteLock(async () => {
      const current = await readLiveQuestStoreAtPath(LIVE_STORE_FILE, ensureLiveDir);
      if (current) return;
      await writeLiveQuestStore(migrated);
    });
    log?.(
      `[quest-store] Migrated co-located live store from ${LEGACY_COLOCATED_LIVE_STORE_FILE} to ${LIVE_STORE_FILE}; preserving legacy quest directory at ${QUESTMASTER_DIR}`,
    );
    return {
      mode: "migrated_existing_live",
      liveStoreFile: LIVE_STORE_FILE,
      legacyBackupDir: QUESTMASTER_DIR,
    };
  }

  const legacyVersionFilesByQuest = await listQuestVersionFilesByQuest();
  if (legacyVersionFilesByQuest.size === 0) {
    log?.("[quest-store] No quest data found to migrate");
    return { mode: "no_data", liveStoreFile: LIVE_STORE_FILE };
  }

  const prepared = await prepareLiveQuestStoreMigrationForSource({
    legacyDir: QUESTMASTER_DIR,
    preservedLegacyDir: QUESTMASTER_DIR,
    snapshotPath: LATEST_SNAPSHOT_FILE,
  });
  await withLiveStoreWriteLock(async () => {
    const current = await readLiveQuestStoreAtPath(LIVE_STORE_FILE, ensureLiveDir);
    if (current) return;
    await writeLiveQuestStore(prepared.store);
  });

  log?.(
    `[quest-store] Migrated ${prepared.report.migratedQuestCount}/${prepared.report.legacyQuestCount} legacy quests into ${LIVE_STORE_FILE}; preserving legacy quest directory at ${QUESTMASTER_DIR}`,
  );
  if (prepared.report.unreadableFiles.length > 0) {
    log?.(
      `[quest-store] Encountered unreadable legacy quest files during startup migration: ${formatQuestIdList([
        ...new Set(prepared.report.unreadableFiles.map((file) => file.questId)),
      ])}`,
    );
  }
  if (prepared.report.blockedQuests.length > 0) {
    log?.(
      `[quest-store] Skipped unreadable legacy quests during startup migration: ${formatQuestIdList(
        prepared.report.blockedQuests.map((quest) => quest.questId),
      )}`,
    );
  }
  if (prepared.report.snapshotMismatchQuestIds.length > 0) {
    log?.(
      `[quest-store] Legacy snapshot mismatches were advisory during startup migration: ${formatQuestIdList(
        prepared.report.snapshotMismatchQuestIds,
      )}`,
    );
  }
  if (prepared.report.snapshotStatus === "unreadable") {
    log?.(
      `[quest-store] Legacy snapshot was unreadable during startup migration: ${prepared.report.snapshotError ?? "Unknown error"}`,
    );
  }

  return {
    mode: "migrated_legacy",
    liveStoreFile: LIVE_STORE_FILE,
    legacyBackupDir: QUESTMASTER_DIR,
    report: prepared.report,
  };
}

async function getQuestHistoryViewForLegacy(questId: string): Promise<QuestHistoryView> {
  return {
    mode: "live",
    entries: await readQuestHistoryForId(questId),
  };
}

async function getQuestHistoryViewForLiveStore(questId: string, store: LiveQuestStore): Promise<QuestHistoryView> {
  if (!store.legacyBackupDir) {
    return {
      mode: "unavailable",
      entries: [],
      message: "Legacy history is unavailable until the live store is activated with a preserved backup.",
    };
  }

  const entries = await readQuestHistoryForIdFromDir(store.legacyBackupDir, questId);
  return {
    mode: "legacy_backup",
    entries,
    backupDir: store.legacyBackupDir,
    ...(entries.length === 0 ? { message: "No legacy backup history exists for this quest." } : {}),
  };
}

function getLiveQuestById(store: LiveQuestStore, questId: string): QuestmasterTask | null {
  return store.quests.find((quest) => quest.questId === questId) ?? null;
}

function upsertLiveQuest(store: LiveQuestStore, quest: QuestmasterTask): LiveQuestStore {
  const nextQuest = normalizeLiveQuest(quest);
  const quests = sortLatestQuests([
    ...store.quests.filter((existing) => existing.questId !== nextQuest.questId),
    nextQuest,
  ]);
  return {
    ...store,
    quests,
    nextQuestNumber: Math.max(store.nextQuestNumber, computeNextQuestNumber(quests)),
  };
}

function removeLiveQuest(store: LiveQuestStore, questId: string): LiveQuestStore {
  const quests = store.quests.filter((quest) => quest.questId !== questId);
  return {
    ...store,
    quests,
    nextQuestNumber: Math.max(store.nextQuestNumber, computeNextQuestNumber(quests)),
  };
}

function buildCreatedQuest(
  questId: string,
  input: QuestCreateInput,
  liveStore: boolean,
  now = Date.now(),
): QuestmasterTask {
  const status = input.status || "idea";
  const tldr = normalizeTldr(input.tldr);
  const base = {
    id: liveStore ? questId : `${questId}-v1`,
    questId,
    version: 1,
    title: input.title.trim(),
    ...(tldr ? { tldr } : {}),
    createdAt: now,
    ...(liveStore ? { statusChangedAt: now } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
  };

  switch (status) {
    case "idea":
      return liveStore
        ? normalizeLiveQuest({
            ...base,
            status: "idea",
            ...(input.description ? { description: input.description } : {}),
          } as QuestIdea)
        : ({
            ...base,
            status: "idea",
            ...(input.description ? { description: input.description } : {}),
          } as QuestIdea);
    case "refined":
      if (!input.description?.trim()) {
        throw new Error("Description is required for refined status");
      }
      return liveStore
        ? normalizeLiveQuest({
            ...base,
            status: "refined",
            description: input.description,
          } as QuestRefined)
        : ({
            ...base,
            status: "refined",
            description: input.description,
          } as QuestRefined);
    default:
      throw new Error(`Cannot create a quest directly in "${status}" status`);
  }
}

function buildTransitionedQuest(
  current: QuestmasterTask,
  input: QuestTransitionInput,
  options: { liveStore: boolean; now?: number },
): QuestmasterTask {
  const targetStatus = input.status;
  const liveStore = options.liveStore;

  if (
    targetStatus === current.status &&
    !input.description &&
    !input.sessionId &&
    !input.verificationItems &&
    !input.commitShas &&
    !input.notes &&
    !input.cancelled &&
    !(targetStatus === "done" && hasQuestReviewMetadata(current)) &&
    input.tldr === undefined
  ) {
    return current;
  }

  const now = options.now ?? Date.now();
  const newVersion = current.version + 1;
  const tldr = input.tldr !== undefined ? normalizeTldr(input.tldr) : normalizeTldr(current.tldr);
  const currentFeedback = current.feedback;
  const currentActiveSessionId = getActiveSessionId(current);
  const currentPreviousOwners = getPreviousOwnerSessionIds(current);
  const previousOwners = [...currentPreviousOwners];
  const base = {
    id: liveStore ? current.questId : nextVersionId(current.questId, current.version),
    questId: current.questId,
    version: newVersion,
    ...(liveStore ? { statusChangedAt: now, createdAt: current.createdAt } : { prevId: current.id, createdAt: now }),
    ...(liveStore && typeof current.updatedAt === "number" ? { updatedAt: current.updatedAt } : {}),
    title: current.title,
    ...(tldr ? { tldr } : {}),
    ...(current.tags?.length ? { tags: current.tags } : {}),
    ...(current.parentId ? { parentId: current.parentId } : {}),
    ...(current.images?.length ? { images: current.images } : {}),
    ...(current.commitShas?.length ? { commitShas: current.commitShas } : {}),
    ...(previousOwners.length ? { previousOwnerSessionIds: previousOwners } : {}),
    ...(currentFeedback?.length ? { feedback: currentFeedback } : {}),
  };
  if (input.commitShas !== undefined && targetStatus !== "done") {
    throw new Error("commitShas can only be set when completing a quest");
  }
  const inputCommitShas =
    input.commitShas && input.commitShas.length > 0 ? normalizeCommitShas(input.commitShas) : undefined;

  let quest: QuestmasterTask;
  switch (targetStatus) {
    case "idea": {
      if (currentActiveSessionId && !previousOwners.includes(currentActiveSessionId)) {
        previousOwners.push(currentActiveSessionId);
      }
      quest = {
        ...base,
        status: "idea",
        ...(previousOwners.length ? { previousOwnerSessionIds: previousOwners } : {}),
        ...("description" in current && current.description ? { description: current.description } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      } as QuestIdea;
      break;
    }
    case "refined": {
      const description = input.description ?? ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for refined status");
      }
      if (currentActiveSessionId && !previousOwners.includes(currentActiveSessionId)) {
        previousOwners.push(currentActiveSessionId);
      }
      quest = {
        ...base,
        status: "refined",
        description,
        ...(previousOwners.length ? { previousOwnerSessionIds: previousOwners } : {}),
      } as QuestRefined;
      break;
    }
    case "in_progress": {
      const description = input.description ?? ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for in_progress status");
      }
      const sessionId =
        input.sessionId ?? ("sessionId" in current ? (current as QuestInProgress).sessionId : undefined);
      if (!sessionId) {
        throw new Error("sessionId is required for in_progress status");
      }
      if (
        currentActiveSessionId &&
        currentActiveSessionId !== sessionId &&
        !previousOwners.includes(currentActiveSessionId)
      ) {
        previousOwners.push(currentActiveSessionId);
      }
      const nextPreviousOwners = previousOwners.filter((sid) => sid !== sessionId);
      quest = {
        ...base,
        status: "in_progress",
        description,
        sessionId,
        claimedAt: now,
        ...(nextPreviousOwners.length ? { previousOwnerSessionIds: nextPreviousOwners } : {}),
      } as QuestInProgress;
      break;
    }
    case "done": {
      const description = input.description ?? ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for done status");
      }
      const completedOwnerSessionId = currentActiveSessionId ?? input.sessionId;
      if (completedOwnerSessionId && !previousOwners.includes(completedOwnerSessionId)) {
        previousOwners.push(completedOwnerSessionId);
      }
      const rawItems =
        input.verificationItems ??
        ("verificationItems" in current ? (current as QuestDone).verificationItems : undefined);
      const verificationItems = rawItems && rawItems.length > 0 ? normalizeVerificationItems(rawItems) : [];
      quest = {
        ...base,
        status: "done",
        description,
        claimedAt: "claimedAt" in current ? (current as QuestInProgress).claimedAt : now,
        verificationItems,
        ...(previousOwners.length ? { previousOwnerSessionIds: previousOwners } : {}),
        ...(inputCommitShas?.length
          ? { commitShas: normalizeCommitShas([...(current.commitShas ?? []), ...inputCommitShas]) }
          : current.commitShas?.length
            ? { commitShas: current.commitShas }
            : {}),
        completedAt: now,
        ...(input.verificationInboxUnread !== undefined
          ? { verificationInboxUnread: input.verificationInboxUnread }
          : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.cancelled ? { cancelled: true } : {}),
      } as QuestDone;
      break;
    }
    default:
      throw new Error(`Unknown status: ${targetStatus}`);
  }

  return liveStore ? normalizeLiveQuest(quest) : quest;
}

function buildCancelledQuest(current: QuestmasterTask, notes: string | undefined, liveStore: boolean): QuestDone {
  const now = Date.now();
  const description = "description" in current ? current.description : undefined;
  const tldr = normalizeTldr(current.tldr);
  const currentActiveSessionId = getActiveSessionId(current);
  const previousOwners = getPreviousOwnerSessionIds(current);
  if (currentActiveSessionId && !previousOwners.includes(currentActiveSessionId)) {
    previousOwners.push(currentActiveSessionId);
  }
  const cancelFeedback = current.feedback;
  const quest: QuestDone = {
    id: liveStore ? current.questId : nextVersionId(current.questId, current.version),
    questId: current.questId,
    version: current.version + 1,
    ...(liveStore
      ? {
          createdAt: current.createdAt,
          statusChangedAt: now,
          ...(typeof current.updatedAt === "number" ? { updatedAt: current.updatedAt } : {}),
        }
      : {
          prevId: current.id,
          createdAt: now,
        }),
    title: current.title,
    ...(tldr ? { tldr } : {}),
    ...(current.tags?.length ? { tags: current.tags } : {}),
    ...(current.parentId ? { parentId: current.parentId } : {}),
    ...(current.images?.length ? { images: current.images } : {}),
    ...(previousOwners.length ? { previousOwnerSessionIds: previousOwners } : {}),
    ...(current.commitShas?.length ? { commitShas: current.commitShas } : {}),
    status: "done",
    ...(description ? { description } : {}),
    claimedAt: "claimedAt" in current ? (current as QuestInProgress).claimedAt : now,
    verificationItems: "verificationItems" in current ? (current as QuestDone).verificationItems : [],
    completedAt: now,
    cancelled: true,
    ...(notes ? { notes } : {}),
    ...(cancelFeedback?.length ? { feedback: cancelFeedback } : {}),
  } as QuestDone;
  return liveStore ? (normalizeLiveQuest(quest) as QuestDone) : quest;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** List the latest version of every quest. */
export async function listQuests(): Promise<QuestmasterTask[]> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) return liveStore.quests;
  const snapshot = await loadLatestSnapshot();
  return snapshot.quests;
}

/** Get the latest version of a quest by questId. */
export async function getQuest(questId: string): Promise<QuestmasterTask | null> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) return getLiveQuestById(liveStore, questId);
  return readLatestQuestVersionForId(questId);
}

/** Get a specific version by full version id (e.g., "q-1-v3"). */
export async function getQuestVersion(id: string): Promise<QuestmasterTask | null> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    if (!liveStore.legacyBackupDir) return null;
    return readQuestVersionFromDir(liveStore.legacyBackupDir, id);
  }
  return readQuest(id);
}

/** Get all versions of a quest, ordered oldest → newest. */
export async function getQuestHistory(questId: string): Promise<QuestmasterTask[]> {
  return (await getQuestHistoryView(questId)).entries;
}

export async function getQuestHistoryView(questId: string): Promise<QuestHistoryView> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) return getQuestHistoryViewForLiveStore(questId, liveStore);
  return getQuestHistoryViewForLegacy(questId);
}

/** Create a new quest. Returns the initial version. */
export async function createQuest(input: QuestCreateInput): Promise<QuestmasterTask> {
  if (!input.title?.trim()) {
    throw new Error("Quest title is required");
  }
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    return mutateLiveQuestStore(async (store) => {
      const questId = `q-${Math.max(store.nextQuestNumber, computeNextQuestNumber(store.quests))}`;
      const quest = buildCreatedQuest(questId, input, true);
      return {
        store: upsertLiveQuest(
          {
            ...store,
            nextQuestNumber: extractQuestNumber(questId) + 1,
          },
          quest,
        ),
        result: quest,
      };
    });
  }

  return withCreateLock(async () => {
    const questId = await nextQuestId();
    const quest = buildCreatedQuest(questId, input, false);
    await writeQuest(quest);
    return quest;
  });
}

/** Same-stage edit. Mutates the latest version in place, no new version. */
export async function patchQuest(
  questId: string,
  patch: QuestPatchInput,
  options?: { current?: QuestmasterTask | null },
): Promise<QuestmasterTask | null> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    return mutateLiveQuestStore(async (store) => {
      const current =
        options?.current && options.current.questId === questId ? options.current : getLiveQuestById(store, questId);
      if (!current) return { store, result: null };

      const markVerificationInboxUnread = shouldMarkVerificationInboxUnreadFromFeedbackPatch(current, patch.feedback);
      const updated = { ...current, updatedAt: Date.now() } as QuestmasterTask;
      if (patch.title !== undefined) (updated as { title: string }).title = patch.title.trim();
      if (patch.description !== undefined) {
        (updated as { description?: string }).description = patch.description.trim();
      }
      if (patch.tldr !== undefined) {
        const tldr = normalizeTldr(patch.tldr);
        if (tldr) (updated as { tldr?: string }).tldr = tldr;
        else delete (updated as { tldr?: string }).tldr;
      }
      if (patch.tags !== undefined) {
        (updated as { tags?: string[] }).tags = patch.tags;
      }
      if (patch.feedback !== undefined) {
        (updated as { feedback?: QuestFeedbackEntry[] }).feedback =
          patch.feedback.length > 0 ? patch.feedback : undefined;
      }
      if (markVerificationInboxUnread && hasQuestReviewMetadata(updated)) {
        (updated as QuestDone).verificationInboxUnread = true;
      }

      return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
    });
  }

  const current = options?.current && options.current.questId === questId ? options.current : await getQuest(questId);
  if (!current) return null;

  const markVerificationInboxUnread = shouldMarkVerificationInboxUnreadFromFeedbackPatch(current, patch.feedback);
  const updated = { ...current, updatedAt: Date.now() } as QuestmasterTask;
  if (patch.title !== undefined) (updated as { title: string }).title = patch.title.trim();
  if (patch.description !== undefined) {
    (updated as { description?: string }).description = patch.description.trim();
  }
  if (patch.tldr !== undefined) {
    const tldr = normalizeTldr(patch.tldr);
    if (tldr) (updated as { tldr?: string }).tldr = tldr;
    else delete (updated as { tldr?: string }).tldr;
  }
  if (patch.tags !== undefined) {
    (updated as { tags?: string[] }).tags = patch.tags;
  }
  if (patch.feedback !== undefined) {
    (updated as { feedback?: QuestFeedbackEntry[] }).feedback = patch.feedback.length > 0 ? patch.feedback : undefined;
  }
  if (markVerificationInboxUnread && hasQuestReviewMetadata(updated)) {
    (updated as QuestDone).verificationInboxUnread = true;
  }

  await writeQuest(updated);
  return updated;
}

/** Delete a quest and all its versions. */
export async function deleteQuest(questId: string): Promise<boolean> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    return mutateLiveQuestStore(async (store) => {
      const current = getLiveQuestById(store, questId);
      if (!current) return { store, result: false };
      return { store: removeLiveQuest(store, questId), result: true };
    });
  }

  const versions = await getQuestHistory(questId);
  if (versions.length === 0) return false;
  for (const v of versions) {
    try {
      await unlink(filePath(v.id));
    } catch {
      // ok
    }
  }
  await removeQuestFromLatestSnapshot(questId);
  return true;
}

/**
 * Generic status transition. Creates a new version linked to the previous.
 * Carries forward fields from the current version and adds new required fields.
 */
export async function transitionQuest(questId: string, input: QuestTransitionInput): Promise<QuestmasterTask | null> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    return mutateLiveQuestStore(async (store) => {
      const current = getLiveQuestById(store, questId);
      if (!current) return { store, result: null };
      const quest = buildTransitionedQuest(current, input, { liveStore: true });
      return { store: upsertLiveQuest(store, quest), result: quest };
    });
  }

  const current = await getQuest(questId);
  if (!current) return null;
  const quest = buildTransitionedQuest(current, input, { liveStore: false });
  await writeQuest(quest);
  return quest;
}

/**
 * Get the active (in_progress) quest for a session, if any.
 * Returns null if the session has no in_progress quest.
 */
export async function getActiveQuestForSession(sessionId: string): Promise<QuestmasterTask | null> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    return (
      liveStore.quests.find((quest) => quest.status === "in_progress" && getActiveSessionId(quest) === sessionId) ??
      null
    );
  }
  const snapshot = await loadLatestSnapshot();
  const questId = snapshot.activeQuestBySessionId[sessionId];
  if (!questId) return null;
  return snapshot.quests.find((quest) => quest.questId === questId) ?? null;
}

/** Convenience: claim a quest (transition to in_progress). */
export async function claimQuest(
  questId: string,
  sessionId: string,
  options?: {
    allowArchivedOwnerTakeover?: boolean;
    isSessionArchived?: (sessionId: string) => boolean;
  },
): Promise<QuestmasterTask | null> {
  const current = await getQuest(questId);
  if (!current) return null;

  // Already claimed by the same session — idempotent, return as-is
  if (
    current.status === "in_progress" &&
    "sessionId" in current &&
    (current as QuestInProgress).sessionId === sessionId
  ) {
    return current;
  }

  // Claimed by a different session — error
  if (
    current.status === "in_progress" &&
    "sessionId" in current &&
    (current as QuestInProgress).sessionId !== sessionId
  ) {
    const existingSessionId = (current as QuestInProgress).sessionId;
    const ownerArchived = !!options?.isSessionArchived?.(existingSessionId);
    if (options?.allowArchivedOwnerTakeover && ownerArchived) {
      // Archived active owner can be taken over by a live session.
    } else {
      const ownerName = getName(existingSessionId);
      const ownerLabel = ownerName ? `"${ownerName}" (${existingSessionId.slice(0, 8)})` : existingSessionId;
      throw new Error(`Quest ${questId} is already claimed by session ${ownerLabel}`);
    }
  }

  // Enforce one in_progress quest per session: if this session already has
  // another quest in_progress, reject the claim.
  const existing = await getActiveQuestForSession(sessionId);
  if (existing && existing.questId !== questId) {
    throw new Error(
      `Session already has an active quest: ${existing.questId} "${existing.title}". ` +
        `Complete or transition it before claiming another.`,
    );
  }

  return transitionQuest(questId, {
    status: "in_progress",
    sessionId,
  });
}

/** Convenience: complete a quest (mark done and enter the review inbox). */
export async function completeQuest(
  questId: string,
  items: QuestVerificationItem[],
  opts?: { commitShas?: string[]; sessionId?: string },
): Promise<QuestmasterTask | null> {
  return transitionQuest(questId, {
    status: "done",
    verificationItems: items,
    verificationInboxUnread: true,
    ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts?.commitShas?.length ? { commitShas: opts.commitShas } : {}),
  });
}

/** Convenience: mark a quest as done (or cancelled). */
export async function markDone(
  questId: string,
  opts?: { notes?: string; cancelled?: boolean },
): Promise<QuestmasterTask | null> {
  return transitionQuest(questId, {
    status: "done",
    ...(opts?.notes ? { notes: opts.notes } : {}),
    ...(opts?.cancelled ? { cancelled: true } : {}),
  });
}

/**
 * Cancel a quest from any status. Transitions directly to done+cancelled
 * without requiring sessionId or verificationItems.
 */
export async function cancelQuest(questId: string, notes?: string): Promise<QuestmasterTask | null> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    return mutateLiveQuestStore(async (store) => {
      const current = getLiveQuestById(store, questId);
      if (!current) return { store, result: null };
      const quest = buildCancelledQuest(current, notes, true);
      return { store: upsertLiveQuest(store, quest), result: quest };
    });
  }

  const current = await getQuest(questId);
  if (!current) return null;
  const quest = buildCancelledQuest(current, notes, false);
  await writeQuest(quest);
  return quest;
}

/** Toggle a verification item checkbox (in-place, no new version). */
export async function checkVerificationItem(
  questId: string,
  index: number,
  checked: boolean,
): Promise<QuestmasterTask | null> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    return mutateLiveQuestStore(async (store) => {
      const current = getLiveQuestById(store, questId);
      if (!current) return { store, result: null };
      if (!("verificationItems" in current)) {
        throw new Error("Quest does not have verification items");
      }

      const items = [...(current as QuestDone).verificationItems];
      if (index < 0 || index >= items.length) {
        throw new Error(`Verification item index ${index} out of range`);
      }

      items[index] = { ...items[index], checked };
      const updated = {
        ...current,
        verificationItems: items,
        updatedAt: Date.now(),
      } as QuestmasterTask;
      return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
    });
  }

  const current = await getQuest(questId);
  if (!current) return null;

  if (!("verificationItems" in current)) {
    throw new Error("Quest does not have verification items");
  }

  const items = (current as QuestDone).verificationItems;
  if (index < 0 || index >= items.length) {
    throw new Error(`Verification item index ${index} out of range`);
  }

  items[index].checked = checked;
  (current as { updatedAt?: number }).updatedAt = Date.now();
  await writeQuest(current);
  return current;
}

/** Mark a review-pending quest as read so it leaves the review inbox. */
export async function markQuestVerificationRead(questId: string): Promise<QuestmasterTask | null> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    return mutateLiveQuestStore(async (store) => {
      const current = getLiveQuestById(store, questId);
      if (!current) return { store, result: null };
      if (!hasQuestReviewMetadata(current) || !current.verificationInboxUnread) {
        return { store, result: current };
      }

      const updated: QuestDone = {
        ...current,
        verificationInboxUnread: false,
        updatedAt: Date.now(),
      };
      return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
    });
  }

  const current = await getQuest(questId);
  if (!current) return null;
  if (!hasQuestReviewMetadata(current)) return current;
  if (!current.verificationInboxUnread) return current;

  const updated: QuestDone = {
    ...current,
    verificationInboxUnread: false,
    updatedAt: Date.now(),
  };
  await writeQuest(updated);
  return updated;
}

/** Mark a review-pending quest as unread so it returns to the review inbox. */
export async function markQuestVerificationInboxUnread(questId: string): Promise<QuestmasterTask | null> {
  const liveStore = await readLiveQuestStore();
  if (liveStore) {
    return mutateLiveQuestStore(async (store) => {
      const current = getLiveQuestById(store, questId);
      if (!current) return { store, result: null };
      if (!hasQuestReviewMetadata(current) || current.verificationInboxUnread) {
        return { store, result: current };
      }

      const updated: QuestDone = {
        ...current,
        verificationInboxUnread: true,
        updatedAt: Date.now(),
      };
      return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
    });
  }

  const current = await getQuest(questId);
  if (!current) return null;
  if (!hasQuestReviewMetadata(current)) return current;
  if (current.verificationInboxUnread) return current;

  const updated: QuestDone = {
    ...current,
    verificationInboxUnread: true,
    updatedAt: Date.now(),
  };
  await writeQuest(updated);
  return updated;
}

// ─── Image management ────────────────────────────────────────────────────────

/** Save an image to disk and return image metadata. */
export async function saveQuestImage(filename: string, data: Buffer, mimeType: string): Promise<QuestImage> {
  return saveQuestImageFile({ filename, data, mimeType, liveImagesDir: LIVE_IMAGES_DIR, ensureLiveImagesDir });
}

/** Add images to a quest (in-place patch, no new version). */
export async function addQuestImages(questId: string, images: QuestImage[]): Promise<QuestmasterTask | null> {
  return addQuestImagesToStore(questId, images, {
    getLiveQuestById,
    getQuest,
    liveQuestmasterDir: LIVE_QUESTMASTER_DIR,
    mutateLiveQuestStore,
    normalizeLiveQuest,
    readLiveQuestStore,
    upsertLiveQuest,
    writeQuest,
  });
}

/** Remove an image from a quest and delete the file. */
export async function removeQuestImage(questId: string, imageId: string): Promise<QuestmasterTask | null> {
  return removeQuestImageFromStore(questId, imageId, {
    getLiveQuestById,
    getQuest,
    liveQuestmasterDir: LIVE_QUESTMASTER_DIR,
    mutateLiveQuestStore,
    normalizeLiveQuest,
    readLiveQuestStore,
    upsertLiveQuest,
    writeQuest,
  });
}

/** Read an image file from disk. Returns null if not found. */
export async function readQuestImageFile(imageId: string): Promise<{ data: Buffer; mimeType: string } | null> {
  return readQuestImageFileFromDirs(imageId, [LIVE_IMAGES_DIR, IMAGES_DIR]);
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Reset the store directory. Only for tests. */
export async function _resetForTests(): Promise<void> {
  for (const dir of [QUESTMASTER_DIR, LIVE_QUESTMASTER_DIR]) {
    await mkdir(dir, { recursive: true });
    try {
      const files = await readdir(dir);
      for (const file of files) {
        try {
          await rm(join(dir, file), { recursive: true, force: true });
        } catch {
          // ok
        }
      }
    } catch {
      // ok
    }
  }
}
