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

  // ── Session resume ──────────────────────────────────────────────────────────

  it("uses thread/resume instead of thread/start when threadId is provided", async () => {
    const mock = createMockProcess();

    new CodexAdapter(mock.proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/workspace",
      threadId: "thr_existing_456",
    });

    await tick();

    // Respond to initialize
    mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    // The second call should be thread/resume, not thread/start
    // Respond to thread/resume
    mock.stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_existing_456" } } }) + "\n");
    await tick();

    const allWritten = mock.stdin.chunks.join("");
    expect(allWritten).toContain('"method":"thread/resume"');
    expect(allWritten).toContain('"threadId":"thr_existing_456"');
    expect(allWritten).not.toContain('"method":"thread/start"');
  });

  it("configures developer instructions before resuming a thread", async () => {
    // Regression: relaunched leader sessions resume an existing thread, so they
    // need the same guardrails configured before thread/resume.
    const mock = createMockProcess();

    new CodexAdapter(mock.proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/workspace",
      threadId: "thr_existing_leader",
      instructions: "leader guardrails",
    });

    await tick();

    mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    let lines = parseWrittenJsonLines(mock.stdin.chunks);
    const configWrite = lines.find((line) => line.method === "config/value/write");
    expect(configWrite?.params).toEqual({
      keyPath: "developer_instructions",
      value: "leader guardrails",
      mergeStrategy: "replace",
    });
    expect(lines.find((line) => line.method === "thread/resume")).toBeUndefined();

    mock.stdout.push(JSON.stringify({ id: 2, result: {} }) + "\n");
    await tick();

    lines = parseWrittenJsonLines(mock.stdin.chunks);
    const resume = lines.find((line) => line.method === "thread/resume");
    expect(resume).toBeDefined();
    expect(resume.params.threadId).toBe("thr_existing_leader");
    expect(lines.find((line) => line.method === "thread/start")).toBeUndefined();
  });

  it("restores currentTurnId when thread/resume returns an in-progress turn", async () => {
    const mock = createMockProcess();

    const adapter = new CodexAdapter(mock.proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/workspace",
      threadId: "thr_existing_789",
    });

    await tick();

    mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    mock.stdout.push(
      JSON.stringify({
        id: 2,
        result: {
          thread: {
            id: "thr_existing_789",
            turns: [
              {
                id: "turn_in_progress",
                status: "inProgress",
                items: [
                  { type: "userMessage", content: [{ type: "text", text: "run command" }] },
                  { type: "commandExecution", id: "cmd_live", status: "in_progress", command: ["sleep", "60"] },
                ],
              },
            ],
          },
        },
      }) + "\n",
    );
    await tick();

    expect(adapter.getCurrentTurnId()).toBe("turn_in_progress");
  });

  it("does NOT set currentTurnId when thread/resume returns inProgress turn but thread is idle", async () => {
    // After a CLI restart, the resumed thread may report idle while the last
    // turn still says "inProgress" (stale from the dead process). The adapter
    // must not set currentTurnId in this case — doing so would block subsequent
    // user messages with a stale turn/interrupt.
    const mock = createMockProcess();

    const adapter = new CodexAdapter(mock.proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/workspace",
      threadId: "thr_idle_thread",
    });

    await tick();

    mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    mock.stdout.push(
      JSON.stringify({
        id: 2,
        result: {
          thread: {
            id: "thr_idle_thread",
            status: { type: "idle" },
            turns: [
              {
                id: "turn_stale_inprogress",
                status: "inProgress",
                items: [
                  { type: "userMessage", content: [{ type: "text", text: "do something" }] },
                  { type: "commandExecution", id: "cmd_dead", status: "in_progress", command: ["make"] },
                ],
              },
            ],
          },
        },
      }) + "\n",
    );
    await tick();

    // Thread is idle → turn is stale → currentTurnId must be null
    expect(adapter.getCurrentTurnId()).toBeNull();
  });

  it("thread/status/changed idle clears stale currentTurnId", async () => {
    // If currentTurnId is set (e.g. from a resumed inProgress turn that's
    // actually running), a thread/status/changed notification reporting idle
    // should clear it so user messages aren't blocked.
    const mock = createMockProcess();

    const adapter = new CodexAdapter(mock.proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/workspace",
      threadId: "thr_status_change",
    });

    await tick();

    mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    // Resume returns an active thread with an inProgress turn
    mock.stdout.push(
      JSON.stringify({
        id: 2,
        result: {
          thread: {
            id: "thr_status_change",
            status: { type: "active" },
            turns: [
              {
                id: "turn_active",
                status: "inProgress",
                items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
              },
            ],
          },
        },
      }) + "\n",
    );
    await tick();

    expect(adapter.getCurrentTurnId()).toBe("turn_active");

    // Thread transitions to idle — turn is done, clear currentTurnId
    mock.stdout.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/status/changed",
        params: { threadId: "thr_status_change", status: { type: "idle" } },
      }) + "\n",
    );
    await tick();

    expect(adapter.getCurrentTurnId()).toBeNull();
  });

  it("falls back to thread/start when thread/resume fails with missing rollout", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const errors: string[] = [];
    const mock = createMockProcess();

    const adapter = new CodexAdapter(mock.proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/workspace",
      threadId: "thr_stale_123",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));
    adapter.onInitError((err) => errors.push(err));

    await tick();

    // initialize response
    mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    // thread/resume error from stale thread/rollout
    mock.stdout.push(
      JSON.stringify({
        id: 2,
        error: { code: -1, message: "no rollout found for thread id thr_stale_123" },
      }) + "\n",
    );
    await tick();

    // fallback thread/start success
    mock.stdout.push(JSON.stringify({ id: 3, result: { thread: { id: "thr_new_789" } } }) + "\n");
    await tick();

    const allWritten = mock.stdin.chunks.join("");
    expect(allWritten).toContain('"method":"thread/resume"');
    expect(allWritten).toContain('"threadId":"thr_stale_123"');
    expect(allWritten).toContain('"method":"thread/start"');
    expect(errors).toHaveLength(0);
    expect(messages.some((m) => m.type === "session_init")).toBe(true);
  });

  it("falls back to thread/start when thread/resume fails with empty session file", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const errors: string[] = [];
    const mock = createMockProcess();

    const adapter = new CodexAdapter(mock.proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/workspace",
      threadId: "thr_empty_123",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));
    adapter.onInitError((err) => errors.push(err));

    await tick();

    mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    mock.stdout.push(
      JSON.stringify({
        id: 2,
        error: { code: -1, message: "failed to load rollout rollout_abc: empty session file" },
      }) + "\n",
    );
    await tick();

    mock.stdout.push(JSON.stringify({ id: 3, result: { thread: { id: "thr_new_456" } } }) + "\n");
    await tick();

    const allWritten = mock.stdin.chunks.join("");
    expect(allWritten).toContain('"method":"thread/resume"');
    expect(allWritten).toContain('"threadId":"thr_empty_123"');
    expect(allWritten).toContain('"method":"thread/start"');
    expect(errors).toHaveLength(0);
    expect(messages.some((m) => m.type === "session_init")).toBe(true);
  });
});
