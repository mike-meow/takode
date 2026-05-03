import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, ContentBlock, SessionState } from "./session-types.js";
import { CODEX_LOCAL_SLASH_COMMANDS } from "../shared/codex-slash-commands.js";

/** Minimal event-loop yield so the ReadableStream reader can process chunks.
 *  Replaces the original 20-50ms setTimeout calls — 1ms is sufficient. */
const tick = () => new Promise<void>((r) => setTimeout(r, 1));

// ─── Mock Subprocess ──────────────────────────────────────────────────────────

class MockWritableStream {
  chunks: string[] = [];
  private writer = {
    write: async (chunk: Uint8Array) => {
      this.chunks.push(new TextDecoder().decode(chunk));
    },
    releaseLock: () => {},
  };
  getWriter() {
    return this.writer;
  }
}

class MockReadableStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly stream: ReadableStream<Uint8Array>;

  constructor() {
    this.stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  push(data: string) {
    this.controller?.enqueue(new TextEncoder().encode(data));
  }

  close() {
    this.controller?.close();
  }
}

function createMockProcess() {
  const stdinStream = new MockWritableStream();
  const stdoutReadable = new MockReadableStream();
  const stderrReadable = new MockReadableStream();

  let resolveExit: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const proc = {
    stdin: stdinStream,
    stdout: stdoutReadable.stream,
    stderr: stderrReadable.stream,
    pid: 12345,
    exited: exitPromise,
    kill: vi.fn(),
  };

  return { proc, stdin: stdinStream, stdout: stdoutReadable, stderr: stderrReadable };
}

async function initializeAdapter(stdout: MockReadableStream) {
  stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
  await tick();
  stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
  await tick();
}

function parseWrittenJsonLines(chunks: string[]): any[] {
  return chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getToolResultBlocks(
  messages: BrowserIncomingMessage[],
  toolUseId?: string,
): Extract<ContentBlock, { type: "tool_result" }>[] {
  const blocks: Extract<ContentBlock, { type: "tool_result" }>[] = [];
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    for (const block of msg.message.content) {
      if (block.type !== "tool_result") continue;
      if (toolUseId && block.tool_use_id !== toolUseId) continue;
      blocks.push(block);
    }
  }
  return blocks;
}

function getToolUseBlocks(
  messages: BrowserIncomingMessage[],
  toolName?: string,
): Extract<ContentBlock, { type: "tool_use" }>[] {
  const blocks: Extract<ContentBlock, { type: "tool_use" }>[] = [];
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    for (const block of msg.message.content) {
      if (block.type !== "tool_use") continue;
      if (toolName && block.name !== toolName) continue;
      blocks.push(block);
    }
  }
  return blocks;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CodexAdapter", () => {
  let proc: ReturnType<typeof createMockProcess>["proc"];
  let stdin: MockWritableStream;
  let stdout: MockReadableStream;

  beforeEach(() => {
    const mock = createMockProcess();
    proc = mock.proc;
    stdin = mock.stdin;
    stdout = mock.stdout;
  });

  it("sends approval response when receiving permission_response", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    // Complete initialization
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Simulate approval request
    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/requestApproval",
        id: 100,
        params: {
          itemId: "item_cmd_1",
          command: ["npm", "test"],
          parsedCmd: "npm test",
        },
      }) + "\n",
    );
    await tick();

    // Get the generated request_id
    const permRequest = messages.find((m) => m.type === "permission_request") as { request: { request_id: string } };
    expect(permRequest).toBeDefined();

    // Clear stdin to check response
    stdin.chunks = [];

    // Send approval
    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: permRequest.request.request_id,
      behavior: "allow",
    });

    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"decision":"accept"');
    expect(allWritten).toContain('"id":100');
  });

  it("sends decline response when permission is denied", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/requestApproval",
        id: 200,
        params: { itemId: "item_cmd_2", command: ["rm", "-rf", "/"], parsedCmd: "rm -rf /" },
      }) + "\n",
    );
    await tick();

    const permRequest = messages.find((m) => m.type === "permission_request") as { request: { request_id: string } };
    stdin.chunks = [];

    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: permRequest.request.request_id,
      behavior: "deny",
    });

    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"decision":"decline"');
    expect(allWritten).toContain('"id":200');
  });

  it("includes tool_start_times in tool_use assistant messages for live timers", async () => {
    // Regression: Codex tool chips showed no ticking timer because tool_start_times
    // was missing from the emitted assistant message.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "commandExecution", id: "cmd_timer", command: ["echo", "hi"], status: "inProgress" },
        },
      }) + "\n",
    );
    await tick();

    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "cmd_timer");
    });
    expect(toolUseMsg).toBeDefined();

    const startTimes = (toolUseMsg as { tool_start_times?: Record<string, number> }).tool_start_times;
    expect(startTimes).toBeDefined();
    expect(startTimes!["cmd_timer"]).toBeTypeOf("number");
    expect(startTimes!["cmd_timer"]).toBeGreaterThan(0);
  });

  it("translates fileChange item to Edit/Write tool_use", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // fileChange with "create" kind → Write tool
    // item/started without diff is deferred; item/completed provides the diff.
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "fileChange",
            id: "fc_1",
            changes: [{ path: "/tmp/new-file.ts", kind: "create" }],
            status: "inProgress",
          },
        },
      }) + "\n",
    );
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "fc_1",
            changes: [{ path: "/tmp/new-file.ts", kind: "create", diff: "+new content" }],
            status: "completed",
          },
        },
      }) + "\n",
    );

    await tick();

    const assistantMsgs = messages.filter((m) => m.type === "assistant");
    const writeMsg = assistantMsgs.find((m) => {
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Write");
    });
    expect(writeMsg).toBeDefined();

    // fileChange with "add" kind should also normalize to Write tool
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "fc_add",
            changes: [{ path: "/tmp/added.ts", kind: "add", diff: "+export const added = true;\n" }],
            status: "completed",
          },
        },
      }) + "\n",
    );

    await tick();

    const addWriteMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (
          m as {
            message: { content: Array<{ type: string; id?: string; name?: string; input?: { file_path?: string } }> };
          }
        ).message.content;
        return content.some(
          (b) =>
            b.type === "tool_use" && b.id === "fc_add" && b.name === "Write" && b.input?.file_path === "/tmp/added.ts",
        );
      });
    expect(addWriteMsg).toBeDefined();

    // fileChange with "modify" kind → Edit tool
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "fileChange",
            id: "fc_2",
            changes: [{ path: "/tmp/existing.ts", kind: "modify" }],
            status: "inProgress",
          },
        },
      }) + "\n",
    );
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "fc_2",
            changes: [{ path: "/tmp/existing.ts", kind: "modify", diff: "@@ -1 +1 @@\n-old\n+new" }],
            status: "completed",
          },
        },
      }) + "\n",
    );

    await tick();

    const editMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_use" && b.name === "Edit");
      });
    expect(editMsg).toBeDefined();
  });

  it("passes fileChange patch text through to Edit tool input when available", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "fileChange",
            id: "fc_patch",
            changes: [
              {
                path: "/tmp/existing.ts",
                kind: "modify",
                diff: "diff --git a/existing.ts b/existing.ts\n--- a/existing.ts\n+++ b/existing.ts\n@@ -1 +1 @@\n-old\n+new",
              },
            ],
            status: "inProgress",
          },
        },
      }) + "\n",
    );

    await tick();

    const assistant = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Edit");
    });
    expect(assistant).toBeDefined();

    const toolUse = (
      assistant as {
        message: { content: Array<{ type: string; name?: string; input?: { changes?: Array<{ diff?: string }> } }> };
      }
    ).message.content.find((b) => b.type === "tool_use" && b.name === "Edit");

    expect(toolUse?.input?.changes?.[0]?.diff).toContain("@@ -1 +1 @@");
  });

  it("uses patch_apply_begin diffs when fileChange started payload is empty", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "codex/event/patch_apply_begin",
        params: {
          msg: {
            type: "patch_apply_begin",
            call_id: "fc_patch_begin",
            changes: {
              "/tmp/from-patch.ts": {
                type: "update",
                unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
              },
            },
          },
        },
      }) + "\n",
    );

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "fileChange",
            id: "fc_patch_begin",
            changes: [],
            status: "inProgress",
          },
        },
      }) + "\n",
    );

    await tick();

    const assistant = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string; name?: string }> } }).message
        .content;
      return content.some((b) => b.type === "tool_use" && b.id === "fc_patch_begin" && b.name === "Edit");
    });
    expect(assistant).toBeDefined();

    const toolUse = (
      assistant as {
        message: {
          content: Array<{
            type: string;
            id?: string;
            name?: string;
            input?: { file_path?: string; changes?: Array<{ diff?: string }> };
          }>;
        };
      }
    ).message.content.find((b) => b.type === "tool_use" && b.id === "fc_patch_begin");
    expect(toolUse?.input?.file_path).toBe("/tmp/from-patch.ts");
    expect(toolUse?.input?.changes?.[0]?.diff).toContain("@@ -1 +1 @@");
  });

  it("defers empty fileChange start until completed payload provides diff", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "fileChange",
            id: "fc_late_diff",
            changes: [],
            status: "inProgress",
          },
        },
      }) + "\n",
    );
    await tick();

    const earlyToolUse = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "fc_late_diff");
    });
    expect(earlyToolUse).toBeUndefined();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "fc_late_diff",
            changes: [
              {
                path: "/tmp/later.ts",
                kind: "modify",
                diff: "@@ -1 +1 @@\n-old\n+new\n",
              },
            ],
            status: "completed",
          },
        },
      }) + "\n",
    );
    await tick();

    const toolUseAfterComplete = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (
        m as {
          message: {
            content: Array<{
              type: string;
              id?: string;
              name?: string;
              input?: { changes?: Array<{ diff?: string }> };
            }>;
          };
        }
      ).message.content;
      return content.some(
        (b) => b.type === "tool_use" && b.id === "fc_late_diff" && b.name === "Edit" && !!b.input?.changes?.[0]?.diff,
      );
    });
    expect(toolUseAfterComplete).toBeDefined();
  });

  it("defers fileChange with path/kind but no diff until completed provides diff", async () => {
    // Regression: item/started with changes containing path/kind but no diff field
    // was emitted immediately, causing ToolBlock to show "No changes".
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // item/started with path and kind, but NO diff
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "fileChange",
            id: "fc_no_diff",
            changes: [{ path: "/tmp/nodiff.ts", kind: "modify" }],
            status: "inProgress",
          },
        },
      }) + "\n",
    );
    await tick();

    // tool_use should NOT have been emitted yet (no diff data)
    const earlyToolUse = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "fc_no_diff");
    });
    expect(earlyToolUse).toBeUndefined();

    // item/completed with actual diff
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "fc_no_diff",
            changes: [
              {
                path: "/tmp/nodiff.ts",
                kind: "modify",
                diff: "@@ -1 +1 @@\n-before\n+after\n",
              },
            ],
            status: "completed",
          },
        },
      }) + "\n",
    );
    await tick();

    // Now tool_use should exist with the diff from completed
    const toolUse = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (
        m as {
          message: {
            content: Array<{
              type: string;
              id?: string;
              name?: string;
              input?: { changes?: Array<{ diff?: string }> };
            }>;
          };
        }
      ).message.content;
      return content.some(
        (b) => b.type === "tool_use" && b.id === "fc_no_diff" && b.name === "Edit" && !!b.input?.changes?.[0]?.diff,
      );
    });
    expect(toolUse).toBeDefined();
  });

  it("suppresses fileChange tool_use when completed payload still has no renderable diff or content", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "fc_unrenderable",
            changes: [{ path: "/tmp/placeholder.ts", kind: "add" }],
            status: "completed",
          },
        },
      }) + "\n",
    );
    await tick();

    const fileChangeMessages = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string; tool_use_id?: string }> } })
        .message.content;
      return content.some(
        (block) =>
          (block.type === "tool_use" && block.id === "fc_unrenderable") ||
          (block.type === "tool_result" && block.tool_use_id === "fc_unrenderable"),
      );
    });
    expect(fileChangeMessages).toHaveLength(0);
  });

  it("sends turn/interrupt on interrupt message", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();
    // Respond to account/rateLimits/read (id: 3, fired after init)
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    // Send a user message first to establish a turn
    adapter.sendBrowserMessage({ type: "user_message", content: "Do something" });
    await tick();

    // Simulate turn/start response (provides a turn ID — id bumped to 4 due to rateLimits/read)
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_1" } } }) + "\n");
    await tick();

    stdin.chunks = [];

    adapter.sendBrowserMessage({ type: "interrupt" });
    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"method":"turn/interrupt"');
    expect(allWritten).toContain("thr_123");
    expect(allWritten).toContain("turn_1");
  });

  it("translates error turn/completed to error result", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: { id: "turn_1", status: "failed", error: { message: "Rate limit exceeded" } },
        },
      }) + "\n",
    );

    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results.length).toBe(1);

    const result = results[0] as { data: { is_error: boolean; subtype: string; result: string } };
    expect(result.data.is_error).toBe(true);
    expect(result.data.subtype).toBe("error_during_execution");
    expect(result.data.result).toBe("Rate limit exceeded");
  });

  it("renders tool-router errors as failed tool results and clears the turn on idle fallback", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Apply a patch" });
    await tick();

    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_router_error" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "tool_apply_patch",
            type: "commandExecution",
            command: ["apply_patch"],
          },
        },
      }) + "\n",
    );
    await tick();

    const errorMessage =
      "apply_patch verification failed: Failed to find expected lines in /workspace/file.ts:\nexpected line";
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: errorMessage } },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thr_123", status: { type: "idle" } },
      }) + "\n",
    );
    await tick();

    const toolResult = messages.find(
      (msg): msg is Extract<BrowserIncomingMessage, { type: "assistant" }> =>
        msg.type === "assistant" &&
        msg.message.content.some((block) => block.type === "tool_result" && block.tool_use_id === "tool_apply_patch"),
    );
    const toolResultBlock = (toolResult?.message.content ?? []).find((block) => block.type === "tool_result");
    if (!toolResultBlock || toolResultBlock.type !== "tool_result") {
      throw new Error("missing failed tool result");
    }
    expect(toolResultBlock?.is_error).toBe(true);
    expect(toolResultBlock?.content).toContain("apply_patch verification failed");

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { data: { is_error: boolean; result: string; codex_turn_id?: string } };
    expect(result.data.is_error).toBe(true);
    expect(result.data.result).toContain("apply_patch verification failed");
    expect(result.data.codex_turn_id).toBe("turn_router_error");
    expect(adapter.getCurrentTurnId()).toBeNull();

    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: { id: "turn_router_error", status: "failed", error: { message: "duplicate terminal error" } },
        },
      }) + "\n",
    );
    await tick();

    expect(messages.filter((m) => m.type === "result")).toHaveLength(1);
  });

  it("renders write_stdin router errors as failed write_stdin tool results", async () => {
    // q-1073: terminal interactions are rendered as write_stdin tool calls.
    // If Codex later reports the corresponding process id as gone, close a
    // write_stdin call as failed instead of misattributing the router error to
    // the parent Bash command.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Poll a terminal" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_write_stdin_router_error" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "cmd_live",
            type: "commandExecution",
            command: ["sleep", "20"],
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/terminalInteraction",
        params: {
          itemId: "cmd_live",
          processId: "13506",
          stdin: "",
        },
      }) + "\n",
    );
    await tick();

    const errorMessage = "write_stdin failed: Unknown process id 13506";
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: errorMessage } },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: errorMessage } },
      }) + "\n",
    );
    await tick();

    const failedWriteStdinResults = getToolResultBlocks(messages).filter(
      (block) => block.is_error === true && typeof block.content === "string" && block.content.includes(errorMessage),
    );
    expect(failedWriteStdinResults).toHaveLength(1);

    const failedWriteStdinUse = getToolUseBlocks(messages, "write_stdin").find(
      (block) => block.id === failedWriteStdinResults[0]?.tool_use_id,
    );
    expect(failedWriteStdinUse).toBeDefined();
    expect(failedWriteStdinUse?.input).toMatchObject({ session_id: "13506", chars: "" });
    expect(getToolResultBlocks(messages, "cmd_live").some((block) => block.is_error)).toBe(false);
    expect(messages.some((msg) => msg.type === "error" && msg.message === errorMessage)).toBe(false);

    stdout.push(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thr_123", status: { type: "idle" } },
      }) + "\n",
    );
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { data: { is_error: boolean; result?: string; codex_turn_id?: string } };
    expect(result.data.is_error).toBe(false);
    expect(result.data.result).toBeUndefined();
    expect(result.data.codex_turn_id).toBe("turn_write_stdin_router_error");
    expect(adapter.getCurrentTurnId()).toBeNull();

    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: { id: "turn_write_stdin_router_error", status: "failed", error: { message: errorMessage } },
        },
      }) + "\n",
    );
    await tick();

    expect(messages.filter((m) => m.type === "result")).toHaveLength(1);
  });

  it("surfaces a different completion error after handled write_stdin idle cleanup", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Poll a terminal" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_write_stdin_then_real_error" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "cmd_live_real_error",
            type: "commandExecution",
            command: ["sleep", "20"],
          },
        },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/terminalInteraction",
        params: {
          itemId: "cmd_live_real_error",
          processId: "13506",
          stdin: "",
        },
      }) + "\n",
    );
    await tick();

    const routerErrorMessage = "write_stdin failed: Unknown process id 13506";
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: routerErrorMessage } },
      }) + "\n",
    );
    await tick();

    expect(
      getToolResultBlocks(messages).some(
        (block) =>
          block.is_error === true && typeof block.content === "string" && block.content.includes(routerErrorMessage),
      ),
    ).toBe(true);

    stdout.push(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thr_123", status: { type: "idle" } },
      }) + "\n",
    );
    await tick();

    const cleanupResults = messages.filter((m) => m.type === "result");
    expect(cleanupResults).toHaveLength(1);
    expect((cleanupResults[0] as { data: { is_error: boolean } }).data.is_error).toBe(false);

    const realErrorMessage = "Codex turn failed after terminal router drift";
    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: {
            id: "turn_write_stdin_then_real_error",
            status: "failed",
            error: { message: realErrorMessage },
          },
        },
      }) + "\n",
    );
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(2);
    const realErrorResult = results[1] as { data: { is_error: boolean; result?: string; codex_turn_id?: string } };
    expect(realErrorResult.data.is_error).toBe(true);
    expect(realErrorResult.data.result).toBe(realErrorMessage);
    expect(realErrorResult.data.codex_turn_id).toBe("turn_write_stdin_then_real_error");
  });

  it("renders unmatched write_stdin router errors as non-disruptive diagnostic tool results", async () => {
    // A write_stdin router failure is only specific enough to close a
    // write_stdin tool when the adapter has seen a terminal interaction for
    // that process id. Otherwise keep it visible as an unparented write_stdin
    // diagnostic without failing the parent Bash command or the whole turn.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Run a terminal command" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_unmatched_write_stdin_error" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "cmd_without_terminal_poll",
            type: "commandExecution",
            command: ["sleep", "20"],
          },
        },
      }) + "\n",
    );
    await tick();

    const errorMessage = "write_stdin failed: Unknown process id 24680";
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: errorMessage } },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: errorMessage } },
      }) + "\n",
    );
    await tick();

    expect(getToolResultBlocks(messages, "cmd_without_terminal_poll")).toHaveLength(0);
    const failedWriteStdinResults = getToolResultBlocks(messages).filter(
      (block) => block.is_error === true && typeof block.content === "string" && block.content.includes(errorMessage),
    );
    expect(failedWriteStdinResults).toHaveLength(1);
    const failedWriteStdinUse = getToolUseBlocks(messages, "write_stdin").find(
      (block) => block.id === failedWriteStdinResults[0]?.tool_use_id,
    );
    expect(failedWriteStdinUse?.input).toMatchObject({ session_id: "24680", chars: "" });
    expect(messages.some((msg) => msg.type === "error" && msg.message === errorMessage)).toBe(false);

    stdout.push(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thr_123", status: { type: "idle" } },
      }) + "\n",
    );
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { data: { is_error: boolean; result?: string; codex_turn_id?: string } };
    expect(result.data.is_error).toBe(false);
    expect(result.data.result).toBeUndefined();
    expect(result.data.codex_turn_id).toBe("turn_unmatched_write_stdin_error");
    expect(adapter.getCurrentTurnId()).toBeNull();

    const turnStartsBefore = parseWrittenJsonLines(stdin.chunks).filter((line) => line.method === "turn/start").length;
    adapter.sendBrowserMessage({ type: "user_message", content: "recover after diagnostic" });
    await tick();
    const turnStartsAfter = parseWrittenJsonLines(stdin.chunks).filter((line) => line.method === "turn/start").length;
    expect(turnStartsAfter).toBe(turnStartsBefore + 1);
  });

  it("does not attach stale write_stdin router errors after the command completed", async () => {
    // Once the parent command is complete, a later Unknown process id message
    // is stale context. It should not reopen or fail the earlier write_stdin UI
    // entry, but it should still render as non-disruptive write_stdin output.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Run and finish a terminal command" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_stale_write_stdin_error" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "cmd_finished",
            type: "commandExecution",
            command: ["sleep", "1"],
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/terminalInteraction",
        params: {
          itemId: "cmd_finished",
          processId: "13506",
          stdin: "",
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "cmd_finished",
            type: "commandExecution",
            command: ["sleep", "1"],
            status: "completed",
            exitCode: 0,
          },
        },
      }) + "\n",
    );
    await tick();

    const errorMessage = "write_stdin failed: Unknown process id 13506";
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: errorMessage } },
      }) + "\n",
    );
    await tick();

    const failedWriteStdinResults = getToolResultBlocks(messages).filter(
      (block) => block.is_error === true && typeof block.content === "string" && block.content.includes(errorMessage),
    );
    expect(failedWriteStdinResults).toHaveLength(1);
    const failedWriteStdinUse = getToolUseBlocks(messages, "write_stdin").find(
      (block) => block.id === failedWriteStdinResults[0]?.tool_use_id,
    );
    expect(failedWriteStdinUse?.input).toMatchObject({ session_id: "13506", chars: "" });
    expect(messages.some((msg) => msg.type === "error" && msg.message === errorMessage)).toBe(false);

    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: { id: "turn_stale_write_stdin_error", status: "failed", error: { message: errorMessage } },
        },
      }) + "\n",
    );
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { data: { is_error: boolean; result?: string; codex_turn_id?: string } };
    expect(result.data.is_error).toBe(false);
    expect(result.data.result).toBeUndefined();
    expect(result.data.codex_turn_id).toBe("turn_stale_write_stdin_error");
  });

  it("renders stderr-only closed-stdin router failures as failed write_stdin results", async () => {
    // q-1073 feedback #6: this production failure surfaced as Codex process
    // stderr, not a confirmed codex/event/error notification. Keep stderr
    // logging intact, but also route the narrow tool-router write_stdin failure
    // through normal failed tool output when there is one active terminal
    // command to attach it to.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Poll a closed stdin terminal" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_closed_stdin_stderr" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "cmd_closed_stdin",
            type: "commandExecution",
            command: ["bun", "test"],
          },
        },
      }) + "\n",
    );
    await tick();

    const errorMessage =
      "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open";
    adapter.handleProcessStderr(`2026-05-02T19:19:37.348471Z ERROR codex_core::tools::router: error=${errorMessage}\n`);
    await tick();

    const failedWriteStdinResults = getToolResultBlocks(messages).filter(
      (block) => block.is_error === true && typeof block.content === "string" && block.content.includes(errorMessage),
    );
    expect(failedWriteStdinResults).toHaveLength(1);

    const failedWriteStdinUse = getToolUseBlocks(messages, "write_stdin").find(
      (block) => block.id === failedWriteStdinResults[0]?.tool_use_id,
    );
    expect(failedWriteStdinUse).toBeDefined();
    expect(failedWriteStdinUse?.input).toMatchObject({ session_id: "", chars: "" });
    expect(getToolResultBlocks(messages, "cmd_closed_stdin").some((block) => block.is_error)).toBe(false);
    expect(messages.some((msg) => msg.type === "error" && msg.message === errorMessage)).toBe(false);

    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: { id: "turn_closed_stdin_stderr", status: "failed", error: { message: errorMessage } },
        },
      }) + "\n",
    );
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { data: { is_error: boolean; result?: string; codex_turn_id?: string } };
    expect(result.data.is_error).toBe(false);
    expect(result.data.result).toBeUndefined();
    expect(result.data.codex_turn_id).toBe("turn_closed_stdin_stderr");
    expect(adapter.getCurrentTurnId()).toBeNull();
  });

  it("buffers stderr router failures split before the write_stdin error field", async () => {
    // Stderr stream chunks are not line-delivery boundaries. A router record
    // split before the error field should be reconstructed before parsing.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Poll a closed stdin terminal" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_closed_stdin_split_before_error" } } }) + "\n");
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { id: "cmd_split_before_error", type: "commandExecution", command: ["bun", "test"] } },
      }) + "\n",
    );
    await tick();

    const errorMessage =
      "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open";
    adapter.handleProcessStderr("2026-05-02T19:19:37.348471Z ERROR codex_core::tools::router: ");
    await tick();
    expect(getToolUseBlocks(messages, "write_stdin")).toHaveLength(0);

    adapter.handleProcessStderr(`error=${errorMessage}\n`);
    await tick();

    const failedWriteStdinResults = getToolResultBlocks(messages).filter(
      (block) => block.is_error === true && typeof block.content === "string" && block.content.includes(errorMessage),
    );
    expect(failedWriteStdinResults).toHaveLength(1);
    expect(messages.some((msg) => msg.type === "error" && msg.message === errorMessage)).toBe(false);
  });

  it("buffers stderr router failures split inside the closed-stdin message", async () => {
    // Do not emit a truncated failed write_stdin result when the stream splits
    // inside "stdin is closed for this session"; parse only after newline.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Poll a closed stdin terminal" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_closed_stdin_split_inside" } } }) + "\n");
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { id: "cmd_split_inside", type: "commandExecution", command: ["bun", "test"] } },
      }) + "\n",
    );
    await tick();

    const errorMessage =
      "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open";
    const fullLine = `2026-05-02T19:19:37.348471Z ERROR codex_core::tools::router: error=${errorMessage}\n`;
    const splitAt = fullLine.indexOf("session;") + "sess".length;
    adapter.handleProcessStderr(fullLine.slice(0, splitAt));
    await tick();
    expect(
      getToolResultBlocks(messages).some(
        (block) => block.is_error === true && typeof block.content === "string" && block.content.includes("stdin is"),
      ),
    ).toBe(false);

    adapter.handleProcessStderr(fullLine.slice(splitAt));
    await tick();

    const failedWriteStdinResults = getToolResultBlocks(messages).filter(
      (block) => block.is_error === true && typeof block.content === "string" && block.content === errorMessage,
    );
    expect(failedWriteStdinResults).toHaveLength(1);
  });

  it("does not attach closed-stdin stderr router failures when multiple real tools are active", async () => {
    // Without a process id, the closed-stdin stderr fallback is intentionally
    // narrower than the generic router-error path: if more than one real tool
    // is active, keep the error visible as an unparented diagnostic without
    // guessing a write_stdin parent.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Run overlapping tools" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_closed_stdin_multi_tool" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "cmd_closed_stdin_overlap",
            type: "commandExecution",
            command: ["sleep", "20"],
          },
        },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "web_search_overlap",
            type: "webSearch",
            query: "router failure",
          },
        },
      }) + "\n",
    );
    await tick();

    const errorMessage =
      "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open";
    adapter.handleProcessStderr(`ERROR codex_core::tools::router: error=${errorMessage}\n`);
    await tick();

    expect(getToolResultBlocks(messages, "cmd_closed_stdin_overlap")).toHaveLength(0);
    const failedWriteStdinResults = getToolResultBlocks(messages).filter(
      (block) => block.is_error === true && typeof block.content === "string" && block.content.includes(errorMessage),
    );
    expect(failedWriteStdinResults).toHaveLength(1);
    const failedWriteStdinUse = getToolUseBlocks(messages, "write_stdin").find(
      (block) => block.id === failedWriteStdinResults[0]?.tool_use_id,
    );
    expect(failedWriteStdinUse?.input).toMatchObject({ session_id: "", chars: "" });
    expect(messages.some((msg) => msg.type === "error" && msg.message === errorMessage)).toBe(false);

    stdout.push(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thr_123", status: { type: "idle" } },
      }) + "\n",
    );
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { data: { is_error: boolean; result?: string; codex_turn_id?: string } };
    expect(result.data.is_error).toBe(false);
    expect(result.data.result).toBeUndefined();
    expect(result.data.codex_turn_id).toBe("turn_closed_stdin_multi_tool");
  });

  it("ignores non-write_stdin Codex stderr router failures", async () => {
    // The stderr parser is deliberately scoped to write_stdin router failures;
    // unrelated Codex process failures should remain raw stderr/log events, not
    // fabricated browser/tool results.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    adapter.handleProcessStderr("ERROR codex_core::tools::router: error=exec_command failed: process crashed\n");
    await tick();

    expect(messages.some((msg) => msg.type === "error")).toBe(false);
    expect(getToolUseBlocks(messages, "write_stdin")).toHaveLength(0);
    expect(getToolResultBlocks(messages)).toHaveLength(0);
  });

  it("ignores synthetic plan entries when attaching router errors to an active command", async () => {
    // Codex plan updates render as TodoWrite UI state, but they are not
    // result-bearing tools. They must not prevent a later apply_patch router
    // failure from closing the real active command.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Plan and patch" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_plan_then_router_error" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "turn/plan/updated",
        params: {
          turnId: "turn_plan_then_router_error",
          plan: [{ content: "Patch file", status: "in_progress" }],
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "tool_apply_patch_after_plan",
            type: "commandExecution",
            command: ["apply_patch"],
          },
        },
      }) + "\n",
    );
    await tick();

    const errorMessage =
      "apply_patch verification failed: Failed to find expected lines in /workspace/file.ts:\nexpected line";
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: errorMessage } },
      }) + "\n",
    );
    await tick();

    const todoToolUses = getToolUseBlocks(messages, "TodoWrite");
    expect(todoToolUses).toHaveLength(1);
    expect(todoToolUses[0]?.id).toMatch(/^codex-plan-/);

    const commandResults = getToolResultBlocks(messages, "tool_apply_patch_after_plan");
    expect(commandResults).toHaveLength(1);
    expect(commandResults[0]?.is_error).toBe(true);
    expect(commandResults[0]?.content).toContain("apply_patch verification failed");

    const todoResults = getToolResultBlocks(messages).filter((block) => block.tool_use_id.startsWith("codex-plan-"));
    expect(todoResults).toHaveLength(0);
  });

  it("does not attach router-shaped errors to plan-only synthetic TodoWrite state", async () => {
    // A plan-only turn has visible checklist UI but no result-bearing active
    // tool. Router-shaped errors should remain ordinary visible errors for
    // tool targeting, not failed results for the synthetic TodoWrite block.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Plan only" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_plan_only_router_error" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "turn/plan/updated",
        params: {
          turnId: "turn_plan_only_router_error",
          plan: [{ content: "Decide patch", status: "in_progress" }],
        },
      }) + "\n",
    );
    await tick();

    const errorMessage =
      "apply_patch verification failed: Failed to find expected lines in /workspace/file.ts:\nexpected line";
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: errorMessage } },
      }) + "\n",
    );
    await tick();

    const todoToolUses = getToolUseBlocks(messages, "TodoWrite");
    expect(todoToolUses).toHaveLength(1);
    expect(todoToolUses[0]?.id).toMatch(/^codex-plan-/);
    expect(getToolResultBlocks(messages)).toHaveLength(0);
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", message: errorMessage }));

    stdout.push(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thr_123", status: { type: "idle" } },
      }) + "\n",
    );
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(getToolResultBlocks(messages).filter((block) => block.tool_use_id.startsWith("codex-plan-"))).toHaveLength(
      0,
    );
  });

  it("keeps non-router codex/event/error visible without failing the active tool", async () => {
    // Regression for q-1066 Mental Simulation: an ordinary session-level Codex
    // error during an active tool must not be misclassified as that tool's
    // failed result, and must not arm the router-error idle fallback.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Run a command" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_non_router_error" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "tool_active",
            type: "commandExecution",
            command: ["sleep", "1"],
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: "Rate limit exceeded" } },
      }) + "\n",
    );
    await tick();

    expect(
      messages.some(
        (msg) =>
          msg.type === "assistant" &&
          msg.message.content.some((block) => block.type === "tool_result" && block.tool_use_id === "tool_active"),
      ),
    ).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", message: "Rate limit exceeded" }));

    stdout.push(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thr_123", status: { type: "idle" } },
      }) + "\n",
    );
    await tick();

    expect(messages.filter((m) => m.type === "result")).toHaveLength(0);
    expect(adapter.getCurrentTurnId()).toBeNull();
  });

  it("does not attach router errors to an arbitrary tool when multiple tools are active", async () => {
    // If Codex ever overlaps tool items, the adapter should prefer a generic
    // visible error plus turn-level fallback over closing the newest active
    // tool incorrectly.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Run two tools" });
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_multi_tool_error" } } }) + "\n");
    await tick();

    for (const [id, command] of [
      ["tool_first", ["sleep", "1"]],
      ["tool_second", ["apply_patch"]],
    ] as const) {
      stdout.push(
        JSON.stringify({
          method: "item/started",
          params: {
            item: {
              id,
              type: "commandExecution",
              command,
            },
          },
        }) + "\n",
      );
      await tick();
    }

    const errorMessage =
      "apply_patch verification failed: Failed to find expected lines in /workspace/file.ts:\nexpected line";
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: errorMessage } },
      }) + "\n",
    );
    await tick();

    expect(
      messages.some(
        (msg) => msg.type === "assistant" && msg.message.content.some((block) => block.type === "tool_result"),
      ),
    ).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", message: errorMessage }));

    stdout.push(
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thr_123", status: { type: "idle" } },
      }) + "\n",
    );
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { data: { is_error: boolean; result: string; codex_turn_id?: string } };
    expect(result.data.is_error).toBe(true);
    expect(result.data.result).toContain("apply_patch verification failed");
    expect(result.data.codex_turn_id).toBe("turn_multi_tool_error");
  });

  it("emits result for interrupted turn/completed so session returns to idle", async () => {
    // Interrupted turns must still emit a result so the server transitions
    // to idle. For internal interrupts (new message mid-turn), the next
    // turn/start immediately sets generating=true again.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: { id: "turn_1", status: "interrupted", items: [], error: null },
        },
      }) + "\n",
    );
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const resultData = (results[0] as { data: { subtype: string; is_error: boolean; stop_reason: string } }).data;
    expect(resultData.subtype).toBe("success");
    expect(resultData.is_error).toBe(false);
    expect(resultData.stop_reason).toBe("interrupted");
  });

  it("returns false for unsupported outgoing message types", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    expect(adapter.sendBrowserMessage({ type: "set_model", model: "gpt-5.3-codex" })).toBe(false);
    expect(adapter.sendBrowserMessage({ type: "set_permission_mode", mode: "plan" })).toBe(false);
  });

  it("translates webSearch item to WebSearch tool_use", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "webSearch", id: "ws_1", query: "typescript generics guide" },
        },
      }) + "\n",
    );

    await tick();

    const toolMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_use" && b.name === "WebSearch");
      });
    expect(toolMsg).toBeDefined();

    const content = (toolMsg as { message: { content: Array<{ type: string; input?: { query: string } }> } }).message
      .content;
    const toolBlock = content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { query: string } }).input.query).toBe("typescript generics guide");
  });
});
