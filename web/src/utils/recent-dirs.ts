import { scopedGetItem, scopedSetItem } from "./scoped-storage.js";

const RECENT_DIRS_KEY = "cc-recent-dirs";
const GROUP_RECENT_DIRS_KEY = "cc-recent-dirs-groups";
const MAX_RECENT_DIRS = 5;
const MAX_GROUP_RECENT_DIRS = 50;

type StoredGroupRecentDirs = { dirs?: unknown; updatedAt?: number };

function normalizeDirs(candidate: unknown): string[] {
  if (!Array.isArray(candidate)) return [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "string") continue;
    const dir = entry.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
    if (dirs.length >= MAX_RECENT_DIRS) break;
  }
  return dirs;
}

function normalizeGroupKey(groupKey: string | null | undefined): string {
  return groupKey?.trim() ?? "";
}

function parseGroupRecentDirsMap(): Record<string, StoredGroupRecentDirs> {
  try {
    const raw = scopedGetItem(GROUP_RECENT_DIRS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, StoredGroupRecentDirs>;
  } catch {
    return {};
  }
}

export function getRecentDirs(groupKey?: string): string[] {
  const key = normalizeGroupKey(groupKey);
  if (key) {
    return normalizeDirs(parseGroupRecentDirsMap()[key]?.dirs);
  }

  try {
    return normalizeDirs(JSON.parse(scopedGetItem(RECENT_DIRS_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function addRecentDir(dir: string, groupKey?: string) {
  const normalizedDir = dir.trim();
  if (!normalizedDir) return;

  const key = normalizeGroupKey(groupKey);
  const dirs = getRecentDirs(key).filter((d) => d !== normalizedDir);
  dirs.unshift(normalizedDir);

  if (!key) {
    scopedSetItem(RECENT_DIRS_KEY, JSON.stringify(dirs.slice(0, MAX_RECENT_DIRS)));
    return;
  }

  const next = parseGroupRecentDirsMap();
  next[key] = {
    dirs: dirs.slice(0, MAX_RECENT_DIRS),
    updatedAt: Date.now(),
  };

  const entries = Object.entries(next);
  if (entries.length > MAX_GROUP_RECENT_DIRS) {
    entries
      .sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))
      .slice(0, entries.length - MAX_GROUP_RECENT_DIRS)
      .forEach(([staleKey]) => {
        delete next[staleKey];
      });
  }

  scopedSetItem(GROUP_RECENT_DIRS_KEY, JSON.stringify(next));
}
