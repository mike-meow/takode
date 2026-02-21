#!/usr/bin/env bun
/**
 * Unified dev server — runs both the Hono backend and Vite frontend
 * in a single terminal. Ctrl+C kills both.
 *
 * If the backend exits with code 42 (restart requested), only the backend
 * is respawned — Vite keeps running. Any other exit kills everything.
 */
import { spawn, type Subprocess } from "bun";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESTART_EXIT_CODE } from "./server/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname);

const procs: Subprocess[] = [];
let shuttingDown = false;

function prefix(name: string, color: string, stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const reset = "\x1b[0m";
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (line.trim()) {
          process.stdout.write(`${color}[${name}]${reset} ${line}\n`);
        }
      }
    }
  })();
}

function spawnBackend(): Subprocess {
  const proc = spawn(["bun", "--watch", "server/index.ts"], {
    cwd: webDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "development", COMPANION_SUPERVISED: "1" },
  });
  prefix("api", "\x1b[36m", proc.stdout);
  prefix("api", "\x1b[31m", proc.stderr);
  return proc;
}

// ── Backend (Hono on Bun) — restarts on exit code 42 ─────────────
let backend = spawnBackend();
procs.push(backend);

async function monitorBackend() {
  while (true) {
    const code = await backend.exited;
    if (shuttingDown) return;

    if (code === RESTART_EXIT_CODE) {
      console.log("\x1b[33m[dev] Backend requested restart (exit 42), respawning...\x1b[0m");
      // Remove old proc from the list
      const idx = procs.indexOf(backend);
      if (idx !== -1) procs.splice(idx, 1);
      // Brief pause to let the port be released
      await new Promise((r) => setTimeout(r, 1000));
      backend = spawnBackend();
      procs.push(backend);
      continue;
    }

    console.error(`\x1b[31m[dev] Backend exited with code ${code}, shutting down...\x1b[0m`);
    cleanup();
    return;
  }
}

// ── Vite (frontend HMR) ───────────────────────────────────────────
const vite = spawn(["bun", "run", "dev:vite"], {
  cwd: webDir,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, NODE_ENV: "development" },
});
procs.push(vite);
prefix("vite", "\x1b[35m", vite.stdout);
prefix("vite", "\x1b[31m", vite.stderr);

// ── Cleanup on exit ───────────────────────────────────────────────
function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) p.kill();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// If Vite exits, kill everything
vite.exited.then((code) => {
  if (shuttingDown) return;
  console.error(`\x1b[31m[dev] Vite exited with code ${code}, shutting down...\x1b[0m`);
  cleanup();
});

// Monitor backend for restart signals
monitorBackend();
