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

describe("takode herd", () => {
  it("fails clearly on non-force herd conflicts and suggests force takeover", async () => {
    // Ordinary herd conflicts should stay non-force, exit nonzero, and tell the
    // user exactly how to retry if they intend a takeover.
    const herdBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-conflict", isOrchestrator: true }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-conflict/herd") {
        herdBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            herded: [],
            notFound: [],
            conflicts: [{ id: "worker-conflict", herder: "leader-old" }],
            reassigned: [],
            leaders: [],
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
      const result = await runTakode(["herd", "worker-conflict", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-conflict",
        COMPANION_AUTH_TOKEN: "auth-conflict",
      });

      expect(result.status).toBe(1);
      expect(herdBodies).toEqual([{ workerIds: ["worker-conflict"] }]);
      expect(result.stdout).toContain("Conflict: worker-conflict already herded by leader-old");
      expect(result.stderr).toContain("takode herd --force worker-conflict");
    } finally {
      server.close();
    }
  });

  it("keeps json herd conflicts machine-readable while still exiting nonzero", async () => {
    // JSON mode should preserve the raw herd payload on stdout while still
    // failing the command when a non-force conflict is reported.
    const herdBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-conflict-json", isOrchestrator: true }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-conflict-json/herd") {
        herdBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            herded: [],
            notFound: [],
            conflicts: [{ id: "worker-conflict-json", herder: "leader-old" }],
            reassigned: [],
            leaders: [],
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
      const result = await runTakode(["herd", "worker-conflict-json", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-conflict-json",
        COMPANION_AUTH_TOKEN: "auth-conflict-json",
      });

      expect(result.status).toBe(1);
      expect(herdBodies).toEqual([{ workerIds: ["worker-conflict-json"] }]);
      expect(JSON.parse(result.stdout)).toEqual({
        herded: [],
        notFound: [],
        conflicts: [{ id: "worker-conflict-json", herder: "leader-old" }],
        reassigned: [],
        leaders: [],
      });
      expect(result.stderr).toContain("takode herd --force worker-conflict-json");
    } finally {
      server.close();
    }
  });

  it("passes force through to the herd API and prints reassignment details", async () => {
    // Force herd must stay opt-in on the CLI surface and should print the
    // reassignment summary when the server reports a takeover.
    const herdBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-force", isOrchestrator: true }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-force/herd") {
        herdBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            herded: ["worker-force"],
            notFound: [],
            conflicts: [],
            reassigned: [{ id: "worker-force", fromLeader: "leader-old" }],
            leaders: [],
          }),
        );
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-force/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-force",
            sessionNum: 17,
            name: "Worker Force",
            state: "running",
            cwd: "/tmp/worker-force",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
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
      const result = await runTakode(["herd", "--force", "worker-force", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-force",
        COMPANION_AUTH_TOKEN: "auth-force",
      });

      expect(result.status).toBe(0);
      expect(herdBodies).toEqual([{ workerIds: ["worker-force"], force: true }]);
      expect(result.stdout).toContain("Herded 1 session(s)");
      expect(result.stdout).toContain("Reassigned worker-force from leader-old");
    } finally {
      server.close();
    }
  });

  it("keeps ordinary takode herd requests non-force by default", async () => {
    // The default CLI path must not silently add force, otherwise normal
    // conflict behavior would be impossible to preserve.
    const herdBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-plain", isOrchestrator: true }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/leader-plain/herd") {
        herdBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            herded: ["worker-plain"],
            notFound: [],
            conflicts: [],
            reassigned: [],
            leaders: [],
          }),
        );
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-plain/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-plain",
            sessionNum: 18,
            name: "Worker Plain",
            state: "running",
            cwd: "/tmp/worker-plain",
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
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
      const result = await runTakode(["herd", "worker-plain", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-plain",
        COMPANION_AUTH_TOKEN: "auth-plain",
      });

      expect(result.status).toBe(0);
      expect(herdBodies).toEqual([{ workerIds: ["worker-plain"] }]);
      expect(result.stdout).toContain("Herded 1 session(s)");
      expect(result.stdout).not.toContain("Reassigned");
    } finally {
      server.close();
    }
  });
});
