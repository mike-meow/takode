import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createTakodeRoutes } from "./takode.js";

function createTestApp() {
  const session = {
    pendingPermissions: new Map([
      [
        "req-exit-plan",
        {
          request_id: "req-exit-plan",
          tool_name: "ExitPlanMode",
          timestamp: 2000,
          input: { plan: "Step 1: fix the approval path", allowedPrompts: [] },
        },
      ],
    ]),
    notifications: [],
    messageHistory: [{ type: "permission_request", request: { request_id: "req-exit-plan" } }],
  };

  const handleBrowserMessage = vi.fn(async (_ws: any, _raw: string) => {});
  const launcher = {
    resolveSessionId: vi.fn((id: string) => id),
    getSession: vi.fn((id: string) =>
      id === "worker-1" ? { sessionId: "worker-1", herdedBy: "orch-1" } : { sessionId: "orch-1", isOrchestrator: true },
    ),
  };

  const app = new Hono();
  app.route(
    "/api",
    createTakodeRoutes({
      launcher,
      wsBridge: {
        getSession: vi.fn(() => session),
        handleBrowserMessage,
      },
      authenticateTakodeCaller: vi.fn(() => ({ callerId: "orch-1", caller: { sessionId: "orch-1" } })),
      resolveId: (id: string) => id,
    } as any),
  );

  return { app, handleBrowserMessage };
}

describe("takode answer permission routing", () => {
  it("routes ExitPlanMode approval through the real bridge browser-message entrypoint", async () => {
    const { app, handleBrowserMessage } = createTestApp();

    const res = await app.request("/api/sessions/worker-1/answer", {
      method: "POST",
      body: JSON.stringify({ response: "approve" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      kind: "permission",
      tool_name: "ExitPlanMode",
      action: "approved",
    });
    expect(handleBrowserMessage).toHaveBeenCalledTimes(1);

    const [ws, raw] = handleBrowserMessage.mock.calls[0]!;
    expect(ws.data).toEqual({ kind: "browser", sessionId: "worker-1" });
    expect(JSON.parse(raw)).toEqual({
      type: "permission_response",
      request_id: "req-exit-plan",
      behavior: "allow",
      updated_input: { plan: "Step 1: fix the approval path", allowedPrompts: [] },
      actorSessionId: "orch-1",
    });
  });
});
