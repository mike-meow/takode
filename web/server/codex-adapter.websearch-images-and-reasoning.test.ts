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

  it("extracts webSearch query from action fields when query is absent", async () => {
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
            type: "webSearch",
            id: "ws_action_query",
            action: { type: "search", query: "codex cli skills documentation" },
          },
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
    expect((toolBlock as { input: { query: string } }).input.query).toBe("codex cli skills documentation");
  });

  it("surfaces rawResponseItem/completed view_image function calls as completed tool blocks", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "rawResponseItem/completed",
        params: {
          item: {
            type: "function_call",
            name: "view_image",
            arguments: '{"path":"/tmp/proof.png"}',
            call_id: "call_view_image_1",
          },
        },
      }) + "\n",
    );

    await tick();

    const toolMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; name?: string; id?: string }> } }).message
          .content;
        return content.some((b) => b.type === "tool_use" && b.name === "view_image" && b.id === "call_view_image_1");
      });

    expect(toolMsg).toBeDefined();
    const toolBlock = (
      toolMsg as { message: { content: Array<{ type: string; input?: { path?: string } }> } }
    ).message.content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { path?: string } }).input.path).toBe("/tmp/proof.png");

    const resultMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_result" && b.tool_use_id === "call_view_image_1");
      });
    expect(resultMsg).toBeDefined();
  });

  it("deduplicates replayed rawResponseItem/completed view_image calls", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    const rawViewImage = JSON.stringify({
      method: "rawResponseItem/completed",
      params: {
        item: {
          type: "function_call",
          name: "view_image",
          arguments: '{"path":"/tmp/replayed.png"}',
          call_id: "call_view_image_replay",
        },
      },
    });

    stdout.push(rawViewImage + "\n");
    stdout.push(rawViewImage + "\n");

    await tick();

    const toolUseMsgs = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "call_view_image_replay");
    });

    expect(toolUseMsgs).toHaveLength(1);
  });

  it("surfaces imageView item started/completed notifications as a completed tool block", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "imageView",
            id: "image-view-item-1",
            path: "/tmp/from-item-started.png",
          },
        },
      }) + "\n",
    );
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "imageView",
            id: "image-view-item-1",
            path: "/tmp/from-item-started.png",
          },
        },
      }) + "\n",
    );

    await tick();

    const toolUseMsgs = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string; id?: string }> } }).message
        .content;
      return content.some((b) => b.type === "tool_use" && b.name === "view_image" && b.id === "image-view-item-1");
    });

    expect(toolUseMsgs).toHaveLength(1);
    const toolBlock = (
      toolUseMsgs[0] as { message: { content: Array<{ type: string; input?: { path?: string } }> } }
    ).message.content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { path?: string } }).input.path).toBe("/tmp/from-item-started.png");

    const resultMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_result" && b.tool_use_id === "image-view-item-1");
      });
    expect(resultMsg).toBeDefined();
  });

  it("backfills imageView path on completion before emitting the final tool_result", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "imageView",
            id: "image-view-item-2",
            path: "",
          },
        },
      }) + "\n",
    );
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "imageView",
            id: "image-view-item-2",
            path: "/tmp/from-completed.png",
          },
        },
      }) + "\n",
    );

    await tick();

    const lastToolUseMsg = messages
      .filter((m) => m.type === "assistant")
      .filter((m) => {
        const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_use" && b.id === "image-view-item-2");
      })
      .at(-1);
    expect(lastToolUseMsg).toBeDefined();
    const toolBlock = (
      lastToolUseMsg as { message: { content: Array<{ type: string; input?: { path?: string } }> } }
    ).message.content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { path?: string } }).input.path).toBe("/tmp/from-completed.png");

    const resultMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_result" && b.tool_use_id === "image-view-item-2");
      });
    expect(resultMsg).toBeDefined();
  });

  it("calls onSessionMeta with thread ID after initialization", async () => {
    const metaCalls: Array<{ cliSessionId?: string; model?: string }> = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "gpt-5.4", cwd: "/project" });
    adapter.onSessionMeta((meta) => metaCalls.push(meta));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_456" } } }) + "\n");
    await tick();

    expect(metaCalls.length).toBe(1);
    expect(metaCalls[0].cliSessionId).toBe("thr_456");
    expect(metaCalls[0].model).toBe("gpt-5.4");
  });

  // ── Item completion handlers ───────────────────────────────────────────────

  it("emits tool_result on webSearch item/completed", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // item/started for webSearch
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "webSearch", id: "ws_1", query: "typescript guide" } },
      }) + "\n",
    );
    await tick();

    // item/completed for webSearch
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "webSearch",
            id: "ws_1",
            query: "typescript guide",
            action: { type: "navigate", url: "https://example.com/guide" },
          },
        },
      }) + "\n",
    );
    await tick();

    const toolResults = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result");
    });
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    const resultMsg = toolResults[toolResults.length - 1] as {
      message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> };
    };
    const resultBlock = resultMsg.message.content.find((b) => b.type === "tool_result");
    expect(resultBlock?.tool_use_id).toBe("ws_1");
    expect(resultBlock?.content).toContain("https://example.com/guide");
  });

  it("prefers structured webSearch results over echoing the query", async () => {
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
            type: "webSearch",
            id: "ws_2",
            query: "Codex CLI skills documentation",
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "webSearch",
            id: "ws_2",
            query: "Codex CLI skills documentation",
            results: [
              {
                title: "OpenAI Codex CLI docs",
                url: "https://platform.openai.com/docs/codex",
                snippet: "Official setup and skills documentation.",
              },
            ],
          },
        },
      }) + "\n",
    );
    await tick();

    const toolResults = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result");
    });
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    const resultMsg = toolResults[toolResults.length - 1] as {
      message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> };
    };
    const resultBlock = resultMsg.message.content.find((b) => b.type === "tool_result");
    expect(resultBlock?.tool_use_id).toBe("ws_2");
    expect(resultBlock?.content).toContain("OpenAI Codex CLI docs");
    expect(resultBlock?.content).toContain("https://platform.openai.com/docs/codex");
    expect(resultBlock?.content).not.toBe("Codex CLI skills documentation");
  });

  // Regression: Codex web search items with no real result data caused the
  // adapter to emit the query text as the tool_result, which the ToolBlock
  // then displayed as "RESULT: <query>". The fix suppresses tool_result
  // emission when the result would just echo the query.
  it("skips tool_result when webSearch result would echo the query", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // item/started
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "webSearch", id: "ws_echo", query: "Codex CLI skills documentation" },
        },
      }) + "\n",
    );
    await tick();

    // item/completed — only has query, no real result fields. The adapter's
    // extractWebSearchResultText falls through to "Web search completed" or
    // returns the query itself.
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "webSearch",
            id: "ws_echo",
            query: "Codex CLI skills documentation",
          },
        },
      }) + "\n",
    );
    await tick();

    // No tool_result should be emitted — the only result would be the query
    const toolResults = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result");
    });
    expect(toolResults.length).toBe(0);
  });

  it("emits content_block_stop on reasoning item/completed", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // item/started for reasoning (opens thinking block)
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "reasoning", id: "r_1", summary: "Thinking about the problem..." } },
      }) + "\n",
    );
    await tick();

    // item/completed for reasoning (should close thinking block)
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: { item: { type: "reasoning", id: "r_1", summary: "Thinking about the problem..." } },
      }) + "\n",
    );
    await tick();

    const blockStops = messages.filter(
      (m) => m.type === "stream_event" && (m as { event: { type: string } }).event?.type === "content_block_stop",
    );
    expect(blockStops.length).toBeGreaterThanOrEqual(1);
  });

  it("does not disconnect when reasoning summary payload is non-string", async () => {
    // Regression: Codex may send summary/content in structured object form.
    // The adapter must coerce safely instead of throwing and dropping transport.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    const onDisconnect = vi.fn();
    adapter.onBrowserMessage((msg) => messages.push(msg));
    adapter.onDisconnect(onDisconnect);

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "reasoning", id: "r_obj" } },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "reasoning",
            id: "r_obj",
            summary: { text: "Structured reasoning summary" },
          },
        },
      }) + "\n",
    );
    await tick();

    const thinkingMsgs = messages.filter(
      (m) =>
        m.type === "assistant" &&
        (m as { message: { content: Array<{ type: string }> } }).message.content.some((b) => b.type === "thinking"),
    );
    expect(thinkingMsgs.length).toBeGreaterThanOrEqual(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("measures thinking_time_ms per summary from the previous completed message", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Think about this" } as BrowserOutgoingMessage);
    await tick();

    // Resolve rateLimits/read + turn/start
    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_1" } } }) + "\n");
    await tick();

    // First reasoning summary arrives after a measurable gap from turn/start.
    // Real delay needed here — this test validates wall-clock thinking_time_ms measurement.
    await new Promise((r) => setTimeout(r, 80));
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "reasoning", id: "r_t1", summary: "First summary" } },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: { item: { type: "reasoning", id: "r_t1", summary: "First summary" } },
      }) + "\n",
    );
    await tick();

    // Second reasoning summary arrives shortly after the first one completed.
    await new Promise((r) => setTimeout(r, 20));
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "reasoning", id: "r_t2", summary: "Second summary" } },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: { item: { type: "reasoning", id: "r_t2", summary: "Second summary" } },
      }) + "\n",
    );
    await tick();

    const reasoningAssistants = messages.filter(
      (m) =>
        m.type === "assistant" &&
        (m as { message: { content: Array<{ type: string }> } }).message.content.some((b) => b.type === "thinking"),
    ) as Array<{ message: { content: Array<{ type: string; thinking_time_ms?: number }> } }>;

    expect(reasoningAssistants.length).toBeGreaterThanOrEqual(2);
    const firstThinking = reasoningAssistants[0].message.content.find((b) => b.type === "thinking");
    const secondThinking = reasoningAssistants[1].message.content.find((b) => b.type === "thinking");
    const firstMs = firstThinking?.thinking_time_ms ?? -1;
    const secondMs = secondThinking?.thinking_time_ms ?? -1;

    expect(firstMs).toBeGreaterThanOrEqual(60);
    expect(secondMs).toBeGreaterThanOrEqual(10);
    expect(secondMs).toBeLessThan(firstMs);
  });

  it("emits live reasoning summary deltas as thinking stream events", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "reasoning", id: "r_live", summary: "Inspecting " } },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/reasoning/summaryTextDelta",
        params: { itemId: "r_live", delta: "session state" },
      }) + "\n",
    );
    await tick();

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "content_block_start",
          content_block: expect.objectContaining({ type: "thinking", thinking: "Inspecting " }),
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "content_block_delta",
          delta: expect.objectContaining({ type: "thinking_delta", thinking: "session state" }),
        }),
      }),
    );
  });
});
