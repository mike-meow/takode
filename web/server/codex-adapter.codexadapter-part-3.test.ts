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

  it("uses streamed outputDelta text when failed command lacks stdout/stderr", async () => {
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
            type: "commandExecution",
            id: "cmd_fail",
            command: "sed -n '1,260p' missing.ts",
            status: "inProgress",
          },
        },
      }) + "\n",
    );
    await tick();

    // Simulate codex sending streamed terminal output but no final stdout/stderr fields.
    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/outputDelta",
        params: {
          itemId: "cmd_fail",
          delta: "sed: can't read missing.ts: No such file or directory\n",
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            id: "cmd_fail",
            command: "sed -n '1,260p' missing.ts",
            status: "failed",
            exitCode: 2,
          },
        },
      }) + "\n",
    );
    await tick();

    const toolResultMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } })
        .message.content;
      return content.some((b) => b.type === "tool_result" && b.tool_use_id === "cmd_fail");
    }) as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } } | undefined;

    expect(toolResultMsg).toBeDefined();
    const resultBlock = toolResultMsg!.message.content.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "cmd_fail",
    );
    expect(resultBlock?.content).toContain("No such file or directory");
    expect(resultBlock?.content).toContain("Exit code: 2");
  });

  it("emits tool_progress with output_delta for streamed command output", async () => {
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
          item: { type: "commandExecution", id: "cmd_live", command: "long-running.sh", status: "inProgress" },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/outputDelta",
        params: {
          itemId: "cmd_live",
          delta: "step 1/3 complete\n",
        },
      }) + "\n",
    );
    await tick();

    const progressMsg = messages.find(
      (m) => m.type === "tool_progress" && (m as { tool_use_id?: string }).tool_use_id === "cmd_live",
    ) as { type: "tool_progress"; output_delta?: string; elapsed_time_seconds: number } | undefined;
    expect(progressMsg).toBeDefined();
    expect(progressMsg?.output_delta).toBe("step 1/3 complete\n");
    expect(progressMsg?.elapsed_time_seconds).toBeGreaterThanOrEqual(0);
  });

  it("surfaces terminal polling interactions as visible write_stdin tool calls", async () => {
    // q-426: Codex emits terminalInteraction notifications when the runtime
    // polls or writes to a live unified-exec session. Those actions need to
    // become transcript-visible tool calls instead of silently disappearing.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "commandExecution", id: "cmd_live", command: "sleep 20", status: "inProgress" },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/terminalInteraction",
        params: {
          itemId: "cmd_live",
          processId: "59356",
          stdin: "",
        },
      }) + "\n",
    );
    await tick();

    const writeStdinUse = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (
        m as { message: { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } }
      ).message.content;
      return content.some(
        (b) =>
          b.type === "tool_use" && b.name === "write_stdin" && b.input?.session_id === "59356" && b.input?.chars === "",
      );
    }) as
      | {
          message: { content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> };
        }
      | undefined;

    expect(writeStdinUse).toBeDefined();

    const syntheticToolUseId = writeStdinUse!.message.content.find(
      (b) => b.type === "tool_use" && b.name === "write_stdin",
    )?.id;
    expect(syntheticToolUseId).toBeTruthy();

    const writeStdinResult = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } })
        .message.content;
      return content.some(
        (b) =>
          b.type === "tool_result" &&
          b.tool_use_id === syntheticToolUseId &&
          typeof b.content === "string" &&
          b.content.includes('write_stdin(chars="")'),
      );
    });

    expect(writeStdinResult).toBeDefined();
  });

  it("maps turn/plan/updated into TodoWrite tool_use for checklist rendering", async () => {
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
        method: "turn/plan/updated",
        params: {
          turnId: "turn_plan_1",
          plan: {
            steps: [
              { content: "Fix failing test", status: "in_progress", activeForm: "Fixing failing test" },
              { content: "Run test suite", status: "completed" },
            ],
          },
        },
      }) + "\n",
    );
    await tick();

    const todoToolUse = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (
        m as { message: { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } }
      ).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "TodoWrite");
    }) as { message: { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } } | undefined;

    expect(todoToolUse).toBeDefined();
    const block = todoToolUse!.message.content.find((b) => b.type === "tool_use" && b.name === "TodoWrite");
    const todos = block?.input?.todos as Array<{ content: string; status: string; activeForm?: string }>;
    expect(todos).toEqual([
      { content: "Fix failing test", status: "in_progress", activeForm: "Fixing failing test" },
      { content: "Run test suite", status: "completed" },
    ]);
  });

  it("deduplicates identical plan updates for the same turn", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    const payload = {
      method: "turn/plan/updated",
      params: {
        turnId: "turn_plan_same",
        plan: {
          steps: [
            { content: "Implement fix", status: "in_progress" },
            { content: "Add tests", status: "pending" },
          ],
        },
      },
    };
    stdout.push(JSON.stringify(payload) + "\n");
    stdout.push(JSON.stringify(payload) + "\n");
    await tick();

    const todoToolUses = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "TodoWrite");
    });
    expect(todoToolUses).toHaveLength(1);
  });

  it("emits an empty TodoWrite when a previously non-empty plan is cleared", async () => {
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
        method: "turn/plan/updated",
        params: {
          turnId: "turn_plan_clear",
          plan: {
            steps: [
              { content: "Inspect worktree", status: "in_progress" },
              { content: "Run tests", status: "pending" },
            ],
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "turn/plan/updated",
        params: {
          turnId: "turn_plan_clear",
          plan: {
            steps: [],
          },
        },
      }) + "\n",
    );
    await tick();

    const todoToolUses = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (
        m as { message: { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } }
      ).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "TodoWrite");
    }) as Array<{ message: { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } }>;

    expect(todoToolUses).toHaveLength(2);
    const clearedBlock = todoToolUses[1]!.message.content.find((b) => b.type === "tool_use" && b.name === "TodoWrite");
    expect(clearedBlock?.input?.todos).toEqual([]);
  });

  it("fetches rate limits after initialization via account/rateLimits/read", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    // id:1 = initialize, id:2 = thread/start
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // id:3 = account/rateLimits/read response
    stdout.push(
      JSON.stringify({
        id: 3,
        result: {
          rateLimits: {
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 },
            secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1731552000 },
          },
        },
      }) + "\n",
    );
    await tick();

    const rl = adapter.getRateLimits();
    expect(rl).toBeDefined();
    expect(rl!.primary).toEqual({ usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 });
    expect(rl!.secondary).toEqual({ usedPercent: 10, windowDurationMins: 10080, resetsAt: 1731552000 });
  });

  it("updates rate limits on account/rateLimits/updated notification", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Send account/rateLimits/updated notification (no id = notification)
    stdout.push(
      JSON.stringify({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1730947200 },
            secondary: null,
          },
        },
      }) + "\n",
    );
    await tick();

    const rl = adapter.getRateLimits();
    expect(rl).toBeDefined();
    expect(rl!.primary).toEqual({ usedPercent: 50, windowDurationMins: 300, resetsAt: 1730947200 });
    expect(rl!.secondary).toBeNull();
  });

  it("normalizes fractional usedPercent (0..1) into percentage values", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: { usedPercent: 0.42, windowDurationMins: 300, resetsAt: 1730947200 },
            secondary: { usedPercent: 0.09, windowDurationMins: 10080, resetsAt: 1731552000 },
          },
        },
      }) + "\n",
    );
    await tick();

    const rl = adapter.getRateLimits();
    expect(rl).toBeDefined();
    expect(rl!.primary).toEqual({ usedPercent: 42, windowDurationMins: 300, resetsAt: 1730947200 });
    expect(rl!.secondary).toEqual({ usedPercent: 9, windowDurationMins: 10080, resetsAt: 1731552000 });
  });

  it("does not scale usedPercent:1 to 100 (treats integer 1 as 1%, not 0..1 fraction)", async () => {
    // Regression: usedPercent:1 (meaning 1%) was previously treated as 0..1 format
    // and multiplied by 100, displaying 100% when actual usage was 1%.
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1730947200 },
            secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1731552000 },
          },
        },
      }) + "\n",
    );
    await tick();

    const rl = adapter.getRateLimits();
    expect(rl).toBeDefined();
    expect(rl!.primary).toEqual({ usedPercent: 1, windowDurationMins: 300, resetsAt: 1730947200 });
    expect(rl!.secondary).toEqual({ usedPercent: 1, windowDurationMins: 10080, resetsAt: 1731552000 });
  });

  it("parses resetsAt when provided as numeric or ISO strings", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: "1730947200" },
            secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: "2026-02-26T12:00:00.000Z" },
          },
        },
      }) + "\n",
    );
    await tick();

    const rl = adapter.getRateLimits();
    expect(rl).toBeDefined();
    expect(rl!.primary).toEqual({ usedPercent: 12, windowDurationMins: 300, resetsAt: 1730947200 });
    expect(rl!.secondary).toEqual({
      usedPercent: 34,
      windowDurationMins: 10080,
      resetsAt: Date.parse("2026-02-26T12:00:00.000Z"),
    });
  });

  it("prefers canonical codex limits from rateLimitsByLimitId over model-specific zero buckets", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        id: 3,
        result: {
          rateLimits: {
            limitId: "codex_bengalfox",
            primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1731999999 },
            secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1732999999 },
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1730947200 },
              secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1731552000 },
            },
            codex_bengalfox: {
              limitId: "codex_bengalfox",
              primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1731999999 },
              secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1732999999 },
            },
          },
        },
      }) + "\n",
    );
    await tick();

    const rl = adapter.getRateLimits();
    expect(rl).toBeDefined();
    expect(rl!.primary).toEqual({ usedPercent: 3, windowDurationMins: 300, resetsAt: 1730947200 });
    expect(rl!.secondary).toEqual({ usedPercent: 5, windowDurationMins: 10080, resetsAt: 1731552000 });
  });

  it("does not regress to model-specific zero limits after canonical codex limits are known", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1730947200 },
            secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1731552000 },
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex_bengalfox",
            primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1731999999 },
            secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1732999999 },
          },
        },
      }) + "\n",
    );
    await tick();

    const rl = adapter.getRateLimits();
    expect(rl).toBeDefined();
    expect(rl!.primary).toEqual({ usedPercent: 7, windowDurationMins: 300, resetsAt: 1730947200 });
    expect(rl!.secondary).toEqual({ usedPercent: 4, windowDurationMins: 10080, resetsAt: 1731552000 });
  });

  // ── requestUserInput tests ──────────────────────────────────────────────

  it("forwards item/tool/requestUserInput as AskUserQuestion permission_request", async () => {
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
        method: "item/tool/requestUserInput",
        id: 700,
        params: {
          threadId: "thr_123",
          turnId: "turn_1",
          itemId: "item_1",
          questions: [
            {
              id: "q1",
              header: "Approach",
              question: "Which approach should I use?",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Option A", description: "First approach" },
                { label: "Option B", description: "Second approach" },
              ],
            },
          ],
        },
      }) + "\n",
    );
    await tick();

    const permReqs = messages.filter((m) => m.type === "permission_request");
    expect(permReqs.length).toBe(1);

    const perm = permReqs[0] as unknown as {
      request: {
        tool_name: string;
        input: { questions: Array<{ header: string; question: string; options: unknown[] }> };
      };
    };
    expect(perm.request.tool_name).toBe("AskUserQuestion");
    expect(perm.request.input.questions.length).toBe(1);
    expect(perm.request.input.questions[0].header).toBe("Approach");
    expect(perm.request.input.questions[0].options.length).toBe(2);
  });

  it("converts browser answers to Codex ToolRequestUserInputResponse format", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Send requestUserInput
    stdout.push(
      JSON.stringify({
        method: "item/tool/requestUserInput",
        id: 701,
        params: {
          threadId: "thr_123",
          turnId: "turn_1",
          itemId: "item_1",
          questions: [
            {
              id: "q_alpha",
              header: "Q1",
              question: "Pick one",
              isOther: false,
              isSecret: false,
              options: [{ label: "Yes", description: "" }],
            },
            {
              id: "q_beta",
              header: "Q2",
              question: "Pick another",
              isOther: false,
              isSecret: false,
              options: [{ label: "No", description: "" }],
            },
          ],
        },
      }) + "\n",
    );
    await tick();

    // Get the request_id from the emitted permission_request
    const permReq = messages.find((m) => m.type === "permission_request") as unknown as {
      request: { request_id: string };
    };
    expect(permReq).toBeDefined();

    // Send answer back via permission_response
    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: permReq.request.request_id,
      behavior: "allow",
      updated_input: { answers: { "0": "Yes", "1": "No" } },
    });
    await tick();

    // Check what was sent to Codex (should be ToolRequestUserInputResponse format)
    const allWritten = stdin.chunks.join("");
    const responseLine = allWritten.split("\n").find((l) => l.includes('"id":701'));
    expect(responseLine).toBeDefined();

    const response = JSON.parse(responseLine!);
    expect(response.result.answers).toBeDefined();
    expect(response.result.answers.q_alpha).toEqual({ answers: ["Yes"] });
    expect(response.result.answers.q_beta).toEqual({ answers: ["No"] });
  });

  // ── applyPatchApproval tests ──────────────────────────────────────────

  it("forwards applyPatchApproval as Edit permission_request", async () => {
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
        method: "applyPatchApproval",
        id: 800,
        params: {
          conversationId: "thr_123",
          callId: "call_patch_1",
          fileChanges: {
            "src/index.ts": {
              kind: "modify",
              unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
            },
            "src/utils.ts": { kind: "create" },
          },
          reason: "Refactoring imports",
          grantRoot: null,
        },
      }) + "\n",
    );
    await tick();

    const permReqs = messages.filter((m) => m.type === "permission_request");
    expect(permReqs.length).toBe(1);

    const perm = permReqs[0] as unknown as {
      request: {
        tool_name: string;
        input: {
          file_path: string;
          file_paths: string[];
          changes: Array<{ path: string; kind: string; diff?: string }>;
        };
        description: string;
      };
    };
    expect(perm.request.tool_name).toBe("Edit");
    expect(perm.request.input.file_path).toBe("src/index.ts");
    expect(perm.request.input.file_paths).toContain("src/index.ts");
    expect(perm.request.input.file_paths).toContain("src/utils.ts");
    expect(perm.request.input.changes[0].diff).toContain("@@ -1 +1 @@");
    expect(perm.request.description).toBe("Refactoring imports");
  });

  it("responds to applyPatchApproval with ReviewDecision format", async () => {
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
        method: "applyPatchApproval",
        id: 801,
        params: {
          conversationId: "thr_123",
          callId: "call_patch_2",
          fileChanges: { "file.ts": {} },
          reason: null,
          grantRoot: null,
        },
      }) + "\n",
    );
    await tick();

    const permReq = messages.find((m) => m.type === "permission_request") as unknown as {
      request: { request_id: string };
    };

    // Allow the patch
    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: permReq.request.request_id,
      behavior: "allow",
    });
    await tick();

    const allWritten = stdin.chunks.join("");
    const responseLine = allWritten.split("\n").find((l) => l.includes('"id":801'));
    expect(responseLine).toBeDefined();
    // Should use "approved" (ReviewDecision), NOT "accept"
    expect(responseLine).toContain('"approved"');
    expect(responseLine).not.toContain('"accept"');
  });

  // ── execCommandApproval tests ──────────────────────────────────────────

  it("forwards execCommandApproval as Bash permission_request", async () => {
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
        method: "execCommandApproval",
        id: 900,
        params: {
          conversationId: "thr_123",
          callId: "call_exec_1",
          command: ["npm", "install"],
          cwd: "/workspace",
          reason: "Installing dependencies",
          parsedCmd: [],
        },
      }) + "\n",
    );
    await tick();

    const permReqs = messages.filter((m) => m.type === "permission_request");
    expect(permReqs.length).toBe(1);

    const perm = permReqs[0] as unknown as {
      request: { tool_name: string; input: { command: string; cwd: string }; description: string };
    };
    expect(perm.request.tool_name).toBe("Bash");
    expect(perm.request.input.command).toBe("npm install");
    expect(perm.request.input.cwd).toBe("/workspace");
    expect(perm.request.description).toBe("Installing dependencies");
  });

  it("responds to execCommandApproval with ReviewDecision format (denied)", async () => {
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
        method: "execCommandApproval",
        id: 901,
        params: {
          conversationId: "thr_123",
          callId: "call_exec_2",
          command: ["rm", "-rf", "/"],
          cwd: "/",
          reason: null,
          parsedCmd: [],
        },
      }) + "\n",
    );
    await tick();

    const permReq = messages.find((m) => m.type === "permission_request") as unknown as {
      request: { request_id: string };
    };

    // Deny the command
    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: permReq.request.request_id,
      behavior: "deny",
    });
    await tick();

    const allWritten = stdin.chunks.join("");
    const responseLine = allWritten.split("\n").find((l) => l.includes('"id":901'));
    expect(responseLine).toBeDefined();
    // Should use "denied" (ReviewDecision), NOT "decline"
    expect(responseLine).toContain('"denied"');
    expect(responseLine).not.toContain('"decline"');
  });

  // ── MCP elicitation (mcpServer/elicitation/request) ───────────────────

  it("emits permission_request with mcp:server:tool format for elicitation", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "mcpServer/elicitation/request",
        id: 500,
        params: {
          serverName: "slack",
          message: 'Allow the slack MCP server to run tool "slack_send_message"?',
          _meta: {
            tool_description: "Send a message to a Slack channel",
            tool_params: { channel: "#general", text: "hello" },
          },
        },
      }) + "\n",
    );
    await tick();

    const permReqs = messages.filter((m) => m.type === "permission_request");
    expect(permReqs.length).toBe(1);

    const perm = permReqs[0] as unknown as {
      request: { tool_name: string; input: Record<string, unknown>; description: string };
    };
    expect(perm.request.tool_name).toBe("mcp:slack:slack_send_message");
    expect(perm.request.input).toEqual({ channel: "#general", text: "hello" });
    expect(perm.request.description).toContain("Send a message to a Slack channel");
  });

  it("maps allow to accept and deny to decline for elicitation responses", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "mcpServer/elicitation/request",
        id: 501,
        params: {
          serverName: "slack",
          message: 'Allow the slack MCP server to run tool "slack_send_message"?',
          _meta: { tool_params: {} },
        },
      }) + "\n",
    );
    await tick();

    const permReq = messages.find((m) => m.type === "permission_request") as unknown as {
      request: { request_id: string };
    };

    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: permReq.request.request_id,
      behavior: "allow",
    });
    await tick();

    let responseLine = stdin.chunks
      .join("")
      .split("\n")
      .find((l) => l.includes('"id":501'));
    expect(responseLine).toBeDefined();
    expect(responseLine).toContain('"action"');
    expect(responseLine).toContain('"accept"');
    expect(responseLine).not.toContain('"decision"');

    stdout.push(
      JSON.stringify({
        method: "mcpServer/elicitation/request",
        id: 502,
        params: {
          serverName: "slack",
          message: 'Allow the slack MCP server to run tool "slack_send_message"?',
          _meta: { tool_params: {} },
        },
      }) + "\n",
    );
    await tick();

    const secondPermReq = messages.filter((m) => m.type === "permission_request").at(-1) as unknown as {
      request: { request_id: string };
    };

    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: secondPermReq.request.request_id,
      behavior: "deny",
    });
    await tick();

    responseLine = stdin.chunks
      .join("")
      .split("\n")
      .find((l) => l.includes('"id":502'));
    expect(responseLine).toBeDefined();
    expect(responseLine).toContain('"action"');
    expect(responseLine).toContain('"decline"');
    expect(responseLine).not.toContain('"decision"');
  });

  it("falls back to 'elicitation' tool name when message format is unexpected", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "mcpServer/elicitation/request",
        id: 503,
        params: {
          serverName: "custom-server",
          message: "Some unexpected elicitation message format",
          _meta: { tool_params: { key: "value" } },
        },
      }) + "\n",
    );
    await tick();

    const permReqs = messages.filter((m) => m.type === "permission_request");
    expect(permReqs.length).toBe(1);

    const perm = permReqs[0] as unknown as {
      request: { tool_name: string };
    };
    expect(perm.request.tool_name).toBe("mcp:custom-server:elicitation");
  });

  // ── MCP server management (Codex app-server methods) ───────────────────

  it("surfaces MCP startup failure as failed MCP status without failing Codex init", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const initErrors: string[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));
    adapter.onInitError((error) => initErrors.push(error));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "mcpServer/startupStatus/updated",
        params: {
          name: "notion",
          status: "failed",
          error:
            'MCP client for `notion` failed to start: Auth(TokenRefreshFailed("Server returned error response: invalid_grant"))',
        },
      }) + "\n",
    );
    await tick();

    expect(initErrors).toHaveLength(0);
    const mcpStatus = messages.find((m) => m.type === "mcp_status") as
      | { type: "mcp_status"; servers: Array<{ name: string; status: string; error?: string }> }
      | undefined;
    expect(mcpStatus).toBeDefined();
    expect(mcpStatus!.servers).toContainEqual(
      expect.objectContaining({
        name: "notion",
        status: "failed",
        error: expect.stringContaining("invalid_grant"),
      }),
    );
    const update = messages.find((m) => m.type === "session_update") as
      | { type: "session_update"; session: { mcp_servers?: Array<{ name: string; status: string }> } }
      | undefined;
    expect(update?.session.mcp_servers).toContainEqual({ name: "notion", status: "failed" });
  });

  it("handles mcp_get_status via mcpServerStatus/list + config/read", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks.length = 0;
    adapter.sendBrowserMessage({ type: "mcp_get_status" });
    await tick();

    // id:4 = mcpServerStatus/list (id:3 is account/rateLimits/read)
    stdout.push(
      JSON.stringify({
        id: 4,
        result: {
          data: [
            {
              name: "alpha",
              authStatus: "oAuth",
              tools: {
                read_file: { name: "read_file", annotations: { readOnly: true } },
              },
            },
            {
              name: "beta",
              authStatus: "notLoggedIn",
              tools: {},
            },
          ],
          nextCursor: null,
        },
      }) + "\n",
    );
    await tick();

    // id:5 = config/read
    stdout.push(
      JSON.stringify({
        id: 5,
        result: {
          config: {
            mcp_servers: {
              alpha: { url: "http://localhost:8080/mcp", enabled: true },
              beta: { command: "npx", args: ["-y", "@test/server"], enabled: true },
            },
          },
        },
      }) + "\n",
    );
    await tick();

    const mcpStatus = messages.find((m) => m.type === "mcp_status") as
      | { type: "mcp_status"; servers: Array<{ name: string; status: string; tools?: unknown[]; error?: string }> }
      | undefined;
    expect(mcpStatus).toBeDefined();
    expect(mcpStatus!.servers.find((s) => s.name === "alpha")?.status).toBe("connected");
    expect(mcpStatus!.servers.find((s) => s.name === "beta")?.status).toBe("failed");
    expect(mcpStatus!.servers.find((s) => s.name === "beta")?.error).toContain("requires login");
    expect(mcpStatus!.servers.find((s) => s.name === "alpha")?.tools?.length).toBe(1);

    stdout.push(
      JSON.stringify({
        method: "mcpServer/startupStatus/updated",
        params: { name: "alpha", status: "failed", error: "invalid_grant" },
      }) + "\n",
    );
    await tick();

    const statusUpdates = messages.filter((m) => m.type === "mcp_status") as Array<{
      type: "mcp_status";
      servers: Array<{ name: string; status: string; error?: string; tools?: unknown[] }>;
    }>;
    const latestMcpStatus = statusUpdates[statusUpdates.length - 1];
    expect(latestMcpStatus.servers.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(latestMcpStatus.servers.find((s) => s.name === "alpha")?.error).toContain("invalid_grant");
    expect(latestMcpStatus.servers.find((s) => s.name === "alpha")?.tools?.length).toBe(1);

    stdout.push(
      JSON.stringify({
        method: "mcpServer/startupStatus/updated",
        params: { name: "alpha", status: "ready" },
      }) + "\n",
    );
    await tick();

    const readyStatusUpdates = messages.filter((m) => m.type === "mcp_status") as Array<{
      type: "mcp_status";
      servers: Array<{ name: string; status: string; error?: string; tools?: unknown[] }>;
    }>;
    const readyMcpStatus = readyStatusUpdates[readyStatusUpdates.length - 1];
    const alpha = readyMcpStatus.servers.find((s) => s.name === "alpha");
    expect(alpha).toMatchObject({ name: "alpha", status: "connected" });
    expect(alpha?.error).toBeUndefined();
    expect(alpha?.tools?.length).toBe(1);
  });

  it("handles mcp_toggle by writing config, reloading MCP, and refreshing status", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks.length = 0;
    adapter.sendBrowserMessage({ type: "mcp_toggle", serverName: "alpha", enabled: false });
    await tick();

    const allWritten = stdin.chunks.join("");
    const writeLine = allWritten.split("\n").find((l) => l.includes('"method":"config/value/write"'));
    expect(writeLine).toBeDefined();
    const writeReq = JSON.parse(writeLine!);
    expect(writeReq.params.keyPath).toBe("mcp_servers.alpha.enabled");
    expect(writeReq.params.value).toBe(false);

    // Respond to config/value/write with the actual request ID.
    stdout.push(JSON.stringify({ id: writeReq.id, result: { status: "updated" } }) + "\n");
    await tick();

    const afterWrite = stdin.chunks.join("");
    const reloadLine = afterWrite.split("\n").find((l) => l.includes('"method":"config/mcpServer/reload"'));
    expect(reloadLine).toBeDefined();
    const reloadReq = JSON.parse(reloadLine!);
    stdout.push(JSON.stringify({ id: reloadReq.id, result: {} }) + "\n");
    await tick();

    const afterReload = stdin.chunks.join("");
    const listLine = afterReload.split("\n").find((l) => l.includes('"method":"mcpServerStatus/list"'));
    expect(listLine).toBeDefined();
    const listReq = JSON.parse(listLine!);
    stdout.push(
      JSON.stringify({
        id: listReq.id,
        result: { data: [{ name: "alpha", tools: {}, authStatus: "oAuth" }], nextCursor: null },
      }) + "\n",
    );
    await tick();

    const afterList = stdin.chunks.join("");
    const readLine = afterList.split("\n").find((l) => l.includes('"method":"config/read"'));
    expect(readLine).toBeDefined();
    const readReq = JSON.parse(readLine!);
    stdout.push(
      JSON.stringify({
        id: readReq.id,
        result: { config: { mcp_servers: { alpha: { url: "http://localhost:8080/mcp", enabled: false } } } },
      }) + "\n",
    );
    await tick();

    const allWrittenAfter = stdin.chunks.join("");
    expect(allWrittenAfter).toContain('"method":"config/mcpServer/reload"');
    expect(allWrittenAfter).toContain('"method":"mcpServerStatus/list"');

    const mcpStatus = messages.find((m) => m.type === "mcp_status") as
      | { type: "mcp_status"; servers: Array<{ name: string; status: string }> }
      | undefined;
    expect(mcpStatus).toBeDefined();
    expect(mcpStatus!.servers[0].name).toBe("alpha");
    expect(mcpStatus!.servers[0].status).toBe("disabled");
  });

  it("handles mcp_set_servers by merging with existing config", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks.length = 0;
    adapter.sendBrowserMessage({
      type: "mcp_set_servers",
      servers: {
        memory: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
        },
      },
    });
    await tick();

    const allWritten = stdin.chunks.join("");
    const writeLine = allWritten.split("\n").find((l) => l.includes('"method":"config/batchWrite"'));
    expect(writeLine).toBeDefined();
    const writeReq = JSON.parse(writeLine!);
    expect(writeReq.params.edits).toHaveLength(1);
    expect(writeReq.params.edits[0].keyPath).toBe("mcp_servers.memory");
    expect(writeReq.params.edits[0].mergeStrategy).toBe("upsert");
    expect(writeReq.params.edits[0].value.command).toBe("npx");
    expect(writeReq.params.edits[0].value.args).toEqual(["-y", "@modelcontextprotocol/server-memory"]);

    // Complete in-flight requests
    stdout.push(JSON.stringify({ id: 4, result: { status: "updated" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 5, result: {} }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 6, result: { data: [], nextCursor: null } }) + "\n");
    await tick();
    stdout.push(
      JSON.stringify({ id: 7, result: { config: { mcp_servers: { memory: writeReq.params.edits[0].value } } } }) + "\n",
    );
    await tick();
  });

  it("mcp_toggle fallback removes server entry when reload fails with invalid transport", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks.length = 0;
    adapter.sendBrowserMessage({ type: "mcp_toggle", serverName: "context7", enabled: false });
    await tick();

    // First write ok, then reload fails with invalid transport
    stdout.push(JSON.stringify({ id: 4, result: { status: "updated" } }) + "\n");
    await tick();
    stdout.push(
      JSON.stringify({
        id: 5,
        error: { code: -32603, message: "Invalid configuration: invalid transport in `mcp_servers.context7`" },
      }) + "\n",
    );
    await tick();

    const written = stdin.chunks.join("");
    const lines = written.split("\n").filter(Boolean);
    const deleteWrite = lines
      .map((l) => JSON.parse(l))
      .find((msg) => msg.method === "config/value/write" && msg.params?.keyPath === "mcp_servers.context7");
    expect(deleteWrite).toBeDefined();
    expect(deleteWrite.params.value).toBe(null);
    expect(deleteWrite.params.mergeStrategy).toBe("replace");
  });

  it("handles mcp_reconnect by calling reload and then refreshing status", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdin.chunks.length = 0;
    adapter.sendBrowserMessage({ type: "mcp_reconnect", serverName: "alpha" });
    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"method":"config/mcpServer/reload"');

    // id:4 = reload, id:5 = mcpServerStatus/list, id:6 = config/read
    stdout.push(JSON.stringify({ id: 4, result: {} }) + "\n");
    await tick();
    stdout.push(
      JSON.stringify({
        id: 5,
        result: { data: [{ name: "alpha", tools: {}, authStatus: "oAuth" }], nextCursor: null },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        id: 6,
        result: { config: { mcp_servers: { alpha: { enabled: true, url: "http://localhost:8080/mcp" } } } },
      }) + "\n",
    );
    await tick();
  });

  it("computes context_used_percent from last turn, not cumulative total", async () => {
    // Regression: cumulative total.inputTokens can far exceed contextWindow
    // (e.g. 1.2M input on a 258k window). The context bar should use
    // last.inputTokens + last.outputTokens which reflects current turn usage.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Send a tokenUsage/updated with large cumulative totals but small last-turn
    stdout.push(
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thr_123",
          turnId: "turn_1",
          tokenUsage: {
            total: {
              totalTokens: 1_200_000,
              inputTokens: 1_150_000,
              cachedInputTokens: 930_000,
              outputTokens: 50_000,
              reasoningOutputTokens: 2_000,
            },
            last: {
              totalTokens: 90_000,
              inputTokens: 85_000,
              cachedInputTokens: 80_000,
              outputTokens: 5_000,
              reasoningOutputTokens: 200,
            },
            modelContextWindow: 258_400,
          },
        },
      }) + "\n",
    );

    await tick();

    // Find the session_update message
    const sessionUpdates = messages.filter((m) => m.type === "session_update") as Array<{
      type: "session_update";
      session: { context_used_percent?: number; codex_token_details?: Record<string, number> };
    }>;
    expect(sessionUpdates.length).toBeGreaterThan(0);

    const lastUpdate = sessionUpdates[sessionUpdates.length - 1];

    // context_used_percent should use last turn's input only (output tokens excluded,
    // they are generated, not context occupants). cachedInputTokens (80k) fits within
    // inputTokens (85k), so OpenAI semantics applies: use inputTokens directly.
    // 85000 / 258400 ≈ 33%
    expect(lastUpdate.session.context_used_percent).toBe(33);
    expect(lastUpdate.session.codex_token_details?.contextTokensUsed).toBe(85_000);

    // codex_token_details should still show cumulative totals
    expect(lastUpdate.session.codex_token_details?.inputTokens).toBe(1_150_000);
    expect(lastUpdate.session.codex_token_details?.outputTokens).toBe(50_000);
    expect(lastUpdate.session.codex_token_details?.cachedInputTokens).toBe(930_000);
  });

  it("applies additive cache semantics when cachedInputTokens exceeds inputTokens", async () => {
    // Native Anthropic semantics: inputTokens excludes cached portions and
    // the cache field is additive. This can happen if a future Codex backend
    // routes through native Anthropic token accounting.
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
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thr_123",
          turnId: "turn_1",
          tokenUsage: {
            total: { totalTokens: 100_000, inputTokens: 90_000, cachedInputTokens: 0, outputTokens: 10_000 },
            last: {
              totalTokens: 50_000,
              // inputTokens excludes cached (Anthropic semantics)
              inputTokens: 10_000,
              cachedInputTokens: 40_000,
              outputTokens: 5_000,
            },
            modelContextWindow: 200_000,
          },
        },
      }) + "\n",
    );

    await tick();

    const sessionUpdates = messages.filter((m) => m.type === "session_update") as Array<{
      type: "session_update";
      session: { context_used_percent?: number };
    }>;
    expect(sessionUpdates.length).toBeGreaterThan(0);

    const lastUpdate = sessionUpdates[sessionUpdates.length - 1];

    // Anthropic semantics: cachedInputTokens (40k) > inputTokens (10k),
    // so fields are additive: 10000 + 40000 = 50000 / 200000 = 25%
    expect(lastUpdate.session.context_used_percent).toBe(25);
  });
});
