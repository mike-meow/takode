import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SCRIPT_SOURCE = join(import.meta.dirname, "..", "..", "scripts", "dev-start.sh");
const tempDirs: string[] = [];

describe("scripts/dev-start.sh", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("fails fast with setup guidance when web dependencies are missing", async () => {
    // Fresh clones should stop before any startup work and point to the
    // explicit install command instead of attempting a package install.
    const fixture = await createFixture();

    const result = runDevStart(fixture.rootDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing local web dependencies");
    expect(result.stderr).toContain("bun install --cwd web");
    expect(result.stderr).toContain("make dev");
    expect(result.stderr).toContain("./scripts/dev-start.sh");
  });

  it("fails fast when the install state is incomplete", async () => {
    // Partial node_modules state should produce the same actionable guidance
    // instead of falling through to a noisier Vite or backend startup failure.
    const fixture = await createFixture();
    await mkdir(join(fixture.rootDir, "web", "node_modules"), { recursive: true });

    const result = runDevStart(fixture.rootDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected install artifact not found");
    expect(result.stderr).toContain("node_modules/.bin/vite");
  });
});

async function createFixture(): Promise<{ rootDir: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), "takode-dev-start-"));
  tempDirs.push(rootDir);

  await mkdir(join(rootDir, "scripts"), { recursive: true });
  await mkdir(join(rootDir, "web"), { recursive: true });
  await mkdir(join(rootDir, ".fake-bin"), { recursive: true });

  await writeFile(join(rootDir, "scripts", "dev-start.sh"), await readFile(SCRIPT_SOURCE, "utf-8"), "utf-8");
  await writeFile(join(rootDir, "web", "package.json"), '{ "name": "fixture-web" }\n', "utf-8");
  await writeExecutable(join(rootDir, ".fake-bin", "bun"), '#!/usr/bin/env bash\necho "1.3.10"\n');
  await writeExecutable(join(rootDir, ".fake-bin", "python3"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(join(rootDir, ".fake-bin", "lsof"), "#!/usr/bin/env bash\nexit 1\n");

  return { rootDir };
}

function runDevStart(rootDir: string) {
  return spawnSync("bash", [join(rootDir, "scripts", "dev-start.sh")], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(rootDir, ".fake-bin")}:${process.env.PATH || ""}`,
    },
  });
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o755 });
}
