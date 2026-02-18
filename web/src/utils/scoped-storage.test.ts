// @vitest-environment jsdom

// vi.hoisted runs before any imports, ensuring browser globals are available
// when scoped-storage.ts initializes.
vi.hoisted(() => {
  // Node.js 22+ native localStorage may be broken (invalid --localstorage-file).
  // Polyfill before scoped-storage.ts import triggers localStorage access.
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, String(value));
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
        get length() {
          return store.size;
        },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
});

import {
  scopedKey,
  scopedGetItem,
  scopedSetItem,
  scopedRemoveItem,
  bootstrapServerId,
} from "./scoped-storage.js";

beforeEach(() => {
  localStorage.clear();
});

// ─── scopedKey ───────────────────────────────────────────────────────────────

describe("scopedKey", () => {
  it("returns bare key when no server ID is cached", () => {
    // With empty localStorage, there is no cc-server-id entry,
    // so scopedKey should return the key without any prefix.
    expect(scopedKey("cc-backend")).toBe("cc-backend");
  });

  it("returns prefixed key when server ID is cached", () => {
    // When a server ID is present in localStorage, scoped keys
    // should be prefixed with "{serverId}:" to isolate per-server state.
    localStorage.setItem("cc-server-id", "abc123");
    expect(scopedKey("cc-backend")).toBe("abc123:cc-backend");
  });

  it("never prefixes global keys", () => {
    // Global user preferences (dark mode, zoom, notifications, telemetry)
    // are shared across all servers and must never be prefixed,
    // even when a server ID is cached.
    localStorage.setItem("cc-server-id", "abc123");

    expect(scopedKey("cc-dark-mode")).toBe("cc-dark-mode");
    expect(scopedKey("cc-zoom-level")).toBe("cc-zoom-level");
    expect(scopedKey("cc-notification-sound")).toBe("cc-notification-sound");
    expect(scopedKey("cc-notification-desktop")).toBe(
      "cc-notification-desktop",
    );
    expect(scopedKey("cc-telemetry-enabled")).toBe("cc-telemetry-enabled");
  });
});

// ─── scopedGetItem / scopedSetItem / scopedRemoveItem ────────────────────────

describe("scopedGetItem", () => {
  it("reads from scoped key", () => {
    // When a server ID is cached, scopedGetItem should read from
    // the prefixed key, not the bare key.
    localStorage.setItem("cc-server-id", "abc123");
    localStorage.setItem("abc123:cc-backend", "claude");
    expect(scopedGetItem("cc-backend")).toBe("claude");
  });
});

describe("scopedSetItem", () => {
  it("writes to scoped key", () => {
    // scopedSetItem should write to the prefixed key when a server ID
    // is cached, ensuring per-server isolation.
    localStorage.setItem("cc-server-id", "abc123");
    scopedSetItem("cc-backend", "codex");
    expect(localStorage.getItem("abc123:cc-backend")).toBe("codex");
  });
});

describe("scopedRemoveItem", () => {
  it("removes scoped key", () => {
    // scopedRemoveItem should remove the prefixed key, leaving
    // any un-prefixed key untouched.
    localStorage.setItem("cc-server-id", "abc123");
    localStorage.setItem("abc123:cc-backend", "claude");
    scopedRemoveItem("cc-backend");
    expect(localStorage.getItem("abc123:cc-backend")).toBeNull();
  });
});

// ─── bootstrapServerId ───────────────────────────────────────────────────────

describe("bootstrapServerId", () => {
  it("caches server ID in localStorage", () => {
    // bootstrapServerId should persist the server ID under the
    // well-known "cc-server-id" key for synchronous access on
    // subsequent page loads.
    bootstrapServerId("xyz789");
    expect(localStorage.getItem("cc-server-id")).toBe("xyz789");
  });

  it("returns true on first bootstrap", () => {
    // When no prior server ID exists, bootstrapServerId performs
    // migration and returns true so the caller can reinit store state.
    expect(bootstrapServerId("xyz789")).toBe(true);
  });

  it("returns false when already bootstrapped with same ID", () => {
    // When the same server ID is already cached, no migration is
    // needed and the function returns false.
    bootstrapServerId("xyz789");
    expect(bootstrapServerId("xyz789")).toBe(false);
  });

  it("migrates un-prefixed keys to prefixed copies", () => {
    // On first bootstrap, un-prefixed scoped keys should be copied
    // to their prefixed equivalents. The originals are preserved
    // because other server tabs may still reference them.
    localStorage.setItem("cc-backend", "claude");
    localStorage.setItem("cc-current-session", "sess-42");
    localStorage.setItem("cc-recent-dirs", '["a","b"]');

    bootstrapServerId("srv1");

    // Prefixed copies exist
    expect(localStorage.getItem("srv1:cc-backend")).toBe("claude");
    expect(localStorage.getItem("srv1:cc-current-session")).toBe("sess-42");
    expect(localStorage.getItem("srv1:cc-recent-dirs")).toBe('["a","b"]');

    // Un-prefixed originals still exist (not deleted)
    expect(localStorage.getItem("cc-backend")).toBe("claude");
    expect(localStorage.getItem("cc-current-session")).toBe("sess-42");
    expect(localStorage.getItem("cc-recent-dirs")).toBe('["a","b"]');
  });

  it("migrates dynamic model keys", () => {
    // Dynamic cc-model-{backend} keys should also be migrated
    // so per-server model preferences carry over.
    localStorage.setItem("cc-model-claude", "claude-sonnet-4-5-20250929");
    localStorage.setItem("cc-model-codex", "codex-mini-latest");

    bootstrapServerId("srv1");

    expect(localStorage.getItem("srv1:cc-model-claude")).toBe(
      "claude-sonnet-4-5-20250929",
    );
    expect(localStorage.getItem("srv1:cc-model-codex")).toBe(
      "codex-mini-latest",
    );
  });

  it("migrates companion:last-seq keys", () => {
    // Dynamic companion:last-seq:* keys track the last-seen sequence
    // number per session. These should also be migrated.
    localStorage.setItem("companion:last-seq:sess1", "42");

    bootstrapServerId("srv1");

    expect(localStorage.getItem("srv1:companion:last-seq:sess1")).toBe("42");
  });
});
