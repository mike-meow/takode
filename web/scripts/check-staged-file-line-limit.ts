import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAX_FILE_LINES = 2000;

type OversizedFile = {
  lineCount: number;
  path: string;
};

export function countLines(contents: Buffer): number {
  if (contents.length === 0) {
    return 0;
  }

  let lineCount = 0;

  for (const byte of contents) {
    if (byte === 0x0a) {
      lineCount += 1;
    }
  }

  if (contents[contents.length - 1] !== 0x0a) {
    lineCount += 1;
  }

  return lineCount;
}

export function isProbablyBinary(contents: Buffer): boolean {
  return contents.includes(0);
}

async function runGit(args: string[], cwd: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export async function getRepoRoot(cwd = process.cwd()): Promise<string> {
  const stdout = await runGit(["rev-parse", "--show-toplevel"], cwd);
  return stdout.toString("utf8").trim();
}

export function parseNullDelimitedPaths(stdout: Buffer): string[] {
  return stdout.toString("utf8").split("\0").filter(Boolean);
}

export async function getStagedFiles(repoRoot: string): Promise<string[]> {
  const stdout = await runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], repoRoot);
  return parseNullDelimitedPaths(stdout);
}

export async function readStagedFile(repoRoot: string, filePath: string): Promise<Buffer> {
  return runGit(["show", `:${filePath}`], repoRoot);
}

export async function findOversizedStagedFiles(repoRoot: string): Promise<OversizedFile[]> {
  const stagedFiles = await getStagedFiles(repoRoot);
  const oversizedFiles: OversizedFile[] = [];

  for (const filePath of stagedFiles) {
    const contents = await readStagedFile(repoRoot, filePath);
    if (isProbablyBinary(contents)) {
      continue;
    }

    const lineCount = countLines(contents);
    if (lineCount > MAX_FILE_LINES) {
      oversizedFiles.push({ path: filePath, lineCount });
    }
  }

  return oversizedFiles;
}

function formatFailureMessage(oversizedFiles: OversizedFile[]): string {
  const lines = oversizedFiles
    .sort((left, right) => right.lineCount - left.lineCount || left.path.localeCompare(right.path))
    .map(({ path, lineCount }) => `- ${path} (${lineCount} lines)`);

  return [
    `Staged file line limit exceeded: files must stay at or under ${MAX_FILE_LINES} lines.`,
    `Split files before committing if a change would leave them above ${MAX_FILE_LINES} lines.`,
    `Exactly ${MAX_FILE_LINES} lines is allowed.`,
    ...lines,
  ].join("\n");
}

export async function main(): Promise<number> {
  const repoRoot = await getRepoRoot();
  const oversizedFiles = await findOversizedStagedFiles(repoRoot);

  if (oversizedFiles.length === 0) {
    return 0;
  }

  console.error(formatFailureMessage(oversizedFiles));
  return 1;
}

if (import.meta.main) {
  const exitCode = await main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to check staged file line limits: ${message}`);
    return 1;
  });

  process.exit(exitCode);
}
