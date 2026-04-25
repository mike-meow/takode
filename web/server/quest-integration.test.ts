import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
}));

const execMock = vi.hoisted(() =>
  vi.fn((command: string, options: { cwd?: string }, callback: (error: Error | null, stdout: string) => void) => {
    if (command.includes("rev-parse --git-common-dir")) {
      if (options.cwd?.startsWith("/repo")) {
        callback(null, "/repo/.git\n");
        return;
      }
      callback(null, "/main-checkout/.git\n");
      return;
    }
    callback(new Error(`Unexpected command: ${command}`), "");
  }),
);

vi.mock("node:os", () => ({
  homedir: () => "/home/tester",
}));

vi.mock("node:fs", () => fsMocks);
vi.mock("node:child_process", () => ({
  exec: execMock,
}));

import { ensureQuestmasterIntegration } from "./quest-integration.js";

describe("ensureQuestmasterIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
  });

  it("writes quest skill to both Claude and Codex skill homes", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith("/home/tester/.claude/skills/quest", { recursive: true });
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith("/home/tester/.codex/skills/quest", { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.claude/skills/quest/SKILL.md",
      expect.stringContaining("name: quest"),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.codex/skills/quest/SKILL.md",
      expect.stringContaining("name: quest"),
      "utf-8",
    );
  });

  it("includes explicit feedback-addressing workflow in generated skill", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    const codexSkillWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.codex/skills/quest/SKILL.md",
    );
    expect(codexSkillWrite).toBeDefined();

    const skill = String(codexSkillWrite?.[1] ?? "");
    expect(skill).toContain("quest address <id> <index> [--json]");
    // Validates the pre-submission checklist includes feedback-addressing, summary, and consolidation requirements.
    expect(skill).toContain("Address all human feedback");
    expect(skill).toContain("Both steps are required");
    expect(skill).toContain("Add or refresh a user-oriented summary comment");
    expect(skill).toContain("what changed, why it matters, and what verification passed");
    expect(skill).toContain("Write the summary as an outcome note, not a review or rework timeline");
    expect(skill).toContain("Prefer one consolidated feedback entry");
    expect(skill).toContain("This summary may also be the explanation for addressed human feedback");
    expect(skill).toContain("Avoid review-process timelines, duplicate near-identical comments");
    expect(skill).toContain("required worker deliverable");
    expect(skill).toContain("first commit the current worktree state");
    expect(skill).toContain("separate commit so the reviewer can inspect only the new diff");
  });

  it("requires quest-design before quest creation or refinement only", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    const codexSkillWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.codex/skills/quest/SKILL.md",
    );
    expect(codexSkillWrite).toBeDefined();

    const skill = String(codexSkillWrite?.[1] ?? "");
    expect(skill).toContain("Required `/quest-design` before quest creation or refinement");
    expect(skill).toContain("invoke `/quest-design` and complete its confirmation round");
    expect(skill).toContain("Before any agent creates a new quest or refines an `idea` quest");
    expect(skill).toContain("Use `/quest-design` before:");
    expect(skill).toContain("`quest create`");
    expect(skill).toContain("`quest edit` or `quest transition --status refined` when refining an `idea` quest");
    expect(skill).toContain("Intended goal/scope");
    expect(skill).toContain("Major assumptions");
    expect(skill).toContain("Non-goals");
    expect(skill).toContain("Highest-leverage clarification questions");
    expect(skill).toContain("Operations that do not require `/quest-design`");
    expect(skill).toContain("Adding human or agent feedback to an existing quest");
    expect(skill).toContain("Routine progress bookkeeping after approved work");
    expect(skill).toContain("invoke `/quest-design` before applying them");
    expect(skill).toContain("Ask clarifying questions until the goal, scope, and non-goals are clear enough");
    expect(skill).toContain("Draft the refined title, description, and tags, then invoke `/quest-design`");
    expect(skill).toContain("Wait for user confirmation or correction");
    expect(skill).not.toContain("Before any agent creates a quest or materially updates/refines an existing quest");
    expect(skill).not.toContain("When in doubt, treat the change as material and confirm first");
  });

  it("requires titles under 10 words for refined and later stages", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    const codexSkillWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.codex/skills/quest/SKILL.md",
    );
    expect(codexSkillWrite).toBeDefined();

    const skill = String(codexSkillWrite?.[1] ?? "");
    expect(skill).toContain("Title rule for refined and later");
    expect(skill).toContain("less than 10 words");
    expect(skill).toContain("refined`, `in_progress`, `needs_verification`, or `done");
  });

  it("tells worktree workers to sync to main before needs_verification", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    const codexSkillWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.codex/skills/quest/SKILL.md",
    );
    expect(codexSkillWrite).toBeDefined();

    const skill = String(codexSkillWrite?.[1] ?? "");
    expect(skill).toContain("Worktree sessions:");
    expect(skill).toContain("do **not** run `quest complete`");
    expect(skill).toContain("synced to the main repo checkout and pushed");
    expect(skill).toContain('quest complete q-N --items "..." --commits "sha1,sha2"');
    expect(skill).toContain("Synced SHAs: sha1,sha2");
    expect(skill).toContain("Do not rely on log parsing or memory");
    expect(skill).toContain("Do not leave commit info only in comments");
    expect(skill).toContain("one substantive quest-level prose summary");
    expect(skill).toContain("what changed, why it matters to the user or project, and what verification passed");
    expect(skill).toContain("Re-running the same summary-style feedback (`Summary:` or `Refreshed summary:`)");
    expect(skill).toContain("Only add a second port-specific comment");
    expect(skill).toContain("pass `quest complete ... --no-code`");
    expect(skill).toContain("only a local reminder switch");
    expect(skill).toContain("no placeholder port notes or synced SHA lines");
    expect(skill).toContain("zero git-tracked changes");
    expect(skill).toContain(
      "Docs, skills, prompts, templates, and other text-only tracked-file edits are commit-producing work",
    );
    expect(skill).toContain("Do not use `--no-code` for these quests");
  });

  it("instructs agents to use quest directly before PATH fallbacks", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    const codexSkillWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.codex/skills/quest/SKILL.md",
    );
    expect(codexSkillWrite).toBeDefined();

    const skill = String(codexSkillWrite?.[1] ?? "");
    expect(skill).toContain("Prefer `quest ...` directly when `quest` is already on PATH");
    expect(skill).toContain("Do not prepend to `PATH` proactively");
  });

  it("writes a copied global quest wrapper targeting the stable main checkout", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/worktrees/wt-1/web");

    const sharedWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.companion/bin/quest",
    );
    expect(sharedWrite).toBeDefined();

    const sharedWrapper = String(sharedWrite?.[1] ?? "");
    expect(sharedWrapper).toContain('exec bun "/repo/web/bin/quest.ts" "$@"');
    expect(sharedWrapper).toContain('exec "$HOME/.bun/bin/bun" "/repo/web/bin/quest.ts" "$@"');
    expect(sharedWrapper).not.toContain("/repo/worktrees/wt-1/web/bin/quest.ts");
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      "/home/tester/.companion/bin/servers/server-a/quest",
      expect.anything(),
      "utf-8",
    );
  });

  it("writes a ~/.local/bin/quest shim that delegates to ~/.companion/bin/quest", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith("/home/tester/.local/bin", { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/quest",
      expect.stringContaining('exec "$HOME/.companion/bin/quest" "$@"'),
      "utf-8",
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith("/home/tester/.local/bin/quest", 0o755);
  });

  it("writes a ~/.local/bin/rg compatibility shim", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining("rg (companion shim) 0.0.0"),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining('if [ "$1" = "--files" ]; then'),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining("grep_args=("),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining('exec grep "${grep_args[@]}" -- "$pattern" "${positional[@]:1}"'),
      "utf-8",
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith("/home/tester/.local/bin/rg", 0o755);
  });

  it("documents verification inbox commands and filters", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    const codexSkillWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.codex/skills/quest/SKILL.md",
    );
    expect(codexSkillWrite).toBeDefined();

    const skill = String(codexSkillWrite?.[1] ?? "");
    expect(skill).toContain("quest later  <id> [--json]");
    expect(skill).toContain("quest inbox  <id> [--json]");
    expect(skill).toContain("--verification <scope>");
    expect(skill).toContain("Verification Inbox workflow");
    expect(skill).toContain("quest list --verification inbox");
  });

  it("tells agents to prefer plain-text quest show and reserve --json for exact fields", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    const codexSkillWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.codex/skills/quest/SKILL.md",
    );
    expect(codexSkillWrite).toBeDefined();

    const skill = String(codexSkillWrite?.[1] ?? "");
    expect(skill).toContain("Prefer the plain-text form");
    expect(skill).toContain("quest feedback list/latest/show");
    expect(skill).toContain("quest feedback list --json");
    expect(skill).toContain("`commitShas`");
    expect(skill).toContain("version-local metadata from `quest history`");
  });

  it("documents feedback inspection and compact status commands", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    const codexSkillWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.codex/skills/quest/SKILL.md",
    );
    expect(codexSkillWrite).toBeDefined();

    const skill = String(codexSkillWrite?.[1] ?? "");
    expect(skill).toContain("quest status <id>");
    expect(skill).toContain("quest feedback list <id>");
    expect(skill).toContain("quest feedback latest <id>");
    expect(skill).toContain("quest feedback show <id> <index>");
    expect(skill).toContain("Use these read-only commands instead of `quest show --json` plus jq/Python");
  });

  it("documents quest grep as the preferred way to search inside quest text and comments", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    const codexSkillWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.codex/skills/quest/SKILL.md",
    );
    expect(codexSkillWrite).toBeDefined();

    const skill = String(codexSkillWrite?.[1] ?? "");
    expect(skill).toContain("quest grep   <pattern> [--count N] [--json]");
    expect(skill).toContain("Search quest title, description, and feedback/comments");
    expect(skill).toContain("Use `quest grep` when you need to search **inside** quest titles");
    expect(skill).toContain("Use `quest list --text` when you are broadly filtering the quest list");
    expect(skill).toContain("prefer `quest grep <pattern>` over manually scanning `quest show` output");
  });

  it("keeps copied quest wrappers identical across worktrees of the same repo", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/worktrees/wt-a/web");
    await ensureQuestmasterIntegration(3456, "/repo/worktrees/wt-b/web");

    const sharedWrites = fsMocks.writeFileSync.mock.calls.filter(
      (call) => call[0] === "/home/tester/.companion/bin/quest",
    );
    expect(sharedWrites).toHaveLength(2);
    expect(sharedWrites[0]?.[1]).toBe(sharedWrites[1]?.[1]);

    const sharedWrapper = String(sharedWrites[1]?.[1] ?? "");
    expect(sharedWrapper).toContain("/repo/web/bin/quest.ts");
    expect(sharedWrapper).not.toContain("/repo/worktrees/wt-a/web/bin/quest.ts");
    expect(sharedWrapper).not.toContain("/repo/worktrees/wt-b/web/bin/quest.ts");
  });
});
