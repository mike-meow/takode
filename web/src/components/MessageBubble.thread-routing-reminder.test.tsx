// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage } from "../types.js";
import {
  THREAD_ROUTING_REMINDER_SOURCE_ID,
  THREAD_ROUTING_REMINDER_SOURCE_LABEL,
} from "../../shared/thread-routing-reminder.js";
import {
  QUEST_THREAD_REMINDER_SOURCE_ID,
  QUEST_THREAD_REMINDER_SOURCE_LABEL,
} from "../../shared/quest-thread-reminder.js";

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

function makeQuestThreadReminderMessage(): ChatMessage {
  return {
    id: "quest-thread-reminder-1",
    role: "user",
    content: "Thread reminder: attach any prior messages that clearly belong to q-1025 with `takode thread attach`.",
    timestamp: Date.now(),
    agentSource: {
      sessionId: QUEST_THREAD_REMINDER_SOURCE_ID,
      sessionLabel: QUEST_THREAD_REMINDER_SOURCE_LABEL,
    },
    metadata: { threadKey: "q-1025", questId: "q-1025" },
  };
}

describe("MessageBubble thread-routing reminder messages", () => {
  it("renders synthetic thread-routing reminders as compact collapsed model-only notices", async () => {
    render(<MessageBubble message={makeThreadRoutingReminderMessage()} sessionId="thread-routing-reminder-session" />);

    expect(screen.getByText("Thread routing reminder")).toBeTruthy();
    expect(screen.getByText("model-only")).toBeTruthy();
    expect(screen.queryByText(/Missing thread marker/)).toBeNull();
    expect(screen.queryByText(/Resend user-visible leader text/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Expand Thread routing reminder" }));

    expect(screen.getByText(/^\[Thread routing reminder\]/)).toBeTruthy();
    expect(screen.getAllByText(/Missing thread marker/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Resend user-visible leader text/)).toBeTruthy();
    expect(screen.getByText(/For leader shell commands/)).toBeTruthy();
  });

  it("renders synthetic quest thread reminders as compact collapsed model-only notices", async () => {
    render(<MessageBubble message={makeQuestThreadReminderMessage()} sessionId="quest-thread-reminder-session" />);

    expect(screen.getByText("Quest thread reminder")).toBeTruthy();
    expect(screen.getByText("model-only")).toBeTruthy();
    expect(screen.queryByText(/attach any prior messages that clearly belong to q-1025/)).toBeNull();
    expect(screen.queryByTestId("markdown")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Expand Quest thread reminder" }));

    expect(screen.getByText(/^Thread reminder:/)).toBeTruthy();
    expect(
      screen.getAllByText(/attach any prior messages that clearly belong to q-1025/).length,
    ).toBeGreaterThanOrEqual(1);
  });
});
