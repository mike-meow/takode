import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(SERVER_DIR, "index.ts");

describe("index startup skill registration", () => {
  it("registers canonical Journey skills plus legacy compatibility aliases", async () => {
    // q-275: if a nonexistent project skill is reintroduced here, startup will
    // recreate warning spam and potentially broken symlink state. Guard the
    // actual ensureSkillSymlinks(...) registration list in index.ts directly.
    const source = await readFile(INDEX_PATH, "utf-8");
    const match = source.match(/ensureSkillSymlinks\(\[([\s\S]*?)\]\);/);
    expect(match).toBeTruthy();

    const registered = [...match![1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);

    expect(registered).not.toContain("cron-scheduling");
    expect(registered).toContain("takode-orchestration");
    expect(registered).toContain("leader-dispatch");
    expect(registered).not.toContain("quest-journey-planning");
    expect(registered).not.toContain("quest-journey-explore");
    expect(registered).not.toContain("quest-journey-implement");
    expect(registered).not.toContain("quest-journey-code-review");
    expect(registered).not.toContain("quest-journey-mental-simulation");
    expect(registered).not.toContain("quest-journey-execute");
    expect(registered).not.toContain("quest-journey-outcome-review");
    expect(registered).not.toContain("quest-journey-bookkeeping");
    expect(registered).not.toContain("quest-journey-port");
    expect(registered).not.toContain("quest-journey-implementation");
    expect(registered).not.toContain("quest-journey-skeptic-review");
    expect(registered).not.toContain("quest-journey-reviewer-groom");
    expect(registered).not.toContain("quest-journey-porting");
    expect(registered).toContain("self-groom");
    expect(registered).toContain("reviewer-groom");
    expect(registered).toContain("skeptic-review");
    expect(registered).toContain("worktree-rules");
  });
});
