// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage, ContentBlock } from "../types.js";

const revertToMessageMock = vi.hoisted(() => vi.fn(async () => ({})));
const markNotificationDoneMock = vi.hoisted(() => vi.fn(async () => ({})));
const writeClipboardTextMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../api.js", () => ({
  api: {
    revertToMessage: revertToMessageMock,
    markNotificationDone: markNotificationDoneMock,
  },
}));

// Mock react-markdown to avoid ESM/parsing issues in tests
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

import { MessageBubble, NotificationMarker, HerdEventMessage } from "./MessageBubble.js";
import { parseHerdEvents } from "../utils/herd-event-parser.js";
import { useStore } from "../store.js";

beforeEach(() => {
  writeClipboardTextMock.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: writeClipboardTextMock,
      write: vi.fn(),
    },
  });
});

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── System messages ─────────────────────────────────────────────────────────

describe("MessageBubble - system messages", () => {
  it("renders system message with italic text", () => {
    const msg = makeMessage({ role: "system", content: "Session started" });
    const { container } = render(<MessageBubble message={msg} />);

    const italicSpan = container.querySelector(".italic");
    expect(italicSpan).toBeTruthy();
    expect(italicSpan?.textContent).toBe("Session started");
  });

  it("renders system message with divider lines", () => {
    const msg = makeMessage({ role: "system", content: "Divider test" });
    const { container } = render(<MessageBubble message={msg} />);

    // There should be 2 divider elements (h-px)
    const dividers = container.querySelectorAll(".h-px");
    expect(dividers.length).toBe(2);
  });
});

describe("MessageBubble - error system messages", () => {
  it("renders error variant with prominent styling and warning icon", () => {
    const msg = makeMessage({ role: "system", content: "Error: something failed", variant: "error" });
    const { container } = render(<MessageBubble message={msg} />);

    // Should have error styling (red border/background)
    const errorDiv = container.querySelector(".border-cc-error\\/20");
    expect(errorDiv).toBeTruthy();

    // Should show the error text
    expect(screen.getByText("Error: something failed")).toBeTruthy();

    // Should NOT have divider lines (those are for info system messages)
    const dividers = container.querySelectorAll(".h-px");
    expect(dividers.length).toBe(0);
  });

  it("renders 'prompt is too long' error with actionable guidance", () => {
    const msg = makeMessage({ role: "system", content: "Error: Prompt is too long", variant: "error" });
    render(<MessageBubble message={msg} />);

    // Should show the error
    expect(screen.getByText("Error: Prompt is too long")).toBeTruthy();
    // Should show compact guidance
    expect(screen.getByText(/\/compact/)).toBeTruthy();
    expect(screen.getByText(/start a new session/)).toBeTruthy();
  });

  it("renders Codex payload-too-large errors with compact guidance", () => {
    const msg = makeMessage({
      role: "system",
      content: '413 Payload Too Large: APIError: Github_copilotException - {"message":"failed to parse request"}',
      variant: "error",
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText(/413 Payload Too Large/)).toBeTruthy();
    expect(screen.getByText(/\/compact/)).toBeTruthy();
    expect(screen.getByText(/shrink retained context before retrying/i)).toBeTruthy();
  });

  it("renders generic error without compact guidance", () => {
    const msg = makeMessage({ role: "system", content: "Error: API rate limit exceeded", variant: "error" });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Error: API rate limit exceeded")).toBeTruthy();
    // Should NOT show compact guidance for non-context-limit errors
    expect(screen.queryByText(/\/compact/)).toBeNull();
  });

  it("renders info/default system messages with divider style (no variant)", () => {
    const msg = makeMessage({ role: "system", content: "Session started" });
    const { container } = render(<MessageBubble message={msg} />);

    // Should have divider lines
    const dividers = container.querySelectorAll(".h-px");
    expect(dividers.length).toBe(2);

    // Should have italic text
    const italicSpan = container.querySelector(".italic");
    expect(italicSpan).toBeTruthy();
  });
});

// ─── User messages ───────────────────────────────────────────────────────────

describe("MessageBubble - user messages", () => {
  beforeEach(() => {
    revertToMessageMock.mockClear();
  });

  it("renders user message right-aligned with content", () => {
    const msg = makeMessage({ role: "user", content: "Hello Claude" });
    const { container } = render(<MessageBubble message={msg} />);

    // Check for right-alignment (justify-end)
    const wrapper = container.querySelector(".justify-end");
    expect(wrapper).toBeTruthy();

    // Check content
    expect(screen.getByText("Hello Claude")).toBeTruthy();
  });

  it("renders a timestamp for user messages", () => {
    const ts = 1700000000000;
    const msg = makeMessage({ role: "user", content: "With timestamp", timestamp: ts });
    render(<MessageBubble message={msg} />);

    const time = screen.getByTestId("message-timestamp");
    expect(time.getAttribute("dateTime")).toBe(new Date(ts).toISOString());
    expect((time.textContent || "").length).toBeGreaterThan(0);
  });

  it("renders a VS Code selection attachment above the user message content", () => {
    const msg = makeMessage({
      role: "user",
      content: "Please review this",
      metadata: {
        vscodeSelection: {
          absolutePath: "/test/web/src/components/Composer.tsx",
          relativePath: "web/src/components/Composer.tsx",
          displayPath: "Composer.tsx",
          startLine: 35,
          endLine: 38,
          lineCount: 4,
        },
      },
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Composer.tsx:35-38")).toBeTruthy();
    expect(screen.getByText("Please review this")).toBeTruthy();
  });

  it("renders user messages with image thumbnails from REST URLs", () => {
    const msg = makeMessage({
      role: "user",
      content: "See this image",
      images: [
        { imageId: "img-1", media_type: "image/png" },
        { imageId: "img-2", media_type: "image/jpeg" },
      ],
    });
    const { container } = render(<MessageBubble message={msg} sessionId="test-session" />);

    const images = container.querySelectorAll("img");
    expect(images.length).toBe(2);
    expect(images[0].getAttribute("src")).toBe("/api/images/test-session/img-1/thumb");
    expect(images[1].getAttribute("src")).toBe("/api/images/test-session/img-2/thumb");
    expect(images[0].getAttribute("alt")).toBe("attachment");
  });

  it("does not render images section when images array is empty", () => {
    const msg = makeMessage({ role: "user", content: "No images", images: [] });
    const { container } = render(<MessageBubble message={msg} />);

    const images = container.querySelectorAll("img");
    expect(images.length).toBe(0);
  });

  it("opens lightbox when clicking an image thumbnail", () => {
    const msg = makeMessage({
      role: "user",
      content: "Check this",
      images: [{ imageId: "img-1", media_type: "image/png" }],
    });
    render(<MessageBubble message={msg} sessionId="test-session" />);

    // Click the thumbnail image
    const thumbnail = screen.getByTestId("image-thumbnail");
    fireEvent.click(thumbnail);

    // The lightbox should now be open with the full-size image
    const lightboxImage = screen.getByTestId("lightbox-image");
    expect(lightboxImage).toBeTruthy();
    expect(lightboxImage.getAttribute("src")).toBe("/api/images/test-session/img-1/full");
  });

  it("closes lightbox when clicking the backdrop", () => {
    const msg = makeMessage({
      role: "user",
      content: "Check this",
      images: [{ imageId: "img-1", media_type: "image/png" }],
    });
    render(<MessageBubble message={msg} sessionId="test-session" />);

    // Open the lightbox
    const thumbnail = screen.getByTestId("image-thumbnail");
    fireEvent.click(thumbnail);
    expect(screen.getByTestId("lightbox-backdrop")).toBeTruthy();

    // Close by clicking backdrop
    fireEvent.click(screen.getByTestId("lightbox-backdrop"));
    expect(screen.queryByTestId("lightbox-backdrop")).toBeNull();
  });

  it("closes lightbox when pressing Escape", () => {
    const msg = makeMessage({
      role: "user",
      content: "Check this",
      images: [{ imageId: "img-1", media_type: "image/png" }],
    });
    render(<MessageBubble message={msg} sessionId="test-session" />);

    // Open the lightbox
    fireEvent.click(screen.getByTestId("image-thumbnail"));
    expect(screen.getByTestId("lightbox-backdrop")).toBeTruthy();

    // Close with Escape
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("lightbox-backdrop")).toBeNull();
  });

  it("shows 'Revert to here' in the user message menu for Codex sessions", () => {
    // q-289 follow-up: Codex sessions should now expose the same user-message
    // revert affordance as Claude sessions when backend support exists.
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });

    try {
      const msg = makeMessage({ role: "user", content: "Can I revert this?" });
      render(<MessageBubble message={msg} sessionId="codex-session" />);

      fireEvent.click(screen.getByTitle("Message options"));
      expect(screen.getByText("Copy message")).toBeTruthy();
      expect(screen.getByText("Revert to here")).toBeTruthy();
    } finally {
      useStore.setState({ sessions: prevSessions });
    }
  });

  it("does not show 'Revert to here' for later Codex user messages in the same turn", () => {
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });

    try {
      const first = makeMessage({ id: "u1", role: "user", content: "First user input" });
      const second = makeMessage({ id: "u2", role: "user", content: "Second user input" });
      useStore.getState().setMessages("codex-session", [first, second]);
      render(<MessageBubble message={second} sessionId="codex-session" />);

      fireEvent.click(screen.getByTitle("Message options"));
      expect(screen.getByText("Copy message")).toBeTruthy();
      expect(screen.queryByText("Revert to here")).toBeNull();
    } finally {
      useStore.setState({ sessions: prevSessions });
      useStore.getState().setMessages("codex-session", []);
    }
  });

  it("does not show 'Revert to here' when no sessionId is available", () => {
    // Revert remains unavailable without a session anchor because the client
    // has no target session/message route to send to the server.
    const msg = makeMessage({ role: "user", content: "No session to revert" });
    render(<MessageBubble message={msg} />);

    fireEvent.click(screen.getByTitle("Message options"));
    expect(screen.getByText("Copy message")).toBeTruthy();
    expect(screen.queryByText("Revert to here")).toBeNull();
  });

  it("copies a stable message link for user messages", async () => {
    const prevSdkSessions = useStore.getState().sdkSessions;
    useStore.setState({
      sdkSessions: [
        { sessionId: "session-abc", state: "connected", cwd: "/repo", createdAt: 1, sessionNum: 123 } as any,
      ],
    });

    try {
      const msg = makeMessage({ id: "user-msg-42", role: "user", content: "Link me" });
      render(<MessageBubble message={msg} sessionId="session-abc" />);

      fireEvent.click(screen.getByTitle("Message options"));
      fireEvent.click(screen.getByText("Copy message link"));

      await waitFor(() => {
        expect(writeClipboardTextMock).toHaveBeenCalledWith("http://localhost:3000/#/session/123/msg/user-msg-42");
      });
    } finally {
      useStore.setState({ sdkSessions: prevSdkSessions });
    }
  });

  it("restores image attachments into the composer draft after revert", async () => {
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });
    useStore.getState().setComposerDraft("codex-session", {
      text: "stale draft text",
      images: [{ name: "stale.png", base64: "stale-data", mediaType: "image/png" }],
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      statusText: "OK",
      blob: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: "image/png" }),
    }));
    const prevFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchMock as any);

    try {
      const msg = makeMessage({
        role: "user",
        content: "Revert this with image",
        images: [{ imageId: "img-1", media_type: "image/png" }],
      });
      render(<MessageBubble message={msg} sessionId="codex-session" />);

      fireEvent.click(screen.getByTitle("Message options"));
      fireEvent.click(screen.getByText("Revert to here"));
      fireEvent.click(screen.getByText("Revert"));

      await waitFor(() => {
        expect(revertToMessageMock).toHaveBeenCalledWith("codex-session", msg.id);
      });
      await waitFor(() => {
        const draft = useStore.getState().composerDrafts.get("codex-session");
        expect(draft?.text).toBe("Revert this with image");
        expect(draft?.images).toHaveLength(1);
        expect(draft?.images[0]?.name).toBe("attachment-1.png");
        expect(draft?.images[0]?.mediaType).toBe("image/png");
        expect(draft?.images[0]?.base64).toBeTruthy();
      });
      const finalDraft = useStore.getState().composerDrafts.get("codex-session");
      expect(finalDraft?.images?.[0]?.name).not.toBe("stale.png");
      expect(fetchMock).toHaveBeenCalledWith("/api/images/codex-session/img-1/full");
    } finally {
      useStore.setState({ sessions: prevSessions });
      vi.stubGlobal("fetch", prevFetch as any);
    }
  });

  it("keeps the reverted text draft even if image restoration fails", async () => {
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });
    useStore.getState().setComposerDraft("codex-session", {
      text: "stale draft text",
      images: [{ name: "stale.png", base64: "stale-data", mediaType: "image/png" }],
    });

    const fetchMock = vi.fn(async () => ({
      ok: false,
      statusText: "boom",
    }));
    const prevFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchMock as any);

    try {
      const msg = makeMessage({
        role: "user",
        content: "Keep my text",
        images: [{ imageId: "img-1", media_type: "image/png" }],
      });
      render(<MessageBubble message={msg} sessionId="codex-session" />);

      fireEvent.click(screen.getByTitle("Message options"));
      fireEvent.click(screen.getByText("Revert to here"));
      fireEvent.click(screen.getByText("Revert"));

      await waitFor(() => {
        expect(revertToMessageMock).toHaveBeenCalledWith("codex-session", msg.id);
      });
      await waitFor(() => {
        const draft = useStore.getState().composerDrafts.get("codex-session");
        expect(draft?.text).toBe("Keep my text");
      });
      const draft = useStore.getState().composerDrafts.get("codex-session");
      expect(draft?.images ?? []).toEqual([]);
    } finally {
      useStore.setState({ sessions: prevSessions });
      vi.stubGlobal("fetch", prevFetch as any);
    }
  });

  it("clears stale draft images for plain-text Codex reverts", async () => {
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });
    useStore.getState().setComposerDraft("codex-session", {
      text: "stale draft text",
      images: [{ name: "stale.png", base64: "stale-data", mediaType: "image/png" }],
    });

    try {
      const msg = makeMessage({
        role: "user",
        content: "Plain text revert",
      });
      render(<MessageBubble message={msg} sessionId="codex-session" />);

      fireEvent.click(screen.getByTitle("Message options"));
      fireEvent.click(screen.getByText("Revert to here"));
      fireEvent.click(screen.getByText("Revert"));

      await waitFor(() => {
        expect(revertToMessageMock).toHaveBeenCalledWith("codex-session", msg.id);
      });
      const draft = useStore.getState().composerDrafts.get("codex-session");
      expect(draft).toEqual({ text: "Plain text revert", images: [] });
    } finally {
      useStore.setState({ sessions: prevSessions });
    }
  });
});

// ─── Agent source badge ─────────────────────────────────────────────────────

describe("MessageBubble - agent source badge", () => {
  it("does not render badge when agentSource is absent", () => {
    const msg = makeMessage({ role: "user", content: "Normal message" });
    render(<MessageBubble message={msg} />);

    expect(screen.queryByTestId("agent-source-badge")).toBeNull();
  });

  it("renders badge with session label when agentSource is present", () => {
    const msg = makeMessage({
      role: "user",
      content: "Run tests",
      agentSource: { sessionId: "abc123def456", sessionLabel: "#3 orchestrator" },
    });
    render(<MessageBubble message={msg} />);

    const badge = screen.getByTestId("agent-source-badge");
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain("via #3 orchestrator");
  });

  it("renders truncated session ID when no label is provided", () => {
    const msg = makeMessage({
      role: "user",
      content: "Run tests",
      agentSource: { sessionId: "abc123def456" },
    });
    render(<MessageBubble message={msg} />);

    const badge = screen.getByTestId("agent-source-badge");
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain("via abc123de");
  });

  it("renders cron label for cron-originated messages", () => {
    const msg = makeMessage({
      role: "user",
      content: "Check emails",
      agentSource: { sessionId: "cron:email-digest", sessionLabel: "cron: Email Digest" },
    });
    render(<MessageBubble message={msg} />);

    const badge = screen.getByTestId("agent-source-badge");
    expect(badge.textContent).toContain("via cron: Email Digest");
  });

  it("opens context menu when badge is clicked", () => {
    const msg = makeMessage({
      role: "user",
      content: "Run tests",
      agentSource: { sessionId: "abc123def456", sessionLabel: "#3 orchestrator" },
    });
    render(<MessageBubble message={msg} />);

    const badge = screen.getByTestId("agent-source-badge");
    fireEvent.click(badge);

    // Context menu should show "Open session" for non-cron sources
    expect(screen.getByText("Open session")).toBeTruthy();
  });

  it("does not show 'Open session' for cron sources", () => {
    const msg = makeMessage({
      role: "user",
      content: "Check emails",
      agentSource: { sessionId: "cron:email-digest", sessionLabel: "cron: Email Digest" },
    });
    render(<MessageBubble message={msg} />);

    const badge = screen.getByTestId("agent-source-badge");
    fireEvent.click(badge);

    // Cron sources should not have "Open session" option
    expect(screen.queryByText("Open session")).toBeNull();
  });

  it("does not show 'Open session' for system sources", () => {
    const msg = makeMessage({
      role: "user",
      content: "System nudge",
      agentSource: { sessionId: "system:leader-tag-enforcer", sessionLabel: "System" },
    });
    render(<MessageBubble message={msg} />);

    const badge = screen.getByTestId("agent-source-badge");
    fireEvent.click(badge);

    expect(screen.queryByText("Open session")).toBeNull();
  });

  it("does not render the generic interactive badge for timer sources", () => {
    const msg = makeMessage({
      role: "user",
      content: "[⏰ Timer t2] Timer ping",
      agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
    });
    render(<MessageBubble message={msg} />);

    expect(screen.queryByTestId("agent-source-badge")).toBeNull();
    expect(screen.getByText("t2")).toBeTruthy();
  });
});

describe("MessageBubble - timer messages", () => {
  it("renders fired timers as a single inline row and keeps the description collapsed by default", () => {
    const msg = makeMessage({
      role: "user",
      content: "[⏰ Timer t2] Monitor RTG datagen\n\nCheck squeue for RTG jobs and report shard status.",
      agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
    });
    render(<MessageBubble message={msg} showTimestamp={false} />);

    expect(screen.queryByText("via Timer t2")).toBeNull();
    expect(screen.getByText("t2")).toBeTruthy();
    expect(screen.getByText("Monitor RTG datagen")).toBeTruthy();
    expect(screen.queryByText(/Check squeue for RTG jobs/)).toBeNull();
    expect(screen.getByRole("button", { name: "Expand timer description" })).toBeTruthy();
  });

  it("expands and collapses timer descriptions on click", () => {
    const msg = makeMessage({
      role: "user",
      content: "[⏰ Timer t2] Monitor RTG datagen\n\nCheck squeue for RTG jobs and report shard status.",
      agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
    });
    render(<MessageBubble message={msg} showTimestamp={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand timer description" }));
    expect(screen.getByText(/Check squeue for RTG jobs/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse timer description" }));
    expect(screen.queryByText(/Check squeue for RTG jobs/)).toBeNull();
  });

  it("preserves search highlighting for timer title and description content", () => {
    const prevSessionSearch = useStore.getState().sessionSearch;
    const msg = makeMessage({
      id: "timer-search-msg",
      role: "user",
      content: "[⏰ Timer t2] Monitor RTG datagen\n\nCheck squeue for RTG jobs and report shard status.",
      agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
    });

    useStore.setState({
      sessionSearch: new Map(prevSessionSearch).set("timer-search-session", {
        query: "Monitor report",
        isOpen: true,
        mode: "fuzzy",
        category: "all",
        matches: [{ messageId: msg.id }],
        currentMatchIndex: 0,
      }),
    });

    try {
      const { container } = render(
        <MessageBubble message={msg} sessionId="timer-search-session" showTimestamp={false} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Expand timer description" }));

      const marks = Array.from(container.querySelectorAll("mark")).map((node) => node.textContent);
      expect(marks).toContain("Monitor");
      expect(marks).toContain("report");
    } finally {
      useStore.setState({ sessionSearch: prevSessionSearch });
    }
  });

  it("preserves search highlighting for the visible timer id when the query matches the inline timer row", () => {
    const prevSessionSearch = useStore.getState().sessionSearch;
    const msg = makeMessage({
      id: "timer-source-search-msg",
      role: "user",
      content: "[⏰ Timer t2] Monitor RTG datagen\n\nCheck squeue for RTG jobs and report shard status.",
      agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
    });

    useStore.setState({
      sessionSearch: new Map(prevSessionSearch).set("timer-search-session", {
        query: "t2",
        isOpen: true,
        mode: "strict",
        category: "all",
        matches: [{ messageId: msg.id }],
        currentMatchIndex: 0,
      }),
    });

    try {
      const { container } = render(
        <MessageBubble message={msg} sessionId="timer-search-session" showTimestamp={false} />,
      );

      const marks = Array.from(container.querySelectorAll("mark")).map((node) => node.textContent);
      expect(marks).toContain("t2");
    } finally {
      useStore.setState({ sessionSearch: prevSessionSearch });
    }
  });

  it("restores visible highlighting for strict full timer-header matches", () => {
    const prevSessionSearch = useStore.getState().sessionSearch;
    const msg = makeMessage({
      id: "timer-header-search-msg",
      role: "user",
      content: "[⏰ Timer t2] Monitor RTG datagen\n\nCheck squeue for RTG jobs and report shard status.",
      agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
    });

    useStore.setState({
      sessionSearch: new Map(prevSessionSearch).set("timer-search-session", {
        query: "Timer t2",
        isOpen: true,
        mode: "strict",
        category: "all",
        matches: [{ messageId: msg.id }],
        currentMatchIndex: 0,
      }),
    });

    try {
      const { container } = render(
        <MessageBubble message={msg} sessionId="timer-search-session" showTimestamp={false} />,
      );

      const marks = Array.from(container.querySelectorAll("mark")).map((node) => node.textContent);
      expect(marks).toContain("Timer t2");
    } finally {
      useStore.setState({ sessionSearch: prevSessionSearch });
    }
  });

  it("renders cancelled timers as simpler cancellation events instead of replaying the fired row", () => {
    const msg = makeMessage({
      role: "user",
      content: "[⏰ Timer t2 cancelled] Monitor RTG datagen",
      agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
    });
    render(<MessageBubble message={msg} showTimestamp={false} />);

    expect(screen.queryByText("via Timer t2")).toBeNull();
    expect(screen.getByText("t2")).toBeTruthy();
    expect(screen.getByText("cancelled")).toBeTruthy();
    expect(screen.getByText("Monitor RTG datagen")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /timer description/i })).toBeNull();
  });
});

// ─── Assistant messages ──────────────────────────────────────────────────────

describe("MessageBubble - assistant messages", () => {
  beforeEach(() => {
    markNotificationDoneMock.mockClear();
  });

  it("renders plain text assistant message with markdown", () => {
    const msg = makeMessage({ role: "assistant", content: "Hello world" });
    render(<MessageBubble message={msg} />);

    // Our mock renders content inside data-testid="markdown"
    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toBe("Hello world");
  });

  it("renders deprecated @to(user) tags as raw text", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "here's the latest status @to(user)",
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByTestId("markdown").textContent).toBe("here's the latest status @to(user)");
  });

  it("keeps trailing @to(user) suffix in text blocks", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "text", text: "Worker #3 finished tests. @to(user)" }],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByTestId("markdown").textContent).toBe("Worker #3 finished tests. @to(user)");
  });

  it("keeps trailing @to(self) suffix in assistant text", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "Internal handoff details @to(self)",
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByTestId("markdown").textContent).toBe("Internal handoff details @to(self)");
  });

  it("keeps deprecated suffixes in mixed text and tool blocks", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "text", text: "First note." },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" } },
        { type: "text", text: "Final status for user @to(user)" },
      ],
    });
    render(<MessageBubble message={msg} />);

    const markdownBlocks = screen.getAllByTestId("markdown");
    expect(markdownBlocks[0].textContent).toBe("First note.");
    expect(markdownBlocks[1].textContent).toBe("Final status for user @to(user)");
  });

  it("renders a timestamp for assistant messages", () => {
    const ts = 1700000003000;
    const msg = makeMessage({ role: "assistant", content: "Timed response", timestamp: ts });
    render(<MessageBubble message={msg} />);

    const time = screen.getByTestId("message-timestamp");
    expect(time.getAttribute("dateTime")).toBe(new Date(ts).toISOString());
    expect((time.textContent || "").length).toBeGreaterThan(0);
  });

  it("shows assistant turn duration next to the timestamp when present", () => {
    const ts = 1700000003000;
    const msg = makeMessage({
      role: "assistant",
      content: "Timed response",
      timestamp: ts,
      turnDurationMs: 5200,
    });
    render(<MessageBubble message={msg} />);

    const time = screen.getByTestId("message-timestamp");
    expect(time.textContent).toContain("5.2s");
  });

  it("renders assistant message with text content blocks", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "text", text: "Here is the answer" }],
    });
    render(<MessageBubble message={msg} />);

    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toBe("Here is the answer");
  });

  it("copies a stable message link for assistant messages", async () => {
    const prevSdkSessions = useStore.getState().sdkSessions;
    useStore.setState({
      sdkSessions: [
        { sessionId: "session-abc", state: "connected", cwd: "/repo", createdAt: 1, sessionNum: 123 } as any,
      ],
    });

    try {
      const msg = makeMessage({ id: "asst-msg-42", role: "assistant", content: "Assistant link target" });
      render(<MessageBubble message={msg} sessionId="session-abc" />);

      fireEvent.click(screen.getByTitle("Copy message"));
      fireEvent.click(screen.getByText("Copy message link"));

      await waitFor(() => {
        expect(writeClipboardTextMock).toHaveBeenCalledWith("http://localhost:3000/#/session/123/msg/asst-msg-42");
      });
    } finally {
      useStore.setState({ sdkSessions: prevSdkSessions });
    }
  });

  it("renders tool_use content blocks as ToolBlock components", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } }],
    });
    render(<MessageBubble message={msg} />);

    // Bash rows render as preview-only command entries.
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.getByText("pwd")).toBeTruthy();
  });

  it("shows a review checkbox affordance for takode notify review tool markers before inbox lookup resolves", () => {
    // The marker keeps the review checkbox visible immediately so the chip layout
    // matches the needs-input case, but it should stay disabled until the inbox
    // has the authoritative notification entry for this message.
    const msg = makeMessage({
      id: "asst-review-tool",
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "tool_use", id: "tu-review", name: "Bash", input: { command: "takode notify review" } }],
    });

    render(<MessageBubble message={msg} sessionId="review-session" />);

    expect(screen.getByRole("button", { name: "Mark as reviewed" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Ready for review")).toBeTruthy();
  });

  it("marks the matching review notification done from the in-message checkbox", async () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const initialNotifications = new Map(prevNotifications);
    initialNotifications.delete("review-session");
    useStore.setState({ sessionNotifications: initialNotifications });

    try {
      const msg = makeMessage({
        id: "asst-review-tool",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-review", name: "Bash", input: { command: "takode notify review" } },
        ],
      });

      render(<MessageBubble message={msg} sessionId="review-session" />);

      // Start from the pre-hydration state: the marker is present, but the
      // authoritative notification inbox has not delivered the matching entry.
      expect(screen.getByRole("button", { name: "Mark as reviewed" }).hasAttribute("disabled")).toBe(true);

      const hydratedNotifications = new Map(useStore.getState().sessionNotifications);
      hydratedNotifications.set("review-session", [
        {
          id: "n-review-1",
          category: "review",
          timestamp: Date.now(),
          messageId: "asst-review-tool",
          done: false,
        },
      ]);
      useStore.setState({ sessionNotifications: hydratedNotifications });

      // After the post-render store update arrives, the marker should enable
      // and forward the toggle through the existing API surface.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Mark as reviewed" }).hasAttribute("disabled")).toBe(false);
      });

      fireEvent.click(screen.getByRole("button", { name: "Mark as reviewed" }));

      await waitFor(() => {
        expect(markNotificationDoneMock).toHaveBeenCalledWith("review-session", "n-review-1", true);
      });
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });

  it("renders the review checkbox on plain-text assistant messages with direct notification metadata", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const nextNotifications = new Map(prevNotifications);
    nextNotifications.set("review-session", [
      {
        id: "n-review-plain",
        category: "review",
        timestamp: Date.now(),
        messageId: "asst-review-plain",
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: nextNotifications });

    try {
      const msg = makeMessage({
        id: "asst-review-plain",
        role: "assistant",
        content: "This change is ready for review.",
        notification: { category: "review", timestamp: Date.now(), summary: "Ready for review" },
      });

      render(<MessageBubble message={msg} sessionId="review-session" />);

      expect(screen.getByRole("button", { name: "Mark as reviewed" }).hasAttribute("disabled")).toBe(false);
      expect(screen.getByText("Ready for review")).toBeTruthy();
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });

  it("renders authoritative anchored notifications even when message text mentions takode notify", () => {
    // The real server-driven notification path comes from message.notification,
    // not from scanning assistant text. Mentioning `takode notify review` in the
    // message body must not interfere with anchored notification rendering.
    const prevNotifications = useStore.getState().sessionNotifications;
    const nextNotifications = new Map(prevNotifications);
    nextNotifications.set("review-session", [
      {
        id: "n-review-authoritative",
        category: "review",
        timestamp: Date.now(),
        messageId: "asst-review-authoritative",
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: nextNotifications });

    try {
      const msg = makeMessage({
        id: "asst-review-authoritative",
        role: "assistant",
        content: "Leader note: this quoted text mentions takode notify review but is not the source of the chip.",
        notification: { category: "review", timestamp: Date.now(), summary: "Ready for review" },
      });

      render(<MessageBubble message={msg} sessionId="review-session" />);

      expect(screen.getByText("Ready for review")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Mark as reviewed" }).hasAttribute("disabled")).toBe(false);
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });

  it("renders the review checkbox on block-based assistant messages with direct notification metadata", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const nextNotifications = new Map(prevNotifications);
    nextNotifications.set("review-session", [
      {
        id: "n-review-blocks",
        category: "review",
        timestamp: Date.now(),
        messageId: "asst-review-blocks",
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: nextNotifications });

    try {
      const msg = makeMessage({
        id: "asst-review-blocks",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "text", text: "Ready after the latest test pass." }],
        notification: { category: "review", timestamp: Date.now(), summary: "Ready for review" },
      });

      render(<MessageBubble message={msg} sessionId="review-session" />);

      expect(screen.getByRole("button", { name: "Mark as reviewed" }).hasAttribute("disabled")).toBe(false);
      expect(screen.getByText("Ready for review")).toBeTruthy();
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });

  it("does not render a duplicate tool-derived notification marker when authoritative notification metadata exists", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const nextNotifications = new Map(prevNotifications);
    nextNotifications.set("review-session", [
      {
        id: "n-review-dedup",
        category: "review",
        timestamp: Date.now(),
        messageId: "asst-review-dedup",
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: nextNotifications });

    try {
      const msg = makeMessage({
        id: "asst-review-dedup",
        role: "assistant",
        content: "I have the result. Sending the notification now.",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-review-dedup",
            name: "Bash",
            input: { command: 'TAKODE_API_PORT=3455 takode notify review "Ready for review"' },
          },
        ],
        notification: { category: "review", timestamp: Date.now(), summary: "Ready for review" },
      });

      render(<MessageBubble message={msg} sessionId="review-session" />);

      expect(screen.getAllByText("Ready for review")).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /Mark as reviewed|Mark as not reviewed/ })).toHaveLength(1);
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });

  it("renders completed review notifications with the undo label and done styling", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const nextNotifications = new Map(prevNotifications);
    nextNotifications.set("review-session", [
      {
        id: "n-review-done",
        category: "review",
        timestamp: Date.now(),
        messageId: "asst-review-done",
        done: true,
      },
    ]);
    useStore.setState({ sessionNotifications: nextNotifications });

    try {
      const msg = makeMessage({
        id: "asst-review-done",
        role: "assistant",
        content: "Review completed.",
        notification: { category: "review", timestamp: Date.now(), summary: "Ready for review" },
      });

      render(<MessageBubble message={msg} sessionId="review-session" />);

      expect(screen.getByRole("button", { name: "Mark as not reviewed" }).hasAttribute("disabled")).toBe(false);
      expect(screen.getByText("Ready for review").className).toContain("line-through");
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });

  it("uses the local toggle override for preview markers instead of the notification API", () => {
    // Playground previews should be able to demonstrate the review checkbox
    // locally without routing clicks through the real session notification API.
    const onToggleDone = vi.fn();

    render(
      <NotificationMarker
        category="review"
        summary="Ready for review"
        doneOverride={false}
        onToggleDone={onToggleDone}
        showReplyAction={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark as reviewed" }));

    expect(onToggleDone).toHaveBeenCalledTimes(1);
    expect(markNotificationDoneMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Reply to this notification")).toBeNull();
  });

  it("does not render Task tool_use blocks (they render as SubagentContainers in MessageFeed)", () => {
    // Task tool_use blocks must be filtered out in MessageBubble to prevent
    // duplicate subagent chips: one from SubagentContainer (correct) and one
    // from ToolBlock with label "Subagent" (incorrect).
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        {
          type: "tool_use",
          id: "tu-task-1",
          name: "Task",
          input: { description: "Explore auth", subagent_type: "Explore" },
        },
      ],
    });
    render(<MessageBubble message={msg} />);

    // "Subagent" is getToolLabel("Task") — should NOT appear
    expect(screen.queryByText("Subagent")).toBeNull();
  });

  it("does not render synthetic write_stdin polling tool_use blocks", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        {
          type: "tool_use",
          id: "tu-write-stdin-1",
          name: "write_stdin",
          input: { session_id: "59356", chars: "" },
        },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.queryByText("write_stdin")).toBeNull();
    expect(screen.queryByText("59356")).toBeNull();
  });

  it("renders thinking blocks with 'Thinking' label and char count", () => {
    const thinkingText = "Let me analyze this problem step by step...";
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "thinking", thinking: thinkingText }],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText(`${thinkingText.length} chars`)).toBeTruthy();
  });

  it("thinking blocks expand and collapse on click", () => {
    const thinkingText = "Deep analysis of the problem at hand.";
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "thinking", thinking: thinkingText }],
    });
    render(<MessageBubble message={msg} />);

    // Initially collapsed - thinking text should not be visible in a pre
    expect(screen.queryByText(thinkingText)).toBeNull();

    // Find and click the thinking button
    const thinkingButton = screen.getByText("Thinking").closest("button")!;
    fireEvent.click(thinkingButton);

    // Now the thinking text should be visible
    expect(screen.getByText(thinkingText)).toBeTruthy();

    // Click again to collapse
    fireEvent.click(thinkingButton);
    expect(screen.queryByText(thinkingText)).toBeNull();
  });

  it("renders short codex thinking summary as compact inline text and not collapsible", () => {
    const thinkingText = "Short codex reasoning summary.";
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });

    try {
      const msg = makeMessage({
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "thinking", thinking: thinkingText }],
      });
      render(<MessageBubble message={msg} sessionId="codex-session" />);

      // Codex thinking summaries are rendered inline (not collapsed/toggleable).
      expect(screen.getByText(thinkingText)).toBeTruthy();
      expect(screen.queryByText(`${thinkingText.length} chars`)).toBeNull();
      expect(screen.queryByRole("button", { name: /expand thinking summary/i })).toBeNull();
    } finally {
      useStore.setState({ sessions: prevSessions });
    }
  });

  it("truncates long codex thinking summary with expandable ellipsis", () => {
    const thinkingText =
      "This is a much longer codex reasoning summary that should be truncated in preview mode until the user expands it via the ellipsis control at the end.";
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });

    try {
      const msg = makeMessage({
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "thinking", thinking: thinkingText }],
      });
      render(<MessageBubble message={msg} sessionId="codex-session" />);

      const expand = screen.getByRole("button", { name: /expand thinking summary/i });
      expect(expand).toBeTruthy();
      expect(screen.queryByText(thinkingText)).toBeNull();

      fireEvent.click(expand);
      expect(screen.getByText(thinkingText)).toBeTruthy();

      const collapse = screen.getByRole("button", { name: /collapse thinking summary/i });
      fireEvent.click(collapse);
      expect(screen.queryByText(thinkingText)).toBeNull();
    } finally {
      useStore.setState({ sessions: prevSessions });
    }
  });

  it("shows codex thinking time inline in compact mode", () => {
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });

    try {
      const msg = makeMessage({
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "thinking", thinking: "Summary text", thinking_time_ms: 1200 }],
      });
      render(<MessageBubble message={msg} sessionId="codex-session" />);
      expect(screen.getByText("Summary text (1.2 s)")).toBeTruthy();
      expect(screen.queryByText(/thinking time/i)).toBeNull();
    } finally {
      useStore.setState({ sessions: prevSessions });
    }
  });

  it("strips outer markdown bold markers from codex thinking summary text", () => {
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });

    try {
      const msg = makeMessage({
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "thinking", thinking: "**Checking route fields for reasoning effort**" }],
      });
      render(<MessageBubble message={msg} sessionId="codex-session" />);
      expect(screen.getByText("Checking route fields for reasoning effort")).toBeTruthy();
      expect(screen.queryByText("**Checking route fields for reasoning effort**")).toBeNull();
    } finally {
      useStore.setState({ sessions: prevSessions });
    }
  });

  it("does not render duplicate raw content when codex thinking block exists", () => {
    const thinkingText = "Inspecting session and worktree";
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });

    try {
      const msg = makeMessage({
        role: "assistant",
        content: thinkingText,
        contentBlocks: [{ type: "thinking", thinking: thinkingText }],
      });
      render(<MessageBubble message={msg} sessionId="codex-session" />);

      // Reasoning should render once in the styled thinking block, not again as fallback markdown.
      expect(screen.getAllByText(thinkingText)).toHaveLength(1);
      expect(screen.queryByTestId("markdown")).toBeNull();
    } finally {
      useStore.setState({ sessions: prevSessions });
    }
  });

  it("renders tool_result blocks with string content", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "tool_result", tool_use_id: "tu-1", content: "Command output: success" }],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Command output: success")).toBeTruthy();
  });

  it("renders tool_result blocks with JSON content", () => {
    const jsonContent = [{ type: "text" as const, text: "nested result" }];
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "tool_result", tool_use_id: "tu-2", content: jsonContent as unknown as string }],
    });
    render(<MessageBubble message={msg} />);

    // The JSON.stringify of the content should be rendered
    const rendered = screen.getByText(JSON.stringify(jsonContent));
    expect(rendered).toBeTruthy();
  });

  it("renders tool_result error blocks with error styling", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "tool_result", tool_use_id: "tu-3", content: "Error: file not found", is_error: true }],
    });
    const { container } = render(<MessageBubble message={msg} />);

    expect(screen.getByText("Error: file not found")).toBeTruthy();
    // Check for error styling class
    const errorDiv = container.querySelector(".text-cc-error");
    expect(errorDiv).toBeTruthy();
  });

  it("renders non-error tool_result without error styling", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "tool_result", tool_use_id: "tu-4", content: "Success output" }],
    });
    const { container } = render(<MessageBubble message={msg} />);

    expect(screen.getByText("Success output")).toBeTruthy();
    const resultDiv = screen.getByText("Success output");
    expect(resultDiv.className).toContain("text-cc-muted");
    expect(resultDiv.className).not.toContain("text-cc-error");
  });
});

// ─── groupContentBlocks behavior (tested indirectly through MessageBubble) ──

describe("MessageBubble - content block grouping", () => {
  it("renders file-tool blocks as standalone chips without grouping", () => {
    // Edit/Write/Read tools are never grouped -- each gets its own standalone chip
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } },
        { type: "tool_use", id: "tu-3", name: "Read", input: { file_path: "/c.ts" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // No count badge -- each is standalone
    expect(screen.queryByText("3")).toBeNull();
    // 3 standalone chips, each with "Read File" label
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(3);
  });

  it("keeps the outer Terminal group label while removing repeated inner bash labels", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "test -f package.json" } },
        { type: "tool_use", id: "tu-2", name: "Bash", input: { command: "bun run test" } },
      ],
    });

    render(<MessageBubble message={msg} />);

    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getAllByText("Terminal")).toHaveLength(1);
    expect(screen.getByText("test -f package.json")).toBeTruthy();
    expect(screen.getByText("bun run test")).toBeTruthy();
  });

  it("does not group different tool types together", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "tu-2", name: "Bash", input: { command: "ls" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Both labels should appear separately
    expect(screen.getByText("Read File")).toBeTruthy();
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.getByText("ls")).toBeTruthy();
  });

  it("renders a single tool_use without group count badge", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo hi" } }],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.getByText("echo hi")).toBeTruthy();
    expect(screen.queryByText("1")).toBeNull();
  });

  it("groups same tools separated by non-tool blocks into separate groups", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "text", text: "Let me check something else" },
        { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // The two Read tools should not be grouped since there is a text block between them
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(2);
  });
});

// ─── HerdEventMessage tests ─────────────────────────────────────────────────

describe("HerdEventMessage", () => {
  it("renders event headers collapsed by default", () => {
    // Herd event with activity lines should show header but NOT activity
    const msg = makeMessage({
      role: "user",
      content: '1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s | tools: 1\n  [10] user: "Fix bug"\n  [11] ✓ "Done"',
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    render(<HerdEventMessage message={msg} showTimestamp={false} />);

    // Header should be visible
    expect(screen.getByText(/turn_end.*5\.0s/)).toBeTruthy();
    // Activity should NOT be visible (collapsed)
    expect(screen.queryByText(/Fix bug/)).toBeNull();
  });

  it("expands activity on click when activity lines are present", () => {
    const msg = makeMessage({
      role: "user",
      content: '1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s\n  [10] user: "Fix bug"\n  [11] ✓ "Done"',
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    render(<HerdEventMessage message={msg} showTimestamp={false} />);

    // Click the header to expand
    fireEvent.click(screen.getByText(/turn_end/));
    // Activity should now be visible
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
    // Regression test for the nested interactive path: Enter and Space on the
    // #N button should route to the session and must not bubble into the
    // parent chip's expand/collapse keyboard handler.
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
    // Regression guard: the #N button suppresses the browser default outline,
    // so it must carry its own replacement focus-visible treatment.
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

  it("renders events without activity as clickable (expand shows untruncated header)", () => {
    // Event header with no activity lines -- still clickable with chevron,
    // but no activity <pre> block appears on expand
    const msg = makeMessage({
      role: "user",
      content: "1 event from 1 session\n\n#8 | turn_end | ✓ 5.0s",
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    render(<HerdEventMessage message={msg} showTimestamp={false} />);

    // Header visible with chevron
    expect(screen.getByText(/turn_end/)).toBeTruthy();
    const chip = screen.getByText(/turn_end/).closest('[role="button"]') as HTMLElement;
    expect(chip.querySelector("svg")).not.toBeNull();

    // Click expands (removes truncation) but shows no activity <pre> block
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

    // Both headers visible, no activity
    expect(screen.getByText(/5\.0s/)).toBeTruthy();
    expect(screen.getByText(/3\.0s/)).toBeTruthy();
    expect(screen.queryByText(/First/)).toBeNull();
    expect(screen.queryByText(/Second/)).toBeNull();

    // Expand only first event
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
    // Regression test: ## and ### headings from a worker's response (key message)
    // were incorrectly parsed as separate event headers because they start with #.
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

    // Should parse as exactly ONE event (not 4 events for each heading)
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);

    // Header should be the real event line
    expect(screen.getByText(/turn_end.*53\.6s/)).toBeTruthy();

    // Markdown headings should NOT appear as separate event headers
    expect(screen.queryByText("## Skeptic Review: Session #286")).toBeNull();
    expect(screen.queryByText("### Task")).toBeNull();

    // Expand the event -- all content including headings should be visible
    fireEvent.click(buttons[0]);
    expect(screen.getByText(/Skeptic Review/)).toBeTruthy();
    expect(screen.getByText(/ACCEPT/)).toBeTruthy();
  });
});

// ─── parseHerdEvents unit tests ─────────────────────────────────────────────

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
    // Key bug: ## and ### headings in key message content were mistakenly
    // parsed as event headers because they start with #
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
    // Only ONE real event header (#287 | turn_end)
    expect(events).toHaveLength(1);
    expect(events[0].header).toBe("#287 | turn_end | ✓ 53.6s");
    // All remaining lines are activity (including markdown headings)
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

  it("returns empty array when content has only a batch header (no event lines)", () => {
    expect(parseHerdEvents("3 events from 2 sessions\n\n")).toHaveLength(0);
  });

  it("parses event header at very first line (no batch header prefix)", () => {
    const events = parseHerdEvents("#1 | turn_end | ✓ 1.0s\n  [5] asst: Done.");
    expect(events).toHaveLength(1);
    // Activity includes trailing blank line from the split, plus the actual line
    expect(events[0].activity.some((l) => l.includes("Done"))).toBe(true);
  });

  it("preserves blank lines in activity for 1:1 fidelity with injected content", () => {
    // Key message content often has paragraph breaks (blank lines between sections).
    // These must be preserved so the expanded view is an exact match of what was injected.
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
    // Blank lines between sections should be preserved
    const joined = events[0].activity.join("\n");
    expect(joined).toContain("## Summary\n\nThe fix is correct.\n\n## Details");
  });
});
