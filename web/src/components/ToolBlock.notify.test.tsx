// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolBlock } from "./ToolBlock.js";
import { useStore } from "../store.js";
import { api } from "../api.js";

vi.mock("../api.js", () => ({
  api: {
    getSettings: vi.fn(),
    getToolResult: vi.fn(),
    getFsImageUrl: vi.fn((path: string) => `/api/fs/image?path=${encodeURIComponent(path)}`),
    openVsCodeRemoteFile: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(api.getSettings).mockReset();
  vi.mocked(api.getToolResult).mockReset();
  vi.mocked(api.openVsCodeRemoteFile).mockReset();
  vi.mocked(api.getSettings).mockResolvedValue({ editorConfig: { editor: "vscode-local" } } as Awaited<
    ReturnType<typeof api.getSettings>
  >);
  useStore.setState({ sessionNotifications: new Map(), toolResults: new Map(), latestBoardToolUseId: new Map() });
});

describe("ToolBlock takode notify rendering", () => {
  it("does not render a notification chip when takode notify text is only quoted inside another command", () => {
    // Regression for q-325: leader-side Bash commands like `takode send ...`
    // can quote the literal text `takode notify review` inside their message
    // body, but that should still render as a normal tool row.
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'takode send 17 "If this looks good, later run takode notify review"' }}
        toolUseId="tool-notify-quoted"
      />,
    );

    expect(screen.getByText(/takode send 17 "If this looks good, later run takode notify/)).toBeTruthy();
    expect(screen.queryByText("Ready for review")).toBeNull();
    expect(screen.queryByText("Needs input")).toBeNull();
  });

  it("does not render a notification chip when takode notify text is embedded in another top-level command", () => {
    // The parser should only match a real top-level `takode notify` command.
    // Other commands that merely echo or mention that text must remain normal
    // Bash tool rows.
    render(<ToolBlock name="Bash" input={{ command: "echo takode notify review" }} toolUseId="tool-notify-embedded" />);

    expect(screen.getByText("echo takode notify review")).toBeTruthy();
    expect(screen.queryByText("Ready for review")).toBeNull();
    expect(screen.queryByText("Needs input")).toBeNull();
  });

  it("keeps the review notification fallback for actual takode notify review commands", () => {
    // q-568 relies on review commands showing an immediate inline marker before
    // the authoritative notification inbox has hydrated.
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'TAKODE_API_PORT=3455 takode notify review "q-325 ready"' }}
        toolUseId="tool-notify-real"
        sessionId="review-session"
        parentMessageId="asst-review-tool"
      />,
    );

    expect(screen.getByText("Ready for review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark as reviewed" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders actual takode notify needs-input commands as normal Bash rows", () => {
    // q-1013: the generated notification card carries needs-input content and
    // actions, so the command itself should stay a normal command chip.
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'TAKODE_API_PORT=3455 takode notify needs-input "Need a decision"' }}
        toolUseId="tool-notify-needs-input"
        sessionId="needs-input-session"
        parentMessageId="asst-needs-input-tool"
      />,
    );

    expect(screen.getByText(/TAKODE_API_PORT=3455 takode notify needs-input/)).toBeTruthy();
    expect(screen.queryByText("Needs input")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark handled" })).toBeNull();
  });

  it("keeps needs-input notify commands normal even when a matching notification exists", () => {
    // The authoritative needs-input marker is rendered by MessageBubble from
    // message metadata or inbox anchors, not by ToolBlock's command fallback.
    const sessionNotifications = new Map(useStore.getState().sessionNotifications);
    sessionNotifications.set("needs-input-session", [
      {
        id: "n-needs-input-done",
        category: "needs-input",
        timestamp: Date.now(),
        messageId: "asst-needs-input-done",
        summary: "Need a decision",
        done: true,
      },
    ]);
    useStore.setState({ sessionNotifications });

    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'TAKODE_API_PORT=3455 takode notify needs-input "Need a decision"' }}
        toolUseId="tool-notify-done"
        sessionId="needs-input-session"
        parentMessageId="asst-needs-input-done"
      />,
    );

    expect(screen.getByText(/TAKODE_API_PORT=3455 takode notify needs-input/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark unhandled" })).toBeNull();
    expect(screen.queryByText("Needs input")).toBeNull();
  });

  it("uses the anchored store summary for a lagged takode notify review marker", () => {
    // q-568: if the inbox notification is already anchored to this message
    // before `msg.notification` lands, ToolBlock should still surface the rich
    // review summary instead of a generic placeholder.
    const sessionNotifications = new Map(useStore.getState().sessionNotifications);
    sessionNotifications.set("review-session", [
      {
        id: "n-review-lagged",
        category: "review",
        timestamp: Date.now(),
        messageId: "asst-review-lagged",
        summary: "q-568 single rich chip",
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications });

    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'TAKODE_API_PORT=3455 takode notify review "q-568 single rich chip"' }}
        toolUseId="tool-notify-lagged"
        sessionId="review-session"
        parentMessageId="asst-review-lagged"
      />,
    );

    expect(screen.getByText("q-568 single rich chip")).toBeTruthy();
    expect(screen.queryByText("Ready for review")).toBeNull();
  });
});
