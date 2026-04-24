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
