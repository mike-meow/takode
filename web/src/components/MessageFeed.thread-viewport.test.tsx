// @vitest-environment jsdom

const mockScrollTo = vi.fn();

beforeAll(() => {
  Element.prototype.scrollTo = mockScrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)" ? false : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage, ThreadWindowState } from "../types.js";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

vi.mock("../ws.js", () => ({
  sendToSession: vi.fn(() => true),
}));

const mockStoreValues: Record<string, unknown> = {};
const mockSetCollapsibleTurnIds = vi.fn();
const mockSetActiveTaskTurnId = vi.fn();

vi.mock("../store.js", () => {
  const useStore: any = (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      messages: mockStoreValues.messages ?? new Map(),
      messageFrozenCounts: new Map(),
      messageFrozenRevisions: new Map(),
      historyLoading: new Map(),
      historyWindows: new Map(),
      streaming: new Map(),
      streamingByParentToolUseId: new Map(),
      streamingThinking: new Map(),
      streamingThinkingByParentToolUseId: new Map(),
      streamingStartedAt: new Map(),
      streamingOutputTokens: new Map(),
      streamingPausedDuration: new Map(),
      streamingPauseStartedAt: new Map(),
      sessionStatus: new Map(),
      sessionStuck: new Map(),
      sessions: mockStoreValues.sessions ?? new Map(),
      toolProgress: new Map(),
      toolResults: new Map(),
      toolStartTimestamps: new Map(),
      sdkSessions: mockStoreValues.sdkSessions ?? [],
      feedScrollPosition: mockStoreValues.feedScrollPosition ?? new Map(),
      turnActivityOverrides: new Map(),
      autoExpandedTurnIds: new Map(),
      toggleTurnActivity: vi.fn(),
      scrollToTurnId: new Map(),
      clearScrollToTurn: vi.fn(),
      scrollToMessageId: new Map(),
      clearScrollToMessage: vi.fn(),
      expandAllInTurn: new Map(),
      clearExpandAllInTurn: vi.fn(),
      bottomAlignNextUserMessage: new Set(),
      sessionTaskHistory: new Map(),
      pendingUserUploads: new Map(),
      pendingCodexInputs: new Map(),
      activeTaskTurnId: new Map(),
      setActiveTaskTurnId: mockSetActiveTaskTurnId,
      backgroundAgentNotifs: new Map(),
      sessionNotifications: new Map(),
      sessionSearch: new Map(),
      threadWindows: mockStoreValues.threadWindows ?? new Map(),
      threadWindowMessages: mockStoreValues.threadWindowMessages ?? new Map(),
    };
    return selector(state);
  };
  useStore.getState = () => ({
    feedScrollPosition: mockStoreValues.feedScrollPosition ?? new Map(),
    setFeedScrollPosition: vi.fn(),
    collapseAllTurnActivity: vi.fn(),
    setCollapsibleTurnIds: mockSetCollapsibleTurnIds,
    turnActivityOverrides: new Map(),
    autoExpandedTurnIds: new Map(),
    toggleTurnActivity: vi.fn(),
    focusTurn: vi.fn(),
    keepTurnExpanded: vi.fn(),
    clearBottomAlignOnNextUserMessage: vi.fn(),
    setComposerDraft: vi.fn(),
    removePendingUserUpload: vi.fn(),
    updatePendingUserUpload: vi.fn(),
    focusComposer: vi.fn(),
  });
  return {
    useStore,
    getSessionSearchState: () => ({
      query: "",
      isOpen: false,
      mode: "strict",
      category: "all",
      matches: [],
      currentMatchIndex: -1,
    }),
  };
});

import { getFeedViewportKey, persistLeaderViewportPosition } from "../utils/thread-viewport.js";
import { MessageFeed } from "./MessageFeed.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function setStoreMessages(sessionId: string, messages: ChatMessage[]) {
  mockStoreValues.messages = new Map([[sessionId, messages]]);
}

function makeThreadWindow(overrides: Partial<ThreadWindowState> = {}): ThreadWindowState {
  return {
    thread_key: "q-941",
    from_item: 0,
    item_count: 12,
    total_items: 12,
    has_older_items: false,
    has_newer_items: false,
    source_history_length: 12,
    section_item_count: 6,
    visible_item_count: 3,
    ...overrides,
  };
}

beforeEach(() => {
  mockScrollTo.mockClear();
  mockSetActiveTaskTurnId.mockClear();
  mockSetCollapsibleTurnIds.mockClear();
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
  mockStoreValues.messages = new Map();
  mockStoreValues.feedScrollPosition = new Map();
  mockStoreValues.sessions = new Map();
  mockStoreValues.sdkSessions = [];
  mockStoreValues.threadWindows = new Map();
  mockStoreValues.threadWindowMessages = new Map();
});

describe("MessageFeed thread viewport restoration", () => {
  it("restores a browser-local persisted leader viewport when memory state is missing", async () => {
    const sid = "test-persisted-leader-viewport";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main-1", role: "user", content: "Main setup" }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "Quest update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    persistLeaderViewportPosition(sid, "q-941", {
      scrollTop: 420,
      scrollHeight: 1600,
      isAtBottom: false,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1600 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    try {
      render(<MessageFeed sessionId={sid} threadKey="q-941" />);

      await waitFor(() => expect(scrollTopValue).toBe(420));
      expect(screen.queryByText("Main setup")).toBeNull();
      expect(screen.getByText("Quest update")).toBeTruthy();
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
    }
  });

  it("defaults missing leader viewport state to the latest bottom", () => {
    const sid = "test-missing-leader-viewport-bottom";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main-1", role: "user", content: "Main setup" }),
      makeMessage({ id: "a-main-1", role: "assistant", content: "Main answer" }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1200 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 400 : 0;
      },
    });

    try {
      render(<MessageFeed sessionId={sid} threadKey="main" />);

      expect(mockScrollTo).toHaveBeenCalledWith({ top: 788, behavior: "auto" });
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("waits for the selected thread window before restoring a persisted anchor", async () => {
    // The selected tab can restore before its server-backed thread window has
    // hydrated. Anchored viewport restore must wait so a pre-window render does
    // not consume the saved state and leave the user at scrollTop=0.
    const sid = "test-persisted-anchor-after-window";
    const liveThreadMessage = makeMessage({
      id: "live-q941",
      role: "assistant",
      content: "Live quest shell",
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
    });
    const windowMessages = [
      makeMessage({ id: "u-before", role: "user", content: "Earlier request", historyIndex: 1 }),
      makeMessage({ id: "a-before", role: "assistant", content: "Earlier answer", historyIndex: 2 }),
      makeMessage({ id: "u-anchor", role: "user", content: "Saved anchor request", historyIndex: 3 }),
      makeMessage({ id: "a-anchor", role: "assistant", content: "Saved anchor answer", historyIndex: 4 }),
    ];
    setStoreMessages(sid, [liveThreadMessage]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    persistLeaderViewportPosition(sid, "q-941", {
      scrollTop: 1600,
      scrollHeight: 5226,
      isAtBottom: false,
      anchorTurnId: "u-anchor",
      anchorOffsetTop: -120,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 5226 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 846 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.turnId === "u-anchor") {
        return DOMRect.fromRect({ x: 0, y: 1450, width: 600, height: 100 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 846 });
      }
      return originalRect.call(this);
    };

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="q-941" />);
      expect(scrollTopValue).toBe(0);
      expect(mockScrollTo).not.toHaveBeenCalled();

      mockStoreValues.threadWindows = new Map([[sid, new Map([["q-941", makeThreadWindow()]])]]);
      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-941", windowMessages]])]]);
      rerender(<MessageFeed sessionId={sid} threadKey="q-941" />);

      await waitFor(() => expect(scrollTopValue).toBe(1570));
      expect(screen.getByText("Saved anchor request")).toBeTruthy();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("restores Main independently after visiting a short quest thread", () => {
    // Regression for q-976: a short quest projection must not leave Main at
    // the oldest messages when returning to the Main projection.
    const sid = "test-thread-aware-main-restore";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main-1", role: "user", content: "Main setup" }),
      makeMessage({ id: "a-main-1", role: "assistant", content: "Main answer" }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "Short quest update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);
    mockStoreValues.feedScrollPosition = new Map([
      [getFeedViewportKey(sid, "main"), { scrollTop: 300, scrollHeight: 1200, isAtBottom: false }],
      [getFeedViewportKey(sid, "q-941"), { scrollTop: 0, scrollHeight: 300, isAtBottom: true }],
    ]);

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1800 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="q-941" />);
      scrollTopValue = 0;

      rerender(<MessageFeed sessionId={sid} threadKey="main" />);

      expect(scrollTopValue).toBe(450);
      expect(screen.getByText("Main setup")).toBeTruthy();
      expect(screen.queryByText("Short quest update")).toBeNull();
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
    }
  });

  it("keeps All Threads scroll independent from Main", () => {
    // All Threads is a global projection, so it needs its own viewport state
    // instead of borrowing Main's reading position.
    const sid = "test-thread-aware-all-independent";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main-1", role: "user", content: "Main setup" }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "Quest update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);
    mockStoreValues.feedScrollPosition = new Map([
      [getFeedViewportKey(sid, "main"), { scrollTop: 300, scrollHeight: 1600, isAtBottom: false }],
      [getFeedViewportKey(sid, "all"), { scrollTop: 700, scrollHeight: 1600, isAtBottom: false }],
    ]);

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1600 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="all" />);
      expect(scrollTopValue).toBe(700);

      rerender(<MessageFeed sessionId={sid} threadKey="main" />);

      expect(scrollTopValue).toBe(300);
      expect(screen.getByText("Main setup")).toBeTruthy();
      expect(screen.queryByText("Quest update")).toBeNull();
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
    }
  });
});
