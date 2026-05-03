import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function runQuest(
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const questPath = fileURLToPath(new URL("../bin/quest.ts", import.meta.url));
  const child = spawn(process.execPath, [questPath, ...args], {
    cwd,
    env: {
      ...env,
      BUN_INSTALL_CACHE_DIR:
        env.BUN_INSTALL_CACHE_DIR ||
        process.env.BUN_INSTALL_CACHE_DIR ||
        join(process.env.HOME || "", ".bun/install/cache"),
    },
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

describe("quest CLI numeric session refs", () => {
  it("sends explicit numeric --session values without rewriting them client-side", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-numeric-session-"));
    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const seenBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      seenHeaders.push(req.headers);
      if (req.method === "POST" && req.url === "/api/quests/q-1/claim") {
        seenBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ questId: "q-1", title: "Quest", status: "in_progress", sessionId: "session-file" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");

    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runQuest(
        ["claim", "q-1", "--session", "42", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: "session-file",
          COMPANION_AUTH_TOKEN: "file-token",
          COMPANION_PORT: String(port),
          TAKODE_ROLE: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ questId: "q-1", sessionId: "session-file" });
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "session-file")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "file-token")).toBe(true);
      expect(seenBodies[0]).toMatchObject({ sessionId: "42" });
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
