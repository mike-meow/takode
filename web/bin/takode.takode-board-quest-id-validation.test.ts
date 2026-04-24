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
