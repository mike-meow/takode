import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const mockAccess = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
const mockRequireResolve = vi.hoisted(() => vi.fn());
const mockCreateRequire = vi.hoisted(() =>
  vi.fn(() => ({
    resolve: mockRequireResolve,
  })),
);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: mockAccess };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: mockExec };
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: mockCreateRequire };
});

// ─── Import after mocks ─────────────────────────────────────────────────────

// Dynamic import to reset the module cache between tests (since it caches the result)
async function freshImport() {
  vi.resetModules();
  return import("./ripgrep.js");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("getRipgrepPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the SDK vendored binary when it exists", async () => {
    const { getRipgrepPath } = await freshImport();
    mockRequireResolve.mockReturnValue("/mock/sdk/sdk.mjs");
    // access() succeeds — vendored binary exists
    mockAccess.mockResolvedValue(undefined);

    const result = await getRipgrepPath();
    const ext = process.platform === "win32" ? ".exe" : "";
    expect(mockRequireResolve).toHaveBeenCalledWith("@anthropic-ai/claude-agent-sdk");
    expect(result).toBe(join("/mock/sdk", "vendor", "ripgrep", `${process.arch}-${process.platform}`, `rg${ext}`));
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("falls back to system rg when SDK binary is missing", async () => {
    const { getRipgrepPath } = await freshImport();
    mockRequireResolve.mockImplementation(() => {
      throw new Error("SDK export missing");
    });
    mockAccess.mockResolvedValue(undefined);
    // exec() for 'which rg' returns a discovered path
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb?: Function) => {
      if (cb) cb(null, { stdout: "/custom/tools/rg\n" });
      return {} as any;
    });

    const result = await getRipgrepPath();
    expect(result).toBe("/custom/tools/rg");
  });

  it("returns bare 'rg' when neither SDK nor system binary exists", async () => {
    const { getRipgrepPath } = await freshImport();
    mockRequireResolve.mockImplementation(() => {
      throw new Error("SDK export missing");
    });
    // access() always fails — no system binary either
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    // exec() for 'which rg' fails
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb?: Function) => {
      if (cb) cb(new Error("not found"), { stdout: "" });
      return {} as any;
    });

    const result = await getRipgrepPath();
    expect(result).toBe("rg");
  });

  it("caches the result after first call", async () => {
    const { getRipgrepPath } = await freshImport();
    mockRequireResolve.mockReturnValue("/mock/sdk/sdk.mjs");
    mockAccess.mockResolvedValue(undefined);

    const first = await getRipgrepPath();
    mockAccess.mockClear();
    const second = await getRipgrepPath();

    expect(first).toBe(second);
    // access() should NOT be called again (result was cached)
    expect(mockAccess).not.toHaveBeenCalled();
  });
});
