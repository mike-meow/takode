import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
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

import { ensureTakodeIntegration } from "./takode-integration.js";

describe("ensureTakodeIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a copied global takode wrapper targeting the stable main checkout", async () => {
    await ensureTakodeIntegration("/repo/worktrees/wt-1/web");

    const sharedWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.companion/bin/takode",
    );
    expect(sharedWrite).toBeDefined();

    const sharedWrapper = String(sharedWrite?.[1] ?? "");
    expect(sharedWrapper).toContain('exec bun "/repo/web/bin/takode.ts" "$@"');
    expect(sharedWrapper).toContain('exec "$HOME/.bun/bin/bun" "/repo/web/bin/takode.ts" "$@"');
    expect(sharedWrapper).not.toContain("/repo/worktrees/wt-1/web/bin/takode.ts");
  });

  it("keeps copied takode wrappers identical across worktrees of the same repo", async () => {
    await ensureTakodeIntegration("/repo/worktrees/wt-a/web");
    await ensureTakodeIntegration("/repo/worktrees/wt-b/web");

    const sharedWrites = fsMocks.writeFileSync.mock.calls.filter(
      (call) => call[0] === "/home/tester/.companion/bin/takode",
    );
    expect(sharedWrites).toHaveLength(2);
    expect(sharedWrites[0]?.[1]).toBe(sharedWrites[1]?.[1]);

    const sharedWrapper = String(sharedWrites[1]?.[1] ?? "");
    expect(sharedWrapper).toContain("/repo/web/bin/takode.ts");
    expect(sharedWrapper).not.toContain("/repo/worktrees/wt-a/web/bin/takode.ts");
    expect(sharedWrapper).not.toContain("/repo/worktrees/wt-b/web/bin/takode.ts");
  });
});
