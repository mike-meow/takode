#!/usr/bin/env bun
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Increase libuv thread pool before any async I/O — prevents thread pool
// exhaustion on NFS when many sessions do concurrent file operations.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "32";

// Package root so the server can find dist/ regardless of CWD
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.__COMPANION_PACKAGE_ROOT = resolve(__dirname, "..");

const command = process.argv[2];

// Management subcommands that delegate to ctl.ts
const CTL_COMMANDS = new Set(["sessions", "envs", "cron", "skills", "settings", "assistant", "ctl-help"]);

function printUsage(): void {
  console.log(`
Usage: takode [command]

Server commands:
  (none)      Start the server in foreground (default)
  serve       Start the server in foreground
  start       Start the background service
  install     Install as a background service (launchd/systemd)
  stop        Stop the background service
  restart     Restart the background service
  uninstall   Remove the background service
  status      Show service status (or use 'takode status' when server is running)
  logs        Tail service log files
  help        Show this help message

Data commands (no server required):
  export      Export session data to a .tar.zst archive [--port PORT]
  import      Import session data from a .tar.zst archive [--port PORT]

Takode session commands (requires running server + Companion session auth):
  takode      Session inspection for all sessions; send/herd/spawn require TAKODE_ROLE=orchestrator

Management commands (requires running server):
  sessions    Manage sessions (list, create, kill, relaunch, archive, rename, send-message)
  envs        Manage environment profiles (list, get, create, update, delete)
  cron        Manage scheduled jobs (list, get, create, update, delete, toggle, run)
  skills      Manage Claude Code skills (list, get, create, update, delete)
  settings    Manage settings (get, set)
  assistant   Manage the Takode Assistant (status, launch, stop, config)

Options:
  --port <n>  Override the default port (default: 3456)
`);
}

switch (command) {
  case "help":
  case "-h":
  case "--help":
    printUsage();
    break;

  case "serve": {
    process.env.NODE_ENV = process.env.NODE_ENV || "production";
    await import("../server/index.ts");
    break;
  }

  case "start": {
    // Internal service process should stay in foreground server mode.
    const forceForeground = process.argv.includes("--foreground");
    const launchedByInit = (() => {
      if (process.ppid === 1) return true;
      // User-level systemd (systemctl --user) spawns services from a
      // per-user systemd process whose ppid != 1.  Detect it via /proc.
      try {
        const { readFileSync } = require("node:fs");
        const comm = readFileSync(`/proc/${process.ppid}/comm`, "utf-8").trim();
        return comm === "systemd";
      } catch {
        return false;
      }
    })();
    if (forceForeground || launchedByInit) {
      process.env.NODE_ENV = process.env.NODE_ENV || "production";
      await import("../server/index.ts");
      break;
    }
    const { start } = await import("../server/service.js");
    await start();
    break;
  }

  case "install": {
    const { install } = await import("../server/service.js");
    const portIdx = process.argv.indexOf("--port");
    const rawPort = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : undefined;
    const port = rawPort && !Number.isNaN(rawPort) ? rawPort : undefined;
    await install({ port });
    break;
  }

  case "uninstall": {
    const { uninstall } = await import("../server/service.js");
    await uninstall();
    break;
  }

  case "status": {
    // Try management API first (server running), fall back to service status
    try {
      const { handleCtlCommand } = await import("./ctl.js");
      await handleCtlCommand("status", process.argv.slice(3));
    } catch {
      // Server not running — show service status
      const { status } = await import("../server/service.js");
      const result = await status();
      if (!result.installed) {
        console.log("Takode is not installed as a service.");
        console.log("Run: takode install");
      } else if (result.running) {
        console.log(`Takode is running (PID: ${result.pid})`);
        console.log(`  URL: http://localhost:${result.port}`);
      } else {
        console.log("Takode is installed but not running.");
        console.log("Check logs at ~/.companion/logs/");
      }
    }
    break;
  }

  case "stop": {
    const { stop } = await import("../server/service.js");
    await stop();
    break;
  }

  case "restart": {
    const { restart } = await import("../server/service.js");
    await restart();
    break;
  }

  case "export": {
    const args = process.argv.slice(3);
    const includeRecordings = args.includes("--include-recordings");
    const exportPortIdx = args.indexOf("--port");
    const exportPort = exportPortIdx !== -1 ? Number(args[exportPortIdx + 1]) : 3456;
    // Determine output path: first non-flag arg (skip --port's value)
    const outputArg = args.find((a, i) => !a.startsWith("--") && i !== exportPortIdx + 1);
    const timestamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
    const outputPath = outputArg || `companion-export-${timestamp}.tar.zst`;
    const { resolve: resolvePath } = await import("node:path");
    const absOutput = resolvePath(outputPath);

    const { runExport } = await import("../server/migration.js");
    try {
      await runExport({ port: exportPort, outputPath: absOutput, includeRecordings });
    } catch (e) {
      console.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  case "import": {
    const importArgs = process.argv.slice(3);
    const importPortIdx = importArgs.indexOf("--port");
    const importPort = importPortIdx !== -1 ? Number(importArgs[importPortIdx + 1]) : 3456;
    const importArg = importArgs.find((a, i) => !a.startsWith("--") && i !== importPortIdx + 1);
    if (!importArg) {
      console.error("Usage: takode import <archive.tar.zst> [--port PORT]");
      process.exit(1);
    }
    const { resolve: resolvePath } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const absArchive = resolvePath(importArg);
    if (!existsSync(absArchive)) {
      console.error(`File not found: ${absArchive}`);
      process.exit(1);
    }

    const { runImport, printImportStats } = await import("../server/migration.js");
    try {
      const stats = await runImport(absArchive, importPort);
      printImportStats(stats);
    } catch (e) {
      console.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }

  case "takode": {
    // Delegate to takode CLI — shift argv so takode sees its own args
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("./takode.js");
    break;
  }

  case "logs": {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { spawn } = await import("node:child_process");
    const logFile = join(homedir(), ".companion/logs/companion.log");
    const errFile = join(homedir(), ".companion/logs/companion.error.log");
    const { existsSync } = await import("node:fs");
    if (!existsSync(logFile) && !existsSync(errFile)) {
      console.error("No log files found at ~/.companion/logs/");
      console.error("The service may not have been started yet.");
      process.exit(1);
    }
    console.log("Tailing logs from ~/.companion/logs/");
    const tail = spawn("tail", ["-f", logFile, errFile], { stdio: "inherit" });
    tail.on("exit", () => process.exit(0));
    break;
  }

  case undefined: {
    // Default: start server in foreground
    process.env.NODE_ENV = process.env.NODE_ENV || "production";
    await import("../server/index.ts");
    break;
  }

  default: {
    if (command && CTL_COMMANDS.has(command)) {
      const { handleCtlCommand } = await import("./ctl.js");
      await handleCtlCommand(command, process.argv.slice(3));
    } else {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}
