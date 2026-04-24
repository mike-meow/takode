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
