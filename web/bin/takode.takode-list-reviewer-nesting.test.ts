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

describe("takode list reviewer nesting", () => {
  // Verifies that reviewer sessions are nested under their parent worker
  // in the CWD group, the group header count excludes reviewers, and
  // orphaned reviewers (parent not visible) fall back to their own CWD group.

  it("nests reviewer under parent and excludes reviewer from group count", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-nest", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "worker-a",
              sessionNum: 10,
              name: "Fix tree view",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 20_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: true,
            },
            {
              sessionId: "reviewer-a",
              sessionNum: 11,
              name: "Reviewer of #10",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 10_000,
              lastActivityAt: Date.now() - 3_000,
              cliConnected: true,
              reviewerOf: 10,
            },
            {
              sessionId: "worker-b",
              sessionNum: 12,
              name: "Fix quest styling",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 15_000,
              lastActivityAt: Date.now() - 8_000,
              cliConnected: true,
            },
          ]),
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
      const result = await runTakode(["list", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-nest",
        COMPANION_AUTH_TOKEN: "auth-nest",
      });

      expect(result.status).toBe(0);

      // Group header should show 2 (two workers), not 3 (which would include the reviewer)
      expect(result.stdout).toMatch(/▸\s+companion\s+2/);
      expect(result.stdout).not.toMatch(/▸\s+companion\s+3/);

      // Reviewer should be visually nested with ↳ prefix on the same line as its name
      expect(result.stdout).toMatch(/↳.*#11.*Reviewer of #10/);

      // Parent worker should expose attached reviewer state directly.
      expect(result.stdout).toMatch(/#10.*👀 #11 idle/);

      // Reviewer has [reviewer] role tag
      expect(result.stdout).toContain("[reviewer]");

      // Both workers should appear as top-level entries
      expect(result.stdout).toContain("#10");
      expect(result.stdout).toContain("#12");

      // Reviewer appears after its parent in output (nesting order)
      const lines = result.stdout.split("\n");
      const parentIdx = lines.findIndex((l) => l.includes("#10") && !l.includes("↳"));
      const reviewerIdx = lines.findIndex((l) => l.includes("#11") && l.includes("↳"));
      expect(parentIdx).toBeGreaterThanOrEqual(0);
      expect(reviewerIdx).toBeGreaterThan(parentIdx);
    } finally {
      server.close();
    }
  });

  it("falls back orphaned reviewer to its own CWD group", async () => {
    // When the reviewer's parent is not in the session list (e.g. archived
    // or filtered out), the reviewer should fall back to its own CWD key
    // rather than disappearing.
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-orphan", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "orphan-reviewer",
              sessionNum: 20,
              name: "Reviewer of #99",
              state: "idle",
              archived: false,
              cwd: "/repo/other-project",
              createdAt: Date.now() - 10_000,
              lastActivityAt: Date.now() - 3_000,
              cliConnected: true,
              reviewerOf: 99, // parent #99 is not in the list
            },
          ]),
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
      const result = await runTakode(["list", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-orphan",
        COMPANION_AUTH_TOKEN: "auth-orphan",
      });

      expect(result.status).toBe(0);

      // Orphaned reviewer appears under its own CWD group with correct header.
      // The header count is 0 top-level sessions (the reviewer is still a reviewer),
      // but the reviewer is rendered as an orphan inside printNestedSessions.
      expect(result.stdout).toMatch(/▸\s+other-project\s+0/);
      expect(result.stdout).toMatch(/↳.*Reviewer of #99/);
    } finally {
      server.close();
    }
  });

  it("shows worker-slot usage separately from the raw session total", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-slot-summary", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              sessionId: "leader-slot-summary",
              sessionNum: 9,
              name: "Leader Slot Summary",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 30_000,
              lastActivityAt: Date.now() - 12_000,
              cliConnected: true,
              isOrchestrator: true,
            },
            {
              sessionId: "worker-a",
              sessionNum: 10,
              name: "Fix tree view",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 20_000,
              lastActivityAt: Date.now() - 5_000,
              cliConnected: true,
              herdedBy: "leader-slot-summary",
            },
            {
              sessionId: "reviewer-a",
              sessionNum: 11,
              name: "Reviewer of #10",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 10_000,
              lastActivityAt: Date.now() - 3_000,
              cliConnected: true,
              reviewerOf: 10,
              herdedBy: "leader-slot-summary",
            },
            {
              sessionId: "worker-b",
              sessionNum: 12,
              name: "Fix quest styling",
              state: "idle",
              archived: false,
              cwd: "/repo/companion",
              createdAt: Date.now() - 15_000,
              lastActivityAt: Date.now() - 8_000,
              cliConnected: true,
              herdedBy: "leader-slot-summary",
            },
          ]),
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
      const result = await runTakode(["list", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-slot-summary",
        COMPANION_AUTH_TOKEN: "auth-slot-summary",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("3 session(s) shown (2 workers, 1 reviewer)");
      expect(result.stdout).toContain(
        "Worker slots used: 2/5. Reviewers do not use worker slots, and archiving reviewers will not free worker-slot capacity.",
      );
    } finally {
      server.close();
    }
  });
});
