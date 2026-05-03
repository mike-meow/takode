import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function runTakode(
  args: string[],
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
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

describe("takode peek tool durations", () => {
  it("renders expanded tool durations in range peek output", async () => {
    // Regression: the range renderer used formatDurationSeconds without importing it,
    // so real peek responses containing expanded tool durations crashed at runtime.
    const now = Date.now();
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-peek-duration", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?count=2&from=0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "session-153",
            sn: 153,
            name: "Worker Peek",
            status: "idle",
            quest: null,
            mode: "range",
            totalMessages: 2,
            from: 0,
            to: 1,
            messages: [
              { idx: 0, type: "user", content: "inspect tool duration", ts: now - 2_000 },
              {
                idx: 1,
                type: "assistant",
                content: "",
                ts: now - 1_000,
                tools: [
                  {
                    idx: 1,
                    name: "Bash",
                    summary: "takode peek 1405 --from 3440 --count 180",
                    status: "completed",
                    durationSeconds: 1.2,
                  },
                ],
              },
            ],
            bounds: [{ turn: 1, si: 0, ei: 1 }],
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
      const result = await runTakode(["peek", "153", "--from", "0", "--count", "2", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "worker-peek-duration",
        COMPANION_AUTH_TOKEN: "auth-worker-peek-duration",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Bash");
      expect(result.stdout).toContain("1.2s");
      expect(result.stdout).not.toContain("formatDurationSeconds is not defined");
    } finally {
      server.close();
    }
  });
});
