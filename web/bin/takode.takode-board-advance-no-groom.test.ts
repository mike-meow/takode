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
