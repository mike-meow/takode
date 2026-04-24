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
