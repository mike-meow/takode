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

  it("emits a synthetic Agent tool_use for Codex spawnAgent calls and parents child tool activity under it", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thr_123",
          item: {
            type: "collabAgentToolCall",
            id: "agent_call_1",
            tool: "spawnAgent",
            prompt: "Inspect the feed renderer",
            senderThreadId: "thr_123",
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thr_123",
          item: {
            type: "collabAgentToolCall",
            id: "agent_call_1",
            tool: "spawnAgent",
            prompt: "Inspect the feed renderer",
            senderThreadId: "thr_123",
            receiverThreadIds: ["thr_child_1"],
            agentsStates: [{ nickname: "Banach", role: "explorer" }],
            status: "completed",
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thr_child_1",
          item: {
            type: "commandExecution",
            id: "cmd_child_1",
            command: ["rg", "subagent", "web/src"],
            status: "inProgress",
          },
        },
      }) + "\n",
    );
    await tick();

    const agentToolUse = messages.find((msg) => {
      if (msg.type !== "assistant") return false;
      const content = (
        msg as {
          message: { content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> };
        }
      ).message.content;
      return content.some(
        (block) => block.type === "tool_use" && block.id === "agent_call_1" && block.name === "Agent",
      );
    }) as
      | {
          parent_tool_use_id?: string | null;
          message: { content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> };
        }
      | undefined;
    expect(agentToolUse).toBeDefined();
    expect(agentToolUse!.parent_tool_use_id ?? null).toBeNull();
    const agentBlock = agentToolUse!.message.content.find(
      (block) => block.type === "tool_use" && block.id === "agent_call_1",
    ) as {
      input?: Record<string, unknown>;
    };
    expect(agentBlock.input?.description).toBe("Banach");
    expect(agentBlock.input?.subagent_type).toBe("explorer");

    const childToolUse = messages.find((msg) => {
      if (msg.type !== "assistant") return false;
      const content = (msg as { message: { content: Array<{ type: string; id?: string; name?: string }> } }).message
        .content;
      return content.some((block) => block.type === "tool_use" && block.id === "cmd_child_1" && block.name === "Bash");
    }) as { parent_tool_use_id?: string | null } | undefined;
    expect(childToolUse).toBeDefined();
    expect(childToolUse!.parent_tool_use_id).toBe("agent_call_1");
  });

  it("parents child assistant messages under the spawned Agent card", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thr_123",
          item: {
            type: "collabAgentToolCall",
            id: "agent_call_2",
            tool: "spawnAgent",
            prompt: "Summarize the adapter",
            senderThreadId: "thr_123",
            receiverThreadIds: ["thr_child_2"],
            agentsStates: [{ nickname: "Peirce", role: "explorer" }],
            status: "completed",
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thr_child_2",
          item: { type: "agentMessage", id: "agent_msg_1" },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thr_child_2",
          itemId: "agent_msg_1",
          delta: "Subagent reporting in",
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thr_child_2",
          item: { type: "agentMessage", id: "agent_msg_1", text: "Subagent reporting in" },
        },
      }) + "\n",
    );
    await tick();

    const childAssistant = messages.find(
      (msg) =>
        msg.type === "assistant" && (msg as { message: { id: string } }).message.id === "codex-agent-agent_msg_1",
    ) as
      | { parent_tool_use_id?: string | null; message: { content: Array<{ type: string; text?: string }> } }
      | undefined;
    expect(childAssistant).toBeDefined();
    expect(childAssistant!.parent_tool_use_id).toBe("agent_call_2");
    expect(childAssistant!.message.content[0].text).toBe("Subagent reporting in");
  });

  it("emits a subagent tool_result from task_complete and suppresses child-thread turn results", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thr_123",
          item: {
            type: "collabAgentToolCall",
            id: "agent_call_3",
            tool: "spawnAgent",
            prompt: "Verify completion",
            senderThreadId: "thr_123",
            receiverThreadIds: ["thr_child_3"],
            agentsStates: [{ nickname: "Noether", role: "explorer" }],
            status: "completed",
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "codex/event/task_complete",
        params: {
          conversationId: "thr_child_3",
          msg: {
            conversation_id: "thr_child_3",
            last_agent_message: "Done reading the relevant files.",
          },
        },
      }) + "\n",
    );
    await tick();

    const toolResult = messages.find((msg) => {
      if (msg.type !== "assistant") return false;
      const content = (msg as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } })
        .message.content;
      return content.some((block) => block.type === "tool_result" && block.tool_use_id === "agent_call_3");
    }) as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } } | undefined;
    expect(toolResult).toBeDefined();
    const resultBlock = toolResult!.message.content.find(
      (block) => block.type === "tool_result" && block.tool_use_id === "agent_call_3",
    ) as {
      content?: string;
    };
    expect(resultBlock.content).toContain("Done reading the relevant files.");

    const resultCountBeforeChildTurn = messages.filter((msg) => msg.type === "result").length;

    stdout.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thr_child_3",
          turn: { id: "turn_child_3", status: "completed", items: [], error: null },
        },
      }) + "\n",
    );
    await tick();

    const resultCountAfterChildTurn = messages.filter((msg) => msg.type === "result").length;
    expect(resultCountAfterChildTurn).toBe(resultCountBeforeChildTurn);
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

    stdout.push(
      JSON.stringify({
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
      }) + "\n",
    );

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
    const content = (toolUseMsg as { message: { content: Array<{ type: string; input?: { command: string } }> } })
      .message.content;
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

    const init = initMsgs[0] as {
      session: { backend_type: string; model: string; cwd: string; slash_commands: string[] };
    };
    expect(init.session.backend_type).toBe("codex");
    expect(init.session.model).toBe("o4-mini");
    expect(init.session.cwd).toBe("/home/user/project");
    expect(init.session.slash_commands).toEqual([...CODEX_LOCAL_SLASH_COMMANDS]);
  });

  it("refreshSkills fetches enabled skills for the matching cwd and emits session_update", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "o4-mini",
      cwd: "/home/user/project",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();
    // Resolve the init-time rate limit fetch first so request IDs stay deterministic.
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    stdin.chunks = [];
    const refreshPromise = adapter.refreshSkills(true);
    await tick();

    const lines = stdin.chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const skillsReq = lines.find((line) => line.method === "skills/list");
    expect(skillsReq).toBeDefined();
    expect(skillsReq.params).toEqual({
      cwds: ["/home/user/project"],
      forceReload: true,
    });

    stdout.push(
      JSON.stringify({
        id: 4,
        result: {
          data: [
            {
              cwd: "/other",
              skills: [
                {
                  name: "other-skill",
                  path: "/skills/other/SKILL.md",
                  description: "Other project skill",
                  enabled: true,
                },
              ],
              errors: [],
            },
            {
              cwd: "/home/user/project",
              skills: [
                {
                  name: "review",
                  path: "/skills/review/SKILL.md",
                  description: "Review code",
                  enabled: true,
                },
                { name: "disabled-skill", enabled: false },
                {
                  name: "fix",
                  path: "/skills/fix/SKILL.md",
                  description: "Fix issues",
                  enabled: true,
                },
              ],
              errors: [],
            },
          ],
        },
      }) + "\n",
    );
    await tick();

    const appLines = stdin.chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const appsReq = appLines.find((line) => line.method === "app/list");
    expect(appsReq).toBeDefined();
    expect(appsReq.params).toEqual({
      threadId: "thr_123",
      forceRefetch: true,
    });

    stdout.push(
      JSON.stringify({
        id: appsReq.id,
        result: {
          data: [
            {
              id: "connector_google_drive",
              name: "Google Drive",
              description: "Search and edit Drive files",
              isAccessible: true,
              isEnabled: true,
            },
            {
              id: "connector_disabled",
              name: "Disabled App",
              description: "Hidden app",
              isAccessible: true,
              isEnabled: false,
            },
          ],
          nextCursor: null,
        },
      }) + "\n",
    );

    await expect(refreshPromise).resolves.toEqual(["fix", "review"]);
    const update = messages.find(
      (msg) =>
        msg.type === "session_update" && Array.isArray((msg as { session?: { skills?: string[] } }).session?.skills),
    ) as { session: Partial<SessionState> } | undefined;
    expect(update?.session.skills).toEqual(["fix", "review"]);
    expect(update?.session.skill_metadata).toEqual([
      { name: "fix", path: "/skills/fix/SKILL.md", description: "Fix issues" },
      { name: "review", path: "/skills/review/SKILL.md", description: "Review code" },
    ]);
    expect(update?.session.apps).toEqual([
      {
        id: "connector_google_drive",
        name: "Google Drive",
        description: "Search and edit Drive files",
      },
    ]);
  });

  it("forwards app/list/updated notifications as session app metadata", async () => {
    // Validates live app-list changes refresh the composer mention menu without a manual reload.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "app/list/updated",
        params: {
          data: [
            {
              id: "connector_slack",
              name: "Slack",
              description: "Read and send Slack messages",
              isAccessible: true,
              isEnabled: true,
            },
            {
              id: "connector_inaccessible",
              name: "Hidden",
              description: "Hidden connector",
              isAccessible: false,
              isEnabled: true,
            },
          ],
        },
      }) + "\n",
    );
    await tick();

    const appUpdate = messages.find(
      (msg) =>
        msg.type === "session_update" && Array.isArray((msg as { session?: { apps?: unknown[] } }).session?.apps),
    ) as { session: Partial<SessionState> } | undefined;
    expect(appUpdate?.session.apps).toEqual([
      {
        id: "connector_slack",
        name: "Slack",
        description: "Read and send Slack messages",
      },
    ]);
  });

  it("adds structured skill and app mention inputs to turn/start payloads", async () => {
    // Validates `$skill` and `[$app](app://...)` mentions are sent as structured
    // Codex input items in addition to the raw prompt text.
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "o4-mini",
      cwd: "/home/user/project",
    });

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 3, result: { rateLimits: { primary: null, secondary: null } } }) + "\n");
    await tick();

    const refreshPromise = adapter.refreshSkills(true);
    await tick();
    stdout.push(
      JSON.stringify({
        id: 4,
        result: {
          data: [
            {
              cwd: "/home/user/project",
              skills: [
                {
                  name: "review",
                  path: "/Users/test/.agents/skills/review/SKILL.md",
                  description: "Review code changes",
                  enabled: true,
                },
              ],
              errors: [],
            },
          ],
        },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        id: 5,
        result: { data: [], nextCursor: null },
      }) + "\n",
    );
    await refreshPromise;

    stdin.chunks = [];
    adapter.sendBrowserMessage({
      type: "user_message",
      content: "Use $review and [$Google Drive](app://connector_google_drive)",
    });
    await tick();

    const lines = stdin.chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const turnStart = lines.find((line) => line.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect(turnStart.params.input).toEqual([
      {
        type: "text",
        text: "Use $review and [$Google Drive](app://connector_google_drive)",
        text_elements: [],
      },
      {
        type: "mention",
        name: "google-drive",
        path: "app://connector_google_drive",
      },
      {
        type: "skill",
        name: "review",
        path: "/Users/test/.agents/skills/review/SKILL.md",
      },
    ]);
  });
});
