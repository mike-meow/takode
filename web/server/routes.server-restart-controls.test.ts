import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    namerConfig: { backend: "claude" },
    transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true },
    editorConfig: { editor: "none" },
    questmasterViewMode: "cards",
  })),
  updateSettings: vi.fn(() => ({})),
  getServerName: vi.fn(() => ""),
  setServerName: vi.fn(),
  getServerId: vi.fn(() => "test-server"),
  getClaudeUserDefaultModel: vi.fn(async () => ""),
  getCodexUserDefaultModel: vi.fn(async () => ""),
  STT_MODELS: [],
}));

vi.mock("./path-resolver.js", () => ({
  resolveBinary: vi.fn(() => null),
  getEnrichedPath: vi.fn(() => process.env.PATH ?? ""),
}));

import { createSettingsRoutes } from "./routes/settings.js";
import type { PermissionRequest } from "./session-types.js";
import { WsBridge } from "./ws-bridge.js";

type TestCliSocket = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeCliSocket(sessionId: string, sentOrder: string[]): TestCliSocket {
  return {
    send: vi.fn((raw: string) => {
      const parsed = JSON.parse(raw.trim());
      if (parsed.type === "control_request" && parsed.request?.subtype === "interrupt") {
        sentOrder.push(sessionId);
      }
    }),
    close: vi.fn(),
  };
}

describe("server restart controls", () => {
  let app: Hono;
  let bridge: WsBridge;
  let launcher: {
    listSessions: ReturnType<typeof vi.fn>;
    getSessionNum: ReturnType<typeof vi.fn>;
  };
  let requestRestart: ReturnType<typeof vi.fn>;
  let sentOrder: string[];
  let cliSockets: Record<string, TestCliSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new WsBridge();
    sentOrder = [];
    cliSockets = {};
    requestRestart = vi.fn();
    launcher = {
      listSessions: vi.fn(() => []),
      getSessionNum: vi.fn((sessionId: string) => ({ leader: 5, worker: 11, approval: 17 })[sessionId] ?? null),
    };

    app = new Hono();
    app.route(
      "/api",
      createSettingsRoutes({
        launcher,
        wsBridge: bridge,
        options: { requestRestart },
        pushoverNotifier: undefined,
      } as any),
    );
  });

  function attachBlockingSession(
    sessionId: string,
    options: { isGenerating: boolean; pendingPermissionCount?: number },
  ): void {
    const session = bridge.getOrCreateSession(sessionId);
    session.isGenerating = options.isGenerating;
    session.pendingPermissions = new Map(
      Array.from({ length: options.pendingPermissionCount ?? 0 }, (_, index) => {
        const requestId = `perm-${sessionId}-${index}`;
        const request: PermissionRequest = {
          request_id: requestId,
          tool_name: "Bash",
          input: {},
          tool_use_id: `tool-${requestId}`,
          timestamp: Date.now(),
        };
        return [requestId, request];
      }),
    );
    const socket = makeCliSocket(sessionId, sentOrder);
    session.backendSocket = socket as any;
    cliSockets[sessionId] = socket;
  }

  it("blocks restart when a session only has pending permissions", async () => {
    launcher.listSessions.mockReturnValue([{ sessionId: "approval", state: "connected", name: "Needs approval" }]);
    attachBlockingSession("approval", { isGenerating: false, pendingPermissionCount: 1 });

    const res = await app.request("/api/server/restart", { method: "POST" });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error:
        "Cannot restart while 1 session(s) are still blocking restart readiness. Please stop them first: Needs approval",
    });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("interrupts restart blockers through the live bridge surface in child-before-leader order", async () => {
    launcher.listSessions.mockReturnValue([
      { sessionId: "leader", state: "connected", name: "Leader session" },
      { sessionId: "worker", state: "connected", name: "Worker session", herdedBy: "leader" },
      { sessionId: "approval", state: "connected", name: "Needs approval" },
      { sessionId: "idle", state: "connected", name: "Idle session" },
    ]);
    attachBlockingSession("leader", { isGenerating: true });
    attachBlockingSession("worker", { isGenerating: true });
    attachBlockingSession("approval", { isGenerating: false, pendingPermissionCount: 2 });
    attachBlockingSession("idle", { isGenerating: false });

    expect((bridge as any).routeBrowserMessage).toBeUndefined();

    const res = await app.request("/api/server/interrupt-all", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(sentOrder).toEqual(["worker", "leader", "approval"]);
    expect(body).toEqual({
      ok: true,
      interrupted: [
        { sessionId: "worker", label: "Worker session", reasons: ["running"] },
        { sessionId: "leader", label: "Leader session", reasons: ["running"] },
        { sessionId: "approval", label: "Needs approval", reasons: ["2 pending permissions"] },
      ],
      skipped: [],
      failures: [],
    });

    const workerSession = bridge.getSession("worker");
    const leaderSession = bridge.getSession("leader");
    expect(workerSession?.interruptSourceDuringTurn).toBe("user");
    expect(workerSession?.interruptedDuringTurn).toBe(true);
    expect(workerSession?.messageHistory).not.toContainEqual(expect.objectContaining({ type: "user_message" }));
    expect(leaderSession?.interruptSourceDuringTurn).toBe("user");

    for (const sessionId of ["worker", "leader", "approval"] as const) {
      expect(cliSockets[sessionId].send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(cliSockets[sessionId].send.mock.calls[0][0].trim());
      expect(payload.type).toBe("control_request");
      expect(payload.request?.subtype).toBe("interrupt");
    }
  });
});
