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

describe("takode auth fallback", () => {
  it("uses centralized ~/.companion/session-auth/ when env credentials are missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-auth-fallback-"));
    const authPath = centralAuthPath(tmp, tmp);
    mkdirSync(getSessionAuthDir(tmp), { recursive: true });
    writeFileSync(
      authPath,
      JSON.stringify({ sessionId: "leader-file", authToken: "file-token", port: 9999, serverId: "test-server-id" }),
      "utf-8",
    );

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      seenHeaders.push(req.headers);
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-file", isOrchestrator: true }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
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
        ["list", "--port", String(port), "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("[]");
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "leader-file")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "file-token")).toBe(true);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
      try {
        unlinkSync(authPath);
      } catch {}
    }
  });

  it("uses centralized session-auth port when no explicit port env or flag is provided", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-auth-port-fallback-"));
    const authPath = centralAuthPath(tmp, tmp);
    mkdirSync(getSessionAuthDir(tmp), { recursive: true });

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      seenHeaders.push(req.headers);
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-port-file", isOrchestrator: true }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    writeFileSync(
      authPath,
      JSON.stringify({ sessionId: "leader-port-file", authToken: "file-port-token", port, serverId: "test-server-id" }),
      "utf-8",
    );

    try {
      const result = await runTakode(
        ["list", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          TAKODE_API_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("[]");
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "leader-port-file")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "file-port-token")).toBe(true);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
      try {
        unlinkSync(authPath);
      } catch {}
    }
  });

  it("fails closed when multiple Companion auth contexts exist for the same cwd", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-auth-ambiguous-"));
    mkdirSync(getSessionAuthDir(tmp), { recursive: true });
    writeFileSync(
      centralAuthPath(tmp, tmp, "server-a"),
      JSON.stringify({ sessionId: "leader-a", authToken: "token-a", port: 4100, serverId: "server-a" }),
      "utf-8",
    );
    writeFileSync(
      centralAuthPath(tmp, tmp, "server-b"),
      JSON.stringify({ sessionId: "leader-b", authToken: "token-b", port: 4200, serverId: "server-b" }),
      "utf-8",
    );

    try {
      const result = await runTakode(
        ["list", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          TAKODE_API_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Multiple Companion auth contexts were found");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses the matching session-scoped auth context when multiple servers share a cwd", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-auth-session-match-"));
    mkdirSync(getSessionAuthDir(tmp), { recursive: true });
    writeFileSync(
      centralAuthPath(tmp, tmp, "server-a"),
      JSON.stringify({ sessionId: "leader-a", authToken: "token-a", port: 4301, serverId: "server-a" }),
      "utf-8",
    );

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      seenHeaders.push(req.headers);
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-b", isOrchestrator: true }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    writeFileSync(
      centralAuthPath(tmp, tmp, "server-b"),
      JSON.stringify({ sessionId: "leader-b", authToken: "token-b", port, serverId: "server-b" }),
      "utf-8",
    );

    try {
      const result = await runTakode(
        ["list", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: "leader-b",
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          TAKODE_API_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("[]");
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "leader-b")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "token-b")).toBe(true);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
