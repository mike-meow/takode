// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  THREAD_OUTCOME_REMINDER_SOURCE_ID,
  THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
} from "../../shared/thread-outcome-reminder.js";
import {
  COMPACTION_RECOVERY_SOURCE_ID,
  COMPACTION_RECOVERY_SOURCE_LABEL,
  LEADER_KICKOFF_SOURCE_ID,
  LEADER_KICKOFF_SOURCE_LABEL,
} from "../../shared/injected-event-message.js";
import type { ChatMessage, ContentBlock } from "../types.js";

const revertToMessageMock = vi.hoisted(() => vi.fn(async () => ({})));
const markNotificationDoneMock = vi.hoisted(() => vi.fn(async () => ({})));
const writeClipboardTextMock = vi.hoisted(() => vi.fn(async () => undefined));
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

import { MessageBubble } from "./MessageBubble.js";
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

  it("renders the stable thread source badge for user messages", () => {
    const msg = makeMessage({
      role: "user",
      content: "Quest-thread reply",
      metadata: { threadKey: "q-941", questId: "q-941" },
    });

    render(<MessageBubble message={msg} />);

    expect(screen.getByTestId("thread-source-badge").textContent).toBe("[thread:q-941]");
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

  it("renders assistant-mentioned local images as a thumbnail-only preview group", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [{ type: "text", text: "Evidence is in /tmp/desktop.png and /tmp/missing.webp." }],
    });
    render(<MessageBubble message={msg} sessionId="test-session" />);

    expect(screen.queryByTestId("assistant-image-preview-group")).toBeNull();
    const preloadImages = screen.getAllByTestId("image-preview-preload");
    fireEvent.load(preloadImages[0]!);
    fireEvent.error(preloadImages[1]!);

    const previewGroup = screen.getByTestId("assistant-image-preview-group");
    expect(within(previewGroup).getByRole("button", { name: "Open image desktop.png" })).toBeTruthy();
    expect(within(previewGroup).queryByRole("button", { name: "Open image missing.webp" })).toBeNull();
    expect(within(previewGroup).queryByText("desktop.png")).toBeNull();

    fireEvent.click(within(previewGroup).getByRole("button", { name: "Open image desktop.png" }));
    expect(screen.getByRole("dialog", { name: "Image preview: desktop.png" })).toBeTruthy();
    expect(screen.getByTestId("image-preview-modal-image").getAttribute("src")).toBe(
      "/api/fs/image?path=%2Ftmp%2Fdesktop.png&variant=full",
    );
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
    const prevMessages = new Map(useStore.getState().messages);
    useStore.setState({
      sdkSessions: [
        { sessionId: "session-abc", state: "connected", cwd: "/repo", createdAt: 1, sessionNum: 123 } as any,
      ],
    });

    try {
      const msg = makeMessage({ id: "user-msg-42", role: "user", content: "Link me", historyIndex: 4 });
      useStore
        .getState()
        .setMessages("session-abc", [makeMessage({ id: "previous-msg", role: "assistant", content: "Previous" }), msg]);
      render(<MessageBubble message={msg} sessionId="session-abc" />);

      fireEvent.click(screen.getByTitle("Message options"));
      fireEvent.click(screen.getByText("Copy message link"));

      await waitFor(() => {
        expect(writeClipboardTextMock).toHaveBeenCalledWith("http://localhost:3000/#/session/123/msg/4");
      });
    } finally {
      useStore.setState({ sdkSessions: prevSdkSessions, messages: prevMessages });
    }
  });

  it("restores image attachments into the composer draft after revert", async () => {
    const prevSessions = useStore.getState().sessions;
    const nextSessions = new Map(prevSessions);
    nextSessions.set("codex-session", { backend_type: "codex" } as any);
    useStore.setState({ sessions: nextSessions });
    useStore.getState().setComposerDraft("codex-session", {
      text: "stale draft text",
      images: [{ id: "stale-1", name: "stale.png", base64: "stale-data", mediaType: "image/png", status: "ready" }],
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
        expect(draft?.images[0]?.status).toBe("uploading");
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
      images: [{ id: "stale-2", name: "stale.png", base64: "stale-data", mediaType: "image/png", status: "ready" }],
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
      images: [{ id: "stale-3", name: "stale.png", base64: "stale-data", mediaType: "image/png", status: "ready" }],
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

describe("MessageBubble - assistant thread source", () => {
  it("renders the stable thread source badge for assistant messages", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "Main response",
      contentBlocks: [{ type: "text", text: "Main response" }],
      metadata: { threadKey: "main" },
    });

    render(<MessageBubble message={msg} />);

    expect(screen.getByTestId("thread-source-badge").textContent).toBe("[thread:main]");
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

  it("renders Thread Outcome Reminder as a collapsed chip by default", () => {
    const msg = makeMessage({
      role: "user",
      content: [
        "Thread outcome reminder: mark every touched leader thread with a fresh outcome before idling.",
        "Missing outcome marker for: Main.",
        'Use `takode notify waiting "..."` for non-attention waiting/WIP.',
      ].join("\n"),
      agentSource: {
        sessionId: THREAD_OUTCOME_REMINDER_SOURCE_ID,
        sessionLabel: THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
      },
    });
    render(<MessageBubble message={msg} showTimestamp={false} />);

    const chip = screen.getByRole("button", { name: `Expand ${THREAD_OUTCOME_REMINDER_SOURCE_LABEL}` });
    expect(chip.textContent).toContain("Thread Outcome Reminder");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/mark every touched leader thread/)).toBeNull();
    expect(screen.queryByTestId("agent-source-badge")).toBeNull();
  });

  it("expands Thread Outcome Reminder content on demand", () => {
    const msg = makeMessage({
      role: "user",
      content: [
        "Thread outcome reminder: mark every touched leader thread with a fresh outcome before idling.",
        "Missing outcome marker for: Main.",
      ].join("\n"),
      agentSource: {
        sessionId: THREAD_OUTCOME_REMINDER_SOURCE_ID,
        sessionLabel: THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
      },
    });
    render(<MessageBubble message={msg} showTimestamp={false} />);

    const chip = screen.getByRole("button", { name: `Expand ${THREAD_OUTCOME_REMINDER_SOURCE_LABEL}` });
    fireEvent.click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: `Collapse ${THREAD_OUTCOME_REMINDER_SOURCE_LABEL}` })).toBeTruthy();
    expect(screen.getByText(/mark every touched leader thread/)).toBeTruthy();
    expect(screen.getByText(/Missing outcome marker for: Main/)).toBeTruthy();
  });

  it("renders Thread Outcome Reminder as historical when a later same-thread needs-input satisfies it", async () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const nextNotifications = new Map(prevNotifications);
    nextNotifications.set("thread-outcome-session", [
      {
        id: "n-approval",
        category: "needs-input",
        summary: "Approve recovery quest",
        timestamp: 2000,
        messageId: "approval-plan",
        done: true,
        threadKey: "main",
      },
    ]);
    useStore.setState({ sessionNotifications: nextNotifications });

    try {
      const msg = makeMessage({
        role: "user",
        content: [
          "Thread outcome reminder: mark every touched leader thread with a fresh outcome before idling.",
          "Missing outcome marker for: Main.",
        ].join("\n"),
        timestamp: 1500,
        agentSource: {
          sessionId: THREAD_OUTCOME_REMINDER_SOURCE_ID,
          sessionLabel: THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
        },
        metadata: { threadKey: "main" },
      });
      render(<MessageBubble message={msg} sessionId="thread-outcome-session" showTimestamp={false} />);

      const chip = screen.getByRole("button", { name: `Expand Historical ${THREAD_OUTCOME_REMINDER_SOURCE_LABEL}` });
      expect(chip.textContent).toContain(`Historical ${THREAD_OUTCOME_REMINDER_SOURCE_LABEL}`);
      expect(screen.queryByText(/Satisfied by needs-input/)).toBeNull();

      await userEvent.click(chip);

      expect(screen.getByText("Satisfied by needs-input: Approve recovery quest")).toBeTruthy();
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });

  it("renders compaction recovery injections as collapsed event chips by default", () => {
    const msg = makeMessage({
      role: "user",
      content: [
        "Context was compacted. Before continuing, recover enough context from your own session history to safely resume work:",
        "",
        "1. Inspect your own session history with Takode tools.",
      ].join("\n"),
      agentSource: {
        sessionId: COMPACTION_RECOVERY_SOURCE_ID,
        sessionLabel: COMPACTION_RECOVERY_SOURCE_LABEL,
      },
    });
    render(<MessageBubble message={msg} showTimestamp={false} />);

    const chip = screen.getByRole("button", { name: `Expand ${COMPACTION_RECOVERY_SOURCE_LABEL}` });
    expect(chip.textContent).toContain("Compaction Recovery");
    expect(chip.textContent).toContain("event");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Inspect your own session history/)).toBeNull();
    expect(screen.queryByTestId("agent-source-badge")).toBeNull();
  });

  it("expands leader kickoff event injections on demand", () => {
    const msg = makeMessage({
      role: "user",
      content: [
        "[System] You are a leader session. Your job is to coordinate worker sessions.",
        "",
        "**On startup**: Load the `takode-orchestration` and `quest` skills.",
      ].join("\n"),
      agentSource: {
        sessionId: LEADER_KICKOFF_SOURCE_ID,
        sessionLabel: LEADER_KICKOFF_SOURCE_LABEL,
      },
    });
    render(<MessageBubble message={msg} showTimestamp={false} />);

    const chip = screen.getByRole("button", { name: `Expand ${LEADER_KICKOFF_SOURCE_LABEL}` });
    fireEvent.click(chip);

    expect(screen.getByRole("button", { name: `Collapse ${LEADER_KICKOFF_SOURCE_LABEL}` })).toBeTruthy();
    expect(screen.getByText(/coordinate worker sessions/)).toBeTruthy();
    expect(screen.getByText(/System-injected startup instructions/)).toBeTruthy();
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
  it("renders new timer reminders as inline rows while preserving the softer reminder framing", () => {
    const msg = makeMessage({
      role: "user",
      content:
        "[⏰ Timer t2 reminder] Monitor RTG datagen\n\nThis is a reminder from your earlier timer note, not a new user instruction.\n\nEarlier note:\nCheck squeue for RTG jobs and report shard status.",
      agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
    });
    render(<MessageBubble message={msg} showTimestamp={false} />);

    expect(screen.queryByText("via Timer t2")).toBeNull();
    expect(screen.getByText("t2")).toBeTruthy();
    expect(screen.getByText("Monitor RTG datagen")).toBeTruthy();
    expect(screen.queryByText(/not a new user instruction/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand timer description" }));
    expect(screen.getByText(/not a new user instruction/)).toBeTruthy();
    expect(screen.getByText(/Earlier note:/)).toBeTruthy();
    expect(screen.getByText(/Check squeue for RTG jobs/)).toBeTruthy();
  });

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

  it("renders a visible Slack thread summary for root assistant messages with server-owned thread records", () => {
    // Thread counts come from authoritative session state, so reconnect replay
    // can rebuild the summary without relying on local UI state.
    const sessionId = "session-with-slack-thread";
    const msg = makeMessage({ id: "assistant-anchor", role: "assistant", content: "Root answer" });
    useStore.getState().addSession({
      session_id: sessionId,
      backend_type: "claude",
      model: "claude-sonnet",
      cwd: "/tmp/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 1,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/tmp/test",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      slackThreads: {
        "st-test": {
          id: "st-test",
          rootSessionId: sessionId,
          childSessionId: "child-session",
          anchorMessageId: "assistant-anchor",
          anchorHistoryIndex: 1,
          anchorPreview: "Root answer",
          createdAt: 1,
          updatedAt: 2,
          messageCount: 2,
          lastMessagePreview: "Thread follow-up",
          seeded: true,
        },
      },
    } as any);

    render(<MessageBubble message={msg} sessionId={sessionId} currentThreadKey="main" />);

    expect(screen.getByText("2 replies")).toBeTruthy();
    expect(screen.getByText("Thread follow-up")).toBeTruthy();
  });

  it("keeps Slack thread creation available for root assistant messages by default", () => {
    const msg = makeMessage({ id: "assistant-anchor", role: "assistant", content: "Root answer" });

    render(<MessageBubble message={msg} sessionId="root-session" currentThreadKey="main" />);

    expect(screen.getByRole("button", { name: "Start thread" })).toBeTruthy();
  });

  it("suppresses Slack thread creation for assistant messages embedded in a Slack thread panel", () => {
    const msg = makeMessage({ id: "thread-assistant", role: "assistant", content: "Thread answer" });

    render(
      <MessageBubble
        message={msg}
        sessionId="hidden-thread-child"
        currentThreadKey="main"
        showSlackThreadActions={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Start thread" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
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

  it("copies the raw history index for assistant messages loaded from a non-zero history window", async () => {
    const prevSdkSessions = useStore.getState().sdkSessions;
    const prevMessages = new Map(useStore.getState().messages);
    useStore.setState({
      sdkSessions: [
        { sessionId: "session-abc", state: "connected", cwd: "/repo", createdAt: 1, sessionNum: 123 } as any,
      ],
    });

    try {
      const msg = makeMessage({
        id: "asst-msg-42",
        role: "assistant",
        content: "Assistant link target",
        historyIndex: 52,
      });
      useStore
        .getState()
        .setMessages("session-abc", [
          makeMessage({ id: "prompt-msg", role: "user", content: "Question", historyIndex: 50 }),
          msg,
        ]);
      render(<MessageBubble message={msg} sessionId="session-abc" />);

      fireEvent.click(screen.getByTitle("Copy message"));
      fireEvent.click(screen.getByText("Copy message link"));

      await waitFor(() => {
        expect(writeClipboardTextMock).toHaveBeenCalledWith("http://localhost:3000/#/session/123/msg/52");
      });
    } finally {
      useStore.setState({ sdkSessions: prevSdkSessions, messages: prevMessages });
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

  it("promotes a matching inbox notification into the rich banner when message metadata has not landed yet", () => {
    // q-568: notification_update can arrive before the assistant message has its
    // inline `notification` metadata. When the inbox already has exactly one
    // notification for this message, the richer summary-bearing banner should
    // win immediately and suppress the fallback `takode notify` chip.
    const prevNotifications = useStore.getState().sessionNotifications;
    const nextNotifications = new Map(prevNotifications);
    nextNotifications.set("review-session", [
      {
        id: "n-review-store-fallback",
        category: "review",
        timestamp: Date.now(),
        messageId: "asst-review-store-fallback",
        summary: "q-568 single rich chip",
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: nextNotifications });

    try {
      const msg = makeMessage({
        id: "asst-review-store-fallback",
        role: "assistant",
        content: "The verification summary is ready.",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-review-store-fallback",
            name: "Bash",
            input: { command: 'TAKODE_API_PORT=3455 takode notify review "q-568 single rich chip"' },
          },
        ],
      });

      render(<MessageBubble message={msg} sessionId="review-session" />);

      expect(screen.getAllByText("q-568 single rich chip")).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /Mark as reviewed|Mark as not reviewed/ })).toHaveLength(1);
      expect(screen.queryByText("Ready for review")).toBeNull();
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
