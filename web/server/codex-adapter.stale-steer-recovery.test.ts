import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "./session-types.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

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
}

function createMockProcess() {
  const stdinStream = new MockWritableStream();
  const stdoutReadable = new MockReadableStream();
  const stderrReadable = new MockReadableStream();

  const proc = {
    stdin: stdinStream,
    stdout: stdoutReadable.stream,
    stderr: stderrReadable.stream,
    pid: 12345,
    exited: new Promise<number>(() => {}),
    kill: vi.fn(),
  };

  return { proc, stdin: stdinStream, stdout: stdoutReadable, stderr: stderrReadable };
}

function parseWrittenJsonLines(chunks: string[]): any[] {
  return chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findLastRequestId(stdin: MockWritableStream, method: string): number {
  const request = parseWrittenJsonLines(stdin.chunks)
    .filter((line) => line.method === method)
    .at(-1);
  expect(request?.id).toEqual(expect.any(Number));
  return request.id;
}

async function initializeAdapter(stdout: MockReadableStream): Promise<void> {
  stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
  await tick();
  stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
  await tick();
}

async function startActiveTurn(
  adapter: CodexAdapter,
  stdin: MockWritableStream,
  stdout: MockReadableStream,
  turnId = "turn_active",
  content = "initial turn",
) {
  adapter.sendBrowserMessage({ type: "user_message", content } as BrowserOutgoingMessage);
  await tick();

  const rateLimitsRead = parseWrittenJsonLines(stdin.chunks).find((line) => line.method === "rateLimits/read");
  if (typeof rateLimitsRead?.id === "number") {
    stdout.push(JSON.stringify({ id: rateLimitsRead.id, result: {} }) + "\n");
  }
  stdout.push(JSON.stringify({ id: findLastRequestId(stdin, "turn/start"), result: { turn: { id: turnId } } }) + "\n");
  await tick();
}

describe("CodexAdapter stale turn/steer recovery", () => {
  let proc: ReturnType<typeof createMockProcess>["proc"];
  let stdin: MockWritableStream;
  let stdout: MockReadableStream;

  beforeEach(() => {
    const mock = createMockProcess();
    proc = mock.proc;
    stdin = mock.stdin;
    stdout = mock.stdout;
  });

  it("clears a matching stale active turn and suppresses no-active-turn steer errors", async () => {
    const emitted: BrowserIncomingMessage[] = [];
    const steerFailed = vi.fn();
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => emitted.push(msg));
    adapter.onTurnSteerFailed(steerFailed);

    await initializeAdapter(stdout);
    await startActiveTurn(adapter, stdin, stdout);

    adapter.sendBrowserMessage({
      type: "codex_steer_pending",
      pendingInputIds: ["pending-follow-up"],
      expectedTurnId: "turn_active",
      inputs: [{ content: "follow-up" }],
    });
    await tick();

    stdout.push(
      JSON.stringify({
        id: findLastRequestId(stdin, "turn/steer"),
        error: { code: -32602, message: "no active turn to steer" },
      }) + "\n",
    );
    await tick();

    expect(adapter.getCurrentTurnId()).toBeNull();
    expect(steerFailed).toHaveBeenCalledWith(["pending-follow-up"]);
    expect(emitted).not.toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Failed to steer active Codex turn"),
      }),
    );

    stdin.chunks = [];
    adapter.sendBrowserMessage({
      type: "codex_start_pending",
      pendingInputIds: ["pending-follow-up"],
      inputs: [{ content: "follow-up" }],
    });
    await tick();

    const methods = parseWrittenJsonLines(stdin.chunks).map((line) => line.method);
    expect(methods).toContain("turn/start");
    expect(methods).not.toContain("turn/interrupt");
  });

  it("keeps unrelated turn/steer failures visible and leaves the active turn intact", async () => {
    const emitted: BrowserIncomingMessage[] = [];
    const steerFailed = vi.fn();
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => emitted.push(msg));
    adapter.onTurnSteerFailed(steerFailed);

    await initializeAdapter(stdout);
    await startActiveTurn(adapter, stdin, stdout);

    adapter.sendBrowserMessage({
      type: "codex_steer_pending",
      pendingInputIds: ["pending-follow-up"],
      expectedTurnId: "turn_active",
      inputs: [{ content: "follow-up" }],
    });
    await tick();

    stdout.push(
      JSON.stringify({
        id: findLastRequestId(stdin, "turn/steer"),
        error: { code: -32602, message: "input must not be empty" },
      }) + "\n",
    );
    await tick();

    expect(adapter.getCurrentTurnId()).toBe("turn_active");
    expect(steerFailed).toHaveBeenCalledWith(["pending-follow-up"]);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Failed to steer active Codex turn: Error: input must not be empty"),
      }),
    );
  });

  it("keeps a newer active turn when a stale expected turn receives no-active-turn", async () => {
    const emitted: BrowserIncomingMessage[] = [];
    const steerFailed = vi.fn();
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => emitted.push(msg));
    adapter.onTurnSteerFailed(steerFailed);

    await initializeAdapter(stdout);
    await startActiveTurn(adapter, stdin, stdout, "turn_old", "old turn");
    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: { turn: { id: "turn_old", status: "completed" } },
      }) + "\n",
    );
    await tick();
    await startActiveTurn(adapter, stdin, stdout, "turn_new", "newer turn");

    adapter.sendBrowserMessage({
      type: "codex_steer_pending",
      pendingInputIds: ["pending-follow-up"],
      expectedTurnId: "turn_old",
      inputs: [{ content: "follow-up for stale turn" }],
    });
    await tick();

    stdout.push(
      JSON.stringify({
        id: findLastRequestId(stdin, "turn/steer"),
        error: { code: -32602, message: "no active turn to steer" },
      }) + "\n",
    );
    await tick();

    expect(adapter.getCurrentTurnId()).toBe("turn_new");
    expect(steerFailed).toHaveBeenCalledWith(["pending-follow-up"]);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Failed to steer active Codex turn: Error: no active turn to steer"),
      }),
    );
  });

  it("emits a stored router failure once during stale-steer recovery", async () => {
    const emitted: BrowserIncomingMessage[] = [];
    const steerFailed = vi.fn();
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => emitted.push(msg));
    adapter.onTurnSteerFailed(steerFailed);

    await initializeAdapter(stdout);
    await startActiveTurn(adapter, stdin, stdout, "turn_router_error");

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

    adapter.sendBrowserMessage({
      type: "codex_steer_pending",
      pendingInputIds: ["pending-follow-up"],
      expectedTurnId: "turn_router_error",
      inputs: [{ content: "follow-up after router failure" }],
    });
    await tick();

    stdout.push(
      JSON.stringify({
        id: findLastRequestId(stdin, "turn/steer"),
        error: { code: -32602, message: "no active turn to steer" },
      }) + "\n",
    );
    await tick();

    const results = emitted.filter((msg) => msg.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { data: { is_error: boolean; result?: string; codex_turn_id?: string } };
    expect(result.data).toMatchObject({
      is_error: true,
      codex_turn_id: "turn_router_error",
    });
    expect(result.data.result).toContain("apply_patch verification failed");
    expect(emitted).not.toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Failed to steer active Codex turn"),
      }),
    );

    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: { id: "turn_router_error", status: "failed", error: { message: "duplicate terminal error" } },
        },
      }) + "\n",
    );
    await tick();

    expect(emitted.filter((msg) => msg.type === "result")).toHaveLength(1);
  });

  it("surfaces a different completion error after handled write_stdin stale-steer cleanup", async () => {
    const emitted: BrowserIncomingMessage[] = [];
    const steerFailed = vi.fn();
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => emitted.push(msg));
    adapter.onTurnSteerFailed(steerFailed);

    await initializeAdapter(stdout);
    await startActiveTurn(adapter, stdin, stdout, "turn_write_stdin_router_error");

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

    const routerErrorMessage = "write_stdin failed: Unknown process id 13506";
    stdout.push(
      JSON.stringify({
        method: "codex/event/error",
        params: { msg: { message: routerErrorMessage } },
      }) + "\n",
    );
    await tick();

    adapter.sendBrowserMessage({
      type: "codex_steer_pending",
      pendingInputIds: ["pending-follow-up"],
      expectedTurnId: "turn_write_stdin_router_error",
      inputs: [{ content: "follow-up after write_stdin router failure" }],
    });
    await tick();

    stdout.push(
      JSON.stringify({
        id: findLastRequestId(stdin, "turn/steer"),
        error: { code: -32602, message: "no active turn to steer" },
      }) + "\n",
    );
    await tick();

    const cleanupResults = emitted.filter((msg) => msg.type === "result");
    expect(cleanupResults).toHaveLength(1);
    expect((cleanupResults[0] as { data: { is_error: boolean } }).data.is_error).toBe(false);
    expect(emitted).not.toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Failed to steer active Codex turn"),
      }),
    );

    const realErrorMessage = "Codex turn failed after stale steer recovery";
    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: {
            id: "turn_write_stdin_router_error",
            status: "failed",
            error: { message: realErrorMessage },
          },
        },
      }) + "\n",
    );
    await tick();

    const results = emitted.filter((msg) => msg.type === "result");
    expect(results).toHaveLength(2);
    const realErrorResult = results[1] as { data: { is_error: boolean; result?: string; codex_turn_id?: string } };
    expect(realErrorResult.data.is_error).toBe(true);
    expect(realErrorResult.data.result).toBe(realErrorMessage);
    expect(realErrorResult.data.codex_turn_id).toBe("turn_write_stdin_router_error");
  });
});
