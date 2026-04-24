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

describe("takode board --wait-for validation (q-N, #N, and free-worker)", () => {
  // CLI-side validation: --wait-for accepts q-N (quest), #N (session), and
  // free-worker refs, rejects bare numbers and arbitrary strings.

  let server: ReturnType<typeof createServer>;
  let port: number;
  let capturedBodies: JsonObject[];

  beforeAll(async () => {
    capturedBodies = [];
    server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/api/sessions/leader-1/board")) {
        const body = await readJson(req);
        capturedBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ board: [{ questId: body.questId, status: body.status ?? "QUEUED" }] }));
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

  beforeEach(() => {
    capturedBodies = [];
  });

  it("accepts --wait-for #5 (session ref)", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "#5", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual(["#5"]);
  });

  it("accepts --wait-for q-1,#5 (mixed quest + session refs)", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "q-1,#5", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual(["q-1", "#5"]);
  });

  it("accepts --wait-for free-worker", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "free-worker", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual(["free-worker"]);
  });

  it.each(["42", "foo", "q-", "#", "#abc", "session-5"])("rejects invalid --wait-for value: %j", async (badRef) => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", badRef, "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid wait-for");
    expect(result.stderr).toContain("q-N");
    expect(result.stderr).toContain("#N");
    expect(result.stderr).toContain("free-worker");
    // No POST should have been made
    expect(capturedBodies).toHaveLength(0);
  });

  it("rejects when any ref in a comma-separated list is invalid", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "q-2,42,#3", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("42");
    expect(capturedBodies).toHaveLength(0);
  });

  it("defaults a new wait-for-only row to QUEUED on the server", async () => {
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "free-worker", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].status).toBeUndefined();
    expect(result.stdout).toContain("QUEUED");
  });
});
