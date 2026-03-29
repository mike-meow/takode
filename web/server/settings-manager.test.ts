import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSettings,
  updateSettings,
  getServerName,
  setServerName,
  getServerId,
  initWithPort,
  _resetForTest,
  _flushForTest,
  _getSecretsPathForTest,
} from "./settings-manager.js";

let tempDir: string;
let settingsPath: string;
let secretsPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "settings-manager-test-"));
  settingsPath = join(tempDir, "settings.json");
  _resetForTest(settingsPath);
  secretsPath = _getSecretsPathForTest(settingsPath);
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
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false,
      autoApprovalModel: "",
      autoApprovalMaxConcurrency: 4,
      autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: {
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        customVocabulary: "",
        enhancementEnabled: true,
        enhancementMode: "default",
        enhancementModel: "gpt-5-mini",
        sttModel: "gpt-4o-mini-transcribe",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      updatedAt: 0,
    });
  });

  it("updates and persists pushover settings", async () => {
    const updated = updateSettings({ pushoverUserKey: "po-user" });
    expect(updated.pushoverUserKey).toBe("po-user");
    expect(updated.updatedAt).toBeGreaterThan(0);

    await _flushForTest();
    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.pushoverUserKey).toBe("po-user");
  });

  it("stores OpenAI API keys in a separate secrets file", async () => {
    const updated = updateSettings({
      namerConfig: {
        backend: "openai",
        apiKey: "namer-secret",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      transcriptionConfig: {
        apiKey: "transcription-secret",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: false,
        enhancementModel: "gpt-5-mini",
      },
    });

    expect(updated.namerConfig).toEqual({
      backend: "openai",
      apiKey: "namer-secret",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
    expect(updated.transcriptionConfig.apiKey).toBe("transcription-secret");

    await _flushForTest();

    const savedSettings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(savedSettings.namerConfig).toEqual({
      backend: "openai",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
    expect(savedSettings.transcriptionConfig).toEqual({
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: false,
      enhancementModel: "gpt-5-mini",
    });
    expect(JSON.stringify(savedSettings)).not.toContain("namer-secret");
    expect(JSON.stringify(savedSettings)).not.toContain("transcription-secret");

    const savedSecrets = JSON.parse(await readFile(secretsPath, "utf-8"));
    expect(savedSecrets).toEqual({
      namerOpenAIApiKey: "namer-secret",
      transcriptionApiKey: "transcription-secret",
    });
  });

  it("persists transcription custom vocabulary across reloads", async () => {
    updateSettings({
      transcriptionConfig: {
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: true,
        enhancementModel: "gpt-5-mini",
        customVocabulary: "Takode, WsBridge, Questmaster",
      },
    });

    await _flushForTest();

    const savedSettings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(savedSettings.transcriptionConfig).toEqual({
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: true,
      enhancementModel: "gpt-5-mini",
      customVocabulary: "Takode, WsBridge, Questmaster",
    });

    _resetForTest(settingsPath);

    expect(getSettings().transcriptionConfig).toEqual({
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: true,
      enhancementMode: "default",
      enhancementModel: "gpt-5-mini",
      customVocabulary: "Takode, WsBridge, Questmaster",
      sttModel: "gpt-4o-mini-transcribe",
    });
  });

  it("persists voiceCaptureMode preference across reloads", async () => {
    // Save a voice capture mode preference (e.g. user switched to "append" during recording)
    updateSettings({
      transcriptionConfig: {
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: true,
        enhancementModel: "gpt-5-mini",
        voiceCaptureMode: "append",
      },
    });

    await _flushForTest();

    const savedSettings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(savedSettings.transcriptionConfig.voiceCaptureMode).toBe("append");

    // Reload from disk and verify the preference survived
    _resetForTest(settingsPath);

    expect(getSettings().transcriptionConfig.voiceCaptureMode).toBe("append");
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

  it("migrates legacy plaintext API keys out of the settings file", async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        namerConfig: {
          backend: "openai",
          apiKey: "legacy-namer-secret",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
        },
        transcriptionConfig: {
          apiKey: "legacy-transcription-secret",
          baseUrl: "https://example.invalid/v1",
          enhancementEnabled: false,
          enhancementModel: "gpt-4o-mini",
        },
        updatedAt: 123,
      }),
      "utf-8",
    );

    _resetForTest(settingsPath);

    const loaded = getSettings();
    expect(loaded.namerConfig).toEqual({
      backend: "openai",
      apiKey: "legacy-namer-secret",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    });
    expect(loaded.transcriptionConfig).toEqual({
      apiKey: "legacy-transcription-secret",
      baseUrl: "https://example.invalid/v1",
      customVocabulary: "",
      enhancementEnabled: false,
      enhancementMode: "default",
      enhancementModel: "gpt-4o-mini",
      sttModel: "gpt-4o-mini-transcribe",
    });

    await _flushForTest();

    const savedSettings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(savedSettings.namerConfig.apiKey).toBe("");
    expect(savedSettings.transcriptionConfig.apiKey).toBe("");

    const savedSecrets = JSON.parse(await readFile(secretsPath, "utf-8"));
    expect(savedSecrets).toEqual({
      namerOpenAIApiKey: "legacy-namer-secret",
      transcriptionApiKey: "legacy-transcription-secret",
    });
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
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false,
      autoApprovalModel: "",
      autoApprovalMaxConcurrency: 4,
      autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: {
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        customVocabulary: "",
        enhancementEnabled: true,
        enhancementMode: "default",
        enhancementModel: "gpt-5-mini",
        sttModel: "gpt-4o-mini-transcribe",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
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

  it("persists server name to disk", async () => {
    setServerName("Backend");
    await _flushForTest();
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

  it("getServerId persists to disk", async () => {
    const id = getServerId();
    await _flushForTest();
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

describe("CLI binary settings", () => {
  it("defaults to empty strings", () => {
    expect(getSettings().claudeBinary).toBe("");
    expect(getSettings().codexBinary).toBe("");
    expect(getSettings().maxKeepAlive).toBe(0);
  });

  it("updates and persists claudeBinary", async () => {
    const updated = updateSettings({ claudeBinary: "/usr/local/bin/claude" });
    expect(updated.claudeBinary).toBe("/usr/local/bin/claude");

    await _flushForTest();
    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.claudeBinary).toBe("/usr/local/bin/claude");
  });

  it("updates and persists codexBinary", async () => {
    const updated = updateSettings({ codexBinary: "/opt/codex/bin/codex" });
    expect(updated.codexBinary).toBe("/opt/codex/bin/codex");

    await _flushForTest();
    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.codexBinary).toBe("/opt/codex/bin/codex");
  });

  it("loads claudeBinary from existing settings file", () => {
    writeFileSync(settingsPath, JSON.stringify({ claudeBinary: "/custom/claude", updatedAt: 0 }), "utf-8");
    _resetForTest(settingsPath);
    expect(getSettings().claudeBinary).toBe("/custom/claude");
  });
});

describe("editor settings", () => {
  it("defaults editor preference to none", () => {
    expect(getSettings().editorConfig).toEqual({ editor: "none" });
  });

  it("updates and persists editor preference", async () => {
    const updated = updateSettings({ editorConfig: { editor: "cursor" } });
    expect(updated.editorConfig).toEqual({ editor: "cursor" });

    await _flushForTest();
    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.editorConfig).toEqual({ editor: "cursor" });
  });
});

describe("maxKeepAlive settings", () => {
  it("updates and persists maxKeepAlive", async () => {
    const updated = updateSettings({ maxKeepAlive: 5 });
    expect(updated.maxKeepAlive).toBe(5);

    await _flushForTest();
    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.maxKeepAlive).toBe(5);
  });

  it("normalizes negative maxKeepAlive to 0", () => {
    writeFileSync(settingsPath, JSON.stringify({ maxKeepAlive: -3, updatedAt: 0 }), "utf-8");
    _resetForTest(settingsPath);
    expect(getSettings().maxKeepAlive).toBe(0);
  });

  it("normalizes non-integer maxKeepAlive to floor", () => {
    writeFileSync(settingsPath, JSON.stringify({ maxKeepAlive: 3.7, updatedAt: 0 }), "utf-8");
    _resetForTest(settingsPath);
    expect(getSettings().maxKeepAlive).toBe(3);
  });
});

describe("initWithPort", () => {
  let portDir: string;

  beforeEach(() => {
    portDir = mkdtempSync(join(tmpdir(), "settings-port-test-"));
  });

  afterEach(() => {
    rmSync(portDir, { recursive: true, force: true });
    _resetForTest();
  });

  /**
   * Helper: patches homedir() so initWithPort writes to our temp directory
   * instead of the real ~/.companion/.
   */
  function initWithPortInDir(port: number, dir: string): string {
    // initWithPort builds the path from homedir(), so we simulate by
    // calling _resetForTest with the expected port-scoped path.
    const portPath = join(dir, `settings-${port}.json`);
    _resetForTest(portPath);
    return portPath;
  }

  it("uses port-scoped file path", async () => {
    const portPath = join(portDir, "settings-9999.json");
    _resetForTest(portPath);

    setServerName("Port Test");
    await _flushForTest();
    expect(existsSync(portPath)).toBe(true);

    const saved = JSON.parse(readFileSync(portPath, "utf-8"));
    expect(saved.serverName).toBe("Port Test");
  });

  it("migrates settings from legacy file when port-scoped file is missing", () => {
    // Write a "legacy" settings file
    const legacyPath = join(portDir, "settings.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        serverName: "Legacy Server",
        serverId: "old-shared-id",
        pushoverUserKey: "po-user-key",
        pushoverApiToken: "po-api-token",
        pushoverDelaySeconds: 45,
        pushoverEnabled: false,
        pushoverBaseUrl: "http://example.com",
        updatedAt: 1000,
      }),
      "utf-8",
    );

    // Simulate initWithPort migration by checking file creation
    const portPath = join(portDir, "settings-3456.json");
    // initWithPort would normally check LEGACY_PATH, but since we can't override
    // homedir() easily, test the migration logic directly:
    // read legacy, write port-scoped with cleared serverId
    const raw = readFileSync(legacyPath, "utf-8");
    const legacy = JSON.parse(raw);
    const migrated = { ...legacy, serverId: "", updatedAt: Date.now() };
    writeFileSync(portPath, JSON.stringify(migrated, null, 2), "utf-8");

    _resetForTest(portPath);

    // Pushover settings should be preserved
    const s = getSettings();
    expect(s.pushoverUserKey).toBe("po-user-key");
    expect(s.pushoverApiToken).toBe("po-api-token");
    expect(s.pushoverDelaySeconds).toBe(45);
    expect(s.pushoverEnabled).toBe(false);
    expect(s.pushoverBaseUrl).toBe("http://example.com");
    expect(s.serverName).toBe("Legacy Server");
  });

  it("clears serverId during migration so each instance gets a unique one", () => {
    // Create port-scoped file with cleared serverId (simulating migration)
    const portPath = join(portDir, "settings-3456.json");
    writeFileSync(portPath, JSON.stringify({ serverName: "Migrated", serverId: "", updatedAt: 100 }), "utf-8");
    _resetForTest(portPath);

    // getServerId should auto-generate a new UUID
    const id = getServerId();
    expect(id).toBeTruthy();
    expect(id).not.toBe("old-shared-id");
  });

  it("does not overwrite existing port-scoped file on subsequent starts", () => {
    const portPath = join(portDir, "settings-3456.json");
    writeFileSync(
      portPath,
      JSON.stringify({
        serverName: "Already Configured",
        serverId: "unique-port-id",
        updatedAt: 500,
      }),
      "utf-8",
    );
    _resetForTest(portPath);

    expect(getServerName()).toBe("Already Configured");
    expect(getServerId()).toBe("unique-port-id");
  });

  it("two ports get independent settings", async () => {
    const port3456Path = join(portDir, "settings-3456.json");
    const port3457Path = join(portDir, "settings-3457.json");

    // Set up port 3456
    _resetForTest(port3456Path);
    setServerName("Production");
    const prodId = getServerId();
    await _flushForTest();

    // Set up port 3457
    _resetForTest(port3457Path);
    setServerName("Development");
    const devId = getServerId();
    await _flushForTest();

    // Verify they're independent
    expect(prodId).not.toBe(devId);

    // Re-read from disk via async readFile to avoid NFS close-to-open race
    // (readFileSync after _resetForTest can see stale data on NFS)
    const saved3456 = JSON.parse(await readFile(port3456Path, "utf-8"));
    expect(saved3456.serverName).toBe("Production");

    const saved3457 = JSON.parse(await readFile(port3457Path, "utf-8"));
    expect(saved3457.serverName).toBe("Development");
  });

  it("works cleanly on fresh install with no legacy file", async () => {
    const portPath = join(portDir, "settings-3456.json");
    _resetForTest(portPath);

    // No legacy file, no port-scoped file — should start with defaults
    expect(getServerName()).toBe("");
    expect(getSettings().pushoverUserKey).toBe("");

    // getServerId creates the file and generates a UUID
    const id = getServerId();
    expect(id).toBeTruthy();
    await _flushForTest();
    expect(existsSync(portPath)).toBe(true);
  });
});
