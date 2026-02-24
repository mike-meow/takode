import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/tester",
}));

vi.mock("node:fs", () => fsMocks);

import { ensureQuestmasterIntegration } from "./quest-integration.js";

describe("ensureQuestmasterIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
  });

  it("writes quest skill to both Claude and Codex skill homes", () => {
    ensureQuestmasterIntegration(3456, "/repo/web");

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

  it("writes a quest wrapper that falls back to $HOME/.bun/bin/bun", () => {
    ensureQuestmasterIntegration(3456, "/repo/web");

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.companion/bin/quest",
      expect.stringContaining("if [ -x \"$HOME/.bun/bin/bun\" ]"),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.companion/bin/quest",
      expect.stringContaining("exec \"$HOME/.bun/bin/bun\""),
      "utf-8",
    );
  });

  it("writes a ~/.local/bin/quest shim that delegates to ~/.companion/bin/quest", () => {
    ensureQuestmasterIntegration(3456, "/repo/web");

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith("/home/tester/.local/bin", { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/quest",
      expect.stringContaining("exec \"$HOME/.companion/bin/quest\" \"$@\""),
      "utf-8",
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith("/home/tester/.local/bin/quest", 0o755);
  });

  it("writes a ~/.local/bin/rg compatibility shim", () => {
    ensureQuestmasterIntegration(3456, "/repo/web");

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining("rg (companion shim) 0.0.0"),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining("if [ \"$1\" = \"--files\" ]; then"),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining("exec grep -RIn --binary-files=without-match --exclude-dir=.git -- \"$pattern\" \"$@\""),
      "utf-8",
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith("/home/tester/.local/bin/rg", 0o755);
  });
});
