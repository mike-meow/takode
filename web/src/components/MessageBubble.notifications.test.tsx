// @vitest-environment jsdom
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChatMessage } from "../types.js";

const revertToMessageMock = vi.hoisted(() => vi.fn(async () => ({})));
const markNotificationDoneMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../api.js", () => ({
  api: {
    revertToMessage: revertToMessageMock,
    markNotificationDone: markNotificationDoneMock,
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

import { MessageBubble, NotificationMarker } from "./MessageBubble.js";
import { useStore } from "../store.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("MessageBubble notification markers", () => {
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

  it("prefills a suggested answer while replying to the exact needs-input notification", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const prevDrafts = useStore.getState().composerDrafts;
    const prevReplyContexts = useStore.getState().replyContexts;
    const prevFocusTrigger = useStore.getState().focusComposerTrigger;
    const notifications = new Map(prevNotifications);
    notifications.set("notify-session", [
      {
        id: "n-17",
        category: "needs-input",
        summary: "Deploy now?",
        suggestedAnswers: ["yes", "no"],
        timestamp: Date.now(),
        messageId: "asst-notify",
        done: false,
      },
    ]);
    const drafts = new Map(prevDrafts);
    drafts.set("notify-session", {
      text: "existing draft",
      images: [{ id: "img-1", name: "keep.png", base64: "abc", mediaType: "image/png", status: "ready" }],
    });
    useStore.setState({ sessionNotifications: notifications, composerDrafts: drafts });

    try {
      render(
        <NotificationMarker
          category="needs-input"
          summary="Deploy now?"
          sessionId="notify-session"
          messageId="asst-notify"
          notificationId="n-17"
        />,
      );

      const actionRow = screen.getByTestId("notification-answer-actions");
      expect(actionRow.contains(screen.getByRole("button", { name: "Use suggested answer: yes" }))).toBe(true);
      expect(actionRow.contains(screen.getByRole("button", { name: "Custom answer" }))).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Use suggested answer: yes" }));

      expect(useStore.getState().replyContexts.get("notify-session")).toEqual({
        messageId: "asst-notify",
        notificationId: "n-17",
        previewText: "Deploy now?",
      });
      expect(useStore.getState().composerDrafts.get("notify-session")).toMatchObject({
        text: "yes",
        images: [{ id: "img-1" }],
      });
      expect(useStore.getState().focusComposerTrigger).toBe(prevFocusTrigger + 1);
    } finally {
      useStore.setState({
        sessionNotifications: prevNotifications,
        composerDrafts: prevDrafts,
        replyContexts: prevReplyContexts,
        focusComposerTrigger: prevFocusTrigger,
      });
    }
  });

  it("uses notification metadata IDs through the real assistant message path", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const prevDrafts = useStore.getState().composerDrafts;
    const prevReplyContexts = useStore.getState().replyContexts;
    const notifications = new Map(prevNotifications);
    notifications.set("notify-session", [
      {
        id: "n-1",
        category: "needs-input",
        summary: "First prompt",
        suggestedAnswers: ["wrong"],
        timestamp: Date.now(),
        messageId: "asst-shared-anchor",
        done: false,
      },
      {
        id: "n-2",
        category: "needs-input",
        summary: "Second prompt",
        suggestedAnswers: ["ship", "hold"],
        timestamp: Date.now(),
        messageId: "asst-shared-anchor",
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: notifications });

    try {
      const msg = makeMessage({
        id: "asst-shared-anchor",
        role: "assistant",
        content: "I need one more decision.",
        notification: {
          id: "n-2",
          category: "needs-input",
          timestamp: Date.now(),
          summary: "Second prompt",
          suggestedAnswers: ["ship", "hold"],
        },
      });

      render(<MessageBubble message={msg} sessionId="notify-session" />);
      fireEvent.click(screen.getByRole("button", { name: "Use suggested answer: ship" }));

      expect(useStore.getState().replyContexts.get("notify-session")).toEqual({
        messageId: "asst-shared-anchor",
        notificationId: "n-2",
        previewText: "Second prompt",
      });
      expect(useStore.getState().composerDrafts.get("notify-session")).toMatchObject({ text: "ship" });
    } finally {
      useStore.setState({
        sessionNotifications: prevNotifications,
        composerDrafts: prevDrafts,
        replyContexts: prevReplyContexts,
      });
    }
  });

  it("uses the custom answer action without replacing the existing draft", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const prevDrafts = useStore.getState().composerDrafts;
    const prevReplyContexts = useStore.getState().replyContexts;
    const notifications = new Map(prevNotifications);
    notifications.set("notify-session", [
      {
        id: "n-18",
        category: "needs-input",
        summary: "Choose rollout mode",
        suggestedAnswers: ["fast", "slow"],
        timestamp: Date.now(),
        messageId: "asst-notify",
        done: false,
      },
    ]);
    const drafts = new Map(prevDrafts);
    drafts.set("notify-session", { text: "keep this text", images: [] });
    useStore.setState({ sessionNotifications: notifications, composerDrafts: drafts });

    try {
      render(
        <NotificationMarker
          category="needs-input"
          summary="Choose rollout mode"
          sessionId="notify-session"
          messageId="asst-notify"
          notificationId="n-18"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Custom answer" }));

      expect(useStore.getState().replyContexts.get("notify-session")).toMatchObject({
        messageId: "asst-notify",
        notificationId: "n-18",
      });
      expect(useStore.getState().composerDrafts.get("notify-session")?.text).toBe("keep this text");
    } finally {
      useStore.setState({
        sessionNotifications: prevNotifications,
        composerDrafts: prevDrafts,
        replyContexts: prevReplyContexts,
      });
    }
  });

  it("hides answer actions for addressed needs-input notifications", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const notifications = new Map(prevNotifications);
    notifications.set("notify-session", [
      {
        id: "n-19",
        category: "needs-input",
        summary: "Deploy now?",
        suggestedAnswers: ["yes", "no"],
        timestamp: Date.now(),
        messageId: "asst-notify",
        done: true,
      },
    ]);
    useStore.setState({ sessionNotifications: notifications });

    try {
      render(
        <NotificationMarker
          category="needs-input"
          summary="Deploy now?"
          sessionId="notify-session"
          messageId="asst-notify"
          notificationId="n-19"
        />,
      );

      expect(screen.getByRole("button", { name: "Mark unhandled" })).not.toBeNull();
      expect(screen.queryByTestId("notification-answer-actions")).toBeNull();
      expect(screen.queryByRole("button", { name: "Use suggested answer: yes" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Custom answer" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reply to this notification" })).toBeNull();
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });
});
