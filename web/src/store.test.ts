// @vitest-environment jsdom

const mockListQuests = vi.fn();

// vi.hoisted runs before any imports, ensuring browser globals are available when store.ts initializes.
vi.hoisted(() => {
  // jsdom does not implement matchMedia
  Object.defineProperty(globalThis.window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  // Node.js 22+ native localStorage may be broken (invalid --localstorage-file).
  // Polyfill before store.ts import triggers getInitialSessionId().
  if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.getItem !== "function") {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, String(value));
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
        get length() {
          return store.size;
        },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
});

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listQuests: (...args: unknown[]) => mockListQuests(...args),
    },
  };
});

import { resetQuestRefreshStateForTests, reconcileQuestList, useStore } from "./store.js";
import { setSdkSessionsWithNotificationFreshness } from "./notification-status.js";
import type { SessionState, PermissionRequest, ChatMessage, TaskItem, SdkSessionInfo } from "./types.js";

function makeSession(id: string): SessionState {
  return {
    session_id: id,
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0",
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
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makePermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    request_id: crypto.randomUUID(),
    tool_name: "Bash",
    input: { command: "ls" },
    timestamp: Date.now(),
    tool_use_id: crypto.randomUUID(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: crypto.randomUUID(),
    subject: "Do something",
    description: "A task",
    status: "pending",
    ...overrides,
  };
}

function makeQuest(
  overrides: Partial<import("./types.js").QuestmasterTask> = {},
): import("./types.js").QuestmasterTask {
  return {
    id: "q-1-v1",
    questId: "q-1",
    version: 1,
    title: "Quest",
    createdAt: 1_000,
    status: "idea",
    ...overrides,
  } as import("./types.js").QuestmasterTask;
}

beforeEach(() => {
  useStore.getState().reset();
  resetQuestRefreshStateForTests();
  mockListQuests.mockReset();
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
});

// ─── Session management ─────────────────────────────────────────────────────

describe("Session management", () => {
  it("addSession: adds to sessions map and initializes empty messages", () => {
    const session = makeSession("s1");
    useStore.getState().addSession(session);

    const state = useStore.getState();
    expect(state.sessions.get("s1")).toEqual(session);
    expect(state.messages.get("s1")).toEqual([]);
  });

  it("addSession: does not overwrite existing messages", () => {
    const session = makeSession("s1");
    const msg = makeMessage({ role: "user", content: "existing" });
    useStore.getState().addSession(session);
    useStore.getState().appendMessage("s1", msg);

    // Re-add the same session
    useStore.getState().addSession(session);
    const state = useStore.getState();
    expect(state.messages.get("s1")).toHaveLength(1);
    expect(state.messages.get("s1")![0].content).toBe("existing");
  });

  it("updateSession: merges partial updates into existing session", () => {
    const session = makeSession("s1");
    useStore.getState().addSession(session);
    useStore.getState().updateSession("s1", { model: "claude-opus-4-6", num_turns: 5 });

    const updated = useStore.getState().sessions.get("s1")!;
    expect(updated.model).toBe("claude-opus-4-6");
    expect(updated.num_turns).toBe(5);
    // Other fields remain untouched
    expect(updated.cwd).toBe("/test");
    expect(updated.session_id).toBe("s1");
  });

  it("updateSession: no-op for unknown session", () => {
    const before = new Map(useStore.getState().sessions);
    useStore.getState().updateSession("nonexistent", { model: "claude-opus-4-6" });
    const after = useStore.getState().sessions;
    expect(after.size).toBe(before.size);
  });

  it("removeSession: cleans all maps and clears currentSessionId if removed was current", () => {
    const session = makeSession("s1");
    useStore.getState().addSession(session);
    useStore.getState().setCurrentSession("s1");
    useStore.getState().appendMessage("s1", makeMessage());
    useStore.getState().setStreaming("s1", "partial text");
    useStore.getState().setStreamingStats("s1", { startedAt: 100, outputTokens: 50 });
    useStore.getState().addPermission("s1", makePermission());
    useStore.getState().addTask("s1", makeTask());
    useStore.getState().setSessionName("s1", "My Session");
    useStore.getState().setConnectionStatus("s1", "connected");
    useStore.getState().setCliConnected("s1", true);
    useStore.getState().setSessionStatus("s1", "running");
    useStore.getState().setPreviousPermissionMode("s1", "default");

    useStore.getState().removeSession("s1");
    const state = useStore.getState();

    expect(state.sessions.has("s1")).toBe(false);
    expect(state.messages.has("s1")).toBe(false);
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.streamingStartedAt.has("s1")).toBe(false);
    expect(state.streamingOutputTokens.has("s1")).toBe(false);
    expect(state.pendingPermissions.has("s1")).toBe(false);
    expect(state.sessionTasks.has("s1")).toBe(false);
    expect(state.sessionNames.has("s1")).toBe(false);
    expect(state.connectionStatus.has("s1")).toBe(false);
    expect(state.cliConnected.has("s1")).toBe(false);
    expect(state.sessionStatus.has("s1")).toBe(false);
    expect(state.previousPermissionMode.has("s1")).toBe(false);
    expect(state.currentSessionId).toBeNull();
  });

  it("removeSession: filters sdkSessions by sessionId", () => {
    const sdk1: SdkSessionInfo = {
      sessionId: "s1",
      state: "connected",
      cwd: "/test",
      createdAt: Date.now(),
    };
    const sdk2: SdkSessionInfo = {
      sessionId: "s2",
      state: "running",
      cwd: "/other",
      createdAt: Date.now(),
    };
    useStore.getState().setSdkSessions([sdk1, sdk2]);
    useStore.getState().addSession(makeSession("s1"));

    useStore.getState().removeSession("s1");
    const state = useStore.getState();
    expect(state.sdkSessions).toHaveLength(1);
    expect(state.sdkSessions[0].sessionId).toBe("s2");
  });

  it("setSdkSessions: hydrates non-current running status from the polled session list", () => {
    useStore.getState().setCurrentSession("current");
    useStore.getState().setSessionStatus("other", "idle");
    useStore.getState().setCliDisconnectReason("other", "idle_limit");

    useStore.getState().setSdkSessions([
      {
        sessionId: "current",
        state: "connected",
        cwd: "/current",
        createdAt: Date.now(),
        cliConnected: true,
      },
      {
        sessionId: "other",
        state: "running",
        cwd: "/other",
        createdAt: Date.now(),
        cliConnected: true,
      },
    ]);

    const state = useStore.getState();
    expect(state.sessionStatus.get("other")).toBe("running");
    expect(state.cliConnected.get("other")).toBe(true);
    expect(state.cliEverConnected.get("other")).toBe(true);
    expect(state.cliDisconnectReason.get("other")).toBeNull();
  });

  it("setSdkSessions: clears stale non-current running state when the poll reports idle", () => {
    useStore.getState().setSessionStatus("other", "running");

    useStore.getState().setSdkSessions([
      {
        sessionId: "other",
        state: "connected",
        cwd: "/other",
        createdAt: Date.now(),
        cliConnected: true,
      },
    ]);

    expect(useStore.getState().sessionStatus.has("other")).toBe(false);
  });

  it("setSdkSessions: preserves the current session's live websocket status", () => {
    useStore.getState().setCurrentSession("current");
    useStore.getState().setSessionStatus("current", "compacting");

    useStore.getState().setSdkSessions([
      {
        sessionId: "current",
        state: "running",
        cwd: "/current",
        createdAt: Date.now(),
        cliConnected: true,
      },
    ]);

    expect(useStore.getState().sessionStatus.get("current")).toBe("compacting");
  });

  it("setSdkSessions: preserves the existing array reference when the payload is semantically unchanged", () => {
    const initial: SdkSessionInfo[] = [
      {
        sessionId: "s1",
        state: "connected",
        cwd: "/repo",
        createdAt: 123,
        cliConnected: true,
        name: "Worker",
        taskHistory: [{ title: "Task", action: "new", timestamp: 1, triggerMessageId: "m1" }],
        keywords: ["alpha"],
      },
    ];
    useStore.getState().setSdkSessions(initial);
    const previousRef = useStore.getState().sdkSessions;

    useStore.getState().setSdkSessions([
      {
        sessionId: "s1",
        state: "connected",
        cwd: "/repo",
        createdAt: 123,
        cliConnected: true,
        name: "Worker",
        taskHistory: [{ title: "Task", action: "new", timestamp: 1, triggerMessageId: "m1" }],
        keywords: ["beta"],
      },
    ]);

    expect(useStore.getState().sdkSessions).toBe(previousRef);
  });

  it("setSdkSessions: updates sdkSessions when only pendingTimerCount changes", () => {
    // Non-selected sidebar rows derive timer visibility from the polled
    // sdkSessions snapshot, so a timer-count-only change must not be treated
    // as semantically unchanged by the store equality guard.
    useStore.getState().setCurrentSession("current");
    useStore.getState().setSdkSessions([
      {
        sessionId: "worker",
        state: "connected",
        cwd: "/repo",
        createdAt: 123,
        cliConnected: true,
        pendingTimerCount: 0,
      },
    ]);
    const previousRef = useStore.getState().sdkSessions;

    useStore.getState().setSdkSessions([
      {
        sessionId: "worker",
        state: "connected",
        cwd: "/repo",
        createdAt: 123,
        cliConnected: true,
        pendingTimerCount: 1,
      },
    ]);

    const state = useStore.getState();
    expect(state.sdkSessions).not.toBe(previousRef);
    expect(state.sdkSessions[0]?.pendingTimerCount).toBe(1);
  });

  it("setSdkSessions: updates sdkSessions when only notification summary changes", () => {
    // Non-selected sidebar rows derive restored notification markers from the
    // polled sdkSessions snapshot, so a summary-only change must trigger
    // reconciliation even when the full notification inbox is not loaded.
    useStore.getState().setCurrentSession("current");
    useStore.getState().setSdkSessions([
      {
        sessionId: "worker",
        state: "connected",
        cwd: "/repo",
        createdAt: 123,
        cliConnected: true,
        notificationUrgency: null,
        activeNotificationCount: 0,
      },
    ]);
    const previousRef = useStore.getState().sdkSessions;

    useStore.getState().setSdkSessions([
      {
        sessionId: "worker",
        state: "connected",
        cwd: "/repo",
        createdAt: 123,
        cliConnected: true,
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
      },
    ]);

    const state = useStore.getState();
    expect(state.sdkSessions).not.toBe(previousRef);
    expect(state.sdkSessions[0]).toMatchObject({
      notificationUrgency: "needs-input",
      activeNotificationCount: 1,
    });
  });

  it("setSdkSessionsWithNotificationFreshness: keeps newer cleared notification status over stale REST data", () => {
    // A slow /api/sessions response may contain an older needs-input summary.
    // The freshness wrapper must preserve the newer resolved status already in the store.
    useStore.getState().setSdkSessions([
      {
        sessionId: "worker",
        state: "connected",
        cwd: "/repo",
        createdAt: 123,
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 5,
        notificationStatusUpdatedAt: 5000,
      },
    ]);

    setSdkSessionsWithNotificationFreshness([
      {
        sessionId: "worker",
        state: "connected",
        cwd: "/repo",
        createdAt: 123,
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
        notificationStatusVersion: 4,
        notificationStatusUpdatedAt: 4000,
      },
    ]);

    expect(useStore.getState().sdkSessions[0]).toMatchObject({
      notificationUrgency: null,
      activeNotificationCount: 0,
      notificationStatusVersion: 5,
      notificationStatusUpdatedAt: 5000,
    });
  });

  it("setSessionTaskHistory: preserves the existing map when tasks are unchanged", () => {
    const tasks = [{ title: "Task", action: "new", timestamp: 1, triggerMessageId: "m1" }] as const;
    useStore.getState().setSessionTaskHistory("s1", [...tasks]);
    const previousMap = useStore.getState().sessionTaskHistory;

    useStore.getState().setSessionTaskHistory("s1", [...tasks]);

    expect(useStore.getState().sessionTaskHistory).toBe(previousMap);
  });

  it("setSessionKeywords: preserves the existing map when keywords are unchanged", () => {
    useStore.getState().setSessionKeywords("s1", ["alpha", "beta"]);
    const previousMap = useStore.getState().sessionKeywords;

    useStore.getState().setSessionKeywords("s1", ["alpha", "beta"]);

    expect(useStore.getState().sessionKeywords).toBe(previousMap);
  });

  it("removeSession: does not clear currentSessionId if a different session is removed", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().addSession(makeSession("s2"));
    useStore.getState().setCurrentSession("s1");

    useStore.getState().removeSession("s2");
    expect(useStore.getState().currentSessionId).toBe("s1");
  });

  it("setCurrentSession: persists to localStorage", () => {
    useStore.getState().setCurrentSession("s1");
    expect(useStore.getState().currentSessionId).toBe("s1");
    expect(localStorage.getItem("test-server:cc-current-session")).toBe("s1");
  });

  it("setCurrentSession(null): removes from localStorage", () => {
    useStore.getState().setCurrentSession("s1");
    useStore.getState().setCurrentSession(null);
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(localStorage.getItem("test-server:cc-current-session")).toBeNull();
  });
});

describe("Questmaster refresh", () => {
  it("reconcileQuestList preserves object identity for unchanged quests", () => {
    const unchanged = makeQuest({ id: "q-1-v2", questId: "q-1", version: 2, updatedAt: 2000 });
    const changed = makeQuest({ id: "q-2-v1", questId: "q-2", version: 1, title: "Before" });
    const prev = [unchanged, changed];

    const next = reconcileQuestList(prev, [
      { ...unchanged },
      { ...changed, id: "q-2-v2", version: 2, title: "After", updatedAt: 3000 },
    ]);

    expect(next[0]).toBe(unchanged);
    expect(next[1]).not.toBe(changed);
    expect(next[1].title).toBe("After");
  });

  it("refreshQuests skips hidden background polls entirely", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    mockListQuests.mockResolvedValue([makeQuest()]);

    await useStore.getState().refreshQuests({ background: true });

    expect(mockListQuests).not.toHaveBeenCalled();
  });

  it("refreshQuests preserves the empty quests array on empty background refreshes", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const previousRef = useStore.getState().quests;
    mockListQuests.mockResolvedValue([]);

    await useStore.getState().refreshQuests({ background: true, force: true });

    expect(useStore.getState().quests).toBe(previousRef);
  });

  it("refreshQuests preserves unchanged quest references on background refresh", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const existing = makeQuest({ id: "q-1-v2", questId: "q-1", version: 2, updatedAt: 2_000 });
    const untouched = makeQuest({ id: "q-2-v1", questId: "q-2", version: 1, updatedAt: 1_500 });
    useStore.getState().setQuests([existing, untouched]);
    const previousRef = useStore.getState().quests;

    mockListQuests.mockResolvedValue([
      { ...existing },
      { ...untouched, id: "q-2-v2", version: 2, updatedAt: 3_000, title: "Updated title" },
    ]);

    await useStore.getState().refreshQuests({ background: true, force: true });

    const quests = useStore.getState().quests;
    expect(quests).not.toBe(previousRef);
    expect(quests[0]).toBe(existing);
    expect(quests[1]).not.toBe(untouched);
    expect(quests[1].title).toBe("Updated title");
  });
});

// ─── Messages ───────────────────────────────────────────────────────────────

describe("Messages", () => {
  it("appendMessage: adds to session's list", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg = makeMessage({ content: "first" });
    useStore.getState().appendMessage("s1", msg);

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("first");
  });

  it("appendMessage: creates list even if session was not pre-initialized", () => {
    const msg = makeMessage({ content: "orphan" });
    useStore.getState().appendMessage("s1", msg);
    expect(useStore.getState().messages.get("s1")).toHaveLength(1);
  });

  it("appendMessage: deduplicates by ID", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg = makeMessage({ id: "dup-1", content: "first" });
    useStore.getState().appendMessage("s1", msg);
    useStore.getState().appendMessage("s1", { ...msg, content: "duplicate" });

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("first");
  });

  it("appendMessage: allows messages without IDs (no dedup)", () => {
    useStore.getState().addSession(makeSession("s1"));
    const msg1 = makeMessage({ id: "", content: "a" });
    const msg2 = makeMessage({ id: "", content: "b" });
    useStore.getState().appendMessage("s1", msg1);
    useStore.getState().appendMessage("s1", msg2);

    expect(useStore.getState().messages.get("s1")).toHaveLength(2);
  });

  it("setMessages: replaces all messages for a session", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ content: "old" }));

    const newMessages = [makeMessage({ content: "new1" }), makeMessage({ content: "new2" })];
    useStore.getState().setMessages("s1", newMessages);

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("new1");
    expect(messages[1].content).toBe("new2");
  });

  it("setMessages: records the frozen boundary when provided", () => {
    useStore.getState().addSession(makeSession("s1"));
    const newMessages = [
      makeMessage({ content: "new1" }),
      makeMessage({ content: "new2" }),
      makeMessage({ content: "new3" }),
    ];

    useStore.getState().setMessages("s1", newMessages, { frozenCount: 2 });

    expect(useStore.getState().messageFrozenCounts.get("s1")).toBe(2);
    expect(useStore.getState().messageFrozenRevisions.get("s1")).toBe(0);
  });

  it("commitMessagesAsFrozen: freezes the current message tail without rebuilding messages", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ content: "u1" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "a1" }));

    useStore.getState().commitMessagesAsFrozen("s1");

    expect(useStore.getState().messageFrozenCounts.get("s1")).toBe(2);
    expect(useStore.getState().messages.get("s1")).toHaveLength(2);
  });

  it("updateMessage: bumps the frozen revision when editing a frozen message", () => {
    useStore.getState().addSession(makeSession("s1"));
    const first = makeMessage({ id: "frozen", content: "old" });
    const second = makeMessage({ id: "active", content: "tail" });
    useStore.getState().setMessages("s1", [first, second], { frozenCount: 1 });

    useStore.getState().updateMessage("s1", "frozen", { content: "new" });

    expect(useStore.getState().messageFrozenRevisions.get("s1")).toBe(1);
  });

  it("updateMessage: does not bump the frozen revision for active-tail edits", () => {
    useStore.getState().addSession(makeSession("s1"));
    const first = makeMessage({ id: "frozen", content: "old" });
    const second = makeMessage({ id: "active", content: "tail" });
    useStore.getState().setMessages("s1", [first, second], { frozenCount: 1 });

    useStore.getState().updateMessage("s1", "active", { content: "new-tail" });

    expect(useStore.getState().messageFrozenRevisions.get("s1")).toBe(0);
  });

  it("updateLastAssistantMessage: updates the last assistant message", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ role: "user", content: "q" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "a1" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "a2" }));

    useStore.getState().updateLastAssistantMessage("s1", (msg) => ({
      ...msg,
      content: "a2-updated",
    }));

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages[1].content).toBe("a1"); // first assistant unchanged
    expect(messages[2].content).toBe("a2-updated"); // last assistant updated
  });

  it("updateLastAssistantMessage: skips non-assistant messages from end", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().appendMessage("s1", makeMessage({ role: "assistant", content: "answer" }));
    useStore.getState().appendMessage("s1", makeMessage({ role: "user", content: "followup" }));

    useStore.getState().updateLastAssistantMessage("s1", (msg) => ({
      ...msg,
      content: "answer-updated",
    }));

    const messages = useStore.getState().messages.get("s1")!;
    expect(messages[0].content).toBe("answer-updated");
    expect(messages[1].content).toBe("followup");
  });
});

// ─── Streaming ──────────────────────────────────────────────────────────────

describe("Streaming", () => {
  it("setStreaming: sets text for a session", () => {
    useStore.getState().setStreaming("s1", "partial output");
    expect(useStore.getState().streaming.get("s1")).toBe("partial output");
  });

  it("setStreaming(null): deletes entry", () => {
    useStore.getState().setStreaming("s1", "some text");
    useStore.getState().setStreaming("s1", null);
    expect(useStore.getState().streaming.has("s1")).toBe(false);
  });

  it("setStreamingStats: sets startedAt and outputTokens", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 12345, outputTokens: 42 });
    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(12345);
    expect(useStore.getState().streamingOutputTokens.get("s1")).toBe(42);
  });

  it("setStreamingStats: sets only provided fields", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 100 });
    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(100);
    expect(useStore.getState().streamingOutputTokens.has("s1")).toBe(false);
  });

  it("setStreamingStats(null): clears both fields", () => {
    useStore.getState().setStreamingStats("s1", { startedAt: 100, outputTokens: 50 });
    useStore.getState().setStreamingStats("s1", null);
    expect(useStore.getState().streamingStartedAt.has("s1")).toBe(false);
    expect(useStore.getState().streamingOutputTokens.has("s1")).toBe(false);
  });
});

describe("Bottom-align next user message", () => {
  it("tracks and clears a one-shot bottom-align request per session", () => {
    useStore.getState().requestBottomAlignOnNextUserMessage("s1");
    expect(useStore.getState().bottomAlignNextUserMessage.has("s1")).toBe(true);

    useStore.getState().clearBottomAlignOnNextUserMessage("s1");
    expect(useStore.getState().bottomAlignNextUserMessage.has("s1")).toBe(false);
  });
});

// ─── Permissions ────────────────────────────────────────────────────────────

describe("Permissions", () => {
  it("addPermission: adds to nested map", () => {
    const perm = makePermission({ request_id: "r1", tool_name: "Bash" });
    useStore.getState().addPermission("s1", perm);

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.get("r1")).toEqual(perm);
  });

  it("addPermission: accumulates multiple permissions", () => {
    const perm1 = makePermission({ request_id: "r1" });
    const perm2 = makePermission({ request_id: "r2" });
    useStore.getState().addPermission("s1", perm1);
    useStore.getState().addPermission("s1", perm2);

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.size).toBe(2);
  });

  it("removePermission: removes specific request", () => {
    const perm1 = makePermission({ request_id: "r1" });
    const perm2 = makePermission({ request_id: "r2" });
    useStore.getState().addPermission("s1", perm1);
    useStore.getState().addPermission("s1", perm2);

    useStore.getState().removePermission("s1", "r1");

    const sessionPerms = useStore.getState().pendingPermissions.get("s1")!;
    expect(sessionPerms.has("r1")).toBe(false);
    expect(sessionPerms.has("r2")).toBe(true);
  });
});

// ─── Tasks ──────────────────────────────────────────────────────────────────

describe("Tasks", () => {
  it("addTask: appends task to session list", () => {
    const task = makeTask({ id: "t1", subject: "Fix bug" });
    useStore.getState().addTask("s1", task);

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Fix bug");
  });

  it("setTasks: replaces all tasks for a session", () => {
    useStore.getState().addTask("s1", makeTask({ subject: "old" }));
    const newTasks = [makeTask({ subject: "new1" }), makeTask({ subject: "new2" })];
    useStore.getState().setTasks("s1", newTasks);

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subject).toBe("new1");
    expect(tasks[1].subject).toBe("new2");
  });

  it("updateTask: merges updates into matching task without affecting others", () => {
    const task1 = makeTask({ id: "t1", subject: "Task 1", status: "pending" });
    const task2 = makeTask({ id: "t2", subject: "Task 2", status: "pending" });
    useStore.getState().addTask("s1", task1);
    useStore.getState().addTask("s1", task2);

    useStore.getState().updateTask("s1", "t1", { status: "completed" });

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks[0].status).toBe("completed");
    expect(tasks[0].subject).toBe("Task 1"); // other fields preserved
    expect(tasks[1].status).toBe("pending"); // other task untouched
  });
});

// ─── Session names ──────────────────────────────────────────────────────────

describe("Session names", () => {
  it("setSessionName: persists to localStorage as JSON", () => {
    useStore.getState().setSessionName("s1", "My Session");

    expect(useStore.getState().sessionNames.get("s1")).toBe("My Session");

    const stored = JSON.parse(localStorage.getItem("test-server:cc-session-names") || "[]");
    expect(stored).toEqual([["s1", "My Session"]]);
  });

  it("setSessionName: updates existing name", () => {
    useStore.getState().setSessionName("s1", "First");
    useStore.getState().setSessionName("s1", "Second");

    expect(useStore.getState().sessionNames.get("s1")).toBe("Second");

    const stored = JSON.parse(localStorage.getItem("test-server:cc-session-names") || "[]");
    const map = new Map(stored);
    expect(map.get("s1")).toBe("Second");
  });
});

// ─── Recently renamed (animation tracking) ──────────────────────────────────

describe("recentlyRenamed", () => {
  it("markRecentlyRenamed: adds session to the set", () => {
    useStore.getState().markRecentlyRenamed("s1");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("clearRecentlyRenamed: removes session from the set", () => {
    useStore.getState().markRecentlyRenamed("s1");
    useStore.getState().clearRecentlyRenamed("s1");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });

  it("removeSession: also clears recentlyRenamed", () => {
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().markRecentlyRenamed("s1");
    useStore.getState().removeSession("s1");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });
});

// ─── UI state ───────────────────────────────────────────────────────────────

describe("UI state", () => {
  it("setColorTheme: updates colorTheme, darkMode, and persists to localStorage", () => {
    useStore.getState().setColorTheme("vscode-dark");

    expect(useStore.getState().colorTheme).toBe("vscode-dark");
    expect(useStore.getState().darkMode).toBe(true);
    expect(localStorage.getItem("cc-color-theme")).toBe("vscode-dark");
    expect(localStorage.getItem("cc-dark-mode")).toBe("true");

    useStore.getState().setColorTheme("light");

    expect(useStore.getState().colorTheme).toBe("light");
    expect(useStore.getState().darkMode).toBe(false);
    expect(localStorage.getItem("cc-color-theme")).toBe("light");
    expect(localStorage.getItem("cc-dark-mode")).toBe("false");
  });

  it("toggleDarkMode: flips between light and dark, persists to localStorage", () => {
    useStore.getState().setColorTheme("light");
    useStore.getState().toggleDarkMode();

    expect(useStore.getState().darkMode).toBe(true);
    expect(useStore.getState().colorTheme).toBe("dark");
    expect(localStorage.getItem("cc-dark-mode")).toBe("true");

    useStore.getState().toggleDarkMode();
    expect(useStore.getState().darkMode).toBe(false);
    expect(useStore.getState().colorTheme).toBe("light");
    expect(localStorage.getItem("cc-dark-mode")).toBe("false");
  });

  it("newSession: clears currentSessionId", () => {
    useStore.getState().setCurrentSession("s1");

    useStore.getState().newSession();

    expect(useStore.getState().currentSessionId).toBeNull();
    expect(localStorage.getItem("test-server:cc-current-session")).toBeNull();
  });
});

// ─── Turn activity overrides ───────────────────────────────────────────────

describe("Turn activity overrides", () => {
  it("toggleTurnActivity: expands a default-collapsed turn by setting override=true", () => {
    useStore.getState().toggleTurnActivity("s1", "turn-1", false);

    const overrides = useStore.getState().turnActivityOverrides.get("s1");
    expect(overrides?.get("turn-1")).toBe(true);
  });

  it("toggleTurnActivity: collapses a default-expanded turn by setting override=false", () => {
    useStore.getState().toggleTurnActivity("s1", "turn-last", true);

    const overrides = useStore.getState().turnActivityOverrides.get("s1");
    expect(overrides?.get("turn-last")).toBe(false);
  });

  it("toggleTurnActivity: removes existing override on second toggle", () => {
    useStore.getState().toggleTurnActivity("s1", "turn-2", false);
    useStore.getState().toggleTurnActivity("s1", "turn-2", false);

    const overrides = useStore.getState().turnActivityOverrides.get("s1");
    expect(overrides?.has("turn-2")).toBe(false);
  });

  it("keepTurnAutoExpanded + clearAutoExpandedTurns manage transient expansion state separately", () => {
    useStore.getState().keepTurnAutoExpanded("s1", "turn-1");
    useStore.getState().keepTurnAutoExpanded("s1", "turn-2");

    expect(useStore.getState().autoExpandedTurnIds.get("s1")).toEqual(new Set(["turn-1", "turn-2"]));

    useStore.getState().clearAutoExpandedTurns("s1");

    expect(useStore.getState().autoExpandedTurnIds.has("s1")).toBe(false);
  });
});

// ─── Reset ──────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("clears all maps and resets state", () => {
    // Populate many fields
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().setCurrentSession("s1");
    useStore.getState().appendMessage("s1", makeMessage());
    useStore.getState().setStreaming("s1", "text");
    useStore.getState().setStreamingStats("s1", { startedAt: 1, outputTokens: 2 });
    useStore.getState().addPermission("s1", makePermission());
    useStore.getState().addTask("s1", makeTask());
    useStore.getState().setSessionName("s1", "name");
    useStore.getState().markRecentlyRenamed("s1");
    useStore.getState().setConnectionStatus("s1", "connected");
    useStore.getState().setCliConnected("s1", true);
    useStore.getState().setSessionStatus("s1", "running");
    useStore.getState().setPreviousPermissionMode("s1", "default");
    useStore.getState().setSdkSessions([{ sessionId: "s1", state: "connected", cwd: "/", createdAt: 0 }]);

    useStore.getState().reset();
    const state = useStore.getState();

    expect(state.sessions.size).toBe(0);
    expect(state.sdkSessions).toEqual([]);
    expect(state.currentSessionId).toBeNull();
    expect(state.messages.size).toBe(0);
    expect(state.streaming.size).toBe(0);
    expect(state.streamingStartedAt.size).toBe(0);
    expect(state.streamingOutputTokens.size).toBe(0);
    expect(state.pendingPermissions.size).toBe(0);
    expect(state.connectionStatus.size).toBe(0);
    expect(state.cliConnected.size).toBe(0);
    expect(state.sessionStatus.size).toBe(0);
    expect(state.previousPermissionMode.size).toBe(0);
    expect(state.sessionTasks.size).toBe(0);
    expect(state.sessionNames.size).toBe(0);
    expect(state.recentlyRenamed.size).toBe(0);
    expect(state.mcpServers.size).toBe(0);
  });
});

// ─── MCP Servers ──────────────────────────────────────────────────────────────

describe("MCP Servers", () => {
  it("setMcpServers: stores servers for a session", () => {
    const servers = [
      { name: "test-server", status: "connected" as const, config: { type: "stdio" }, scope: "project" },
    ];
    useStore.getState().setMcpServers("s1", servers);
    expect(useStore.getState().mcpServers.get("s1")).toEqual(servers);
  });

  it("setMcpServers: replaces existing servers", () => {
    const first = [{ name: "old", status: "connected" as const, config: { type: "stdio" }, scope: "project" }];
    const second = [{ name: "new", status: "failed" as const, config: { type: "sse" }, scope: "user" }];
    useStore.getState().setMcpServers("s1", first);
    useStore.getState().setMcpServers("s1", second);
    expect(useStore.getState().mcpServers.get("s1")).toEqual(second);
  });

  it("removeSession: clears mcpServers", () => {
    const servers = [{ name: "test", status: "connected" as const, config: { type: "stdio" }, scope: "project" }];
    useStore.getState().addSession(makeSession("s1"));
    useStore.getState().setMcpServers("s1", servers);
    useStore.getState().removeSession("s1");
    expect(useStore.getState().mcpServers.has("s1")).toBe(false);
  });
});
