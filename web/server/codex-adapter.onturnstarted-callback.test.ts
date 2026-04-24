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

describe("onTurnStarted callback", () => {
  // The bridge relies on turn/start acknowledgement before it marks a Codex
  // user turn as running. These tests lock that callback to both the normal
  // and legacy-collaborationMode fallback paths.

  let proc: ReturnType<typeof createMockProcess>["proc"];
  let stdout: MockReadableStream;

  beforeEach(() => {
    const mock = createMockProcess();
    proc = mock.proc;
    stdout = mock.stdout;
  });

  async function initAdapter(): Promise<CodexAdapter> {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();
    return adapter;
  }

  it("fires onTurnStarted when turn/start succeeds", async () => {
    const adapter = await initAdapter();
    const startedCb = vi.fn();
    adapter.onTurnStarted(startedCb);

    adapter.sendBrowserMessage({ type: "user_message", content: "start turn" } as BrowserOutgoingMessage);
    await tick();

    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_1" } } }) + "\n");
    await tick();

    expect(startedCb).toHaveBeenCalledOnce();
    expect(startedCb).toHaveBeenCalledWith("turn_1");
  });

  it("fires onTurnStarted after retrying without collaborationMode", async () => {
    const adapter = await initAdapter();
    const startedCb = vi.fn();
    adapter.onTurnStarted(startedCb);

    adapter.sendBrowserMessage({ type: "user_message", content: "legacy server" } as BrowserOutgoingMessage);
    await tick();

    // First turn/start fails because older Codex builds reject collaborationMode.
    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    stdout.push(
      JSON.stringify({
        id: 4,
        error: { code: -32602, message: "Unknown field: collaborationMode" },
      }) + "\n",
    );
    await tick();

    // Retry without collaborationMode succeeds.
    stdout.push(JSON.stringify({ id: 5, result: { turn: { id: "turn_legacy" } } }) + "\n");
    await tick();

    expect(startedCb).toHaveBeenCalledOnce();
    expect(startedCb).toHaveBeenCalledWith("turn_legacy");
  });
});
