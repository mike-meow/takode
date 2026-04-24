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
