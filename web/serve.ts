#!/usr/bin/env bun
/**
 * Production server wrapper with restart support.
 *
 * Runs `bun run build` then starts the server. If the server exits with
 * code 42 (restart requested via the UI), it rebuilds and restarts.
 * Any other exit code stops the wrapper.
 *
 * Usage: bun serve.ts          (or: bun run serve)
 */
import { spawn } from "bun";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESTART_EXIT_CODE } from "./server/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname);

let shuttingDown = false;
let serverProc: ReturnType<typeof spawn> | null = null;

async function build(): Promise<boolean> {
  // Install deps first — no-op when up to date, but catches new packages
  // added by commits pulled between restarts (e.g. highlight.js).
  console.log("\x1b[36m[serve] Installing dependencies...\x1b[0m");
  const install = spawn(["bun", "install"], {
    cwd: webDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  await install.exited;

  console.log("\x1b[36m[serve] Building...\x1b[0m");
  const proc = spawn(["bun", "run", "build"], {
    cwd: webDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\x1b[31m[serve] Build failed (exit ${code})\x1b[0m`);
    return false;
  }
  console.log("\x1b[32m[serve] Build succeeded\x1b[0m");
  return true;
}

async function run() {
  // Initial build
  if (!(await build())) {
    process.exit(1);
  }

  while (true) {
    console.log("\x1b[36m[serve] Starting server...\x1b[0m");
    serverProc = spawn(["bun", "server/index.ts"], {
      cwd: webDir,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
        COMPANION_SUPERVISED: "1",
        UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || "32",
      },
    });

    const code = await serverProc.exited;
    serverProc = null;

    if (shuttingDown) return;

    if (code !== RESTART_EXIT_CODE) {
      console.log(`\x1b[31m[serve] Server exited with code ${code}, stopping.\x1b[0m`);
      process.exit(code ?? 1);
    }

    console.log("\x1b[33m[serve] Server requested restart, rebuilding...\x1b[0m");

    // Brief pause to let the port be released
    await new Promise((r) => setTimeout(r, 1000));

    if (!(await build())) {
      console.error("\x1b[31m[serve] Rebuild failed, restarting with previous build...\x1b[0m");
    }
  }
}

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  serverProc?.kill();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

run();
