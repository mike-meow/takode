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

describe("takode notify self-resolution workflow", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let requestBodies: JsonObject[];

  beforeAll(async () => {
    requestBodies = [];
    server = createServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-7", isOrchestrator: false }));
        return;
      }

      if (method === "POST" && url === "/api/sessions/worker-7/notify") {
        requestBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            category: "needs-input",
            anchoredMessageId: "asst-1",
            notificationId: 7,
            rawNotificationId: "n-7",
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-7/notifications/needs-input/self") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            notifications: [
              {
                notificationId: 2,
                rawNotificationId: "n-2",
                summary: "Need rollout decision",
                timestamp: 1000,
                messageId: "asst-2",
              },
              {
                notificationId: 7,
                rawNotificationId: "n-7",
                summary: "Need config confirmation",
                timestamp: 1001,
                messageId: "asst-7",
              },
            ],
            resolvedCount: 3,
          }),
        );
        return;
      }

      if (method === "POST" && url === "/api/sessions/worker-7/notifications/needs-input/7/resolve") {
        requestBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, notificationId: 7, rawNotificationId: "n-7", changed: false }));
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
    requestBodies = [];
  });

  it("prints the created notification id for takode notify needs-input", async () => {
    const result = await runTakode(["notify", "needs-input", "Need", "approval", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Notification sent (needs-input, id 7)");
    expect(requestBodies[0]).toEqual({ category: "needs-input", summary: "Need approval" });
  });

  it("lists unresolved same-session needs-input notifications", async () => {
    const result = await runTakode(["notify", "list", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Unresolved same-session needs-input notifications: 2. Resolved: 3.");
    expect(result.stdout).toContain("2. Need rollout decision");
    expect(result.stdout).toContain("7. Need config confirmation");
  });

  it("treats resolving an already-resolved notification as a successful no-op", async () => {
    const result = await runTakode(["notify", "resolve", "7", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Needs-input notification 7 was already resolved.");
    expect(requestBodies[0]).toEqual({});
  });
});
