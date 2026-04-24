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

  // ── Codex CLI enum values must be kebab-case (v0.99+) ─────────────────
  // Valid sandbox values: "read-only", "workspace-write", "danger-full-access"
  // Valid approvalPolicy values: "never", "untrusted", "on-failure", "on-request"

  it("sends kebab-case sandbox value", async () => {
    new CodexAdapter(proc as never, "test-session", { model: "gpt-5.3-codex", cwd: "/tmp" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"sandbox":"workspace-write"');
    // Reject camelCase variants
    expect(allWritten).not.toContain('"sandbox":"workspaceWrite"');
    expect(allWritten).not.toContain('"sandbox":"readOnly"');
    expect(allWritten).not.toContain('"sandbox":"dangerFullAccess"');
  });

  it.each([
    { approvalMode: "bypassPermissions", askPermission: undefined, expected: "never" },
    { approvalMode: "suggest", askPermission: undefined, expected: "untrusted" },
    { approvalMode: "plan", askPermission: undefined, expected: "untrusted" },
    { approvalMode: "plan", askPermission: false, expected: "never" },
    { approvalMode: "acceptEdits", askPermission: undefined, expected: "untrusted" },
    { approvalMode: "default", askPermission: undefined, expected: "untrusted" },
    { approvalMode: undefined, askPermission: undefined, expected: "untrusted" },
  ])("maps approvalMode=$approvalMode askPermission=$askPermission to kebab-case approvalPolicy=$expected", async ({
    approvalMode,
    askPermission,
    expected,
  }) => {
    const mock = createMockProcess();

    new CodexAdapter(mock.proc as never, "test-session", {
      model: "gpt-5.3-codex",
      approvalMode,
      askPermission,
    });

    await tick();
    mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    const allWritten = mock.stdin.chunks.join("");
    expect(allWritten).toContain(`"approvalPolicy":"${expected}"`);
    // Reject camelCase variants
    expect(allWritten).not.toContain('"approvalPolicy":"unlessTrusted"');
    expect(allWritten).not.toContain('"approvalPolicy":"onFailure"');
    expect(allWritten).not.toContain('"approvalPolicy":"onRequest"');
  });

  it("sends session_init to browser after successful initialization", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/my/project",
      approvalMode: "plan",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_789" } } }) + "\n");
    await tick();

    const initMsg = messages.find((m) => m.type === "session_init");
    expect(initMsg).toBeDefined();

    const session = (initMsg as unknown as { session: Record<string, unknown> }).session;
    expect(session.backend_type).toBe("codex");
    expect(session.model).toBe("gpt-5.3-codex");
    expect(session.cwd).toBe("/my/project");
    expect(session.session_id).toBe("test-session");
  });

  it("passes model and cwd in thread/start request", async () => {
    new CodexAdapter(proc as never, "test-session", {
      model: "gpt-5.4",
      cwd: "/workspace/app",
    });

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"model":"gpt-5.4"');
    expect(allWritten).toContain('"cwd":"/workspace/app"');
  });

  // ── Init error handling ────────────────────────────────────────────────────

  it("calls onInitError when initialization fails", async () => {
    const errors: string[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onInitError((err) => errors.push(err));

    await tick();

    // Send an error response to the initialize request
    stdout.push(
      JSON.stringify({
        id: 1,
        error: { code: -1, message: "server not ready" },
      }) + "\n",
    );

    await tick();

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("initialization failed");
  });

  it("includes launcher failure context when init transport closes before initialize completes", async () => {
    const errors: string[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "o4-mini",
      failureContextProvider: () => "codex bootstrap failed: cache write denied",
    });
    adapter.onInitError((err) => errors.push(err));

    await tick();
    stdout.close();
    await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Codex initialization failed: Transport closed");
    expect(errors[0]).toContain("cache write denied");
  });

  it("rejects messages and discards queue after init failure", async () => {
    // Verify that after initialization fails, sendBrowserMessage returns false
    // and any previously queued messages are discarded (no memory leak).
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    // Queue a message before init completes — should be accepted
    const queued = adapter.sendBrowserMessage({ type: "user_message", content: "hello" } as any);
    expect(queued).toBe(true);

    // Fail init
    stdout.push(
      JSON.stringify({
        id: 1,
        error: { code: -1, message: "no rollout found" },
      }) + "\n",
    );

    await tick();

    // After init failure, new messages should be rejected
    const rejected = adapter.sendBrowserMessage({ type: "user_message", content: "world" } as any);
    expect(rejected).toBe(false);

    // The error message should have been emitted to the browser
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeDefined();
  });
});
