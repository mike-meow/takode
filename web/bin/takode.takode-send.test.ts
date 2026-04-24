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
