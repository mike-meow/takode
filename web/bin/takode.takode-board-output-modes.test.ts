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

describe("takode board output modes", () => {
  it("makes worker reviewer relationships and next action obvious in board show output", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-visible", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-visible/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-420",
                title: "Recover reviewer visibility",
                worker: "worker-558",
                workerNum: 558,
                status: "CODE_REVIEWING",
                waitFor: ["#560"],
                journey: {
                  phaseIds: ["alignment", "implement", "code-review", "port"],
                  activePhaseIndex: 2,
                  revisionReason: "Need another pass before port",
                },
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            resolvedSessionDeps: [],
            rowSessionStatuses: {
              "q-420": {
                worker: { sessionId: "worker-558", sessionNum: 558, status: "idle" },
                reviewer: { sessionId: "reviewer-560", sessionNum: 560, status: "running" },
              },
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
      const result = await runTakode(["board", "show", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-visible",
        COMPANION_AUTH_TOKEN: "auth-board-visible",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("#558 idle / #560 running");
      expect(result.stdout).toContain("read the code-review leader brief");
      expect(result.stdout).not.toContain("revised:");
      expect(result.stdout).not.toContain("Need another pass before port");
    } finally {
      server.close();
    }
  });

  it("keeps default board show output human-first without embedded JSON", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-show", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-show/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-12",
                title: "Simplify board output",
                worker: "worker-1",
                workerNum: 5,
                status: "QUEUED",
                waitFor: ["q-9"],
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            queueWarnings: [
              {
                questId: "q-12",
                kind: "dispatchable",
                summary: "q-12 can be dispatched now: wait-for resolved (q-9).",
                action: "Dispatch it now or replace QUEUED with the next active board stage.",
              },
            ],
            rowSessionStatuses: {
              "q-12": {
                worker: { sessionId: "worker-1", sessionNum: 5, status: "idle" },
                reviewer: null,
              },
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
      const result = await runTakode(["board", "show", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-show",
        COMPANION_AUTH_TOKEN: "auth-board-show",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("QUEST");
      expect(result.stdout).toContain("WORKER / REVIEWER");
      expect(result.stdout).toContain("ACTION");
      expect(result.stdout).toContain("q-12");
      expect(result.stdout).toContain("#5 idle / no reviewer");
      expect(result.stdout).toContain("ready");
      expect(result.stdout).toContain("dispatch now");
      expect(result.stdout).not.toContain("__takode_board__");
      expect(result.stdout).not.toContain('"rowSessionStatuses"');
    } finally {
      server.close();
    }
  });

  it("renders linked wait-for-input state explicitly in board show output", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-input", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-input/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-12",
                title: "Wait for rollout answer",
                worker: "worker-1",
                workerNum: 5,
                status: "IMPLEMENTING",
                waitForInput: ["n-3", "n-8"],
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            rowSessionStatuses: {
              "q-12": {
                worker: { sessionId: "worker-1", sessionNum: 5, status: "idle" },
                reviewer: null,
              },
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
      const result = await runTakode(["board", "show", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-input",
        COMPANION_AUTH_TOKEN: "auth-board-input",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("input 3, 8");
      expect(result.stdout).toContain("wait for user input (3, 8)");
    } finally {
      server.close();
    }
  });

  it("keeps default board show compact and moves Journey notes to board detail", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-notes", isOrchestrator: true }));
        return;
      }

      if (
        method === "GET" &&
        (url === "/api/sessions/leader-board-notes/board?resolve=true" ||
          url === "/api/sessions/leader-board-notes/board?resolve=true&include_completed=true")
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-12",
                title: "Draft Journey notes",
                status: "PROPOSED",
                waitForInput: ["n-3"],
                createdAt: 1,
                updatedAt: 2,
                journey: {
                  mode: "proposed",
                  phaseIds: ["alignment", "implement", "code-review", "implement", "code-review", "port"],
                  phaseNotes: {
                    "2": "focus on stream migration behavior",
                    "4": "inspect only the follow-up diff",
                  },
                },
              },
            ],
            rowSessionStatuses: {},
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
      const compact = await runTakode(["board", "show", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-notes",
        COMPANION_AUTH_TOKEN: "auth-board-notes",
      });

      expect(compact.status).toBe(0);
      expect(compact.stdout).toContain("q-12");
      expect(compact.stdout).not.toContain("journey:");
      expect(compact.stdout).not.toContain("note[3]");
      expect(compact.stdout).not.toContain("focus on stream migration behavior");

      const detail = await runTakode(["board", "detail", "q-12", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-notes",
        COMPANION_AUTH_TOKEN: "auth-board-notes",
      });

      expect(detail.status).toBe(0);
      expect(detail.stdout).toContain(
        "journey: 1. Alignment -> 2. Implement -> 3. Code Review -> 4. Implement -> 5. Code Review -> 6. Port",
      );
      expect(detail.stdout).toContain("note[3] Code Review: focus on stream migration behavior");
      expect(detail.stdout).toContain("note[5] Code Review: inspect only the follow-up diff");
    } finally {
      server.close();
    }
  });

  it("shows the active repeated phase occurrence in the full board show output", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-repeated", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-repeated/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-720",
                title: "Repeated simulation loop",
                status: "MENTAL_SIMULATING",
                createdAt: 1,
                updatedAt: 2,
                journey: {
                  phaseIds: [
                    "alignment",
                    "implement",
                    "mental-simulation",
                    "implement",
                    "mental-simulation",
                    "code-review",
                    "port",
                  ],
                  activePhaseIndex: 4,
                  currentPhaseId: "mental-simulation",
                },
              },
            ],
            rowSessionStatuses: {},
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
      const result = await runTakode(["board", "show", "--full", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-repeated",
        COMPANION_AUTH_TOKEN: "auth-board-repeated",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "journey: 1. Alignment -> 2. Implement -> 3. Mental Simulation -> 4. Implement -> [5. Mental Simulation] -> 6. Code Review -> 7. Port",
      );
    } finally {
      server.close();
    }
  });

  it("emits structured board JSON only in --json mode", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-json", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-json/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [{ questId: "q-12", status: "PLANNING", createdAt: 1, updatedAt: 2 }],
            rowSessionStatuses: {},
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
      const result = await runTakode(["board", "show", "--json", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-json",
        COMPANION_AUTH_TOKEN: "auth-board-json",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"__takode_board__": true');
      expect(result.stdout).toContain('"rowSessionStatuses": {}');
      expect(result.stdout).not.toContain("QUEST");
      expect(result.stdout).not.toContain("WORKER / REVIEWER");
    } finally {
      server.close();
    }
  });

  it("shows queue warnings for dispatchable queued rows, including free-worker readiness", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-warning", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/leader-board-warning/board?resolve=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-88",
                title: "Dispatch queued follow-up",
                status: "QUEUED",
                waitFor: ["free-worker"],
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            queueWarnings: [
              {
                questId: "q-88",
                kind: "dispatchable",
                summary: "q-88 can be dispatched now: worker slots are available (3/5 used).",
                action: "Dispatch it now or replace QUEUED with the next active board stage.",
              },
            ],
            workerSlotUsage: { used: 3, limit: 5 },
            rowSessionStatuses: {},
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
      const result = await runTakode(["board", "show", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-warning",
        COMPANION_AUTH_TOKEN: "auth-board-warning",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ready");
      expect(result.stdout).toContain("dispatch now");
      expect(result.stdout).toContain("q-88 can be dispatched now");
      expect(result.stdout).toContain("Next: Dispatch it now or replace QUEUED");
    } finally {
      server.close();
    }
  });

  it("prints compact mutation output for only the changed row unless full output is requested", async () => {
    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-mutate", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/5/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-5", sessionNum: 5 }));
        return;
      }

      if (method === "POST" && url === "/api/sessions/leader-board-mutate/board") {
        await readJson(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            board: [
              {
                questId: "q-12",
                title: "Compact changed row",
                worker: "worker-5",
                workerNum: 5,
                status: "IMPLEMENTING",
                waitForInput: ["n-3"],
                journey: {
                  phaseIds: ["alignment", "implement", "code-review", "port"],
                  activePhaseIndex: 1,
                  phaseNotes: { "1": "long implementation detail that belongs in board detail" },
                },
                createdAt: 1,
                updatedAt: 2,
              },
              {
                questId: "q-13",
                title: "Unrelated board row",
                worker: "worker-6",
                workerNum: 6,
                status: "CODE_REVIEWING",
                createdAt: 3,
                updatedAt: 4,
              },
            ],
            rowSessionStatuses: {
              "q-12": {
                worker: { sessionId: "worker-5", sessionNum: 5, status: "idle" },
                reviewer: { sessionId: "reviewer-9", sessionNum: 9, status: "disconnected" },
              },
              "q-13": {
                worker: { sessionId: "worker-6", sessionNum: 6, status: "running" },
                reviewer: null,
              },
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
      const compact = await runTakode(["board", "set", "q-12", "--worker", "5", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-mutate",
        COMPANION_AUTH_TOKEN: "auth-board-mutate",
      });

      expect(compact.status).toBe(0);
      expect(compact.stdout).toContain("set q-12: updated");
      expect(compact.stdout).toContain("q-12");
      expect(compact.stdout).toContain("#5 idle / #9 disconnected");
      expect(compact.stdout).toContain("input 3");
      expect(compact.stdout).toContain("wait for user input (3)");
      expect(compact.stdout).not.toContain("q-13");
      expect(compact.stdout).not.toContain("Unrelated board row");
      expect(compact.stdout).not.toContain("long implementation detail");

      const full = await runTakode(["board", "set", "q-12", "--worker", "5", "--full", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-mutate",
        COMPANION_AUTH_TOKEN: "auth-board-mutate",
      });

      expect(full.status).toBe(0);
      expect(full.stdout).toContain("q-12");
      expect(full.stdout).toContain("q-13");
      expect(full.stdout).toContain("long implementation detail");
    } finally {
      server.close();
    }
  });

  it("keeps compact final advance output useful when the completed row leaves the active board", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-advance-final", isOrchestrator: true }));
        return;
      }

      if (method === "POST" && url === "/api/sessions/leader-board-advance-final/board/q-12/advance") {
        // Final Journey advancement removes q-12 from the active board, so the
        // compact path must rely on the mutation summary instead of a row table.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            removed: true,
            previousState: "PORTING",
            newState: "DONE",
            completedCount: 1,
            board: [
              {
                questId: "q-13",
                title: "Unrelated active row",
                status: "IMPLEMENTING",
                createdAt: 3,
                updatedAt: 4,
              },
            ],
            rowSessionStatuses: {},
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
      const result = await runTakode(["board", "advance", "q-12", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-advance-final",
        COMPANION_AUTH_TOKEN: "auth-board-advance-final",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("q-12: completed (moved to history)");
      expect(result.stdout).not.toContain("changed: q-12");
      expect(result.stdout).not.toContain("q-13");
      expect(result.stdout).not.toContain("Unrelated active row");
      expect(result.stdout).not.toContain("QUEST");
    } finally {
      server.close();
    }
  });

  it("keeps compact board rm output focused when the removed row leaves the active board", async () => {
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-board-remove", isOrchestrator: true }));
        return;
      }

      if (method === "DELETE" && url === "/api/sessions/leader-board-remove/board/q-12") {
        // Removed rows are intentionally absent from the returned active board;
        // compact output should acknowledge removal without dumping unrelated rows.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            completedCount: 0,
            board: [
              {
                questId: "q-13",
                title: "Unrelated active row",
                status: "CODE_REVIEWING",
                createdAt: 3,
                updatedAt: 4,
              },
            ],
            rowSessionStatuses: {},
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
      const result = await runTakode(["board", "rm", "q-12", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-board-remove",
        COMPANION_AUTH_TOKEN: "auth-board-remove",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("removed q-12");
      expect(result.stdout).not.toContain("changed: q-12");
      expect(result.stdout).not.toContain("q-13");
      expect(result.stdout).not.toContain("Unrelated active row");
      expect(result.stdout).not.toContain("QUEST");
    } finally {
      server.close();
    }
  });
});
