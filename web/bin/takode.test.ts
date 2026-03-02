import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type JsonObject = Record<string, unknown>;

function readJson(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      resolve(body ? JSON.parse(body) as JsonObject : {});
    });
  });
}

async function runTakode(
  args: string[],
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const takodePath = fileURLToPath(new URL("./takode.ts", import.meta.url));
  const child = spawn(process.execPath, [takodePath, ...args], {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  const [code] = await once(child, "close");
  return { status: code as number | null, stdout, stderr };
}

describe("takode auth fallback", () => {
  it("uses .companion/session-auth.json when env credentials are missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-auth-fallback-"));
    const companionDir = join(tmp, ".companion");
    mkdirSync(companionDir, { recursive: true });
    writeFileSync(
      join(companionDir, "session-auth.json"),
      JSON.stringify({ sessionId: "leader-file", authToken: "file-token", port: 9999 }),
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
    }
  });
});

describe("takode spawn", () => {
  it("uses defaults and includes createdBy for auto-herding", async () => {
    const createBodies: JsonObject[] = [];
    const created = [{ sessionId: "worker-1", sessionNum: 21, name: "Worker One" }];
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
        res.end(JSON.stringify({ sessionId: "leader-1", permissionMode: "plan" }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(created.shift()));
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
    // Validates default payload fields for spawn.
    expect(createBodies[0]).toEqual({
      backend: "codex",
      cwd: process.cwd(),
      useWorktree: true,
      createdBy: "leader-1",
      codexReasoningEffort: "high",
    });
    expect(result.stdout).toContain('#21 "Worker One"');
  });

  it("inherits bypass permission mode and sends initial message to each spawned session", async () => {
    const createBodies: JsonObject[] = [];
    const messageCalls: Array<{ id: string; body: JsonObject }> = [];
    const created = [
      { sessionId: "worker-a", sessionNum: 31, name: "Worker A" },
      { sessionId: "worker-b", sessionNum: 32, name: "Worker B" },
    ];

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
});

describe("takode search", () => {
  it("uses server-side session search and shows field/reason/snippet/message id", async () => {
    const searchRequests: URL[] = [];
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([
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
        ]));
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
        res.end(JSON.stringify({
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
          ],
        }));
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
    expect(result.stdout).toContain("field: message");
    expect(result.stdout).toContain("reason: message: auth token is missing in env");
    expect(result.stdout).toContain("snippet: auth token is missing in env");
    expect(result.stdout).toContain("message id: m-42 (takode peek 7 --from m-42)");
  });

  it("keeps archived sessions enabled for --all and exposes match metadata in --json output", async () => {
    const searchRequests: URL[] = [];
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([
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
        ]));
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
        res.end(JSON.stringify({
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
        }));
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
