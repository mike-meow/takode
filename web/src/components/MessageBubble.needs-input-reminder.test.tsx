// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
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

import { MessageBubble } from "./MessageBubble.js";
import { useStore } from "../store.js";

function makeNeedsInputReminderMessage(): ChatMessage {
  return {
    id: "needs-input-reminder-1",
    role: "user",
    content: [
      "[Needs-input reminder]",
      "Unresolved same-session needs-input notifications: 1.",
      "  17. Confirm rollout scope",
      "Review or resolve these before assuming the user's latest message answered them.",
    ].join("\n"),
    timestamp: Date.now(),
    agentSource: {
      sessionId: "system:needs-input-reminder",
      sessionLabel: "Needs Input Reminder",
    },
  };
}

describe("MessageBubble needs-input reminder messages", () => {
  beforeEach(() => {
    revertToMessageMock.mockClear();
    markNotificationDoneMock.mockClear();
  });

  it("renders resolved historical reminder state instead of stale unresolved text", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const nextNotifications = new Map(prevNotifications);
    nextNotifications.set("reminder-session", [
      {
        id: "n-17",
        category: "needs-input",
        summary: "Confirm rollout scope",
        timestamp: Date.now(),
        messageId: null,
        done: true,
      },
    ]);
    useStore.setState({ sessionNotifications: nextNotifications });

    try {
      render(<MessageBubble message={makeNeedsInputReminderMessage()} sessionId="reminder-session" />);

      expect(screen.getByText("Historical needs-input reminder")).toBeTruthy();
      expect(screen.getByText("All referenced needs-input notifications have since been resolved.")).toBeTruthy();
      expect(screen.getByText("resolved")).toBeTruthy();
      expect(screen.queryByText("Unresolved same-session needs-input notifications: 1.")).toBeNull();
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });

  it("updates a reminder from active to historical when notification state changes", async () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const activeNotifications = new Map(prevNotifications);
    activeNotifications.set("reminder-session", [
      {
        id: "n-17",
        category: "needs-input",
        summary: "Confirm rollout scope",
        timestamp: Date.now(),
        messageId: null,
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: activeNotifications });

    try {
      render(<MessageBubble message={makeNeedsInputReminderMessage()} sessionId="reminder-session" />);

      expect(screen.getByText("Needs-input reminder")).toBeTruthy();
      expect(screen.getByText("1 referenced needs-input notification is still unresolved.")).toBeTruthy();

      const resolvedNotifications = new Map(useStore.getState().sessionNotifications);
      resolvedNotifications.set("reminder-session", [
        {
          id: "n-17",
          category: "needs-input",
          summary: "Confirm rollout scope",
          timestamp: Date.now(),
          messageId: null,
          done: true,
        },
      ]);
      useStore.setState({ sessionNotifications: resolvedNotifications });

      await waitFor(() => {
        expect(screen.getByText("Historical needs-input reminder")).toBeTruthy();
      });
      expect(screen.getByText("All referenced needs-input notifications have since been resolved.")).toBeTruthy();
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });

  it("renders missing notification references as historical state unavailable", () => {
    const prevNotifications = useStore.getState().sessionNotifications;
    const nextNotifications = new Map(prevNotifications);
    nextNotifications.set("reminder-session", []);
    useStore.setState({ sessionNotifications: nextNotifications });

    try {
      render(<MessageBubble message={makeNeedsInputReminderMessage()} sessionId="reminder-session" />);

      expect(screen.getByText("Historical needs-input reminder")).toBeTruthy();
      expect(screen.getByText("Notification state is no longer available for this historical reminder.")).toBeTruthy();
      expect(screen.getByText("state unavailable")).toBeTruthy();
      expect(screen.queryByText("Unresolved same-session needs-input notifications: 1.")).toBeNull();
    } finally {
      useStore.setState({ sessionNotifications: prevNotifications });
    }
  });
});
