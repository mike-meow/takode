// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { useStore } from "../store.js";
import { MOCK_SESSION_ID, PLAYGROUND_SECTIONED_SESSION_ID } from "./playground/fixtures.js";
import { usePlaygroundSeed } from "./playground/usePlaygroundSeed.js";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Mock markdown renderer used by MessageBubble/PermissionBanner
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({
  default: {},
}));

vi.mock("./ChatView.js", () => ({
  ChatView: ({ sessionId }: { sessionId: string }) => <div data-testid={`mock-chat-view-${sessionId}`}>ChatView</div>,
}));

vi.mock("./MessageFeed.js", () => ({
  MessageFeed: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`mock-message-feed-${sessionId}`}>MessageFeed {sessionId}</div>
  ),
}));

import { Playground } from "./Playground.js";

function PlaygroundSeedHarness() {
  usePlaygroundSeed();
  return null;
}

describe("Playground", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  afterEach(() => {
    useStore.getState().reset();
  });

  it("renders the real chat stack section with integrated chat components", () => {
    render(<Playground />);

    expect(screen.getByText("Component Playground")).toBeTruthy();
    expect(screen.getByText("Real Chat Stack")).toBeTruthy();
    expect(screen.getByText("Notification Marker")).toBeTruthy();
    expect(screen.getByText("Timer Messages")).toBeTruthy();
    expect(screen.getByText("Pending local upload bubble")).toBeTruthy();

    const realChat = screen.getByTestId("playground-real-chat-stack");
    expect(realChat).toBeTruthy();
    expect(within(realChat).getAllByText(/ChatView|MessageFeed/).length).toBeGreaterThan(0);
  });

  it("seeds demo session state on mount and restores prior values on unmount", () => {
    const previousSession = { session_id: MOCK_SESSION_ID, cwd: "/tmp/original-session" } as any;
    const previousMessages = [{ id: "original-message", role: "user", content: "original", timestamp: 1 }] as any;
    const previousToolResults = new Map([
      [
        "preexisting-tool",
        {
          tool_use_id: "preexisting-tool",
          content: "original result",
          is_error: false,
          total_size: 15,
          is_truncated: false,
        },
      ],
    ]);
    const previousToolProgress = new Map([
      ["preexisting-tool", { toolName: "Bash", elapsedSeconds: 9, output: "original progress" }],
    ]);
    const previousToolStarts = new Map([["preexisting-tool", 321]]);
    const previousTimers = [
      {
        id: "existing-timer",
        sessionId: "leader-alpha",
        title: "Existing timer",
        description: "should be restored after cleanup",
        type: "delay" as const,
        originalSpec: "5m",
        nextFireAt: 5_000,
        createdAt: 1_000,
        fireCount: 0,
      },
    ];

    useStore.setState({
      sessions: new Map([[MOCK_SESSION_ID, previousSession]]),
      messages: new Map([[MOCK_SESSION_ID, previousMessages]]),
      toolResults: new Map([[MOCK_SESSION_ID, previousToolResults]]),
      toolProgress: new Map([[MOCK_SESSION_ID, previousToolProgress]]),
      toolStartTimestamps: new Map([[MOCK_SESSION_ID, previousToolStarts]]),
      sessionTimers: new Map([["leader-alpha", previousTimers]]),
      questNamedSessions: new Set(["quest-in-progress"]),
    });

    const { unmount } = render(<PlaygroundSeedHarness />);

    let state = useStore.getState();
    expect(state.sessions.get(MOCK_SESSION_ID)?.cwd).toBe("/Users/stan/Dev/project");
    expect(state.sessions.has(PLAYGROUND_SECTIONED_SESSION_ID)).toBe(true);
    expect(state.messages.get(MOCK_SESSION_ID)).toHaveLength(4);
    expect(state.toolResults.get(MOCK_SESSION_ID)?.has("tu-1")).toBe(true);
    expect(state.toolProgress.get(MOCK_SESSION_ID)?.has("tb-live")).toBe(true);
    expect(state.toolStartTimestamps.get(MOCK_SESSION_ID)?.has("tb-live")).toBe(true);
    expect(state.sessionTimers.get("leader-alpha")?.[0]?.title).toBe("Check worker queue");
    expect(state.questNamedSessions.has("quest-needs-verification")).toBe(true);

    unmount();

    state = useStore.getState();
    expect(state.sessions.get(MOCK_SESSION_ID)).toBe(previousSession);
    expect(state.sessions.has(PLAYGROUND_SECTIONED_SESSION_ID)).toBe(false);
    expect(state.messages.get(MOCK_SESSION_ID)).toBe(previousMessages);
    expect(state.toolResults.get(MOCK_SESSION_ID)).toBe(previousToolResults);
    expect(state.toolProgress.get(MOCK_SESSION_ID)).toBe(previousToolProgress);
    expect(state.toolStartTimestamps.get(MOCK_SESSION_ID)).toBe(previousToolStarts);
    expect(state.sessionTimers.get("leader-alpha")).toBe(previousTimers);
    expect(state.questNamedSessions.has("quest-in-progress")).toBe(true);
    expect(state.questNamedSessions.has("quest-needs-verification")).toBe(false);
  });
});
