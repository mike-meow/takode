#!/usr/bin/env bun

import { workstreamMemoryService } from "../server/workstream-memory-service.js";
import { getServerSlug, initWithPort } from "../server/settings-manager.js";
import {
  MEMORY_COMMIT_OPERATIONS,
  MEMORY_KINDS,
  type MemoryCommitOperation,
  type MemoryKind,
} from "../server/workstream-memory-types.js";

const VALUE_OPTIONS = new Set(["--root", "--server-id", "--server-slug", "--session-space"]);
const args = process.argv.slice(2);
const commandIndex = findCommandIndex(args);
const command = commandIndex === -1 ? undefined : args[commandIndex];
const jsonOutput = flag("json");

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

function findCommandIndex(tokens: string[]): number {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) return index;
    if (VALUE_OPTIONS.has(token) && tokens[index + 1] && !tokens[index + 1].startsWith("--")) index += 1;
  }
  return -1;
}

function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1];
  return undefined;
}

function options(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === `--${name}` && args[index + 1] && !args[index + 1].startsWith("--")) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function positional(index: number): string | undefined {
  let current = 0;
  const start = commandIndex === -1 ? 0 : commandIndex + 1;
  for (let i = start; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
      continue;
    }
    if (current === index) return args[i];
    current += 1;
  }
  return undefined;
}

function die(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function printUsage(): void {
  console.log(`Usage: memory [options] <command> [args]

Commands:
  repo path
      Print the resolved repo root. Use this to rediscover memory after compaction.
  catalog [show|diff]
      Show the repo root and list authored memory files from frontmatter.
      Default show output is compact; inspect the file or use --json for provenance/source refs.
      Use catalog diff as a freshness check for memory-focused work, not routine orientation.
  lint
      Canonical health check for memory files and frontmatter.
  lock status|acquire|release [--owner NAME] [--ttl-ms N]
      Coordinate direct file edits with the repo-level write lock.
  status
      Show git status for pending memory edits.
  diff
      Show the unstaged/staged memory diff before commit.
  commit --message TEXT [--quest q-N] [--session N] [--operation update] [--memory-id PATH] [--source REF]
      Commit memory edits with provenance trailers.

Options:
  --root PATH       Override the memory repo root for this command.
	  --server-slug SLUG
	                    Override the server slug used for default repo discovery.
	  --session-space SLUG
	                    Override the session-space slug used for default repo discovery.
	  --json            Emit exact machine-readable fields. Default output is concise for agents.

Default repo:
  ~/.companion/memory/<serverSlug>/<sessionSpace>
  Normal memory operations auto-create the Git repo and authored directories.
  Server slugs are short names such as prod, dev, or port-3455; the default session space is Takode.

Memory files are authored directly under:
  current/ knowledge/ procedures/ decisions/ references/ artifacts/

Frontmatter schema:
  description: one or two sentences for catalog orientation
  source: [q-1218, session:1476]
  id and kind are derived from the repo-relative file path.

Common examples:
	  memory repo path
	  memory --server-slug dev repo path
	  memory --server-slug dev --session-space Other repo path
	  memory catalog show
  memory catalog diff
  # If catalog/context makes a memory match plausible, search with concrete terms.
  rg "exact task terms" "$(memory repo path)"
  memory lint

Write flow:
  memory lock acquire --owner <session-or-role>
  edit Markdown files directly under the authored directories
  memory lint
  memory diff
  memory commit --message "Update memory" --source <source-ref> --memory-id <repo-relative-path>
  memory lock release`);
}

function repoOptions() {
  return {
    root: option("root"),
    serverId: option("server-id"),
    serverSlug: option("server-slug"),
    sessionSpaceSlug: option("session-space"),
  };
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseKinds(): MemoryKind[] | undefined {
  const raw = [...options("kind"), ...parseCsv(option("kinds"))].flatMap((item) => parseCsv(item));
  if (!raw.length) return undefined;
  const kinds: MemoryKind[] = [];
  for (const value of raw) {
    if (!MEMORY_KINDS.includes(value as MemoryKind)) {
      die(`--kind must be one of: ${MEMORY_KINDS.join(", ")}`);
    }
    kinds.push(value as MemoryKind);
  }
  return kinds;
}

function parseFacets(): Record<string, string[]> | undefined {
  const values = [...options("facet"), ...parseCsv(option("facets"))];
  if (!values.length) return undefined;
  const facets: Record<string, string[]> = {};
  for (const token of values) {
    const [key, value] = token.split(":", 2);
    if (!key?.trim() || !value?.trim()) die(`Invalid --facet token: ${token}`);
    facets[key.trim()] = [...(facets[key.trim()] ?? []), value.trim()];
  }
  return facets;
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) die(`${label} must be a positive integer`);
  return parsed;
}

function parseOperation(raw: string | undefined): MemoryCommitOperation | undefined {
  if (!raw) return undefined;
  if (MEMORY_COMMIT_OPERATIONS.includes(raw as MemoryCommitOperation)) return raw as MemoryCommitOperation;
  die(`--operation must be one of: ${MEMORY_COMMIT_OPERATIONS.join(", ")}`);
}

function requireOption(name: string): string {
  const value = option(name);
  if (!value?.trim()) die(`--${name} is required`);
  return value.trim();
}

function printCatalog(catalog: Awaited<ReturnType<typeof workstreamMemoryService.catalog>>): void {
  if (jsonOutput) {
    out(catalog);
    return;
  }
  console.log(`Memory repo: ${catalog.repo.root}`);
  if (!catalog.entries.length) {
    console.log("No memory files found.");
  }
  for (const entry of catalog.entries) {
    console.log(`${entry.id} ${entry.description}`);
  }
  printIssues(filterNormalReadIssues(catalog.issues));
}

function printCatalogDiff(diff: Awaited<ReturnType<typeof workstreamMemoryService.catalogDiff>>): void {
  if (jsonOutput) {
    out(diff);
    return;
  }
  console.log(`Memory repo: ${diff.repo.root}`);
  if (diff.previousSeenAt) {
    console.log(`Catalog changes since ${diff.previousSeenAt}:`);
  } else {
    console.log("No prior catalog snapshot for this session; current entries are shown as new:");
  }
  if (!diff.changes.length) {
    console.log("No catalog changes since last seen.");
  }
  for (const change of diff.changes) {
    const entry = change.after ?? change.before;
    const description = entry?.description ? ` ${entry.description}` : "";
    console.log(`${change.kind}: ${change.path}${description}`);
  }
  printIssues(filterNormalReadIssues(diff.issues));
}

function printIssues(issues: { severity: string; path?: string; message: string }[]): void {
  if (!issues.length) return;
  console.log("\nIssues:");
  for (const issue of issues) {
    const path = issue.path ? `${issue.path}: ` : "";
    console.log(`  ${issue.severity}: ${path}${issue.message}`);
  }
}

function filterNormalReadIssues(
  issues: { severity: string; path?: string; message: string }[],
): { severity: string; path?: string; message: string }[] {
  return issues.filter((issue) => !isSafelyIgnoredObsoleteFrontmatterWarning(issue));
}

function isSafelyIgnoredObsoleteFrontmatterWarning(issue: { severity: string; message: string }): boolean {
  return (
    issue.severity === "warning" &&
    issue.message.startsWith("Obsolete memory frontmatter field ") &&
    issue.message.includes(" is ignored; derive it from path or use description/source.")
  );
}

async function main(): Promise<void> {
  await scopeSettingsFromEnv();

  if (!command || flag("help") || command === "help") {
    printUsage();
    return;
  }

  if (command === "repo") {
    const subcommand = positional(0) ?? "path";
    if (subcommand === "path") {
      const repo = workstreamMemoryService.resolveRepo(repoOptions());
      if (jsonOutput) out(repo);
      else console.log(repo.root);
      return;
    }
    die("repo subcommand must be path");
  }

  if (command === "catalog") {
    const subcommand = positional(0);
    if (subcommand === "diff") {
      printCatalogDiff(await workstreamMemoryService.catalogDiff(repoOptions()));
      return;
    }
    if (subcommand && subcommand !== "show") die("catalog subcommand must be show or diff");
    const catalog = await workstreamMemoryService.catalog(repoOptions());
    printCatalog(catalog);
    await workstreamMemoryService.markCatalogSeen(catalog);
    return;
  }

  if (command === "recall") {
    const result = await workstreamMemoryService.recall(
      {
        query: positional(0),
        kinds: parseKinds(),
        facets: parseFacets(),
        includeContent: flag("content"),
        limit: parsePositiveInt(option("limit"), "--limit"),
      },
      repoOptions(),
    );
    if (jsonOutput) {
      out(result);
      return;
    }
    console.log(`Memory repo: ${result.repo.root}`);
    if (!result.matches.length) console.log("No matching memory files found.");
    for (const match of result.matches) {
      console.log(`${match.entry.id} [${match.entry.kind}] score=${match.score} ${match.entry.path}`);
      console.log(`  ${match.entry.description}`);
      if (match.entry.source.length) console.log(`  source: ${match.entry.source.join(", ")}`);
      if (match.content) console.log(`\n${match.content.trim()}\n`);
    }
    printIssues(filterNormalReadIssues(result.issues));
    return;
  }

  if (command === "lint" || command === "doctor") {
    const catalog = await workstreamMemoryService.lint(repoOptions());
    const errors = catalog.issues.filter((issue) => issue.severity === "error").length;
    if (jsonOutput) {
      out({ ok: !catalog.issues.some((issue) => issue.severity === "error"), ...catalog });
      if (errors) process.exit(1);
      return;
    }
    printIssues(catalog.issues);
    const warnings = catalog.issues.filter((issue) => issue.severity === "warning").length;
    console.log(
      errors || warnings ? `Memory lint found ${errors} errors and ${warnings} warnings.` : "Memory lint passed.",
    );
    if (errors) process.exit(1);
    return;
  }

  if (command === "lock") {
    const subcommand = positional(0) ?? "status";
    if (subcommand === "status") {
      const status = await workstreamMemoryService.lockStatus(repoOptions());
      if (jsonOutput) out(status);
      else console.log(status.locked ? `locked: ${status.owner ?? "unknown"} ${status.expiresAt ?? ""}` : "unlocked");
      return;
    }
    if (subcommand === "acquire") {
      const status = await workstreamMemoryService.acquireLock({
        ...repoOptions(),
        owner: option("owner"),
        ttlMs: parsePositiveInt(option("ttl-ms"), "--ttl-ms"),
        stealStale: !flag("no-steal-stale"),
      });
      if (jsonOutput) out(status);
      else console.log(`locked: ${status.lockPath}`);
      return;
    }
    if (subcommand === "release") {
      const status = await workstreamMemoryService.releaseLock(repoOptions());
      if (jsonOutput) out(status);
      else console.log("unlocked");
      return;
    }
    die("lock subcommand must be status, acquire, or release");
  }

  if (command === "status") {
    const status = await workstreamMemoryService.gitStatus(repoOptions());
    if (jsonOutput) out({ status });
    else console.log(status || "clean");
    return;
  }

  if (command === "diff") {
    console.log(await workstreamMemoryService.gitDiff(repoOptions()));
    return;
  }

  if (command === "commit") {
    const lock = await workstreamMemoryService.lockStatus(repoOptions());
    if (!lock.locked || lock.stale) die("Acquire the memory repo lock before committing memory changes.");
    const operation = parseOperation(option("operation"));
    const result = await workstreamMemoryService.commit({
      ...repoOptions(),
      message: requireOption("message"),
      quest: option("quest"),
      session: option("session"),
      operation,
      memoryIds: [...options("memory-id"), ...parseCsv(option("memory-ids"))],
      sources: [...options("source"), ...parseCsv(option("sources"))],
    });
    if (jsonOutput) out(result);
    else console.log(result.committed ? `committed ${result.sha}` : result.message);
    return;
  }

  console.error(`Error: Unknown memory command: ${command}`);
  printUsage();
  process.exit(1);
}

async function scopeSettingsFromEnv(): Promise<void> {
  const port = Number(process.env.COMPANION_PORT);
  if (!Number.isInteger(port) || port <= 0) return;
  await initWithPort(port);
  if (!option("server-slug")) {
    process.env.COMPANION_SERVER_SLUG = getServerSlug();
  }
}

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error));
});
