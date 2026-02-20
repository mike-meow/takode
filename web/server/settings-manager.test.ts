import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSettings,
  updateSettings,
  getServerName,
  setServerName,
  getServerId,
  _resetForTest,
  DEFAULT_OPENROUTER_MODEL,
} from "./settings-manager.js";

let tempDir: string;
let settingsPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "settings-manager-test-"));
  settingsPath = join(tempDir, "settings.json");
  _resetForTest(settingsPath);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetForTest();
});

describe("settings-manager", () => {
  it("returns defaults when file is missing", () => {
    expect(getSettings()).toEqual({
      openrouterApiKey: "",
      openrouterModel: DEFAULT_OPENROUTER_MODEL,
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverBaseUrl: "",
      updatedAt: 0,
    });
  });

  it("updates and persists settings", () => {
    const updated = updateSettings({ openrouterApiKey: "or-key" });
    expect(updated.openrouterApiKey).toBe("or-key");
    expect(updated.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(updated.updatedAt).toBeGreaterThan(0);

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.openrouterApiKey).toBe("or-key");
    expect(saved.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("loads existing settings from disk", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        openrouterApiKey: "existing",
        openrouterModel: "openai/gpt-4o-mini",
        updatedAt: 123,
      }),
      "utf-8",
    );

    _resetForTest(settingsPath);

    expect(getSettings()).toEqual({
      openrouterApiKey: "existing",
      openrouterModel: "openai/gpt-4o-mini",
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverBaseUrl: "",
      updatedAt: 123,
    });
  });

  it("falls back to defaults for invalid JSON", () => {
    writeFileSync(settingsPath, "not-json", "utf-8");
    _resetForTest(settingsPath);

    expect(getSettings().openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("updates only model while preserving existing key", () => {
    updateSettings({ openrouterApiKey: "or-key" });
    const updated = updateSettings({ openrouterModel: "openai/gpt-4o-mini" });

    expect(updated.openrouterApiKey).toBe("or-key");
    expect(updated.openrouterModel).toBe("openai/gpt-4o-mini");
  });

  it("ignores undefined patch values without overwriting existing fields", () => {
    // Simulates saving Pushover-only fields — openrouterApiKey arrives as undefined
    updateSettings({ openrouterApiKey: "or-key" });
    const updated = updateSettings({ pushoverUserKey: "po-user" } as Parameters<typeof updateSettings>[0]);

    expect(updated.openrouterApiKey).toBe("or-key");
    expect(updated.pushoverUserKey).toBe("po-user");
  });

  it("uses default model when empty model is provided", () => {
    const updated = updateSettings({ openrouterModel: "" });
    expect(updated.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("normalizes malformed file shape to defaults", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        openrouterApiKey: 123,
        openrouterModel: null,
        updatedAt: "x",
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    expect(getSettings()).toEqual({
      openrouterApiKey: "",
      openrouterModel: DEFAULT_OPENROUTER_MODEL,
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverBaseUrl: "",
      updatedAt: 0,
    });
  });
});

describe("server name", () => {
  it("returns empty string by default", () => {
    expect(getServerName()).toBe("");
  });

  it("sets and retrieves server name", () => {
    setServerName("Frontend");
    expect(getServerName()).toBe("Frontend");
  });

  it("persists server name to disk", () => {
    setServerName("Backend");
    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.serverName).toBe("Backend");
  });

  it("clears name when set to empty string", () => {
    setServerName("Frontend");
    expect(getServerName()).toBe("Frontend");

    setServerName("");
    expect(getServerName()).toBe("");
  });

  it("trims whitespace from server name", () => {
    setServerName("  My Server  ");
    expect(getServerName()).toBe("My Server");
  });

  it("loads serverName from existing settings file", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        openrouterApiKey: "",
        openrouterModel: "openrouter/free",
        serverName: "Saved Name",
        updatedAt: 0,
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    expect(getServerName()).toBe("Saved Name");
  });
});

describe("server ID", () => {
  it("getServerId auto-generates a UUID when missing", () => {
    // When no serverId exists in the settings file, getServerId should
    // auto-generate one (a non-empty UUID string) and persist it.
    const id = getServerId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("getServerId returns the same ID on subsequent calls", () => {
    // The server ID is stable — calling getServerId multiple times
    // must always return the same value within a session.
    const first = getServerId();
    const second = getServerId();
    expect(first).toBe(second);
  });

  it("getServerId persists to disk", () => {
    // After auto-generation, the serverId must be written to the
    // settings.json file so it survives server restarts.
    const id = getServerId();
    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.serverId).toBe(id);
  });

  it("getServerId preserves existing serverId from disk", () => {
    // If a settings file already contains a serverId, getServerId
    // should return that value rather than generating a new one.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        openrouterApiKey: "",
        openrouterModel: DEFAULT_OPENROUTER_MODEL,
        serverName: "",
        serverId: "my-custom-server-id",
        updatedAt: 0,
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    expect(getServerId()).toBe("my-custom-server-id");
  });

  it("server name changes do not affect serverId", () => {
    // Updating the server display name must not alter the stable
    // server ID — they are independent fields.
    const id = getServerId();
    setServerName("New Name");
    expect(getServerId()).toBe(id);
  });
});
