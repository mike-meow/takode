import { scopedGetItem, scopedSetItem } from "./scoped-storage.js";

const RECENT_DIRS_KEY = "cc-recent-dirs";

export function getRecentDirs(): string[] {
  try {
    return JSON.parse(scopedGetItem(RECENT_DIRS_KEY) || "[]");
  } catch {
    return [];
  }
}

export function addRecentDir(dir: string) {
  const dirs = getRecentDirs().filter((d) => d !== dir);
  dirs.unshift(dir);
  scopedSetItem(RECENT_DIRS_KEY, JSON.stringify(dirs.slice(0, 5)));
}
