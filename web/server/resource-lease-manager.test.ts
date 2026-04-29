import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceLeaseManager } from "./resource-lease-manager.js";
import { ResourceLeaseStore } from "./resource-lease-store.js";

function createBridge() {
  return {
    injectUserMessage: vi.fn(() => "sent" as const),
  };
}

describe("ResourceLeaseManager", () => {
  let tempDir: string;
  let bridge: ReturnType<typeof createBridge>;
  let manager: ResourceLeaseManager;

  beforeEach(async () => {
    vi.useFakeTimers({ now: new Date("2026-04-29T12:00:00Z") });
    tempDir = mkdtempSync(join(tmpdir(), "resource-leases-"));
    bridge = createBridge();
    manager = new ResourceLeaseManager(bridge, new ResourceLeaseStore("test-server", tempDir));
    await manager.startAll();
  });

  afterEach(() => {
    manager.destroy();
    rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("acquires a named resource with quest, metadata, and default TTL", async () => {
    const result = await manager.acquire({
      resourceKey: "Dev-Server:Companion",
      callerSessionId: "session-1",
      questId: "q-979",
      purpose: "Run E2E verification",
      metadata: { url: "http://localhost:5174", empty: "" },
    });

    expect(result.status).toBe("acquired");
    if (result.status !== "acquired") throw new Error("expected acquired");
    expect(result.lease).toMatchObject({
      resourceKey: "dev-server:companion",
      ownerSessionId: "session-1",
      questId: "q-979",
      purpose: "Run E2E verification",
      metadata: { url: "http://localhost:5174" },
      ttlMs: 30 * 60_000,
    });
    expect(result.lease.expiresAt).toBe(Date.now() + 30 * 60_000);
  });

  it("queues waiters and promotes the first waiter on release", async () => {
    await manager.acquire({
      resourceKey: "agent-browser",
      callerSessionId: "owner",
      purpose: "Inspect UI",
    });
    const queuedOne = await manager.acquire({
      resourceKey: "agent-browser",
      callerSessionId: "waiter-1",
      purpose: "Run mobile check",
      waitIfUnavailable: true,
    });
    const queuedTwo = await manager.acquire({
      resourceKey: "agent-browser",
      callerSessionId: "waiter-2",
      purpose: "Run desktop check",
      waitIfUnavailable: true,
    });

    expect(queuedOne.status).toBe("queued");
    expect(queuedTwo.status).toBe("queued");

    const released = await manager.release("agent-browser", "owner");

    expect(released.promoted).toMatchObject({
      resourceKey: "agent-browser",
      ownerSessionId: "waiter-1",
      purpose: "Run mobile check",
    });
    expect(released.waiters).toHaveLength(1);
    expect(released.waiters[0].waiterSessionId).toBe("waiter-2");
    expect(bridge.injectUserMessage).toHaveBeenCalledWith(
      "waiter-1",
      expect.stringContaining("You now hold `agent-browser`."),
      { sessionId: "resource-lease:agent-browser", sessionLabel: "Resource Lease" },
    );
  });

  it("promotes the first waiter when a lease expires", async () => {
    await manager.acquire({
      resourceKey: "dev-server:companion",
      callerSessionId: "owner",
      purpose: "Use server",
      ttlMs: 10_000,
    });
    await manager.acquire({
      resourceKey: "dev-server:companion",
      callerSessionId: "waiter",
      purpose: "Need server next",
      waitIfUnavailable: true,
    });

    vi.advanceTimersByTime(10_001);
    const status = await manager.getStatus("dev-server:companion");

    expect(status.lease).toMatchObject({
      ownerSessionId: "waiter",
      purpose: "Need server next",
    });
    expect(status.waiters).toEqual([]);
    expect(bridge.injectUserMessage).toHaveBeenCalledWith(
      "waiter",
      expect.stringContaining("Heartbeat with `takode lease renew dev-server:companion`"),
      { sessionId: "resource-lease:dev-server:companion", sessionLabel: "Resource Lease" },
    );
  });

  it("renews only by owner and extends heartbeat/expiry", async () => {
    await manager.acquire({
      resourceKey: "agent-browser",
      callerSessionId: "owner",
      purpose: "Inspect UI",
      ttlMs: 10_000,
    });

    await expect(
      manager.renew({ resourceKey: "agent-browser", callerSessionId: "other", ttlMs: 20_000 }),
    ).rejects.toMatchObject({ code: "forbidden" });

    vi.advanceTimersByTime(1_000);
    const renewed = await manager.renew({ resourceKey: "agent-browser", callerSessionId: "owner", ttlMs: 20_000 });

    expect(renewed.heartbeatAt).toBe(Date.now());
    expect(renewed.expiresAt).toBe(Date.now() + 20_000);
  });

  it("persists leases and waiters through a new manager instance", async () => {
    await manager.acquire({
      resourceKey: "dev-server:companion",
      callerSessionId: "owner",
      purpose: "Use server",
    });
    await manager.acquire({
      resourceKey: "dev-server:companion",
      callerSessionId: "waiter",
      purpose: "Use server next",
      waitIfUnavailable: true,
    });
    manager.destroy();

    const restored = new ResourceLeaseManager(bridge, new ResourceLeaseStore("test-server", tempDir));
    await restored.startAll();
    const status = await restored.getStatus("dev-server:companion");
    restored.destroy();

    expect(status.lease?.ownerSessionId).toBe("owner");
    expect(status.waiters).toHaveLength(1);
    expect(status.waiters[0].waiterSessionId).toBe("waiter");
  });
});
