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

describe("takode board set --worker auto-clears waitFor", () => {
  // When --worker is provided without --wait-for, the CLI should send waitFor: []
  // to clear stale dependencies from a previous board entry. When --wait-for is
  // also provided, the explicit value should take precedence.

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
      // Capture the board set POST body and respond with a valid board
      if (req.method === "POST" && req.url?.startsWith("/api/sessions/leader-1/board")) {
        const body = await readJson(req);
        capturedBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ board: [{ questId: body.questId, status: body.status ?? "PLANNING" }] }));
        return;
      }
      // Worker info lookup -- return a resolved session
      if (req.method === "GET" && req.url?.includes("/sessions/") && req.url?.endsWith("/info")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-session-abc", sessionNum: 3 }));
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

  it("sends waitFor: [] when --worker is provided without --wait-for", async () => {
    const result = await runTakode(["board", "set", "q-1", "--worker", "3", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual([]);
  });

  it("preserves explicit --wait-for when provided alongside --worker", async () => {
    const result = await runTakode(
      ["board", "set", "q-1", "--worker", "3", "--wait-for", "q-2,q-3", "--port", String(port)],
      {
        ...process.env,
        COMPANION_SESSION_ID: "leader-1",
        COMPANION_AUTH_TOKEN: "auth-1",
      },
    );

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual(["q-2", "q-3"]);
  });

  it("does not send waitFor when --worker is not provided", async () => {
    const result = await runTakode(["board", "set", "q-1", "--status", "PLANNING", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toBeUndefined();
  });

  it("handles --wait-for with empty string by sending empty array (not [''])", async () => {
    // Guards against naive .split(",") producing [""] instead of []
    const result = await runTakode(["board", "set", "q-1", "--wait-for", "", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].waitFor).toEqual([]);
  });

  it("sends noCode: true when --no-code is provided", async () => {
    const result = await runTakode(["board", "set", "q-1", "--no-code", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].noCode).toBe(true);
  });

  it("sends noCode: false when --code-change is provided", async () => {
    const result = await runTakode(["board", "set", "q-1", "--code-change", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].noCode).toBe(false);
  });

  it("sends planned Quest Journey phases and preset metadata", async () => {
    const result = await runTakode(
      [
        "board",
        "set",
        "q-1",
        "--worker",
        "3",
        "--phases",
        "planning,implementation,skeptic-review",
        "--preset",
        "lightweight-code",
        "--port",
        String(port),
      ],
      {
        ...process.env,
        COMPANION_SESSION_ID: "leader-1",
        COMPANION_AUTH_TOKEN: "auth-1",
      },
    );

    expect(result.status).toBe(0);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].worker).toBe("worker-session-abc");
    expect(capturedBodies[0].workerNum).toBe(3);
    expect(capturedBodies[0].phases).toEqual(["planning", "implementation", "skeptic-review"]);
    expect(capturedBodies[0].presetId).toBe("lightweight-code");
  });

  it("rejects unknown planned Quest Journey phase IDs before posting", async () => {
    const result = await runTakode(["board", "set", "q-1", "--phases", "planning,unknown", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid Quest Journey phase");
    expect(capturedBodies).toHaveLength(0);
  });

  it("requires --phases when setting a Quest Journey preset", async () => {
    const result = await runTakode(["board", "set", "q-1", "--preset", "lightweight-code", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use --preset only with --phases");
    expect(capturedBodies).toHaveLength(0);
  });

  it("rejects --no-code and --code-change together", async () => {
    const result = await runTakode(["board", "set", "q-1", "--no-code", "--code-change", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use either --no-code or --code-change");
  });
});
