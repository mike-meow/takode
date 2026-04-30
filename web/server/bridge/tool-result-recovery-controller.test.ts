import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finalizeSupersededCodexTerminalTools,
  recoverToolStartTimesFromHistory,
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
    getToolUseBlockInHistory: (session, toolUseId) => {
      for (const msg of session.messageHistory) {
        if (msg.type !== "assistant") continue;
        const content = msg.message?.content;
        if (!Array.isArray(content)) continue;
        const block = content.find((item) => item.type === "tool_use" && item.id === toolUseId);
        if (block?.type === "tool_use") return block;
      }
      return { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep 1" } };
    },
    hasToolResultPreviewReplay: () => false,
    clearCodexToolResultWatchdog: () => {},
    broadcastToBrowsers: () => {},
    persistSession: () => {},
    getCodexTurnInRecovery: () => null,
    codexToolResultWatchdogMs: 50,
    takodeBoardResultPreviewLimit: 12_000,
    defaultToolResultPreviewLimit: 300,
    ...overrides,
  };
}

function addBashToolUse(session: ToolResultRecoverySessionLike, toolUseId: string, startedAt: number): void {
  session.toolStartTimes.set(toolUseId, startedAt);
  addPersistedToolUse(session, toolUseId, "Bash", startedAt, { command: "echo test" });
}

function addPersistedToolUse(
  session: ToolResultRecoverySessionLike,
  toolUseId: string,
  toolName: string,
  startedAt: number,
  input: Record<string, unknown>,
): void {
  session.messageHistory.push({
    type: "assistant",
    message: {
      id: `msg-${toolUseId}`,
      type: "message",
      role: "assistant",
      model: "gpt-5.3-codex",
      content: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    session_id: session.id,
    uuid: `uuid-${toolUseId}`,
    tool_start_times: { [toolUseId]: startedAt },
  } as ToolResultRecoverySessionLike["messageHistory"][number]);
}

function addPersistedToolResultPreview(session: ToolResultRecoverySessionLike, toolUseId: string): void {
  session.messageHistory.push({
    type: "tool_result_preview",
    previews: [
      {
        tool_use_id: toolUseId,
        content: "done",
        is_error: false,
        total_size: 4,
        is_truncated: false,
        duration_seconds: 1,
      },
    ],
  });
}

describe("tool-result-recovery-controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not recover restored Codex plan TodoWrite starts as unresolved tool results", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const session = makeSession();
    session.toolStartTimes.clear();
    session.messageHistory = [];
    addPersistedToolUse(session, "codex-plan-turn-1", "TodoWrite", 1_000, {
      todos: [{ content: "Inspect", status: "in_progress" }],
    });
    const broadcastToBrowsers = vi.fn();
    const persistSession = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ broadcastToBrowsers, persistSession, codexToolResultWatchdogMs: 1_000 });

    // Regression coverage for q-1011: synthetic plan/TodoWrite entries are UI
    // state updates and never have a terminal result to recover.
    recoverToolStartTimesFromHistory(session);
    scheduleCodexToolResultWatchdogs(session, "restore_from_disk", deps);
    vi.advanceTimersByTime(1_000);

    expect(session.toolStartTimes.size).toBe(0);
    expect(session.toolResults.size).toBe(0);
    expect(session.messageHistory.filter((msg) => msg.type === "tool_result_preview")).toHaveLength(0);
    expect(broadcastToBrowsers).not.toHaveBeenCalled();
    expect(persistSession).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("still recovers and synthesizes restored unresolved Codex Bash starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const session = makeSession();
    session.toolStartTimes.clear();
    session.messageHistory = [];
    addPersistedToolUse(session, "cmd-restored", "Bash", 10_000, { command: "sleep 999" });
    const broadcastToBrowsers = vi.fn();
    const persistSession = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ broadcastToBrowsers, persistSession, codexToolResultWatchdogMs: 1_000 });

    // The planning-tool guard must not weaken real terminal recovery; old Bash
    // starts without a preview still need a browser-visible terminal placeholder.
    recoverToolStartTimesFromHistory(session);
    expect(session.toolStartTimes.get("cmd-restored")).toBe(10_000);
    scheduleCodexToolResultWatchdogs(session, "restore_from_disk", deps);
    vi.advanceTimersByTime(1_000);

    expect(broadcastToBrowsers).toHaveBeenCalledTimes(1);
    expect(persistSession).toHaveBeenCalledTimes(1);
    const previewMsg = session.messageHistory.find((msg) => msg.type === "tool_result_preview");
    expect(previewMsg?.type).toBe("tool_result_preview");
    if (previewMsg?.type === "tool_result_preview") {
      expect(previewMsg.previews[0]?.tool_use_id).toBe("cmd-restored");
      expect(previewMsg.previews[0]?.is_error).toBe(true);
    }
    expect(session.toolResults.has("cmd-restored")).toBe(true);
    expect(session.toolStartTimes.has("cmd-restored")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("restore_from_disk"));
    warnSpy.mockRestore();
  });

  it("treats existing persisted previews as resolved during restored start recovery", () => {
    const session = makeSession();
    session.toolStartTimes.clear();
    session.messageHistory = [];
    addPersistedToolUse(session, "cmd-resolved", "Bash", 10_000, { command: "echo done" });
    addPersistedToolResultPreview(session, "cmd-resolved");

    // Existing previews are the durable resolved marker; restore should not
    // schedule duplicate fallback previews for tools already represented in history.
    recoverToolStartTimesFromHistory(session);

    expect(session.toolStartTimes.has("cmd-resolved")).toBe(false);
  });

  it("uses the injected codex watchdog delay when scheduling tool-result recovery", () => {
    vi.useFakeTimers();
    const session = makeSession();
    const broadcastToBrowsers = vi.fn();
    const deps = makeDeps({ broadcastToBrowsers, codexToolResultWatchdogMs: 25 });

    scheduleCodexToolResultWatchdogs(session, "disconnect", deps);
    vi.advanceTimersByTime(24);
    expect(broadcastToBrowsers).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(broadcastToBrowsers).toHaveBeenCalledTimes(1);
  });

  it("does not synthesize a superseded Codex Bash preview before the watchdog window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const session = makeSession();
    session.messageHistory = [];
    session.toolStartTimes.clear();
    addBashToolUse(session, "older-tool", 9_500);
    addBashToolUse(session, "later-tool", 9_900);
    const broadcastToBrowsers = vi.fn();
    const deps = makeDeps({ broadcastToBrowsers, codexToolResultWatchdogMs: 1_000 });

    // A later tool result can arrive while an earlier command is still alive or
    // delayed; the superseded path must defer to the watchdog instead of creating
    // a false orphaned preview immediately.
    finalizeSupersededCodexTerminalTools(session, [9_900], deps);

    expect(broadcastToBrowsers).not.toHaveBeenCalled();
    expect(session.messageHistory.some((msg) => msg.type === "tool_result_preview")).toBe(false);
    expect(session.toolStartTimes.has("older-tool")).toBe(true);
  });

  it("synthesizes a superseded Codex Bash preview after the watchdog window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const session = makeSession();
    session.messageHistory = [];
    session.toolStartTimes.clear();
    addBashToolUse(session, "older-tool", 18_000);
    addBashToolUse(session, "later-tool", 19_900);
    const broadcastToBrowsers = vi.fn();
    const persistSession = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ broadcastToBrowsers, persistSession, codexToolResultWatchdogMs: 1_000 });

    // Once the older command has exceeded the normal recovery delay, a later
    // completed tool is enough evidence to finalize the missing preview.
    finalizeSupersededCodexTerminalTools(session, [19_900], deps);

    expect(broadcastToBrowsers).toHaveBeenCalledTimes(1);
    expect(persistSession).toHaveBeenCalledTimes(1);
    const previewMsg = session.messageHistory.find((msg) => msg.type === "tool_result_preview");
    expect(previewMsg?.type).toBe("tool_result_preview");
    if (previewMsg?.type === "tool_result_preview") {
      expect(previewMsg.previews[0]?.tool_use_id).toBe("older-tool");
      expect(previewMsg.previews[0]?.duration_seconds).toBe(2);
    }
    expect(session.toolStartTimes.has("older-tool")).toBe(false);
    expect(session.toolStartTimes.has("later-tool")).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ageMs=2000"));
    warnSpy.mockRestore();
  });
});
