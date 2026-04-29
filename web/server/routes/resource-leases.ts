import { Hono } from "hono";
import { parseDuration } from "../timer-parse.js";
import { ResourceLeaseError } from "../resource-lease-manager.js";
import type { RouteContext } from "./context.js";

export function createResourceLeaseRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { authenticateTakodeCaller, wsBridge } = ctx;

  api.get("/resource-leases", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    if (!ctx.resourceLeaseManager) return c.json({ error: "Resource lease manager not available" }, 503);

    const resources = await ctx.resourceLeaseManager.listStatuses();
    return c.json({ resources });
  });

  api.get("/resource-leases/:resourceKey", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    if (!ctx.resourceLeaseManager) return c.json({ error: "Resource lease manager not available" }, 503);

    return c.json({ resource: await ctx.resourceLeaseManager.getStatus(c.req.param("resourceKey")) });
  });

  api.post("/resource-leases/:resourceKey/acquire", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    if (!ctx.resourceLeaseManager) return c.json({ error: "Resource lease manager not available" }, 503);

    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await ctx.resourceLeaseManager.acquire({
        resourceKey: c.req.param("resourceKey"),
        callerSessionId: auth.callerId,
        questId: normalizeQuestId(body.questId) ?? wsBridge.getSession(auth.callerId)?.state.claimedQuestId,
        purpose: normalizePurpose(body.purpose),
        metadata: normalizeMetadata(body.metadata),
        ttlMs: normalizeTtl(body),
        waitIfUnavailable: body.wait === true || body.waitIfUnavailable === true,
      });
      return c.json({ result }, statusCodeForAcquireResult(result.status));
    } catch (err) {
      return resourceLeaseErrorResponse(c, err);
    }
  });

  api.post("/resource-leases/:resourceKey/wait", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    if (!ctx.resourceLeaseManager) return c.json({ error: "Resource lease manager not available" }, 503);

    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await ctx.resourceLeaseManager.wait({
        resourceKey: c.req.param("resourceKey"),
        callerSessionId: auth.callerId,
        questId: normalizeQuestId(body.questId) ?? wsBridge.getSession(auth.callerId)?.state.claimedQuestId,
        purpose: normalizePurpose(body.purpose),
        metadata: normalizeMetadata(body.metadata),
        ttlMs: normalizeTtl(body),
        waitIfUnavailable: true,
      });
      return c.json({ result }, statusCodeForAcquireResult(result.status));
    } catch (err) {
      return resourceLeaseErrorResponse(c, err);
    }
  });

  api.post("/resource-leases/:resourceKey/renew", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    if (!ctx.resourceLeaseManager) return c.json({ error: "Resource lease manager not available" }, 503);

    try {
      const body = await c.req.json().catch(() => ({}));
      const lease = await ctx.resourceLeaseManager.renew({
        resourceKey: c.req.param("resourceKey"),
        callerSessionId: auth.callerId,
        ttlMs: normalizeTtl(body),
      });
      return c.json({ lease });
    } catch (err) {
      return resourceLeaseErrorResponse(c, err);
    }
  });

  api.post("/resource-leases/:resourceKey/heartbeat", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    if (!ctx.resourceLeaseManager) return c.json({ error: "Resource lease manager not available" }, 503);

    try {
      const body = await c.req.json().catch(() => ({}));
      const lease = await ctx.resourceLeaseManager.renew({
        resourceKey: c.req.param("resourceKey"),
        callerSessionId: auth.callerId,
        ttlMs: normalizeTtl(body),
      });
      return c.json({ lease });
    } catch (err) {
      return resourceLeaseErrorResponse(c, err);
    }
  });

  api.post("/resource-leases/:resourceKey/release", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    if (!ctx.resourceLeaseManager) return c.json({ error: "Resource lease manager not available" }, 503);

    try {
      const result = await ctx.resourceLeaseManager.release(c.req.param("resourceKey"), auth.callerId);
      return c.json({ result });
    } catch (err) {
      return resourceLeaseErrorResponse(c, err);
    }
  });

  return api;
}

function statusCodeForAcquireResult(status: string): 200 | 201 | 202 {
  if (status === "acquired") return 201;
  if (status === "queued") return 202;
  return 200;
}

function normalizePurpose(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function normalizeQuestId(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : undefined;
}

function normalizeMetadata(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .map(([key, value]) => [key.trim(), String(value ?? "").trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
}

function normalizeTtl(body: Record<string, unknown>): number | undefined {
  if (typeof body.ttlMs === "number") return body.ttlMs;
  if (typeof body.ttl === "string" && body.ttl.trim()) return parseDuration(body.ttl);
  return undefined;
}

function resourceLeaseErrorResponse(c: any, err: unknown): Response {
  if (err instanceof ResourceLeaseError) {
    const status = err.code === "forbidden" ? 403 : err.code === "not_found" ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
}
