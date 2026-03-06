import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSessionAuthDir, getSessionAuthPath } from "../shared/session-auth.js";

type JsonObject = Record<string, unknown>;

/** Compute centralized auth path — must match getSessionAuthPath() in cli-launcher.ts.
 * Uses explicit home parameter since tests override HOME for the child process. */
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
      resolve(body ? JSON.parse(body) as JsonObject : {});
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
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  const [code] = await once(child, "close");
  return { status: code as number | null, stdout, stderr };
}

describe("quest CLI auth fallback", () => {
  it("uses centralized ~/.companion/session-auth/ for claim when env vars are missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-auth-claim-"));
    // With HOME=tmp, centralAuthPath(tmp, tmp) resolves to the server-scoped auth file.
    const authDir = getSessionAuthDir(tmp);
    mkdirSync(authDir, { recursive: true });
    const authPath = centralAuthPath(tmp, tmp);

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const seenBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      seenHeaders.push(req.headers);
      if (req.method === "POST" && req.url === "/api/quests/q-1/claim") {
        seenBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          questId: "q-1",
          title: "Quest",
          status: "in_progress",
          sessionId: "session-file",
        }));
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
        ["claim", "q-1", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ questId: "q-1", sessionId: "session-file" });
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "session-file")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "file-token")).toBe(true);
      expect(seenBodies[0]).toMatchObject({ sessionId: "session-file" });
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses centralized ~/.companion/session-auth/ for agent feedback when env vars are missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-auth-feedback-"));
    const authDir = getSessionAuthDir(tmp);
    mkdirSync(authDir, { recursive: true });
    const authPath = centralAuthPath(tmp, tmp);

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const seenBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      seenHeaders.push(req.headers);
      if (req.method === "POST" && req.url === "/api/quests/q-1/feedback") {
        seenBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          questId: "q-1",
          title: "Quest",
          status: "needs_verification",
          feedback: [{ author: "agent", text: "Addressed" }],
        }));
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
        ["feedback", "q-1", "--text", "Addressed", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ questId: "q-1" });
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "session-file")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "file-token")).toBe(true);
      expect(seenBodies[0]).toMatchObject({
        author: "agent",
        text: "Addressed",
        sessionId: "session-file",
      });
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("quest CLI create image attachments", () => {
  it("attaches uploaded images on create via --image and --images", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-create-images-"));
    const imgA = join(tmp, "a.png");
    const imgB = join(tmp, "b.png");
    const imgC = join(tmp, "c.png");
    writeFileSync(imgA, "a", "utf-8");
    writeFileSync(imgB, "b", "utf-8");
    writeFileSync(imgC, "c", "utf-8");

    let uploadCount = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/quests/_images") {
        req.resume();
        req.on("end", () => {
          uploadCount += 1;
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: `img-${uploadCount}`,
            filename: `img-${uploadCount}.png`,
            mimeType: "image/png",
            path: `/tmp/img-${uploadCount}.png`,
          }));
        });
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

    try {
      const result = await runQuest(
        [
          "create",
          "Quest with images",
          "--image",
          imgA,
          "--images",
          `${imgB}, ${imgC}`,
          "--json",
        ],
        {
          ...process.env,
          COMPANION_PORT: String(port),
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(uploadCount).toBe(3);
      const quest = JSON.parse(result.stdout) as {
        title: string;
        images?: { id: string; filename: string; mimeType: string; path: string }[];
      };
      expect(quest.title).toBe("Quest with images");
      expect(quest.images).toHaveLength(3);
      expect(quest.images?.map((img) => img.id).sort()).toEqual(["img-1", "img-2", "img-3"]);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails create when image flags are used without Companion port", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-create-images-no-port-"));
    const img = join(tmp, "no-port.png");
    writeFileSync(img, "x", "utf-8");

    try {
      const result = await runQuest(
        ["create", "Quest no port", "--image", img],
        {
          ...process.env,
          COMPANION_PORT: undefined,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Companion server port not found");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("quest CLI verification inbox commands", () => {
  it("uses verification/read endpoint for quest later", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-verification-read-"));
    const authDir = getSessionAuthDir(tmp);
    mkdirSync(authDir, { recursive: true });
    const authPath = centralAuthPath(tmp, tmp);

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const seenPaths: string[] = [];
    const server = createServer(async (req, res) => {
      seenHeaders.push(req.headers);
      seenPaths.push(req.url || "");
      if (req.method === "POST" && req.url === "/api/quests/q-1/verification/read") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          questId: "q-1",
          title: "Quest",
          status: "needs_verification",
          verificationInboxUnread: false,
          verificationItems: [{ text: "check", checked: false }],
        }));
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
        ["later", "q-1", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        questId: "q-1",
        verificationInboxUnread: false,
      });
      expect(seenPaths).toContain("/api/quests/q-1/verification/read");
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "session-file")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "file-token")).toBe(true);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses verification/inbox endpoint for quest inbox", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-verification-inbox-"));
    const authDir = getSessionAuthDir(tmp);
    mkdirSync(authDir, { recursive: true });
    const authPath = centralAuthPath(tmp, tmp);

    const seenHeaders: Record<string, string | string[] | undefined>[] = [];
    const seenPaths: string[] = [];
    const server = createServer(async (req, res) => {
      seenHeaders.push(req.headers);
      seenPaths.push(req.url || "");
      if (req.method === "POST" && req.url === "/api/quests/q-1/verification/inbox") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          questId: "q-1",
          title: "Quest",
          status: "needs_verification",
          verificationInboxUnread: true,
          verificationItems: [{ text: "check", checked: false }],
        }));
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
        ["inbox", "q-1", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        questId: "q-1",
        verificationInboxUnread: true,
      });
      expect(seenPaths).toContain("/api/quests/q-1/verification/inbox");
      expect(seenHeaders.some((h) => h["x-companion-session-id"] === "session-file")).toBe(true);
      expect(seenHeaders.some((h) => h["x-companion-auth-token"] === "file-token")).toBe(true);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
