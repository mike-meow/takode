// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import type { ChatMessage, ContentBlock } from "../types.js";

// Mock react-markdown to avoid ESM/parsing issues in tests
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

import { MessageBubble } from "./MessageBubble.js";
import { useStore } from "../store.js";

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
});

// ─── Assistant messages ──────────────────────────────────────────────────────

describe("MessageBubble - assistant messages", () => {
  it("renders plain text assistant message with markdown", () => {
    const msg = makeMessage({ role: "assistant", content: "Hello world" });
    render(<MessageBubble message={msg} />);

    // Our mock renders content inside data-testid="markdown"
    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toBe("Hello world");
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
      contentBlocks: [
        { type: "text", text: "Here is the answer" },
      ],
    });
    render(<MessageBubble message={msg} />);

    const markdown = screen.getByTestId("markdown");
    expect(markdown.textContent).toBe("Here is the answer");
  });

  it("renders tool_use content blocks as ToolBlock components", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // ToolBlock renders with the label "Terminal" for Bash
    expect(screen.getByText("Terminal")).toBeTruthy();
    // And the preview should show the command
    expect(screen.getByText("pwd")).toBeTruthy();
  });

  it("renders thinking blocks with 'Thinking' label and char count", () => {
    const thinkingText = "Let me analyze this problem step by step...";
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "thinking", thinking: thinkingText },
      ],
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
      contentBlocks: [
        { type: "thinking", thinking: thinkingText },
      ],
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

  it("renders codex thinking summary as compact inline text and not collapsible", () => {
    const thinkingText = "This is a concise codex reasoning summary that should appear directly in the collapsed header.";
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
      expect(screen.getByText(/This is a concise codex reasoning summary/)).toBeTruthy();
      expect(screen.queryByText(`${thinkingText.length} chars`)).toBeNull();
      expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
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

  it("renders tool_result blocks with string content", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-1", content: "Command output: success" },
      ],
    });
    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Command output: success")).toBeTruthy();
  });

  it("renders tool_result blocks with JSON content", () => {
    const jsonContent = [{ type: "text" as const, text: "nested result" }];
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-2", content: jsonContent as unknown as string },
      ],
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
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-3", content: "Error: file not found", is_error: true },
      ],
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
      contentBlocks: [
        { type: "tool_result", tool_use_id: "tu-4", content: "Success output" },
      ],
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
  it("groups consecutive same-tool tool_use blocks together", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } },
        { type: "tool_use", id: "tu-3", name: "Read", input: { file_path: "/c.ts" } },
      ],
    });
    const { container } = render(<MessageBubble message={msg} />);

    // When grouped, there should be a count badge showing "3"
    expect(screen.getByText("3")).toBeTruthy();
    // The group header label plus each expanded child renders the tool name.
    // 1 (group header) + 3 (children, since group defaults to open) = 4 total.
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(4);
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
    expect(screen.getByText("Terminal")).toBeTruthy();
  });

  it("renders a single tool_use without group count badge", () => {
    const msg = makeMessage({
      role: "assistant",
      content: "",
      contentBlocks: [
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo hi" } },
      ],
    });
    render(<MessageBubble message={msg} />);

    // Should render Terminal label but no count badge
    expect(screen.getByText("Terminal")).toBeTruthy();
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
