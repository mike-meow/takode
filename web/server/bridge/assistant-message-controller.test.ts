import { describe, expect, it } from "vitest";
import {
  extractActivityPreview,
  getAssistantContentAppendBlocks,
  handleAssistantMessage,
  handleAssistantMessageWithRuntime,
  type AssistantMessageSessionLike,
} from "./claude-message-controller.js";
import type { BrowserIncomingMessage, CLIAssistantMessage, ContentBlock } from "../session-types.js";

function makeSession(): AssistantMessageSessionLike {
  return {
    id: "s-assistant",
    backendType: "claude",
    cliResuming: false,
    dropReplayHistoryAfterRevert: false,
    isGenerating: false,
    messageHistory: [],
    assistantAccumulator: new Map(),
    toolStartTimes: new Map(),
    toolProgressOutput: new Map(),
    diffStatsDirty: false,
    lastActivityPreview: undefined,
    state: {
      model: "claude-sonnet-4-5-20250929",
      context_used_percent: 0,
    },
  };
}

function makeAssistant(
  content: ContentBlock[],
  id = `assistant-${Math.random().toString(36).slice(2)}`,
): CLIAssistantMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: `${id}-uuid`,
    session_id: "s-assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function routeAssistantMessage(
  session: AssistantMessageSessionLike,
  content: ContentBlock[],
  overrides: Partial<Parameters<typeof handleAssistantMessage>[2]> = {},
): BrowserIncomingMessage {
  const broadcasts: BrowserIncomingMessage[] = [];
  handleAssistantMessage(session, makeAssistant(content), {
    hasAssistantReplay: () => false,
    getLauncherSessionInfo: () => null,
    broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
    persistSession: () => {},
    ...overrides,
  });
  expect(broadcasts).toHaveLength(1);
  return broadcasts[0];
}

describe("assistant-message-controller", () => {
  // Validates that replayed assistant snapshots only append genuinely new blocks
  // and do not re-emit previously-seen tool_use IDs when the same message arrives in parts.
  it("appends only novel assistant content blocks after overlap while deduping repeated tool_use ids", () => {
    const seenToolUseIds = new Set(["tool-1"]);
    const append = getAssistantContentAppendBlocks(
      [
        { type: "text", text: "alpha" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
      ] as any,
      [
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        { type: "text", text: "beta" },
        { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "a.ts" } },
      ] as any,
      seenToolUseIds,
    );

    expect(append).toEqual([
      { type: "text", text: "beta" },
      { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "a.ts" } },
    ]);
    expect(seenToolUseIds.has("tool-2")).toBe(true);
  });

  // Covers the two supported task-preview sources so push-notification context
  // stays aligned whether the assistant emitted TodoWrite or TaskUpdate blocks.
  it("extracts the active preview from TodoWrite and TaskUpdate tool_use blocks", () => {
    const session = makeSession();

    extractActivityPreview(session, [
      {
        type: "tool_use",
        name: "TodoWrite",
        input: {
          todos: [
            { status: "pending", content: "later" },
            { status: "in_progress", activeForm: "Reviewing the merged assistant payload" },
          ],
        },
      },
    ]);
    expect(session.lastActivityPreview).toBe("Reviewing the merged assistant payload");

    extractActivityPreview(session, [
      {
        type: "tool_use",
        name: "TaskUpdate",
        input: {
          status: "in_progress",
          activeForm: "Finishing the next ws-bridge controller slice",
        },
      },
    ]);
    expect(session.lastActivityPreview).toBe("Finishing the next ws-bridge controller slice");
  });

  it("notifies runtime deps only for newly observed tool_use blocks", () => {
    const session = makeSession();
    const observed: string[] = [];
    const deps = {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: () => {},
      persistSession: () => {},
      setGenerating: () => {},
      broadcastStatusRunning: () => {},
      onToolUseObserved: (_session: AssistantMessageSessionLike, block: { id?: string }) => {
        if (block.id) observed.push(block.id);
      },
    };

    handleAssistantMessageWithRuntime(
      session,
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "assistant-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep 61" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      } as any,
      deps,
    );

    handleAssistantMessageWithRuntime(
      session,
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "assistant-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep 61" } },
            { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "a.ts" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      } as any,
      deps,
    );

    expect(observed).toEqual(["tool-1", "tool-2"]);
  });

  it("drops id-less assistant replay while post-revert replay suppression is active", () => {
    const session = makeSession();
    session.cliResuming = true;
    session.dropReplayHistoryAfterRevert = true;
    const deps = {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: () => {},
      persistSession: () => {},
      setGenerating: () => {},
      broadcastStatusRunning: () => {},
      onToolUseObserved: () => {},
    };

    handleAssistantMessageWithRuntime(
      session,
      {
        type: "assistant",
        uuid: "sdk-replayed-no-id",
        parent_tool_use_id: null,
        message: {
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "stale replayed assistant" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      } as any,
      deps,
    );

    expect(session.messageHistory).toHaveLength(0);
  });

  it("strips leader thread text prefixes and persists quest thread metadata", () => {
    // The controller path, not only the parser, must store the routed body and
    // metadata that drive quest-thread projections in the UI.
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941]\nRouted update" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(msg.type === "assistant" ? msg.message.content : []).toMatchObject([
      { type: "text", text: "Routed update" },
    ]);
    expect(session.messageHistory[0]).toMatchObject(msg);
  });

  it("strips same-line leader thread prefixes and persists quest thread metadata", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941] Same-line routed update" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(msg.type === "assistant" ? msg.message.content : []).toMatchObject([
      { type: "text", text: "Same-line routed update" },
    ]);
  });

  it("routes leader text when launcher info says orchestrator and session state has not caught up", () => {
    const session = makeSession();
    delete session.state.isOrchestrator;

    const msg = routeAssistantMessage(
      session,
      [{ type: "text", text: "[thread:q-966] Launcher-derived Claude route" }],
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
      { type: "text", text: "Launcher-derived Claude route" },
    ]);
  });

  it("preserves unrouted leader text and records missing prefix metadata", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [{ type: "text", text: "Unmarked leader text" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadRoutingError: { reason: "missing", rawContent: "Unmarked leader text" },
    });
    const content = msg.type === "assistant" ? msg.message.content : [];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "text", text: "Unmarked leader text" });
  });

  it("preserves unrouted leader text and records invalid prefix metadata", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [{ type: "text", text: "[thread:side]\nWrong marker" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadRoutingError: { reason: "invalid", marker: "[thread:side]" },
    });
    const content = msg.type === "assistant" ? msg.message.content : [];
    expect(content[0].type === "text" ? content[0].text : "").toBe("[thread:side]\nWrong marker");
  });

  it("strips Bash command thread comments and persists command thread metadata", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [
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
});
