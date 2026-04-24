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

describe("takode watch deprecation", () => {
  it("does not advertise watch in help output", async () => {
    const result = await runTakode(["--help"], {
      ...process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("watch");
  });

  it("fails with unknown command for deprecated watch", async () => {
    const result = await runTakode(["watch", "--sessions", "1"], {
      ...process.env,
      COMPANION_SESSION_ID: "leader-1",
      COMPANION_AUTH_TOKEN: "auth-1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: watch");
    expect(result.stdout).toContain("Usage: takode <command>");
  });

  it.each([
    [["list", "--help"], "Usage: takode list"],
    [["search", "--help"], "Usage: takode search"],
    [["info", "--help"], "Usage: takode info"],
    [["send", "--help"], "Usage: takode send"],
    [["logs", "--help"], "Usage: takode logs"],
    [["notify", "--help"], "Usage: takode notify"],
  ])("prints top-level command help without auth for %j", async (argv, expected) => {
    const result = await runTakode(argv, {
      ...process.env,
      COMPANION_SESSION_ID: undefined,
      COMPANION_AUTH_TOKEN: undefined,
      COMPANION_PORT: undefined,
      TAKODE_API_PORT: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stderr).toBe("");
  });

  it.each([
    [["board", "--help"], "Usage: takode board [show|set|advance|advance-no-groom|rm] ..."],
    [["board", "set", "--help"], "Usage: takode board set <quest-id>"],
    [["board", "advance", "--help"], "Usage: takode board advance <quest-id>"],
    [["board", "advance-no-groom", "--help"], "Usage: takode board advance-no-groom <quest-id>"],
    [["branch", "--help"], "Usage: takode branch <status|set-base> ..."],
    [["branch", "status", "--help"], "Usage: takode branch status [--json]"],
    [["branch", "set-base", "--help"], "Usage: takode branch set-base <branch> [--json]"],
    [["timer", "--help"], "Usage: takode timer <create|list|cancel> ..."],
    [["timer", "create", "--help"], "Usage: takode timer create <title>"],
    [["timer", "cancel", "--help"], "Usage: takode timer cancel <timer-id>"],
    [["help", "board", "set"], "Usage: takode board set <quest-id>"],
    [["help", "timer", "create"], "Usage: takode timer create <title>"],
  ])("prints nested help without executing live commands for %j", async (argv, expected) => {
    const result = await runTakode(argv, {
      ...process.env,
      COMPANION_SESSION_ID: undefined,
      COMPANION_AUTH_TOKEN: undefined,
      COMPANION_PORT: undefined,
      TAKODE_API_PORT: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("__takode_board__");
    expect(result.stdout).not.toContain("Board is empty.");
    expect(result.stdout).not.toContain("No active sessions.");
    expect(result.stdout).not.toContain("Cannot connect to Companion server");
  });

  it("documents advance-no-groom as only for zero git-tracked changes", async () => {
    const result = await runTakode(["board", "advance-no-groom", "--help"], {
      ...process.env,
      COMPANION_SESSION_ID: undefined,
      COMPANION_AUTH_TOKEN: undefined,
      COMPANION_PORT: undefined,
      TAKODE_API_PORT: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("zero git-tracked changes");
    expect(result.stdout).toContain(
      "Git-tracked docs, skills, prompts, templates, and other text-only edits do not qualify",
    );
  });

  it("keeps unknown commands with --help as an error", async () => {
    const result = await runTakode(["wat", "--help"], {
      ...process.env,
      COMPANION_SESSION_ID: undefined,
      COMPANION_AUTH_TOKEN: undefined,
      COMPANION_PORT: undefined,
      TAKODE_API_PORT: undefined,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: wat");
    expect(result.stdout).toContain("Usage: takode <command>");
  });
});
