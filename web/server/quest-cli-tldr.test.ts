import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
  const childEnv = {
    ...env,
    BUN_INSTALL_CACHE_DIR:
      env.BUN_INSTALL_CACHE_DIR ||
      process.env.BUN_INSTALL_CACHE_DIR ||
      join(process.env.HOME || "", ".bun/install/cache"),
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

describe("quest CLI TLDR metadata", () => {
  it("shows an indented TLDR preview line in plain quest list output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-list-tldr-"));
    const liveDir = join(tmp, ".companion", "questmaster-live");
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(
      join(liveDir, "store.json"),
      JSON.stringify(
        {
          format: "mutable_current_record",
          version: 1,
          nextQuestNumber: 3,
          updatedAt: 0,
          quests: [
            {
              id: "q-1",
              questId: "q-1",
              version: 1,
              title: "Long quest",
              status: "refined",
              description: "Detailed implementation notes that remain available in full detail.",
              tldr: "Short scanner summary for humans.",
              createdAt: 1,
              statusChangedAt: 1,
            },
            {
              id: "q-2",
              questId: "q-2",
              version: 1,
              title: "No TLDR quest",
              status: "idea",
              description: "This quest has no TLDR metadata.",
              createdAt: 2,
              statusChangedAt: 2,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    try {
      const result = await runQuest(
        ["list"],
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
      expect(result.stdout).toContain("q-1");
      expect(result.stdout).toContain("       TLDR: Short scanner summary for humans.");
      expect(result.stdout).toContain("q-2");
      expect(result.stdout.match(/TLDR:/g)).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sends feedback TLDR metadata and warns when long agent feedback omits it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-feedback-tldr-"));
    const authDir = getSessionAuthDir(tmp);
    mkdirSync(authDir, { recursive: true });
    const authPath = centralAuthPath(tmp, tmp);
    const payload = "Long agent update. ".repeat(80);

    const seenBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/quests/q-1/feedback") {
        seenBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            questId: "q-1",
            title: "Quest",
            status: "in_progress",
            feedback: [{ author: "agent", text: payload, tldr: seenBodies.at(-1)?.tldr }],
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
      const missing = await runQuest(
        ["feedback", "q-1", "--text", payload, "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );
      expect(missing.status).toBe(0);
      expect(missing.stderr).toContain("quest feedback is 1200+ characters");

      const withTldr = await runQuest(
        ["feedback", "q-1", "--text", payload, "--tldr", "Short agent update", "--json"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );
      expect(withTldr.status).toBe(0);
      expect(withTldr.stderr).not.toContain("quest feedback is 1200+ characters");
      expect(seenBodies.at(-1)).toMatchObject({ tldr: "Short agent update" });
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("supports quest description TLDR flags and warns for long descriptions without TLDR", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-create-tldr-"));
    const descPath = join(tmp, "desc.md");
    const tldrPath = join(tmp, "tldr.md");
    const longDescription = "Long quest description. ".repeat(80);
    writeFileSync(descPath, longDescription, "utf-8");
    writeFileSync(tldrPath, "Short quest summary", "utf-8");

    try {
      const missing = await runQuest(
        ["create", "Long quest", "--desc-file", descPath, "--json"],
        {
          ...process.env,
          COMPANION_PORT: undefined,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );
      expect(missing.status).toBe(0);
      expect(missing.stderr).toContain("quest description is 1200+ characters");

      const withTldr = await runQuest(
        ["create", "Summarized quest", "--desc-file", descPath, "--tldr-file", tldrPath, "--json"],
        {
          ...process.env,
          COMPANION_PORT: undefined,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );
      expect(withTldr.status).toBe(0);
      expect(withTldr.stderr).not.toContain("quest description is 1200+ characters");
      expect(JSON.parse(withTldr.stdout)).toMatchObject({ tldr: "Short quest summary" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
