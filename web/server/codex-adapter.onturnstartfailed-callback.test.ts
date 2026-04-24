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

describe("onTurnStartFailed callback", () => {
  // When transport closes during turn/start, the adapter should fire the
  // onTurnStartFailed callback with the original user message so the bridge
  // can re-queue it for replay after relaunch.

  let proc: ReturnType<typeof createMockProcess>["proc"];
  let stdin: MockWritableStream;
  let stdout: MockReadableStream;

  beforeEach(() => {
    const mock = createMockProcess();
    proc = mock.proc;
    stdin = mock.stdin;
    stdout = mock.stdout;
  });

  async function initAdapter(): Promise<CodexAdapter> {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    await tick();
    // Initialize response + thread/start response
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();
    return adapter;
  }

  it("fires onTurnStartFailed when transport closes during turn/start", async () => {
    const adapter = await initAdapter();
    const failedCb = vi.fn();
    adapter.onTurnStartFailed(failedCb);

    // Send a user message — this triggers turn/start RPC call
    adapter.sendBrowserMessage({ type: "user_message", content: "test message" } as BrowserOutgoingMessage);

    // Give a moment for the async handleOutgoingUserMessage to start the transport.call
    await tick();

    // Close stdout — this rejects all pending RPC promises with "Transport closed"
    stdout.close();

    // Wait for the catch block to execute (microtask + setTimeout)
    await tick();

    expect(failedCb).toHaveBeenCalledOnce();
    expect(failedCb).toHaveBeenCalledWith(expect.objectContaining({ type: "user_message", content: "test message" }));
  });

  it("does not emit a turn/start error when transport closes and message is re-queued", async () => {
    const adapter = await initAdapter();
    const failedCb = vi.fn();
    const emitted: BrowserIncomingMessage[] = [];
    adapter.onBrowserMessage((msg) => emitted.push(msg));
    adapter.onTurnStartFailed(failedCb);

    adapter.sendBrowserMessage({ type: "user_message", content: "test message" } as BrowserOutgoingMessage);
    await tick();

    stdout.close();
    await tick();

    expect(failedCb).toHaveBeenCalledOnce();
    const startErrors = emitted.filter((m) => m.type === "error" && m.message.includes("Failed to start turn"));
    expect(startErrors).toHaveLength(0);
  });

  it("re-queues once without emitting an error when turn/start never acknowledges", async () => {
    const adapter = await initAdapter();
    vi.useFakeTimers();
    try {
      const failedCb = vi.fn();
      const emitted: BrowserIncomingMessage[] = [];
      adapter.onBrowserMessage((msg) => emitted.push(msg));
      adapter.onTurnStartFailed(failedCb);

      adapter.sendBrowserMessage({ type: "user_message", content: "test message" } as BrowserOutgoingMessage);
      await vi.advanceTimersByTimeAsync(1);

      expect(failedCb).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.runOnlyPendingTimersAsync();

      expect(failedCb).toHaveBeenCalledOnce();
      expect(failedCb).toHaveBeenCalledWith(expect.objectContaining({ type: "user_message", content: "test message" }));
      const turnStartWrites = stdin.chunks.filter((chunk) => chunk.includes('"method":"turn/start"'));
      expect(turnStartWrites).toHaveLength(1);
      const startErrors = emitted.filter((m) => m.type === "error" && m.message.includes("Failed to start turn"));
      expect(startErrors).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a turn/start error when transport closes and no re-queue callback is registered", async () => {
    const adapter = await initAdapter();
    const emitted: BrowserIncomingMessage[] = [];
    adapter.onBrowserMessage((msg) => emitted.push(msg));

    adapter.sendBrowserMessage({ type: "user_message", content: "test message" } as BrowserOutgoingMessage);
    await tick();

    stdout.close();
    await tick();

    const startErrors = emitted.filter((m) => m.type === "error" && m.message.includes("Failed to start turn"));
    expect(startErrors.length).toBeGreaterThan(0);
  });

  it("does NOT fire onTurnStartFailed when turn/start succeeds", async () => {
    const adapter = await initAdapter();
    const failedCb = vi.fn();
    adapter.onTurnStartFailed(failedCb);

    // Send a user message
    adapter.sendBrowserMessage({ type: "user_message", content: "test message" } as BrowserOutgoingMessage);
    await tick();

    // Respond to rateLimits/read (id=3) and turn/start (id=4) successfully
    // rateLimits is fire-and-forget from init, turn/start is from the user message
    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_1" } } }) + "\n");
    await tick();

    expect(failedCb).not.toHaveBeenCalled();
  });
});
