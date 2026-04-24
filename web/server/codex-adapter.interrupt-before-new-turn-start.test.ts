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

describe("interrupt before new turn/start", () => {
  // Sending turn/start while a turn is already in progress causes Codex to
  // error or crash. The adapter must interrupt the running turn first and
  // wait for it to complete before issuing a new turn/start.

  let proc: ReturnType<typeof createMockProcess>["proc"];
  let stdin: MockWritableStream;
  let stdout: MockReadableStream;

  beforeEach(() => {
    const mock = createMockProcess();
    proc = mock.proc;
    stdin = mock.stdin;
    stdout = mock.stdout;
  });

  async function initAdapterWithTurn(): Promise<CodexAdapter> {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    await tick();
    // Initialize response + thread/start response
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Send first user message to start a turn
    adapter.sendBrowserMessage({ type: "user_message", content: "first message" } as BrowserOutgoingMessage);
    await tick();

    // Respond to rateLimits/read (id=3) and turn/start (id=4)
    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_active" } } }) + "\n");
    await tick();

    // Clear stdin for clean assertion later
    stdin.chunks = [];
    return adapter;
  }

  it("sends turn/interrupt before new turn/start when a turn is active", async () => {
    // Verify that when a second user message arrives while a turn is in
    // progress, the adapter interrupts the running turn before starting a
    // new one.
    const adapter = await initAdapterWithTurn();

    // Send second message while turn_active is still running
    adapter.sendBrowserMessage({ type: "user_message", content: "second message" } as BrowserOutgoingMessage);
    await tick();

    // Respond to turn/interrupt (id=5 — next RPC)
    stdout.push(JSON.stringify({ id: 5, result: {} }) + "\n");
    await tick();

    // Simulate turn completing after interrupt
    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: { turn: { id: "turn_active", status: "interrupted", items: [], error: null } },
      }) + "\n",
    );
    await tick();

    // Respond to the new turn/start (id=6)
    stdout.push(JSON.stringify({ id: 6, result: { turn: { id: "turn_new" } } }) + "\n");
    await tick();

    const allWritten = stdin.chunks.join("");
    // Should see turn/interrupt before the second turn/start
    const interruptIdx = allWritten.indexOf('"method":"turn/interrupt"');
    const turnStartIdx = allWritten.lastIndexOf('"method":"turn/start"');
    expect(interruptIdx).toBeGreaterThanOrEqual(0);
    expect(turnStartIdx).toBeGreaterThan(interruptIdx);
  });

  it("does NOT send turn/interrupt when no turn is active", async () => {
    // Verify that when no turn is in progress, the adapter sends turn/start
    // directly without an interrupt.
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];
    adapter.sendBrowserMessage({ type: "user_message", content: "only message" } as BrowserOutgoingMessage);
    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).not.toContain('"method":"turn/interrupt"');
    expect(allWritten).toContain('"method":"turn/start"');
  });

  it("proceeds with turn/start after interrupt timeout (5s)", async () => {
    // If Codex never sends turn/completed after interrupt, the adapter
    // should time out and proceed with the new turn anyway.
    vi.useFakeTimers();
    try {
      const mock = createMockProcess();
      const adapter = new CodexAdapter(mock.proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
      await vi.advanceTimersByTimeAsync(50);
      mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
      await vi.advanceTimersByTimeAsync(20);
      mock.stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
      await vi.advanceTimersByTimeAsync(50);

      // Start a turn
      adapter.sendBrowserMessage({ type: "user_message", content: "first" } as BrowserOutgoingMessage);
      await vi.advanceTimersByTimeAsync(20);
      // id=3 rateLimits, id=4 turn/start
      mock.stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
      mock.stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_stuck" } } }) + "\n");
      await vi.advanceTimersByTimeAsync(50);

      mock.stdin.chunks = [];

      // Send second message while turn is active
      adapter.sendBrowserMessage({ type: "user_message", content: "second" } as BrowserOutgoingMessage);
      await vi.advanceTimersByTimeAsync(20);

      // Respond to turn/interrupt but never send turn/completed
      mock.stdout.push(JSON.stringify({ id: 5, result: {} }) + "\n");
      await vi.advanceTimersByTimeAsync(20);

      // Advance past the 5s timeout
      await vi.advanceTimersByTimeAsync(5100);

      // New turn/start should have been sent after timeout
      const allWritten = mock.stdin.chunks.join("");
      expect(allWritten).toContain('"method":"turn/interrupt"');
      expect(allWritten).toContain('"method":"turn/start"');
      expect(allWritten).toContain('"text":"second"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes rapid user_message sends so turn/start does not overlap", async () => {
    // Two quick user messages must not race into concurrent turn/start RPCs.
    // The second message should wait until the first turn has a turnId, then
    // interrupt/complete that turn before starting the next one.
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];

    adapter.sendBrowserMessage({ type: "user_message", content: "first rapid" } as BrowserOutgoingMessage);
    adapter.sendBrowserMessage({ type: "user_message", content: "second rapid" } as BrowserOutgoingMessage);
    await tick();

    const earlyWrites = stdin.chunks.join("");
    const earlyTurnStarts = (earlyWrites.match(/\"method\":\"turn\/start\"/g) || []).length;
    expect(earlyTurnStarts).toBe(1);
    expect(earlyWrites).toContain('"text":"first rapid"');
    expect(earlyWrites).not.toContain('"text":"second rapid"');

    // Complete rateLimits/read + first turn/start so the queued second message can continue.
    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_first" } } }) + "\n");
    await tick();

    const midWrites = stdin.chunks.join("");
    expect(midWrites).toContain('"method":"turn/interrupt"');
    expect(midWrites).toContain('"turnId":"turn_first"');

    // Resolve interrupt, then complete the first turn to allow second turn/start.
    stdout.push(JSON.stringify({ id: 5, result: {} }) + "\n");
    await tick();
    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: { turn: { id: "turn_first", status: "interrupted", items: [], error: null } },
      }) + "\n",
    );
    await tick();

    const finalWrites = stdin.chunks.join("");
    const finalTurnStarts = (finalWrites.match(/\"method\":\"turn\/start\"/g) || []).length;
    expect(finalTurnStarts).toBe(2);
    expect(finalWrites).toContain('"text":"second rapid"');
  });
});
