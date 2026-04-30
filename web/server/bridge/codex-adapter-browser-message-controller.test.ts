import { describe, expect, it, vi } from "vitest";
import {
  handleCodexAdapterBrowserMessage,
  type CodexAdapterBrowserMessageDeps,
} from "./codex-adapter-browser-message-controller.js";
import type { BrowserIncomingMessage, ContentBlock } from "../session-types.js";

type TestCodexSession = {
  id: string;
  state: any;
  messageHistory: BrowserIncomingMessage[];
  toolStartTimes: Map<string, number>;
  toolProgressOutput: Map<string, string>;
  lastCliMessageAt?: number;
};

function makeSession(): TestCodexSession {
  return {
    id: "codex-leader",
    state: { isOrchestrator: true, backend_type: "codex" },
    messageHistory: [],
    toolStartTimes: new Map(),
    toolProgressOutput: new Map(),
  };
}

function makeAssistant(
  content: ContentBlock[],
  id = `codex-${Math.random().toString(36).slice(2)}`,
): BrowserIncomingMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    timestamp: 1,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function makeDeps(broadcasts: BrowserIncomingMessage[]): CodexAdapterBrowserMessageDeps {
  return {
    getCodexLeaderRecycleThresholdTokens: () => 0,
    getLauncherSessionInfo: () => null,
    touchActivity: vi.fn(),
    clearOptimisticRunningTimer: vi.fn(),
    setCodexImageSendStage: vi.fn(),
    sanitizeCodexSessionPatch: (patch) => patch,
    cacheSlashCommandState: vi.fn(),
    refreshGitInfoThenRecomputeDiff: vi.fn(),
    persistSession: vi.fn(),
    emitTakodeEvent: vi.fn(),
    freezeHistoryThroughCurrentTail: vi.fn(),
    injectCompactionRecovery: vi.fn(),
    trackCodexQuestCommands: vi.fn(),
    reconcileCodexQuestToolResult: vi.fn(async () => {}),
    collectCompletedToolStartTimes: () => [],
    buildToolResultPreviews: () => [],
    broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
    finalizeSupersededCodexTerminalTools: vi.fn(),
    isDuplicateCodexAssistantReplay: () => false,
    completeCodexTurnsForResult: () => true,
    clearCodexFreshTurnRequirement: vi.fn(),
    handleResultMessage: vi.fn(),
    queueCodexPendingStartBatch: vi.fn(),
    dispatchQueuedCodexTurns: vi.fn(),
    maybeFlushQueuedCodexMessages: vi.fn(),
    handleCodexPermissionRequest: vi.fn(),
    requestCodexLeaderRecycle: vi.fn(async () => ({ ok: true })),
  };
}

async function routeAssistantMessage(
  session: TestCodexSession,
  content: ContentBlock[],
  depsOverride: Partial<CodexAdapterBrowserMessageDeps> = {},
): Promise<BrowserIncomingMessage> {
  const broadcasts: BrowserIncomingMessage[] = [];
  await handleCodexAdapterBrowserMessage(session, makeAssistant(content), { ...makeDeps(broadcasts), ...depsOverride });
  expect(broadcasts).toHaveLength(1);
  return broadcasts[0];
}

describe("codex-adapter-browser-message-controller thread routing", () => {
  it("records and broadcasts Codex compaction lifecycle events from status changes", async () => {
    // Codex surfaces compaction through item lifecycle status changes; the
    // bridge should persist lifecycle telemetry without relying on chat history.
    const session = makeSession();
    session.state = {
      backend_type: "codex",
      context_used_percent: 90,
      codex_token_details: {
        contextTokensUsed: 270_000,
        inputTokens: 300_000,
        outputTokens: 10_000,
        cachedInputTokens: 30_000,
        reasoningOutputTokens: 5_000,
        modelContextWindow: 300_000,
      },
    };
    const broadcasts: BrowserIncomingMessage[] = [];
    const deps = makeDeps(broadcasts);

    await handleCodexAdapterBrowserMessage(session, { type: "status_change", status: "compacting" }, deps);

    expect(session.state.lifecycle_events).toEqual([
      expect.objectContaining({
        type: "compaction",
        before: expect.objectContaining({
          contextTokensUsed: 270_000,
          contextUsedPercent: 90,
          source: "codex_token_details",
        }),
      }),
    ]);
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: { lifecycle_events: session.state.lifecycle_events },
      }),
    );

    session.state.codex_token_details = {
      ...session.state.codex_token_details,
      contextTokensUsed: 42_000,
    };
    session.state.context_used_percent = 14;
    await handleCodexAdapterBrowserMessage(session, { type: "status_change", status: null }, deps);

    expect(session.state.lifecycle_events?.[0]).toMatchObject({
      after: {
        contextTokensUsed: 42_000,
        contextUsedPercent: 14,
        source: "codex_token_details",
      },
    });
  });

  it("strips leader thread text prefixes and persists quest thread metadata", async () => {
    // Codex uses a separate adapter path, so it needs direct coverage for the
    // persisted/broadcast message shape consumed by quest-thread UI filtering.
    const session = makeSession();

    const msg = await routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941]\nCodex routed update" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(msg.type === "assistant" ? msg.message.content : []).toMatchObject([
      { type: "text", text: "Codex routed update" },
    ]);
    expect(session.messageHistory[0]).toMatchObject(msg);
  });

  it("strips same-line leader thread prefixes and persists quest thread metadata", async () => {
    const session = makeSession();

    const msg = await routeAssistantMessage(session, [
      { type: "text", text: "[thread:q-941] Same-line Codex routed update" },
    ]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(msg.type === "assistant" ? msg.message.content : []).toMatchObject([
      { type: "text", text: "Same-line Codex routed update" },
    ]);
  });

  it("routes leader text when launcher info says orchestrator and session state has not caught up", async () => {
    const session = makeSession();
    delete session.state.isOrchestrator;

    const msg = await routeAssistantMessage(
      session,
      [{ type: "text", text: "[thread:q-966] Launcher-derived Codex route" }],
      { getLauncherSessionInfo: () => ({ isOrchestrator: true }) },
    );

    expect(session.state.isOrchestrator).toBe(true);
    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-966",
      questId: "q-966",
      threadRefs: [{ threadKey: "q-966", questId: "q-966", source: "explicit" }],
    });
    expect(msg.type === "assistant" ? msg.message.content : []).toMatchObject([
      { type: "text", text: "Launcher-derived Codex route" },
    ]);
  });

  it("preserves unrouted leader text and records missing prefix metadata", async () => {
    const session = makeSession();

    const msg = await routeAssistantMessage(session, [{ type: "text", text: "Unmarked Codex leader text" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadRoutingError: { reason: "missing", rawContent: "Unmarked Codex leader text" },
    });
    const content = msg.type === "assistant" ? msg.message.content : [];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "text", text: "Unmarked Codex leader text" });
  });

  it("strips Bash command thread comments and persists command thread metadata", async () => {
    const session = makeSession();

    const msg = await routeAssistantMessage(session, [
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:q-941\npwd" } },
    ]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    const block = msg.type === "assistant" ? msg.message.content[0] : null;
    expect(block).toMatchObject({ type: "tool_use", input: { command: "pwd" } });
  });

  it("does not track Codex plan TodoWrite tool uses for result recovery", async () => {
    const session = makeSession();

    await routeAssistantMessage(session, [
      {
        type: "tool_use",
        id: "codex-plan-live-1",
        name: "TodoWrite",
        input: { todos: [{ content: "Inspect", status: "in_progress" }] },
      },
      { type: "tool_use", id: "cmd-live-1", name: "Bash", input: { command: "pwd" } },
    ]);

    // Codex plan updates are rendered through TodoWrite for UI state, but they
    // never produce tool_result messages. Real terminal tools still need timers.
    expect(session.toolStartTimes.has("codex-plan-live-1")).toBe(false);
    expect(session.toolStartTimes.has("cmd-live-1")).toBe(true);
  });
});
