import { afterEach, describe, expect, it, vi } from "vitest";
import {
  scheduleCodexToolResultWatchdogs,
  type ToolResultRecoveryDeps,
  type ToolResultRecoverySessionLike,
} from "./tool-result-recovery-controller.js";

function makeSession(): ToolResultRecoverySessionLike {
  return {
    id: "s1",
    backendType: "codex",
    messageHistory: [],
    toolResults: new Map(),
    toolStartTimes: new Map([["tool-1", Date.now() - 1_000]]),
    toolProgressOutput: new Map(),
    codexToolResultWatchdogs: new Map(),
    codexAdapter: null,
  };
}

function makeDeps(overrides: Partial<ToolResultRecoveryDeps> = {}): ToolResultRecoveryDeps {
  return {
    getToolUseBlockInHistory: () => ({ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep 1" } }),
    clearCodexToolResultWatchdog: () => {},
    emitSyntheticToolResultPreview: () => {},
    getCodexTurnInRecovery: () => null,
    codexToolResultWatchdogMs: 50,
    takodeBoardResultPreviewLimit: 12_000,
    defaultToolResultPreviewLimit: 300,
    ...overrides,
  };
}

describe("tool-result-recovery-controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the injected codex watchdog delay when scheduling tool-result recovery", () => {
    vi.useFakeTimers();
    const session = makeSession();
    const emitSyntheticToolResultPreview = vi.fn();
    const deps = makeDeps({ emitSyntheticToolResultPreview, codexToolResultWatchdogMs: 25 });

    scheduleCodexToolResultWatchdogs(session, "disconnect", deps);
    vi.advanceTimersByTime(24);
    expect(emitSyntheticToolResultPreview).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(emitSyntheticToolResultPreview).toHaveBeenCalledTimes(1);
  });
});
