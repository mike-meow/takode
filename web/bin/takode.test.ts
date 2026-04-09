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

describe("takode auth fallback", () => {
  it("uses centralized ~/.companion/session-auth/ when env credentials are missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-auth-fallback-"));
    const authPath = centralAuthPath(tmp, tmp);
    mkdirSync(getSessionAuthDir(tmp), { recursive: true });
    writeFileSync(
      authPath,
      JSON.stringify({ sessionId: "leader-file", authToken: "file-token", port: 9999, serverId: "test-server-id" }),
      "utf-8",
    );

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      seenHeaders.push(req.headers);
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-file", isOrchestrator: true }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/takode/sessions") {
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
        ["list", "--port", String(port), "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("[]");
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "leader-file")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "file-token")).toBe(true);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
      try {
        unlinkSync(authPath);
      } catch {}
    }
  });

  it("uses centralized session-auth port when no explicit port env or flag is provided", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-auth-port-fallback-"));
    const authPath = centralAuthPath(tmp, tmp);
    mkdirSync(getSessionAuthDir(tmp), { recursive: true });

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      seenHeaders.push(req.headers);
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-port-file", isOrchestrator: true }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/takode/sessions") {
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

    writeFileSync(
      authPath,
      JSON.stringify({ sessionId: "leader-port-file", authToken: "file-port-token", port, serverId: "test-server-id" }),
      "utf-8",
    );

    try {
      const result = await runTakode(
        ["list", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          TAKODE_API_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("[]");
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "leader-port-file")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "file-port-token")).toBe(true);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
      try {
        unlinkSync(authPath);
      } catch {}
    }
  });

  it("fails closed when multiple Companion auth contexts exist for the same cwd", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-auth-ambiguous-"));
    mkdirSync(getSessionAuthDir(tmp), { recursive: true });
    writeFileSync(
      centralAuthPath(tmp, tmp, "server-a"),
      JSON.stringify({ sessionId: "leader-a", authToken: "token-a", port: 4100, serverId: "server-a" }),
      "utf-8",
    );
    writeFileSync(
      centralAuthPath(tmp, tmp, "server-b"),
      JSON.stringify({ sessionId: "leader-b", authToken: "token-b", port: 4200, serverId: "server-b" }),
      "utf-8",
    );

    try {
      const result = await runTakode(
        ["list", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          TAKODE_API_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Multiple Companion auth contexts were found");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses the matching session-scoped auth context when multiple servers share a cwd", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-auth-session-match-"));
    mkdirSync(getSessionAuthDir(tmp), { recursive: true });
    writeFileSync(
      centralAuthPath(tmp, tmp, "server-a"),
      JSON.stringify({ sessionId: "leader-a", authToken: "token-a", port: 4301, serverId: "server-a" }),
      "utf-8",
    );

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      seenHeaders.push(req.headers);
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-b", isOrchestrator: true }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/takode/sessions") {
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

    writeFileSync(
      centralAuthPath(tmp, tmp, "server-b"),
      JSON.stringify({ sessionId: "leader-b", authToken: "token-b", port, serverId: "server-b" }),
      "utf-8",
    );

    try {
      const result = await runTakode(
        ["list", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: "leader-b",
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          TAKODE_API_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("[]");
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "leader-b")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "token-b")).toBe(true);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("takode access control", () => {
  it("allows non-orchestrator sessions to list sessions", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-list", isOrchestrator: false }));
        return;
      }
      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "worker-list",
              sessionNum: 153,
              name: "Worker List",
              state: "idle",
              archived: false,
              cwd: "/repo",
              createdAt: Date.now(),
              cliConnected: true,
            },
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

    try {
      const result = await runTakode(["list", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-list",
        COMPANION_AUTH_TOKEN: "auth-worker-list",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        expect.objectContaining({
          sessionId: "worker-list",
          sessionNum: 153,
          name: "Worker List",
        }),
      ]);
    } finally {
      server.close();
    }
  });

  it("allows non-orchestrator sessions to peek at session activity", async () => {
    const now = Date.now();
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-peek", isOrchestrator: false }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/153/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "session-153",
            sessionNum: 153,
            sessionName: "Worker Peek",
            status: "idle",
            quest: null,
            mode: "default",
            totalTurns: 1,
            totalMessages: 2,
            collapsedTurns: [],
            omittedTurnCount: 0,
            expandedTurn: {
              turnNum: 1,
              startedAt: now - 2_000,
              endedAt: now,
              durationMs: 2_000,
              messages: [
                { idx: 0, type: "user", content: "check status", ts: now - 2_000 },
                { idx: 1, type: "result", content: "all good", ts: now, success: true },
              ],
              stats: { tools: 0, messages: 2, subagents: 0 },
              omittedMessageCount: 0,
            },
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

    try {
      const result = await runTakode(["peek", "153", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-peek",
        COMPANION_AUTH_TOKEN: "auth-worker-peek",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          sessionNum: 153,
          sessionName: "Worker Peek",
          mode: "default",
        }),
      );
    } finally {
      server.close();
    }
  });

  it("passes inclusive backward peek paging through to the server", async () => {
    const requestUrls: string[] = [];
    const server = createServer((req, res) => {
      requestUrls.push(req.url || "");
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-peek-until", isOrchestrator: false }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/153/messages?count=2&until=4") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "session-153",
            sessionNum: 153,
            sessionName: "Worker Peek",
            status: "idle",
            quest: null,
            mode: "range",
            totalMessages: 5,
            from: 3,
            to: 4,
            messages: [
              { idx: 3, type: "assistant", content: "done", ts: 1_700_000_000_000 },
              { idx: 4, type: "result", content: "ok", ts: 1_700_000_000_500, success: true },
            ],
            turnBoundaries: [{ turnNum: 1, startIdx: 2, endIdx: 4 }],
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

    try {
      const result = await runTakode(
        ["peek", "153", "--until", "4", "--count", "2", "--json", "--port", String(port)],
        {
          ...process.env,
          COMPANION_SESSION_ID: "worker-peek-until",
          COMPANION_AUTH_TOKEN: "auth-worker-peek-until",
        },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          mode: "range",
          from: 3,
          to: 4,
        }),
      );
      expect(requestUrls).toEqual(["/api/takode/me", "/api/sessions/153/messages?count=2&until=4"]);
    } finally {
      server.close();
    }
  });

  it("keeps herd messaging restricted to orchestrator sessions", async () => {
    const requestUrls: string[] = [];
    const server = createServer((req, res) => {
      requestUrls.push(req.url || "");
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-send", isOrchestrator: false }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["send", "153", "please", "retry", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-send",
        COMPANION_AUTH_TOKEN: "auth-worker-send",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("takode commands require an orchestrator session.");
      expect(requestUrls).toEqual(["/api/takode/me"]);
    } finally {
      server.close();
    }
  });
});

describe("takode send", () => {
  it("keeps the positional message form for short manual sends", async () => {
    const messageCalls: Array<{ id: string; body: JsonObject }> = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-send", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-send") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-send", sessionNum: 7, name: "Worker Send", isGenerating: false }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-send/herd") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ sessionId: "worker-send" }]));
        return;
      }
      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ sessionId: "leader-send", sessionNum: 1, name: "Leader Send" }]));
        return;
      }
      if (method === "POST" && url === "/api/sessions/worker-send/message") {
        messageCalls.push({ id: "worker-send", body: await readJson(req) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId: "worker-send" }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["send", "worker-send", "Please", "add", "tests", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-send",
        COMPANION_AUTH_TOKEN: "auth-send",
      });

      expect(result.status).toBe(0);
      expect(messageCalls).toEqual([
        {
          id: "worker-send",
          body: {
            content: "Please add tests",
            agentSource: { sessionId: "leader-send", sessionLabel: "#1 Leader Send" },
          },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it("reads multiline shell-sensitive content from --stdin without mangling it", async () => {
    const messageCalls: Array<{ id: string; body: JsonObject }> = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-stdin", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-stdin") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ sessionId: "worker-stdin", sessionNum: 9, name: "Worker Stdin", isGenerating: false }),
        );
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-stdin/herd") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ sessionId: "worker-stdin" }]));
        return;
      }
      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ sessionId: "leader-stdin", sessionNum: 2, name: "Leader Stdin" }]));
        return;
      }
      if (method === "POST" && url === "/api/sessions/worker-stdin/message") {
        messageCalls.push({ id: "worker-stdin", body: await readJson(req) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId: "worker-stdin" }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const stdinMessage = "First line with $HOME\nSecond line with `code`\n";

    try {
      const result = await runTakode(
        ["send", "worker-stdin", "--stdin", "--port", String(port)],
        {
          ...process.env,
          COMPANION_SESSION_ID: "leader-stdin",
          COMPANION_AUTH_TOKEN: "auth-stdin",
        },
        process.cwd(),
        stdinMessage,
      );

      expect(result.status).toBe(0);
      expect(messageCalls).toEqual([
        {
          id: "worker-stdin",
          body: {
            content: stdinMessage,
            agentSource: { sessionId: "leader-stdin", sessionLabel: "#2 Leader Stdin" },
          },
        },
      ]);
    } finally {
      server.close();
    }
  });
});

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
        res.end(JSON.stringify({ sessionId: "leader-2", permissionMode: "bypassPermissions" }));
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
          agentSource: { sessionId: "leader-2" },
        },
      },
      {
        id: "worker-b",
        body: {
          content: "run smoke tests",
          agentSource: { sessionId: "leader-2" },
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

describe("takode info", () => {
  it("prints codex metadata from the enriched session info shape", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-info", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-info/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-info",
            sessionNum: 52,
            name: "Info Worker",
            state: "running",
            backendType: "codex",
            model: "gpt-5.4",
            cwd: "/tmp/info-worker",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            permissionMode: "bypassPermissions",
            askPermission: false,
            isWorktree: true,
            branch: "jiayi",
            actualBranch: "jiayi-wt-7173",
            codexReasoningEffort: "high",
            codexInternetAccess: true,
            codexSandbox: "danger-full-access",
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

    const result = await runTakode(["info", "worker-info", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-info",
      COMPANION_AUTH_TOKEN: "auth-info",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Backend        codex  model: gpt-5.4");
    expect(result.stdout).toContain("Permissions    bypassPermissions");
    expect(result.stdout).toContain("Ask Mode       no-ask");
    expect(result.stdout).toContain("Internet       enabled");
    expect(result.stdout).toContain("Reasoning      high");
    expect(result.stdout).toContain("Sandbox        danger-full-access");
    expect(result.stdout).toContain("Worktree       yes");
    expect(result.stdout).toContain("WT Branch      jiayi");
    expect(result.stdout).toContain("Actual Branch  jiayi-wt-7173");
  });
});

describe("takode search", () => {
  it("uses server-side session search, excludes exited by default, and shows field/reason/snippet/message id", async () => {
    const searchRequests: URL[] = [];
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "worker-1",
              sessionNum: 7,
              name: "Auth worker",
              state: "idle",
              archived: false,
              cwd: "/repo",
              createdAt: Date.now() - 60_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: true,
            },
            {
              sessionId: "worker-exited",
              sessionNum: 70,
              name: "Exited worker",
              state: "exited",
              archived: false,
              cwd: "/repo",
              createdAt: Date.now() - 60_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: false,
            },
          ]),
        );
        return;
      }
      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url.startsWith("/api/sessions/search?")) {
        const parsed = new URL(`http://localhost${url}`);
        searchRequests.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            query: parsed.searchParams.get("q"),
            tookMs: 2,
            totalMatches: 1,
            results: [
              {
                sessionId: "worker-1",
                score: 500,
                matchedField: "user_message",
                matchContext: "message: auth token is missing in env",
                matchedAt: Date.now() - 5000,
                messageMatch: {
                  id: "m-42",
                  timestamp: Date.now() - 5000,
                  snippet: "auth token is missing in env",
                },
              },
              {
                sessionId: "worker-exited",
                score: 480,
                matchedField: "name",
                matchContext: "name: Exited worker",
                matchedAt: Date.now() - 3000,
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

    const result = await runTakode(["search", "auth", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.searchParams.get("q")).toBe("auth");
    expect(searchRequests[0]?.searchParams.get("includeArchived")).toBe("false");
    expect(result.stdout).not.toContain("Exited worker");
    expect(result.stdout).toContain("field: message");
    expect(result.stdout).toContain("reason: message: auth token is missing in env");
    expect(result.stdout).toContain("snippet: auth token is missing in env");
    expect(result.stdout).toContain("message id: m-42 (takode peek 7 --from m-42)");
  });

  it("drops stale search rows when session id is missing from takode session list", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }
      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url.startsWith("/api/sessions/search?")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            query: "auth",
            tookMs: 2,
            totalMatches: 1,
            results: [
              {
                sessionId: "deleted-worker",
                score: 500,
                matchedField: "user_message",
                matchContext: "message: should not render",
                matchedAt: Date.now() - 5000,
                messageMatch: {
                  id: "m-stale-1",
                  timestamp: Date.now() - 5000,
                  snippet: "should not render",
                },
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

    const result = await runTakode(["search", "auth", "--json", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("keeps archived sessions enabled for --all and exposes match metadata in --json output", async () => {
    const searchRequests: URL[] = [];
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "worker-2",
              sessionNum: 8,
              name: "Legacy auth run",
              state: "exited",
              archived: true,
              cwd: "/repo",
              createdAt: Date.now() - 120_000,
              lastActivityAt: Date.now() - 120_000,
              cliConnected: false,
            },
          ]),
        );
        return;
      }
      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url.startsWith("/api/sessions/search?")) {
        const parsed = new URL(`http://localhost${url}`);
        searchRequests.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            query: parsed.searchParams.get("q"),
            tookMs: 2,
            totalMatches: 1,
            results: [
              {
                sessionId: "worker-2",
                score: 1000,
                matchedField: "name",
                matchContext: null,
                matchedAt: Date.now() - 120000,
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

    const result = await runTakode(["search", "auth", "--all", "--json", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.searchParams.get("q")).toBe("auth");
    expect(searchRequests[0]?.searchParams.get("includeArchived")).toBeNull();
    const parsed = JSON.parse(result.stdout) as Array<{
      sessionId: string;
      matchedField: string;
      messageId: string | null;
      snippet: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      sessionId: "worker-2",
      matchedField: "name",
      messageId: null,
      snippet: "Legacy auth run",
    });
  });
});

describe("takode output escaping", () => {
  it("escapes control characters in list output without breaking row layout", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-list", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "worker-list",
              sessionNum: 12,
              name: "Worker\nName\tA",
              state: "idle",
              archived: false,
              cwd: "/repo/project",
              createdAt: Date.now() - 10_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: true,
              lastMessagePreview: "hello\nworld\t\x1b[31mred",
            },
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

    try {
      const result = await runTakode(["list", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-list",
        COMPANION_AUTH_TOKEN: "auth-list",
      });

      expect(result.status).toBe(0);
      // These fields used to leak raw newlines/tabs/escape bytes into the table output.
      expect(result.stdout).toContain("Worker\\nName\\tA");
      expect(result.stdout).toContain('"hello\\nworld\\t\\x1b[31mred"');
      expect(result.stdout).not.toContain("Worker\nName\tA");
      expect(result.stdout).not.toContain("hello\nworld\t");
      expect(result.stdout).not.toContain("\x1b[31m");
    } finally {
      server.close();
    }
  });

  it("escapes special characters in pending question and plan output", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-pending", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-pending/pending") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            pending: [
              {
                request_id: "req-1",
                tool_name: "AskUserQuestion",
                timestamp: Date.now(),
                questions: [
                  {
                    question: "Pick\none\tplease",
                    options: [{ label: "A\t1", description: "first\noption" }],
                  },
                ],
              },
              {
                request_id: "req-2",
                tool_name: "ExitPlanMode",
                timestamp: Date.now(),
                plan: "Line 1\nLine 2\t\x1b[31mred",
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

    try {
      const result = await runTakode(["pending", "worker-pending", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-pending",
        COMPANION_AUTH_TOKEN: "auth-pending",
      });

      expect(result.status).toBe(0);
      // Pending output should stay readable and single-line per entry even with hostile content.
      expect(result.stdout).toContain("[AskUserQuestion] Pick\\none\\tplease");
      expect(result.stdout).toContain("1. A\\t1 -- first\\noption");
      expect(result.stdout).toContain("Line 1\\nLine 2\\t\\x1b[31mred");
      expect(result.stdout).not.toContain("Pick\none\tplease");
      expect(result.stdout).not.toContain("first\noption");
      expect(result.stdout).not.toContain("\x1b[31m");
    } finally {
      server.close();
    }
  });

  it("escapes search headings and match metadata from user-controlled content", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "worker-search",
              sessionNum: 14,
              name: "Search\nWorker",
              state: "idle",
              archived: false,
              cwd: "/repo",
              createdAt: Date.now() - 60_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: true,
            },
          ]),
        );
        return;
      }
      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-search", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url.startsWith("/api/sessions/search?")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            query: "auth\nneedle",
            tookMs: 2,
            totalMatches: 1,
            results: [
              {
                sessionId: "worker-search",
                score: 500,
                matchedField: "user_message",
                matchContext: "message: reason\nwith\tcontrol",
                matchedAt: Date.now() - 5000,
                messageMatch: {
                  id: "m-42\nextra",
                  timestamp: Date.now() - 5000,
                  snippet: "snippet\tvalue",
                },
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

    try {
      const result = await runTakode(["search", "auth\nneedle", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-search",
        COMPANION_AUTH_TOKEN: "auth-search",
      });

      expect(result.status).toBe(0);
      // Search output mixes query, session fields, and match metadata in one formatted block.
      expect(result.stdout).toContain('matching "auth\\nneedle"');
      expect(result.stdout).toContain("Search\\nWorker");
      expect(result.stdout).toContain("reason: message: reason\\nwith\\tcontrol");
      expect(result.stdout).toContain("message id: m-42\\nextra (takode peek 14 --from m-42\\nextra)");
      expect(result.stdout).not.toContain("Search\nWorker");
      expect(result.stdout).not.toContain("reason: message: reason\nwith\tcontrol");
    } finally {
      server.close();
    }
  });

  it("escapes read output lines instead of printing raw control characters", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-read", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-read/messages/msg-1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            idx: 41,
            type: "user_message\nraw",
            ts: Date.now(),
            totalLines: 2,
            offset: 0,
            limit: 200,
            content: "first\tline\nsecond \x1b[31mline",
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

    try {
      const result = await runTakode(["read", "worker-read", "msg-1", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-read",
        COMPANION_AUTH_TOKEN: "auth-read",
      });

      expect(result.status).toBe(0);
      // Read keeps real line boundaries, but each rendered line should escape tabs/control bytes.
      expect(result.stdout).toContain("[msg 41] user_message\\nraw -- ");
      expect(result.stdout).toContain("1  first\\tline");
      expect(result.stdout).toContain("2  second \\x1b[31mline");
      expect(result.stdout).not.toContain("first\tline");
      expect(result.stdout).not.toContain("\x1b[31m");
    } finally {
      server.close();
    }
  });
});

describe("takode watch deprecation", () => {
  it("does not advertise watch in help output", async () => {
    const result = await runTakode(["--help"], {
      ...process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("watch");
  });

  it("fails with unknown command for deprecated watch", async () => {
    const result = await runTakode(["watch", "--sessions", "1"], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: watch");
    expect(result.stdout).toContain("Usage: takode <command>");
  });
});

describe("takode board quest ID validation", () => {
  // CLI-side validation rejects invalid quest IDs before making any board API call.
  // A mock server is needed because the CLI calls /api/takode/me for auth before
  // reaching board-specific validation in handleBoard().

  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/takode/me") {
        // Auth check: return a minimal valid response so the CLI proceeds to handleBoard
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  it.each(["foo", "123", "q-", "q-abc", "set"])("board set rejects invalid quest ID: %j", async (badId) => {
    const result = await runTakode(["board", "set", badId, "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("q-NNN");
  });

  it("board set rejects missing quest ID with usage hint", async () => {
    const result = await runTakode(["board", "set", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage");
  });

  it.each(["foo", "123", "q-"])("board advance rejects invalid quest ID: %j", async (badId) => {
    const result = await runTakode(["board", "advance", badId, "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("q-NNN");
  });

  it.each(["foo", "q-abc"])("board rm rejects invalid quest ID: %j", async (badId) => {
    const result = await runTakode(["board", "rm", badId, "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("q-NNN");
  });
});

describe("takode list reviewer nesting", () => {
  // Verifies that reviewer sessions are nested under their parent worker
  // in the CWD group, the group header count excludes reviewers, and
  // orphaned reviewers (parent not visible) fall back to their own CWD group.

  it("nests reviewer under parent and excludes reviewer from group count", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-nest", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "worker-a",
              sessionNum: 10,
              name: "Fix tree view",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 20_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: true,
            },
            {
              sessionId: "reviewer-a",
              sessionNum: 11,
              name: "Reviewer of #10",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 10_000,
              lastActivityAt: Date.now() - 3_000,
              cliConnected: true,
              reviewerOf: 10,
            },
            {
              sessionId: "worker-b",
              sessionNum: 12,
              name: "Fix quest styling",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 15_000,
              lastActivityAt: Date.now() - 8_000,
              cliConnected: true,
            },
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

    try {
      const result = await runTakode(["list", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-nest",
        COMPANION_AUTH_TOKEN: "auth-nest",
      });

      expect(result.status).toBe(0);

      // Group header should show 2 (two workers), not 3 (which would include the reviewer)
      expect(result.stdout).toMatch(/▸\s+companion\s+2/);
      expect(result.stdout).not.toMatch(/▸\s+companion\s+3/);

      // Reviewer should be visually nested with ↳ prefix on the same line as its name
      expect(result.stdout).toMatch(/↳.*#11.*Reviewer of #10/);

      // Reviewer has [reviewer] role tag
      expect(result.stdout).toContain("[reviewer]");

      // Both workers should appear as top-level entries
      expect(result.stdout).toContain("#10");
      expect(result.stdout).toContain("#12");

      // Reviewer appears after its parent in output (nesting order)
      const lines = result.stdout.split("\n");
      const parentIdx = lines.findIndex((l) => l.includes("#10") && !l.includes("↳"));
      const reviewerIdx = lines.findIndex((l) => l.includes("#11") && l.includes("↳"));
      expect(parentIdx).toBeGreaterThanOrEqual(0);
      expect(reviewerIdx).toBeGreaterThan(parentIdx);
    } finally {
      server.close();
    }
  });

  it("falls back orphaned reviewer to its own CWD group", async () => {
    // When the reviewer's parent is not in the session list (e.g. archived
    // or filtered out), the reviewer should fall back to its own CWD key
    // rather than disappearing.
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-orphan", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "orphan-reviewer",
              sessionNum: 20,
              name: "Reviewer of #99",
              state: "idle",
              archived: false,
              cwd: "/repo/other-project",
              createdAt: Date.now() - 10_000,
              lastActivityAt: Date.now() - 3_000,
              cliConnected: true,
              reviewerOf: 99, // parent #99 is not in the list
            },
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

    try {
      const result = await runTakode(["list", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-orphan",
        COMPANION_AUTH_TOKEN: "auth-orphan",
      });

      expect(result.status).toBe(0);

      // Orphaned reviewer appears under its own CWD group with correct header.
      // The header count is 0 top-level sessions (the reviewer is still a reviewer),
      // but the reviewer is rendered as an orphan inside printNestedSessions.
      expect(result.stdout).toMatch(/▸\s+other-project\s+0/);
      expect(result.stdout).toMatch(/↳.*Reviewer of #99/);
    } finally {
      server.close();
    }
  });
});
