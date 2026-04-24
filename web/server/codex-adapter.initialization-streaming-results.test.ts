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

  it("sends initialize request on construction", async () => {
    new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });

    // Give the adapter time to write the initialize request
    await tick();

    // Check stdin received the initialize request
    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"method":"initialize"');
    expect(allWritten).toContain("thecompanion");
  });

  it("translates agent message streaming to content_block_delta events", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    // Wait for initialize to be sent
    await tick();

    // Simulate server responses: initialize response, then initialized, then thread/start
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Simulate streaming: item/started -> item/agentMessage/delta -> item/completed
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "agentMessage", id: "item_1" } },
      }) + "\n",
    );

    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "item_1", delta: "Hello " },
      }) + "\n",
    );

    stdout.push(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "item_1", delta: "world!" },
      }) + "\n",
    );

    await tick();

    // Find content_block_delta events
    const deltas = messages.filter(
      (m) => m.type === "stream_event" && (m as { event: { type: string } }).event?.type === "content_block_delta",
    );

    expect(deltas.length).toBeGreaterThanOrEqual(2);

    // Check delta content
    const firstDelta = deltas[0] as { event: { delta: { text: string } } };
    expect(firstDelta.event.delta.text).toBe("Hello ");

    const secondDelta = deltas[1] as { event: { delta: { text: string } } };
    expect(secondDelta.event.delta.text).toBe("world!");
  });

  it("uses stable assistant message IDs derived from Codex item IDs", async () => {
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
        params: { item: { type: "agentMessage", id: "item_1" } },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "item_1", delta: "Hello world" },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: { item: { type: "agentMessage", id: "item_1" } },
      }) + "\n",
    );
    await tick();

    const assistantMsgs = messages.filter((m) => m.type === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const last = assistantMsgs[assistantMsgs.length - 1] as {
      message: { id: string; content: Array<{ type: string; text?: string }> };
    };
    expect(last.message.id).toBe("codex-agent-item_1");
    expect(last.message.content[0].type).toBe("text");
    expect(last.message.content[0].text).toBe("Hello world");
  });

  it("translates command approval request to permission_request", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    // Send init responses
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Simulate an approval request (this is a JSON-RPC *request* from server with an id)
    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/requestApproval",
        id: 100,
        params: {
          itemId: "item_cmd_1",
          threadId: "thr_123",
          turnId: "turn_1",
          command: ["rm", "-rf", "/tmp/test"],
          cwd: "/home/user",
          parsedCmd: "rm -rf /tmp/test",
        },
      }) + "\n",
    );

    await tick();

    const permRequests = messages.filter((m) => m.type === "permission_request");
    expect(permRequests.length).toBe(1);

    const perm = permRequests[0] as unknown as { request: { tool_name: string; input: { command: string } } };
    expect(perm.request.tool_name).toBe("Bash");
    expect(perm.request.input.command).toBe("rm -rf /tmp/test");
  });

  it("translates turn/completed to result message", async () => {
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
          turn: { id: "turn_1", status: "completed", items: [], error: null },
        },
      }) + "\n",
    );

    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results.length).toBe(1);

    const result = results[0] as { data: { is_error: boolean; subtype: string; codex_turn_id?: string } };
    expect(result.data.is_error).toBe(false);
    expect(result.data.subtype).toBe("success");
    expect(result.data.codex_turn_id).toBe("turn_1");
  });
});
