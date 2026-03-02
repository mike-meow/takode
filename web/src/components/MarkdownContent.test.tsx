// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkdownContent } from "./MarkdownContent.js";
import { useStore } from "../store.js";

describe("MarkdownContent quest links", () => {
  beforeEach(() => {
    window.location.hash = "#/session/s1";
    useStore.getState().reset();
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
});
