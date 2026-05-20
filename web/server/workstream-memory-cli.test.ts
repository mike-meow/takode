import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function runMemory(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const memoryPath = fileURLToPath(new URL("../bin/memory.ts", import.meta.url));
  const child = spawn(process.execPath, [memoryPath, ...args], {
    env: {
      ...process.env,
      ...env,
      BUN_INSTALL_CACHE_DIR:
        process.env.BUN_INSTALL_CACHE_DIR || join(process.env.HOME || "", ".bun", "install", "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

describe("memory CLI", () => {
  let tempDir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-cli-test-"));
    env = {
      COMPANION_MEMORY_DIR: join(tempDir, "memory"),
      COMPANION_SERVER_ID: "test-server",
      COMPANION_SERVER_SLUG: "test",
      COMPANION_PORT: "",
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeMemoryFile(path: string, frontmatter: string, body = "Body text."): Promise<void> {
    const absolutePath = join(tempDir, "memory", path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, `---\n${frontmatter.trim()}\n---\n\n${body}\n`, "utf-8");
  }

  it("auto-initializes, catalogs, and recalls authored memory files", async () => {
    await writeMemoryFile(
      "procedures/run-service-x.md",
      `
description: Starts Service X.
source:
  - q-1218
facets:
  project: takode
`,
      "Run bun run dev from the web directory.",
    );

    const catalog = await runMemory(["catalog", "--json"], env);
    expect(catalog.status).toBe(0);
    const catalogJson = JSON.parse(catalog.stdout);
    expect(catalogJson.repo).toEqual(
      expect.objectContaining({
        root: join(tempDir, "memory"),
        serverId: "test-server",
        serverSlug: "test",
        sessionSpaceSlug: "Takode",
        initialized: true,
        authoredDirs: ["current", "knowledge", "procedures", "decisions", "references", "artifacts"],
      }),
    );
    await expect(readFile(join(tempDir, "memory", ".git", "HEAD"), "utf-8")).resolves.toContain("ref:");
    expect(catalogJson.entries[0]).toEqual(
      expect.objectContaining({
        id: "procedures/run-service-x.md",
        kind: "procedures",
        description: "Starts Service X.",
        source: ["q-1218"],
      }),
    );

    const recall = await runMemory(
      ["recall", "bun service", "--kind", "procedures", "--facet", "project:takode", "--content", "--json"],
      env,
    );
    expect(recall.status).toBe(0);
    expect(JSON.parse(recall.stdout).matches[0].content).toContain("bun run dev");
  });

  it("shows catalog entries relative to the printed memory repo root", async () => {
    await writeMemoryFile(
      "decisions/memory-schema.md",
      `
description: Memory frontmatter is intentionally small and path-derived.
source: [q-1220, session:1559]
`,
      "Use the catalog for orientation and direct file tools for details.",
    );

    const catalog = await runMemory(["catalog", "show"], env);

    expect(catalog.status).toBe(0);
    expect(catalog.stdout).toContain(`Memory repo: ${join(tempDir, "memory")}`);
    expect(catalog.stdout).toContain(
      "decisions/memory-schema.md Memory frontmatter is intentionally small and path-derived.",
    );
    expect(catalog.stdout).not.toContain("[decisions]");
    expect(catalog.stdout).not.toContain("source: q-1220, session:1559");
    expect(catalog.stdout).not.toContain(join(tempDir, "memory", "decisions", "memory-schema.md"));

    const catalogJson = await runMemory(["catalog", "show", "--json"], env);
    expect(catalogJson.status).toBe(0);
    expect(JSON.parse(catalogJson.stdout).entries[0]).toEqual(
      expect.objectContaining({
        id: "decisions/memory-schema.md",
        kind: "decisions",
        source: ["q-1220", "session:1559"],
      }),
    );
  });

  it("reports catalog changes since this session last saw the catalog", async () => {
    const scopedEnv = { ...env, COMPANION_SESSION_ID: "session-a" };
    await writeMemoryFile(
      "decisions/first.md",
      `
description: First catalog entry.
source:
  - q-1237
`,
    );

    const firstDiff = await runMemory(["catalog", "diff"], scopedEnv);
    expect(firstDiff.status).toBe(0);
    expect(firstDiff.stdout).toContain("No prior catalog snapshot for this session");
    expect(firstDiff.stdout).toContain("added: decisions/first.md First catalog entry.");

    const show = await runMemory(["catalog", "show"], scopedEnv);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("decisions/first.md First catalog entry.");

    await writeMemoryFile(
      "decisions/first.md",
      `
description: Updated catalog entry.
source:
  - q-1237
`,
    );
    await writeMemoryFile(
      "procedures/second.md",
      `
description: Second catalog entry.
source:
  - q-1237
`,
    );

    const secondDiff = await runMemory(["catalog", "diff"], scopedEnv);
    expect(secondDiff.status).toBe(0);
    expect(secondDiff.stdout).toContain("Catalog changes since");
    expect(secondDiff.stdout).toContain("changed: decisions/first.md Updated catalog entry.");
    expect(secondDiff.stdout).toContain("added: procedures/second.md Second catalog entry.");

    const cleanDiff = await runMemory(["catalog", "diff"], scopedEnv);
    expect(cleanDiff.status).toBe(0);
    expect(cleanDiff.stdout).toContain("No catalog changes since last seen.");
  });

  it("defaults to one auto-created repo per server/session space when no root override is set", async () => {
    const scopedEnv = {
      HOME: tempDir,
      COMPANION_SERVER_ID: "server-id",
      COMPANION_SERVER_SLUG: "server-slug",
      COMPANION_PORT: "",
    };

    const path = await runMemory(["repo", "path"], scopedEnv);
    expect(path.status).toBe(0);
    const expectedRoot = join(tempDir, ".companion", "memory", "server-slug", "Takode");
    expect(path.stdout.trim()).toBe(expectedRoot);

    const catalog = await runMemory(["catalog", "--json"], scopedEnv);
    expect(catalog.status).toBe(0);
    expect(JSON.parse(catalog.stdout).repo).toEqual(
      expect.objectContaining({
        root: expectedRoot,
        serverId: "server-id",
        serverSlug: "server-slug",
        sessionSpaceSlug: "Takode",
        initialized: true,
      }),
    );
    await expect(readFile(join(expectedRoot, ".git", "HEAD"), "utf-8")).resolves.toContain("ref:");
  });

  it("accepts global repo options before or after the command", async () => {
    const scopedEnv = {
      HOME: tempDir,
      COMPANION_SERVER_ID: "server-id",
      COMPANION_SERVER_SLUG: "default",
      COMPANION_PORT: "",
    };

    // This locks down the compaction-recovery-friendly form shown in help.
    const preCommand = await runMemory(["--server-slug", "dev", "--session-space", "Other", "repo", "path"], scopedEnv);
    expect(preCommand.status).toBe(0);

    // This preserves the original post-command placement that already worked.
    const postCommand = await runMemory(
      ["repo", "path", "--server-slug", "dev", "--session-space", "Other"],
      scopedEnv,
    );
    expect(postCommand.status).toBe(0);

    const expectedRoot = join(tempDir, ".companion", "memory", "dev", "Other");
    expect(preCommand.stdout.trim()).toBe(expectedRoot);
    expect(postCommand.stdout.trim()).toBe(expectedRoot);
  });

  it("does not move or catalog another session space when the default space changes", async () => {
    const scopedEnv = {
      HOME: tempDir,
      COMPANION_SERVER_ID: "same-server",
      COMPANION_SERVER_SLUG: "prod",
      COMPANION_PORT: "",
      COMPANION_MEMORY_DIR: "",
    };
    const takodeRoot = join(tempDir, ".companion", "memory", "prod", "Takode");
    const otherRoot = join(tempDir, ".companion", "memory", "prod", "Other");

    const first = await runMemory(["catalog", "--json"], { ...scopedEnv, COMPANION_MEMORY_SPACE_SLUG: "Takode" });
    expect(first.status).toBe(0);
    await mkdir(join(takodeRoot, "current"), { recursive: true });
    await writeFile(
      join(takodeRoot, "current", "takode.md"),
      `---
description: Belongs to the Takode session space.
source:
  - q-1331
---

Takode-owned memory.
`,
      "utf-8",
    );

    const other = await runMemory(["catalog", "--json"], { ...scopedEnv, COMPANION_MEMORY_SPACE_SLUG: "Other" });

    expect(other.status).toBe(0);
    const otherJson = JSON.parse(other.stdout);
    expect(otherJson.repo).toEqual(
      expect.objectContaining({ root: otherRoot, sessionSpaceSlug: "Other", serverId: "same-server" }),
    );
    expect(otherJson.entries).toEqual([]);
    await expect(readFile(join(takodeRoot, "current", "takode.md"), "utf-8")).resolves.toContain("Takode-owned memory");
    await expect(readFile(join(otherRoot, "current", "takode.md"), "utf-8")).rejects.toThrow();
  });

  it("lints authored files and exits non-zero for schema errors", async () => {
    await mkdir(join(tempDir, "memory", "knowledge"), { recursive: true });
    await writeFile(join(tempDir, "memory", "knowledge", "broken.md"), "# no frontmatter\n", "utf-8");

    const result = await runMemory(["lint", "--json"], env);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("must start with YAML frontmatter") }),
    );
  });

  it("reports obsolete frontmatter fields from the old schema", async () => {
    await writeMemoryFile(
      "knowledge/old-schema.md",
      `
id: old-schema
kind: knowledge
title: Old Schema
summary: Old summary.
lifecycle: active
canonicalFor:
  - old-memory-schema
source: [q-1220]
`,
    );

    const result = await runMemory(["lint", "--json"], env);

    expect(result.status).toBe(1);
    const issues = JSON.parse(result.stdout).issues as Array<{ severity: string; message: string }>;
    const messages = issues.map((issue) => issue.message);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        message: 'Obsolete memory frontmatter field "id" is ignored; derive it from path or use description/source.',
      }),
    );
    expect(messages).toContain(
      'Obsolete memory frontmatter field "kind" is ignored; derive it from path or use description/source.',
    );
    expect(messages).toContain(
      'Obsolete memory frontmatter field "title" is ignored; derive it from path or use description/source.',
    );
    expect(messages).toContain(
      'Obsolete memory frontmatter field "summary" is ignored; derive it from path or use description/source.',
    );
    expect(messages).toContain(
      'Obsolete memory frontmatter field "lifecycle" is ignored; derive it from path or use description/source.',
    );
    expect(messages).toContain(
      'Obsolete memory frontmatter field "canonicalFor" is ignored; derive it from path or use description/source.',
    );
    expect(messages).toContain("Memory description is required");
  });

  it("catalogs dual-schema files from path-derived and simplified fields", async () => {
    await writeMemoryFile(
      "knowledge/dual-schema.md",
      `
id: old-id
kind: current
title: Old Title
summary: Old summary.
lifecycle: active
description: New description wins.
source:
  - q-1220
`,
    );

    const catalog = await runMemory(["catalog", "--json"], env);

    expect(catalog.status).toBe(0);
    const parsed = JSON.parse(catalog.stdout);
    expect(parsed.entries[0]).toEqual(
      expect.objectContaining({
        id: "knowledge/dual-schema.md",
        kind: "knowledge",
        description: "New description wins.",
        source: ["q-1220"],
      }),
    );
    expect(parsed.entries[0]).not.toHaveProperty("title");
    expect(parsed.entries[0]).not.toHaveProperty("lifecycle");
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        message: 'Obsolete memory frontmatter field "kind" is ignored; derive it from path or use description/source.',
      }),
    );
  });

  it("keeps obsolete-field compatibility warnings out of normal catalog and recall output", async () => {
    await writeMemoryFile(
      "knowledge/dual-schema.md",
      `
id: old-id
kind: current
title: Old Title
summary: Old summary.
lifecycle: active
canonicalFor:
  - old-memory-schema
description: New schema description stays visible.
source:
  - q-1220
`,
    );

    const catalog = await runMemory(["catalog"], env);
    expect(catalog.status).toBe(0);
    expect(catalog.stdout).toContain("knowledge/dual-schema.md New schema description stays visible.");
    expect(catalog.stdout).not.toContain("[knowledge]");
    expect(catalog.stdout).not.toContain("source: q-1220");
    expect(catalog.stdout).not.toContain("Obsolete memory frontmatter field");
    expect(catalog.stdout).not.toContain("Issues:");

    const recall = await runMemory(["recall", "schema"], env);
    expect(recall.status).toBe(0);
    expect(recall.stdout).toContain("knowledge/dual-schema.md");
    expect(recall.stdout).not.toContain("Obsolete memory frontmatter field");
    expect(recall.stdout).not.toContain("Issues:");

    const lint = await runMemory(["lint"], env);
    expect(lint.status).toBe(0);
    expect(lint.stdout).toContain("Obsolete memory frontmatter field");
    expect(lint.stdout).toContain("Memory lint found 0 errors and 6 warnings.");
  });

  it("requires source refs as a YAML list in simplified frontmatter", async () => {
    await writeMemoryFile(
      "references/missing-source.md",
      `
description: Tracks an external source without provenance.
`,
    );
    await writeMemoryFile(
      "references/scalar-source.md",
      `
description: Tracks an external source with scalar provenance.
source: q-1220
`,
    );

    const result = await runMemory(["lint", "--json"], env);

    expect(result.status).toBe(1);
    const issues = JSON.parse(result.stdout).issues;
    expect(issues).toContainEqual(
      expect.objectContaining({ message: "Memory source must list at least one contributing quest or session ref" }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ message: "Memory source must be a YAML list of contributing quest or session refs" }),
    );
  });

  it("supports repo-level lock and commit helpers for direct edits", async () => {
    await writeMemoryFile(
      "current/memory-foundation.md",
      `
description: Tracks the active memory implementation state.
source:
  - q-1205
`,
    );

    const lock = await runMemory(["lock", "acquire", "--owner", "worker", "--json"], env);
    expect(lock.status).toBe(0);
    expect(JSON.parse(lock.stdout).locked).toBe(true);

    const commit = await runMemory(
      [
        "commit",
        "--message",
        "Record memory foundation",
        "--quest",
        "q-1205",
        "--session",
        "1537",
        "--operation",
        "add",
        "--memory-id",
        "current/memory-foundation.md",
        "--source",
        "quest:q-1205",
        "--json",
      ],
      env,
    );
    expect(commit.status).toBe(0);
    expect(JSON.parse(commit.stdout)).toEqual(expect.objectContaining({ committed: true }));

    const status = await runMemory(["status"], env);
    expect(status.stdout.trim()).toBe("clean");

    const release = await runMemory(["lock", "release", "--json"], env);
    expect(JSON.parse(release.stdout).locked).toBe(false);
  });

  it("rejects commit helper calls without lock or required provenance", async () => {
    await writeMemoryFile(
      "current/provenance.md",
      `
description: Tracks memory commit provenance validation.
source:
  - q-1205
`,
    );

    const noLock = await runMemory(
      ["commit", "--message", "Missing lock", "--memory-id", "current/provenance.md", "--source", "quest:q-1205"],
      env,
    );
    expect(noLock.status).toBe(1);
    expect(noLock.stderr).toContain("Acquire the memory repo lock");

    await runMemory(["lock", "acquire", "--owner", "worker"], env);

    const missingSource = await runMemory(["commit", "--message", "Missing source", "--memory-id", "provenance"], env);
    expect(missingSource.status).toBe(1);
    expect(missingSource.stderr).toContain("at least one source trailer");

    const missingTraceability = await runMemory(
      ["commit", "--message", "Missing traceability", "--source", "quest:q-1205"],
      env,
    );
    expect(missingTraceability.status).toBe(1);
    expect(missingTraceability.stderr).toContain("include quest, session, or at least one memory id");
  });

  it("treats old workstream/upsert/check commands as unknown and omits migration guidance", async () => {
    const result = await runMemory(["upsert", "current", "takode/key"], env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown memory command: upsert");
    expect(result.stderr).not.toContain("workstream-memory");
    expect(result.stdout).not.toContain("migrate");
    expect(result.stdout).not.toContain("workstream");
    expect(result.stdout).not.toContain("upsert");
    expect(result.stdout).not.toMatch(/^  check\b/m);
  });

  it("prints self-contained help without re-advertising legacy commands", async () => {
    const help = await runMemory(["help"], env);

    expect(help.status).toBe(0);
    // The help text should be enough for an agent to recover the memory workflow after compaction.
    expect(help.stdout).toContain("Normal memory operations auto-create");
    expect(help.stdout).toContain("~/.companion/memory/<serverSlug>/<sessionSpace>");
    expect(help.stdout).toContain("default session space is Takode");
    expect(help.stdout).toContain("repo path");
    expect(help.stdout).toContain("Print the resolved repo root");
    expect(help.stdout).toContain("catalog [show|diff]");
    expect(help.stdout).toContain("Show the repo root and list authored memory files");
    expect(help.stdout).toContain("Default show output is compact");
    expect(help.stdout).toContain("inspect the file or use --json for provenance/source refs");
    expect(help.stdout).toContain("Use catalog diff as a freshness check for memory-focused work");
    expect(help.stdout).not.toContain("Prefer catalog/direct file inspection for normal orientation.");
    expect(help.stdout).toContain("description: one or two sentences for catalog orientation");
    expect(help.stdout).toContain("source: [q-1218, session:1476]");
    expect(help.stdout).toContain("id and kind are derived from the repo-relative file path.");
    expect(help.stdout).toContain("Canonical health check");
    expect(help.stdout).toContain("memory catalog show");
    expect(help.stdout).toContain("memory catalog diff");
    expect(help.stdout).toContain("If catalog/context makes a memory match plausible");
    expect(help.stdout).toContain('rg "exact task terms" "$(memory repo path)"');
    expect(help.stdout).not.toContain('memory recall "current task terms"');
    expect(help.stdout).not.toContain("recall [query]");
    expect(help.stdout).toContain("memory lock acquire --owner <session-or-role>");
    expect(help.stdout).toContain("edit Markdown files directly under the authored directories");
    expect(help.stdout).toContain("memory commit --message");
    expect(help.stdout).toContain(
      "--json            Emit exact machine-readable fields. Default output is concise for agents.",
    );
    expect(help.stdout).not.toContain("repo path [--json]");
    expect(help.stdout).not.toContain("doctor");
    expect(help.stdout).not.toContain("repo path|init");
    expect(help.stdout).not.toContain("repo init");
    expect(help.stdout).not.toContain("migrate");
    expect(help.stdout).not.toContain("workstream");
    expect(help.stdout).not.toContain("upsert");
    expect(help.stdout).not.toMatch(/^  check\b/m);
  });
});
