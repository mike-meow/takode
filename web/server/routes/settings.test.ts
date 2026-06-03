import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { _flushForTest, _resetForTest, getSettings } from "../settings-manager.js";
import { createSettingsRoutes } from "./settings.js";

let tempDir: string;

function createApp(): Hono {
  const app = new Hono();
  app.route(
    "/api",
    createSettingsRoutes({
      launcher: {
        listSessions: vi.fn(() => []),
        setServerSlug: vi.fn(),
      },
      wsBridge: {},
      sessionStore: { directory: tempDir },
      options: {},
      pushoverNotifier: undefined,
    } as any),
  );
  return app;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "settings-route-test-"));
  _resetForTest(join(tempDir, "settings.json"));
});

afterEach(async () => {
  await _flushForTest();
  await rm(tempDir, { recursive: true, force: true });
  _resetForTest();
});

describe("settings routes", () => {
  it("accepts worker concurrency settings above the legacy five-worker default", async () => {
    // q-122 requires the server setting to support at least ten workers so
    // leaders can raise capacity without code changes.
    const app = createApp();

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ takodeWorkerConcurrency: 10 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.takodeWorkerConcurrency).toBe(10);
    expect(getSettings().takodeWorkerConcurrency).toBe(10);
  });

  it("rejects invalid worker concurrency settings", async () => {
    // Rejecting invalid settings at the API boundary keeps CLI and prompt
    // consumers from seeing divergent normalized values.
    const app = createApp();

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ takodeWorkerConcurrency: 0 }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "takodeWorkerConcurrency must be an integer between 1 and 50",
    });
  });

  it("accepts shortcut-only settings updates", async () => {
    const app = createApp();
    const shortcutSettings = {
      enabled: true,
      preset: "standard",
      overrides: { search_session: "Ctrl+Shift+F" },
    };

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcutSettings }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shortcutSettings).toEqual(shortcutSettings);
    expect(getSettings().shortcutSettings).toEqual(shortcutSettings);
  });
});
