import { vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    randomUUID: () => "test-session-id",
    randomBytes: (n: number) => ({ toString: () => "a".repeat(n * 2) }),
  };
});

const mockExec = vi.hoisted(() =>
  vi.fn((_cmd: string, _opts: any, cb: any) => {
    if (typeof _opts === "function") {
      _opts(null, "", "");
      return;
    }
    if (cb) cb(null, "", "");
  }),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    exec: mockExec,
  };
});

const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string): string | null => "/opt/fake/codex"));
const mockGetEnrichedPath = vi.hoisted(() => vi.fn(() => "/usr/bin:/usr/local/bin"));
const mockCaptureUserShellPath = vi.hoisted(() => vi.fn(() => "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"));
const mockCaptureUserShellEnv = vi.hoisted(() => vi.fn((): Record<string, string> => ({})));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  getEnrichedPath: mockGetEnrichedPath,
  captureUserShellPath: mockCaptureUserShellPath,
  captureUserShellEnv: mockCaptureUserShellEnv,
}));

vi.mock("./container-manager.js", () => ({
  containerManager: {
    isContainerAlive: () => "running",
    hasBinaryInContainer: () => true,
    startContainer: vi.fn(),
  },
}));

import { SessionStore } from "./session-store.js";
import { CliLauncher, type LaunchOptions } from "./cli-launcher.js";

const mockSpawn = vi.fn();
const bunGlobal = globalThis as typeof globalThis & { Bun?: any };
const hadBunGlobal = typeof bunGlobal.Bun !== "undefined";
const originalBunSpawn = hadBunGlobal ? bunGlobal.Bun!.spawn : undefined;
const originalFetch = globalThis.fetch;
const mockFetch = vi.fn();
if (hadBunGlobal) {
  (bunGlobal.Bun as { spawn?: unknown }).spawn = mockSpawn;
} else {
  bunGlobal.Bun = { spawn: mockSpawn };
}

function createMockCodexProc(pid = 12345) {
  return {
    pid,
    kill: vi.fn(),
    exited: new Promise<number>(() => {}),
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForSpawnCalls(count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (mockSpawn.mock.calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} spawn call(s), got ${mockSpawn.mock.calls.length}`);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met");
}

describe("Codex spawn preparation", () => {
  let tempDir: string;
  let codexHome: string;
  let store: SessionStore;
  let launcher: CliLauncher;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "launcher-spawn-test-"));
    codexHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    store = new SessionStore(tempDir);
    launcher = new CliLauncher(3456, { serverId: "test-server-id" });
    launcher.setStore(store);
    mockSpawn.mockReturnValue(createMockCodexProc());
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockGetEnrichedPath.mockReturnValue("/usr/bin:/usr/local/bin");
    mockCaptureUserShellPath.mockReturnValue("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    mockCaptureUserShellEnv.mockReturnValue({});
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockRejectedValue(new Error("no LiteLLM proxy in this test"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    delete process.env.LITELLM_API_KEY;
    delete process.env.LITELLM_PROXY_URL;
    delete process.env.LITELLM_BASE_URL;
  });

  afterAll(() => {
    if (hadBunGlobal) {
      (bunGlobal.Bun as { spawn?: unknown }).spawn = originalBunSpawn;
    } else {
      delete bunGlobal.Bun;
    }
    globalThis.fetch = originalFetch;
  });

  async function launchCodex(options: LaunchOptions = {}) {
    const info = await launcher.launch({
      backendType: "codex",
      cwd: tempDir,
      codexSandbox: "workspace-write",
      codexHome,
      ...options,
    });
    await waitForSpawnCalls(1);
    return info;
  }

  function mockLitellmModels(modelIds: string[]): void {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: modelIds.map((id) => ({ id })) }),
    });
  }

  function readCodexConfigArg(args: string[], key: string): string | undefined {
    for (let i = 0; i < args.length - 1; i += 1) {
      if (args[i] === "-c" && args[i + 1].startsWith(`${key}=`)) {
        return args[i + 1].slice(key.length + 1);
      }
    }
    return undefined;
  }

  it("preserves Companion/Takode env vars in Codex shell policy for orchestrators", async () => {
    // The session config must allow Takode env vars through Codex's filtered
    // shell policy while preserving unrelated user feature settings.
    const sessionHome = join(codexHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    mkdirSync(sessionHome, { recursive: true });
    writeFileSync(
      configPath,
      [
        'sandbox_mode = "workspace-write"',
        "",
        "[features]",
        "multi_agent = false",
        "other_feature = false",
        "",
        "[shell_environment_policy]",
        'inherit = "core"',
        "include_only = [",
        '    "PATH",',
        '    "HOME",',
        "]",
        "",
      ].join("\n"),
      "utf-8",
    );

    await launchCodex({
      env: {
        COMPANION_PORT: "3456",
        TAKODE_ROLE: "orchestrator",
        TAKODE_API_PORT: "3456",
      },
    });

    const [cmdAndArgs, options] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs).toContain("app-server");
    expect(options.env.COMPANION_SERVER_ID).toBe("test-server-id");
    expect(options.env.COMPANION_SESSION_ID).toBe("test-session-id");
    expect(options.env.COMPANION_SESSION_NUMBER).toBeDefined();

    const updatedConfig = await Bun.file(configPath).text();
    expect(updatedConfig).toContain("[features]");
    expect(updatedConfig).toContain("multi_agent = true");
    expect(updatedConfig).not.toContain("multi_agent = false");
    expect(updatedConfig).toContain("other_feature = false");
    expect(updatedConfig).toContain('"PATH"');
    expect(updatedConfig).toContain('"HOME"');
    expect(updatedConfig).toContain('"COMPANION_SERVER_ID"');
    expect(updatedConfig).toContain('"COMPANION_SESSION_ID"');
    expect(updatedConfig).toContain('"COMPANION_SESSION_NUMBER"');
    expect(updatedConfig).toContain('"COMPANION_AUTH_TOKEN"');
    expect(updatedConfig).toContain('"COMPANION_PORT"');
    expect(updatedConfig).toContain('"TAKODE_ROLE"');
    expect(updatedConfig).toContain('"TAKODE_API_PORT"');
  });

  it("passes Codex auto-review a valid review_model from Takode autoApprovalModel", async () => {
    // Auto-review must keep Codex's native reviewer mode while sending a
    // model ID that LiteLLM actually serves.
    mockLitellmModels(["sonnet", "haiku", "gpt-5.5"]);
    launcher.setSettingsGetter(() => ({
      claudeBinary: "",
      codexBinary: "/opt/fake/codex",
      autoApprovalModel: "haiku",
    }));

    await launchCodex({
      permissionMode: "codex-auto-review",
      model: "gpt-5.5",
      codexInternetAccess: false,
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(readCodexConfigArg(cmdAndArgs, "approvals_reviewer")).toBe("auto_review");
    expect(readCodexConfigArg(cmdAndArgs, "review_model")).toBe("haiku");
  });

  it("falls back to a valid session model when autoApprovalModel is unavailable", async () => {
    // A configured approval model is only usable when it appears in the local
    // provider list; otherwise the session/provider model is the next choice.
    mockLitellmModels(["sonnet", "gpt-5.5"]);
    launcher.setSettingsGetter(() => ({
      claudeBinary: "",
      codexBinary: "/opt/fake/codex",
      autoApprovalModel: "codex-auto-review",
    }));

    await launchCodex({
      permissionMode: "codex-auto-review",
      model: "gpt-5.5",
      codexInternetAccess: false,
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(readCodexConfigArg(cmdAndArgs, "review_model")).toBe("gpt-5.5");
  });

  it("falls back to sonnet when Codex auto-review has no valid configured model", async () => {
    // This is the current regression shape: codex-auto-review is a permission
    // profile, not a LiteLLM model, so the reviewer needs a separate fallback.
    mockLitellmModels(["sonnet", "gpt-5.5"]);

    await launchCodex({
      permissionMode: "codex-auto-review",
      model: "codex-auto-review",
      codexInternetAccess: false,
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(readCodexConfigArg(cmdAndArgs, "approvals_reviewer")).toBe("auto_review");
    expect(readCodexConfigArg(cmdAndArgs, "review_model")).toBe("sonnet");
  });

  it("ignores synthesized leader catalog entries when resolving Codex auto-review review_model", async () => {
    // Leader launch prep can synthesize a catalog entry for the session model.
    // That generated entry must not make the permission profile look like a
    // real LiteLLM reviewer model.
    mockLitellmModels(["sonnet", "gpt-5.5"]);

    await launchCodex({
      permissionMode: "codex-auto-review",
      model: "codex-auto-review",
      codexInternetAccess: false,
      env: {
        TAKODE_ROLE: "orchestrator",
        TAKODE_API_PORT: "3456",
      },
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(readCodexConfigArg(cmdAndArgs, "approvals_reviewer")).toBe("auto_review");
    expect(readCodexConfigArg(cmdAndArgs, "review_model")).toBe("sonnet");

    const generatedCatalog = JSON.parse(
      await Bun.file(join(codexHome, "test-session-id", "takode-leader-model-catalog.json")).text(),
    );
    expect(generatedCatalog.models.some((model: { slug?: string }) => model.slug === "codex-auto-review")).toBe(true);
  });

  it.each([
    ["codex-default", "on-request", "workspace-write"],
    ["codex-full-access", "never", "danger-full-access"],
    ["codex-custom", undefined, undefined],
  ])("does not add Codex reviewer config for %s", async (permissionMode, expectedApproval, expectedSandbox) => {
    // Non-auto-review profiles should retain their existing approval/sandbox
    // behavior and must not receive Codex reviewer-specific config.
    await launchCodex({
      permissionMode,
      codexSandbox: undefined,
      codexInternetAccess: false,
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const approvalIdx = cmdAndArgs.indexOf("-a");
    const sandboxIdx = cmdAndArgs.indexOf("-s");
    if (expectedApproval) {
      expect(cmdAndArgs[approvalIdx + 1]).toBe(expectedApproval);
    } else {
      expect(approvalIdx).toBe(-1);
    }
    if (expectedSandbox) {
      expect(cmdAndArgs[sandboxIdx + 1]).toBe(expectedSandbox);
    } else {
      expect(sandboxIdx).toBe(-1);
    }
    expect(readCodexConfigArg(cmdAndArgs, "approvals_reviewer")).toBeUndefined();
    expect(readCodexConfigArg(cmdAndArgs, "review_model")).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("scrubs session-scoped developer instructions from an existing session config", async () => {
    // Existing Takode session homes can already contain stale guardrails; launch
    // prep should remove only that root key before Codex writes fresh ones.
    const sessionHome = join(codexHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    mkdirSync(sessionHome, { recursive: true });
    writeFileSync(
      configPath,
      [
        'model_provider = "mai-litellm"',
        'model = "gpt-5.5"',
        'model_reasoning_effort = "high"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        'developer_instructions = """',
        "old Takode session guardrails",
        '"""',
        "",
        "[features]",
        "other_feature = true",
        "",
        "[model_providers.mai-litellm]",
        'name = "MAI LiteLLM"',
        'base_url = "http://localhost:4000/v1"',
        'env_key = "LITELLM_API_KEY"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
      "utf-8",
    );

    await launchCodex({
      env: {
        COMPANION_PORT: "3456",
      },
    });

    const updatedConfig = await Bun.file(configPath).text();
    expect(updatedConfig).toContain('model_provider = "mai-litellm"');
    expect(updatedConfig).toContain('model = "gpt-5.5"');
    expect(updatedConfig).toContain('model_reasoning_effort = "high"');
    expect(updatedConfig).toContain('approval_policy = "on-request"');
    expect(updatedConfig).toContain('sandbox_mode = "workspace-write"');
    expect(updatedConfig).toContain("[features]");
    expect(updatedConfig).toContain("other_feature = true");
    expect(updatedConfig).toContain("multi_agent = true");
    expect(updatedConfig).toContain("image_generation = false");
    expect(updatedConfig).toContain("[model_providers.mai-litellm]");
    expect(updatedConfig).toContain('name = "MAI LiteLLM"');
    expect(updatedConfig).toContain('base_url = "http://localhost:4000/v1"');
    expect(updatedConfig).toContain('env_key = "LITELLM_API_KEY"');
    expect(updatedConfig).toContain('wire_api = "responses"');
    expect(updatedConfig).not.toContain("developer_instructions");
    expect(updatedConfig).not.toContain("old Takode session guardrails");
  });

  it("builds host Codex PATH from enriched startup data without hot-path shell capture", async () => {
    // Spawn prep should reuse startup-warmed shell data; re-capturing a shell in
    // this path is slow and can stall session startup.
    mockCaptureUserShellPath.mockImplementation(() => {
      throw new Error("host Codex launch should not re-capture shell PATH");
    });
    mockCaptureUserShellEnv.mockReturnValue({ LITELLM_API_KEY: "startup-warmed-key" });
    mockGetEnrichedPath.mockReturnValue(
      "/opt/homebrew/bin:/Users/test/.bun/bin:/usr/local/share/companion-extra:/usr/bin:/bin",
    );
    process.env.LITELLM_API_KEY = "stale-daemon-key";

    await launchCodex({ codexInternetAccess: true });

    const [, options] = mockSpawn.mock.calls[0];
    const dirs = options.env.PATH.split(":");
    expect(dirs.slice(0, 6)).toEqual([
      "/opt/fake",
      join(homedir(), ".companion", "bin"),
      join(homedir(), ".local", "bin"),
      join(homedir(), ".bun", "bin"),
      "/opt/homebrew/bin",
      "/Users/test/.bun/bin",
    ]);
    expect(dirs).toContain("/usr/local/share/companion-extra");
    expect(options.env.LITELLM_API_KEY).toBe("startup-warmed-key");
    expect(mockCaptureUserShellEnv).toHaveBeenCalledWith(["LITELLM_API_KEY", "LITELLM_PROXY_URL", "LITELLM_BASE_URL"], {
      allowShellSpawn: false,
    });
    expect(mockCaptureUserShellPath).not.toHaveBeenCalled();
  });

  it("spawns codex via sibling node binary to bypass shebang issues", async () => {
    // Node-installed Codex scripts can have shebangs that resolve to an old
    // system node, so the launcher should prefer the sibling node binary.
    const tmpBinDir = mkdtempSync(join(tmpdir(), "codex-test-"));
    const fakeCodex = join(tmpBinDir, "codex");
    const fakeNode = join(tmpBinDir, "node");
    writeFileSync(fakeCodex, "#!/usr/bin/env node\n");
    writeFileSync(fakeNode, "#!/bin/sh\n");

    try {
      mockResolveBinary.mockReturnValue(fakeCodex);

      await launchCodex();

      const [cmdAndArgs] = mockSpawn.mock.calls[0];
      expect(cmdAndArgs[0]).toBe(fakeNode);
      expect(cmdAndArgs[1]).toContain("codex");
      expect(cmdAndArgs).toContain("app-server");
    } finally {
      rmSync(tmpBinDir, { recursive: true, force: true });
    }
  });

  it("does not invoke sibling node for a native codex binary", async () => {
    // Native Codex binaries must run directly; passing them to node would fail
    // even when a sibling node binary happens to exist.
    const tmpBinDir = mkdtempSync(join(tmpdir(), "codex-native-test-"));
    const fakeCodex = join(tmpBinDir, "codex");
    const fakeNode = join(tmpBinDir, "node");
    writeFileSync(fakeCodex, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]));
    writeFileSync(fakeNode, "#!/bin/sh\n");

    try {
      mockResolveBinary.mockReturnValue(fakeCodex);

      await launchCodex();

      const [cmdAndArgs] = mockSpawn.mock.calls[0];
      expect(cmdAndArgs[0]).toBe(fakeCodex);
      expect(cmdAndArgs.slice(1, 5)).toEqual(["-c", "tools.webSearch=false", "-a", "untrusted"]);
    } finally {
      rmSync(tmpBinDir, { recursive: true, force: true });
    }
  });

  it("sets state=exited and exitCode=127 when codex binary is not found", async () => {
    // Missing binary failures should become session state, not an attempted
    // spawn with a bogus command.
    mockResolveBinary.mockReturnValue(null);

    const info = await launcher.launch({
      backendType: "codex",
      cwd: tempDir,
      codexSandbox: "workspace-write",
      codexHome,
    });
    await waitForCondition(() => info.state === "exited");

    expect(info.exitCode).toBe(127);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
