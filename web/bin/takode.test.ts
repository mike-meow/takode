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
            sid: "session-153",
            sn: 153,
            name: "Worker Peek",
            status: "idle",
            quest: null,
            mode: "default",
            totalTurns: 1,
            totalMessages: 2,
            collapsed: [],
            omitted: 0,
            expanded: {
              turn: 1,
              start: now - 2_000,
              end: now,
              dur: 2_000,
              messages: [
                { idx: 0, type: "user", content: "check status", ts: now - 2_000 },
                { idx: 1, type: "result", content: "all good", ts: now, success: true },
              ],
              stats: { tools: 0, messages: 2, subagents: 0 },
              omittedMsgs: 0,
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
          sn: 153,
          name: "Worker Peek",
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
            sid: "session-153",
            sn: 153,
            name: "Worker Peek",
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
            bounds: [{ turn: 1, si: 2, ei: 4 }],
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

describe("takode logs", () => {
  it("prints filtered structured logs from the server", async () => {
    // Verifies the human-readable CLI formatter and basic filter passthrough for non-follow mode.
    const requestUrls: string[] = [];
    const server = createServer((req, res) => {
      requestUrls.push(req.url || "");
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-logs", isOrchestrator: false }));
        return;
      }
      if (method === "GET" && url === "/api/logs?level=warn%2Cerror&component=ws-bridge&limit=200") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            entries: [
              {
                ts: 1_700_000_000_000,
                isoTime: "2024-11-14T22:13:20.000Z",
                level: "warn",
                component: "ws-bridge",
                message: "Permission required",
                pid: 123,
                seq: 1,
              },
              {
                ts: 1_700_000_001_000,
                isoTime: "2024-11-14T22:13:21.000Z",
                level: "error",
                component: "ws-bridge",
                message: "Reconnect failed",
                sessionId: "session-7",
                pid: 123,
                seq: 2,
              },
            ],
            availableComponents: ["ws-bridge"],
            logFile: "/tmp/server-3456.jsonl",
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
        ["logs", "--level", "warn,error", "--component", "ws-bridge", "--port", String(port)],
        {
          ...process.env,
          COMPANION_SESSION_ID: "worker-logs",
          COMPANION_AUTH_TOKEN: "auth-worker-logs",
        },
      );

      expect(result.status).toBe(0);
      expect(requestUrls).toEqual(["/api/takode/me", "/api/logs?level=warn%2Cerror&component=ws-bridge&limit=200"]);
      expect(result.stdout).toContain("WARN");
      expect(result.stdout).toContain("ERROR");
      expect(result.stdout).toContain("Permission required");
      expect(result.stdout).toContain("Reconnect failed");
      expect(result.stdout).toContain("session=session-7");
    } finally {
      server.close();
    }
  });

  it("prints JSON results verbatim when --json is set", async () => {
    // Guards the machine-readable branch used by agents and scripts consuming structured log output.
    const payload = {
      entries: [
        {
          ts: 1_700_000_000_000,
          isoTime: "2024-11-14T22:13:20.000Z",
          level: "info",
          component: "server",
          message: "boot",
          pid: 123,
          seq: 1,
        },
      ],
      availableComponents: ["server"],
      logFile: "/tmp/server-3456.jsonl",
    };
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-json-logs", isOrchestrator: false }));
        return;
      }
      if (method === "GET" && url === "/api/logs?limit=200") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["logs", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-json-logs",
        COMPANION_AUTH_TOKEN: "auth-worker-json-logs",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(payload);
    } finally {
      server.close();
    }
  });

  it("streams live log entries when --follow is set", async () => {
    // Follow mode should use the atomic stream endpoint with a snapshot tail instead of a separate GET.
    const requestUrls: string[] = [];
    const server = createServer((req, res) => {
      requestUrls.push(req.url || "");
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-follow-logs", isOrchestrator: false }));
        return;
      }
      if (method === "GET" && url === "/api/logs/stream?level=error&limit=200&tail=200") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: entry\n");
        res.write(
          'data: {"ts":1700000001000,"isoTime":"2024-11-14T22:13:21.000Z","level":"error","component":"server","message":"Snapshot failure","pid":123,"seq":2}\n\n',
        );
        res.write("event: ready\n");
        res.write('data: {"ok":true,"availableComponents":["server"],"logFile":"/tmp/server-3456.jsonl"}\n\n');
        res.write("event: entry\n");
        res.write(
          'data: {"ts":1700000002000,"isoTime":"2024-11-14T22:13:22.000Z","level":"error","component":"server","message":"Live failure","pid":123,"seq":3}\n\n',
        );
        res.end();
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["logs", "--level", "error", "--follow", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-follow-logs",
        COMPANION_AUTH_TOKEN: "auth-worker-follow-logs",
      });

      expect(result.status).toBe(0);
      expect(requestUrls).toEqual(["/api/takode/me", "/api/logs/stream?level=error&limit=200&tail=200"]);
      expect(result.stdout).toContain("Snapshot failure");
      expect(result.stdout).toContain("Live failure");
      expect(result.stdout).toContain("ERROR");
    } finally {
      server.close();
    }
  });

  it("fails fast when the server rejects an invalid regex filter", async () => {
    // Invalid regex should surface as an error instead of silently printing 'No matching logs.'
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-invalid-regex", isOrchestrator: false }));
        return;
      }
      if (method === "GET" && url === "/api/logs?pattern=%28&regex=1&limit=200") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid log regex: (" }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["logs", "--pattern", "(", "--regex", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-invalid-regex",
        COMPANION_AUTH_TOKEN: "auth-worker-invalid-regex",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid log regex: (");
    } finally {
      server.close();
    }
  });

  it("streams JSON entries verbatim in follow mode when --json is set", async () => {
    // Follow-mode JSON is used by automation, so it should emit raw NDJSON-style entries instead of text formatting.
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-follow-json-logs", isOrchestrator: false }));
        return;
      }
      if (method === "GET" && url === "/api/logs/stream?level=warn&limit=200&tail=200") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: entry\n");
        res.write(
          'data: {"ts":1700000003000,"isoTime":"2024-11-14T22:13:23.000Z","level":"warn","component":"server","message":"JSON warning","pid":123,"seq":4}\n\n',
        );
        res.write("event: ready\n");
        res.write('data: {"ok":true,"availableComponents":["server"],"logFile":"/tmp/server-3456.jsonl"}\n\n');
        res.end();
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["logs", "--level", "warn", "--follow", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-follow-json-logs",
        COMPANION_AUTH_TOKEN: "auth-worker-follow-json-logs",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"message":"JSON warning"');
      expect(result.stdout).not.toContain("WARN ");
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

  it("fails clearly for archived target sessions before attempting delivery", async () => {
    let posted = false;
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-archived", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/reviewer-archived") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "reviewer-archived",
            sessionNum: 14,
            name: "Reviewer Archived",
            archived: true,
            isGenerating: false,
          }),
        );
        return;
      }
      if (method === "POST" && url === "/api/sessions/reviewer-archived/message") {
        posted = true;
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

    try {
      const result = await runTakode(["send", "reviewer-archived", "ping", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-archived",
        COMPANION_AUTH_TOKEN: "auth-archived",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Cannot send to archived session #14 Reviewer Archived.");
      expect(posted).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("takode herd", () => {
  it("fails clearly on non-force herd conflicts and suggests force takeover", async () => {
    // Ordinary herd conflicts should stay non-force, exit nonzero, and tell the
    // user exactly how to retry if they intend a takeover.
    const herdBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-conflict", isOrchestrator: true }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-conflict/herd") {
        herdBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            herded: [],
            notFound: [],
            conflicts: [{ id: "worker-conflict", herder: "leader-old" }],
            reassigned: [],
            leaders: [],
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
      const result = await runTakode(["herd", "worker-conflict", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-conflict",
        COMPANION_AUTH_TOKEN: "auth-conflict",
      });

      expect(result.status).toBe(1);
      expect(herdBodies).toEqual([{ workerIds: ["worker-conflict"] }]);
      expect(result.stdout).toContain("Conflict: worker-conflict already herded by leader-old");
      expect(result.stderr).toContain("takode herd --force worker-conflict");
    } finally {
      server.close();
    }
  });

  it("keeps json herd conflicts machine-readable while still exiting nonzero", async () => {
    // JSON mode should preserve the raw herd payload on stdout while still
    // failing the command when a non-force conflict is reported.
    const herdBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-conflict-json", isOrchestrator: true }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-conflict-json/herd") {
        herdBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            herded: [],
            notFound: [],
            conflicts: [{ id: "worker-conflict-json", herder: "leader-old" }],
            reassigned: [],
            leaders: [],
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
      const result = await runTakode(["herd", "worker-conflict-json", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-conflict-json",
        COMPANION_AUTH_TOKEN: "auth-conflict-json",
      });

      expect(result.status).toBe(1);
      expect(herdBodies).toEqual([{ workerIds: ["worker-conflict-json"] }]);
      expect(JSON.parse(result.stdout)).toEqual({
        herded: [],
        notFound: [],
        conflicts: [{ id: "worker-conflict-json", herder: "leader-old" }],
        reassigned: [],
        leaders: [],
      });
      expect(result.stderr).toContain("takode herd --force worker-conflict-json");
    } finally {
      server.close();
    }
  });

  it("passes force through to the herd API and prints reassignment details", async () => {
    // Force herd must stay opt-in on the CLI surface and should print the
    // reassignment summary when the server reports a takeover.
    const herdBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-force", isOrchestrator: true }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-force/herd") {
        herdBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            herded: ["worker-force"],
            notFound: [],
            conflicts: [],
            reassigned: [{ id: "worker-force", fromLeader: "leader-old" }],
            leaders: [],
          }),
        );
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-force/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-force",
            sessionNum: 17,
            name: "Worker Force",
            state: "running",
            cwd: "/tmp/worker-force",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
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
      const result = await runTakode(["herd", "--force", "worker-force", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-force",
        COMPANION_AUTH_TOKEN: "auth-force",
      });

      expect(result.status).toBe(0);
      expect(herdBodies).toEqual([{ workerIds: ["worker-force"], force: true }]);
      expect(result.stdout).toContain("Herded 1 session(s)");
      expect(result.stdout).toContain("Reassigned worker-force from leader-old");
    } finally {
      server.close();
    }
  });

  it("keeps ordinary takode herd requests non-force by default", async () => {
    // The default CLI path must not silently add force, otherwise normal
    // conflict behavior would be impossible to preserve.
    const herdBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-plain", isOrchestrator: true }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-plain/herd") {
        herdBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            herded: ["worker-plain"],
            notFound: [],
            conflicts: [],
            reassigned: [],
            leaders: [],
          }),
        );
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-plain/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-plain",
            sessionNum: 18,
            name: "Worker Plain",
            state: "running",
            cwd: "/tmp/worker-plain",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
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
      const result = await runTakode(["herd", "worker-plain", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-plain",
        COMPANION_AUTH_TOKEN: "auth-plain",
      });

      expect(result.status).toBe(0);
      expect(herdBodies).toEqual([{ workerIds: ["worker-plain"] }]);
      expect(result.stdout).toContain("Herded 1 session(s)");
      expect(result.stdout).not.toContain("Reassigned");
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
            pendingTimerCount: 3,
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
    expect(result.stdout).toContain("Timers         3 pending");
  });
});

describe("takode list timer counts", () => {
  it("shows pending timer counts in session rows", async () => {
    // Verifies list output surfaces the server-reported pending timer count for
    // each visible session, including the zero-count case.
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-timers", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "leader-timers",
              sessionNum: 1,
              name: "Leader",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 50_000,
              lastActivityAt: Date.now() - 10_000,
              cliConnected: true,
              isOrchestrator: true,
            },
            {
              sessionId: "worker-with-timers",
              sessionNum: 10,
              name: "Timer Worker",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 40_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: true,
              herdedBy: "leader-timers",
              pendingTimerCount: 2,
            },
            {
              sessionId: "worker-no-timers",
              sessionNum: 11,
              name: "No Timer Worker",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 30_000,
              lastActivityAt: Date.now() - 8_000,
              cliConnected: true,
              herdedBy: "leader-timers",
              pendingTimerCount: 0,
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
        COMPANION_SESSION_ID: "leader-timers",
        COMPANION_AUTH_TOKEN: "auth-timers",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/#10.*⏰2/);
      expect(result.stdout).toMatch(/#11.*⏰0/);
    } finally {
      server.close();
    }
  });
});

describe("takode timers", () => {
  it("creates timers with separate title and description", async () => {
    // Verifies timer creation sends the new title + description payload shape and
    // keeps the success output centered on the concise title.
    let receivedBody: Record<string, unknown> | null = null;
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-self", isOrchestrator: false }));
        return;
      }

      if (method === "POST" && url === "/api/sessions/worker-self/timers") {
        let raw = "";
        req.on("data", (chunk) => {
          raw += String(chunk);
        });
        req.on("end", () => {
          receivedBody = JSON.parse(raw);
          res.writeHead(201, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              timer: {
                id: "t1",
                sessionId: "worker-self",
                title: "Check build health",
                description: "Inspect the latest failing shard if the build is red.",
                type: "delay",
                originalSpec: "30m",
                nextFireAt: Date.now() + 30 * 60 * 1000,
                createdAt: Date.now(),
                fireCount: 0,
              },
            }),
          );
        });
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
        [
          "timer",
          "create",
          "Check build health",
          "--desc",
          "Inspect the latest failing shard if the build is red.",
          "--in",
          "30m",
          "--port",
          String(port),
        ],
        {
          ...process.env,
          COMPANION_SESSION_ID: "worker-self",
          COMPANION_AUTH_TOKEN: "auth-self",
        },
      );

      expect(result.status).toBe(0);
      expect(receivedBody).toEqual({
        title: "Check build health",
        description: "Inspect the latest failing shard if the build is red.",
        in: "30m",
      });
      expect(result.stdout).toContain('Created timer t1 (delay): "Check build health"');
      expect(result.stdout).toContain("Description: Inspect the latest failing shard if the build is red.");
    } finally {
      server.close();
    }
  });

  it("inspects timers for another session", async () => {
    // Verifies the cross-session inspection command renders timer schedule,
    // next fire time, and recurrence metadata without relying on the current session.
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-watch", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-77/timers") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            timers: [
              {
                id: "t1",
                sessionId: "worker-77",
                title: "Check build health",
                description: "Inspect the latest failing shard if the build is red.",
                type: "delay",
                originalSpec: "30m",
                nextFireAt: Date.now() + 30 * 60 * 1000,
                createdAt: Date.now(),
                fireCount: 0,
              },
              {
                id: "t2",
                sessionId: "worker-77",
                title: "Refresh context",
                description: "Summarize blockers added since the last run.",
                type: "recurring",
                originalSpec: "10m",
                nextFireAt: Date.now() + 10 * 60 * 1000,
                createdAt: Date.now(),
                fireCount: 4,
                lastFiredAt: Date.now() - 60 * 1000,
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
      const result = await runTakode(["timers", "worker-77", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-watch",
        COMPANION_AUTH_TOKEN: "auth-watch",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Pending timers for worker-77 (2):");
      expect(result.stdout).toContain("t1  in 30m");
      expect(result.stdout).toContain("t2  every 10m");
      expect(result.stdout).toContain("last=");
      expect(result.stdout).toContain('"Refresh context"');
      expect(result.stdout).toContain("Summarize blockers added since the last run.");
    } finally {
      server.close();
    }
  });

  it("prints the empty-state message when a session has no timers", async () => {
    // Verifies the advertised human-readable empty branch for cross-session timer
    // inspection instead of treating an empty payload as a rendering failure.
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-empty", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-empty/timers") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ timers: [] }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["timers", "worker-empty", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-empty",
        COMPANION_AUTH_TOKEN: "auth-empty",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No pending timers for worker-empty.");
    } finally {
      server.close();
    }
  });

  it("returns raw timer data in json mode", async () => {
    // Verifies the machine-readable branch so orchestrator scripts can consume
    // the same session-level timer inspection command without parsing prose.
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-json", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-json/timers") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            timers: [
              {
                id: "t3",
                sessionId: "worker-json",
                title: "JSON branch",
                description: "Machine-readable timer detail",
                type: "at",
                originalSpec: "3pm",
                nextFireAt: 1_700_000_123_000,
                createdAt: 1_700_000_000_000,
                fireCount: 1,
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
      const result = await runTakode(["timers", "worker-json", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-json",
        COMPANION_AUTH_TOKEN: "auth-json",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        timers: [
          {
            id: "t3",
            sessionId: "worker-json",
            title: "JSON branch",
            description: "Machine-readable timer detail",
            type: "at",
            originalSpec: "3pm",
            nextFireAt: 1_700_000_123_000,
            createdAt: 1_700_000_000_000,
            fireCount: 1,
          },
        ],
      });
    } finally {
      server.close();
    }
  });
});

describe("takode peek/scan timer counts", () => {
  it("shows pending timer count in peek header", async () => {
    // Regression: peek is a state-bearing Takode surface and must include the
    // pending timer count in its session header, not just list/info.
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-peek-timers", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Peek Worker",
            status: "idle",
            pendingTimerCount: 2,
            quest: null,
            mode: "default",
            totalTurns: 0,
            totalMessages: 0,
            collapsed: [],
            omitted: 0,
            expanded: null,
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
      const result = await runTakode(["peek", "153", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-peek-timers",
        COMPANION_AUTH_TOKEN: "auth-peek-timers",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Session #153 "Peek Worker" -- idle  ⏰2');
    } finally {
      server.close();
    }
  });

  it("shows pending timer count in scan header", async () => {
    // Regression: scan reuses the shared session header, so timer visibility
    // must remain present there as well.
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-scan-timers", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Scan Worker",
            status: "running",
            pendingTimerCount: 1,
            quest: null,
            mode: "turn_scan",
            totalTurns: 1,
            totalMessages: 3,
            from: 0,
            count: 1,
            turns: [
              {
                turn: 0,
                si: 0,
                ei: 2,
                start: Date.now() - 60_000,
                end: Date.now() - 30_000,
                dur: 30_000,
                stats: { tools: 0, messages: 3, subagents: 0 },
                result: "done",
                user: "scan session",
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
      const result = await runTakode(["scan", "153", "--from", "0", "--count", "1", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-scan-timers",
        COMPANION_AUTH_TOKEN: "auth-scan-timers",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Session #153 "Scan Worker" -- running  ⏰1');
    } finally {
      server.close();
    }
  });

  it("uses a zero-count scan probe to fetch metadata before the real default scan page", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";
      requests.push(`${method} ${url}`);

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-scan-probe", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Scan Worker",
            status: "idle",
            quest: null,
            mode: "turn_scan",
            totalTurns: 2,
            totalMessages: 6,
            from: 0,
            count: 0,
            turns: [],
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=50") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Scan Worker",
            status: "idle",
            quest: null,
            mode: "turn_scan",
            totalTurns: 2,
            totalMessages: 6,
            from: 0,
            count: 2,
            turns: [
              {
                turn: 0,
                si: 0,
                ei: 2,
                start: Date.now() - 120_000,
                end: Date.now() - 90_000,
                dur: 30_000,
                stats: { tools: 0, messages: 3, subagents: 0 },
                result: "first turn",
                user: "scan session 1",
              },
              {
                turn: 1,
                si: 3,
                ei: 5,
                start: Date.now() - 60_000,
                end: Date.now() - 30_000,
                dur: 30_000,
                stats: { tools: 0, messages: 3, subagents: 0 },
                result: "second turn",
                user: "scan session 2",
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
      const result = await runTakode(["scan", "153", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-scan-probe",
        COMPANION_AUTH_TOKEN: "auth-scan-probe",
      });

      expect(result.status).toBe(0);
      expect(requests).toContain("GET /api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=0");
      expect(requests).toContain("GET /api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=50");
      expect(result.stdout).toContain('Session #153 "Scan Worker" -- idle');
      expect(result.stdout).toContain("Showing turns 0-1:");
    } finally {
      server.close();
    }
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

  it.each([
    [["list", "--help"], "Usage: takode list"],
    [["search", "--help"], "Usage: takode search"],
    [["info", "--help"], "Usage: takode info"],
    [["send", "--help"], "Usage: takode send"],
    [["logs", "--help"], "Usage: takode logs"],
    [["notify", "--help"], "Usage: takode notify"],
  ])("prints top-level command help without auth for %j", async (argv, expected) => {
    const result = await runTakode(argv, {
      ...process.env,
      COMPANION_SESSION_ID: undefined,
      COMPANION_AUTH_TOKEN: undefined,
      COMPANION_PORT: undefined,
      TAKODE_API_PORT: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stderr).toBe("");
  });

  it.each([
    [["board", "--help"], "Usage: takode board [show|set|advance|advance-no-groom|rm] ..."],
    [["board", "set", "--help"], "Usage: takode board set <quest-id>"],
    [["board", "advance", "--help"], "Usage: takode board advance <quest-id>"],
    [["board", "advance-no-groom", "--help"], "Usage: takode board advance-no-groom <quest-id>"],
    [["branch", "--help"], "Usage: takode branch <status|set-base> ..."],
    [["branch", "status", "--help"], "Usage: takode branch status [--json]"],
    [["branch", "set-base", "--help"], "Usage: takode branch set-base <branch> [--json]"],
    [["timer", "--help"], "Usage: takode timer <create|list|cancel> ..."],
    [["timer", "create", "--help"], "Usage: takode timer create <title>"],
    [["timer", "cancel", "--help"], "Usage: takode timer cancel <timer-id>"],
    [["help", "board", "set"], "Usage: takode board set <quest-id>"],
    [["help", "timer", "create"], "Usage: takode timer create <title>"],
  ])("prints nested help without executing live commands for %j", async (argv, expected) => {
    const result = await runTakode(argv, {
      ...process.env,
      COMPANION_SESSION_ID: undefined,
      COMPANION_AUTH_TOKEN: undefined,
      COMPANION_PORT: undefined,
      TAKODE_API_PORT: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("__takode_board__");
    expect(result.stdout).not.toContain("Board is empty.");
    expect(result.stdout).not.toContain("No active sessions.");
    expect(result.stdout).not.toContain("Cannot connect to Companion server");
  });

  it("keeps unknown commands with --help as an error", async () => {
    const result = await runTakode(["wat", "--help"], {
      ...process.env,
      COMPANION_SESSION_ID: undefined,
      COMPANION_AUTH_TOKEN: undefined,
      COMPANION_PORT: undefined,
      TAKODE_API_PORT: undefined,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: wat");
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

  it.each(["foo", "123", "q-"])("board advance-no-groom rejects invalid quest ID: %j", async (badId) => {
    const result = await runTakode(["board", "advance-no-groom", badId, "--port", String(port)], {
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

describe("takode board set --worker auto-clears waitFor", () => {
  // When --worker is provided without --wait-for, the CLI should send waitFor: []
  // to clear stale dependencies from a previous board entry. When --wait-for is
  // also provided, the explicit value should take precedence.

  let server: ReturnType<typeof createServer>;
  let port: number;
  let capturedBodies: JsonObject[];

  beforeAll(async () => {
    capturedBodies = [];
    server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      // Capture the board set POST body and respond with a valid board
      if (req.method === "POST" && req.url?.startsWith("/api/sessions/leader-1/board")) {
        const body = await readJson(req);
        capturedBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ board: [{ questId: body.questId, status: body.status ?? "PLANNING" }] }));
        return;
      }
      // Worker info lookup -- return a resolved session
      if (req.method === "GET" && req.url?.includes("/sessions/") && req.url?.endsWith("/info")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-session-abc", sessionNum: 3 }));
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

  beforeEach(() => {
    capturedBodies = [];
  });

  it("sends waitFor: [] when --worker is provided without --wait-for", async () => {
    const result = await runTakode(["board", "set", "q-1", "--worker", "3", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual([]);
  });

  it("preserves explicit --wait-for when provided alongside --worker", async () => {
    const result = await runTakode(
      ["board", "set", "q-1", "--worker", "3", "--wait-for", "q-2,q-3", "--port", String(port)],
      {
        ...process.env,
        COMPANION_SESSION_ID: "leader-1",
        COMPANION_AUTH_TOKEN: "auth-1",
      },
    );

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual(["q-2", "q-3"]);
  });

  it("does not send waitFor when --worker is not provided", async () => {
    const result = await runTakode(["board", "set", "q-1", "--status", "PLANNING", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toBeUndefined();
  });

  it("handles --wait-for with empty string by sending empty array (not [''])", async () => {
    // Guards against naive .split(",") producing [""] instead of []
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual([]);
  });

  it("sends noCode: true when --no-code is provided", async () => {
    const result = await runTakode(["board", "set", "q-1", "--no-code", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].noCode).toBe(true);
  });

  it("sends noCode: false when --code-change is provided", async () => {
    const result = await runTakode(["board", "set", "q-1", "--code-change", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].noCode).toBe(false);
  });

  it("rejects --no-code and --code-change together", async () => {
    const result = await runTakode(["board", "set", "q-1", "--no-code", "--code-change", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use either --no-code or --code-change");
  });
});

describe("takode board advance-no-groom", () => {
  it("calls the dedicated no-code endpoint and prints the explicit skip-groom completion message", async () => {
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      const url = req.url || "";
      requests.push(`${req.method || ""} ${url}`);

      if (req.method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board", isOrchestrator: true }));
        return;
      }
      if (req.method === "POST" && url === "/api/sessions/leader-board/board/q-1/advance-no-groom") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [],
            removed: true,
            previousState: "SKEPTIC_REVIEWING",
            skippedStates: ["GROOM_REVIEWING", "PORTING"],
            completedCount: 1,
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
      const result = await runTakode(["board", "advance-no-groom", "q-1", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board",
        COMPANION_AUTH_TOKEN: "auth-1",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("q-1: completed via no-code path");
      expect(result.stdout).toContain("skipped GROOM_REVIEWING and PORTING");
      expect(requests).toContain("POST /api/sessions/leader-board/board/q-1/advance-no-groom");
    } finally {
      server.close();
    }
  });
});

describe("takode board reviewer status output", () => {
  it("shows worker and reviewer runtime status on board advance", async () => {
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board", isOrchestrator: true }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-board/board/q-1/advance") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-1",
                title: "Fix archived reviewer send bug",
                worker: "worker-1",
                workerNum: 7,
                status: "IMPLEMENTING",
                createdAt: 1,
                updatedAt: 2,
              },
              {
                questId: "q-2",
                title: "Queue next quest",
                worker: "worker-2",
                workerNum: 8,
                status: "PLANNING",
                createdAt: 3,
                updatedAt: 4,
              },
            ],
            previousState: "PLANNING",
            newState: "IMPLEMENTING",
            rowSessionStatuses: {
              "q-1": {
                worker: { sessionId: "worker-1", sessionNum: 7, status: "idle" },
                reviewer: { sessionId: "reviewer-1", sessionNum: 17, status: "running" },
              },
              "q-2": {
                worker: { sessionId: "worker-2", sessionNum: 8, status: "disconnected" },
                reviewer: null,
              },
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
      const result = await runTakode(["board", "advance", "q-1", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board",
        COMPANION_AUTH_TOKEN: "auth-board",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("q-1: PLANNING -> IMPLEMENTING");
      expect(result.stdout).toContain("WORKER / REVIEWER");
      expect(result.stdout).toContain("#7 idle / #17 running");
      expect(result.stdout).toContain("#8 disconnected / no reviewer");
      expect(result.stdout).not.toContain('"rowSessionStatuses"');
    } finally {
      server.close();
    }
  });
});

describe("takode board output modes", () => {
  it("makes worker reviewer relationships and next action obvious in board show output", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-visible", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-visible/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-420",
                title: "Recover reviewer visibility",
                worker: "worker-558",
                workerNum: 558,
                status: "SKEPTIC_REVIEWING",
                waitFor: ["#560"],
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            resolvedSessionDeps: [],
            rowSessionStatuses: {
              "q-420": {
                worker: { sessionId: "worker-558", sessionNum: 558, status: "idle" },
                reviewer: { sessionId: "reviewer-560", sessionNum: 560, status: "running" },
              },
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
      const result = await runTakode(["board", "show", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-visible",
        COMPANION_AUTH_TOKEN: "auth-board-visible",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("#558 idle / #560 running");
      expect(result.stdout).toContain("wait #560");
      expect(result.stdout).toContain("wait for #560");
    } finally {
      server.close();
    }
  });

  it("keeps default board show output human-first without embedded JSON", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-show", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-show/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-12",
                title: "Simplify board output",
                worker: "worker-1",
                workerNum: 5,
                status: "PLANNING",
                waitFor: ["q-9"],
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            queueWarnings: [
              {
                questId: "q-12",
                kind: "dispatchable",
                summary: "q-12 can be dispatched now: wait-for resolved (q-9).",
                action: "Dispatch it now or replace QUEUED with the next active board stage.",
              },
            ],
            rowSessionStatuses: {
              "q-12": {
                worker: { sessionId: "worker-1", sessionNum: 5, status: "idle" },
                reviewer: null,
              },
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
      const result = await runTakode(["board", "show", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-show",
        COMPANION_AUTH_TOKEN: "auth-board-show",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("QUEST");
      expect(result.stdout).toContain("WORKER / REVIEWER");
      expect(result.stdout).toContain("ACTION");
      expect(result.stdout).toContain("q-12");
      expect(result.stdout).toContain("#5 idle / no reviewer");
      expect(result.stdout).toContain("ready");
      expect(result.stdout).toContain("dispatch now");
      expect(result.stdout).not.toContain("__takode_board__");
      expect(result.stdout).not.toContain('"rowSessionStatuses"');
    } finally {
      server.close();
    }
  });

  it("emits structured board JSON only in --json mode", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-json", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-json/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [{ questId: "q-12", status: "PLANNING", createdAt: 1, updatedAt: 2 }],
            rowSessionStatuses: {},
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
      const result = await runTakode(["board", "show", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-json",
        COMPANION_AUTH_TOKEN: "auth-board-json",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"__takode_board__": true');
      expect(result.stdout).toContain('"rowSessionStatuses": {}');
      expect(result.stdout).not.toContain("QUEST");
      expect(result.stdout).not.toContain("WORKER / REVIEWER");
    } finally {
      server.close();
    }
  });

  it("shows queue warnings for dispatchable queued rows, including free-worker readiness", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-warning", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-warning/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-88",
                title: "Dispatch queued follow-up",
                status: "QUEUED",
                waitFor: ["free-worker"],
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            queueWarnings: [
              {
                questId: "q-88",
                kind: "dispatchable",
                summary: "q-88 can be dispatched now: worker slots are available (3/5 used).",
                action: "Dispatch it now or replace QUEUED with the next active board stage.",
              },
            ],
            workerSlotUsage: { used: 3, limit: 5 },
            rowSessionStatuses: {},
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
      const result = await runTakode(["board", "show", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-warning",
        COMPANION_AUTH_TOKEN: "auth-board-warning",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ready");
      expect(result.stdout).toContain("dispatch now");
      expect(result.stdout).toContain("q-88 can be dispatched now");
      expect(result.stdout).toContain("Next: Dispatch it now or replace QUEUED");
    } finally {
      server.close();
    }
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

      // Parent worker should expose attached reviewer state directly.
      expect(result.stdout).toMatch(/#10.*👀 #11 idle/);

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

  it("shows worker-slot usage separately from the raw session total", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-slot-summary", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "leader-slot-summary",
              sessionNum: 9,
              name: "Leader Slot Summary",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 30_000,
              lastActivityAt: Date.now() - 12_000,
              cliConnected: true,
              isOrchestrator: true,
            },
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
              herdedBy: "leader-slot-summary",
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
              herdedBy: "leader-slot-summary",
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
              herdedBy: "leader-slot-summary",
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
        COMPANION_SESSION_ID: "leader-slot-summary",
        COMPANION_AUTH_TOKEN: "auth-slot-summary",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("3 session(s) shown (2 workers, 1 reviewer)");
      expect(result.stdout).toContain(
        "Worker slots used: 2/5. Reviewers do not use worker slots, and archiving reviewers will not free worker-slot capacity.",
      );
    } finally {
      server.close();
    }
  });
});

describe("takode board --wait-for validation (q-N, #N, and free-worker)", () => {
  // CLI-side validation: --wait-for accepts q-N (quest), #N (session), and
  // free-worker refs, rejects bare numbers and arbitrary strings.

  let server: ReturnType<typeof createServer>;
  let port: number;
  let capturedBodies: JsonObject[];

  beforeAll(async () => {
    capturedBodies = [];
    server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/api/sessions/leader-1/board")) {
        const body = await readJson(req);
        capturedBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ board: [{ questId: body.questId, status: body.status ?? "QUEUED" }] }));
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

  beforeEach(() => {
    capturedBodies = [];
  });

  it("accepts --wait-for #5 (session ref)", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "#5", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual(["#5"]);
  });

  it("accepts --wait-for q-1,#5 (mixed quest + session refs)", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "q-1,#5", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual(["q-1", "#5"]);
  });

  it("accepts --wait-for free-worker", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "free-worker", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual(["free-worker"]);
  });

  it.each(["42", "foo", "q-", "#", "#abc", "session-5"])("rejects invalid --wait-for value: %j", async (badRef) => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", badRef, "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid wait-for");
    expect(result.stderr).toContain("q-N");
    expect(result.stderr).toContain("#N");
    expect(result.stderr).toContain("free-worker");
    // No POST should have been made
    expect(capturedBodies).toHaveLength(0);
  });

  it("rejects when any ref in a comma-separated list is invalid", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "q-2,42,#3", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("42");
    expect(capturedBodies).toHaveLength(0);
  });

  it("defaults a new wait-for-only row to QUEUED on the server", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "free-worker", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].status).toBeUndefined();
    expect(result.stdout).toContain("QUEUED");
  });
});
