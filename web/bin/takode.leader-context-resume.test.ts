import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
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

async function runTakode(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const takodePath = fileURLToPath(new URL("./takode.ts", import.meta.url));
  const child = spawn(process.execPath, [takodePath, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.end();

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

describe("takode leader-context-resume", () => {
  it("renders compact text output from the structured resume payload", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";
      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-ctx", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-ctx/leader-context-resume") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            leader: { sessionId: "leader-ctx", sessionNum: 1132, name: "Leader" },
            observed: {
              unresolvedUserDecisions: [],
              unresolvedNotifications: [],
              activeBoardQuests: [
                {
                  questId: "q-773",
                  title: "Recover leader context after compaction",
                  currentBoardPhase: "IMPLEMENTING",
                  worker: {
                    sessionId: "worker-ctx",
                    sessionNum: 1128,
                    name: "Worker",
                    role: "worker",
                    status: "idle",
                  },
                  questStatus: "in_progress",
                  rowUpdatedAt: 1,
                  lastRelevantLeaderInstruction: {
                    participantRole: "worker",
                    participantSessionId: "worker-ctx",
                    participantSessionNum: 1128,
                    phaseId: "implement",
                    summary: "explicit `IMPLEMENT` dispatch",
                    source: { sessionId: "worker-ctx", sessionNum: 1128, messageIndex: 3, timestamp: 3_000 },
                  },
                },
              ],
              warnings: [],
            },
            synthesized: {
              activeBoardQuests: [
                {
                  questId: "q-773",
                  whyHere: 'worker result "Within scope: proceed to implement."',
                  whyHereSource: { sessionId: "worker-ctx", sessionNum: 1128, messageIndex: 2, timestamp: 2_025 },
                  nextLeaderAction: "wait for the worker report from [#1128](session:1128)",
                  warnings: [],
                },
              ],
              warnings: [],
              suggestedCommands: ["takode peek 1128"],
            },
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

    const result = await runTakode(["leader-context-resume", "leader-ctx", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-ctx",
      COMPANION_AUTH_TOKEN: "auth-token",
    });

    server.close();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Recovery for [#1132](session:1132)");
    expect(result.stdout).toContain("[q-773](quest:q-773) -- IMPLEMENTING");
    expect(result.stdout).toContain("latest result: none since that instruction");
    expect(result.stdout).toContain("`takode peek 1128`");
  });

  it("passes through json and surfaces the strict leader-only error", async () => {
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";
      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-ctx", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-ctx/leader-context-resume") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ leader: { sessionId: "leader-ctx", sessionNum: 7 }, observed: {}, synthesized: {} }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/not-a-leader/leader-context-resume") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Session is not recognized as a leader/orchestrator session; takode leader-context-resume only supports leader sessions.",
          }),
        );
        return;
      }
      await readJson(req);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const jsonResult = await runTakode(["leader-context-resume", "leader-ctx", "--json", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-ctx",
      COMPANION_AUTH_TOKEN: "auth-token",
    });
    const errorResult = await runTakode(["leader-context-resume", "not-a-leader", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-ctx",
      COMPANION_AUTH_TOKEN: "auth-token",
    });

    server.close();

    expect(jsonResult.status).toBe(0);
    expect(jsonResult.stdout).toContain('"leader"');
    expect(jsonResult.stdout).toContain('"observed"');
    expect(jsonResult.stdout).toContain('"synthesized"');

    expect(errorResult.status).toBe(1);
    expect(errorResult.stderr).toContain("leader/orchestrator");
  });
});
