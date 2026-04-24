import { describe, expect, it, vi } from "vitest";
import { resolveSessionCreateModel } from "./session-create-model.js";

function makeLauncher(
  session:
    | {
        backendType?: "claude" | "codex" | "claude-sdk";
        model?: string;
      }
    | undefined = undefined,
) {
  return {
    getSession: vi.fn(() => session),
    resolveSessionId: vi.fn((id: string) => id),
  };
}

describe("resolveSessionCreateModel", () => {
  it("inherits the creator model for same-backend spawns when no explicit model is provided", async () => {
    const launcher = makeLauncher({ backendType: "codex", model: "gpt-5.5" });

    await expect(
      resolveSessionCreateModel({
        backend: "codex",
        createdBy: "leader-1",
        getClaudeUserDefaultModel: vi.fn(async () => "claude-default"),
        launcher,
      }),
    ).resolves.toBe("gpt-5.5");
  });

  it("falls back to the target backend default for cross-backend spawns", async () => {
    const getClaudeUserDefaultModel = vi.fn(async () => "claude-default");
    const launcher = makeLauncher({ backendType: "codex", model: "gpt-5.5" });

    await expect(
      resolveSessionCreateModel({
        backend: "claude",
        createdBy: "leader-1",
        getClaudeUserDefaultModel,
        launcher,
      }),
    ).resolves.toBe("claude-default");
    expect(getClaudeUserDefaultModel).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit model override", async () => {
    const launcher = makeLauncher({ backendType: "codex", model: "gpt-5.5" });

    await expect(
      resolveSessionCreateModel({
        backend: "claude",
        createdBy: "leader-1",
        getClaudeUserDefaultModel: vi.fn(async () => "claude-default"),
        launcher,
        requestedModel: "custom-model",
      }),
    ).resolves.toBe("custom-model");
  });
});
