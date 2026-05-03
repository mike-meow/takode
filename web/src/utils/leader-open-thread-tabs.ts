import { scopedGetItem, scopedRemoveItem, scopedSetItem } from "./scoped-storage.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY, normalizeThreadKey } from "./thread-projection.js";

export const MAX_OPEN_THREAD_TAB_KEYS = 20;
export const MAX_OPEN_THREAD_TAB_STORAGE_CHARS = 16 * 1024;

export function openThreadTabsKey(sessionId: string): string {
  return `cc-leader-open-thread-tabs:${sessionId}`;
}

export function shouldPersistOpenThreadTab(threadKey: string): boolean {
  const normalized = normalizeThreadKey(threadKey);
  return normalized !== "" && normalized !== MAIN_THREAD_KEY && normalized !== ALL_THREADS_KEY;
}

export function normalizeOpenThreadTabKeys(threadKeys: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of threadKeys) {
    const rawKey = threadKeyFromLegacyValue(value);
    if (!rawKey) continue;
    const key = normalizeThreadKey(rawKey);
    if (!shouldPersistOpenThreadTab(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
    if (result.length >= MAX_OPEN_THREAD_TAB_KEYS) break;
  }
  return result;
}

export function placeOpenThreadTabKey(
  existingThreadKeys: ReadonlyArray<string>,
  threadKey: string,
  placement: "first" | "last",
): string[] {
  const normalized = normalizeThreadKey(threadKey);
  if (!shouldPersistOpenThreadTab(normalized)) return normalizeOpenThreadTabKeys(existingThreadKeys);
  const withoutTarget = normalizeOpenThreadTabKeys(existingThreadKeys).filter((key) => key !== normalized);
  const nextKeys = placement === "first" ? [normalized, ...withoutTarget] : [...withoutTarget, normalized];
  return normalizeOpenThreadTabKeys(nextKeys);
}

export function readOpenThreadTabKeys(sessionId: string): string[] {
  if (typeof window === "undefined") return [];
  const raw = readStoredOpenThreadTabs(sessionId);
  if (!raw) return [];
  if (raw.length > MAX_OPEN_THREAD_TAB_STORAGE_CHARS) {
    warnOpenThreadTabStorage("Ignoring oversized leader open thread tabs storage.", {
      length: raw.length,
      maxLength: MAX_OPEN_THREAD_TAB_STORAGE_CHARS,
    });
    return [];
  }
  try {
    return normalizeOpenThreadTabKeys(openThreadTabValuesFromParsed(JSON.parse(raw)));
  } catch (error) {
    warnOpenThreadTabStorage("Ignoring invalid leader open thread tabs storage.", error);
    return [];
  }
}

export function persistOpenThreadTabKeys(sessionId: string, threadKeys: ReadonlyArray<string>): boolean {
  if (typeof window === "undefined") return false;
  const storageKey = openThreadTabsKey(sessionId);
  const payload = JSON.stringify(normalizeOpenThreadTabKeys(threadKeys));
  try {
    scopedSetItem(storageKey, payload);
    return true;
  } catch (error) {
    warnOpenThreadTabStorage("Retrying leader open thread tabs storage after write failure.", error);
  }

  try {
    scopedRemoveItem(storageKey);
    scopedSetItem(storageKey, payload);
    return true;
  } catch (error) {
    warnOpenThreadTabStorage("Could not persist leader open thread tabs; continuing in memory.", error);
    return false;
  }
}

function readStoredOpenThreadTabs(sessionId: string): string | null {
  try {
    return scopedGetItem(openThreadTabsKey(sessionId));
  } catch (error) {
    warnOpenThreadTabStorage("Could not read leader open thread tabs storage.", error);
    return null;
  }
}

function openThreadTabValuesFromParsed(parsed: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  for (const key of ["threadKeys", "openThreadTabKeys", "tabs", "openTabs"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function threadKeyFromLegacyValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["threadKey", "questId"]) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function warnOpenThreadTabStorage(message: string, error: unknown): void {
  console.warn(`[takode] ${message}`, error);
}
