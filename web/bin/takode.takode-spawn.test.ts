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

  it("uses a worktree-backed leader branch as worker base and port target", async () => {
    const createBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-worktree", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-worktree") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-worktree",
            sessionNum: 7,
            name: "Leader WT",
            permissionMode: "plan",
            backendType: "claude",
            cwd: "/worktrees/project/main-wt-7758",
            isWorktree: true,
            repoRoot: "/repo/project",
            branch: "main",
            actualBranch: "main-wt-7758",
          }),
        );
        return;
      }

      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-from-leader" }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-from-leader/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-from-leader",
            sessionNum: 77,
            name: "Worker From Leader",
            state: "running",
            backendType: "claude",
            cwd: "/worktrees/project/main-wt-7758-wt-1234",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            isWorktree: true,
            branch: "main-wt-7758",
            actualBranch: "main-wt-7758-wt-1234",
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

    const result = await runTakode(["spawn", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-worktree",
      COMPANION_AUTH_TOKEN: "auth-worktree",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]).toEqual({
      backend: "claude",
      cwd: "/worktrees/project/main-wt-7758",
      useWorktree: true,
      createdBy: "leader-worktree",
      branch: "main-wt-7758",
      worktreePortTarget: {
        repoRoot: "/repo/project",
        branch: "main-wt-7758",
        sourceSessionId: "leader-worktree",
        sourceSessionNum: 7,
        sourceLabel: "#7 Leader WT",
      },
    });
  });

  it("inherits memory session-space from the leader for workers and from the parent for reviewers", async () => {
    const createBodies: JsonObject[] = [];
    const created = [{ sessionId: "worker-space" }, { sessionId: "reviewer-space" }];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-space", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-space") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-space",
            permissionMode: "plan",
            backendType: "claude",
            memorySessionSpaceSlug: "LeaderSpace",
          }),
        );
        return;
      }
      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "parent-worker",
              sessionNum: 42,
              archived: false,
              cwd: "/repo/parent-worker",
              memorySessionSpaceSlug: "ParentSpace",
            },
          ]),
        );
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(created.shift()));
        return;
      }
      if (
        method === "GET" &&
        (url === "/api/sessions/worker-space/info" || url === "/api/sessions/reviewer-space/info")
      ) {
        const isReviewer = url.includes("reviewer-space");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: isReviewer ? "reviewer-space" : "worker-space",
            sessionNum: isReviewer ? 52 : 51,
            name: isReviewer ? "Reviewer Space" : "Worker Space",
            state: "running",
            backendType: "claude",
            cwd: isReviewer ? "/repo/parent-worker" : "/tmp/worker-space",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            isWorktree: !isReviewer,
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
    const env = {
      ...process.env,
      COMPANION_SESSION_ID: "leader-space",
      COMPANION_AUTH_TOKEN: "auth-space",
    };

    const workerResult = await runTakode(["spawn", "--port", String(port), "--json"], env);
    const reviewerResult = await runTakode(["spawn", "--port", String(port), "--reviewer", "42", "--json"], env);

    server.close();

    expect(workerResult.status).toBe(0);
    expect(reviewerResult.status).toBe(0);
    expect(createBodies[0]).toEqual(
      expect.objectContaining({
        memorySessionSpaceSlug: "LeaderSpace",
      }),
    );
    expect(createBodies[1]).toEqual(
      expect.objectContaining({
        reviewerOf: 42,
        cwd: "/repo/parent-worker",
        useWorktree: false,
        memorySessionSpaceSlug: "ParentSpace",
      }),
    );
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

  it("lets Codex leaders override the spawned worker permission profile", async () => {
    const createBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-auto-review", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-auto-review") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-auto-review",
            permissionMode: "codex-full-access",
            backendType: "codex",
          }),
        );
        return;
      }

      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-auto-review" }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-auto-review/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-auto-review",
            sessionNum: 33,
            name: "Auto Review Worker",
            state: "running",
            backendType: "codex",
            cwd: "/tmp/spawn-test",
            createdAt: Date.now(),
            permissionMode: "codex-auto-review",
            askPermission: true,
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

    const result = await runTakode(["spawn", "--port", String(port), "--permission-mode", "auto-review", "--json"], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-auto-review",
      COMPANION_AUTH_TOKEN: "auth-auto-review",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(createBodies[0]).toEqual(
      expect.objectContaining({
        backend: "codex",
        permissionMode: "codex-auto-review",
        codexReasoningEffort: "high",
      }),
    );
    expect(createBodies[0]).not.toHaveProperty("askPermission");

    const parsed = JSON.parse(result.stdout) as { codexPermissionMode: string | null };
    expect(parsed.codexPermissionMode).toBe("codex-auto-review");
  });

  it("inherits a Codex leader permission profile when no spawn override is provided", async () => {
    const createBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-inherit-mode", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-inherit-mode") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-inherit-mode",
            permissionMode: "codex-auto-review",
            backendType: "codex",
          }),
        );
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-inherit-mode" }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-inherit-mode/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-inherit-mode",
            sessionNum: 34,
            state: "running",
            backendType: "codex",
            cwd: "/tmp/spawn-test",
            createdAt: Date.now(),
            permissionMode: "codex-auto-review",
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

    const result = await runTakode(["spawn", "--port", String(port), "--json"], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-inherit-mode",
      COMPANION_AUTH_TOKEN: "auth-inherit-mode",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(createBodies[0]).toEqual(expect.objectContaining({ permissionMode: "codex-auto-review" }));
    const parsed = JSON.parse(result.stdout) as { codexPermissionMode: string | null };
    expect(parsed.codexPermissionMode).toBe("codex-auto-review");
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
            permissionMode: "codex-full-access",
            isWorktree: false,
            codexReasoningEffort: "medium",
            codexInternetAccess: true,
            injectedSystemPrompt: "large injected prompt",
            taskHistory: [{ title: "Trace spawn output", startedAt: 100 }],
            tools: ["Bash", "Read"],
            mcpServers: [{ name: "slack", status: "connected" }],
            keywords: ["spawn", "json"],
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
        permissionMode: "codex-full-access",
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
        taskHistoryCount: number;
        toolsCount: number;
        mcpServerCount: number;
        keywordCount: number;
      }>;
      defaultModel: string | null;
    };
    expect(parsed.defaultModel).toBeNull();
    expect(parsed.sessions).toEqual([
      expect.objectContaining({
        model: "gpt-5.4",
        permissionMode: "codex-full-access",
        codexReasoningEffort: "medium",
        codexInternetAccess: true,
        askPermission: false,
        isWorktree: false,
        taskHistoryCount: 1,
        toolsCount: 2,
        mcpServerCount: 1,
        keywordCount: 2,
      }),
    ]);
    expect(parsed.sessions[0]).not.toHaveProperty("injectedSystemPrompt");
    expect(parsed.sessions[0]).not.toHaveProperty("taskHistory");
    expect(parsed.sessions[0]).not.toHaveProperty("tools");
    expect(parsed.sessions[0]).not.toHaveProperty("mcpServers");
    expect(parsed.sessions[0]).not.toHaveProperty("keywords");
  });

  it("reveals opt-in spawn session fields in JSON", async () => {
    const sessionInfo = {
      sessionId: "worker-detail",
      sessionNum: 42,
      name: "Detail Worker",
      state: "running",
      backendType: "codex",
      cwd: "/tmp/detail-worker",
      createdAt: Date.now(),
      cliConnected: true,
      isGenerating: false,
      isWorktree: true,
      injectedSystemPrompt: "large spawn prompt",
      taskHistory: [{ title: "Trace detail output", startedAt: 300 }],
      tools: ["Bash"],
    };
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-detail", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-detail") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-detail", permissionMode: "plan", backendType: "codex" }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        await readJson(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-detail" }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-detail/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sessionInfo));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const included = await runTakode(
      ["spawn", "--port", String(port), "--json", "--include", "injectedSystemPrompt", "--no-worktree"],
      {
        ...process.env,
        COMPANION_SESSION_ID: "leader-detail",
        COMPANION_AUTH_TOKEN: "auth-detail",
      },
    );
    const detailed = await runTakode(["spawn", "--port", String(port), "--json", "--details", "--no-worktree"], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-detail",
      COMPANION_AUTH_TOKEN: "auth-detail",
    });

    server.close();

    expect(included.status).toBe(0);
    const includedSession = (JSON.parse(included.stdout) as { sessions: JsonObject[] }).sessions[0];
    expect(includedSession.injectedSystemPrompt).toBe("large spawn prompt");
    expect(includedSession).not.toHaveProperty("taskHistory");

    expect(detailed.status).toBe(0);
    expect((JSON.parse(detailed.stdout) as { sessions: JsonObject[] }).sessions[0]).toMatchObject({
      injectedSystemPrompt: "large spawn prompt",
      taskHistory: [{ title: "Trace detail output", startedAt: 300 }],
      tools: ["Bash"],
    });
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
            {
              sessionId: "leader-slot-warning",
              archived: false,
              isOrchestrator: true,
              leaderActiveBoardRows: [
                { questId: "q-1", status: "IMPLEMENTING" },
                { questId: "q-2", status: "PLANNING" },
                { questId: "q-3", status: "PORTING" },
                { questId: "q-4", status: "MEMORY" },
                { questId: "q-5", status: "BOOKKEEPING" },
                { questId: "q-6", status: "EXECUTING" },
              ],
            },
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
      if (method === "GET" && url === "/api/settings") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ takodeWorkerConcurrency: 5 }));
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
    expect(result.stdout).toContain("Reduce active worker-owned board demand by 1 before dispatching more work.");
    expect(result.stdout).toContain(
      "Reviewers do not use worker slots, and archiving reviewers will not free worker-slot capacity.",
    );
  });

  it("replaces an owned worktree worker while passing normal spawn options and initial message", async () => {
    const replacementBodies: JsonObject[] = [];
    const messages: JsonObject[] = [];
    const sessionInfoById: Record<string, JsonObject> = {
      "new-worker": {
        sessionId: "new-worker",
        sessionNum: 44,
        name: "Replacement Worker",
        state: "running",
        backendType: "codex",
        model: "gpt-5.4",
        cwd: "/wt/main-wt-1111",
        createdAt: Date.now(),
        cliConnected: true,
        isGenerating: false,
        isWorktree: true,
        actualBranch: "main-wt-1111",
        askPermission: true,
        permissionMode: "codex-auto-review",
        codexReasoningEffort: "medium",
        codexInternetAccess: true,
        injectedSystemPrompt: "large replacement prompt",
        taskHistory: [{ title: "Replacement output", startedAt: 200 }],
        tools: ["Bash"],
        keywords: ["replacement"],
      },
    };
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-replace", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-replace") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-replace",
            sessionNum: 7,
            name: "Leader Replace",
            permissionMode: "plan",
            backendType: "claude",
          }),
        );
        return;
      }
      if (method === "POST" && url === "/api/sessions/12/replace-worktree-worker") {
        replacementBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            oldSessionId: "old-worker",
            oldSessionNum: 12,
            oldSessionName: "Old Worker",
            oldSessionLabel: "#12",
            newSessionId: "new-worker",
            recycledPath: "/wt/main-wt-1111",
            repoRoot: "/repo",
            baseBranch: "main",
            baseSha: "abcdef1234567890",
            reset: { ok: true, output: "HEAD is now at abcdef" },
          }),
        );
        return;
      }
      if (method === "POST" && url === "/api/sessions/new-worker/message") {
        messages.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/new-worker/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sessionInfoById["new-worker"]));
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
        "--replace-worktree-worker",
        "12",
        "--backend",
        "codex",
        "--permission-mode",
        "auto-review",
        "--model",
        "gpt-5.4",
        "--reasoning-effort",
        "medium",
        "--internet",
        "--cwd",
        "/repo",
        "--message-file",
        "-",
        "--json",
      ],
      {
        ...process.env,
        COMPANION_SESSION_ID: "leader-replace",
        COMPANION_AUTH_TOKEN: "auth-replace",
      },
      process.cwd(),
      "replace dispatch",
    );

    expect(result.status).toBe(0);
    expect(replacementBodies).toHaveLength(1);
    expect(replacementBodies[0]).toEqual({
      create: {
        backend: "codex",
        cwd: "/repo",
        useWorktree: true,
        createdBy: "leader-replace",
        model: "gpt-5.4",
        permissionMode: "codex-auto-review",
        codexReasoningEffort: "medium",
        codexInternetAccess: true,
      },
    });
    expect(messages).toEqual([
      {
        content: "replace dispatch",
        agentSource: { sessionId: "leader-replace", sessionLabel: "#7 Leader Replace" },
      },
    ]);
    const stdout = JSON.parse(result.stdout) as JsonObject;
    expect(stdout.replacement).toMatchObject({
      oldSessionId: "old-worker",
      newSessionId: "new-worker",
      recycledPath: "/wt/main-wt-1111",
      baseBranch: "main",
      baseSha: "abcdef1234567890",
    });
    expect(stdout.sessions).toEqual([
      expect.objectContaining({
        sessionId: "new-worker",
        sessionNum: 44,
        backendType: "codex",
        taskHistoryCount: 1,
        toolsCount: 1,
        keywordCount: 1,
      }),
    ]);
    expect((stdout.sessions as JsonObject[])[0]).not.toHaveProperty("injectedSystemPrompt");
    expect((stdout.sessions as JsonObject[])[0]).not.toHaveProperty("taskHistory");
    expect((stdout.sessions as JsonObject[])[0]).not.toHaveProperty("tools");
    expect((stdout.sessions as JsonObject[])[0]).not.toHaveProperty("keywords");

    const included = await runTakode(
      [
        "spawn",
        "--port",
        String(port),
        "--replace-worktree-worker",
        "12",
        "--backend",
        "codex",
        "--cwd",
        "/repo",
        "--json",
        "--include",
        "injectedSystemPrompt",
      ],
      {
        ...process.env,
        COMPANION_SESSION_ID: "leader-replace",
        COMPANION_AUTH_TOKEN: "auth-replace",
      },
    );

    server.close();

    expect(included.status).toBe(0);
    expect((JSON.parse(included.stdout) as { sessions: JsonObject[] }).sessions[0].injectedSystemPrompt).toBe(
      "large replacement prompt",
    );
  });

  it("updates active board rows that still point at a replaced worktree worker", async () => {
    const boardUpdates: JsonObject[] = [];
    const sessionInfoById: Record<string, JsonObject> = {
      "new-worker": {
        sessionId: "new-worker",
        sessionNum: 1952,
        name: "Fresh Worker",
        state: "running",
        backendType: "codex",
        cwd: "/wt/main-wt-1111",
        createdAt: Date.now(),
        cliConnected: true,
        isGenerating: false,
        isWorktree: true,
        actualBranch: "main-wt-1111",
      },
    };
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-replace", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-replace") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-replace", sessionNum: 1484, backendType: "codex" }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/1950/replace-worktree-worker") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            oldSessionId: "worker-old",
            oldSessionNum: 1950,
            oldSessionName: "Previous Worker",
            oldSessionLabel: "#1950",
            newSessionId: "new-worker",
            recycledPath: "/wt/main-wt-1111",
            repoRoot: "/repo",
            baseBranch: "main",
            baseSha: "abcdef1234567890",
            reset: { ok: true, output: "HEAD is now at abcdef" },
          }),
        );
        return;
      }
      if (method === "GET" && url === "/api/sessions/new-worker/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sessionInfoById["new-worker"]));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-replace/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-1452",
                title: "Update single-turn RL pipeline overview",
                worker: "worker-old",
                workerNum: 1950,
                status: "ALIGNMENT",
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          }),
        );
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-replace/board") {
        boardUpdates.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-1452",
                worker: "new-worker",
                workerNum: 1952,
                status: "ALIGNMENT",
                createdAt: 1,
                updatedAt: 3,
              },
            ],
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
      ["spawn", "--port", String(port), "--replace-worktree-worker", "1950", "--backend", "codex", "--cwd", "/repo"],
      {
        ...process.env,
        COMPANION_SESSION_ID: "leader-replace",
        COMPANION_AUTH_TOKEN: "auth-replace",
      },
    );

    server.close();

    expect(result.status).toBe(0);
    expect(boardUpdates).toEqual([{ questId: "q-1452", worker: "new-worker", workerNum: 1952 }]);
    expect(result.stdout).toContain("Replaced #1950 with #1952");
    expect(result.stdout).toContain("board=updated q-1452 worker to #1952");
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
