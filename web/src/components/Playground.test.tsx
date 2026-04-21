// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";

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

describe("Playground", () => {
  it("renders the real chat stack section with integrated chat components", () => {
    render(<Playground />);

    expect(screen.getByText("Component Playground")).toBeTruthy();
    expect(screen.getByText("Real Chat Stack")).toBeTruthy();
    expect(screen.getByText("Timer Messages")).toBeTruthy();
    expect(screen.getByText("Pending local upload bubble")).toBeTruthy();

    const realChat = screen.getByTestId("playground-real-chat-stack");
    expect(realChat).toBeTruthy();
    expect(within(realChat).getAllByText(/ChatView|MessageFeed/).length).toBeGreaterThan(0);
  });
});
