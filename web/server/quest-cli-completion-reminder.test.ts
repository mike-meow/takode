import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionAuthDir, getSessionAuthPath } from "../shared/session-auth.js";

type JsonObject = Record<string, unknown>;

function centralAuthPath(cwd: string, home?: string, serverId = "test-server-id"): string {
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

async function runQuest(
  args: string[],
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const questPath = fileURLToPath(new URL("../bin/quest.ts", import.meta.url));
  const child = spawn(process.execPath, [questPath, ...args], {
    env: {
      ...env,
      BUN_INSTALL_CACHE_DIR:
        env.BUN_INSTALL_CACHE_DIR ||
        process.env.BUN_INSTALL_CACHE_DIR ||
        join(process.env.HOME || "", ".bun/install/cache"),
    },
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdin?.end();

  const [code] = await once(child, "close");
  return { status: code as number | null, stdout, stderr };
}

describe("quest CLI completion reminder debrief policy", () => {
  it("reminds normal completion handoffs that final debrief metadata is required", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-complete-debrief-reminder-"));
    const authDir = getSessionAuthDir(tmp);
    mkdirSync(authDir, { recursive: true });
    const authPath = centralAuthPath(tmp, tmp);

    const server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/quests/q-1/complete") {
        await readJson(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            questId: "q-1",
            title: "Quest",
            status: "done",
            verificationItems: [{ text: "Visual check", checked: false }],
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/api/quests/_notify") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
      JSON.stringify({ sessionId: "session-file", authToken: "file-token", port, serverId: "test-server-id" }),
      "utf-8",
    );

    try {
      const result = await runQuest(
        ["complete", "q-1", "--items", "Visual check"],
        {
          ...process.env,
          COMPANION_PORT: String(port),
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Every completed non-cancelled quest must also have final debrief metadata");
      expect(result.stdout).toContain("use `--debrief-file` plus `--debrief-tldr-file` on completion");
      expect(result.stdout).toContain("treat the handoff as incomplete");
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reminds no-code handoffs that zero tracked changes do not relax debrief metadata", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-complete-no-code-debrief-reminder-"));
    const authDir = getSessionAuthDir(tmp);
    mkdirSync(authDir, { recursive: true });
    const authPath = centralAuthPath(tmp, tmp);
    const seenBodies: JsonObject[] = [];

    const server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/quests/q-1/complete") {
        seenBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            questId: "q-1",
            title: "Quest",
            status: "done",
            verificationItems: [{ text: "Review artifact", checked: false }],
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/api/quests/_notify") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
      JSON.stringify({ sessionId: "session-file", authToken: "file-token", port, serverId: "test-server-id" }),
      "utf-8",
    );

    try {
      const result = await runQuest(
        ["complete", "q-1", "--items", "Review artifact", "--no-code"],
        {
          ...process.env,
          COMPANION_PORT: String(port),
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(seenBodies[0]).toMatchObject({
        verificationItems: [{ text: "Review artifact", checked: false }],
      });
      expect(result.stdout).toContain("You used `--no-code` for this local CLI handoff");
      expect(result.stdout).toContain("it does not relax the final debrief and debrief TLDR requirement");
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
