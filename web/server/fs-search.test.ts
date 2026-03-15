import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the /fs/search endpoint behavior.
 *
 * These test the search logic at a higher level: we create a real temporary
 * directory structure, use the actual ripgrep binary, and verify the search
 * results match expected patterns. This validates the end-to-end flow without
 * needing to mock internal details.
 */

// Use a temp directory with a unique name for each test run
const TEST_DIR = join(tmpdir(), `companion-fs-search-test-${Date.now()}`);

// We test the search logic directly rather than through HTTP to avoid
// needing the full Hono server setup. The core logic is simple: run rg --files,
// filter by substring, sort by relevance.
import { getRipgrepPath } from "./ripgrep.js";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(execCb);

/**
 * Minimal reproduction of the search endpoint logic, extracted for testability.
 * Matches the implementation in routes/filesystem.ts.
 */
async function searchFiles(root: string, query: string): Promise<Array<{ relativePath: string; fileName: string }>> {
  if (!query || query.length < 1) return [];
  const rgPath = await getRipgrepPath();
  const { stdout } = await execPromise(
    `"${rgPath}" --files --no-messages --hidden --glob '!.git' 2>/dev/null | head -5000`,
    { cwd: root, timeout: 5000 },
  );

  const queryLower = query.toLowerCase();
  const files = stdout.split("\n").filter(Boolean);
  const matches: Array<{ relativePath: string; fileName: string; score: number }> = [];

  for (const relPath of files) {
    const lower = relPath.toLowerCase();
    if (!lower.includes(queryLower)) continue;
    const name = relPath.split("/").pop() || relPath;
    const nameMatch = name.toLowerCase().includes(queryLower);
    const score = (nameMatch ? 0 : 1000) + relPath.length;
    matches.push({ relativePath: relPath, fileName: name, score });
  }

  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, 15).map((m) => ({
    relativePath: m.relativePath,
    fileName: m.fileName,
  }));
}

describe("file search (fs/search logic)", () => {
  beforeEach(async () => {
    // Create a fresh test directory with known files
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, "src/components"), { recursive: true });
    await mkdir(join(TEST_DIR, "src/utils"), { recursive: true });
    await mkdir(join(TEST_DIR, "node_modules/pkg"), { recursive: true });
    await mkdir(join(TEST_DIR, ".git"), { recursive: true });

    // Create test files
    await Promise.all([
      writeFile(join(TEST_DIR, "src/components/App.tsx"), "export default App"),
      writeFile(join(TEST_DIR, "src/components/Composer.tsx"), "export function Composer() {}"),
      writeFile(join(TEST_DIR, "src/components/Sidebar.tsx"), "export function Sidebar() {}"),
      writeFile(join(TEST_DIR, "src/utils/helpers.ts"), "export function help() {}"),
      writeFile(join(TEST_DIR, "src/utils/api.ts"), "export const api = {}"),
      writeFile(join(TEST_DIR, "package.json"), "{}"),
      writeFile(join(TEST_DIR, "README.md"), "# test"),
      // Files that should be excluded by .gitignore behavior
      writeFile(join(TEST_DIR, "node_modules/pkg/index.js"), "module.exports = {}"),
      writeFile(join(TEST_DIR, ".git/config"), ""),
    ]);

    // Create a .gitignore so rg respects it
    await writeFile(join(TEST_DIR, ".gitignore"), "node_modules/\n");
  });

  it("finds files matching a substring query", async () => {
    const results = await searchFiles(TEST_DIR, "App");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].fileName).toBe("App.tsx");
    expect(results[0].relativePath).toBe("src/components/App.tsx");
  });

  it("is case-insensitive", async () => {
    const results = await searchFiles(TEST_DIR, "app");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].fileName).toBe("App.tsx");
  });

  it("matches directory segments too", async () => {
    const results = await searchFiles(TEST_DIR, "components");
    expect(results.length).toBe(3); // App.tsx, Composer.tsx, Sidebar.tsx
    // All results should be in the components directory
    for (const r of results) {
      expect(r.relativePath).toContain("components/");
    }
  });

  it("prioritizes filename matches over directory-only matches", async () => {
    // Create a file whose name matches the query
    await writeFile(join(TEST_DIR, "src/utils/search.ts"), "");
    // "search" matches the filename "search.ts" directly,
    // not just a directory path
    const results = await searchFiles(TEST_DIR, "search");
    expect(results[0].fileName).toBe("search.ts");
  });

  it("respects .gitignore — excludes node_modules", async () => {
    const results = await searchFiles(TEST_DIR, "index");
    // node_modules/pkg/index.js should not appear
    const nodeModuleResult = results.find((r) => r.relativePath.includes("node_modules"));
    expect(nodeModuleResult).toBeUndefined();
  });

  it("excludes .git directory", async () => {
    const results = await searchFiles(TEST_DIR, "config");
    const gitResult = results.find((r) => r.relativePath.includes(".git"));
    expect(gitResult).toBeUndefined();
  });

  it("returns empty results for non-matching query", async () => {
    const results = await searchFiles(TEST_DIR, "zzzznonexistent");
    expect(results).toEqual([]);
  });

  it("returns empty results for empty query", async () => {
    const results = await searchFiles(TEST_DIR, "");
    expect(results).toEqual([]);
  });

  it("limits results to 15 entries", async () => {
    // Create many matching files
    await mkdir(join(TEST_DIR, "many"), { recursive: true });
    for (let i = 0; i < 20; i++) {
      await writeFile(join(TEST_DIR, `many/test${i}.ts`), "");
    }
    const results = await searchFiles(TEST_DIR, "test");
    expect(results.length).toBeLessThanOrEqual(15);
  });
});
