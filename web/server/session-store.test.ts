import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, type PersistedSession } from "./session-store.js";

let tempDir: string;
let store: SessionStore;

function makeSession(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id,
    state: {
      session_id: id,
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "",
      is_worktree: false,
      is_containerized: false,
      repo_root: "",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    messageHistory: [],
    pendingMessages: [],
    pendingPermissions: [],
    ...overrides,
  };
}

/** Helper: build a minimal completed turn (user → assistant → result). */
function makeTurnMessages(turnIndex: number): PersistedSession["messageHistory"] {
  return [
    { type: "user_message", content: `Turn ${turnIndex} question`, timestamp: Date.now() + turnIndex * 1000 },
    {
      type: "assistant",
      message: {
        id: `msg-${turnIndex}`,
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [
          { type: "text", text: `Turn ${turnIndex} answer` },
          { type: "tool_use", id: `tu-${turnIndex}`, name: "Read", input: {} },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now() + turnIndex * 1000 + 500,
      turn_duration_ms: 1200,
    },
    {
      type: "result",
      data: { type: "result", subtype: "success", uuid: `result-${turnIndex}` },
    },
  ] as PersistedSession["messageHistory"];
}

/** Helper: build tool results for a turn. */
function makeToolResults(turnIndex: number): NonNullable<PersistedSession["toolResults"]> {
  return [
    [
      `tu-${turnIndex}`,
      { content: `Tool result for turn ${turnIndex}`, is_error: false, timestamp: Date.now() + turnIndex * 1000 + 600 },
    ],
  ];
}

function makeToolResultPreviewMessage(
  toolUseId: string,
  content = `Preview for ${toolUseId}`,
): PersistedSession["messageHistory"][number] {
  return {
    type: "tool_result_preview",
    previews: [
      {
        tool_use_id: toolUseId,
        content,
        is_error: false,
        total_size: content.length,
        is_truncated: false,
      },
    ],
  } as PersistedSession["messageHistory"][number];
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ss-test-"));
  store = new SessionStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── saveSync / load ──────────────────────────────────────────────────────────

describe("saveSync / load", () => {
  it("writes a session to disk and reads it back", async () => {
    const session = makeSession("s1");
    store.saveSync(session);
    await store.flushAll();

    const filePath = join(tempDir, "s1.json");
    expect(existsSync(filePath)).toBe(true);

    const loaded = await store.load("s1");
    // load() adds bookkeeping fields (_frozenCount, _frozenToolResultCount, toolResults)
    expect(loaded!.id).toBe("s1");
    expect(loaded!.messageHistory).toEqual([]);
    expect(loaded!.pendingMessages).toEqual([]);
    expect(loaded!.state).toEqual(session.state);
  });

  it("returns null for a non-existent session", async () => {
    const loaded = await store.load("does-not-exist");
    expect(loaded).toBeNull();
  });

  it("returns null for a corrupt JSON file", async () => {
    writeFileSync(join(tempDir, "corrupt.json"), "{{not valid json!!", "utf-8");
    const loaded = await store.load("corrupt");
    expect(loaded).toBeNull();
  });

  it("preserves all session fields through round-trip", async () => {
    const session = makeSession("s2", {
      messageHistory: [{ type: "error", message: "test error" }],
      pendingMessages: ["msg1", "msg2"],
      pendingCodexTurns: [
        {
          adapterMsg: { type: "user_message", content: "retry persisted turn" },
          userMessageId: "user-persisted-1",
          userContent: "retry persisted turn",
          historyIndex: 0,
          status: "backend_acknowledged",
          dispatchCount: 1,
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
          acknowledgedAt: 1700000000500,
          turnTarget: "current",
          lastError: null,
          turnId: "turn-persisted-1",
          disconnectedAt: 1700000000000,
          resumeConfirmedAt: null,
        },
      ],
      pendingPermissions: [
        [
          "req-1",
          {
            request_id: "req-1",
            tool_name: "Write",
            input: { path: "/tmp/test.txt" },
            tool_use_id: "tu-1",
            timestamp: Date.now(),
          },
        ],
      ],
      eventBuffer: [{ seq: 1, message: { type: "backend_connected" } }],
      nextEventSeq: 2,
      lastAckSeq: 1,
      processedClientMessageIds: ["client-msg-1", "client-msg-2"],
      archived: true,
    });

    store.saveSync(session);
    await store.flushAll();
    const loaded = await store.load("s2");
    // load() adds bookkeeping fields; check essential fields individually
    expect(loaded!.id).toBe("s2");
    expect(loaded!.archived).toBe(true);
    expect(loaded!.pendingPermissions).toHaveLength(1);
    expect(loaded!.pendingMessages).toEqual(["msg1", "msg2"]);
    expect(loaded!.pendingCodexTurns).toEqual(session.pendingCodexTurns);
    expect(loaded!.eventBuffer).toEqual([{ seq: 1, message: { type: "backend_connected" } }]);
    expect(loaded!.nextEventSeq).toBe(2);
    expect(loaded!.lastAckSeq).toBe(1);
    expect(loaded!.processedClientMessageIds).toEqual(["client-msg-1", "client-msg-2"]);
  });
});

// ─── save (debounced) ─────────────────────────────────────────────────────────

describe("save (debounced)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not write immediately", () => {
    const session = makeSession("debounce-1");
    store.save(session);

    const filePath = join(tempDir, "debounce-1.json");
    expect(existsSync(filePath)).toBe(false);
  });

  it("writes after the 150ms debounce period", async () => {
    const session = makeSession("debounce-2");
    store.save(session);

    vi.advanceTimersByTime(150);
    // Await the async writeFile triggered by the timer
    await store.flushAll();

    const filePath = join(tempDir, "debounce-2.json");
    expect(existsSync(filePath)).toBe(true);

    const loaded = await store.load("debounce-2");
    // load() adds bookkeeping fields; check essential fields
    expect(loaded!.id).toBe("debounce-2");
    expect(loaded!.messageHistory).toEqual([]);
    expect(loaded!.pendingMessages).toEqual([]);
  });

  it("coalesces rapid calls and only writes the last version", async () => {
    const session1 = makeSession("debounce-3", {
      pendingMessages: ["first"],
    });
    const session2 = makeSession("debounce-3", {
      pendingMessages: ["second"],
    });
    const session3 = makeSession("debounce-3", {
      pendingMessages: ["third"],
    });

    store.save(session1);
    vi.advanceTimersByTime(50);
    store.save(session2);
    vi.advanceTimersByTime(50);
    store.save(session3);

    // Not yet written (timer restarted with session3)
    expect(existsSync(join(tempDir, "debounce-3.json"))).toBe(false);

    vi.advanceTimersByTime(150);
    // Await the async writeFile triggered by the timer
    await store.flushAll();

    const loaded = await store.load("debounce-3");
    expect(loaded!.pendingMessages).toEqual(["third"]);
  });
});

// ─── loadAll ──────────────────────────────────────────────────────────────────

describe("loadAll", () => {
  it("returns all saved sessions", async () => {
    store.saveSync(makeSession("a"));
    store.saveSync(makeSession("b"));
    store.saveSync(makeSession("c"));
    await store.flushAll();

    const all = await store.loadAll();
    const ids = all.map((s) => s.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("skips corrupt JSON files", async () => {
    store.saveSync(makeSession("good"));
    await store.flushAll();
    writeFileSync(join(tempDir, "bad.json"), "not-json!", "utf-8");

    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("good");
  });

  it("excludes launcher.json from results", async () => {
    store.saveSync(makeSession("session-1"));
    await store.flushAll();
    store.saveLauncher({ some: "launcher data" });

    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("session-1");
  });

  it("returns an empty array for an empty directory", async () => {
    const all = await store.loadAll();
    expect(all).toEqual([]);
  });
});

// ─── setArchived ──────────────────────────────────────────────────────────────

describe("setArchived", () => {
  it("sets archived flag to true and persists it", async () => {
    store.saveSync(makeSession("arch-1"));
    await store.flushAll();
    const result = await store.setArchived("arch-1", true);
    await store.flushAll();

    expect(result).toBe(true);

    const loaded = await store.load("arch-1");
    expect(loaded!.archived).toBe(true);
  });

  it("sets archived flag to false and persists it", async () => {
    store.saveSync(makeSession("arch-2", { archived: true }));
    await store.flushAll();
    const result = await store.setArchived("arch-2", false);
    await store.flushAll();

    expect(result).toBe(true);

    const loaded = await store.load("arch-2");
    expect(loaded!.archived).toBe(false);
  });

  it("returns false for a non-existent session", async () => {
    const result = await store.setArchived("no-such-session", true);
    expect(result).toBe(false);
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe("remove", () => {
  it("deletes the session file from disk", async () => {
    store.saveSync(makeSession("rm-1"));
    await store.flushAll();
    expect(existsSync(join(tempDir, "rm-1.json"))).toBe(true);

    store.remove("rm-1");
    // remove() uses async unlink internally — flush to await it
    await store.flushAll();
    expect(existsSync(join(tempDir, "rm-1.json"))).toBe(false);
    expect(await store.load("rm-1")).toBeNull();
  });

  it("deletes both hot JSON and frozen log", async () => {
    // Build a session with a completed turn so it creates a frozen log
    const turn1 = makeTurnMessages(1);
    const session = makeSession("rm-frozen", {
      messageHistory: turn1,
      toolResults: makeToolResults(1),
    });
    store.saveSync(session);
    await store.flushAll();

    expect(existsSync(join(tempDir, "rm-frozen.json"))).toBe(true);
    expect(existsSync(join(tempDir, "rm-frozen.history.jsonl"))).toBe(true);

    store.remove("rm-frozen");
    await store.flushAll();
    expect(existsSync(join(tempDir, "rm-frozen.json"))).toBe(false);
    expect(existsSync(join(tempDir, "rm-frozen.history.jsonl"))).toBe(false);
    expect(await store.load("rm-frozen")).toBeNull();
  });

  it("cancels a pending debounced save so it never writes", () => {
    vi.useFakeTimers();
    try {
      const session = makeSession("rm-2");
      store.save(session);

      // Remove before the debounce fires
      store.remove("rm-2");

      // Advance past the debounce window
      vi.advanceTimersByTime(300);

      expect(existsSync(join(tempDir, "rm-2.json"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw when removing a non-existent session", () => {
    expect(() => store.remove("ghost-session")).not.toThrow();
  });
});

// ─── saveLauncher / loadLauncher ──────────────────────────────────────────────

describe("saveLauncher / loadLauncher", () => {
  it("writes and reads launcher data", async () => {
    const data = { pids: [123, 456], lastBoot: "2025-01-01T00:00:00Z" };
    store.saveLauncher(data);
    await store.flushAll();

    const loaded = await store.loadLauncher<{ pids: number[]; lastBoot: string }>();
    expect(loaded).toEqual(data);
  });

  it("returns null when no launcher file exists", async () => {
    const loaded = await store.loadLauncher();
    expect(loaded).toBeNull();
  });
});

// ─── Append-only frozen history ──────────────────────────────────────────────

describe("append-only frozen history", () => {
  it("freezes completed turns to JSONL and keeps hot tail small", async () => {
    // Simulate a session with one completed turn + one in-progress turn.
    // Completed turn: user_message → assistant → result
    // In-progress: user_message → assistant (no result yet)
    const turn1 = makeTurnMessages(1);
    const inProgress = [
      { type: "user_message", content: "Still thinking...", timestamp: Date.now() + 5000 },
      {
        type: "assistant",
        message: {
          id: "msg-ip",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Working..." }],
          stop_reason: null,
          usage: null,
        },
        parent_tool_use_id: null,
        timestamp: Date.now() + 5500,
      },
    ] as PersistedSession["messageHistory"];

    const session = makeSession("freeze-1", {
      messageHistory: [...turn1, ...inProgress],
      toolResults: makeToolResults(1),
    });

    store.saveSync(session);
    await store.flushAll();

    // Frozen log should exist with the completed turn
    expect(existsSync(join(tempDir, "freeze-1.history.jsonl"))).toBe(true);

    // Hot JSON should only contain the in-progress messages
    const hotRaw = JSON.parse(readFileSync(join(tempDir, "freeze-1.json"), "utf-8"));
    expect(hotRaw._frozenCount).toBe(3); // 3 messages frozen (user + assistant + result)
    expect(hotRaw.messageHistory).toHaveLength(2); // the 2 in-progress messages
    expect(hotRaw.messageHistory[0].type).toBe("user_message");
    expect(hotRaw.messageHistory[0].content).toBe("Still thinking...");

    // Load should reconstruct the full history
    const loaded = await store.load("freeze-1");
    expect(loaded!.messageHistory).toHaveLength(5); // 3 frozen + 2 hot
    expect(loaded!.messageHistory[0].type).toBe("user_message");
    expect((loaded!.messageHistory[0] as { content: string }).content).toBe("Turn 1 question");
    expect(loaded!.messageHistory[3].type).toBe("user_message");
    expect((loaded!.messageHistory[3] as { content: string }).content).toBe("Still thinking...");
  });

  it("incrementally appends new turns without rewriting old ones", async () => {
    // Save after turn 1
    const turn1 = makeTurnMessages(1);
    const session = makeSession("incr-1", {
      messageHistory: [...turn1],
      toolResults: makeToolResults(1),
    });
    store.saveSync(session);
    await store.flushAll();

    const logAfterTurn1 = readFileSync(join(tempDir, "incr-1.history.jsonl"), "utf-8");
    const linesAfterTurn1 = logAfterTurn1.split("\n").filter((l) => l.trim());
    // Header + 3 messages + 1 tool results batch = 5 lines
    expect(linesAfterTurn1.length).toBe(5);

    // Add turn 2 and save again
    const turn2 = makeTurnMessages(2);
    session.messageHistory = [...turn1, ...turn2];
    session.toolResults = [...makeToolResults(1), ...makeToolResults(2)];
    store.saveSync(session);
    await store.flushAll();

    const logAfterTurn2 = readFileSync(join(tempDir, "incr-1.history.jsonl"), "utf-8");
    const linesAfterTurn2 = logAfterTurn2.split("\n").filter((l) => l.trim());
    // Previous 5 lines + 3 new messages + 1 tool results batch = 9 lines
    expect(linesAfterTurn2.length).toBe(9);

    // Verify the JSONL starts with the same content (append-only)
    expect(logAfterTurn2.startsWith(logAfterTurn1)).toBe(true);

    // Load should reconstruct full history
    const loaded = await store.load("incr-1");
    expect(loaded!.messageHistory).toHaveLength(6); // 3 + 3
    expect(loaded!.toolResults).toHaveLength(2);
  });

  it("does not create a frozen log when no turn is completed", async () => {
    // Only in-progress messages (no result)
    const session = makeSession("no-freeze", {
      messageHistory: [
        { type: "user_message", content: "Hello", timestamp: Date.now() },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            content: [{ type: "text", text: "Hi!" }],
            stop_reason: null,
            usage: null,
          },
          parent_tool_use_id: null,
          timestamp: Date.now(),
        },
      ] as PersistedSession["messageHistory"],
    });

    store.saveSync(session);
    await store.flushAll();

    // No JSONL should be created
    expect(existsSync(join(tempDir, "no-freeze.history.jsonl"))).toBe(false);

    // Hot JSON should contain all messages
    const loaded = await store.load("no-freeze");
    expect(loaded!.messageHistory).toHaveLength(2);
    expect(loaded!._frozenCount).toBe(0); // no frozen messages, but count is tracked
  });

  it("handles backward compatibility with legacy format (no JSONL)", async () => {
    // Write a session in the old format (full history in JSON, no _frozenCount)
    const legacySession = makeSession("legacy", {
      messageHistory: makeTurnMessages(1),
      toolResults: makeToolResults(1),
    });
    // Write directly without using the store (simulates old format)
    writeFileSync(join(tempDir, "legacy.json"), JSON.stringify(legacySession), "utf-8");

    // Load with new store — should work and return full history
    const loaded = await store.load("legacy");
    expect(loaded).not.toBeNull();
    expect(loaded!.messageHistory).toHaveLength(3);
    expect(loaded!.toolResults).toHaveLength(1);

    // Saving again should create the frozen log
    store.saveSync(loaded!);
    await store.flushAll();
    expect(existsSync(join(tempDir, "legacy.history.jsonl"))).toBe(true);
  });

  it("recovers from crash between JSONL append and hot JSON write", async () => {
    // Simulate: JSONL has more frozen messages than the hot JSON expects.
    // This happens if the server crashed after appending to JSONL but before
    // writing the updated hot JSON.

    // Save a session with turn 1 — both files are consistent
    const turn1 = makeTurnMessages(1);
    const session = makeSession("crash-1", {
      messageHistory: [...turn1],
      toolResults: makeToolResults(1),
    });
    store.saveSync(session);
    await store.flushAll();

    // Now simulate: turn 2 was appended to JSONL, but hot JSON wasn't updated.
    // Manually append turn 2 to the JSONL:
    const turn2 = makeTurnMessages(2);
    let appendData = "";
    for (const msg of turn2) {
      appendData += JSON.stringify(msg) + "\n";
    }
    const turn2ToolResults = makeToolResults(2);
    appendData += JSON.stringify({ _toolResults: turn2ToolResults }) + "\n";
    const { appendFile: appendFileSync } = await import("node:fs/promises");
    await appendFileSync(join(tempDir, "crash-1.history.jsonl"), appendData, "utf-8");

    // Hot JSON still thinks only 3 messages are frozen (turn 1)
    // But JSONL now has 6 messages (turn 1 + turn 2)
    // The hot JSON's messageHistory contains turn 2 messages (they overlap)
    const hotRaw = JSON.parse(readFileSync(join(tempDir, "crash-1.json"), "utf-8"));
    expect(hotRaw._frozenCount).toBe(3);

    // Rewrite hot JSON to simulate the stale state: it still has turn2 messages
    // in its hot tail (since the hot JSON write didn't happen after freeze)
    hotRaw.messageHistory = turn2;
    hotRaw.toolResults = turn2ToolResults;
    writeFileSync(join(tempDir, "crash-1.json"), JSON.stringify(hotRaw), "utf-8");

    // Load should detect the overlap and not duplicate messages
    // Create a fresh store so there's no in-memory frozen count
    const freshStore = new SessionStore(tempDir);
    const loaded = await freshStore.load("crash-1");
    expect(loaded).not.toBeNull();
    // Should have 6 messages total (3 from turn 1 + 3 from turn 2), not 9
    expect(loaded!.messageHistory).toHaveLength(6);
    expect((loaded!.messageHistory[0] as { content: string }).content).toBe("Turn 1 question");
    expect((loaded!.messageHistory[3] as { content: string }).content).toBe("Turn 2 question");
  });

  it("repairs duplicate replay-generated tool_result_preview hot tails on load and rewrites the hot JSON", async () => {
    const frozenTurn = makeTurnMessages(1);
    const repeatedPreview = makeToolResultPreviewMessage("tu-replayed", "Replay-generated preview");
    const uniquePreview = makeToolResultPreviewMessage("tu-unique", "Latest preview");

    const session = makeSession("repair-preview-tail", {
      messageHistory: [...frozenTurn, repeatedPreview, uniquePreview],
      toolResults: makeToolResults(1),
    });
    store.saveSync(session);
    await store.flushAll();

    const hotPath = join(tempDir, "repair-preview-tail.json");
    const hotRaw = JSON.parse(readFileSync(hotPath, "utf-8"));
    hotRaw.messageHistory = [
      repeatedPreview,
      uniquePreview,
      repeatedPreview,
      uniquePreview,
      repeatedPreview,
      uniquePreview,
    ];
    writeFileSync(hotPath, JSON.stringify(hotRaw), "utf-8");

    const freshStore = new SessionStore(tempDir);
    const loaded = await freshStore.load("repair-preview-tail");
    expect(loaded).not.toBeNull();
    expect(loaded!.messageHistory).toEqual([...frozenTurn, repeatedPreview, uniquePreview]);

    await freshStore.flushAll();
    const repairedHotRaw = JSON.parse(readFileSync(hotPath, "utf-8"));
    expect(repairedHotRaw.messageHistory).toEqual([repeatedPreview, uniquePreview]);
    expect(repairedHotRaw.messageHistory).toHaveLength(2);
  });

  it("does not trim unique in-progress tool_result_preview tails while saving", async () => {
    const session = makeSession("keep-unique-preview-tail", {
      messageHistory: [
        makeToolResultPreviewMessage("tu-a", "First unique preview"),
        makeToolResultPreviewMessage("tu-b", "Second unique preview"),
      ],
    });

    store.saveSync(session);
    await store.flushAll();

    expect(session.messageHistory).toEqual([
      makeToolResultPreviewMessage("tu-a", "First unique preview"),
      makeToolResultPreviewMessage("tu-b", "Second unique preview"),
    ]);

    const loaded = await store.load("keep-unique-preview-tail");
    expect(loaded!.messageHistory).toEqual([
      makeToolResultPreviewMessage("tu-a", "First unique preview"),
      makeToolResultPreviewMessage("tu-b", "Second unique preview"),
    ]);
  });

  it("trims duplicate replay-generated tool_result_preview tails from already-loaded sessions on save", async () => {
    const repeatedPreview = makeToolResultPreviewMessage("tu-replayed", "Replay-generated preview");
    const uniquePreview = makeToolResultPreviewMessage("tu-unique", "Latest preview");
    const session = makeSession("trim-loaded-preview-tail", {
      messageHistory: [repeatedPreview, uniquePreview, repeatedPreview, uniquePreview, repeatedPreview],
    });

    store.saveSync(session);
    await store.flushAll();

    expect(session.messageHistory).toEqual([repeatedPreview, uniquePreview]);

    const loaded = await store.load("trim-loaded-preview-tail");
    expect(loaded!.messageHistory).toEqual([repeatedPreview, uniquePreview]);
  });

  it("handles corrupt/truncated JSONL lines gracefully", async () => {
    // Save a completed turn
    const session = makeSession("corrupt-log", {
      messageHistory: makeTurnMessages(1),
      toolResults: makeToolResults(1),
    });
    store.saveSync(session);
    await store.flushAll();

    // Corrupt the last line of the JSONL by truncating it
    const logPath = join(tempDir, "corrupt-log.history.jsonl");
    const logContent = readFileSync(logPath, "utf-8");
    const lines = logContent.split("\n").filter((l) => l.trim());
    // Replace last line with truncated JSON
    lines[lines.length - 1] = '{"type":"result","data":{"type"';
    writeFileSync(logPath, lines.join("\n") + "\n", "utf-8");

    // Load should skip the corrupt line and still work
    const freshStore = new SessionStore(tempDir);
    const loaded = await freshStore.load("corrupt-log");
    expect(loaded).not.toBeNull();
    // We should get at least the non-corrupt messages
    expect(loaded!.messageHistory.length).toBeGreaterThan(0);
  });

  it("does not re-freeze already-frozen messages on repeated saves", async () => {
    // Save session with completed turn
    const turn1 = makeTurnMessages(1);
    const session = makeSession("no-refreeze", {
      messageHistory: [...turn1],
      toolResults: makeToolResults(1),
    });
    store.saveSync(session);
    await store.flushAll();

    const logAfterFirst = readFileSync(join(tempDir, "no-refreeze.history.jsonl"), "utf-8");

    // Save again with the same history (no new turn)
    store.saveSync(session);
    await store.flushAll();

    const logAfterSecond = readFileSync(join(tempDir, "no-refreeze.history.jsonl"), "utf-8");

    // JSONL should be identical (no duplicate appends)
    expect(logAfterSecond).toBe(logAfterFirst);
  });

  it("hot JSON stays small during active streaming", async () => {
    // Simulate: turn 1 completed, turn 2 in progress with many messages
    const turn1 = makeTurnMessages(1);
    const manyStreamMessages = Array.from({ length: 100 }, (_, i) => ({
      type: "stream_event" as const,
      event: { content: `Streaming chunk ${i}` },
      parent_tool_use_id: null,
    })) as PersistedSession["messageHistory"];

    const session = makeSession("hot-small", {
      messageHistory: [...turn1, ...manyStreamMessages],
      toolResults: makeToolResults(1),
    });
    store.saveSync(session);
    await store.flushAll();

    // Hot JSON should only have the 100 stream messages, not the 103 total
    const hotRaw = JSON.parse(readFileSync(join(tempDir, "hot-small.json"), "utf-8"));
    expect(hotRaw.messageHistory).toHaveLength(100);
    expect(hotRaw._frozenCount).toBe(3);

    // Full load should reconstruct all 103
    const loaded = await store.load("hot-small");
    expect(loaded!.messageHistory).toHaveLength(103);
  });

  it("tool results are frozen alongside messages", async () => {
    const turn1 = makeTurnMessages(1);
    const turn2 = makeTurnMessages(2);
    const session = makeSession("tool-freeze", {
      messageHistory: [...turn1, ...turn2],
      toolResults: [...makeToolResults(1), ...makeToolResults(2)],
    });
    store.saveSync(session);
    await store.flushAll();

    // Hot JSON should have no tool results (both turns completed = all frozen)
    const hotRaw = JSON.parse(readFileSync(join(tempDir, "tool-freeze.json"), "utf-8"));
    expect(hotRaw.toolResults).toHaveLength(0);
    expect(hotRaw._frozenToolResultCount).toBe(2);

    // Load should reconstruct all tool results
    const loaded = await store.load("tool-freeze");
    expect(loaded!.toolResults).toHaveLength(2);
    expect(loaded!.toolResults![0][0]).toBe("tu-1");
    expect(loaded!.toolResults![1][0]).toBe("tu-2");
  });

  it("loadAll excludes .history.jsonl files from session list", async () => {
    // Save a session with a completed turn (creates both files)
    const session = makeSession("listed", {
      messageHistory: makeTurnMessages(1),
      toolResults: makeToolResults(1),
    });
    store.saveSync(session);
    await store.flushAll();

    // Verify both files exist
    expect(existsSync(join(tempDir, "listed.json"))).toBe(true);
    expect(existsSync(join(tempDir, "listed.history.jsonl"))).toBe(true);

    // loadAll should return exactly one session (not two)
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("listed");
    expect(all[0].messageHistory).toHaveLength(3);
  });

  it("empty history session has no frozen log", async () => {
    const session = makeSession("empty-hist");
    store.saveSync(session);
    await store.flushAll();

    expect(existsSync(join(tempDir, "empty-hist.history.jsonl"))).toBe(false);

    const loaded = await store.load("empty-hist");
    expect(loaded!.messageHistory).toHaveLength(0);
  });

  it("setArchived works with split persistence", async () => {
    // Create session with a completed turn (so frozen log exists)
    const session = makeSession("arch-frozen", {
      messageHistory: makeTurnMessages(1),
      toolResults: makeToolResults(1),
    });
    store.saveSync(session);
    await store.flushAll();

    const result = await store.setArchived("arch-frozen", true);
    await store.flushAll();

    expect(result).toBe(true);
    const loaded = await store.load("arch-frozen");
    expect(loaded!.archived).toBe(true);
    // History should still be intact
    expect(loaded!.messageHistory).toHaveLength(3);
    expect(loaded!.toolResults).toHaveLength(1);
  });
});

// ─── Property-based tests for frozen history correctness ─────────────────────
//
// These tests use a seeded PRNG to generate random message sequences and verify
// structural invariants of the two-tier persistence system. Each test runs many
// iterations with different random inputs to stress edge cases that hand-written
// tests might miss.

describe("property-based: frozen history correctness", () => {
  // ── Seeded PRNG (Mulberry32) ────────────────────────────────────────────
  // Deterministic 32-bit PRNG so test failures are reproducible. Pass any
  // integer seed. Returns a function producing numbers in [0, 1).
  function mulberry32(seed: number): () => number {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Random message generators ──────────────────────────────────────────
  // Message types that appear in real sessions. The key property is that
  // "result" marks the freeze boundary — everything up to the last result
  // is frozen, and everything after stays hot.

  type MsgType = "user_message" | "assistant" | "assistant_with_tool" | "stream_event" | "result" | "error";
  const MSG_TYPES: MsgType[] = ["user_message", "assistant", "assistant_with_tool", "stream_event", "result", "error"];

  /** Build a single message of the given type. Includes a unique marker so
   *  we can verify ordering and identity after round-trip. */
  function makeMsg(type: MsgType, index: number): PersistedSession["messageHistory"][number] {
    switch (type) {
      case "user_message":
        return {
          type: "user_message",
          content: `user-${index}`,
          timestamp: 1000 + index,
        } as PersistedSession["messageHistory"][number];
      case "assistant":
        return {
          type: "assistant",
          message: {
            id: `msg-${index}`,
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            content: [{ type: "text", text: `asst-${index}` }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 1000 + index,
        } as PersistedSession["messageHistory"][number];
      case "assistant_with_tool":
        return {
          type: "assistant",
          message: {
            id: `msg-${index}`,
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            content: [
              { type: "text", text: `asst-tool-${index}` },
              { type: "tool_use", id: `tu-${index}`, name: "Read", input: {} },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 1000 + index,
        } as PersistedSession["messageHistory"][number];
      case "stream_event":
        return {
          type: "stream_event",
          event: { content: `stream-${index}` },
          parent_tool_use_id: null,
        } as PersistedSession["messageHistory"][number];
      case "result":
        return {
          type: "result",
          data: { type: "result", subtype: "success", uuid: `result-${index}` },
        } as PersistedSession["messageHistory"][number];
      case "error":
        return {
          type: "error",
          message: `error-${index}`,
        } as PersistedSession["messageHistory"][number];
    }
  }

  /** Generate a random message sequence of `count` messages.
   *  Ensures at least some structural realism: user messages precede
   *  assistants, and result messages only appear after at least one
   *  non-result message (to avoid empty turns). */
  function randomMessageSequence(rng: () => number, count: number): PersistedSession["messageHistory"] {
    const msgs: PersistedSession["messageHistory"] = [];
    for (let i = 0; i < count; i++) {
      const typeIdx = Math.floor(rng() * MSG_TYPES.length);
      msgs.push(makeMsg(MSG_TYPES[typeIdx], i));
    }
    return msgs;
  }

  /** Generate tool results corresponding to assistant_with_tool messages. */
  function toolResultsForMessages(
    msgs: PersistedSession["messageHistory"],
  ): NonNullable<PersistedSession["toolResults"]> {
    const results: NonNullable<PersistedSession["toolResults"]> = [];
    for (const msg of msgs) {
      if ((msg as { type: string }).type !== "assistant") continue;
      const content = (msg as { message?: { content?: Array<{ type: string; id?: string }> } }).message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "tool_use" && block.id) {
          results.push([block.id, { content: `result-for-${block.id}`, is_error: false, timestamp: Date.now() }]);
        }
      }
    }
    return results;
  }

  /** Compute the expected freeze cutoff: index after the last "result" message. */
  function expectedFreezeCutoff(msgs: PersistedSession["messageHistory"]): number {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if ((msgs[i] as { type: string }).type === "result") return i + 1;
    }
    return 0;
  }

  /** Generate a realistic multi-turn message sequence:
   *  N completed turns (user → assistant_with_tool → result) + optional
   *  in-progress tail (user → assistant, no result). This mirrors real
   *  session patterns more closely than fully random sequences. */
  function realisticSequence(
    rng: () => number,
    completedTurns: number,
    inProgressMessages: number,
  ): { messages: PersistedSession["messageHistory"]; toolResults: NonNullable<PersistedSession["toolResults"]> } {
    const msgs: PersistedSession["messageHistory"] = [];
    const toolResults: NonNullable<PersistedSession["toolResults"]> = [];
    let idx = 0;

    for (let t = 0; t < completedTurns; t++) {
      // User message
      msgs.push(makeMsg("user_message", idx++));
      // 1-3 assistant messages (some with tools)
      const assistantCount = 1 + Math.floor(rng() * 3);
      for (let a = 0; a < assistantCount; a++) {
        const hasTools = rng() > 0.4;
        if (hasTools) {
          msgs.push(makeMsg("assistant_with_tool", idx));
          toolResults.push([`tu-${idx}`, { content: `result-${idx}`, is_error: rng() > 0.9, timestamp: 1000 + idx }]);
        } else {
          msgs.push(makeMsg("assistant", idx));
        }
        idx++;
      }
      // Optional stream events
      const streamCount = Math.floor(rng() * 3);
      for (let s = 0; s < streamCount; s++) {
        msgs.push(makeMsg("stream_event", idx++));
      }
      // Result
      msgs.push(makeMsg("result", idx++));
    }

    // In-progress tail (no result)
    for (let i = 0; i < inProgressMessages; i++) {
      const type = rng() > 0.5 ? "user_message" : rng() > 0.5 ? "assistant" : "stream_event";
      msgs.push(makeMsg(type as MsgType, idx++));
    }

    return { messages: msgs, toolResults };
  }

  const ITERATIONS = 80;

  // ── P1: Round-trip correctness ──────────────────────────────────────────
  // For ANY sequence of messages, save() → load() must reconstruct the
  // exact same messageHistory and toolResults.
  it("P1: round-trip correctness — random message sequences", async () => {
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rng = mulberry32(seed);
      const msgCount = Math.floor(rng() * 30);
      const messages = randomMessageSequence(rng, msgCount);
      const toolResults = toolResultsForMessages(messages);

      const sessionId = `p1-${seed}`;
      const session = makeSession(sessionId, {
        messageHistory: [...messages],
        toolResults: [...toolResults],
      });

      store.saveSync(session);
      await store.flushAll();

      const loaded = await store.load(sessionId);
      expect(loaded, `seed=${seed}: load() returned null`).not.toBeNull();
      expect(loaded!.messageHistory).toHaveLength(messages.length);

      // Deep equality on each message to catch serialization drift
      for (let i = 0; i < messages.length; i++) {
        expect(loaded!.messageHistory[i], `seed=${seed}: msg[${i}] mismatch`).toEqual(messages[i]);
      }

      // Tool results must round-trip exactly
      expect(loaded!.toolResults ?? [], `seed=${seed}: toolResults length`).toHaveLength(toolResults.length);
      for (let i = 0; i < toolResults.length; i++) {
        expect(loaded!.toolResults![i][0], `seed=${seed}: toolResult[${i}] key`).toBe(toolResults[i][0]);
        expect(loaded!.toolResults![i][1].content, `seed=${seed}: toolResult[${i}] content`).toBe(
          toolResults[i][1].content,
        );
      }

      // Clean up files to keep the test directory manageable
      store.remove(sessionId);
      await store.flushAll();
    }
  });

  // ── P2: Incremental freeze is append-only ───────────────────────────────
  // After each save, the JSONL content from the previous save must be a
  // prefix of the current content (existing lines are never modified).
  it("P2: JSONL is append-only — content from previous save is a prefix", async () => {
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rng = mulberry32(seed + 10000);
      const sessionId = `p2-${seed}`;

      // Build turns incrementally: start with T1, then add T2, etc.
      const totalTurns = 1 + Math.floor(rng() * 5);
      let allMessages: PersistedSession["messageHistory"] = [];
      let allToolResults: NonNullable<PersistedSession["toolResults"]> = [];
      let prevLogContent = "";

      for (let t = 0; t < totalTurns; t++) {
        const { messages: turnMsgs, toolResults: turnTr } = realisticSequence(rng, 1, 0);
        allMessages = [...allMessages, ...turnMsgs];
        allToolResults = [...allToolResults, ...turnTr];

        const session = makeSession(sessionId, {
          messageHistory: [...allMessages],
          toolResults: [...allToolResults],
        });

        store.saveSync(session);
        await store.flushAll();

        const logPath = join(tempDir, `${sessionId}.history.jsonl`);
        if (existsSync(logPath)) {
          const currentLog = readFileSync(logPath, "utf-8");
          if (prevLogContent) {
            expect(
              currentLog.startsWith(prevLogContent),
              `seed=${seed}, turn=${t}: JSONL is not append-only — previous content not a prefix`,
            ).toBe(true);
          }
          prevLogContent = currentLog;
        }
      }

      store.remove(sessionId);
      await store.flushAll();
    }
  });

  // ── P4: Tool results are never lost ─────────────────────────────────────
  // For any sequence of saves, all tool results present in the input must
  // be present in the loaded output.
  it("P4: tool results are never lost across save/load", async () => {
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rng = mulberry32(seed + 30000);
      const sessionId = `p4-${seed}`;
      const totalTurns = 1 + Math.floor(rng() * 5);
      let allMessages: PersistedSession["messageHistory"] = [];
      let allToolResults: NonNullable<PersistedSession["toolResults"]> = [];

      // Build up incrementally — save after each turn
      for (let t = 0; t < totalTurns; t++) {
        const { messages: turnMsgs, toolResults: turnTr } = realisticSequence(rng, 1, 0);
        allMessages = [...allMessages, ...turnMsgs];
        allToolResults = [...allToolResults, ...turnTr];

        const session = makeSession(sessionId, {
          messageHistory: [...allMessages],
          toolResults: [...allToolResults],
        });
        store.saveSync(session);
        await store.flushAll();
      }

      // Add some in-progress messages (no new tool results)
      const ipCount = Math.floor(rng() * 5);
      for (let i = 0; i < ipCount; i++) {
        allMessages = [...allMessages, makeMsg("stream_event", 9000 + i)];
      }
      const finalSession = makeSession(sessionId, {
        messageHistory: [...allMessages],
        toolResults: [...allToolResults],
      });
      store.saveSync(finalSession);
      await store.flushAll();

      const loaded = await store.load(sessionId);
      expect(loaded, `seed=${seed}: null`).not.toBeNull();

      // Every tool result key must be present
      const loadedKeys = new Set((loaded!.toolResults ?? []).map(([k]) => k));
      for (const [key] of allToolResults) {
        expect(loadedKeys.has(key), `seed=${seed}: missing tool result "${key}"`).toBe(true);
      }
      expect(loaded!.toolResults ?? []).toHaveLength(allToolResults.length);

      store.remove(sessionId);
      await store.flushAll();
    }
  });

  // ── P5: Freeze boundary is correct ──────────────────────────────────────
  // The number of frozen messages (recorded in hot JSON) equals the index
  // after the last "result" message in the full history.
  it("P5: _frozenCount equals index after last result message", async () => {
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rng = mulberry32(seed + 40000);
      const msgCount = 1 + Math.floor(rng() * 30);
      const messages = randomMessageSequence(rng, msgCount);
      const toolResults = toolResultsForMessages(messages);

      const sessionId = `p5-${seed}`;
      const session = makeSession(sessionId, {
        messageHistory: [...messages],
        toolResults: [...toolResults],
      });

      store.saveSync(session);
      await store.flushAll();

      const hotRaw = JSON.parse(readFileSync(join(tempDir, `${sessionId}.json`), "utf-8"));
      const expected = expectedFreezeCutoff(messages);

      expect(hotRaw._frozenCount, `seed=${seed}: _frozenCount=${hotRaw._frozenCount} but expected=${expected}`).toBe(
        expected,
      );

      store.remove(sessionId);
      await store.flushAll();
    }
  });

  // ── P6: Crash recovery — JSONL ahead of hot JSON ────────────────────────
  // Simulates a crash between JSONL append and hot JSON write. After
  // recovery, load() must reconstruct the correct history without
  // message duplication or gaps.
  it("P6: crash recovery — load() deduplicates overlap after partial write", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed + 50000);
      const sessionId = `p6-${seed}`;

      // Phase 1: save N completed turns normally
      const phase1Turns = 1 + Math.floor(rng() * 3);
      const { messages: phase1Msgs, toolResults: phase1Tr } = realisticSequence(rng, phase1Turns, 0);

      const session = makeSession(sessionId, {
        messageHistory: [...phase1Msgs],
        toolResults: [...phase1Tr],
      });
      store.saveSync(session);
      await store.flushAll();

      // Record the frozen count from the hot JSON before "crash"
      const hotBefore = JSON.parse(readFileSync(join(tempDir, `${sessionId}.json`), "utf-8"));
      const frozenBefore = hotBefore._frozenCount as number;

      // Phase 2: generate one more completed turn and manually append
      // it to the JSONL (simulating JSONL write succeeded, hot write didn't)
      const { messages: crashTurnMsgs, toolResults: crashTurnTr } = realisticSequence(rng, 1, 0);

      let appendData = "";
      for (const msg of crashTurnMsgs) {
        appendData += JSON.stringify(msg) + "\n";
      }
      if (crashTurnTr.length > 0) {
        appendData += JSON.stringify({ _toolResults: crashTurnTr }) + "\n";
      }

      const { appendFile: fsAppendFile } = await import("node:fs/promises");
      await fsAppendFile(join(tempDir, `${sessionId}.history.jsonl`), appendData, "utf-8");

      // Hot JSON is stale — it still has the old _frozenCount. Rewrite
      // it to include the crash turn's messages in the hot tail (this
      // is what would happen: the hot JSON still has the previous hot
      // tail that included these messages before the freeze attempted).
      hotBefore.messageHistory = [...crashTurnMsgs];
      hotBefore.toolResults = [...crashTurnTr];
      // _frozenCount stays at frozenBefore (stale)
      writeFileSync(join(tempDir, `${sessionId}.json`), JSON.stringify(hotBefore), "utf-8");

      // Load with a fresh store (no in-memory state)
      const freshStore = new SessionStore(tempDir);
      const loaded = await freshStore.load(sessionId);
      expect(loaded, `seed=${seed}: null after crash recovery`).not.toBeNull();

      // Total messages = phase1 + crash turn (no duplicates)
      const expectedTotal = phase1Msgs.length + crashTurnMsgs.length;
      expect(
        loaded!.messageHistory.length,
        `seed=${seed}: expected ${expectedTotal} msgs but got ${loaded!.messageHistory.length} (frozenBefore=${frozenBefore})`,
      ).toBe(expectedTotal);

      // Verify ordering: phase1 messages come first, then crash turn
      for (let i = 0; i < phase1Msgs.length; i++) {
        expect(loaded!.messageHistory[i], `seed=${seed}: phase1 msg[${i}]`).toEqual(phase1Msgs[i]);
      }
      for (let i = 0; i < crashTurnMsgs.length; i++) {
        expect(loaded!.messageHistory[phase1Msgs.length + i], `seed=${seed}: crash msg[${i}]`).toEqual(
          crashTurnMsgs[i],
        );
      }

      store.remove(sessionId);
      await store.flushAll();
    }
  });

  // ── P8: Multiple save-load cycles are idempotent ────────────────────────
  // Repeated save → load → save → load cycles must not cause data growth
  // (no duplicate freezing) or corruption.
  it("P8: repeated save → load → save → load cycles are idempotent", async () => {
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rng = mulberry32(seed + 70000);
      const sessionId = `p8-${seed}`;

      const completedTurns = 1 + Math.floor(rng() * 4);
      const inProgress = Math.floor(rng() * 5);
      const { messages, toolResults } = realisticSequence(rng, completedTurns, inProgress);

      // First save
      const session = makeSession(sessionId, {
        messageHistory: [...messages],
        toolResults: [...toolResults],
      });
      store.saveSync(session);
      await store.flushAll();

      // Read the JSONL after first save
      const logPath = join(tempDir, `${sessionId}.history.jsonl`);
      const logAfterFirst = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";

      // N cycles of load → save
      const cycles = 2 + Math.floor(rng() * 3);
      for (let c = 0; c < cycles; c++) {
        const loaded = await store.load(sessionId);
        expect(loaded, `seed=${seed}, cycle=${c}: null`).not.toBeNull();

        // Verify message count is stable
        expect(loaded!.messageHistory, `seed=${seed}, cycle=${c}: msg count`).toHaveLength(messages.length);
        expect(loaded!.toolResults ?? [], `seed=${seed}, cycle=${c}: tr count`).toHaveLength(toolResults.length);

        // Re-save the loaded session (this must not re-freeze)
        store.saveSync(loaded!);
        await store.flushAll();
      }

      // JSONL must not have grown (no duplicate appends)
      const logAfterCycles = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      expect(logAfterCycles, `seed=${seed}: JSONL grew after ${cycles} cycles`).toBe(logAfterFirst);

      store.remove(sessionId);
      await store.flushAll();
    }
  });
});
