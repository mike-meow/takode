import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { countLines, MAX_FILE_LINES } from "./check-staged-file-line-limit";

const SCRIPT_PATH = path.resolve(import.meta.dirname, "check-staged-file-line-limit.ts");

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();
}

function writeLines(filePath: string, lineCount: number): void {
  const contents = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join("\n");
  writeFileSync(filePath, `${contents}\n`);
}

function runScript(repoDir: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: repoDir,
    encoding: "utf8",
  });
}

describe("countLines", () => {
  it("counts newline-terminated files correctly", () => {
    expect(countLines(Buffer.from("a\nb\nc\n"))).toBe(3);
  });

  it("counts a final line without a trailing newline", () => {
    expect(countLines(Buffer.from("a\nb\nc"))).toBe(3);
  });

  it("treats an empty file as zero lines", () => {
    expect(countLines(Buffer.alloc(0))).toBe(0);
  });
});

describe("check-staged-file-line-limit", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        rmSync(tempDir, { force: true, recursive: true });
      }
    }
  });

  function createRepo(): string {
    const repoDir = mkdtempSync(path.join(tmpdir(), "staged-file-line-limit-"));
    tempDirs.push(repoDir);

    git(repoDir, ["init"]);
    git(repoDir, ["config", "user.name", "Takode Test"]);
    git(repoDir, ["config", "user.email", "takode@example.com"]);

    writeFileSync(path.join(repoDir, "README.md"), "seed\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "seed"]);

    return repoDir;
  }

  it("allows a staged file at exactly 2000 lines", () => {
    const repoDir = createRepo();
    writeLines(path.join(repoDir, "exact.txt"), MAX_FILE_LINES);
    git(repoDir, ["add", "exact.txt"]);

    const result = runScript(repoDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails when a staged file exceeds 2000 lines", () => {
    const repoDir = createRepo();
    writeLines(path.join(repoDir, "too-long.txt"), MAX_FILE_LINES + 1);
    git(repoDir, ["add", "too-long.txt"]);

    const result = runScript(repoDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Staged file line limit exceeded");
    expect(result.stderr).toContain("too-long.txt");
    expect(result.stderr).toContain(`${MAX_FILE_LINES + 1} lines`);
  });

  it("checks the staged snapshot instead of unstaged working tree edits", () => {
    const repoDir = createRepo();
    const filePath = path.join(repoDir, "staged-only.txt");

    // Stage the allowed snapshot first, then make the working tree too long without restaging it.
    writeLines(filePath, MAX_FILE_LINES);
    git(repoDir, ["add", "staged-only.txt"]);
    writeLines(filePath, MAX_FILE_LINES + 1);

    const result = runScript(repoDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("ignores deleted staged files", () => {
    const repoDir = createRepo();
    const filePath = path.join(repoDir, "delete-me.txt");

    // Deletions should not block the commit, even if the removed file was oversized.
    writeLines(filePath, MAX_FILE_LINES + 5);
    git(repoDir, ["add", "delete-me.txt"]);
    git(repoDir, ["commit", "-m", "add oversized file"]);
    git(repoDir, ["rm", "delete-me.txt"]);

    const result = runScript(repoDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
