// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useStore } from "../store.js";

const mockGetSettings = vi.fn();
const mockOpenVsCodeRemoteFile = vi.fn();
const mockReadFile = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    openVsCodeRemoteFile: (...args: unknown[]) => mockOpenVsCodeRemoteFile(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
}));

import { MarkdownContent } from "./MarkdownContent.js";

describe("MarkdownContent line breaks", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("renders visible line breaks for single newlines inside a paragraph", () => {
    // Validates the shared renderer respects soft line breaks for normal prose.
    const { container } = render(<MarkdownContent text={"First line\nSecond line"} />);

    const paragraph = container.querySelector("p");
    expect(paragraph).toBeTruthy();
    expect(paragraph?.querySelector("br")).toBeTruthy();
    expect(paragraph?.textContent).toBe("First line\nSecond line");
  });

  it("keeps markdown lists structured as lists while allowing soft breaks in list items", () => {
    // Guards against the newline fix flattening list syntax into plain paragraphs.
    const { container } = render(<MarkdownContent text={"Agenda:\n- first item\n- second item"} />);

    expect(screen.getByText("Agenda:")).toBeTruthy();
    const list = screen.getByRole("list");
    expect(list).toBeTruthy();
    expect(screen.getByText("first item")).toBeTruthy();
    expect(screen.getByText("second item")).toBeTruthy();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("preserves fenced code blocks while adding breaks only to surrounding prose", () => {
    // Ensures fenced code keeps raw newlines instead of being transformed into <br> tags.
    const { container } = render(
      <MarkdownContent text={"Summary line\nFollow-up line\n\n```ts\nconst x = 1;\nconst y = 2;\n```"} />,
    );

    const paragraph = container.querySelector("p");
    const code = container.querySelector("pre code");

    expect(paragraph?.querySelector("br")).toBeTruthy();
    expect(code?.querySelector("br")).toBeNull();
    expect(code?.textContent).toContain("const x = 1;\nconst y = 2;");
  });
});

describe("MarkdownContent quest links", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    window.location.hash = "#/session/s1";
    useStore.getState().reset();
    mockGetSettings.mockReset();
    mockOpenVsCodeRemoteFile.mockReset();
    mockReadFile.mockReset();
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "none" } });
    mockReadFile.mockResolvedValue({ path: "/tmp/file", content: "" });
  });

  it("opens quest links as overlay on the current route", () => {
    render(<MarkdownContent text="[q-42](quest:q-42)" />);

    const link = screen.getByRole("link", { name: "q-42" });
    // href is still set for right-click "open in new tab"
    expect(link.getAttribute("href")).toBe("#/session/s1?quest=q-42");
    fireEvent.click(link);
    // Click opens the quest overlay instead of changing the hash
    expect(useStore.getState().questOverlayId).toBe("q-42");
    // Hash should NOT have changed (stays on current session)
    expect(window.location.hash).toBe("#/session/s1");
  });

  it("supports bare quest-id hrefs as a short schema", () => {
    render(<MarkdownContent text="[open](q-77)" />);

    const link = screen.getByRole("link", { name: "open" });
    expect(link.getAttribute("href")).toBe("#/session/s1?quest=q-77");
    fireEvent.click(link);
    // Click opens the quest overlay instead of changing the hash
    expect(useStore.getState().questOverlayId).toBe("q-77");
    expect(window.location.hash).toBe("#/session/s1");
  });

  it("shows QuestHoverCard content when hovering a quest link", async () => {
    useStore.setState((state) => ({
      ...state,
      quests: [
        {
          id: "q-42-v1",
          questId: "q-42",
          version: 1,
          title: "Fix auth race condition",
          createdAt: 1,
          status: "in_progress",
          description: "Ensure claim state updates atomically.",
          sessionId: "session-abc",
          claimedAt: 1,
          tags: ["ui", "bugfix"],
        },
      ],
    }));

    render(<MarkdownContent text="[q-42](quest:q-42)" />);
    fireEvent.mouseEnter(screen.getByRole("link", { name: "q-42" }));

    expect(await screen.findByText("Fix auth race condition")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();
    expect(screen.getByText("ui")).toBeTruthy();
    expect(screen.getByText("bugfix")).toBeTruthy();
  });

  it("keeps external links as normal web links", () => {
    render(<MarkdownContent text="[docs](https://example.com)" />);

    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("routes session: schema links to the referenced session hash", () => {
    useStore.setState((state) => ({
      ...state,
      sdkSessions: [
        {
          sessionId: "session-abc",
          state: "connected",
          cwd: "/repo",
          createdAt: 1,
          sessionNum: 123,
        },
      ],
    }));

    render(<MarkdownContent text="[#123](session:123)" />);

    const link = screen.getByRole("link", { name: "#123" });
    expect(link.getAttribute("href")).toBe("#/session/session-abc");
    fireEvent.click(link);
    expect(window.location.hash).toBe("#/session/session-abc");
  });

  it("routes session:N:M message-level links with msg query param in href", () => {
    useStore.setState((state) => ({
      ...state,
      sdkSessions: [
        {
          sessionId: "session-abc",
          state: "connected",
          cwd: "/repo",
          createdAt: 1,
          sessionNum: 123,
        },
      ],
    }));

    render(<MarkdownContent text="[#123 msg 42](session:123:42)" />);

    const link = screen.getByRole("link", { name: "#123 msg 42" });
    // Href should include ?msg= query param for right-click "open in new tab" support
    expect(link.getAttribute("href")).toBe("#/session/session-abc?msg=42");
    expect(link.getAttribute("title")).toBe("Open session #123, message 42");
  });

  it("shows SessionHoverCard content when hovering a session link", async () => {
    useStore.setState((state) => ({
      ...state,
      sdkSessions: [
        {
          sessionId: "session-abc",
          state: "connected",
          cwd: "/repo",
          createdAt: 1,
          sessionNum: 123,
        },
      ],
      sessionNames: new Map([["session-abc", "Auth Worker"]]),
    }));

    render(<MarkdownContent text="[#123](session:123)" />);
    fireEvent.mouseEnter(screen.getByRole("link", { name: "#123" }));

    expect(await screen.findByText("Auth Worker")).toBeTruthy();
  });

  it("opens file: links in VS Code using configured editor preference", async () => {
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-local" } });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<MarkdownContent text="[app.ts](file:/tmp/project/app.ts:42)" />);
    fireEvent.click(screen.getByRole("link", { name: "app.ts" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith("vscode://file//tmp/project/app.ts:42:1", "_blank", "noopener,noreferrer");
    });
    openSpy.mockRestore();
  });

  it("opens file: line-range links at the range start for local VS Code URIs", async () => {
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-local" } });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<MarkdownContent text="[CLAUDE.md:53-54](file:/tmp/project/CLAUDE.md:53-54)" />);
    fireEvent.click(screen.getByRole("link", { name: "CLAUDE.md:53-54" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "vscode://file//tmp/project/CLAUDE.md:53:1",
        "_blank",
        "noopener,noreferrer",
      );
    });
    openSpy.mockRestore();
  });

  it("resolves repo-root-relative file: links against the active session repo root", async () => {
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-local" } });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    useStore.setState((state) => ({
      ...state,
      currentSessionId: "s1",
      sessions: new Map([
        [
          "s1",
          {
            session_id: "s1",
            cwd: "/repo",
            repo_root: "/repo",
          } as never,
        ],
      ]),
    }));

    render(<MarkdownContent text="[TopBar.tsx](file:web/src/components/TopBar.tsx:162)" />);
    fireEvent.click(screen.getByRole("link", { name: "TopBar.tsx" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "vscode://file//repo/web/src/components/TopBar.tsx:162:1",
        "_blank",
        "noopener,noreferrer",
      );
    });
    openSpy.mockRestore();
  });

  it("resolves relative file: links against the worktree root for worktree sessions", async () => {
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-local" } });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    useStore.setState((state) => ({
      ...state,
      currentSessionId: "s1",
      sessions: new Map([
        [
          "s1",
          {
            session_id: "s1",
            cwd: "/worktrees/repo-branch",
            repo_root: "/repo",
            is_worktree: true,
          } as never,
        ],
      ]),
    }));

    render(<MarkdownContent text="[TopBar.tsx](file:web/src/components/TopBar.tsx:162)" />);
    fireEvent.click(screen.getByRole("link", { name: "TopBar.tsx" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "vscode://file//worktrees/repo-branch/web/src/components/TopBar.tsx:162:1",
        "_blank",
        "noopener,noreferrer",
      );
    });
    openSpy.mockRestore();
  });

  it("remaps stale absolute worktree file links to the current worktree root", async () => {
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-local" } });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    useStore.setState((state) => ({
      ...state,
      currentSessionId: "s1",
      sessions: new Map([
        [
          "s1",
          {
            session_id: "s1",
            cwd: "/Users/yuege/.companion/worktrees/openai/master-wt-9326",
            repo_root: "/Users/yuege/code/openai",
            is_worktree: true,
          } as never,
        ],
      ]),
    }));

    render(
      <MarkdownContent text="[datasets.py](file:/Users/yuege/.companion/worktrees/openai/master-wt-7257/project/vs2s/audio_perception_asr/audio_perception_asr/datasets.py:1:1)" />,
    );
    fireEvent.click(screen.getByRole("link", { name: "datasets.py" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "vscode://file//Users/yuege/code/openai/project/vs2s/audio_perception_asr/audio_perception_asr/datasets.py:1:1",
        "_blank",
        "noopener,noreferrer",
      );
    });
    openSpy.mockRestore();
  });

  it("does not launch an editor for file: links when editor preference is none", async () => {
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "none" } });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<MarkdownContent text="[app.ts](file:/tmp/project/app.ts:7:3)" />);
    fireEvent.click(screen.getByRole("link", { name: "app.ts" }));

    await waitFor(() => {
      expect(mockGetSettings).toHaveBeenCalledTimes(1);
    });
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("routes file links through the authoritative remote VSCode path when configured", async () => {
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-remote" } });
    mockOpenVsCodeRemoteFile.mockResolvedValue({ ok: true, sourceId: "window-a", commandId: "cmd-1" });

    render(<MarkdownContent text="[app.ts](file:/tmp/project/app.ts:7:3)" />);
    fireEvent.click(screen.getByRole("link", { name: "app.ts" }));

    await waitFor(() => {
      expect(mockOpenVsCodeRemoteFile).toHaveBeenCalledWith({
        absolutePath: "/tmp/project/app.ts",
        line: 7,
        column: 3,
      });
    });
  });

  it("routes file line ranges through the authoritative remote VSCode path", async () => {
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-remote" } });
    mockOpenVsCodeRemoteFile.mockResolvedValue({ ok: true, sourceId: "window-a", commandId: "cmd-range" });

    render(<MarkdownContent text="[CLAUDE.md:53-54](file:/tmp/project/CLAUDE.md:53-54)" />);
    fireEvent.click(screen.getByRole("link", { name: "CLAUDE.md:53-54" }));

    await waitFor(() => {
      expect(mockOpenVsCodeRemoteFile).toHaveBeenCalledWith({
        absolutePath: "/tmp/project/CLAUDE.md",
        line: 53,
        column: 1,
        endLine: 54,
      });
    });
  });

  it("routes repo-root-relative file links through the authoritative remote VSCode path", async () => {
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-remote" } });
    mockOpenVsCodeRemoteFile.mockResolvedValue({ ok: true, sourceId: "window-a", commandId: "cmd-2" });

    useStore.setState((state) => ({
      ...state,
      currentSessionId: "s1",
      sessions: new Map([
        [
          "s1",
          {
            session_id: "s1",
            cwd: "/repo",
            repo_root: "/repo",
          } as never,
        ],
      ]),
    }));

    render(<MarkdownContent text="[TopBar.tsx](file:web/src/components/TopBar.tsx:162:4)" />);
    fireEvent.click(screen.getByRole("link", { name: "TopBar.tsx" }));

    await waitFor(() => {
      expect(mockOpenVsCodeRemoteFile).toHaveBeenCalledWith({
        absolutePath: "/repo/web/src/components/TopBar.tsx",
        line: 162,
        column: 4,
      });
    });
  });

  it("routes worktree file links through the authoritative remote VSCode path using the worktree root", async () => {
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-remote" } });
    mockOpenVsCodeRemoteFile.mockResolvedValue({ ok: true, sourceId: "window-a", commandId: "cmd-worktree" });

    useStore.setState((state) => ({
      ...state,
      currentSessionId: "s1",
      sessions: new Map([
        [
          "s1",
          {
            session_id: "s1",
            cwd: "/worktrees/repo-branch",
            repo_root: "/repo",
            is_worktree: true,
          } as never,
        ],
      ]),
    }));

    render(<MarkdownContent text="[TopBar.tsx](file:web/src/components/TopBar.tsx:162:4)" />);
    fireEvent.click(screen.getByRole("link", { name: "TopBar.tsx" }));

    await waitFor(() => {
      expect(mockOpenVsCodeRemoteFile).toHaveBeenCalledWith({
        absolutePath: "/worktrees/repo-branch/web/src/components/TopBar.tsx",
        line: 162,
        column: 4,
      });
    });
  });

  it("routes stale absolute worktree links through remote VSCode using the current worktree root", async () => {
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-remote" } });
    mockOpenVsCodeRemoteFile.mockResolvedValue({ ok: true, sourceId: "window-a", commandId: "cmd-stale-worktree" });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    useStore.setState((state) => ({
      ...state,
      currentSessionId: "s1",
      sessions: new Map([
        [
          "s1",
          {
            session_id: "s1",
            cwd: "/Users/yuege/.companion/worktrees/openai/master-wt-9326",
            repo_root: "/Users/yuege/code/openai",
            is_worktree: true,
          } as never,
        ],
      ]),
    }));

    render(
      <MarkdownContent text="[datasets.py](file:/Users/yuege/.companion/worktrees/openai/master-wt-7257/project/vs2s/audio_perception_asr/audio_perception_asr/datasets.py:1:1)" />,
    );
    fireEvent.click(screen.getByRole("link", { name: "datasets.py" }));

    await waitFor(() => {
      expect(mockOpenVsCodeRemoteFile).toHaveBeenCalledWith({
        absolutePath: "/Users/yuege/code/openai/project/vs2s/audio_perception_asr/audio_perception_asr/datasets.py",
        line: 1,
        column: 1,
      });
    });
  });

  it("shows the remote VSCode error when the server reports no running VSCode window", async () => {
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode-remote" } });
    mockOpenVsCodeRemoteFile.mockRejectedValue(new Error("No running VSCode was detected on this machine."));
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    render(<MarkdownContent text="[app.ts](file:/tmp/project/app.ts:7:3)" />);
    fireEvent.click(screen.getByRole("link", { name: "app.ts" }));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith("No running VSCode was detected on this machine.");
    });
    alertSpy.mockRestore();
  });
});
