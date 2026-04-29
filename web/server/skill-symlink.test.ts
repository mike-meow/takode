import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn((_targetDir: string) => false),
  mkdirSync: vi.fn(),
  symlinkSync: vi.fn(),
  lstatSync: vi.fn((_targetDir: string): { isSymbolicLink: () => boolean } => {
    throw new Error("ENOENT");
  }),
  readlinkSync: vi.fn(),
  readdirSync: vi.fn((): any[] => []),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));

const execMock = vi.hoisted(() =>
  vi.fn((_command: string, _options: object, callback: (error: Error | null, stdout: string) => void) => {
    callback(null, "../.git\n");
  }),
);

vi.mock("node:os", () => ({
  homedir: () => "/home/tester",
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
}));

vi.mock("node:url", () => ({
  fileURLToPath: () => "/repo/web/server/skill-symlink.ts",
}));

vi.mock("node:fs", () => fsMocks);

import { ensureSkillSymlinks } from "./skill-symlink.js";

describe("ensureSkillSymlinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue([]);
    fsMocks.lstatSync.mockImplementation((_targetDir: string): { isSymbolicLink: () => boolean } => {
      throw new Error("ENOENT");
    });
  });

  it("symlinks project skills into Claude and agents homes", async () => {
    // Validates the shared project-skill fallback used by takode-orchestration,
    // which currently only exists under the repo's .claude/skills directory.
    fsMocks.existsSync.mockImplementation((targetDir: string) => {
      return targetDir === "/repo/.claude/skills/takode-orchestration";
    });

    await ensureSkillSymlinks(["takode-orchestration"]);

    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.claude/skills/takode-orchestration",
    );
    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.agents/skills/takode-orchestration",
    );
    expect(fsMocks.symlinkSync).not.toHaveBeenCalledWith(
      expect.any(String),
      "/home/tester/.codex/skills/takode-orchestration",
    );
  });

  it("replaces stale copied agent skill directories with repo symlinks", async () => {
    // Validates the observed bug: old copied ~/.agents skills are replaced with
    // repo-backed symlinks, so subdocs like quest-journey.md stay available.
    fsMocks.existsSync.mockImplementation((targetDir: string) => {
      return targetDir === "/repo/.claude/skills/takode-orchestration";
    });
    fsMocks.lstatSync.mockImplementation((targetDir: string) => {
      if (targetDir === "/home/tester/.agents/skills/takode-orchestration") {
        return { isSymbolicLink: () => false };
      }
      throw new Error("ENOENT");
    });

    await ensureSkillSymlinks(["takode-orchestration"]);

    expect(fsMocks.rmSync).toHaveBeenCalledWith("/home/tester/.agents/skills/takode-orchestration", {
      recursive: true,
    });
    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.agents/skills/takode-orchestration",
    );
  });

  it("uses repo-local agent skill directories when present", async () => {
    // Validates agent-specific variants are preserved instead of being replaced
    // by the Claude source when the repo has an .agents/skills copy.
    fsMocks.existsSync.mockImplementation((targetDir: string) => {
      return (
        targetDir === "/repo/.agents/skills/playwright-e2e-tester" ||
        targetDir === "/repo/.claude/skills/playwright-e2e-tester"
      );
    });

    await ensureSkillSymlinks(["playwright-e2e-tester"]);

    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.agents/skills/playwright-e2e-tester",
      "/home/tester/.agents/skills/playwright-e2e-tester",
    );
    expect(fsMocks.symlinkSync).not.toHaveBeenCalledWith(
      expect.any(String),
      "/home/tester/.codex/skills/playwright-e2e-tester",
    );
  });

  it("ignores repo-local legacy Codex skill directories for active installs", async () => {
    // Validates .codex is compatibility-only; project-specific non-Claude
    // variants now come from .agents, then fall back to .claude.
    fsMocks.existsSync.mockImplementation((targetDir: string) => {
      return (
        targetDir === "/repo/.codex/skills/takode-orchestration" ||
        targetDir === "/repo/.claude/skills/takode-orchestration"
      );
    });

    await ensureSkillSymlinks(["takode-orchestration"]);

    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.agents/skills/takode-orchestration",
    );
    expect(fsMocks.symlinkSync).not.toHaveBeenCalledWith(
      "/repo/.codex/skills/takode-orchestration",
      expect.any(String),
    );
  });

  it("migrates legacy-only global Codex skills into agents with symlinks", async () => {
    // Validates unique old ~/.codex/skills content remains discoverable after
    // .agents becomes the active non-Claude skill root.
    fsMocks.existsSync.mockImplementation((targetDir: string) => {
      return (
        targetDir === "/home/tester/.codex/skills" ||
        targetDir === "/home/tester/.codex/skills/pdf" ||
        targetDir === "/repo/.claude/skills/takode-orchestration"
      );
    });
    fsMocks.readdirSync.mockReturnValue([{ name: "pdf" } as any]);

    await ensureSkillSymlinks(["takode-orchestration"]);

    expect(fsMocks.symlinkSync).toHaveBeenCalledWith(
      "/home/tester/.codex/skills/pdf",
      "/home/tester/.agents/skills/pdf",
    );
  });

  it("leaves an existing correct agent symlink alone", async () => {
    // Validates the startup path stays idempotent once ~/.agents already
    // points at the expected repo-backed skill directory.
    fsMocks.existsSync.mockImplementation((targetDir: string) => {
      return targetDir === "/repo/.claude/skills/takode-orchestration";
    });
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

    await ensureSkillSymlinks(["takode-orchestration"]);

    expect(fsMocks.unlinkSync).not.toHaveBeenCalledWith("/home/tester/.agents/skills/takode-orchestration");
    expect(fsMocks.rmSync).not.toHaveBeenCalledWith("/home/tester/.agents/skills/takode-orchestration", {
      recursive: true,
    });
    expect(fsMocks.symlinkSync).not.toHaveBeenCalledWith(
      "/repo/.claude/skills/takode-orchestration",
      "/home/tester/.agents/skills/takode-orchestration",
    );
  });

  it("skips missing repo skill sources instead of creating broken symlinks", async () => {
    // Validates q-275: startup should not create global skill symlinks for
    // hardcoded slugs that do not exist in the repo checkout.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fsMocks.existsSync.mockImplementation((targetDir: string) => {
      return targetDir !== "/repo/.claude/skills/cron-scheduling";
    });

    await ensureSkillSymlinks(["cron-scheduling"]);

    expect(fsMocks.symlinkSync).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[skill-symlink] Skipping missing repo skill source: /repo/.claude/skills/cron-scheduling",
    );

    warnSpy.mockRestore();
  });
});
