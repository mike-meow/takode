/**
 * Architecture guards — enforce structural rules that prevent performance
 * regressions on NFS-mounted home directories.
 *
 * These tests scan server source files for forbidden patterns. They run as
 * part of the normal test suite, so violations are caught before code can
 * be synced to main.
 *
 * Escape hatch: add a `// sync-ok` comment on the same line to suppress
 * a violation. Use this ONLY for documented cold-path calls (e.g. mkdirSync
 * in constructors, readFileSync in cached-once ensureLoaded() functions).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SERVER_DIR = join(__dirname);

/** Recursively collect all .ts files under a directory, excluding test files. */
function collectSourceFiles(dir: string, result: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, result);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      result.push(full);
    }
  }
  return result;
}

// Sync fs/child_process calls that block the event loop on NFS.
// mkdirSync is intentionally excluded — it's acceptable in constructors/startup.
const FORBIDDEN_SYNC_CALLS = [
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "accessSync",
  "renameSync",
  "unlinkSync",
  "copyFileSync",
  "readdirSync",
  "chmodSync",
  "utimesSync",
  "rmSync",
  "execSync",
  "spawnSync",
  "execFileSync",
];

const FORBIDDEN_PATTERN = new RegExp(`\\b(${FORBIDDEN_SYNC_CALLS.join("|")})\\b`);

interface Violation {
  file: string;
  line: number;
  text: string;
  match: string;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Architecture Guards", () => {
  it("server code must not use synchronous file/process I/O (blocks event loop on NFS)", () => {
    const files = collectSourceFiles(SERVER_DIR);
    const violations: Violation[] = [];

    for (const filePath of files) {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip lines with the escape hatch comment
        if (line.includes("// sync-ok")) continue;

        // Skip comments
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

        // Skip import/require lines. Imports are multi-line so we track
        // whether we're inside an import block.
        if (trimmed.startsWith("import ") || trimmed.startsWith("import{")) {
          // Multi-line import — skip until closing "from" line
          if (!trimmed.includes(" from ") || !trimmed.endsWith(";")) {
            while (i < lines.length - 1 && !lines[i].includes(" from ")) i++;
          }
          continue;
        }
        // Catch continuation lines of multi-line imports (bare identifiers, "} from")
        if (trimmed.startsWith("} from ") || trimmed.startsWith("require(") || /^(const|let|var)\s+\{/.test(trimmed))
          continue;

        const match = FORBIDDEN_PATTERN.exec(line);
        if (match) {
          violations.push({
            file: relative(SERVER_DIR, filePath),
            line: i + 1,
            text: line.trim(),
            match: match[1],
          });
        }
      }
    }

    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line}: ${v.match}\n    ${v.text}`).join("\n");
      expect.fail(
        `\nSync file/process I/O detected in server code (blocks event loop on NFS):\n\n${report}\n\n` +
          `Add '// sync-ok' comment if this is a documented cold-path-only call.\n` +
          `See CLAUDE.md "Never use synchronous file I/O" section for async patterns.`,
      );
    }
  });
});
