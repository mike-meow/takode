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

  it("sends turn/start when receiving user_message", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    // Complete initialization
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Clear written chunks to focus on turn/start
    stdin.chunks = [];

    adapter.sendBrowserMessage({
      type: "user_message",
      content: "Fix the bug",
    });

    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"method":"turn/start"');
    expect(allWritten).toContain("Fix the bug");
    expect(allWritten).toContain("thr_123");
  });

  it("uses thread/compact/start for a plain /compact command", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];

    adapter.sendBrowserMessage({
      type: "user_message",
      content: " /COMPACT ",
    });

    await tick();

    const lines = stdin.chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const compactStart = lines.find((line) => line.method === "thread/compact/start");
    expect(compactStart).toBeDefined();
    expect(compactStart.params.threadId).toBe("thr_123");
    expect(lines.find((line) => line.method === "turn/start")).toBeUndefined();
  });

  it("uses thread/compact/start even when VS Code selection metadata is attached", async () => {
    // Regression coverage for q-432: Codex /compact must stay a real compact
    // command when the composer includes ambient VS Code selection context.
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];

    adapter.sendBrowserMessage({
      type: "user_message",
      content: "/compact",
      vscodeSelection: {
        absolutePath: "/workspace/src/App.tsx",
        relativePath: "src/App.tsx",
        displayPath: "App.tsx",
        startLine: 10,
        endLine: 12,
        lineCount: 3,
      },
    });

    await tick();

    const lines = stdin.chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const compactStart = lines.find((line) => line.method === "thread/compact/start");
    expect(compactStart).toBeDefined();
    expect(compactStart.params.threadId).toBe("thr_123");
    expect(lines.find((line) => line.method === "turn/start")).toBeUndefined();
  });

  it("calls thread/rollback for Codex revert", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];

    const rollbackPromise = adapter.rollbackTurns(2);
    await tick();

    const lines = parseWrittenJsonLines(stdin.chunks);
    const rollback = lines.find((line) => line.method === "thread/rollback");
    expect(rollback).toBeDefined();
    expect(rollback.params).toEqual({ threadId: "thr_123", numTurns: 2 });

    stdout.push(JSON.stringify({ id: rollback.id, result: {} }) + "\n");
    await rollbackPromise;
  });

  it("suppresses the interrupted result emitted while rollback interrupts an active turn", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];
    adapter.sendBrowserMessage({ type: "user_message", content: "active turn" });
    await tick();
    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_active" } } }) + "\n");
    await tick();

    stdin.chunks = [];
    const rollbackPromise = adapter.rollbackTurns(1);
    await tick();

    let lines = parseWrittenJsonLines(stdin.chunks);
    const interrupt = lines.find((line) => line.method === "turn/interrupt");
    expect(interrupt).toBeDefined();
    expect(interrupt.params.turnId).toBe("turn_active");

    stdout.push(JSON.stringify({ id: interrupt.id, result: {} }) + "\n");
    await tick();
    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: { turn: { id: "turn_active", status: "interrupted", items: [], error: null } },
      }) + "\n",
    );
    await tick();

    lines = parseWrittenJsonLines(stdin.chunks);
    const rollback = lines.find((line) => line.method === "thread/rollback");
    expect(rollback).toBeDefined();
    expect(messages.find((msg) => msg.type === "result")).toBeUndefined();

    stdout.push(JSON.stringify({ id: rollback.id, result: {} }) + "\n");
    await rollbackPromise;
  });

  it("keeps /compact as a normal turn when the message carries extra payload", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];

    adapter.sendBrowserMessage({
      type: "user_message",
      content: "/compact",
      images: [{ media_type: "image/png", data: "proof-image-bytes" }],
    });

    await tick();

    const lines = stdin.chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const turnStart = lines.find((line) => line.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect(lines.find((line) => line.method === "thread/compact/start")).toBeUndefined();
  });

  it("configures developer instructions before starting a new thread", async () => {
    // Regression: leader guardrails must be configured before Codex creates a
    // fresh thread, otherwise the first turn can run without orchestration rules.
    new CodexAdapter(proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/workspace",
      instructions: "leader guardrails",
    });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    let lines = parseWrittenJsonLines(stdin.chunks);
    const configWrite = lines.find((line) => line.method === "config/value/write");
    expect(configWrite).toBeDefined();
    expect(configWrite.params).toEqual({
      keyPath: "developer_instructions",
      value: "leader guardrails",
      mergeStrategy: "replace",
    });
    expect(lines.find((line) => line.method === "thread/start")).toBeUndefined();

    stdout.push(JSON.stringify({ id: 2, result: {} }) + "\n");
    await tick();

    lines = parseWrittenJsonLines(stdin.chunks);
    expect(lines.find((line) => line.method === "thread/start")).toBeDefined();
  });

  it("sets collaborationMode=plan on turn/start when approvalMode is plan", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "gpt-5.3-codex",
      approvalMode: "plan",
    });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];
    adapter.sendBrowserMessage({ type: "user_message", content: "switch mode test" });
    await tick();

    const lines = stdin.chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const turnStart = lines.find((line) => line.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect(turnStart.params.collaborationMode.mode).toBe("plan");
  });

  it("sets collaborationMode=default on turn/start when approvalMode is bypassPermissions", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "gpt-5.3-codex",
      approvalMode: "bypassPermissions",
    });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];
    adapter.sendBrowserMessage({ type: "user_message", content: "switch mode test" });
    await tick();

    const lines = stdin.chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const turnStart = lines.find((line) => line.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect(turnStart.params.collaborationMode.mode).toBe("default");
  });

  it("keeps approvalMode=suggest in collaborationMode=default", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "gpt-5.3-codex",
      approvalMode: "suggest",
    });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];
    adapter.sendBrowserMessage({ type: "user_message", content: "legacy mode mapping" });
    await tick();

    const lines = stdin.chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const turnStart = lines.find((line) => line.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect(turnStart.params.collaborationMode.mode).toBe("default");
  });

  it("retries turn/start without collaborationMode while preserving configured instructions", async () => {
    // Regression: legacy Codex builds can reject collaborationMode; the retry
    // must not be the only place leader guardrails are carried.
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "gpt-5.3-codex",
      approvalMode: "plan",
      instructions: "leader guardrails",
    });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: {} }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 3, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    const initLines = parseWrittenJsonLines(stdin.chunks);
    expect(initLines.find((line) => line.method === "config/value/write")?.params).toEqual(
      expect.objectContaining({
        keyPath: "developer_instructions",
        value: "leader guardrails",
      }),
    );

    stdin.chunks = [];
    adapter.sendBrowserMessage({ type: "user_message", content: "fallback test" });
    await tick();

    let lines = parseWrittenJsonLines(stdin.chunks);
    let turnStarts = lines.filter((line) => line.method === "turn/start");
    expect(turnStarts).toHaveLength(1);

    stdout.push(
      JSON.stringify({
        id: turnStarts[0].id,
        error: { code: -32602, message: "invalid params: unknown field `collaborationMode`" },
      }) + "\n",
    );
    await tick();

    lines = parseWrittenJsonLines(stdin.chunks);
    turnStarts = lines.filter((line) => line.method === "turn/start");
    expect(turnStarts).toHaveLength(2);

    stdout.push(JSON.stringify({ id: turnStarts[1].id, result: { turn: { id: "turn_1" } } }) + "\n");
    await tick();

    lines = parseWrittenJsonLines(stdin.chunks);
    turnStarts = lines.filter((line) => line.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0].params.collaborationMode.mode).toBe("plan");
    expect(turnStarts[0].params.collaborationMode.settings.developer_instructions).toBeUndefined();
    expect(turnStarts[1].params.collaborationMode).toBeUndefined();
  });

  it("sends text-only user inputs when attachment paths are included in the prompt", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    // Complete initialization
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];

    adapter.sendBrowserMessage({
      type: "user_message",
      content:
        "Describe these files\n" +
        "[📎 Image attachments -- read these files with the Read tool before responding:\n" +
        "Attachment 1: /tmp/image-a.png\n" +
        "Attachment 2: /tmp/image-b.png]",
    });

    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"method":"turn/start"');
    expect(allWritten).toContain("Attachment 1: /tmp/image-a.png");
    expect(allWritten).toContain("Attachment 2: /tmp/image-b.png");
    expect(allWritten).not.toContain('"type":"localImage"');
    expect(allWritten).toContain("/tmp/image-a.png");
    expect(allWritten).toContain("/tmp/image-b.png");
  });

  it("ignores inline image payloads and sends text-only turn input", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    // Complete initialization
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks = [];

    adapter.sendBrowserMessage({
      type: "user_message",
      content: "Inline images should be ignored",
      images: [{ media_type: "image/png", data: "abc123base64" }],
    });

    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"method":"turn/start"');
    expect(allWritten).toContain("Inline images should be ignored");
    expect(allWritten).not.toContain('"type":"image"');
    expect(allWritten).not.toContain("data:image/");
  });
});
