import { mkdirSync } from "node:fs";
import { readdir, readFile, writeFile, unlink, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { extname } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  QuestmasterTask,
  QuestCreateInput,
  QuestPatchInput,
  QuestTransitionInput,
  QuestVerificationItem,
  QuestFeedbackEntry,
  QuestImage,
  QuestIdea,
  QuestRefined,
  QuestInProgress,
  QuestNeedsVerification,
  QuestDone,
} from "./quest-types.js";
import { getName } from "./session-names.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize verification items: accept strings or {text,checked} objects.
 *  Rejects items with empty text. */
function normalizeVerificationItems(items: unknown[]): QuestVerificationItem[] {
  const result: QuestVerificationItem[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) throw new Error("Verification item text must not be empty");
      result.push({ text, checked: false });
    } else if (
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      typeof (item as { text: unknown }).text === "string"
    ) {
      const text = (item as { text: string }).text.trim();
      if (!text) throw new Error("Verification item text must not be empty");
      result.push({
        text,
        checked: !!(item as { checked?: boolean }).checked,
      });
    } else {
      throw new Error("Each verification item must be a string or { text: string, checked?: boolean }");
    }
  }
  return result;
}

/** Normalize stored commit SHAs. */
function normalizeCommitShas(items: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") {
      throw new Error("Each commit SHA must be a string");
    }
    const sha = item.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      throw new Error(`Invalid commit SHA: ${item}`);
    }
    if (seen.has(sha)) continue;
    seen.add(sha);
    result.push(sha);
  }
  return result;
}

function getActiveSessionId(quest: QuestmasterTask): string | undefined {
  if (!("sessionId" in quest) || typeof quest.sessionId !== "string") return undefined;
  const sid = quest.sessionId.trim();
  return sid.length > 0 ? sid : undefined;
}

function getPreviousOwnerSessionIds(quest: QuestmasterTask): string[] {
  const raw = (quest as { previousOwnerSessionIds?: unknown }).previousOwnerSessionIds;
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const sid = v.trim();
    if (!sid) continue;
    unique.add(sid);
  }
  return [...unique];
}

function normalizeQuestOwnership(quest: QuestmasterTask): QuestmasterTask {
  const normalized = { ...quest } as QuestmasterTask & { previousOwnerSessionIds?: string[]; sessionId?: string };
  const previous = getPreviousOwnerSessionIds(normalized);
  const active = getActiveSessionId(normalized);

  // Legacy normalization: done quests used to carry sessionId. Treat it as past owner.
  if (normalized.status === "done" && active) {
    if (!previous.includes(active)) previous.push(active);
    delete normalized.sessionId;
  }

  const finalActive = getActiveSessionId(normalized);
  if (finalActive) {
    const idx = previous.indexOf(finalActive);
    if (idx !== -1) previous.splice(idx, 1);
  }

  if (previous.length > 0) {
    normalized.previousOwnerSessionIds = previous;
  } else {
    delete normalized.previousOwnerSessionIds;
  }
  return normalized;
}

function shouldMarkVerificationInboxUnreadFromFeedbackPatch(
  current: QuestmasterTask,
  nextFeedback: QuestFeedbackEntry[] | undefined,
): boolean {
  if (current.status !== "needs_verification") return false;
  const previous = current.feedback ?? [];
  if (previous.length === 0 && (!nextFeedback || nextFeedback.length === 0)) return false;

  const maxLength = Math.max(previous.length, nextFeedback?.length ?? 0);
  for (let index = 0; index < maxLength; index += 1) {
    const before = previous[index];
    const after = nextFeedback?.[index];
    if (feedbackEntriesEqual(before, after)) continue;
    if (before?.author === "agent" || after?.author === "agent") return true;
  }
  return false;
}

function feedbackEntriesEqual(a: QuestFeedbackEntry | undefined, b: QuestFeedbackEntry | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.author === b.author &&
    a.text === b.text &&
    a.ts === b.ts &&
    a.authorSessionId === b.authorSessionId &&
    a.addressed === b.addressed &&
    questImagesEqual(a.images, b.images)
  );
}

function questImagesEqual(
  a: QuestFeedbackEntry["images"] | undefined,
  b: QuestFeedbackEntry["images"] | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (image, index) =>
      image.id === b[index]?.id &&
      image.filename === b[index]?.filename &&
      image.mimeType === b[index]?.mimeType &&
      image.path === b[index]?.path,
  );
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const QUESTMASTER_DIR = join(homedir(), ".companion", "questmaster");
const IMAGES_DIR = join(QUESTMASTER_DIR, "images");
const COUNTER_FILE = join(QUESTMASTER_DIR, "_quest_counter.json");
const CREATE_LOCK_DIR = join(QUESTMASTER_DIR, "_create.lock");
const CREATE_LOCK_STALE_MS = 30_000;
const CREATE_LOCK_RETRY_MS = 10;

let pendingCreate: Promise<unknown> = Promise.resolve();

// Cold-path: synchronous mkdir at module load is fine
mkdirSync(QUESTMASTER_DIR, { recursive: true });

async function ensureDir(): Promise<void> {
  await mkdir(QUESTMASTER_DIR, { recursive: true });
}

async function ensureImagesDir(): Promise<void> {
  await mkdir(IMAGES_DIR, { recursive: true });
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

async function writeQuest(quest: QuestmasterTask): Promise<void> {
  await ensureDir();
  await writeFile(filePath(quest.id), JSON.stringify(normalizeQuestOwnership(quest), null, 2), "utf-8");
}

/** Read all version files, grouped by questId. */
async function readAllVersions(): Promise<Map<string, QuestmasterTask[]>> {
  await ensureDir();
  const groups = new Map<string, QuestmasterTask[]>();
  try {
    const files = (await readdir(QUESTMASTER_DIR)).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
    for (const file of files) {
      try {
        const raw = await readFile(join(QUESTMASTER_DIR, file), "utf-8");
        const quest = normalizeQuestOwnership(JSON.parse(raw) as QuestmasterTask);
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

// ─── Public API ──────────────────────────────────────────────────────────────

/** List the latest version of every quest. */
export async function listQuests(): Promise<QuestmasterTask[]> {
  const groups = await readAllVersions();
  const result: QuestmasterTask[] = [];
  for (const versions of groups.values()) {
    result.push(latestVersion(versions));
  }
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result;
}

/** Get the latest version of a quest by questId. */
export async function getQuest(questId: string): Promise<QuestmasterTask | null> {
  const groups = await readAllVersions();
  const versions = groups.get(questId);
  if (!versions || versions.length === 0) return null;
  return latestVersion(versions);
}

/** Get a specific version by full version id (e.g., "q-1-v3"). */
export async function getQuestVersion(id: string): Promise<QuestmasterTask | null> {
  return readQuest(id);
}

/** Get all versions of a quest, ordered oldest → newest. */
export async function getQuestHistory(questId: string): Promise<QuestmasterTask[]> {
  const groups = await readAllVersions();
  const versions = groups.get(questId);
  if (!versions) return [];
  return versions.sort((a, b) => a.version - b.version);
}

/** Create a new quest. Returns the initial version. */
export async function createQuest(input: QuestCreateInput): Promise<QuestmasterTask> {
  if (!input.title?.trim()) {
    throw new Error("Quest title is required");
  }

  const status = input.status || "idea";

  return withCreateLock(async () => {
    const questId = await nextQuestId();
    const id = `${questId}-v1`;
    const now = Date.now();
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

    await writeQuest(quest);
    return quest;
  });
}

/** Same-stage edit. Mutates the latest version in place, no new version. */
export async function patchQuest(questId: string, patch: QuestPatchInput): Promise<QuestmasterTask | null> {
  const current = await getQuest(questId);
  if (!current) return null;

  const markVerificationInboxUnread = shouldMarkVerificationInboxUnreadFromFeedbackPatch(current, patch.feedback);
  const updated = { ...current, updatedAt: Date.now() } as QuestmasterTask;
  if (patch.title !== undefined) (updated as { title: string }).title = patch.title.trim();
  if (patch.description !== undefined) {
    (updated as { description?: string }).description = patch.description.trim();
  }
  if (patch.tags !== undefined) {
    (updated as { tags?: string[] }).tags = patch.tags;
  }
  if (patch.feedback !== undefined) {
    (updated as { feedback?: QuestFeedbackEntry[] }).feedback = patch.feedback.length > 0 ? patch.feedback : undefined;
  }
  if (markVerificationInboxUnread && updated.status === "needs_verification") {
    (updated as QuestNeedsVerification).verificationInboxUnread = true;
  }

  await writeQuest(updated);
  return updated;
}

/** Delete a quest and all its versions. */
export async function deleteQuest(questId: string): Promise<boolean> {
  const versions = await getQuestHistory(questId);
  if (versions.length === 0) return false;
  for (const v of versions) {
    try {
      await unlink(filePath(v.id));
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
export async function transitionQuest(questId: string, input: QuestTransitionInput): Promise<QuestmasterTask | null> {
  const current = await getQuest(questId);
  if (!current) return null;

  const targetStatus = input.status;

  // Guard against no-op transitions (same status with no new fields)
  if (
    targetStatus === current.status &&
    !input.description &&
    !input.sessionId &&
    !input.verificationItems &&
    !input.commitShas &&
    !input.notes &&
    !input.cancelled
  ) {
    return current;
  }
  const now = Date.now();
  const newVersion = current.version + 1;
  const newId = nextVersionId(questId, current.version);

  // Feedback is versioned quest history and should survive every status transition.
  const currentFeedback = current.feedback;
  const currentActiveSessionId = getActiveSessionId(current);
  const currentPreviousOwners = getPreviousOwnerSessionIds(current);
  const previousOwners = [...currentPreviousOwners];

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
    ...(previousOwners.length ? { previousOwnerSessionIds: previousOwners } : {}),
    ...(currentFeedback?.length ? { feedback: currentFeedback } : {}),
  };
  if (input.commitShas !== undefined && targetStatus !== "needs_verification") {
    throw new Error("commitShas can only be set when transitioning to needs_verification");
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

    case "needs_verification": {
      const description = input.description ?? ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for needs_verification status");
      }
      const sessionId =
        input.sessionId ?? ("sessionId" in current ? (current as QuestInProgress).sessionId : undefined);
      if (!sessionId) {
        throw new Error("sessionId is required for needs_verification status");
      }
      if (
        currentActiveSessionId &&
        currentActiveSessionId !== sessionId &&
        !previousOwners.includes(currentActiveSessionId)
      ) {
        previousOwners.push(currentActiveSessionId);
      }
      const nextPreviousOwners = previousOwners.filter((sid) => sid !== sessionId);
      const rawItems =
        input.verificationItems ??
        ("verificationItems" in current ? (current as QuestNeedsVerification).verificationItems : undefined);
      // Empty items is allowed — quest done will auto-pass with nothing to verify
      const verificationItems = rawItems && rawItems.length > 0 ? normalizeVerificationItems(rawItems) : [];
      quest = {
        ...base,
        status: "needs_verification",
        description,
        sessionId,
        claimedAt: "claimedAt" in current ? (current as QuestInProgress).claimedAt : now,
        verificationItems,
        verificationInboxUnread: true,
        ...(nextPreviousOwners.length ? { previousOwnerSessionIds: nextPreviousOwners } : {}),
        ...(inputCommitShas?.length ? { commitShas: inputCommitShas } : {}),
      } as QuestNeedsVerification;
      break;
    }

    case "done": {
      const description = input.description ?? ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for done status");
      }
      if (currentActiveSessionId && !previousOwners.includes(currentActiveSessionId)) {
        previousOwners.push(currentActiveSessionId);
      }
      const rawItems =
        input.verificationItems ??
        ("verificationItems" in current ? (current as QuestNeedsVerification).verificationItems : undefined);
      const verificationItems = rawItems && rawItems.length > 0 ? normalizeVerificationItems(rawItems) : [];
      // Empty items = auto-pass (nothing to verify)
      quest = {
        ...base,
        status: "done",
        description,
        claimedAt: "claimedAt" in current ? (current as QuestInProgress).claimedAt : now,
        verificationItems: verificationItems ?? [],
        ...(previousOwners.length ? { previousOwnerSessionIds: previousOwners } : {}),
        ...(current.commitShas?.length ? { commitShas: current.commitShas } : {}),
        completedAt: now,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.cancelled ? { cancelled: true } : {}),
      } as QuestDone;
      break;
    }

    default:
      throw new Error(`Unknown status: ${targetStatus}`);
  }

  await writeQuest(quest);
  return quest;
}

/**
 * Get the active (in_progress) quest for a session, if any.
 * Returns null if the session has no in_progress quest.
 */
export async function getActiveQuestForSession(sessionId: string): Promise<QuestmasterTask | null> {
  const all = await listQuests();
  return (
    all.find((q) => q.status === "in_progress" && "sessionId" in q && (q as QuestInProgress).sessionId === sessionId) ??
    null
  );
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

/** Convenience: complete a quest (transition to needs_verification). */
export async function completeQuest(
  questId: string,
  items: QuestVerificationItem[],
  opts?: { commitShas?: string[] },
): Promise<QuestmasterTask | null> {
  return transitionQuest(questId, {
    status: "needs_verification",
    verificationItems: items,
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
  const current = await getQuest(questId);
  if (!current) return null;

  const now = Date.now();
  const newVersion = current.version + 1;
  const newId = nextVersionId(questId, current.version);

  const description = "description" in current ? current.description : undefined;
  const currentActiveSessionId = getActiveSessionId(current);
  const previousOwners = getPreviousOwnerSessionIds(current);
  if (currentActiveSessionId && !previousOwners.includes(currentActiveSessionId)) {
    previousOwners.push(currentActiveSessionId);
  }

  const cancelFeedback = current.feedback;
  const quest: QuestDone = {
    id: newId,
    questId,
    version: newVersion,
    prevId: current.id,
    title: current.title,
    createdAt: now,
    ...(current.tags?.length ? { tags: current.tags } : {}),
    ...(current.parentId ? { parentId: current.parentId } : {}),
    ...(current.images?.length ? { images: current.images } : {}),
    ...(previousOwners.length ? { previousOwnerSessionIds: previousOwners } : {}),
    ...(current.commitShas?.length ? { commitShas: current.commitShas } : {}),
    status: "done",
    ...(description ? { description } : {}),
    claimedAt: "claimedAt" in current ? (current as QuestInProgress).claimedAt : now,
    // Carry forward verificationItems if present, use empty array otherwise
    verificationItems: "verificationItems" in current ? (current as QuestNeedsVerification).verificationItems : [],
    completedAt: now,
    cancelled: true,
    ...(notes ? { notes } : {}),
    ...(cancelFeedback?.length ? { feedback: cancelFeedback } : {}),
  } as QuestDone;

  await writeQuest(quest);
  return quest;
}

/** Toggle a verification item checkbox (in-place, no new version). */
export async function checkVerificationItem(
  questId: string,
  index: number,
  checked: boolean,
): Promise<QuestmasterTask | null> {
  const current = await getQuest(questId);
  if (!current) return null;

  if (!("verificationItems" in current)) {
    throw new Error("Quest does not have verification items");
  }

  const items = (current as QuestNeedsVerification).verificationItems;
  if (index < 0 || index >= items.length) {
    throw new Error(`Verification item index ${index} out of range`);
  }

  items[index].checked = checked;
  (current as { updatedAt?: number }).updatedAt = Date.now();
  await writeQuest(current);
  return current;
}

/** Mark a verification quest as read so it leaves the verification inbox. */
export async function markQuestVerificationRead(questId: string): Promise<QuestmasterTask | null> {
  const current = await getQuest(questId);
  if (!current) return null;
  if (current.status !== "needs_verification") return current;
  if (!current.verificationInboxUnread) return current;

  const updated: QuestNeedsVerification = {
    ...current,
    verificationInboxUnread: false,
    updatedAt: Date.now(),
  };
  await writeQuest(updated);
  return updated;
}

/** Mark a verification quest as unread so it returns to the verification inbox. */
export async function markQuestVerificationInboxUnread(questId: string): Promise<QuestmasterTask | null> {
  const current = await getQuest(questId);
  if (!current) return null;
  if (current.status !== "needs_verification") return current;
  if (current.verificationInboxUnread) return current;

  const updated: QuestNeedsVerification = {
    ...current,
    verificationInboxUnread: true,
    updatedAt: Date.now(),
  };
  await writeQuest(updated);
  return updated;
}

// ─── Image management ────────────────────────────────────────────────────────

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

/** Save an image to disk and return image metadata. */
export async function saveQuestImage(filename: string, data: Buffer, mimeType: string): Promise<QuestImage> {
  await ensureImagesDir();
  const id = randomBytes(8).toString("hex");
  const ext = QUEST_MIME_TO_EXT[mimeType] || extname(filename) || ".bin";
  const diskName = `${id}${ext}`;
  const diskPath = join(IMAGES_DIR, diskName);
  const { resizeForStore } = await import("./image-store.js");
  const finalData = await resizeForStore(data, mimeType);
  await writeFile(diskPath, finalData);
  return { id, filename, mimeType, path: diskPath };
}

/** Add images to a quest (in-place patch, no new version). */
export async function addQuestImages(questId: string, images: QuestImage[]): Promise<QuestmasterTask | null> {
  const current = await getQuest(questId);
  if (!current) return null;

  const existing = current.images ?? [];
  (current as { images: QuestImage[] }).images = [...existing, ...images];
  (current as { updatedAt?: number }).updatedAt = Date.now();
  await writeQuest(current);
  return current;
}

/** Remove an image from a quest and delete the file. */
export async function removeQuestImage(questId: string, imageId: string): Promise<QuestmasterTask | null> {
  const current = await getQuest(questId);
  if (!current) return null;
  if (!current.images?.length) return current;

  const image = current.images.find((img) => img.id === imageId);
  (current as { images: QuestImage[] }).images = current.images.filter((img) => img.id !== imageId);
  (current as { updatedAt?: number }).updatedAt = Date.now();
  await writeQuest(current);

  // Delete the file
  if (image) {
    try {
      await unlink(image.path);
    } catch {
      // File may already be deleted
    }
  }

  return current;
}

/** Read an image file from disk. Returns null if not found. */
export async function readQuestImageFile(imageId: string): Promise<{ data: Buffer; mimeType: string } | null> {
  await ensureImagesDir();
  try {
    const files = await readdir(IMAGES_DIR);
    const file = files.find((f) => f.startsWith(imageId));
    if (!file) return null;
    const fullPath = join(IMAGES_DIR, file);
    const data = (await readFile(fullPath)) as Buffer;
    // Derive MIME from extension
    const ext = extname(file).toLowerCase();
    const mimeType = Object.entries(QUEST_MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
    return { data, mimeType };
  } catch {
    return null;
  }
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Reset the store directory. Only for tests. */
export async function _resetForTests(): Promise<void> {
  await ensureDir();
  try {
    const files = await readdir(QUESTMASTER_DIR);
    for (const file of files) {
      try {
        await unlink(join(QUESTMASTER_DIR, file));
      } catch {
        // ok
      }
    }
  } catch {
    // ok
  }
}
