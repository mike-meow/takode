import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TreeGroup {
  id: string; // "default" for the always-present default group
  name: string;
}

export interface TreeGroupState {
  groups: TreeGroup[]; // display order
  assignments: Record<string, string>; // sessionId -> groupId
  nodeOrder: Record<string, string[]>; // groupId -> ordered root session IDs
}

const DEFAULT_GROUP: TreeGroup = { id: "default", name: "Default" };
const DEFAULT_PATH = join(homedir(), ".companion", "tree-groups.json");

// ─── Module state ────────────────────────────────────────────────────────────

let state: TreeGroupState = { groups: [DEFAULT_GROUP], assignments: {}, nodeOrder: {} };
let loaded = false;
let filePath = DEFAULT_PATH;
let pendingWrite: Promise<void> = Promise.resolve();

// ─── Sanitization ────────────────────────────────────────────────────────────

function sanitizeState(input: unknown): TreeGroupState {
  if (!input || typeof input !== "object") return { groups: [{ ...DEFAULT_GROUP }], assignments: {}, nodeOrder: {} };
  const raw = input as Record<string, unknown>;

  // Sanitize groups
  let groups: TreeGroup[] = [];
  if (Array.isArray(raw.groups)) {
    const seenIds = new Set<string>();
    for (const g of raw.groups) {
      if (!g || typeof g !== "object") continue;
      const gObj = g as Record<string, unknown>;
      const id = typeof gObj.id === "string" ? gObj.id.trim() : "";
      const name = typeof gObj.name === "string" ? gObj.name.trim() : "";
      if (!id || !name || seenIds.has(id)) continue;
      seenIds.add(id);
      groups.push({ id, name });
    }
  }

  // Ensure default group exists
  if (!groups.some((g) => g.id === "default")) {
    groups.unshift({ ...DEFAULT_GROUP });
  }

  // Sanitize assignments: only keep entries pointing to known group IDs
  const validGroupIds = new Set(groups.map((g) => g.id));
  const assignments: Record<string, string> = {};
  if (raw.assignments && typeof raw.assignments === "object") {
    for (const [sessionId, groupId] of Object.entries(raw.assignments as Record<string, unknown>)) {
      if (typeof groupId !== "string") continue;
      const trimId = groupId.trim();
      if (validGroupIds.has(trimId)) {
        assignments[sessionId.trim()] = trimId;
      }
    }
  }

  const nodeOrder = sanitizeNodeOrder(raw.nodeOrder, validGroupIds);

  return { groups, assignments, nodeOrder };
}

function sanitizeNodeOrder(input: unknown, validGroupIds: Set<string>): Record<string, string[]> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [groupId, order] of Object.entries(input as Record<string, unknown>)) {
    if (!validGroupIds.has(groupId) || !Array.isArray(order)) continue;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of order) {
      if (typeof id !== "string") continue;
      const trimmed = id.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        ids.push(trimmed);
      }
    }
    if (ids.length > 0) out[groupId] = ids;
  }
  return out;
}

// ─── Load / Persist ──────────────────────────────────────────────────────────

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await readFile(filePath, "utf-8");
    state = sanitizeState(JSON.parse(raw));
  } catch {
    state = { groups: [{ ...DEFAULT_GROUP }], assignments: {}, nodeOrder: {} };
  }
  loaded = true;
}

function persist(): void {
  const path = filePath;
  const data = JSON.stringify(state, null, 2);
  pendingWrite = pendingWrite
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, "utf-8");
    })
    .catch((err) => { console.error("[tree-group-store] persist failed:", err); });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get the full tree group state. */
export async function getState(): Promise<TreeGroupState> {
  await ensureLoaded();
  const nodeOrderCopy: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(state.nodeOrder)) nodeOrderCopy[k] = [...v];
  return { groups: state.groups.map((g) => ({ ...g })), assignments: { ...state.assignments }, nodeOrder: nodeOrderCopy };
}

/** Replace full state (for reorder/batch operations). */
export async function setState(next: TreeGroupState): Promise<void> {
  await ensureLoaded();
  state = sanitizeState(next);
  persist();
}

/** Create a new named group. Returns the created group. */
export async function createGroup(name: string): Promise<TreeGroup> {
  await ensureLoaded();
  const group: TreeGroup = { id: randomUUID(), name: name.trim() || "Untitled" };
  state.groups.push(group);
  persist();
  return { ...group };
}

/** Rename an existing group. Returns true if found. */
export async function renameGroup(id: string, name: string): Promise<boolean> {
  await ensureLoaded();
  const group = state.groups.find((g) => g.id === id);
  if (!group || id === "default") return false;
  group.name = name.trim() || group.name;
  persist();
  return true;
}

/** Delete a group. Reassigns its members to "default". Returns true if deleted. */
export async function deleteGroup(id: string): Promise<boolean> {
  await ensureLoaded();
  if (id === "default") return false;
  const idx = state.groups.findIndex((g) => g.id === id);
  if (idx === -1) return false;
  state.groups.splice(idx, 1);
  // Reassign members to default
  for (const [sessionId, groupId] of Object.entries(state.assignments)) {
    if (groupId === id) {
      state.assignments[sessionId] = "default";
    }
  }
  persist();
  return true;
}

/** Assign a session to a group. */
export async function assignSession(sessionId: string, groupId: string): Promise<void> {
  await ensureLoaded();
  const exists = state.groups.some((g) => g.id === groupId);
  if (!exists) return;
  state.assignments[sessionId] = groupId;
  persist();
}

/** Remove a session from all assignments (e.g., on archive/delete). */
export async function removeSession(sessionId: string): Promise<void> {
  await ensureLoaded();
  delete state.assignments[sessionId];
  // Also remove from any nodeOrder arrays
  for (const order of Object.values(state.nodeOrder)) {
    const idx = order.indexOf(sessionId);
    if (idx !== -1) order.splice(idx, 1);
  }
  persist();
}

/** Set the root node ordering for a specific group. */
export async function setNodeOrder(groupId: string, orderedIds: string[]): Promise<void> {
  await ensureLoaded();
  if (!state.groups.some((g) => g.id === groupId)) return;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of orderedIds) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  if (normalized.length > 0) {
    state.nodeOrder[groupId] = normalized;
  } else {
    delete state.nodeOrder[groupId];
  }
  persist();
}

/** Get the group ID for a session (or undefined if unassigned). */
export async function getGroupForSession(sessionId: string): Promise<string | undefined> {
  await ensureLoaded();
  return state.assignments[sessionId];
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Wait for pending async writes to complete. Test-only. */
export function _flushForTest(): Promise<void> {
  return pendingWrite;
}

/** Reset internal state and optionally override file path (for tests). */
export function _resetForTest(customPath?: string): void {
  state = { groups: [{ ...DEFAULT_GROUP }], assignments: {}, nodeOrder: {} };
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  pendingWrite = Promise.resolve();
}
