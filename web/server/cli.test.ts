import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("CLI help output", () => {
  it("lists daemon and foreground commands", () => {
    const cliPath = fileURLToPath(new URL("../bin/cli.ts", import.meta.url));
    // Use process.execPath instead of "bun" so the test works even when
    // bun is not on the default PATH (e.g. installed in ~/.bun/bin).
    const result = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf-8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("serve       Start the server in foreground");
    expect(result.stdout).toContain("start       Start the background service");
    expect(result.stdout).toContain("stop        Stop the background service");
    expect(result.stdout).toContain("restart     Restart the background service");
    expect(result.stdout).toContain("help        Show this help message");
  });
});
