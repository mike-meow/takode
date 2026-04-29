import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

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
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const takodePath = fileURLToPath(new URL("./takode.ts", import.meta.url));
  const child = spawn(process.execPath, [takodePath, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

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

describe("takode lease", () => {
  it("acquires a lease with purpose, ttl, quest, wait, and metadata payload", async () => {
    let receivedBody: JsonObject | null = null;
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-self", isOrchestrator: false }));
        return;
      }

      if (method === "POST" && url === "/api/resource-leases/dev-server%3Acompanion/acquire") {
        receivedBody = await readJson(req);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            result: {
              status: "acquired",
              lease: {
                resourceKey: "dev-server:companion",
                ownerSessionId: "worker-self",
                questId: "q-979",
                purpose: "Run E2E verification",
                metadata: { url: "http://localhost:5174" },
                acquiredAt: Date.now(),
                heartbeatAt: Date.now(),
                ttlMs: 1_800_000,
                expiresAt: Date.now() + 1_800_000,
              },
              waiters: [],
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
      const result = await runTakode(
        [
          "lease",
          "acquire",
          "dev-server:companion",
          "--purpose",
          "Run E2E verification",
          "--ttl",
          "30m",
          "--quest",
          "q-979",
          "--metadata",
          "url=http://localhost:5174",
          "--wait",
          "--port",
          String(port),
        ],
        {
          ...process.env,
          COMPANION_SESSION_ID: "worker-self",
          COMPANION_AUTH_TOKEN: "auth-self",
        },
      );

      expect(result.status).toBe(0);
      expect(receivedBody).toEqual({
        purpose: "Run E2E verification",
        metadata: { url: "http://localhost:5174" },
        ttlMs: 1_800_000,
        questId: "q-979",
        wait: true,
      });
      expect(result.stdout).toContain("Acquired dev-server:companion");
    } finally {
      server.close();
    }
  });

  it("prints lease status and supports json mode", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-self", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/resource-leases/agent-browser") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            resource: {
              resourceKey: "agent-browser",
              available: false,
              lease: {
                resourceKey: "agent-browser",
                ownerSessionId: "owner",
                purpose: "Inspect UI",
                metadata: {},
                acquiredAt: 1_700_000_000_000,
                heartbeatAt: 1_700_000_000_000,
                ttlMs: 1_800_000,
                expiresAt: Date.now() + 1_800_000,
              },
              waiters: [{ id: "w1", waiterSessionId: "waiter", purpose: "Need browser next" }],
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
      const text = await runTakode(["lease", "status", "agent-browser", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-self",
        COMPANION_AUTH_TOKEN: "auth-self",
      });
      expect(text.status).toBe(0);
      expect(text.stdout).toContain("agent-browser: held by owner");
      expect(text.stdout).toContain("waiters: 1");

      const json = await runTakode(["lease", "status", "agent-browser", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-self",
        COMPANION_AUTH_TOKEN: "auth-self",
      });
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout).resource.resourceKey).toBe("agent-browser");
    } finally {
      server.close();
    }
  });
});
