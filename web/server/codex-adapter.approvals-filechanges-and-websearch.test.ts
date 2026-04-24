import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, SessionState } from "./session-types.js";
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
