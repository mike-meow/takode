// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolBlock, ToolIcon, getToolIcon, getToolLabel, getPreview, formatDuration } from "./ToolBlock.js";
import { useStore } from "../store.js";

// ─── getToolIcon ─────────────────────────────────────────────────────────────

describe("getToolIcon", () => {
  it("returns 'terminal' for Bash", () => {
    expect(getToolIcon("Bash")).toBe("terminal");
  });

  it("returns 'file' for Read", () => {
    expect(getToolIcon("Read")).toBe("file");
  });

  it("returns 'file-plus' for Write", () => {
    expect(getToolIcon("Write")).toBe("file-plus");
  });

  it("returns 'file-edit' for Edit", () => {
    expect(getToolIcon("Edit")).toBe("file-edit");
  });

  it("returns 'search' for Glob", () => {
    expect(getToolIcon("Glob")).toBe("search");
  });

  it("returns 'search' for Grep", () => {
    expect(getToolIcon("Grep")).toBe("search");
  });

  it("returns 'globe' for WebFetch", () => {
    expect(getToolIcon("WebFetch")).toBe("globe");
  });

  it("returns 'globe' for WebSearch", () => {
    expect(getToolIcon("WebSearch")).toBe("globe");
  });

  it("returns 'list' for TaskCreate", () => {
    expect(getToolIcon("TaskCreate")).toBe("list");
  });

  it("returns 'message' for SendMessage", () => {
    expect(getToolIcon("SendMessage")).toBe("message");
  });

  it("returns 'tool' for unknown tool names", () => {
    expect(getToolIcon("SomeUnknownTool")).toBe("tool");
    expect(getToolIcon("")).toBe("tool");
    expect(getToolIcon("FooBar")).toBe("tool");
  });
});

// ─── getToolLabel ────────────────────────────────────────────────────────────

describe("getToolLabel", () => {
  it("returns 'Terminal' for Bash", () => {
    expect(getToolLabel("Bash")).toBe("Terminal");
  });

  it("returns 'Read File' for Read", () => {
    expect(getToolLabel("Read")).toBe("Read File");
  });

  it("returns 'Write File' for Write", () => {
    expect(getToolLabel("Write")).toBe("Write File");
  });

  it("returns 'Edit File' for Edit", () => {
    expect(getToolLabel("Edit")).toBe("Edit File");
  });

  it("returns 'Find Files' for Glob", () => {
    expect(getToolLabel("Glob")).toBe("Find Files");
  });

  it("returns 'Search Content' for Grep", () => {
    expect(getToolLabel("Grep")).toBe("Search Content");
  });

  it("returns known labels for newly added tools", () => {
    expect(getToolLabel("WebFetch")).toBe("Web Fetch");
    expect(getToolLabel("Task")).toBe("Subagent");
    expect(getToolLabel("TodoWrite")).toBe("Tasks");
    expect(getToolLabel("NotebookEdit")).toBe("Notebook");
    expect(getToolLabel("SendMessage")).toBe("Message");
  });

  it("returns the name itself for unknown tools", () => {
    expect(getToolLabel("SomeUnknownTool")).toBe("SomeUnknownTool");
    expect(getToolLabel("CustomTool")).toBe("CustomTool");
  });
});

// ─── getPreview ──────────────────────────────────────────────────────────────

describe("getPreview", () => {
  it("extracts command for Bash tools", () => {
    expect(getPreview("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("truncates Bash commands longer than 60 chars", () => {
    const longCommand = "a".repeat(80);
    const result = getPreview("Bash", { command: longCommand });
    expect(result).toBe("a".repeat(60) + "...");
    expect(result.length).toBe(63);
  });

  it("does not truncate Bash commands at exactly 60 chars", () => {
    const exactCommand = "b".repeat(60);
    expect(getPreview("Bash", { command: exactCommand })).toBe(exactCommand);
  });

  it("extracts last 2 path segments for Read", () => {
    expect(getPreview("Read", { file_path: "/home/user/project/src/index.ts" })).toBe("src/index.ts");
  });

  it("extracts last 2 path segments for Write", () => {
    expect(getPreview("Write", { file_path: "/var/log/app.log" })).toBe("log/app.log");
  });

  it("extracts last 2 path segments for Edit", () => {
    expect(getPreview("Edit", { file_path: "/a/b/c/d.txt" })).toBe("c/d.txt");
  });

  it("handles short paths for file tools", () => {
    expect(getPreview("Read", { file_path: "file.txt" })).toBe("file.txt");
  });

  it("extracts pattern for Glob", () => {
    expect(getPreview("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("extracts pattern for Grep", () => {
    expect(getPreview("Grep", { pattern: "TODO|FIXME" })).toBe("TODO|FIXME");
  });

  it("extracts query for WebSearch", () => {
    expect(getPreview("WebSearch", { query: "react testing library" })).toBe("react testing library");
  });

  it("extracts query for Codex web_search input shape", () => {
    expect(
      getPreview("web_search", {
        search_query: [{ q: "github openai codex skills config.toml skills directories" }],
      }),
    ).toBe("github openai codex skills config.toml skills directories");
  });

  it("returns empty string for unknown tools", () => {
    expect(getPreview("UnknownTool", { some: "data" })).toBe("");
  });

  it("returns empty string for Bash without command", () => {
    expect(getPreview("Bash", { description: "something" })).toBe("");
  });

  it("returns empty string for Read without file_path", () => {
    expect(getPreview("Read", { content: "data" })).toBe("");
  });
});

// ─── ToolIcon ────────────────────────────────────────────────────────────────

describe("ToolIcon", () => {
  it("renders an SVG for terminal type", () => {
    const { container } = render(<ToolIcon type="terminal" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("polyline")).toBeTruthy();
  });

  it("renders an SVG for file type", () => {
    const { container } = render(<ToolIcon type="file" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("path")).toBeTruthy();
  });

  it("renders an SVG for search type", () => {
    const { container } = render(<ToolIcon type="search" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("circle")).toBeTruthy();
  });

  it("renders an SVG for globe type", () => {
    const { container } = render(<ToolIcon type="globe" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("circle")).toBeTruthy();
  });

  it("renders an SVG for message type", () => {
    const { container } = render(<ToolIcon type="message" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("renders an SVG for list type", () => {
    const { container } = render(<ToolIcon type="list" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("renders a default SVG for unknown type", () => {
    const { container } = render(<ToolIcon type="tool" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("path")).toBeTruthy();
  });
});

// ─── ToolBlock component ─────────────────────────────────────────────────────

describe("ToolBlock", () => {
  it("renders with correct label and preview", () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: "echo hello" }}
        toolUseId="tool-1"
      />
    );
    expect(screen.getByText("Terminal")).toBeTruthy();
    // Preview text appears in the header button area
    const previewSpan = screen.getByText("echo hello");
    expect(previewSpan).toBeTruthy();
    expect(previewSpan.className).toContain("truncate");
  });

  it("renders with label only when no preview is available", () => {
    render(
      <ToolBlock
        name="WebFetch"
        input={{ url: "https://example.com" }}
        toolUseId="tool-2"
      />
    );
    expect(screen.getByText("Web Fetch")).toBeTruthy();
  });

  it("is collapsed by default (does not show details)", () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: "ls -la" }}
        toolUseId="tool-3"
      />
    );
    // The expanded detail area should not be present
    expect(screen.queryByText("$")).toBeNull();
  });

  it("expands on click to show input details", () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: "ls -la" }}
        toolUseId="tool-4"
      />
    );

    // Click the button to expand
    const button = screen.getByRole("button");
    fireEvent.click(button);

    // After expanding, the detail area should be visible with a pre element
    const allLsLa = screen.getAllByText("ls -la");
    // One is the preview in the header, the other is in the expanded pre block
    expect(allLsLa.length).toBe(2);
    const preElement = allLsLa.find((el) => el.closest("pre"))?.closest("pre");
    expect(preElement).toBeTruthy();
  });

  it("collapses on second click", () => {
    const { container } = render(
      <ToolBlock
        name="Bash"
        input={{ command: "ls -la" }}
        toolUseId="tool-5"
      />
    );

    const button = screen.getByRole("button");

    // Expand - the detail area with the border-t class should appear
    fireEvent.click(button);
    expect(container.querySelector(".border-t")).toBeTruthy();

    // Collapse - the detail area should disappear
    fireEvent.click(button);
    expect(container.querySelector(".border-t")).toBeNull();
  });

  it("renders Bash command with $ prefix when expanded", () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: "npm install" }}
        toolUseId="tool-6"
      />
    );

    fireEvent.click(screen.getByRole("button"));

    // When expanded, the command appears in both the preview header and the code block.
    // Find the pre element containing the $ prefix.
    const allMatches = screen.getAllByText("npm install");
    const preElement = allMatches.find((el) => el.closest("pre"))?.closest("pre");
    expect(preElement).toBeTruthy();
    // Check the $ prefix is rendered as a span inside the pre
    const dollarSpan = preElement?.querySelector("span");
    expect(dollarSpan?.textContent).toBe("$ ");
  });

  it("renders Edit diff view when expanded", () => {
    const { container } = render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: "/home/user/src/app.ts",
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        }}
        toolUseId="tool-7"
      />
    );

    fireEvent.click(screen.getByRole("button"));

    // DiffViewer renders file header with basename
    expect(screen.getByText("app.ts")).toBeTruthy();
    // DiffViewer renders del/add lines
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
  });

  it("renders Edit diff from unified change patches when old/new strings are missing", () => {
    const { container } = render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: "/home/user/src/app.ts",
          changes: [
            {
              path: "/home/user/src/app.ts",
              kind: "modify",
              diff: [
                "diff --git a/src/app.ts b/src/app.ts",
                "--- a/src/app.ts",
                "+++ b/src/app.ts",
                "@@ -1 +1 @@",
                "-const x = 1;",
                "+const x = 2;",
              ].join("\n"),
            },
          ],
        }}
        toolUseId="tool-7b"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("app.ts")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
  });

  it("renders Edit diff when changes use unified_diff field", () => {
    const { container } = render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: "/home/user/src/app.ts",
          changes: [
            {
              path: "/home/user/src/app.ts",
              kind: "modify",
              unified_diff: [
                "diff --git a/src/app.ts b/src/app.ts",
                "--- a/src/app.ts",
                "+++ b/src/app.ts",
                "@@ -1 +1 @@",
                "-const x = 1;",
                "+const x = 3;",
              ].join("\n"),
            },
          ],
        }}
        toolUseId="tool-7u"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("app.ts")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
  });

  it("renders Edit diff for Codex headerless hunk patches", () => {
    const { container } = render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: "/home/user/src/app.ts",
          changes: [
            {
              path: "/home/user/src/app.ts",
              kind: "update",
              diff: [
                "@@ -1,3 +1,3 @@",
                " const a = 1;",
                "-const b = 2;",
                "+const b = 42;",
                " const c = 3;",
              ].join("\n"),
            },
          ],
        }}
        toolUseId="tool-7h"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("app.ts")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    expect(screen.queryByText("No changes")).toBeNull();
  });

  it("renders non-empty fallback summary for Edit changes without patch text", () => {
    render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: "/home/user/src/app.ts",
          changes: [{ path: "/home/user/src/app.ts", kind: "modify" }],
        }}
        toolUseId="tool-7c"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Applied changes")).toBeTruthy();
    expect(screen.getByText("modify: /home/user/src/app.ts")).toBeTruthy();
  });

  it("renders Read file path when expanded", () => {
    render(
      <ToolBlock
        name="Read"
        input={{ file_path: "/home/user/test.txt" }}
        toolUseId="tool-8"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("/home/user/test.txt")).toBeTruthy();
  });

  it("shows a 3-format copy menu for ExitPlanMode detail blocks", () => {
    render(
      <ToolBlock
        name="ExitPlanMode"
        input={{ plan: "## Plan title\n\n1. First step" }}
        toolUseId="tool-plan-copy"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByTitle("Copy plan"));
    expect(screen.getByText("Copy as Markdown")).toBeTruthy();
    expect(screen.getByText("Copy as Rich Text")).toBeTruthy();
    expect(screen.getByText("Copy as Plain Text")).toBeTruthy();
  });

  it("hides binary result dumps for Read image tool results", () => {
    const toolResults = new Map();
    const sessionResults = new Map();
    sessionResults.set("tool-image-2", {
      tool_use_id: "tool-image-2",
      content: "PNG binary bytes...",
      is_error: false,
      total_size: 4096,
      is_truncated: false,
      duration_seconds: 0.2,
    });
    toolResults.set("s-image", sessionResults);
    useStore.setState({ toolResults });

    render(
      <ToolBlock
        name="Read"
        input={{ file_path: "/home/user/screenshot.jpg" }}
        toolUseId="tool-image-2"
        sessionId="s-image"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Binary image output hidden.")).toBeTruthy();
    expect(screen.queryByText("PNG binary bytes...")).toBeNull();
    // Image preview appears only once (in Result section), avoiding duplicate thumbnails.
    expect(screen.getAllByRole("img").length).toBe(1);
    useStore.setState({ toolResults: new Map() });
  });

  it("shows image preview for Codex Bash reads that reference image file paths", () => {
    const toolResults = new Map();
    const sessionResults = new Map();
    sessionResults.set("tool-image-bash", {
      tool_use_id: "tool-image-bash",
      content: "binary image bytes",
      is_error: false,
      total_size: 8192,
      is_truncated: false,
      duration_seconds: 0.4,
    });
    toolResults.set("s-image-bash", sessionResults);
    useStore.setState({ toolResults });

    render(
      <ToolBlock
        name="Bash"
        input={{ command: "cat web/public/logo.png" }}
        toolUseId="tool-image-bash"
        sessionId="s-image-bash"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    const img = screen.getByRole("img", { name: "web/public/logo.png" });
    expect(img).toBeTruthy();
    expect(screen.getByText("Binary image output hidden.")).toBeTruthy();
    useStore.setState({ toolResults: new Map() });
  });

  it("renders JSON for unknown tools when expanded", () => {
    render(
      <ToolBlock
        name="CustomTool"
        input={{ foo: "bar", count: 42 }}
        toolUseId="tool-9"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    const preElement = document.querySelector("pre");
    expect(preElement?.textContent).toContain('"foo": "bar"');
    expect(preElement?.textContent).toContain('"count": 42');
  });

  it("renders live command output while Bash tool is in progress", () => {
    const toolProgress = new Map();
    const sessionProgress = new Map();
    sessionProgress.set("tu-live-output", {
      toolName: "Bash",
      elapsedSeconds: 12,
      output: "Merged 128/512 files\nMerged 256/512 files\n",
    });
    toolProgress.set("live-session", sessionProgress);
    useStore.setState({ toolProgress, toolResults: new Map() });

    render(
      <ToolBlock
        name="Bash"
        input={{ command: "python scripts/mix_dataset.py --chunks 512" }}
        toolUseId="tu-live-output"
        sessionId="live-session"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Live output")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText(/Merged 256\/512 files/)).toBeTruthy();

    useStore.setState({ toolProgress: new Map(), toolResults: new Map() });
  });

  it("shows waiting message when tool is running but has no output yet", () => {
    const toolProgress = new Map();
    const sessionProgress = new Map();
    sessionProgress.set("tu-live-empty", {
      toolName: "Bash",
      elapsedSeconds: 4,
    });
    toolProgress.set("live-session", sessionProgress);
    useStore.setState({ toolProgress, toolResults: new Map() });

    render(
      <ToolBlock
        name="Bash"
        input={{ command: "sleep 30" }}
        toolUseId="tu-live-empty"
        sessionId="live-session"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Waiting for command output...")).toBeTruthy();

    useStore.setState({ toolProgress: new Map(), toolResults: new Map() });
  });
});

// ─── formatDuration ─────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("returns '<0.1s' for sub-100ms durations", () => {
    expect(formatDuration(0.0)).toBe("<0.1s");
    expect(formatDuration(0.05)).toBe("<0.1s");
  });

  it("formats durations under 10s with one decimal", () => {
    expect(formatDuration(0.1)).toBe("0.1s");
    expect(formatDuration(0.3)).toBe("0.3s");
    expect(formatDuration(2.5)).toBe("2.5s");
    expect(formatDuration(9.9)).toBe("9.9s");
  });

  it("formats durations 10-59s as whole seconds", () => {
    expect(formatDuration(10)).toBe("10s");
    expect(formatDuration(45.3)).toBe("45s");
    expect(formatDuration(59)).toBe("59s");
  });

  it("formats durations >= 60s as minutes and seconds", () => {
    expect(formatDuration(60)).toBe("1m0s");
    expect(formatDuration(125)).toBe("2m5s");
    expect(formatDuration(3661)).toBe("61m1s");
  });
});

// ─── ToolBlock duration display ─────────────────────────────────────────────

describe("ToolBlock duration display", () => {
  afterEach(() => {
    // Clean up store state
    useStore.setState({ toolResults: new Map(), toolStartTimestamps: new Map(), toolProgress: new Map() });
  });

  it("shows final duration badge when tool result has duration_seconds", () => {
    // Set up mock tool result with duration (completed tool)
    const toolResults = new Map();
    const sessionResults = new Map();
    sessionResults.set("tu-dur-1", {
      tool_use_id: "tu-dur-1",
      content: "output",
      is_error: false,
      total_size: 6,
      is_truncated: false,
      duration_seconds: 5.2,
    });
    toolResults.set("test-session", sessionResults);
    useStore.setState({ toolResults });

    render(
      <ToolBlock
        name="Bash"
        input={{ command: "npm test" }}
        toolUseId="tu-dur-1"
        sessionId="test-session"
      />
    );

    // Should show the server-reported ground-truth duration
    expect(screen.getByText("5.2s")).toBeTruthy();
    // Final duration uses muted color, not primary
    const badge = screen.getByText("5.2s");
    expect(badge.className).toContain("text-cc-muted");
  });

  it("shows live timer when start timestamp exists but no final duration", () => {
    // Set up a start timestamp 3 seconds ago (simulating a running tool)
    const toolStartTimestamps = new Map();
    const sessionTimestamps = new Map();
    sessionTimestamps.set("tu-live", Date.now() - 3000);
    toolStartTimestamps.set("test-session", sessionTimestamps);
    useStore.setState({ toolStartTimestamps });

    render(
      <ToolBlock
        name="Bash"
        input={{ command: "npm test" }}
        toolUseId="tu-live"
        sessionId="test-session"
      />
    );

    // Should show a live timer badge with primary color (indicating in-progress)
    const badge = document.querySelector(".tabular-nums");
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain("text-cc-primary");
    // The displayed value should be approximately 3 seconds
    const text = badge!.textContent!;
    expect(text).toMatch(/\d+\.\ds/);
  });

  it("does not show duration badge when neither duration nor start timestamp exists", () => {
    // Tool result without duration and no start timestamp (pre-feature data)
    const toolResults = new Map();
    const sessionResults = new Map();
    sessionResults.set("tu-no-dur", {
      tool_use_id: "tu-no-dur",
      content: "output",
      is_error: false,
      total_size: 6,
      is_truncated: false,
    });
    toolResults.set("test-session", sessionResults);
    useStore.setState({ toolResults });

    const { container } = render(
      <ToolBlock
        name="Bash"
        input={{ command: "echo hi" }}
        toolUseId="tu-no-dur"
        sessionId="test-session"
      />
    );

    // No tabular-nums span (duration badge) should exist
    const durationBadge = container.querySelector(".tabular-nums");
    expect(durationBadge).toBeNull();
  });

  it("falls back to tool_progress elapsed seconds when start timestamp is missing", () => {
    const toolProgress = new Map();
    const sessionProgress = new Map();
    sessionProgress.set("tu-progress-fallback", {
      toolName: "Bash",
      elapsedSeconds: 7,
    });
    toolProgress.set("test-session", sessionProgress);
    useStore.setState({ toolProgress });

    render(
      <ToolBlock
        name="Bash"
        input={{ command: "npm run build" }}
        toolUseId="tu-progress-fallback"
        sessionId="test-session"
      />
    );

    const badge = screen.getByText("7.0s");
    expect(badge.className).toContain("text-cc-primary");
  });

  it("does not show live timer when tool has completed but duration_seconds is missing", () => {
    // This reproduces the bug: server restarted mid-tool, lost transient start time,
    // so tool_result_preview has no duration_seconds. But the assistant message in
    // history still has tool_start_times. Without the fix, the live timer would
    // count forever from the original start timestamp.
    const toolResults = new Map();
    const sessionResults = new Map();
    sessionResults.set("tu-restart", {
      tool_use_id: "tu-restart",
      content: "done",
      is_error: false,
      total_size: 4,
      is_truncated: false,
      // duration_seconds intentionally omitted — server lost start time on restart
    });
    toolResults.set("test-session", sessionResults);

    const toolStartTimestamps = new Map();
    const sessionTimestamps = new Map();
    sessionTimestamps.set("tu-restart", Date.now() - 600_000); // 10 minutes ago
    toolStartTimestamps.set("test-session", sessionTimestamps);

    useStore.setState({ toolResults, toolStartTimestamps });

    const { container } = render(
      <ToolBlock
        name="Bash"
        input={{ command: "sleep 3" }}
        toolUseId="tu-restart"
        sessionId="test-session"
      />
    );

    // Should NOT show a live timer (no tabular-nums badge at all)
    const badge = container.querySelector(".tabular-nums");
    expect(badge).toBeNull();
  });

  it("does not show duration badge without sessionId", () => {
    const { container } = render(
      <ToolBlock
        name="Bash"
        input={{ command: "echo hi" }}
        toolUseId="tu-no-session"
      />
    );

    const durationBadge = container.querySelector(".tabular-nums");
    expect(durationBadge).toBeNull();
  });
});

// Regression: Codex web search was showing the query text as the "RESULT",
// because the adapter returned the query when no structured results existed.
// The ToolBlock should suppress the result section when it just echoes the query.
describe("WebSearch result suppression", () => {
  afterEach(() => {
    useStore.setState({ toolResults: new Map() });
  });

  it("hides RESULT section when content matches the search query", () => {
    const toolResults = new Map();
    const sessionResults = new Map();
    sessionResults.set("ws-echo", {
      tool_use_id: "ws-echo",
      content: "Codex CLI skills documentation",
      is_error: false,
      total_size: 32,
      is_truncated: false,
    });
    toolResults.set("s-ws", sessionResults);
    useStore.setState({ toolResults });

    render(
      <ToolBlock
        name="WebSearch"
        input={{ query: "Codex CLI skills documentation" }}
        toolUseId="ws-echo"
        sessionId="s-ws"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    // The query appears in both the preview and the WebSearchDetail section
    expect(screen.getAllByText("Codex CLI skills documentation").length).toBeGreaterThanOrEqual(1);
    // But NOT in a "Result" label — the result section should be suppressed
    expect(screen.queryByText("Result")).toBeNull();
  });

  it("hides RESULT section for generic 'Web search completed' placeholder", () => {
    const toolResults = new Map();
    const sessionResults = new Map();
    sessionResults.set("ws-placeholder", {
      tool_use_id: "ws-placeholder",
      content: "Web search completed",
      is_error: false,
      total_size: 20,
      is_truncated: false,
    });
    toolResults.set("s-ws2", sessionResults);
    useStore.setState({ toolResults });

    render(
      <ToolBlock
        name="WebSearch"
        input={{ query: "react hooks best practices" }}
        toolUseId="ws-placeholder"
        sessionId="s-ws2"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("Result")).toBeNull();
  });

  it("shows RESULT section when web search has meaningful results", () => {
    const toolResults = new Map();
    const sessionResults = new Map();
    sessionResults.set("ws-real", {
      tool_use_id: "ws-real",
      content: "React Hooks API Reference\nhttps://react.dev/reference/react/hooks\nA comprehensive guide to React hooks...",
      is_error: false,
      total_size: 100,
      is_truncated: false,
    });
    toolResults.set("s-ws3", sessionResults);
    useStore.setState({ toolResults });

    render(
      <ToolBlock
        name="WebSearch"
        input={{ query: "react hooks" }}
        toolUseId="ws-real"
        sessionId="s-ws3"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    // Meaningful results should show the Result section
    expect(screen.getByText("Result")).toBeTruthy();
  });
});
