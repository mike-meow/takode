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
