import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatQuestDetail, type SessionMetadata } from "../bin/quest-format.js";
import { fetchSessionMetadataMap } from "../bin/quest-session-metadata.js";
import type { QuestmasterTask } from "./quest-types.js";
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
  const childEnv = {
    ...env,
    // Keep Bun's package cache on the real home directory even when tests
    // override HOME to isolate the quest store under a temp directory.
    BUN_INSTALL_CACHE_DIR:
      env.BUN_INSTALL_CACHE_DIR || process.env.BUN_INSTALL_CACHE_DIR || join(process.env.HOME || "", ".bun/install/cache"),
  };
  const child = spawn(process.execPath, [questPath, ...args], {
    env: childEnv,
    cwd,
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

describe("quest CLI help", () => {
  it("documents search tips for list filtering vs grep snippets", async () => {
    // Guard the user-facing `quest --help` copy so the grep discoverability
    // wording stays aligned with the CLI entrypoint, not just generated docs.
    const result = await runQuest(["--help"], { ...process.env });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "grep   <pattern> [--count N] [--json]                  Search inside quest title, description, and feedback/comments with snippets",
    );
    expect(result.stdout).toContain('quest list --text "foo"   Filter quests broadly by text');
    expect(result.stdout).toContain(
      'quest grep "foo|bar"      Search inside quest text/comments with contextual snippets',
    );
  });
});

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
        res.end(
          JSON.stringify({
            questId: "q-1",
            title: "Quest",
            status: "in_progress",
            sessionId: "session-file",
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
          TAKODE_ROLE: undefined,
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
        res.end(
          JSON.stringify({
            questId: "q-1",
            title: "Quest",
            status: "needs_verification",
            feedback: [{ author: "agent", text: "Addressed" }],
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
          res.end(
            JSON.stringify({
              id: `img-${uploadCount}`,
              filename: `img-${uploadCount}.png`,
              mimeType: "image/png",
              path: `/tmp/img-${uploadCount}.png`,
            }),
          );
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
        ["create", "Quest with images", "--image", imgA, "--images", `${imgB}, ${imgC}`, "--json"],
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

describe("quest CLI parallel create", () => {
  it("returns unique quest IDs for concurrent create commands", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-create-parallel-"));

    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          runQuest(
            ["create", `Parallel quest ${index + 1}`, "--json"],
            {
              ...process.env,
              COMPANION_PORT: undefined,
              COMPANION_SESSION_ID: undefined,
              COMPANION_AUTH_TOKEN: undefined,
              HOME: tmp,
            },
            tmp,
          ),
        ),
      );

      for (const result of results) {
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
      }

      const quests = results.map(
        (result) =>
          JSON.parse(result.stdout) as {
            questId: string;
            id: string;
            title: string;
          },
      );

      const numericIds = quests.map((quest) => Number(quest.questId.slice(2))).sort((a, b) => a - b);
      expect(new Set(quests.map((quest) => quest.questId)).size).toBe(5);
      expect(numericIds).toEqual([1, 2, 3, 4, 5]);

      const questFiles = readdirSync(join(tmp, ".companion", "questmaster"))
        .filter((name) => /^q-\d+-v1\.json$/.test(name))
        .sort((a, b) => Number(a.match(/^q-(\d+)-/)?.[1]) - Number(b.match(/^q-(\d+)-/)?.[1]));
      expect(questFiles).toEqual(["q-1-v1.json", "q-2-v1.json", "q-3-v1.json", "q-4-v1.json", "q-5-v1.json"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("quest CLI grep", () => {
  it("prints quest ids, match fields, and contextual snippets in text mode", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-grep-text-"));
    const questDir = join(tmp, ".companion", "questmaster");
    mkdirSync(questDir, { recursive: true });

    writeFileSync(
      join(questDir, "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Add beta search",
          createdAt: 1,
          status: "refined",
          description: "Description without the keyword.",
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(questDir, "q-2-v2.json"),
      JSON.stringify(
        {
          id: "q-2-v2",
          questId: "q-2",
          version: 2,
          prevId: "q-2-v1",
          title: "Feedback quest",
          createdAt: 2,
          status: "needs_verification",
          description:
            "Beta appears in the description too, and the surrounding text is intentionally long so the rendered snippet has to be compact and easy to scan in grouped output.",
          sessionId: "session-2",
          claimedAt: 2,
          verificationItems: [{ text: "Visual review", checked: false }],
          feedback: [{ author: "human", text: "Please keep beta context in the snippet output.", ts: 2 }],
        },
        null,
        2,
      ),
      "utf-8",
    );

    try {
      const result = await runQuest(
        ["grep", "beta"],
        {
          ...process.env,
          COMPANION_PORT: undefined,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('3 quest matches for "beta"');
      expect(result.stdout).toContain("q-1    Add beta search (refined)");
      expect(result.stdout).toContain("title");
      expect(result.stdout).toContain("q-2    Feedback quest (verification)");
      expect(result.stdout).toContain("description");
      expect(result.stdout).toContain("feedback[0] | human |");
      expect(result.stdout).not.toContain("field:");
      expect(result.stdout.match(/q-2    Feedback quest/g)?.length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns structured JSON without expanding the feedback-match contract", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-grep-json-"));
    const questDir = join(tmp, ".companion", "questmaster");
    mkdirSync(questDir, { recursive: true });

    writeFileSync(
      join(questDir, "q-3-v1.json"),
      JSON.stringify(
        {
          id: "q-3-v1",
          questId: "q-3",
          version: 1,
          title: "Context quest",
          createdAt: 3,
          status: "needs_verification",
          description: "alpha in description",
          sessionId: "session-3",
          claimedAt: 3,
          verificationItems: [{ text: "Check it", checked: false }],
          feedback: [{ author: "agent", text: "Summary: alpha retained in follow-up note", ts: 3 }],
        },
        null,
        2,
      ),
      "utf-8",
    );

    try {
      const result = await runQuest(
        ["grep", "alpha", "--count", "5", "--json"],
        {
          ...process.env,
          COMPANION_PORT: undefined,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        query: string;
        totalMatches: number;
        matches: Array<{ questId: string; matchedField: string; feedbackAuthor?: string; feedbackTs?: number }>;
      };
      expect(parsed.query).toBe("alpha");
      expect(parsed.totalMatches).toBe(2);
      expect(parsed.matches).toHaveLength(2);
      expect(parsed.matches.every((match) => match.questId === "q-3")).toBe(true);
      expect(parsed.matches.map((match) => match.matchedField)).toEqual(["description", "feedback[0]"]);
      expect(parsed.matches[1]).toMatchObject({ feedbackAuthor: "agent" });
      expect(parsed.matches[1]).not.toHaveProperty("feedbackTs");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails fast on invalid regex patterns with a clear error", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-grep-invalid-"));
    const questDir = join(tmp, ".companion", "questmaster");
    mkdirSync(questDir, { recursive: true });

    writeFileSync(
      join(questDir, "q-4-v1.json"),
      JSON.stringify(
        {
          id: "q-4-v1",
          questId: "q-4",
          version: 1,
          title: "Regex failure quest",
          createdAt: 4,
          status: "refined",
          description: "This data should not be searched when the pattern is invalid.",
        },
        null,
        2,
      ),
      "utf-8",
    );

    try {
      const result = await runQuest(
        ["grep", "foo[bar"],
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
      expect(result.stderr).toContain('Error: Invalid regex pattern "foo[bar"');
      expect(result.stdout).not.toContain("No quest matches");
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
        res.end(
          JSON.stringify({
            questId: "q-1",
            title: "Quest",
            status: "needs_verification",
            verificationInboxUnread: false,
            verificationItems: [{ text: "check", checked: false }],
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
        res.end(
          JSON.stringify({
            questId: "q-1",
            title: "Quest",
            status: "needs_verification",
            verificationInboxUnread: true,
            verificationItems: [{ text: "check", checked: false }],
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

describe("quest CLI completion reminder", () => {
  it("prints a summary-comment reminder after successful HTTP completion", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-complete-reminder-http-"));
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
            status: "needs_verification",
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
      expect(result.stdout).toContain('Completed q-1 "Quest" with 1 verification items');
      expect(result.stdout).toContain("Reminder: keep one substantive quest summary comment up to date");
      expect(result.stdout).toContain('quest feedback q-1 --text "Summary: <what was done>"');
      expect(result.stdout).toContain("Use `--commit/--commits` structured metadata for routine port info");
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints the no-code completion reminder only when --no-code is set", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-complete-no-code-http-"));
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
            status: "needs_verification",
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
      expect(result.stdout).not.toContain("Use `--commit/--commits` structured metadata for routine port info");
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects combining --no-code with commit metadata", async () => {
    const result = await runQuest(["complete", "q-1", "--items", "Review artifact", "--no-code", "--commit", "abc1234"], {
      ...process.env,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--no-code cannot be combined with --commit/--commits");
  });

  it("forwards explicit commit SHAs during HTTP completion", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-complete-commits-http-"));
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
            status: "needs_verification",
            verificationItems: [{ text: "Visual check", checked: false }],
            commitShas: ["abc1234", "deadbeef"],
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
        ["complete", "q-1", "--items", "Visual check", "--commit", "ABC1234", "--commits", "deadbeef,abc1234"],
        {
          ...process.env,
          COMPANION_PORT: String(port),
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(seenBodies[0]).toMatchObject({
        verificationItems: [{ text: "Visual check", checked: false }],
        commitShas: ["abc1234", "deadbeef"],
      });
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints the same summary-comment reminder on filesystem fallback completion", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-complete-reminder-fallback-"));
    const questDir = join(tmp, ".companion", "questmaster");
    mkdirSync(questDir, { recursive: true });

    // Seed a minimal in_progress quest directly on disk so the child CLI uses
    // the direct-filesystem completion path without needing the Companion server.
    writeFileSync(
      join(questDir, "q-1-v2.json"),
      JSON.stringify(
        {
          id: "q-1-v2",
          questId: "q-1",
          version: 2,
          prevId: "q-1-v1",
          title: "Quest",
          createdAt: Date.now(),
          status: "in_progress",
          description: "Test quest for completion reminder",
          sessionId: "session-test",
          claimedAt: Date.now(),
        },
        null,
        2,
      ),
      "utf-8",
    );

    try {
      const result = await runQuest(
        ["complete", "q-1", "--items", "Visual check"],
        {
          ...process.env,
          COMPANION_PORT: undefined,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Completed q-1 "Quest" with 1 verification items');
      expect(result.stdout).toContain("Reminder: keep one substantive quest summary comment up to date");
      expect(result.stdout).toContain('quest feedback q-1 --text "Summary: <what was done>"');
      expect(result.stdout).toContain("Use `--commit/--commits` structured metadata for routine port info");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("quest CLI show session numbers", () => {
  it("shows Takode session numbers prominently for active and previous owners", async () => {
    const quest: QuestmasterTask = {
      id: "q-1-v2",
      questId: "q-1",
      version: 2,
      prevId: "q-1-v1",
      title: "Quest with owners",
      createdAt: Date.now() - 60_000,
      status: "in_progress",
      description: "Quest show should surface human-friendly session numbers.",
      sessionId: "active-12345678",
      previousOwnerSessionIds: ["prev-11111111", "prev-22222222"],
      claimedAt: Date.now() - 30_000,
    };
    const sessionMetadata = new Map<string, SessionMetadata>([
      ["active-12345678", { archived: false, sessionNum: 42, name: "Active Worker" }],
      ["prev-11111111", { archived: false, sessionNum: 7, name: "Earlier Worker" }],
      ["prev-22222222", { archived: false, sessionNum: 8 }],
    ]);

    const detail = formatQuestDetail(quest, sessionMetadata, {
      currentSessionId: "active-12345678",
      getSessionName: () => undefined,
    });

    expect(detail).toContain('Session:     #42 "Active Worker" (active-1, you)');
    expect(detail).toContain('Previous:    #7 "Earlier Worker" (prev-111), #8 (prev-222)');
  });

  it("falls back to UUID-focused labels when session numbers are unavailable", async () => {
    const quest: QuestmasterTask = {
      id: "q-1-v2",
      questId: "q-1",
      version: 2,
      prevId: "q-1-v1",
      title: "Quest without numbers",
      createdAt: Date.now() - 60_000,
      status: "in_progress",
      description: "Quest show should keep UUID prefixes when no session number resolves.",
      sessionId: "fallback-123456",
      previousOwnerSessionIds: ["prevless-87654"],
      claimedAt: Date.now() - 30_000,
    };

    const detail = formatQuestDetail(quest, undefined, {
      currentSessionId: "fallback-123456",
      getSessionName: (sessionId) =>
        ({
          "fallback-123456": "Fallback Worker",
          "prevless-87654": "Earlier Worker",
        })[sessionId],
    });

    expect(detail).toContain('Session:     "Fallback Worker" (fallback) (you)');
    expect(detail).toContain('Previous:    "Earlier Worker" (prevless)');
  });

  it("loads session numbers from the real /api/sessions payload shape used by quest show", async () => {
    // Spawning the full Bun CLI from this harness is blocked in this workspace
    // because quest.ts transitively imports sharp and Bun resolves that optional
    // dependency through a temp HOME-scoped cache before cmdShow() runs. This
    // test still covers the live session-metadata fetch path that quest show
    // depends on, rather than only the pure formatter output.
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            { sessionId: "active-12345678", sessionNum: 42, name: "Active Worker" },
            { sessionId: "prev-11111111", sessionNum: 7, archived: true },
          ]),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = String((server.address() as AddressInfo).port);

    try {
      const metadata = await fetchSessionMetadataMap(port, {});
      expect(metadata.get("active-12345678")).toEqual({
        archived: false,
        sessionNum: 42,
        name: "Active Worker",
      });
      expect(metadata.get("prev-11111111")).toEqual({
        archived: true,
        sessionNum: 7,
        name: undefined,
      });
    } finally {
      server.close();
    }
  });
});
