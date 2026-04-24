import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSessionAuthDir, getSessionAuthPath } from "../shared/session-auth.js";

type JsonObject = Record<string, unknown>;

/** Compute centralized auth path — must match getSessionAuthPath() in cli-launcher.ts */
function centralAuthPath(cwd: string, home: string, serverId = "test-server-id"): string {
  return getSessionAuthPath(cwd, serverId, home);
}

function readJson(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      resolve(body ? (JSON.parse(body) as JsonObject) : {});
    });
  });
}

async function runTakode(
  args: string[],
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
  stdin?: string,
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const takodePath = fileURLToPath(new URL("./takode.ts", import.meta.url));
  const child = spawn(process.execPath, [takodePath, ...args], {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (stdin !== undefined) {
    child.stdin?.end(stdin);
  } else {
    child.stdin?.end();
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const [code] = await once(child, "close");
  return { status: code as number | null, stdout, stderr };
}

describe("takode spawn", () => {
  it("inherits backend from leader session when --backend is not specified", async () => {
    const createBodies: JsonObject[] = [];
    const created = [{ sessionId: "worker-1" }];
    const sessionInfoById: Record<string, JsonObject> = {
      "worker-1": {
        sessionId: "worker-1",
        sessionNum: 21,
        name: "Worker One",
        state: "running",
        backendType: "codex",
        model: "gpt-5.4",
        cwd: "/tmp/worker-1",
        createdAt: Date.now(),
        cliConnected: true,
        isGenerating: false,
        isWorktree: true,
        actualBranch: "feat/worker-1",
        askPermission: true,
        codexReasoningEffort: "high",
        codexInternetAccess: false,
      },
    };
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-1") {
        res.writeHead(200, { "content-type": "application/json" });
        // Leader is a codex session -- spawn should inherit this backend
        res.end(JSON.stringify({ sessionId: "leader-1", permissionMode: "plan", backendType: "codex" }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(created.shift()));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-1/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sessionInfoById["worker-1"]));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const result = await runTakode(["spawn", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(createBodies).toHaveLength(1);
    // Backend is inherited from the leader (codex) when --backend is not specified.
    expect(createBodies[0]).toEqual({
      backend: "codex",
      cwd: process.cwd(),
      useWorktree: true,
      createdBy: "leader-1",
      codexReasoningEffort: "high",
    });
    expect(result.stdout).toContain('#21 "Worker One"');
    expect(result.stdout).toContain("model=gpt-5.4");
    expect(result.stdout).toContain("reasoning=high");
    expect(result.stdout).toContain("internet=off");
    expect(result.stdout).toContain("ask=on");
    expect(result.stdout).toContain("worktree=yes");
  });

  it("inherits bypass permission mode and sends initial message to each spawned session", async () => {
    const createBodies: JsonObject[] = [];
    const messageCalls: Array<{ id: string; body: JsonObject }> = [];
    const created = [{ sessionId: "worker-a" }, { sessionId: "worker-b" }];
    const sessionInfoById: Record<string, JsonObject> = {
      "worker-a": {
        sessionId: "worker-a",
        sessionNum: 31,
        name: "Worker A",
        state: "running",
        backendType: "claude",
        model: "",
        cwd: "/tmp/spawn-test",
        createdAt: Date.now(),
        cliConnected: true,
        isGenerating: false,
        askPermission: false,
        isWorktree: true,
      },
      "worker-b": {
        sessionId: "worker-b",
        sessionNum: 32,
        name: "Worker B",
        state: "running",
        backendType: "claude",
        model: "",
        cwd: "/tmp/spawn-test",
        createdAt: Date.now(),
        cliConnected: true,
        isGenerating: false,
        askPermission: false,
        isWorktree: true,
      },
    };

    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-2", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-2") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-2",
            sessionNum: 12,
            name: "Spawn Boss",
            permissionMode: "bypassPermissions",
          }),
        );
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(created.shift()));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-a/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sessionInfoById["worker-a"]));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-b/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sessionInfoById["worker-b"]));
        return;
      }
      if (method === "POST" && url.startsWith("/api/sessions/") && url.endsWith("/message")) {
        const parts = url.split("/");
        const id = parts[3] || "";
        messageCalls.push({ id, body: await readJson(req) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const result = await runTakode(
      [
        "spawn",
        "--port",
        String(port),
        "--backend",
        "claude",
        "--cwd",
        "/tmp/spawn-test",
        "--count",
        "2",
        "--message",
        "run smoke tests",
        "--json",
      ],
      {
        ...process.env,
        COMPANION_SESSION_ID: "leader-2",
        COMPANION_AUTH_TOKEN: "auth-2",
      },
    );

    server.close();

    expect(result.status).toBe(0);
    // Validates bypass inheritance and per-session create payload.
    expect(createBodies).toEqual([
      {
        backend: "claude",
        cwd: "/tmp/spawn-test",
        useWorktree: true,
        createdBy: "leader-2",
        askPermission: false,
      },
      {
        backend: "claude",
        cwd: "/tmp/spawn-test",
        useWorktree: true,
        createdBy: "leader-2",
        askPermission: false,
      },
    ]);
    // Validates --message fanout to all created sessions.
    expect(messageCalls).toEqual([
      {
        id: "worker-a",
        body: {
          content: "run smoke tests",
          agentSource: { sessionId: "leader-2", sessionLabel: "#12 Spawn Boss" },
        },
      },
      {
        id: "worker-b",
        body: {
          content: "run smoke tests",
          agentSource: { sessionId: "leader-2", sessionLabel: "#12 Spawn Boss" },
        },
      },
    ]);

    const parsed = JSON.parse(result.stdout) as {
      count: number;
      leaderPermissionMode: string | null;
      inheritedAskPermission: boolean | null;
      sessions: Array<{ sessionNum?: number }>;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.leaderPermissionMode).toBe("bypassPermissions");
    expect(parsed.inheritedAskPermission).toBe(false);
    expect(parsed.sessions.map((s) => s.sessionNum)).toEqual([31, 32]);
  });

  it("reads multiline shell-sensitive initial messages from --message-file without mangling them", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-spawn-message-file-"));
    const messagePath = join(tmp, "dispatch.txt");
    const createBodies: JsonObject[] = [];
    const messageCalls: Array<{ id: string; body: JsonObject }> = [];
    const shellSensitiveMessage =
      "First line with $HOME\nSecond line with `code` and $(danger)\nThird line with {json: true}\n";
    writeFileSync(messagePath, shellSensitiveMessage, "utf-8");

    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-file", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-file") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ sessionId: "leader-file", sessionNum: 13, name: "File Leader", backendType: "claude" }),
        );
        return;
      }

      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-file" }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-file/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-file",
            sessionNum: 33,
            name: "Worker File",
            state: "running",
            backendType: "claude",
            model: "",
            cwd: "/tmp/spawn-test",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            askPermission: true,
            isWorktree: true,
          }),
        );
        return;
      }

      if (method === "POST" && url === "/api/sessions/worker-file/message") {
        messageCalls.push({ id: "worker-file", body: await readJson(req) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(
        ["spawn", "--port", String(port), "--message-file", messagePath, "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: "leader-file",
          COMPANION_AUTH_TOKEN: "auth-file",
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(createBodies).toHaveLength(1);
      expect(messageCalls).toEqual([
        {
          id: "worker-file",
          body: {
            content: shellSensitiveMessage,
            agentSource: { sessionId: "leader-file", sessionLabel: "#13 File Leader" },
          },
        },
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        count: 1,
        message: shellSensitiveMessage,
      });
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads multiline shell-sensitive initial messages from stdin via --message-file -", async () => {
    const createBodies: JsonObject[] = [];
    const messageCalls: Array<{ id: string; body: JsonObject }> = [];
    const stdinMessage =
      "First line from stdin with $HOME\nSecond line with `code` and $(danger)\nThird line with {json: true}\n";

    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-stdin-file", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-stdin-file") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-stdin-file",
            sessionNum: 14,
            name: "Stdin File Leader",
            backendType: "claude",
          }),
        );
        return;
      }

      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-stdin-file" }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-stdin-file/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-stdin-file",
            sessionNum: 34,
            name: "Worker Stdin File",
            state: "running",
            backendType: "claude",
            model: "",
            cwd: "/tmp/spawn-test",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            askPermission: true,
            isWorktree: true,
          }),
        );
        return;
      }

      if (method === "POST" && url === "/api/sessions/worker-stdin-file/message") {
        messageCalls.push({ id: "worker-stdin-file", body: await readJson(req) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(
        ["spawn", "--port", String(port), "--message-file", "-", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: "leader-stdin-file",
          COMPANION_AUTH_TOKEN: "auth-stdin-file",
        },
        process.cwd(),
        stdinMessage,
      );

      expect(result.status).toBe(0);
      expect(createBodies).toHaveLength(1);
      expect(messageCalls).toEqual([
        {
          id: "worker-stdin-file",
          body: {
            content: stdinMessage,
            agentSource: { sessionId: "leader-stdin-file", sessionLabel: "#14 Stdin File Leader" },
          },
        },
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        count: 1,
        message: stdinMessage,
      });
    } finally {
      server.close();
    }
  });

  it("rejects mixing --message with --message-file", async () => {
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-mix", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-mix") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-mix", backendType: "claude" }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(
        ["spawn", "--port", String(port), "--message", "inline", "--message-file", "-", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: "leader-mix",
          COMPANION_AUTH_TOKEN: "auth-mix",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Use either --message or --message-file, not both");
    } finally {
      server.close();
    }
  });

  it("claude leader spawns claude workers by default (no --backend needed)", async () => {
    // Regression test: previously, omitting --backend always defaulted to codex,
    // even when the leader was a Claude session.
    const createBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-claude", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-claude") {
        res.writeHead(200, { "content-type": "application/json" });
        // Leader is a Claude (WebSocket) session
        res.end(JSON.stringify({ sessionId: "leader-claude", permissionMode: "plan", backendType: "claude" }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-claude" }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-claude/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-claude",
            sessionNum: 50,
            name: "Claude Worker",
            state: "running",
            backendType: "claude",
            model: "claude-sonnet-4-20250514",
            cwd: "/tmp/claude-worker",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            isWorktree: true,
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    // No --backend flag: should inherit "claude" from leader
    const result = await runTakode(["spawn", "--port", String(port), "--json"], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-claude",
      COMPANION_AUTH_TOKEN: "auth-claude",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(createBodies).toHaveLength(1);
    // Backend inherited from the Claude leader -- NOT defaulting to codex.
    expect(createBodies[0]).toMatchObject({ backend: "claude" });
    // No codex-specific fields should be present
    expect(createBodies[0]).not.toHaveProperty("codexReasoningEffort");
    expect(createBodies[0]).not.toHaveProperty("codexInternetAccess");
  });

  it("passes explicit codex spawn options through and returns the enriched session shape", async () => {
    const createBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-3", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-3") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-3", permissionMode: "plan" }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-c" }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-c/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-c",
            sessionNum: 41,
            name: "Worker C",
            state: "running",
            backendType: "codex",
            model: "gpt-5.4",
            cwd: "/tmp/codex-worker",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            askPermission: false,
            permissionMode: "bypassPermissions",
            isWorktree: false,
            codexReasoningEffort: "medium",
            codexInternetAccess: true,
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const result = await runTakode(
      [
        "spawn",
        "--port",
        String(port),
        "--backend",
        "codex",
        "--model",
        "gpt-5.4",
        "--reasoning-effort",
        "medium",
        "--internet",
        "--no-ask",
        "--json",
      ],
      {
        ...process.env,
        COMPANION_SESSION_ID: "leader-3",
        COMPANION_AUTH_TOKEN: "auth-3",
      },
    );

    server.close();

    expect(result.status).toBe(0);
    expect(createBodies).toEqual([
      {
        backend: "codex",
        cwd: process.cwd(),
        useWorktree: true,
        createdBy: "leader-3",
        model: "gpt-5.4",
        askPermission: false,
        permissionMode: "bypassPermissions",
        codexReasoningEffort: "medium",
        codexInternetAccess: true,
      },
    ]);

    const parsed = JSON.parse(result.stdout) as {
      sessions: Array<{
        model: string;
        codexReasoningEffort: string;
        codexInternetAccess: boolean;
        askPermission: boolean;
        isWorktree: boolean;
      }>;
      defaultModel: string | null;
    };
    expect(parsed.defaultModel).toBeNull();
    expect(parsed.sessions).toEqual([
      expect.objectContaining({
        model: "gpt-5.4",
        permissionMode: "bypassPermissions",
        codexReasoningEffort: "medium",
        codexInternetAccess: true,
        askPermission: false,
        isWorktree: false,
      }),
    ]);
  });

  it("warns about worker-slot overage without counting reviewers", async () => {
    const createBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-slot-warning", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-slot-warning") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-slot-warning", permissionMode: "plan", backendType: "claude" }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-slot-6" }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-slot-6/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-slot-6",
            sessionNum: 36,
            name: "Worker Slot 6",
            state: "running",
            backendType: "claude",
            model: "",
            cwd: "/tmp/slot-warning",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            isWorktree: true,
          }),
        );
        return;
      }
      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            { sessionId: "worker-slot-1", herdedBy: "leader-slot-warning", archived: false },
            { sessionId: "worker-slot-2", herdedBy: "leader-slot-warning", archived: false },
            { sessionId: "worker-slot-3", herdedBy: "leader-slot-warning", archived: false },
            { sessionId: "worker-slot-4", herdedBy: "leader-slot-warning", archived: false },
            { sessionId: "worker-slot-5", herdedBy: "leader-slot-warning", archived: false },
            { sessionId: "worker-slot-6", herdedBy: "leader-slot-warning", archived: false },
            { sessionId: "reviewer-slot-1", herdedBy: "leader-slot-warning", reviewerOf: 31, archived: false },
          ]),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const result = await runTakode(["spawn", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-slot-warning",
      COMPANION_AUTH_TOKEN: "auth-slot-warning",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(createBodies).toHaveLength(1);
    expect(result.stdout).toContain("Worker slots used: 6/5.");
    expect(result.stdout).toContain("Please archive 1 worker session least likely to be reused.");
    expect(result.stdout).toContain(
      "Reviewers do not use worker slots, and archiving reviewers will not free worker-slot capacity.",
    );
  });

  it("rejects unsupported spawn flags instead of ignoring them", async () => {
    const result = await runTakode(["spawn", "--unsupported-flag"], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-4",
      COMPANION_AUTH_TOKEN: "auth-4",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option(s): --unsupported-flag");
  });
});
