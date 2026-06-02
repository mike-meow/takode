// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { ChatMessage } from "../types.js";

const revertToMessageMock = vi.hoisted(() => vi.fn(async () => ({})));
const markNotificationDoneMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../api.js", () => ({
  api: {
    revertToMessage: revertToMessageMock,
    markNotificationDone: markNotificationDoneMock,
    getFsImageUrl: (path: string, variant?: "thumbnail" | "full") => {
      const params = new URLSearchParams({ path });
      if (variant) params.set("variant", variant);
      return `/api/fs/image?${params.toString()}`;
    },
  },
}));

vi.mock("react-markdown", () => ({
  default: ({
    children,
    components,
  }: {
    children: string;
    components?: { p?: (props: { children: string }) => ReactNode };
  }) => {
    if (components?.p) {
      return <div data-testid="markdown">{components.p({ children })}</div>;
    }
    return <div data-testid="markdown">{children}</div>;
  },
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

import { HerdEventMessage } from "./MessageBubble.js";
import { useStore } from "../store.js";
import { parseHerdEvents } from "../utils/herd-event-parser.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("HerdEventMessage", () => {
  it("renders event headers collapsed by default", () => {
    // Herd event with activity lines should show header but NOT activity.
    const msg = makeMessage({
      role: "user",
      content: '1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s | tools: 1\n  [10] user: "Fix bug"\n  [11] ✓ "Done"',
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    render(<HerdEventMessage message={msg} showTimestamp={false} />);

    expect(screen.getByText(/turn_end.*5\.0s/)).toBeTruthy();
    expect(screen.queryByText(/Fix bug/)).toBeNull();
  });

  it("expands activity on click when activity lines are present", () => {
    const msg = makeMessage({
      role: "user",
      content: '1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s\n  [10] user: "Fix bug"\n  [11] ✓ "Done"',
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    render(<HerdEventMessage message={msg} showTimestamp={false} />);

    fireEvent.click(screen.getByText(/turn_end/));
    expect(screen.getByText(/Fix bug/)).toBeTruthy();
    expect(screen.getByText(/Done/)).toBeTruthy();
  });

  it("uses the session number as a navigation affordance when the session resolves", () => {
    // When the herd event session number maps to a live session, clicking that
    // token should navigate without expanding the chip content.
    const prevSdkSessions = useStore.getState().sdkSessions;
    const prevHash = window.location.hash;
    useStore.setState({
      sdkSessions: [
        {
          sessionId: "worker-8",
          sessionNum: 8,
          createdAt: 1,
          cwd: "/repo",
          state: "connected",
        },
      ],
    });

    try {
      const msg = makeMessage({
        role: "user",
        content: '1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s\n  [10] user: "Fix bug"\n  [11] ✓ "Done"',
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      });
      render(<HerdEventMessage message={msg} showTimestamp={false} />);

      fireEvent.click(screen.getByRole("button", { name: "Open session #8" }));

      expect(window.location.hash).toBe("#/session/worker-8");
      expect(screen.queryByText(/Fix bug/)).toBeNull();
    } finally {
      window.location.hash = prevHash;
      useStore.setState({ sdkSessions: prevSdkSessions });
    }
  });

  it("shows the standard session hover card when hovering the resolved session affordance", async () => {
    const prevSdkSessions = useStore.getState().sdkSessions;
    const prevSessionNames = useStore.getState().sessionNames;
    useStore.setState({
      sdkSessions: [
        {
          sessionId: "worker-8",
          sessionNum: 8,
          createdAt: 1,
          cwd: "/repo",
          state: "connected",
        },
      ],
      sessionNames: new Map([["worker-8", "Auth Worker"]]),
    });

    try {
      const msg = makeMessage({
        role: "user",
        content: "1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s",
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      });
      render(<HerdEventMessage message={msg} showTimestamp={false} />);

      fireEvent.mouseEnter(screen.getByRole("button", { name: "Open session #8" }));

      expect(await screen.findByText("Auth Worker")).toBeTruthy();
    } finally {
      useStore.setState({ sdkSessions: prevSdkSessions, sessionNames: prevSessionNames });
    }
  });

  it("activates the session-number affordance from the keyboard without expanding the chip", async () => {
    // Enter and Space on the #N button should route to the session and must not
    // bubble into the parent chip's expand/collapse keyboard handler.
    const prevSdkSessions = useStore.getState().sdkSessions;
    const prevHash = window.location.hash;
    const user = userEvent.setup();
    useStore.setState({
      sdkSessions: [
        {
          sessionId: "worker-8",
          sessionNum: 8,
          createdAt: 1,
          cwd: "/repo",
          state: "connected",
        },
      ],
    });

    try {
      const msg = makeMessage({
        role: "user",
        content: '1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s\n  [10] user: "Fix bug"\n  [11] ✓ "Done"',
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      });
      render(<HerdEventMessage message={msg} showTimestamp={false} />);

      const sessionLink = screen.getByRole("button", { name: "Open session #8" });

      sessionLink.focus();
      await user.keyboard("{Enter}");
      expect(window.location.hash).toBe("#/session/worker-8");
      expect(screen.queryByText(/Fix bug/)).toBeNull();

      window.location.hash = prevHash;
      sessionLink.focus();
      await user.keyboard(" ");
      expect(window.location.hash).toBe("#/session/worker-8");
      expect(screen.queryByText(/Fix bug/)).toBeNull();
    } finally {
      window.location.hash = prevHash;
      useStore.setState({ sdkSessions: prevSdkSessions });
    }
  });

  it("keeps an explicit focus-visible style on the session-number affordance", () => {
    // The #N button suppresses the browser default outline, so it must carry
    // its own replacement focus-visible treatment.
    const prevSdkSessions = useStore.getState().sdkSessions;
    useStore.setState({
      sdkSessions: [
        {
          sessionId: "worker-8",
          sessionNum: 8,
          createdAt: 1,
          cwd: "/repo",
          state: "connected",
        },
      ],
    });

    try {
      const msg = makeMessage({
        role: "user",
        content: "1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s",
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      });
      render(<HerdEventMessage message={msg} showTimestamp={false} />);

      const sessionLink = screen.getByRole("button", { name: "Open session #8" });
      expect(sessionLink.className).toContain("text-amber-400");
      expect(sessionLink.className).toContain("hover:text-amber-300");
      expect(sessionLink.className).toContain("focus-visible:text-amber-300");
      expect(sessionLink.className).toContain("focus-visible:ring-2");
      expect(sessionLink.className).toContain("focus-visible:ring-amber-400/70");
      expect(sessionLink.className).toContain("focus-visible:ring-offset-1");
      expect(sessionLink.className).toContain("focus-visible:ring-offset-cc-card");
    } finally {
      useStore.setState({ sdkSessions: prevSdkSessions });
    }
  });

  it("falls back safely when the session number cannot be resolved", () => {
    // Unresolved session numbers should stay visible but behave like the old
    // chip: clicking the token expands the activity instead of trying to route.
    const prevSdkSessions = useStore.getState().sdkSessions;
    useStore.setState({ sdkSessions: [] });

    try {
      const msg = makeMessage({
        role: "user",
        content: '1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s\n  [10] user: "Fix bug"\n  [11] ✓ "Done"',
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      });
      render(<HerdEventMessage message={msg} showTimestamp={false} />);

      expect(screen.queryByRole("button", { name: "Open session #8" })).toBeNull();

      fireEvent.click(screen.getByText("#8"));

      expect(screen.getByText(/Fix bug/)).toBeTruthy();
    } finally {
      useStore.setState({ sdkSessions: prevSdkSessions });
    }
  });

  it("renders events without activity as clickable", () => {
    // Event header with no activity lines is still clickable with a chevron,
    // but no activity pre block appears on expand.
    const msg = makeMessage({
      role: "user",
      content: "1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s",
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    render(<HerdEventMessage message={msg} showTimestamp={false} />);

    expect(screen.getByText(/turn_end/)).toBeTruthy();
    const chip = screen.getByText(/turn_end/).closest('[role="button"]') as HTMLElement;
    expect(chip.querySelector("svg")).not.toBeNull();

    fireEvent.click(chip);
    expect(chip.closest("div")!.querySelector("pre")).toBeNull();
  });

  it("renders multiple events with independent collapse state", () => {
    const msg = makeMessage({
      role: "user",
      content:
        '2 events from 1 session\n\n#8 | turn_end | ✓ 5.0s\n  [10] user: "First"\n#9 | turn_end | ✓ 3.0s\n  [15] user: "Second"',
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    render(<HerdEventMessage message={msg} showTimestamp={false} />);

    expect(screen.getByText(/5\.0s/)).toBeTruthy();
    expect(screen.getByText(/3\.0s/)).toBeTruthy();
    expect(screen.queryByText(/First/)).toBeNull();
    expect(screen.queryByText(/Second/)).toBeNull();

    fireEvent.click(screen.getByText(/5\.0s/));
    expect(screen.getByText(/First/)).toBeTruthy();
    expect(screen.queryByText(/Second/)).toBeNull();
  });

  it("falls back to raw content when no # lines are found", () => {
    const msg = makeMessage({
      role: "user",
      content: "unexpected format with no event lines",
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    render(<HerdEventMessage message={msg} showTimestamp={false} />);

    expect(screen.getByText("unexpected format with no event lines")).toBeTruthy();
  });

  it("treats markdown headings in key message content as activity, not event headers", () => {
    // Only "#N | type | ..." lines should be treated as event headers.
    const msg = makeMessage({
      role: "user",
      content: [
        "1 event from 1 session",
        "",
        "#287 | turn_end | ✓ 53.6s | tools: 12 | [1]-[22] | 1s ago",
        "  [1] asst: I'll load skills first.",
        "  [22] asst: I now have all the evidence.",
        "## Skeptic Review: Session #286",
        "### Task",
        "Fix the autonamer regex.",
        "### Assessment",
        "**ACCEPT**: The work is thorough.",
      ].join("\n"),
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    render(<HerdEventMessage message={msg} showTimestamp={false} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(screen.getByText(/turn_end.*53\.6s/)).toBeTruthy();
    expect(screen.queryByText("## Skeptic Review: Session #286")).toBeNull();
    expect(screen.queryByText("### Task")).toBeNull();

    fireEvent.click(buttons[0]);
    expect(screen.getByText(/Skeptic Review/)).toBeTruthy();
    expect(screen.getByText(/ACCEPT/)).toBeTruthy();
  });
});

describe("parseHerdEvents", () => {
  it("parses standard event headers with activity lines", () => {
    const content = [
      "1 event from 1 session",
      "",
      "#8 | turn_end | ✓ 5.0s | tools: 1",
      '  [10] user: "Fix bug"',
      '  [11] ✓ "Done"',
    ].join("\n");

    const events = parseHerdEvents(content);
    expect(events).toHaveLength(1);
    expect(events[0].header).toBe("#8 | turn_end | ✓ 5.0s | tools: 1");
    expect(events[0].activity).toHaveLength(2);
  });

  it("does NOT treat markdown headings as event headers", () => {
    // ## and ### headings in key message content are activity lines, not event
    // headers, even though they start with #.
    const content = [
      "1 event from 1 session",
      "",
      "#287 | turn_end | ✓ 53.6s",
      "  [22] asst: Evidence gathered.",
      "## Skeptic Review",
      "### Task",
      "Fix the regex.",
      "### Assessment",
      "ACCEPT",
    ].join("\n");

    const events = parseHerdEvents(content);
    expect(events).toHaveLength(1);
    expect(events[0].header).toBe("#287 | turn_end | ✓ 53.6s");
    expect(events[0].activity).toContain("## Skeptic Review");
    expect(events[0].activity).toContain("### Task");
    expect(events[0].activity).toContain("### Assessment");
    expect(events[0].activity).toContain("Fix the regex.");
    expect(events[0].activity).toContain("ACCEPT");
  });

  it("handles multiple real events in the same batch", () => {
    const content = [
      "2 events from 2 sessions",
      "",
      "#8 | turn_end | ✓ 5.0s",
      "  [10] asst: Done.",
      "#9 | permission_request | Bash",
    ].join("\n");

    const events = parseHerdEvents(content);
    expect(events).toHaveLength(2);
    expect(events[0].header).toMatch(/turn_end/);
    expect(events[1].header).toMatch(/permission_request/);
    expect(events[0].activity).toHaveLength(1);
    expect(events[1].activity).toHaveLength(0);
  });

  it("returns empty array for empty content", () => {
    expect(parseHerdEvents("")).toHaveLength(0);
  });

  it("returns empty array when content has only a batch header", () => {
    expect(parseHerdEvents("3 events from 2 sessions\n\n")).toHaveLength(0);
  });

  it("parses event header at very first line", () => {
    const events = parseHerdEvents("#1 | turn_end | ✓ 1.0s\n  [5] asst: Done.");
    expect(events).toHaveLength(1);
    expect(events[0].activity.some((l) => l.includes("Done"))).toBe(true);
  });

  it("preserves blank lines in activity for 1:1 fidelity with injected content", () => {
    // Key message content often has paragraph breaks. These must be preserved
    // so the expanded view matches what was injected.
    const content = [
      "1 event from 1 session",
      "",
      "#287 | turn_end | ✓ 53.6s",
      "  [22] asst: Review complete.",
      "## Summary",
      "",
      "The fix is correct.",
      "",
      "## Details",
      "No issues found.",
    ].join("\n");

    const events = parseHerdEvents(content);
    expect(events).toHaveLength(1);
    expect(events[0].activity.join("\n")).toContain("## Summary\n\nThe fix is correct.\n\n## Details");
  });
});
