import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

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
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const takodePath = fileURLToPath(new URL("./takode.ts", import.meta.url));
  const child = spawn(process.execPath, [takodePath, ...args], {
    env,
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.end();

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

describe("takode spawn model payloads", () => {
  it("continues forwarding the leader model across backend overrides when --model is omitted", async () => {
    const createBodies: JsonObject[] = [];

    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-cross-backend", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-cross-backend") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-cross-backend",
            permissionMode: "plan",
            backendType: "codex",
            model: "gpt-5.5",
          }),
        );
        return;
      }

      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-cross-backend" }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-cross-backend/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-cross-backend",
            sessionNum: 51,
            name: "Worker Cross Backend",
            state: "running",
            backendType: "claude",
            model: "claude-sonnet-4-5-20250929",
            cwd: "/tmp/worker-cross-backend",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            askPermission: true,
            isWorktree: true,
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

    const result = await runTakode(["spawn", "--port", String(port), "--backend", "claude"], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-cross-backend",
      COMPANION_AUTH_TOKEN: "auth-cross-backend",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(createBodies).toHaveLength(1);
    // This locks in the current reviewed behavior: takode spawn treats the
    // leader's active model as authoritative even when the backend is
    // overridden, unless the caller passes an explicit --model.
    expect(createBodies[0]).toEqual({
      backend: "claude",
      cwd: process.cwd(),
      useWorktree: true,
      createdBy: "leader-cross-backend",
      model: "gpt-5.5",
    });
  });
});
