import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn((_targetDir: string) => false),
  mkdirSync: vi.fn(),
  symlinkSync: vi.fn(),
  lstatSync: vi.fn((_targetDir: string): { isSymbolicLink: () => boolean } => {
    throw new Error("ENOENT");
  }),
  readlinkSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));

const execSyncMock = vi.hoisted(() => vi.fn(() => "../.git\n"));

vi.mock("node:os", () => ({
  homedir: () => "/home/tester",
}));

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

vi.mock("node:url", () => ({
  fileURLToPath: () => "/repo/web/server/skill-symlink.ts",
}));

vi.mock("node:fs", () => fsMocks);

import { ensureSkillSymlinks } from "./skill-symlink.js";

describe("ensureSkillSymlinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSyncMock.mockReturnValue("../.git\n");
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.lstatSync.mockImplementation((_targetDir: string): { isSymbolicLink: () => boolean } => {
      throw new Error("ENOENT");
    });
  });

  it("symlinks project skills into Claude, Codex, and agents homes", () => {
    // Validates the shared project-skill fallback used by takode-orchestration,
    // which currently only exists under the repo's .claude/skills directory.
    ensureSkillSymlinks(["takode-orchestration"]);

    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.claude/skills/takode-orchestration",
    );
    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.codex/skills/takode-orchestration",
    );
    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.agents/skills/takode-orchestration",
    );
  });

  it("replaces stale copied agent skill directories with repo symlinks", () => {
    // Validates the observed bug: old copied ~/.agents skills are replaced with
    // repo-backed symlinks, so subdocs like quest-journey.md stay available.
    fsMocks.lstatSync.mockImplementation((targetDir: string) => {
      if (targetDir === "/home/tester/.agents/skills/takode-orchestration") {
        return { isSymbolicLink: () => false };
      }
      throw new Error("ENOENT");
    });

    ensureSkillSymlinks(["takode-orchestration"]);

    expect(fsMocks.rmSync).toHaveBeenCalledWith("/home/tester/.agents/skills/takode-orchestration", {
      recursive: true,
    });
    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.agents/skills/takode-orchestration",
    );
  });

  it("uses repo-local agent skill directories when present", () => {
    // Validates agent-specific variants are preserved instead of being replaced
    // by the Claude source when the repo has an .agents/skills copy.
    fsMocks.existsSync.mockImplementation((targetDir: string) => {
      return targetDir === "/repo/.agents/skills/playwright-e2e-tester";
    });

    ensureSkillSymlinks(["playwright-e2e-tester"]);

    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.agents/skills/playwright-e2e-tester",
      "/home/tester/.agents/skills/playwright-e2e-tester",
    );
    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/playwright-e2e-tester",
      "/home/tester/.codex/skills/playwright-e2e-tester",
    );
  });

  it("uses repo-local Codex skill directories when present", () => {
    // Validates Codex-specific variants are preserved instead of always
    // falling back to the repo's Claude skill directory.
    fsMocks.existsSync.mockImplementation((targetDir: string) => {
      return targetDir === "/repo/.codex/skills/takode-orchestration";
    });

    ensureSkillSymlinks(["takode-orchestration"]);

    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.codex/skills/takode-orchestration",
      "/home/tester/.codex/skills/takode-orchestration",
    );
    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.agents/skills/takode-orchestration",
    );
  });

  it("leaves an existing correct agent symlink alone", () => {
    // Validates the startup path stays idempotent once ~/.agents already
    // points at the expected repo-backed skill directory.
    fsMocks.lstatSync.mockImplementation((targetDir: string) => {
      if (targetDir === "/home/tester/.agents/skills/takode-orchestration") {
        return { isSymbolicLink: () => true };
      }
      throw new Error("ENOENT");
    });
    fsMocks.readlinkSync.mockImplementation((targetDir: string) => {
      if (targetDir === "/home/tester/.agents/skills/takode-orchestration") {
        return "/repo/.claude/skills/takode-orchestration";
      }
      return "";
    });

    ensureSkillSymlinks(["takode-orchestration"]);

    expect(fsMocks.unlinkSync).not.toHaveBeenCalledWith("/home/tester/.agents/skills/takode-orchestration");
    expect(fsMocks.rmSync).not.toHaveBeenCalledWith("/home/tester/.agents/skills/takode-orchestration", {
      recursive: true,
    });
    expect(fsMocks.symlinkSync).not.toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.agents/skills/takode-orchestration",
    );
  });
});
