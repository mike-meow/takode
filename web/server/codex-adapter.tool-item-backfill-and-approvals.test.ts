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
    stdout.push(
      JSON.stringify({
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
      }) + "\n",
    );

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
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "commandExecution", id: "cmd_2", command: ["echo", "hi"], status: "inProgress" },
        },
      }) + "\n",
    );
    await tick();

    // Then item/completed
    stdout.push(
      JSON.stringify({
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
      }) + "\n",
    );
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
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            id: "cmd_str_1",
            command: "/bin/zsh -lc 'cat README.md'",
            status: "inProgress",
          },
        },
      }) + "\n",
    );
    await tick();

    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Bash");
    });
    expect(toolUseMsg).toBeDefined();

    const content = (toolUseMsg as { message: { content: Array<{ type: string; input?: { command: string } }> } })
      .message.content;
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
    stdout.push(
      JSON.stringify({
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
      }) + "\n",
    );
    await tick();

    // Should have both a backfilled tool_use and a tool_result
    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.name === "Bash");
    });
    expect(toolUseMsg).toBeDefined();

    const content = (toolUseMsg as { message: { content: Array<{ type: string; input?: { command: string } }> } })
      .message.content;
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
    stdout.push(
      JSON.stringify({
        method: "item/commandExecution/requestApproval",
        id: 300,
        params: {
          itemId: "item_cmd_str",
          threadId: "thr_123",
          turnId: "turn_1",
          command: "/bin/zsh -lc 'rm -rf /tmp/test'",
          cwd: "/home/user",
        },
      }) + "\n",
    );
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

    stdout.push(
      JSON.stringify({
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
      }) + "\n",
    );
    await tick();

    const toolUseMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "cmd_actions_1");
    });
    expect(toolUseMsg).toBeDefined();

    const content = (toolUseMsg as { message: { content: Array<{ type: string; input?: { command: string } }> } })
      .message.content;
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
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "commandExecution", id: "cmd_x", command: ["echo", "hi"], status: "inProgress" } },
      }) + "\n",
    );
    await tick();

    // Test webSearch
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "webSearch", id: "ws_x", query: "test" } },
      }) + "\n",
    );
    await tick();

    // Test fileChange (deferred until completed provides diff)
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "fileChange",
            id: "fc_x",
            changes: [{ path: "/tmp/f.ts", kind: "modify" }],
            status: "inProgress",
          },
        },
      }) + "\n",
    );
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "fc_x",
            changes: [{ path: "/tmp/f.ts", kind: "modify", diff: "@@ -1 +1 @@\n-a\n+b" }],
            status: "completed",
          },
        },
      }) + "\n",
    );
    await tick();

    // All three should have content_block_start stream events
    const blockStarts = messages.filter(
      (m) =>
        m.type === "stream_event" &&
        (m as { event: { type: string } }).event?.type === "content_block_start" &&
        (m as { event: { content_block?: { type: string } } }).event?.content_block?.type === "tool_use",
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
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "agentMessage", id: "am_1" } },
      }) + "\n",
    );
    await tick();

    // Complete it
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: { item: { type: "agentMessage", id: "am_1", text: "Hello" } },
      }) + "\n",
    );
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
    stdout.push(
      JSON.stringify({
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
      }) + "\n",
    );
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

    stdout.push(
      JSON.stringify({
        method: "item/mcpToolCall/requestApproval",
        id: 401,
        params: {
          itemId: "mcp_item_2",
          server: "db-server",
          tool: "run_query",
          arguments: { sql: "SELECT * FROM users" },
        },
      }) + "\n",
    );
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
    stdout.push(
      JSON.stringify({
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
      }) + "\n",
    );
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
    stdout.push(
      JSON.stringify({
        method: "item/fileChange/requestApproval",
        id: 501,
        params: {
          itemId: "fc_approval_2",
          reason: "Updating configuration",
        },
      }) + "\n",
    );
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
    stdout.push(
      JSON.stringify({
        method: "item/tool/call",
        id: 600,
        params: {
          callId: "call_abc123",
          tool: "my_custom_tool",
          arguments: { query: "test input" },
        },
      }) + "\n",
    );
    await tick();

    const permRequests = messages.filter((m) => m.type === "permission_request");
    expect(permRequests.length).toBe(1);
    const perm = permRequests[0] as {
      request: { request_id: string; tool_name: string; tool_use_id: string; input: Record<string, unknown> };
    };

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

    stdout.push(
      JSON.stringify({
        method: "item/tool/call",
        id: 601,
        params: {
          callId: "call_def456",
          tool: "code_interpreter",
          arguments: { code: "print('hello')" },
        },
      }) + "\n",
    );
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

      stdout.push(
        JSON.stringify({
          method: "item/tool/call",
          id: 602,
          params: {
            callId: "call_timeout_1",
            tool: "slow_tool",
            arguments: { input: "x" },
          },
        }) + "\n",
      );
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
    stdout.push(
      JSON.stringify({
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
      }) + "\n",
    );
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

    stdout.push(
      JSON.stringify({
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
      }) + "\n",
    );
    await tick();

    const toolResultMsg = messages.find((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } })
        .message.content;
      return content.some((b) => b.type === "tool_result" && b.tool_use_id === "cmd_agg");
    }) as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } } | undefined;

    expect(toolResultMsg).toBeDefined();
    const resultBlock = toolResultMsg!.message.content.find(
      (b) => b.type === "tool_result" && b.tool_use_id === "cmd_agg",
    );
    expect(resultBlock?.content).toContain("src/index.ts");
  });
});
