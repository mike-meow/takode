import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerSessionSlackThreadRoutes } from "./routes/session-slack-thread-routes.js";
import type { BrowserIncomingMessage, SessionState } from "./session-types.js";

vi.mock("./session-names.js", () => ({
  setName: vi.fn(),
}));

function assistant(id: string, text: string): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: [{ type: "text", text }],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: 1,
    uuid: id,
  };
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "root",
    model: "gpt-5.5",
    cwd: "/repo",
    tools: [],
    permissionMode: "codex-default",
    claude_code_version: "test",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 1,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "main",
    is_worktree: false,
    is_containerized: false,
    repo_root: "/repo",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

describe("Slack thread session routes", () => {
  it("launches hidden Codex children with the root session env profile and runtime env", async () => {
    const root = {
      id: "root",
      state: makeState({ backend_type: "codex", memorySessionSpaceSlug: "Takode" }),
      messageHistory: [assistant("anchor-1", "Root answer")],
    };
    const childSession = {
      id: "child",
      state: makeState({ session_id: "child", backend_type: "codex" }),
      messageHistory: [],
    };
    const launcher = {
      getSession: vi.fn((id: string) =>
        id === "root"
          ? {
              sessionId: "root",
              backendType: "codex",
              cwd: "/repo",
              model: "gpt-5.5",
              permissionMode: "codex-default",
              askPermission: true,
              uiMode: "agent",
              codexInternetAccess: true,
              codexReasoningEffort: "high",
              envSlug: "codex-profile",
            }
          : null,
      ),
      getSessionLaunchEnv: vi.fn(() => ({
        LITELLM_API_KEY: "profile-secret",
        PROFILE_ONLY: "kept",
        COMPANION_PORT: "3467",
        COMPANION_AUTH_TOKEN: "root-auth",
        COMPANION_SESSION_ID: "root",
        COMPANION_SESSION_NUMBER: "42",
        TAKODE_ROLE: "orchestrator",
        TAKODE_API_PORT: "3467",
      })),
      launch: vi.fn(async () => ({
        sessionId: "child",
        backendType: "codex",
        cwd: "/repo",
        createdAt: 2,
        state: "starting" as const,
      })),
      touchActivity: vi.fn(),
    };
    const wsBridge = {
      getSession: vi.fn((id: string) => (id === "root" ? root : null)),
      getOrCreateSession: vi.fn(() => childSession),
      persistSessionById: vi.fn(),
      broadcastToSession: vi.fn(),
      syncSlackThreadRecord: vi.fn(),
    };
    const app = new Hono();
    app.route(
      "/api",
      (() => {
        const api = new Hono();
        registerSessionSlackThreadRoutes(api, {
          launcher: launcher as never,
          wsBridge: wsBridge as never,
          resolveId: (id) => (id === "root" ? "root" : null),
        });
        return api;
      })(),
    );

    const res = await app.request("/api/sessions/root/slack-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchorMessageId: "anchor-1" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        permissionMode: "codex-default",
        askPermission: true,
        uiMode: "agent",
        codexSandbox: "read-only",
        codexInternetAccess: true,
        codexReasoningEffort: "high",
        envSlug: "codex-profile",
        blockedEnvKeys: [
          "COMPANION_AUTH_TOKEN",
          "COMPANION_SESSION_ID",
          "COMPANION_SESSION_NUMBER",
          "TAKODE_ROLE",
          "TAKODE_API_PORT",
        ],
        env: {
          LITELLM_API_KEY: "profile-secret",
          PROFILE_ONLY: "kept",
          COMPANION_PORT: "3467",
        },
        hidden: true,
        parentSessionId: "root",
        slackThreadReadOnly: true,
      }),
    );
    const launchOptions = (launcher.launch as unknown as { mock: { calls: Array<[{ env?: Record<string, string> }]> } })
      .mock.calls[0][0];
    expect(launchOptions.env).not.toHaveProperty("COMPANION_AUTH_TOKEN");
    expect(launchOptions.env).not.toHaveProperty("COMPANION_SESSION_ID");
    expect(launchOptions.env).not.toHaveProperty("TAKODE_ROLE");
    expect(childSession.state.permissionMode).toBe("codex-default");
  });
});
