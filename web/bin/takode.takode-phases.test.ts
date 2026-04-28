import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

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

function createPhaseCatalogServer() {
  return createServer((req, res) => {
    const method = req.method || "";
    const url = req.url || "";

    if (method === "GET" && url === "/api/takode/me") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessionId: "worker-1", isOrchestrator: false }));
      return;
    }

    if (method === "GET" && url === "/api/takode/quest-journey-phases") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          phases: [
            {
              id: "alignment",
              label: "Alignment",
              boardState: "PLANNING",
              assigneeRole: "worker",
              contract: "Confirm understanding and blockers before deeper work.",
              nextLeaderAction: "review the read-in",
              aliases: ["planning"],
              sourceType: "built-in",
              sourcePath: "/repo/web/shared/quest-journey-phases/alignment",
              phaseJsonPath: "/home/test/.companion/quest-journey-phases/alignment/phase.json",
              leaderBriefPath: "/home/test/.companion/quest-journey-phases/alignment/leader.md",
              assigneeBriefPath: "/home/test/.companion/quest-journey-phases/alignment/assignee.md",
              phaseJsonDisplayPath: "~/.companion/quest-journey-phases/alignment/phase.json",
              leaderBriefDisplayPath: "~/.companion/quest-journey-phases/alignment/leader.md",
              assigneeBriefDisplayPath: "~/.companion/quest-journey-phases/alignment/assignee.md",
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

describe("takode phases", () => {
  it("prints a human-readable phase catalog with exact assignee brief paths", async () => {
    const server = createPhaseCatalogServer();
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["phases", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-1",
        COMPANION_AUTH_TOKEN: "auth-worker",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Quest Journey phases (1):");
      expect(result.stdout).toContain("alignment -- Alignment [built-in]");
      expect(result.stdout).toContain("aliases: planning");
      expect(result.stdout).toContain("assignee brief: ~/.companion/quest-journey-phases/alignment/assignee.md");
      expect(result.stderr).toBe("");
    } finally {
      server.close();
    }
  });

  it("prints structured JSON for automation and future custom source metadata", async () => {
    const server = createPhaseCatalogServer();
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["phases", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-1",
        COMPANION_AUTH_TOKEN: "auth-worker",
      });

      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout) as { phases: Array<Record<string, unknown>> };
      expect(body.phases[0]).toEqual(
        expect.objectContaining({
          id: "alignment",
          sourceType: "built-in",
          sourcePath: "/repo/web/shared/quest-journey-phases/alignment",
          assigneeBriefDisplayPath: "~/.companion/quest-journey-phases/alignment/assignee.md",
        }),
      );
      expect(result.stderr).toBe("");
    } finally {
      server.close();
    }
  });
});
