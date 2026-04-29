import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceLeaseManager } from "../resource-lease-manager.js";
import { ResourceLeaseStore } from "../resource-lease-store.js";
import { createResourceLeaseRoutes } from "./resource-leases.js";

describe("resource lease routes", () => {
  let tempDir: string;
  let manager: ResourceLeaseManager;
  let app: Hono;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "resource-lease-routes-"));
    manager = new ResourceLeaseManager(
      { injectUserMessage: vi.fn(() => "sent" as const) },
      new ResourceLeaseStore("route-test", tempDir),
    );
    await manager.startAll();
    app = new Hono();
    app.route(
      "/api",
      createResourceLeaseRoutes({
        resourceLeaseManager: manager,
        wsBridge: {
          getSession: (sessionId: string) => ({
            state: { claimedQuestId: sessionId === "owner" ? "q-979" : undefined },
          }),
        },
        authenticateTakodeCaller: (c: any) => {
          const callerId = c.req.header("x-test-session") || "owner";
          return { callerId, caller: { sessionId: callerId } };
        },
      } as any),
    );
  });

  afterEach(() => {
    manager.destroy();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("acquires with caller ownership and default claimed quest", async () => {
    const response = await app.request("/api/resource-leases/dev-server:companion/acquire", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-session": "owner" },
      body: JSON.stringify({ purpose: "Run local verification", metadata: { url: "http://localhost:5174" } }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.result.lease).toMatchObject({
      resourceKey: "dev-server:companion",
      ownerSessionId: "owner",
      questId: "q-979",
      metadata: { url: "http://localhost:5174" },
    });
  });

  it("rejects release from a non-owner session", async () => {
    await app.request("/api/resource-leases/agent-browser/acquire", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-session": "owner" },
      body: JSON.stringify({ purpose: "Inspect UI" }),
    });

    const response = await app.request("/api/resource-leases/agent-browser/release", {
      method: "POST",
      headers: { "x-test-session": "other" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only owner can release agent-browser" });
  });
});
