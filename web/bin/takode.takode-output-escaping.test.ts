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
