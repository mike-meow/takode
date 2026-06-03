import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "./constants.js";
import { normalizeMemorySessionSpaceSlug } from "./memory-session-space.js";
import { getServerId } from "./settings-manager.js";

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

export interface SessionTreeGroupSnapshot {
  sessionId: string;
  treeGroupId?: string | null;
  memorySessionSpaceSlug?: string | null;
}

export interface ReconcileSessionTreeGroupsResult {
  changed: boolean;
  importedLegacyGroups: string[];
  importedLegacyAssignments: string[];
  resolvedGroups: Record<string, string>;
  conflicts: Array<{
    sessionId: string;
    metadataGroup?: string;
    scopedAssignment?: string;
    legacyAssignment?: string;
    memorySessionSpaceSlug?: string;
    matchingMemoryGroupId?: string;
    nodeOrderGroupIds: string[];
    resolvedGroup: string;
    action: "auto_reconciled_stale_default" | "preserved_divergence";
    reason: string;
  }>;
  sessionMetadataUpdates: Array<{
    sessionId: string;
    treeGroupId: string;
    source: "metadata" | "scoped_assignment" | "legacy_assignment" | "default" | "stale_default_conflict";
  }>;
}

const DEFAULT_GROUP: TreeGroup = { id: "default", name: "Default" };
const LEGACY_PATH = join(homedir(), ".companion", "tree-groups.json");
const DEFAULT_SCOPED_DIR = join(homedir(), ".companion", "tree-groups");

// ─── Module state ────────────────────────────────────────────────────────────

let state: TreeGroupState = { groups: [DEFAULT_GROUP], assignments: {}, nodeOrder: {} };
let loaded = false;
let explicitFilePath: string | undefined;
let scopedDir = DEFAULT_SCOPED_DIR;
let legacyPath = LEGACY_PATH;
let configuredServerId: string | undefined;
let configuredPort: number | undefined;
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

function normalizeSessionGroupId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cloneState(input: TreeGroupState): TreeGroupState {
  const nodeOrder: Record<string, string[]> = {};
  for (const [groupId, order] of Object.entries(input.nodeOrder)) {
    nodeOrder[groupId] = [...order];
  }
  return {
    groups: input.groups.map((group) => ({ ...group })),
    assignments: { ...input.assignments },
    nodeOrder,
  };
}

function removeSessionFromOtherNodeOrders(treeState: TreeGroupState, sessionId: string, assignedGroupId: string): void {
  for (const [groupId, order] of Object.entries(treeState.nodeOrder)) {
    if (groupId === assignedGroupId) continue;
    const filtered = order.filter((id) => id !== sessionId);
    if (filtered.length > 0) {
      treeState.nodeOrder[groupId] = filtered;
    } else {
      delete treeState.nodeOrder[groupId];
    }
  }
}

function nodeOrderGroupIdsForSession(treeState: TreeGroupState, sessionId: string): string[] {
  return Object.entries(treeState.nodeOrder)
    .filter(([, order]) => order.includes(sessionId))
    .map(([groupId]) => groupId);
}

function findSingleNonDefaultGroupForMemorySlug(
  groups: TreeGroup[],
  memorySessionSpaceSlug: string | null | undefined,
): TreeGroup | undefined {
  const rawSlug = memorySessionSpaceSlug?.trim();
  if (!rawSlug) return undefined;
  const normalizedSlug = normalizeMemorySessionSpaceSlug(rawSlug);
  const matches = groups.filter(
    (group) => group.id !== "default" && normalizeMemorySessionSpaceSlug(group.name) === normalizedSlug,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function findFirstNonDefaultGroupForMemorySlug(
  groups: TreeGroup[],
  memorySessionSpaceSlug: string | null | undefined,
): TreeGroup | undefined {
  const rawSlug = memorySessionSpaceSlug?.trim();
  if (!rawSlug) return undefined;
  const normalizedSlug = normalizeMemorySessionSpaceSlug(rawSlug);
  return groups.find(
    (group) => group.id !== "default" && normalizeMemorySessionSpaceSlug(group.name) === normalizedSlug,
  );
}

// ─── Load / Persist ──────────────────────────────────────────────────────────

function sanitizeServerIdForPath(serverId: string): string {
  return serverId.trim().replace(/[^a-zA-Z0-9_.-]/g, "_") || "local";
}

function currentPort(): number {
  if (configuredPort !== undefined) return configuredPort;
  const envPort = Number(process.env.PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
}

function currentServerId(): string {
  return configuredServerId || getServerId();
}

function currentFilePath(): string {
  if (explicitFilePath) return explicitFilePath;
  return join(scopedDir, `${sanitizeServerIdForPath(currentServerId())}.json`);
}

function shouldUseLegacyFallback(): boolean {
  return !explicitFilePath && currentPort() === DEFAULT_PORT_PROD;
}

async function readStateFromPath(path: string): Promise<TreeGroupState | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return sanitizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  const scoped = await readStateFromPath(currentFilePath());
  if (scoped) {
    state = scoped;
    loaded = true;
    return;
  }
  if (shouldUseLegacyFallback()) {
    const legacy = await readStateFromPath(legacyPath);
    if (legacy) {
      state = legacy;
      loaded = true;
      return;
    }
  }
  state = { groups: [{ ...DEFAULT_GROUP }], assignments: {}, nodeOrder: {} };
  loaded = true;
}

function persist(): void {
  const path = currentFilePath();
  const data = JSON.stringify(state, null, 2);
  pendingWrite = pendingWrite
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, "utf-8");
    })
    .catch((err) => {
      console.error("[tree-group-store] persist failed:", err);
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Get the full tree group state. */
export async function getState(): Promise<TreeGroupState> {
  await ensureLoaded();
  return cloneState(state);
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

/**
 * Resolve a portable memory/session-space slug to a local authoritative tree
 * group. Used when another Takode server sends a group id that is local to its
 * own tree-group store but also sends the portable Session Space name.
 */
export async function ensureGroupForMemorySessionSpaceSlug(slug: string): Promise<TreeGroup | undefined> {
  await ensureLoaded();
  const normalizedSlug = normalizeMemorySessionSpaceSlug(slug);
  const existing = findFirstNonDefaultGroupForMemorySlug(state.groups, normalizedSlug);
  if (existing) return { ...existing };
  const group: TreeGroup = { id: randomUUID(), name: normalizedSlug };
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
  removeSessionFromOtherNodeOrders(state, sessionId, groupId);
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

export async function reconcileSessionTreeGroups(
  sessions: SessionTreeGroupSnapshot[],
): Promise<ReconcileSessionTreeGroupsResult> {
  await ensureLoaded();

  const scopedState = cloneState(state);
  const nextState = cloneState(state);
  const legacyState = await readStateFromPath(legacyPath);
  const nextGroupIds = new Set(nextState.groups.map((group) => group.id));
  const legacyGroups = new Map((legacyState?.groups ?? []).map((group) => [group.id, group]));
  const localSessionIds = new Set(
    sessions.map((candidate) => candidate.sessionId.trim()).filter((sessionId) => sessionId.length > 0),
  );
  const processedSessionIds = new Set<string>();
  const importedLegacyGroups = new Set<string>();
  const importedLegacyAssignments = new Set<string>();
  const resolvedGroups: Record<string, string> = {};
  const conflicts: ReconcileSessionTreeGroupsResult["conflicts"] = [];
  const sessionMetadataUpdates: ReconcileSessionTreeGroupsResult["sessionMetadataUpdates"] = [];

  const ensureGroupExists = (groupId: string): boolean => {
    if (nextGroupIds.has(groupId)) return true;
    const legacyGroup = legacyGroups.get(groupId);
    if (!legacyGroup) return false;
    nextState.groups.push({ ...legacyGroup });
    nextGroupIds.add(groupId);
    importedLegacyGroups.add(groupId);
    return true;
  };

  for (const candidate of sessions) {
    const sessionId = candidate.sessionId.trim();
    if (!sessionId || processedSessionIds.has(sessionId)) continue;
    processedSessionIds.add(sessionId);

    const metadataGroup = normalizeSessionGroupId(candidate.treeGroupId);
    const scopedAssignment = normalizeSessionGroupId(scopedState.assignments[sessionId]);
    const legacyAssignment = normalizeSessionGroupId(legacyState?.assignments[sessionId]);
    const rawMemorySlug = candidate.memorySessionSpaceSlug?.trim();
    const memorySessionSpaceSlug = rawMemorySlug ? normalizeMemorySessionSpaceSlug(rawMemorySlug) : undefined;
    const matchingMemoryGroup = findSingleNonDefaultGroupForMemorySlug(nextState.groups, rawMemorySlug);
    const nodeOrderGroupIds = nodeOrderGroupIdsForSession(scopedState, sessionId);
    const defaultEvidence = metadataGroup === "default" || scopedAssignment === "default";
    let resolvedGroup = metadataGroup;
    let source: ReconcileSessionTreeGroupsResult["sessionMetadataUpdates"][number]["source"] = "metadata";

    if (defaultEvidence && matchingMemoryGroup) {
      if (nodeOrderGroupIds.includes(matchingMemoryGroup.id)) {
        resolvedGroup = matchingMemoryGroup.id;
        source = "stale_default_conflict";
        conflicts.push({
          sessionId,
          metadataGroup,
          scopedAssignment,
          legacyAssignment,
          memorySessionSpaceSlug,
          matchingMemoryGroupId: matchingMemoryGroup.id,
          nodeOrderGroupIds,
          resolvedGroup,
          action: "auto_reconciled_stale_default",
          reason: "default_tree_location_conflicts_with_matching_memory_slug_and_node_order",
        });
      } else if ((metadataGroup === "default" || scopedAssignment === "default") && memorySessionSpaceSlug) {
        conflicts.push({
          sessionId,
          metadataGroup,
          scopedAssignment,
          legacyAssignment,
          memorySessionSpaceSlug,
          matchingMemoryGroupId: matchingMemoryGroup.id,
          nodeOrderGroupIds,
          resolvedGroup: resolvedGroup || "default",
          action: "preserved_divergence",
          reason: "default_tree_location_conflicts_with_memory_slug_without_node_order_evidence",
        });
      }
    }

    if (!resolvedGroup) {
      if (scopedAssignment) {
        resolvedGroup = scopedAssignment;
        source = "scoped_assignment";
      } else if (legacyAssignment) {
        resolvedGroup = legacyAssignment;
        source = "legacy_assignment";
      } else {
        resolvedGroup = "default";
        source = "default";
      }
    }

    if (!ensureGroupExists(resolvedGroup)) {
      resolvedGroup = "default";
      source = "default";
    }

    resolvedGroups[sessionId] = resolvedGroup;
    if (source === "legacy_assignment") {
      importedLegacyAssignments.add(sessionId);
      const legacyOrder = legacyState?.nodeOrder[resolvedGroup];
      if (legacyOrder && !nextState.nodeOrder[resolvedGroup]) {
        const filtered = legacyOrder.filter((id) => localSessionIds.has(id));
        if (filtered.length > 0) nextState.nodeOrder[resolvedGroup] = filtered;
      }
    }

    nextState.assignments[sessionId] = resolvedGroup;
    removeSessionFromOtherNodeOrders(nextState, sessionId, resolvedGroup);
    if (metadataGroup !== resolvedGroup) {
      sessionMetadataUpdates.push({ sessionId, treeGroupId: resolvedGroup, source });
    }
  }

  const sanitizedNextState = sanitizeState(nextState);
  const changed = JSON.stringify(scopedState) !== JSON.stringify(sanitizedNextState);
  if (changed) {
    state = sanitizedNextState;
    persist();
  }

  return {
    changed,
    importedLegacyGroups: [...importedLegacyGroups],
    importedLegacyAssignments: [...importedLegacyAssignments],
    resolvedGroups,
    conflicts,
    sessionMetadataUpdates,
  };
}

export function initTreeGroupStoreForServer(options: { serverId: string; port: number }): void {
  configuredServerId = options.serverId;
  configuredPort = options.port;
  explicitFilePath = undefined;
  loaded = false;
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Wait for pending async writes to complete. Test-only. */
export function _flushForTest(): Promise<void> {
  return pendingWrite;
}

/** Reset internal state and optionally override file path (for tests). */
export function _resetForTest(
  customPath?: string,
  options?: { serverId?: string; port?: number; scopedDir?: string; legacyPath?: string },
): void {
  state = { groups: [{ ...DEFAULT_GROUP }], assignments: {}, nodeOrder: {} };
  loaded = false;
  explicitFilePath = customPath;
  configuredServerId = options?.serverId;
  configuredPort = options?.port;
  scopedDir = options?.scopedDir || DEFAULT_SCOPED_DIR;
  legacyPath = options?.legacyPath || LEGACY_PATH;
  pendingWrite = Promise.resolve();
}
