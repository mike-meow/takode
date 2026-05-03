// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_OPEN_THREAD_TAB_KEYS,
  MAX_OPEN_THREAD_TAB_STORAGE_CHARS,
  normalizeOpenThreadTabKeys,
  persistOpenThreadTabKeys,
  placeOpenThreadTabKey,
  readOpenThreadTabKeys,
} from "./leader-open-thread-tabs.js";

const SERVER_ID = "test-server";
const SESSION_ID = "s1";
const STORAGE_KEY = `${SERVER_ID}:cc-leader-open-thread-tabs:${SESSION_ID}`;

describe("leader open thread tabs storage", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cc-server-id", SERVER_ID);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("persists and restores compact normalized thread keys with server scoping", () => {
    const persisted = persistOpenThreadTabKeys(SESSION_ID, [" Q-941 ", "main", "all", "q-777", "q-941"]);

    expect(persisted).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('["q-941","q-777"]');
    expect(readOpenThreadTabKeys(SESSION_ID)).toEqual(["q-941", "q-777"]);
  });

  it("dedupes and caps restored tab keys", () => {
    const manyKeys = Array.from({ length: MAX_OPEN_THREAD_TAB_KEYS + 5 }, (_, index) => `q-${index + 1}`);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["q-1", ...manyKeys, "q-2"]));

    expect(readOpenThreadTabKeys(SESSION_ID)).toEqual(manyKeys.slice(0, MAX_OPEN_THREAD_TAB_KEYS));
  });

  it("recovers legacy tab descriptor shapes without restoring full payloads", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { threadKey: " Q-1085 ", title: "Large legacy title", messages: [{ id: "m1", content: "ignored" }] },
          { questId: "q-1086", boardRow: { title: "ignored" } },
          { threadKey: "main" },
          { threadKey: "q-1085" },
        ],
      }),
    );

    expect(readOpenThreadTabKeys(SESSION_ID)).toEqual(["q-1085", "q-1086"]);
  });

  it("treats oversized legacy values as empty so the next compact write can recover the key", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [{ threadKey: "q-1085", payload: "x".repeat(MAX_OPEN_THREAD_TAB_STORAGE_CHARS) }] }),
    );

    expect(readOpenThreadTabKeys(SESSION_ID)).toEqual([]);
    expect(persistOpenThreadTabKeys(SESSION_ID, [])).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("treats corrupt legacy values as empty without throwing through callers", () => {
    localStorage.setItem(STORAGE_KEY, "{not-json");

    expect(() => readOpenThreadTabKeys(SESSION_ID)).not.toThrow();
    expect(readOpenThreadTabKeys(SESSION_ID)).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid leader open thread tabs storage"),
      expect.any(SyntaxError),
    );
  });

  it("does not throw when quota failures reject the open-thread-tabs write", () => {
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(this: Storage, key, value) {
      if (String(key).includes("cc-leader-open-thread-tabs")) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });

    expect(() => persistOpenThreadTabKeys(SESSION_ID, ["q-941"])).not.toThrow();
    expect(persistOpenThreadTabKeys(SESSION_ID, ["q-941"])).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("continuing in memory"),
      expect.any(DOMException),
    );
  });

  it("removes oversized legacy values before retrying a compact write", () => {
    const originalSetItem = Storage.prototype.setItem;
    let shouldRejectFirstOpenTabsWrite = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(this: Storage, key, value) {
      if (String(key).includes("cc-leader-open-thread-tabs") && shouldRejectFirstOpenTabsWrite) {
        shouldRejectFirstOpenTabsWrite = false;
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });

    expect(persistOpenThreadTabKeys(SESSION_ID, ["q-941"])).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('["q-941"]');
  });

  it("keeps tab placement bounded when opening more than the retained maximum", () => {
    const baseline = Array.from({ length: MAX_OPEN_THREAD_TAB_KEYS }, (_, index) => `q-${index + 1}`);
    const next = placeOpenThreadTabKey(baseline, "q-1000", "first");

    expect(next).toHaveLength(MAX_OPEN_THREAD_TAB_KEYS);
    expect(next[0]).toBe("q-1000");
    expect(next).not.toContain("q-20");
  });

  it("normalizes direct arrays without accepting main, all, empty, or duplicate keys", () => {
    expect(normalizeOpenThreadTabKeys(["", "main", "all", " Q-1 ", "q-1", "q-2"])).toEqual(["q-1", "q-2"]);
  });
});
