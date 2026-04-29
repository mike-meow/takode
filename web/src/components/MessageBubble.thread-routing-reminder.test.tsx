// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import type { ChatMessage } from "../types.js";
import {
  THREAD_ROUTING_REMINDER_SOURCE_ID,
  THREAD_ROUTING_REMINDER_SOURCE_LABEL,
} from "../../shared/thread-routing-reminder.js";

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

function makeThreadRoutingReminderMessage(): ChatMessage {
  return {
    id: "thread-routing-reminder-1",
    role: "user",
    content: [
      "[Thread routing reminder]",
      "Missing thread marker. Your previous leader response was not assigned to a thread.",
      "Resend user-visible leader text with `[thread:main]` or `[thread:q-N]` as the first line.",
      "For leader shell commands, put `# thread:main` or `# thread:q-N` as the first non-empty command line.",
    ].join("\n"),
    timestamp: Date.now(),
    agentSource: {
      sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID,
      sessionLabel: THREAD_ROUTING_REMINDER_SOURCE_LABEL,
    },
    metadata: { threadKey: "q-970", questId: "q-970" },
  };
}

describe("MessageBubble thread-routing reminder messages", () => {
  it("renders synthetic thread-routing reminders as distinct reminder notices", () => {
    render(<MessageBubble message={makeThreadRoutingReminderMessage()} sessionId="thread-routing-reminder-session" />);

    expect(screen.getByText("Thread routing reminder")).toBeTruthy();
    expect(
      screen.getByText("Missing thread marker. Your previous leader response was not assigned to a thread."),
    ).toBeTruthy();
    expect(screen.getByText(/Resend user-visible leader text/)).toBeTruthy();
    expect(screen.getByText(/For leader shell commands/)).toBeTruthy();
    expect(screen.queryByText("[Thread routing reminder]")).toBeNull();
  });
});
