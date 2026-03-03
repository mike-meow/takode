import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "./session-types.js";

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
    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "agentMessage", id: "item_1" } },
    }) + "\n");

    await tick();

    stdout.push(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { itemId: "item_1", delta: "Hello " },
    }) + "\n");

    stdout.push(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { itemId: "item_1", delta: "world!" },
    }) + "\n");

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

    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "agentMessage", id: "item_1" } },
    }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { itemId: "item_1", delta: "Hello world" },
    }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "item_1" } },
    }) + "\n");
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
    stdout.push(JSON.stringify({
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
    }) + "\n");

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

    stdout.push(JSON.stringify({
      method: "turn/completed",
      params: {
        turn: { id: "turn_1", status: "completed", items: [], error: null },
      },
    }) + "\n");

    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results.length).toBe(1);

    const result = results[0] as { data: { is_error: boolean; subtype: string } };
    expect(result.data.is_error).toBe(false);
    expect(result.data.subtype).toBe("success");
  });

  it("translates command_execution item to Bash tool_use with stream_event", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: ["ls", "-la"],
          cwd: "/tmp",
          status: "inProgress",
        },
      },
    }) + "\n");

    await tick();

    // Should emit content_block_start stream_event BEFORE the assistant message
    const blockStartEvents = messages.filter(
      (m) => m.type === "stream_event" && (m as { event: { type: string } }).event?.type === "content_block_start",
    );
    const toolUseBlockStart = blockStartEvents.find((m) => {
      const evt = (m as { event: { content_block?: { type: string; name?: string } } }).event;
      return evt.content_block?.type === "tool_use" && evt.content_block?.name === "Bash";
    });
    expect(toolUseBlockStart).toBeDefined();

    const assistantMsgs = messages.filter((m) => m.type === "assistant");
    const toolUseMsg = assistantMsgs.find((m) => {
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Bash");
    });

    expect(toolUseMsg).toBeDefined();
    const content = (toolUseMsg as { message: { content: Array<{ type: string; input?: { command: string } }> } }).message.content;
    const toolBlock = content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { command: string } }).input.command).toBe("ls -la");

    // Verify content_block_start comes before assistant message
    const blockStartIdx = messages.indexOf(toolUseBlockStart!);
    const assistantIdx = messages.indexOf(toolUseMsg!);
    expect(blockStartIdx).toBeLessThan(assistantIdx);
  });

  it("emits session_init with codex backend type", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "o4-mini",
      cwd: "/home/user/project",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    // Send init responses
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    const initMsgs = messages.filter((m) => m.type === "session_init");
    expect(initMsgs.length).toBe(1);

    const init = initMsgs[0] as { session: { backend_type: string; model: string; cwd: string } };
    expect(init.session.backend_type).toBe("codex");
    expect(init.session.model).toBe("o4-mini");
    expect(init.session.cwd).toBe("/home/user/project");
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

    const lines = stdin.chunks.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

    const lines = stdin.chunks.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

    const lines = stdin.chunks.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const turnStart = lines.find((line) => line.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect(turnStart.params.collaborationMode.mode).toBe("default");
  });

  it("retries turn/start without collaborationMode when server rejects the field", async () => {
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
    adapter.sendBrowserMessage({ type: "user_message", content: "fallback test" });
    await tick();

    // id=4 is turn/start here (initialize=1, thread/start=2, rateLimits/read=3)
    stdout.push(JSON.stringify({
      id: 4,
      error: { code: -32602, message: "invalid params: unknown field `collaborationMode`" },
    }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 5, result: { turn: { id: "turn_1" } } }) + "\n");
    await tick();

    const lines = stdin.chunks.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const turnStarts = lines.filter((line) => line.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0].params.collaborationMode.mode).toBe("plan");
    expect(turnStarts[1].params.collaborationMode).toBeUndefined();
  });

  it("sends localImage user inputs when local_images are provided", async () => {
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
      content: "Describe these files",
      local_images: ["/tmp/image-a.png", "/tmp/image-b.png"],
    });

    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"method":"turn/start"');
    expect(allWritten).toContain('"type":"localImage"');
    expect(allWritten).toContain("/tmp/image-a.png");
    expect(allWritten).toContain("/tmp/image-b.png");
  });

  it("sends approval response when receiving permission_response", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    // Complete initialization
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Simulate approval request
    stdout.push(JSON.stringify({
      method: "item/commandExecution/requestApproval",
      id: 100,
      params: {
        itemId: "item_cmd_1",
        command: ["npm", "test"],
        parsedCmd: "npm test",
      },
    }) + "\n");
    await tick();

    // Get the generated request_id
    const permRequest = messages.find((m) => m.type === "permission_request") as { request: { request_id: string } };
    expect(permRequest).toBeDefined();

    // Clear stdin to check response
    stdin.chunks = [];

    // Send approval
    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: permRequest.request.request_id,
      behavior: "allow",
    });

    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"decision":"accept"');
    expect(allWritten).toContain('"id":100');
  });

  it("sends decline response when permission is denied", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/commandExecution/requestApproval",
      id: 200,
      params: { itemId: "item_cmd_2", command: ["rm", "-rf", "/"], parsedCmd: "rm -rf /" },
    }) + "\n");
    await tick();

    const permRequest = messages.find((m) => m.type === "permission_request") as { request: { request_id: string } };
    stdin.chunks = [];

    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: permRequest.request.request_id,
      behavior: "deny",
    });

    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"decision":"decline"');
    expect(allWritten).toContain('"id":200');
  });

  it("includes tool_start_times in tool_use assistant messages for live timers", async () => {
    // Regression: Codex tool chips showed no ticking timer because tool_start_times
    // was missing from the emitted assistant message.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: { type: "commandExecution", id: "cmd_timer", command: ["echo", "hi"], status: "inProgress" },
      },
    }) + "\n");
    await tick();

    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "cmd_timer");
    });
    expect(toolUseMsg).toBeDefined();

    const startTimes = (toolUseMsg as { tool_start_times?: Record<string, number> }).tool_start_times;
    expect(startTimes).toBeDefined();
    expect(startTimes!["cmd_timer"]).toBeTypeOf("number");
    expect(startTimes!["cmd_timer"]).toBeGreaterThan(0);
  });

  it("translates fileChange item to Edit/Write tool_use", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // fileChange with "create" kind → Write tool
    // item/started without diff is deferred; item/completed provides the diff.
    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: { type: "fileChange", id: "fc_1", changes: [{ path: "/tmp/new-file.ts", kind: "create" }], status: "inProgress" },
      },
    }) + "\n");
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: { type: "fileChange", id: "fc_1", changes: [{ path: "/tmp/new-file.ts", kind: "create", diff: "+new content" }], status: "completed" },
      },
    }) + "\n");

    await tick();

    const assistantMsgs = messages.filter((m) => m.type === "assistant");
    const writeMsg = assistantMsgs.find((m) => {
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Write");
    });
    expect(writeMsg).toBeDefined();

    // fileChange with "modify" kind → Edit tool
    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: { type: "fileChange", id: "fc_2", changes: [{ path: "/tmp/existing.ts", kind: "modify" }], status: "inProgress" },
      },
    }) + "\n");
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: { type: "fileChange", id: "fc_2", changes: [{ path: "/tmp/existing.ts", kind: "modify", diff: "@@ -1 +1 @@\n-old\n+new" }], status: "completed" },
      },
    }) + "\n");

    await tick();

    const editMsg = messages.filter((m) => m.type === "assistant").find((m) => {
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Edit");
    });
    expect(editMsg).toBeDefined();
  });

  it("passes fileChange patch text through to Edit tool input when available", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: {
          type: "fileChange",
          id: "fc_patch",
          changes: [{
            path: "/tmp/existing.ts",
            kind: "modify",
            diff: "diff --git a/existing.ts b/existing.ts\n--- a/existing.ts\n+++ b/existing.ts\n@@ -1 +1 @@\n-old\n+new",
          }],
          status: "inProgress",
        },
      },
    }) + "\n");

    await tick();

    const assistant = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Edit");
    });
    expect(assistant).toBeDefined();

    const toolUse = (assistant as {
      message: { content: Array<{ type: string; name?: string; input?: { changes?: Array<{ diff?: string }> } }> };
    }).message.content.find((b) => b.type === "tool_use" && b.name === "Edit");

    expect(toolUse?.input?.changes?.[0]?.diff).toContain("@@ -1 +1 @@");
  });

  it("uses patch_apply_begin diffs when fileChange started payload is empty", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "codex/event/patch_apply_begin",
      params: {
        msg: {
          type: "patch_apply_begin",
          call_id: "fc_patch_begin",
          changes: {
            "/tmp/from-patch.ts": {
              type: "update",
              unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
            },
          },
        },
      },
    }) + "\n");

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: {
          type: "fileChange",
          id: "fc_patch_begin",
          changes: [],
          status: "inProgress",
        },
      },
    }) + "\n");

    await tick();

    const assistant = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "fc_patch_begin" && b.name === "Edit");
    });
    expect(assistant).toBeDefined();

    const toolUse = (assistant as {
      message: { content: Array<{ type: string; id?: string; name?: string; input?: { file_path?: string; changes?: Array<{ diff?: string }> } }> };
    }).message.content.find((b) => b.type === "tool_use" && b.id === "fc_patch_begin");
    expect(toolUse?.input?.file_path).toBe("/tmp/from-patch.ts");
    expect(toolUse?.input?.changes?.[0]?.diff).toContain("@@ -1 +1 @@");
  });

  it("defers empty fileChange start until completed payload provides diff", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: {
          type: "fileChange",
          id: "fc_late_diff",
          changes: [],
          status: "inProgress",
        },
      },
    }) + "\n");
    await tick();

    const earlyToolUse = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "fc_late_diff");
    });
    expect(earlyToolUse).toBeUndefined();

    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          id: "fc_late_diff",
          changes: [{
            path: "/tmp/later.ts",
            kind: "modify",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          }],
          status: "completed",
        },
      },
    }) + "\n");
    await tick();

    const toolUseAfterComplete = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string; name?: string; input?: { changes?: Array<{ diff?: string }> } }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "fc_late_diff" && b.name === "Edit" && !!b.input?.changes?.[0]?.diff);
    });
    expect(toolUseAfterComplete).toBeDefined();
  });

  it("defers fileChange with path/kind but no diff until completed provides diff", async () => {
    // Regression: item/started with changes containing path/kind but no diff field
    // was emitted immediately, causing ToolBlock to show "No changes".
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // item/started with path and kind, but NO diff
    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: {
          type: "fileChange",
          id: "fc_no_diff",
          changes: [{ path: "/tmp/nodiff.ts", kind: "modify" }],
          status: "inProgress",
        },
      },
    }) + "\n");
    await tick();

    // tool_use should NOT have been emitted yet (no diff data)
    const earlyToolUse = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "fc_no_diff");
    });
    expect(earlyToolUse).toBeUndefined();

    // item/completed with actual diff
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          id: "fc_no_diff",
          changes: [{
            path: "/tmp/nodiff.ts",
            kind: "modify",
            diff: "@@ -1 +1 @@\n-before\n+after\n",
          }],
          status: "completed",
        },
      },
    }) + "\n");
    await tick();

    // Now tool_use should exist with the diff from completed
    const toolUse = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string; name?: string; input?: { changes?: Array<{ diff?: string }> } }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "fc_no_diff" && b.name === "Edit" && !!b.input?.changes?.[0]?.diff);
    });
    expect(toolUse).toBeDefined();
  });

  it("sends turn/interrupt on interrupt message", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();
    // Respond to account/rateLimits/read (id: 3, fired after init)
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    // Send a user message first to establish a turn
    adapter.sendBrowserMessage({ type: "user_message", content: "Do something" });
    await tick();

    // Simulate turn/start response (provides a turn ID — id bumped to 4 due to rateLimits/read)
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_1" } } }) + "\n");
    await tick();

    stdin.chunks = [];

    adapter.sendBrowserMessage({ type: "interrupt" });
    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"method":"turn/interrupt"');
    expect(allWritten).toContain("thr_123");
    expect(allWritten).toContain("turn_1");
  });

  it("translates error turn/completed to error result", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "turn/completed",
      params: {
        turn: { id: "turn_1", status: "failed", error: { message: "Rate limit exceeded" } },
      },
    }) + "\n");

    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results.length).toBe(1);

    const result = results[0] as { data: { is_error: boolean; subtype: string; result: string } };
    expect(result.data.is_error).toBe(true);
    expect(result.data.subtype).toBe("error_during_execution");
    expect(result.data.result).toBe("Rate limit exceeded");
  });

  it("emits result for interrupted turn/completed so session returns to idle", async () => {
    // Interrupted turns must still emit a result so the server transitions
    // to idle. For internal interrupts (new message mid-turn), the next
    // turn/start immediately sets generating=true again.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "turn/completed",
      params: {
        turn: { id: "turn_1", status: "interrupted", items: [], error: null },
      },
    }) + "\n");
    await tick();

    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const resultData = (results[0] as { data: { subtype: string; is_error: boolean; stop_reason: string } }).data;
    expect(resultData.subtype).toBe("success");
    expect(resultData.is_error).toBe(false);
    expect(resultData.stop_reason).toBe("interrupted");
  });

  it("returns false for unsupported outgoing message types", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    expect(adapter.sendBrowserMessage({ type: "set_model", model: "gpt-5.3-codex" })).toBe(false);
    expect(adapter.sendBrowserMessage({ type: "set_permission_mode", mode: "plan" })).toBe(false);
  });

  it("translates webSearch item to WebSearch tool_use", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: { type: "webSearch", id: "ws_1", query: "typescript generics guide" },
      },
    }) + "\n");

    await tick();

    const toolMsg = messages.filter((m) => m.type === "assistant").find((m) => {
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "WebSearch");
    });
    expect(toolMsg).toBeDefined();

    const content = (toolMsg as { message: { content: Array<{ type: string; input?: { query: string } }> } }).message.content;
    const toolBlock = content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { query: string } }).input.query).toBe("typescript generics guide");
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

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: {
          type: "webSearch",
          id: "ws_action_query",
          action: { type: "search", query: "codex cli skills documentation" },
        },
      },
    }) + "\n");

    await tick();

    const toolMsg = messages.filter((m) => m.type === "assistant").find((m) => {
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "WebSearch");
    });
    expect(toolMsg).toBeDefined();

    const content = (toolMsg as { message: { content: Array<{ type: string; input?: { query: string } }> } }).message.content;
    const toolBlock = content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { query: string } }).input.query).toBe("codex cli skills documentation");
  });

  it("calls onSessionMeta with thread ID after initialization", async () => {
    const metaCalls: Array<{ cliSessionId?: string; model?: string }> = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "gpt-5.2-codex", cwd: "/project" });
    adapter.onSessionMeta((meta) => metaCalls.push(meta));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_456" } } }) + "\n");
    await tick();

    expect(metaCalls.length).toBe(1);
    expect(metaCalls[0].cliSessionId).toBe("thr_456");
    expect(metaCalls[0].model).toBe("gpt-5.2-codex");
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
    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "webSearch", id: "ws_1", query: "typescript guide" } },
    }) + "\n");
    await tick();

    // item/completed for webSearch
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "webSearch",
          id: "ws_1",
          query: "typescript guide",
          action: { type: "navigate", url: "https://example.com/guide" },
        },
      },
    }) + "\n");
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

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: {
          type: "webSearch",
          id: "ws_2",
          query: "Codex CLI skills documentation",
        },
      },
    }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
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
    }) + "\n");
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
    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: { type: "webSearch", id: "ws_echo", query: "Codex CLI skills documentation" },
      },
    }) + "\n");
    await tick();

    // item/completed — only has query, no real result fields. The adapter's
    // extractWebSearchResultText falls through to "Web search completed" or
    // returns the query itself.
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "webSearch",
          id: "ws_echo",
          query: "Codex CLI skills documentation",
        },
      },
    }) + "\n");
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
    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "reasoning", id: "r_1", summary: "Thinking about the problem..." } },
    }) + "\n");
    await tick();

    // item/completed for reasoning (should close thinking block)
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "reasoning", id: "r_1", summary: "Thinking about the problem..." } },
    }) + "\n");
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

    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "reasoning", id: "r_obj" } },
    }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "reasoning",
          id: "r_obj",
          summary: { text: "Structured reasoning summary" },
        },
      },
    }) + "\n");
    await tick();

    const thinkingMsgs = messages.filter((m) =>
      m.type === "assistant"
      && (m as { message: { content: Array<{ type: string }> } }).message.content.some((b) => b.type === "thinking"),
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
    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "reasoning", id: "r_t1", summary: "First summary" } },
    }) + "\n");
    await tick();
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "reasoning", id: "r_t1", summary: "First summary" } },
    }) + "\n");
    await tick();

    // Second reasoning summary arrives shortly after the first one completed.
    await new Promise((r) => setTimeout(r, 20));
    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "reasoning", id: "r_t2", summary: "Second summary" } },
    }) + "\n");
    await tick();
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "reasoning", id: "r_t2", summary: "Second summary" } },
    }) + "\n");
    await tick();

    const reasoningAssistants = messages.filter((m) =>
      m.type === "assistant"
      && (m as { message: { content: Array<{ type: string }> } }).message.content.some((b) => b.type === "thinking"),
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
  ])("maps approvalMode=$approvalMode askPermission=$askPermission to kebab-case approvalPolicy=$expected", async ({ approvalMode, askPermission, expected }) => {
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
      model: "gpt-5.2-codex",
      cwd: "/workspace/app",
    });

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"model":"gpt-5.2-codex"');
    expect(allWritten).toContain('"cwd":"/workspace/app"');
  });

  // ── Init error handling ────────────────────────────────────────────────────

  it("calls onInitError when initialization fails", async () => {
    const errors: string[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onInitError((err) => errors.push(err));

    await tick();

    // Send an error response to the initialize request
    stdout.push(JSON.stringify({
      id: 1,
      error: { code: -1, message: "server not ready" },
    }) + "\n");

    await tick();

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("initialization failed");
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
    stdout.push(JSON.stringify({
      id: 1,
      error: { code: -1, message: "no rollout found" },
    }) + "\n");

    await tick();

    // After init failure, new messages should be rejected
    const rejected = adapter.sendBrowserMessage({ type: "user_message", content: "world" } as any);
    expect(rejected).toBe(false);

    // The error message should have been emitted to the browser
    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeDefined();
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
    mock.stdout.push(JSON.stringify({
      id: 2,
      error: { code: -1, message: "no rollout found for thread id thr_stale_123" },
    }) + "\n");
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

  // ── Backfill tool_use when item/started is missing ──────────────────────────

  it("backfills tool_use when item/completed arrives without item/started", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    // Initialize
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Skip item/started — go directly to item/completed for a commandExecution
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: ["ls", "-la"],
          status: "completed",
          exitCode: 0,
          stdout: "file1.txt\nfile2.txt",
        },
      },
    }) + "\n");

    await tick();

    // Should have both a tool_use (backfilled) and a tool_result
    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Bash");
    });
    expect(toolUseMsg).toBeDefined();

    const toolResultMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result" && b.tool_use_id === "cmd_1");
    });
    expect(toolResultMsg).toBeDefined();
  });

  it("does not double-emit tool_use when item/started was received", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    // Initialize
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Send item/started first
    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: { type: "commandExecution", id: "cmd_2", command: ["echo", "hi"], status: "inProgress" },
      },
    }) + "\n");
    await tick();

    // Then item/completed
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd_2",
          command: ["echo", "hi"],
          status: "completed",
          exitCode: 0,
          stdout: "hi",
        },
      },
    }) + "\n");
    await tick();

    // Count tool_use messages for cmd_2 — should be exactly 1 (from item/started only)
    const toolUseMessages = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "cmd_2");
    });
    expect(toolUseMessages.length).toBe(1);
  });

  // ── Codex string command format (vs Claude Code array format) ─────────────
  // Codex sends `command` as a STRING (e.g., "/bin/zsh -lc 'cat README.md'"),
  // while Claude Code uses arrays. The adapter must handle both and normalize
  // shell-wrapper commands to keep terminal blocks readable.

  it("handles string command (Codex format) in commandExecution item/started", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Codex sends command as a single string, not an array
    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd_str_1",
          command: "/bin/zsh -lc 'cat README.md'",
          status: "inProgress",
        },
      },
    }) + "\n");
    await tick();

    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Bash");
    });
    expect(toolUseMsg).toBeDefined();

    const content = (toolUseMsg as { message: { content: Array<{ type: string; input?: { command: string } }> } }).message.content;
    const toolBlock = content.find((b) => b.type === "tool_use");
    // Shell wrapper should be unwrapped for display parity with Claude.
    expect((toolBlock as { input: { command: string } }).input.command).toBe("cat README.md");
  });

  it("backfills tool_use with string command when item/started is missing", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Skip item/started — go directly to item/completed with string command
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd_str_2",
          command: "/bin/zsh -lc 'ls -la'",
          status: "completed",
          exitCode: 0,
          stdout: "total 42\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 .",
        },
      },
    }) + "\n");
    await tick();

    // Should have both a backfilled tool_use and a tool_result
    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Bash");
    });
    expect(toolUseMsg).toBeDefined();

    const content = (toolUseMsg as { message: { content: Array<{ type: string; input?: { command: string } }> } }).message.content;
    const toolBlock = content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { command: string } }).input.command).toBe("ls -la");

    const toolResultMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result" && b.tool_use_id === "cmd_str_2");
    });
    expect(toolResultMsg).toBeDefined();
  });

  it("handles string command in approval request (Codex format)", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Codex sends command as string in approval requests too
    stdout.push(JSON.stringify({
      method: "item/commandExecution/requestApproval",
      id: 300,
      params: {
        itemId: "item_cmd_str",
        threadId: "thr_123",
        turnId: "turn_1",
        command: "/bin/zsh -lc 'rm -rf /tmp/test'",
        cwd: "/home/user",
      },
    }) + "\n");
    await tick();

    const permRequests = messages.filter((m) => m.type === "permission_request");
    expect(permRequests.length).toBe(1);

    const perm = permRequests[0] as unknown as { request: { tool_name: string; input: { command: string } } };
    expect(perm.request.tool_name).toBe("Bash");
    // Shell wrapper should be unwrapped for cleaner permission text.
    expect(perm.request.input.command).toBe("rm -rf /tmp/test");
  });

  it("prefers commandActions command for commandExecution display when present", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd_actions_1",
          command: "/bin/bash -lc 'cat README.md'",
          commandActions: [{ type: "read", command: "cat README.md" }],
          status: "inProgress",
        },
      },
    }) + "\n");
    await tick();

    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "cmd_actions_1");
    });
    expect(toolUseMsg).toBeDefined();

    const content = (toolUseMsg as { message: { content: Array<{ type: string; input?: { command: string } }> } }).message.content;
    const toolBlock = content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { command: string } }).input.command).toBe("cat README.md");
  });

  // ── Message queuing during initialization ────────────────────────────────

  it("queues user_message sent before init completes and flushes after", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    // Send a message BEFORE init completes — should be queued
    const accepted = adapter.sendBrowserMessage({
      type: "user_message",
      content: "hello",
    });
    expect(accepted).toBe(true); // accepted into queue

    // Now complete initialization (initialize → thread/start → rateLimits)
    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();
    // Rate limits response is awaited before flushing queued messages
    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    await tick();

    // The queued message should have been flushed — check that turn/start was called
    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"method":"turn/start"');
    expect(allWritten).toContain('"text":"hello"');
  });

  it("emits stream_event content_block_start for tool_use on all tool item types", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Test commandExecution
    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd_x", command: ["echo", "hi"], status: "inProgress" } },
    }) + "\n");
    await tick();

    // Test webSearch
    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "webSearch", id: "ws_x", query: "test" } },
    }) + "\n");
    await tick();

    // Test fileChange (deferred until completed provides diff)
    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "fileChange", id: "fc_x", changes: [{ path: "/tmp/f.ts", kind: "modify" }], status: "inProgress" } },
    }) + "\n");
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "fileChange", id: "fc_x", changes: [{ path: "/tmp/f.ts", kind: "modify", diff: "@@ -1 +1 @@\n-a\n+b" }], status: "completed" } },
    }) + "\n");
    await tick();

    // All three should have content_block_start stream events
    const blockStarts = messages.filter(
      (m) => m.type === "stream_event" && (m as { event: { type: string } }).event?.type === "content_block_start"
            && (m as { event: { content_block?: { type: string } } }).event?.content_block?.type === "tool_use",
    );
    expect(blockStarts.length).toBe(3);
  });

  it("emits null stop_reason in agentMessage completion (not end_turn)", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Start agent message
    stdout.push(JSON.stringify({
      method: "item/started",
      params: { item: { type: "agentMessage", id: "am_1" } },
    }) + "\n");
    await tick();

    // Complete it
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "am_1", text: "Hello" } },
    }) + "\n");
    await tick();

    // Find the message_delta stream event
    const messageDelta = messages.find(
      (m) => m.type === "stream_event" && (m as { event: { type: string } }).event?.type === "message_delta",
    );
    expect(messageDelta).toBeDefined();

    const delta = (messageDelta as { event: { delta: { stop_reason: unknown } } }).event.delta;
    expect(delta.stop_reason).toBeNull();
  });

  // ── MCP tool call approval routing ────────────────────────────────────────

  it("routes MCP tool call approval to browser UI instead of auto-accepting", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Simulate MCP tool call approval request
    stdout.push(JSON.stringify({
      method: "item/mcpToolCall/requestApproval",
      id: 400,
      params: {
        itemId: "mcp_item_1",
        threadId: "thr_123",
        turnId: "turn_1",
        server: "my-mcp-server",
        tool: "search_files",
        arguments: { query: "TODO", path: "/src" },
        reason: "MCP tool wants to search files",
      },
    }) + "\n");
    await tick();

    // Should emit a permission_request to the browser (NOT auto-accept)
    const permRequests = messages.filter((m) => m.type === "permission_request");
    expect(permRequests.length).toBe(1);

    const perm = permRequests[0] as unknown as {
      request: { tool_name: string; input: Record<string, unknown>; description: string; tool_use_id: string };
    };
    expect(perm.request.tool_name).toBe("mcp:my-mcp-server:search_files");
    expect(perm.request.input).toEqual({ query: "TODO", path: "/src" });
    expect(perm.request.description).toBe("MCP tool wants to search files");
    expect(perm.request.tool_use_id).toBe("mcp_item_1");
  });

  it("sends approval response for MCP tool call when user allows", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/mcpToolCall/requestApproval",
      id: 401,
      params: {
        itemId: "mcp_item_2",
        server: "db-server",
        tool: "run_query",
        arguments: { sql: "SELECT * FROM users" },
      },
    }) + "\n");
    await tick();

    const permRequest = messages.find((m) => m.type === "permission_request") as {
      request: { request_id: string };
    };
    expect(permRequest).toBeDefined();

    stdin.chunks = [];

    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: permRequest.request.request_id,
      behavior: "allow",
    });
    await tick();

    const allWritten = stdin.chunks.join("");
    expect(allWritten).toContain('"decision":"accept"');
    expect(allWritten).toContain('"id":401');
  });

  // ── File change approval with file paths ────────────────────────────────

  it("includes file paths in file change approval request", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Simulate file change approval with changes array
    stdout.push(JSON.stringify({
      method: "item/fileChange/requestApproval",
      id: 500,
      params: {
        itemId: "fc_approval_1",
        threadId: "thr_123",
        turnId: "turn_1",
        changes: [
          { path: "/src/index.ts", kind: "modify" },
          { path: "/src/utils.ts", kind: "create" },
        ],
      },
    }) + "\n");
    await tick();

    const permRequests = messages.filter((m) => m.type === "permission_request");
    expect(permRequests.length).toBe(1);

    const perm = permRequests[0] as unknown as {
      request: {
        tool_name: string;
        input: { file_paths?: string[]; changes?: Array<{ path: string; kind: string }> };
        description: string;
      };
    };
    expect(perm.request.tool_name).toBe("Edit");
    expect(perm.request.input.file_paths).toEqual(["/src/index.ts", "/src/utils.ts"]);
    expect(perm.request.input.changes).toEqual([
      { path: "/src/index.ts", kind: "modify" },
      { path: "/src/utils.ts", kind: "create" },
    ]);
    expect(perm.request.description).toContain("/src/index.ts");
    expect(perm.request.description).toContain("/src/utils.ts");
  });

  it("falls back to generic description when file change approval has no changes", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Simulate file change approval without changes array
    stdout.push(JSON.stringify({
      method: "item/fileChange/requestApproval",
      id: 501,
      params: {
        itemId: "fc_approval_2",
        reason: "Updating configuration",
      },
    }) + "\n");
    await tick();

    const permRequests = messages.filter((m) => m.type === "permission_request");
    expect(permRequests.length).toBe(1);

    const perm = permRequests[0] as unknown as {
      request: { description: string; input: { description: string; file_paths?: string[] } };
    };
    expect(perm.request.description).toBe("Updating configuration");
    expect(perm.request.input.file_paths).toBeUndefined();
  });

  it("uses thread/start when no threadId is provided", async () => {
    const mock = createMockProcess();

    new CodexAdapter(mock.proc as never, "test-session", {
      model: "gpt-5.3-codex",
      cwd: "/workspace",
    });

    await tick();

    mock.stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();

    const allWritten = mock.stdin.chunks.join("");
    expect(allWritten).toContain('"method":"thread/start"');
    expect(allWritten).not.toContain('"method":"thread/resume"');
  });

  it("routes item/tool/call to permission_request instead of auto-responding", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Simulate item/tool/call request from Codex
    stdout.push(JSON.stringify({
      method: "item/tool/call",
      id: 600,
      params: {
        callId: "call_abc123",
        tool: "my_custom_tool",
        arguments: { query: "test input" },
      },
    }) + "\n");
    await tick();

    const permRequests = messages.filter((m) => m.type === "permission_request");
    expect(permRequests.length).toBe(1);
    const perm = permRequests[0] as { request: { request_id: string; tool_name: string; tool_use_id: string; input: Record<string, unknown> } };

    expect(perm.request.request_id).toContain("codex-dynamic-");
    expect(perm.request.tool_name).toBe("dynamic:my_custom_tool");
    expect(perm.request.tool_use_id).toBe("call_abc123");
    expect(perm.request.input.query).toBe("test input");
    expect(perm.request.input.call_id).toBe("call_abc123");
  });

  it("responds to item/tool/call with DynamicToolCallResponse after allow", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/tool/call",
      id: 601,
      params: {
        callId: "call_def456",
        tool: "code_interpreter",
        arguments: { code: "print('hello')" },
      },
    }) + "\n");
    await tick();

    const perm = messages.find((m) => m.type === "permission_request") as {
      request: { request_id: string };
    };
    expect(perm).toBeDefined();

    stdin.chunks = [];
    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: perm.request.request_id,
      behavior: "allow",
      updated_input: {
        success: true,
        contentItems: [{ type: "inputText", text: "custom tool output" }],
      },
    });
    await tick();

    const allWritten = stdin.chunks.join("");
    const responseLines = allWritten.split("\n").filter((l) => l.includes('"id":601'));
    expect(responseLines.length).toBeGreaterThanOrEqual(1);
    const responseLine = responseLines[0];
    expect(responseLine).toContain('"success":true');
    expect(responseLine).toContain('"contentItems"');
    expect(responseLine).toContain("custom tool output");
    expect(responseLine).not.toContain('"decision"');
  });

  it("emits tool_use and deferred error tool_result for item/tool/call timeout", async () => {
    vi.useFakeTimers();
    try {
      const messages: BrowserIncomingMessage[] = [];
      const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
      adapter.onBrowserMessage((msg) => messages.push(msg));

      await vi.advanceTimersByTimeAsync(50);
      stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
      await vi.advanceTimersByTimeAsync(20);
      stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
      await vi.advanceTimersByTimeAsync(50);

      stdout.push(JSON.stringify({
        method: "item/tool/call",
        id: 602,
        params: {
          callId: "call_timeout_1",
          tool: "slow_tool",
          arguments: { input: "x" },
        },
      }) + "\n");
      await vi.advanceTimersByTimeAsync(50);

      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(20);

      const toolUseMsg = messages.find((m) => {
        if (m.type !== "assistant") return false;
        const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_use" && b.name === "dynamic:slow_tool");
      });
      expect(toolUseMsg).toBeDefined();

      const toolResultMsg = messages.find((m) => {
        if (m.type !== "assistant") return false;
        const content = (m as { message: { content: Array<{ type: string; is_error?: boolean }> } }).message.content;
        return content.some((b) => b.type === "tool_result" && b.is_error === true);
      });
      expect(toolResultMsg).toBeDefined();

      const allWritten = stdin.chunks.join("");
      const responseLines = allWritten.split("\n").filter((l) => l.includes('"id":602'));
      expect(responseLines.length).toBeGreaterThanOrEqual(1);
      expect(responseLines[0]).toContain('"success":false');
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit tool_result for successful command with no output", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // Command completed with no stdout/stderr and exit code 0
    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd_silent",
          command: "mkdir -p /tmp/newdir",
          status: "completed",
          exitCode: 0,
        },
      },
    }) + "\n");
    await tick();

    // Should still emit tool_use so the command is visible
    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "cmd_silent");
    });
    expect(toolUseMsg).toBeDefined();

    // But should not emit a synthetic success tool_result
    const toolResultMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result" && b.tool_use_id === "cmd_silent");
    });
    expect(toolResultMsg).toBeUndefined();
  });

  it("uses aggregatedOutput when command completion omits stdout/stderr", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "cmd_agg",
          command: "git status --short",
          status: "completed",
          aggregatedOutput: " M src/index.ts\n",
          exitCode: 0,
        },
      },
    }) + "\n");
    await tick();

    const toolResultMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result" && b.tool_use_id === "cmd_agg");
    }) as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } } | undefined;

    expect(toolResultMsg).toBeDefined();
    const resultBlock = toolResultMsg!.message.content.find((b) => b.type === "tool_result" && b.tool_use_id === "cmd_agg");
    expect(resultBlock?.content).toContain("src/index.ts");
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

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: { type: "commandExecution", id: "cmd_fail", command: "sed -n '1,260p' missing.ts", status: "inProgress" },
      },
    }) + "\n");
    await tick();

    // Simulate codex sending streamed terminal output but no final stdout/stderr fields.
    stdout.push(JSON.stringify({
      method: "item/commandExecution/outputDelta",
      params: {
        itemId: "cmd_fail",
        delta: "sed: can't read missing.ts: No such file or directory\n",
      },
    }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
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
    }) + "\n");
    await tick();

    const toolResultMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result" && b.tool_use_id === "cmd_fail");
    }) as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } } | undefined;

    expect(toolResultMsg).toBeDefined();
    const resultBlock = toolResultMsg!.message.content.find((b) => b.type === "tool_result" && b.tool_use_id === "cmd_fail");
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

    stdout.push(JSON.stringify({
      method: "item/started",
      params: {
        item: { type: "commandExecution", id: "cmd_live", command: "long-running.sh", status: "inProgress" },
      },
    }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "item/commandExecution/outputDelta",
      params: {
        itemId: "cmd_live",
        delta: "step 1/3 complete\n",
      },
    }) + "\n");
    await tick();

    const progressMsg = messages.find(
      (m) => m.type === "tool_progress" && (m as { tool_use_id?: string }).tool_use_id === "cmd_live",
    ) as { type: "tool_progress"; output_delta?: string; elapsed_time_seconds: number } | undefined;
    expect(progressMsg).toBeDefined();
    expect(progressMsg?.output_delta).toBe("step 1/3 complete\n");
    expect(progressMsg?.elapsed_time_seconds).toBeGreaterThanOrEqual(0);
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

    stdout.push(JSON.stringify({
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
    }) + "\n");
    await tick();

    const todoToolUse = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } }).message.content;
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

  it("fetches rate limits after initialization via account/rateLimits/read", async () => {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });

    await tick();

    // id:1 = initialize, id:2 = thread/start
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // id:3 = account/rateLimits/read response
    stdout.push(JSON.stringify({
      id: 3,
      result: {
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 },
          secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1731552000 },
        },
      },
    }) + "\n");
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
    stdout.push(JSON.stringify({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1730947200 },
          secondary: null,
        },
      },
    }) + "\n");
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

    stdout.push(JSON.stringify({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          primary: { usedPercent: 0.42, windowDurationMins: 300, resetsAt: 1730947200 },
          secondary: { usedPercent: 0.09, windowDurationMins: 10080, resetsAt: 1731552000 },
        },
      },
    }) + "\n");
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

    stdout.push(JSON.stringify({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1730947200 },
          secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1731552000 },
        },
      },
    }) + "\n");
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

    stdout.push(JSON.stringify({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: "1730947200" },
          secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: "2026-02-26T12:00:00.000Z" },
        },
      },
    }) + "\n");
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

    stdout.push(JSON.stringify({
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
    }) + "\n");
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

    stdout.push(JSON.stringify({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1730947200 },
          secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1731552000 },
        },
      },
    }) + "\n");
    await tick();

    stdout.push(JSON.stringify({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex_bengalfox",
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1731999999 },
          secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1732999999 },
        },
      },
    }) + "\n");
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

    stdout.push(JSON.stringify({
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
    }) + "\n");
    await tick();

    const permReqs = messages.filter((m) => m.type === "permission_request");
    expect(permReqs.length).toBe(1);

    const perm = permReqs[0] as unknown as {
      request: { tool_name: string; input: { questions: Array<{ header: string; question: string; options: unknown[] }> } };
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
    stdout.push(JSON.stringify({
      method: "item/tool/requestUserInput",
      id: 701,
      params: {
        threadId: "thr_123",
        turnId: "turn_1",
        itemId: "item_1",
        questions: [
          { id: "q_alpha", header: "Q1", question: "Pick one", isOther: false, isSecret: false, options: [{ label: "Yes", description: "" }] },
          { id: "q_beta", header: "Q2", question: "Pick another", isOther: false, isSecret: false, options: [{ label: "No", description: "" }] },
        ],
      },
    }) + "\n");
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

    stdout.push(JSON.stringify({
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
    }) + "\n");
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

    stdout.push(JSON.stringify({
      method: "applyPatchApproval",
      id: 801,
      params: {
        conversationId: "thr_123",
        callId: "call_patch_2",
        fileChanges: { "file.ts": {} },
        reason: null,
        grantRoot: null,
      },
    }) + "\n");
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

    stdout.push(JSON.stringify({
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
    }) + "\n");
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

    stdout.push(JSON.stringify({
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
    }) + "\n");
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

  // ── MCP server management (Codex app-server methods) ───────────────────

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
    stdout.push(JSON.stringify({
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
    }) + "\n");
    await tick();

    // id:5 = config/read
    stdout.push(JSON.stringify({
      id: 5,
      result: {
        config: {
          mcp_servers: {
            alpha: { url: "http://localhost:8080/mcp", enabled: true },
            beta: { command: "npx", args: ["-y", "@test/server"], enabled: true },
          },
        },
      },
    }) + "\n");
    await tick();

    const mcpStatus = messages.find((m) => m.type === "mcp_status") as
      | { type: "mcp_status"; servers: Array<{ name: string; status: string; tools?: unknown[]; error?: string }> }
      | undefined;
    expect(mcpStatus).toBeDefined();
    expect(mcpStatus!.servers.find((s) => s.name === "alpha")?.status).toBe("connected");
    expect(mcpStatus!.servers.find((s) => s.name === "beta")?.status).toBe("failed");
    expect(mcpStatus!.servers.find((s) => s.name === "beta")?.error).toContain("requires login");
    expect(mcpStatus!.servers.find((s) => s.name === "alpha")?.tools?.length).toBe(1);
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
    stdout.push(JSON.stringify({
      id: listReq.id,
      result: { data: [{ name: "alpha", tools: {}, authStatus: "oAuth" }], nextCursor: null },
    }) + "\n");
    await tick();

    const afterList = stdin.chunks.join("");
    const readLine = afterList.split("\n").find((l) => l.includes('"method":"config/read"'));
    expect(readLine).toBeDefined();
    const readReq = JSON.parse(readLine!);
    stdout.push(JSON.stringify({
      id: readReq.id,
      result: { config: { mcp_servers: { alpha: { url: "http://localhost:8080/mcp", enabled: false } } } },
    }) + "\n");
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
    stdout.push(JSON.stringify({ id: 7, result: { config: { mcp_servers: { memory: writeReq.params.edits[0].value } } } }) + "\n");
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
    stdout.push(JSON.stringify({ id: 5, error: { code: -32603, message: "Invalid configuration: invalid transport in `mcp_servers.context7`" } }) + "\n");
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
    stdout.push(JSON.stringify({ id: 5, result: { data: [{ name: "alpha", tools: {}, authStatus: "oAuth" }], nextCursor: null } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 6, result: { config: { mcp_servers: { alpha: { enabled: true, url: "http://localhost:8080/mcp" } } } } }) + "\n");
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
    stdout.push(JSON.stringify({
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
    }) + "\n");

    await tick();

    // Find the session_update message
    const sessionUpdates = messages.filter((m) => m.type === "session_update") as Array<{
      type: "session_update";
      session: { context_used_percent?: number; codex_token_details?: Record<string, number> };
    }>;
    expect(sessionUpdates.length).toBeGreaterThan(0);

    const lastUpdate = sessionUpdates[sessionUpdates.length - 1];

    // context_used_percent should use last turn: (85000 + 5000) / 258400 ≈ 35%
    expect(lastUpdate.session.context_used_percent).toBe(35);

    // codex_token_details should still show cumulative totals
    expect(lastUpdate.session.codex_token_details?.inputTokens).toBe(1_150_000);
    expect(lastUpdate.session.codex_token_details?.outputTokens).toBe(50_000);
    expect(lastUpdate.session.codex_token_details?.cachedInputTokens).toBe(930_000);
  });
});

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
    expect(failedCb).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "test message" }),
    );
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
    const startErrors = emitted.filter((m) =>
      m.type === "error" && m.message.includes("Failed to start turn"));
    expect(startErrors).toHaveLength(0);
  });

  it("emits a turn/start error when transport closes and no re-queue callback is registered", async () => {
    const adapter = await initAdapter();
    const emitted: BrowserIncomingMessage[] = [];
    adapter.onBrowserMessage((msg) => emitted.push(msg));

    adapter.sendBrowserMessage({ type: "user_message", content: "test message" } as BrowserOutgoingMessage);
    await tick();

    stdout.close();
    await tick();

    const startErrors = emitted.filter((m) =>
      m.type === "error" && m.message.includes("Failed to start turn"));
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
    stdout.push(JSON.stringify({
      method: "turn/completed",
      params: { turn: { id: "turn_active", status: "interrupted", items: [], error: null } },
    }) + "\n");
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
    expect(earlyWrites).toContain("\"text\":\"first rapid\"");
    expect(earlyWrites).not.toContain("\"text\":\"second rapid\"");

    // Complete rateLimits/read + first turn/start so the queued second message can continue.
    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_first" } } }) + "\n");
    await tick();

    const midWrites = stdin.chunks.join("");
    expect(midWrites).toContain("\"method\":\"turn/interrupt\"");
    expect(midWrites).toContain("\"turnId\":\"turn_first\"");

    // Resolve interrupt, then complete the first turn to allow second turn/start.
    stdout.push(JSON.stringify({ id: 5, result: {} }) + "\n");
    await tick();
    stdout.push(JSON.stringify({
      method: "turn/completed",
      params: { turn: { id: "turn_first", status: "interrupted", items: [], error: null } },
    }) + "\n");
    await tick();

    const finalWrites = stdin.chunks.join("");
    const finalTurnStarts = (finalWrites.match(/\"method\":\"turn\/start\"/g) || []).length;
    expect(finalTurnStarts).toBe(2);
    expect(finalWrites).toContain("\"text\":\"second rapid\"");
  });
});
