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
