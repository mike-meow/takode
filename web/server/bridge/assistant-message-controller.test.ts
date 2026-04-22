import { describe, expect, it } from "vitest";
import {
  extractActivityPreview,
  getAssistantContentAppendBlocks,
  type AssistantMessageSessionLike,
} from "./assistant-message-controller.js";

function makeSession(): AssistantMessageSessionLike {
  return {
    backendType: "claude",
    cliResuming: false,
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
});
