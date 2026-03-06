// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useStore } from "../store.js";

const mockGetSettings = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
  },
}));

import { MarkdownContent } from "./MarkdownContent.js";

describe("MarkdownContent quest links", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    window.location.hash = "#/session/s1";
    useStore.getState().reset();
    mockGetSettings.mockReset();
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "none" } });
  });

  it("opens quest links as overlay on the current route", () => {
    render(<MarkdownContent text="[q-42](quest:q-42)" />);

    const link = screen.getByRole("link", { name: "q-42" });
    expect(link.getAttribute("href")).toBe("#/session/s1?quest=q-42");
    fireEvent.click(link);
    expect(window.location.hash).toBe("#/session/s1?quest=q-42");
  });

  it("supports bare quest-id hrefs as a short schema", () => {
    render(<MarkdownContent text="[open](q-77)" />);

    const link = screen.getByRole("link", { name: "open" });
    expect(link.getAttribute("href")).toBe("#/session/s1?quest=q-77");
    fireEvent.click(link);
    expect(window.location.hash).toBe("#/session/s1?quest=q-77");
  });

  it("shows QuestHoverCard content when hovering a quest link", async () => {
    useStore.setState((state) => ({
      ...state,
      quests: [{
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
      }],
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
      sdkSessions: [{
        sessionId: "session-abc",
        state: "connected",
        cwd: "/repo",
        createdAt: 1,
        sessionNum: 123,
      }],
    }));

    render(<MarkdownContent text="[#123](session:123)" />);

    const link = screen.getByRole("link", { name: "#123" });
    expect(link.getAttribute("href")).toBe("#/session/session-abc");
    fireEvent.click(link);
    expect(window.location.hash).toBe("#/session/session-abc");
  });

  it("shows SessionHoverCard content when hovering a session link", async () => {
    useStore.setState((state) => ({
      ...state,
      sdkSessions: [{
        sessionId: "session-abc",
        state: "connected",
        cwd: "/repo",
        createdAt: 1,
        sessionNum: 123,
      }],
      sessionNames: new Map([["session-abc", "Auth Worker"]]),
    }));

    render(<MarkdownContent text="[#123](session:123)" />);
    fireEvent.mouseEnter(screen.getByRole("link", { name: "#123" }));

    expect(await screen.findByText("Auth Worker")).toBeTruthy();
  });

  it("opens file: links in VS Code using configured editor preference", async () => {
    mockGetSettings.mockResolvedValue({ editorConfig: { editor: "vscode" } });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<MarkdownContent text="[app.ts](file:/tmp/project/app.ts:42)" />);
    fireEvent.click(screen.getByRole("link", { name: "app.ts" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "vscode://file//tmp/project/app.ts:42:1",
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

  it("routes file links through the VS Code embed bridge when running inside the panel", () => {
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    const postMessageSpy = vi.spyOn(window.parent, "postMessage");

    render(<MarkdownContent text="[app.ts](file:/tmp/project/app.ts:7:3)" />);
    fireEvent.click(screen.getByRole("link", { name: "app.ts" }));

    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        source: "takode-vscode-prototype",
        type: "takode:open-file",
        payload: {
          absolutePath: "/tmp/project/app.ts",
          line: 7,
          column: 3,
        },
      },
      "*",
    );
    expect(mockGetSettings).not.toHaveBeenCalled();
    postMessageSpy.mockRestore();
  });
});
