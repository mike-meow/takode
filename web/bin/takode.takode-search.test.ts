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

describe("takode search", () => {
  it("uses server-side session search, excludes exited by default, and shows field/reason/snippet/message id", async () => {
    const searchRequests: URL[] = [];
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "worker-1",
              sessionNum: 7,
              name: "Auth worker",
              state: "idle",
              archived: false,
              cwd: "/repo",
              createdAt: Date.now() - 60_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: true,
            },
            {
              sessionId: "worker-exited",
              sessionNum: 70,
              name: "Exited worker",
              state: "exited",
              archived: false,
              cwd: "/repo",
              createdAt: Date.now() - 60_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: false,
            },
          ]),
        );
        return;
      }
      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url.startsWith("/api/sessions/search?")) {
        const parsed = new URL(`http://localhost${url}`);
        searchRequests.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            query: parsed.searchParams.get("q"),
            tookMs: 2,
            totalMatches: 1,
            results: [
              {
                sessionId: "worker-1",
                score: 500,
                matchedField: "user_message",
                matchContext: "message: auth token is missing in env",
                matchedAt: Date.now() - 5000,
                messageMatch: {
                  id: "m-42",
                  timestamp: Date.now() - 5000,
                  snippet: "auth token is missing in env",
                },
              },
              {
                sessionId: "worker-exited",
                score: 480,
                matchedField: "name",
                matchContext: "name: Exited worker",
                matchedAt: Date.now() - 3000,
              },
            ],
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

    const result = await runTakode(["search", "auth", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.searchParams.get("q")).toBe("auth");
    expect(searchRequests[0]?.searchParams.get("includeArchived")).toBe("false");
    expect(result.stdout).not.toContain("Exited worker");
    expect(result.stdout).toContain("field: message");
    expect(result.stdout).toContain("reason: message: auth token is missing in env");
    expect(result.stdout).toContain("snippet: auth token is missing in env");
    expect(result.stdout).toContain("message id: m-42 (takode peek 7 --from m-42)");
  });

  it("drops stale search rows when session id is missing from takode session list", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }
      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url.startsWith("/api/sessions/search?")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            query: "auth",
            tookMs: 2,
            totalMatches: 1,
            results: [
              {
                sessionId: "deleted-worker",
                score: 500,
                matchedField: "user_message",
                matchContext: "message: should not render",
                matchedAt: Date.now() - 5000,
                messageMatch: {
                  id: "m-stale-1",
                  timestamp: Date.now() - 5000,
                  snippet: "should not render",
                },
              },
            ],
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

    const result = await runTakode(["search", "auth", "--json", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("keeps archived sessions enabled for --all and exposes match metadata in --json output", async () => {
    const searchRequests: URL[] = [];
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "worker-2",
              sessionNum: 8,
              name: "Legacy auth run",
              state: "exited",
              archived: true,
              cwd: "/repo",
              createdAt: Date.now() - 120_000,
              lastActivityAt: Date.now() - 120_000,
              cliConnected: false,
            },
          ]),
        );
        return;
      }
      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-1", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url.startsWith("/api/sessions/search?")) {
        const parsed = new URL(`http://localhost${url}`);
        searchRequests.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            query: parsed.searchParams.get("q"),
            tookMs: 2,
            totalMatches: 1,
            results: [
              {
                sessionId: "worker-2",
                score: 1000,
                matchedField: "name",
                matchContext: null,
                matchedAt: Date.now() - 120000,
              },
            ],
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

    const result = await runTakode(["search", "auth", "--all", "--json", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.searchParams.get("q")).toBe("auth");
    expect(searchRequests[0]?.searchParams.get("includeArchived")).toBeNull();
    const parsed = JSON.parse(result.stdout) as Array<{
      sessionId: string;
      matchedField: string;
      messageId: string | null;
      snippet: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      sessionId: "worker-2",
      matchedField: "name",
      messageId: null,
      snippet: "Legacy auth run",
    });
  });
});
