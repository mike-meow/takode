import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(SERVER_DIR, "index.ts");

describe("index startup skill registration", () => {
  it("does not register missing repo-only skills in ensureSkillSymlinks", async () => {
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
    expect(registered).toContain("self-groom");
    expect(registered).toContain("reviewer-groom");
    expect(registered).toContain("skeptic-review");
    expect(registered).toContain("worktree-rules");
  });
});
