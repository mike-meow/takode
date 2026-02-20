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

  it("updates and persists pushover settings", () => {
    const updated = updateSettings({ pushoverUserKey: "po-user" });
    expect(updated.pushoverUserKey).toBe("po-user");
    expect(updated.updatedAt).toBeGreaterThan(0);

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.pushoverUserKey).toBe("po-user");
  });

  it("loads existing settings from disk", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        pushoverUserKey: "existing-user",
        pushoverApiToken: "existing-token",
        updatedAt: 123,
      }),
      "utf-8",
    );

    _resetForTest(settingsPath);

    const settings = getSettings();
    expect(settings.pushoverUserKey).toBe("existing-user");
    expect(settings.pushoverApiToken).toBe("existing-token");
    expect(settings.updatedAt).toBe(123);
  });

  it("falls back to defaults for invalid JSON", () => {
    writeFileSync(settingsPath, "not-json", "utf-8");
    _resetForTest(settingsPath);

    expect(getSettings().pushoverEnabled).toBe(true);
  });

  it("ignores undefined patch values without overwriting existing fields", () => {
    updateSettings({ pushoverUserKey: "po-user" });
    const updated = updateSettings({ pushoverApiToken: "po-token" });

    // pushoverUserKey should still be there
    expect(updated.pushoverUserKey).toBe("po-user");
    expect(updated.pushoverApiToken).toBe("po-token");
  });

  it("normalizes malformed file shape to defaults", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        serverName: 123,
        updatedAt: "x",
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    expect(getSettings()).toEqual({
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

  it("preserves legacy openrouter fields in settings file without crashing", () => {
    // Old settings files may still contain openrouter fields; ensure we don't crash
    writeFileSync(
      settingsPath,
      JSON.stringify({
        openrouterApiKey: "old-key",
        openrouterModel: "openrouter/free",
        serverName: "Legacy",
        updatedAt: 100,
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    const settings = getSettings();
    expect(settings.serverName).toBe("Legacy");
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
    const id = getServerId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("getServerId returns the same ID on subsequent calls", () => {
    const first = getServerId();
    const second = getServerId();
    expect(first).toBe(second);
  });

  it("getServerId persists to disk", () => {
    const id = getServerId();
    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.serverId).toBe(id);
  });

  it("getServerId preserves existing serverId from disk", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
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
    const id = getServerId();
    setServerName("New Name");
    expect(getServerId()).toBe(id);
  });
});
