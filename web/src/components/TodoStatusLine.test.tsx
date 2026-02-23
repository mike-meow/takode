// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockTask {
  id: string;
  status: "pending" | "in_progress" | "completed";
  subject: string;
  activeForm?: string;
}

interface MockStoreState {
  sessionTasks: Map<string, MockTask[]>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionTasks: new Map(),
    sessionStatus: new Map([["s1", "running"]]),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(mockState),
}));

import { TodoStatusLine } from "./TodoStatusLine.js";

beforeEach(() => {
  resetStore();
});

describe("TodoStatusLine", () => {
  it("renders current todo strip when a session has an in-progress task", () => {
    // Validates that the strip is backend-agnostic and appears whenever
    // extracted session tasks contain active work.
    resetStore({
      sessionTasks: new Map([[
        "s1",
        [
          { id: "t1", status: "in_progress", subject: "Implement task sync" },
          { id: "t2", status: "pending", subject: "Add test coverage" },
        ],
      ]]),
    });

    render(<TodoStatusLine sessionId="s1" />);
    expect(screen.getByText("Implement task sync")).toBeInTheDocument();
    expect(screen.getByText("0/2")).toBeInTheDocument();
  });

  it("renders nothing when there are no tasks", () => {
    const { container } = render(<TodoStatusLine sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });
});
