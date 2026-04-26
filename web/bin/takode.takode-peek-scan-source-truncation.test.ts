import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPeekTurnScan } from "../server/takode-messages.ts";

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

function makeLongContent(prefix: string, fillerLength: number, marker: string): string {
  return `${prefix}${"x".repeat(fillerLength)} ${marker} ${"y".repeat(40)}`;
}

function makeWindowedContent(
  prefix: string,
  visiblePadding: number,
  visibleMarker: string,
  hiddenPadding: number,
  hiddenMarker: string,
): string {
  return `${prefix}${"x".repeat(visiblePadding)} ${visibleMarker} ${"y".repeat(hiddenPadding)} ${hiddenMarker} ${"z".repeat(40)}`;
}

describe("takode peek/scan source-aware truncation", () => {
  it("gives scan human user prompts a generous window while keeping herd prompts aggressive", async () => {
    const userContent = makeWindowedContent("human-summary ", 1880, "USER_SCAN_KEEP", 220, "USER_SCAN_HIDE");
    const herdContent = makeLongContent("herd-summary ", 180, "HERD_SCAN_HIDE");
    const agentContent = makeLongContent("agent-summary ", 120, "AGENT_SCAN_KEEP");
    const now = Date.now();
    const history = [
      { type: "user_message", content: userContent, timestamp: now - 90_000 },
      {
        type: "assistant",
        timestamp: now - 75_000,
        message: { content: [{ type: "text", text: "user turn done" }] },
      },
      {
        type: "result",
        timestamp: now - 60_000,
        data: { duration_ms: 30_000, is_error: false, result: "user turn done" },
      },
      {
        type: "user_message",
        content: herdContent,
        timestamp: now - 60_000,
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      },
      {
        type: "assistant",
        timestamp: now - 50_000,
        message: { content: [{ type: "text", text: "herd turn done" }] },
      },
      {
        type: "result",
        timestamp: now - 40_000,
        data: { duration_ms: 20_000, is_error: false, result: "herd turn done" },
      },
      {
        type: "user_message",
        content: agentContent,
        timestamp: now - 30_000,
        agentSource: { sessionId: "session-7", sessionLabel: "System" },
      },
      {
        type: "assistant",
        timestamp: now - 20_000,
        message: { content: [{ type: "text", text: "agent turn done" }] },
      },
      {
        type: "result",
        timestamp: now - 10_000,
        data: { duration_ms: 20_000, is_error: false, result: "agent turn done" },
      },
    ] as any[];

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-scan-source", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=3") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Scan Worker",
            status: "idle",
            quest: null,
            ...buildPeekTurnScan(history, { fromTurn: 0, turnCount: 3 }),
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
      const result = await runTakode(["scan", "153", "--from", "0", "--count", "3", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-scan-source",
        COMPANION_AUTH_TOKEN: "auth-scan-source",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("user:");
      expect(result.stdout).toContain("herd:");
      expect(result.stdout).toContain("agent System:");
      expect(result.stdout).toContain("USER_SCAN_KEEP");
      expect(result.stdout).not.toContain("USER_SCAN_HIDE");
      expect(result.stdout).toContain("AGENT_SCAN_KEEP");
      expect(result.stdout).not.toContain("HERD_SCAN_HIDE");
    } finally {
      server.close();
    }
  });

  it("gives peek user messages more visible space than herd messages while keeping source provenance", async () => {
    const userContent = makeLongContent("peek-user ", 360, "USER_PEEK_KEEP");
    const herdContent = makeLongContent("peek-herd ", 360, "HERD_PEEK_HIDE");
    const agentContent = makeLongContent("peek-agent ", 220, "AGENT_PEEK_KEEP");

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-peek-source", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?count=3&from=0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Peek Worker",
            status: "idle",
            quest: null,
            mode: "range",
            totalMessages: 3,
            from: 0,
            to: 2,
            bounds: [{ turn: 0, si: 0, ei: 2 }],
            messages: [
              {
                idx: 0,
                type: "user",
                ts: Date.now() - 30_000,
                content: userContent,
              },
              {
                idx: 1,
                type: "user",
                ts: Date.now() - 20_000,
                content: herdContent,
                agent: { sessionId: "herd-events" },
              },
              {
                idx: 2,
                type: "user",
                ts: Date.now() - 10_000,
                content: agentContent,
                agent: { sessionId: "session-9", sessionLabel: "System" },
              },
            ],
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
      const result = await runTakode(["peek", "153", "--from", "0", "--count", "3", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-peek-source",
        COMPANION_AUTH_TOKEN: "auth-peek-source",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("user  ");
      expect(result.stdout).toContain("herd  ");
      expect(result.stdout).toContain("agent System");
      expect(result.stdout).toContain("USER_PEEK_KEEP");
      expect(result.stdout).toContain("AGENT_PEEK_KEEP");
      expect(result.stdout).not.toContain("HERD_PEEK_HIDE");
    } finally {
      server.close();
    }
  });

  it("gives takode read a generous human user window while keeping herd reads shorter and labeled", async () => {
    const userContent = makeWindowedContent("read-user ", 1888, "READ_USER_KEEP", 220, "READ_USER_HIDE");
    const herdContent = makeWindowedContent("read-herd ", 120, "READ_HERD_KEEP", 120, "READ_HERD_HIDE");

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-read-source", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages/0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            idx: 0,
            type: "user_message",
            ts: Date.now() - 30_000,
            totalLines: 1,
            offset: 0,
            limit: 200,
            content: userContent,
            rawMessage: {
              type: "user_message",
              content: userContent,
              timestamp: Date.now() - 30_000,
            },
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages/1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            idx: 1,
            type: "user_message",
            ts: Date.now() - 20_000,
            totalLines: 1,
            offset: 0,
            limit: 200,
            content: herdContent,
            rawMessage: {
              type: "user_message",
              content: herdContent,
              timestamp: Date.now() - 20_000,
              agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
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

    try {
      const userResult = await runTakode(["read", "153", "0", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-read-source",
        COMPANION_AUTH_TOKEN: "auth-read-source",
      });
      const herdResult = await runTakode(["read", "153", "1", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-read-source",
        COMPANION_AUTH_TOKEN: "auth-read-source",
      });

      expect(userResult.status).toBe(0);
      expect(userResult.stdout).toContain("[msg 0] user --");
      expect(userResult.stdout).toContain("READ_USER_KEEP");
      expect(userResult.stdout).not.toContain("READ_USER_HIDE");
      expect(userResult.stdout).toContain("more chars hidden");

      expect(herdResult.status).toBe(0);
      expect(herdResult.stdout).toContain("[msg 1] herd --");
      expect(herdResult.stdout).toContain("READ_HERD_KEEP");
      expect(herdResult.stdout).not.toContain("READ_HERD_HIDE");
      expect(herdResult.stdout).toContain("more chars hidden");
    } finally {
      server.close();
    }
  });
});
