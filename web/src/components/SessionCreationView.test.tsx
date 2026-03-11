// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionCreationView } from "./SessionCreationView.js";

const mockCancelPendingCreation = vi.fn();
const mockRetryPendingCreation = vi.fn();

vi.mock("../utils/pending-creation.js", () => ({
  cancelPendingCreation: (...args: unknown[]) => mockCancelPendingCreation(...args),
  retryPendingCreation: (...args: unknown[]) => mockRetryPendingCreation(...args),
}));

let mockStoreState: Record<string, unknown>;

vi.mock("../store.js", async () => {
  const React = await import("react");
  const listeners = new Set<() => void>();
  const useStore: any = (selector: (state: Record<string, unknown>) => unknown) => {
    const [, forceUpdate] = React.useReducer((c: number) => c + 1, 0);
    React.useEffect(() => {
      listeners.add(forceUpdate);
      return () => { listeners.delete(forceUpdate); };
    }, []);
    return selector(mockStoreState);
  };
  useStore.getState = () => mockStoreState;
  return { useStore };
});

function makePending(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pending-1",
    backend: "claude" as const,
    createOpts: { backend: "claude" as const, cwd: "/repo" },
    progress: [],
    error: null,
    status: "creating" as const,
    realSessionId: null,
    cwd: "/repo",
    groupKey: null,
    createdAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SessionCreationView", () => {
  it("shows 'Session not found' when pending ID does not exist", () => {
    mockStoreState = { pendingSessions: new Map() };
    render(<SessionCreationView pendingId="pending-missing" />);
    expect(screen.getByText("Session not found")).toBeTruthy();
  });

  it("renders progress steps for a creating session", () => {
    const pending = makePending({
      progress: [
        { step: "check", label: "Checking environment", status: "done" },
        { step: "spawn", label: "Spawning CLI", status: "in_progress" },
      ],
    });
    mockStoreState = { pendingSessions: new Map([["pending-1", pending]]) };
    render(<SessionCreationView pendingId="pending-1" />);

    // Both step labels should be visible in the step list
    expect(screen.getByText("Checking environment")).toBeTruthy();
    // "Spawning CLI" appears in both the subtitle and step list
    expect(screen.getAllByText("Spawning CLI").length).toBeGreaterThanOrEqual(1);
  });

  it("shows error detail and retry button on failure", () => {
    const pending = makePending({
      status: "error",
      error: "Connection refused",
      progress: [{ step: "check", label: "Checking environment", status: "error" }],
    });
    mockStoreState = { pendingSessions: new Map([["pending-1", pending]]) };
    render(<SessionCreationView pendingId="pending-1" />);

    expect(screen.getByText("Connection refused")).toBeTruthy();

    // Retry button triggers retryPendingCreation
    fireEvent.click(screen.getByText("Retry"));
    expect(mockRetryPendingCreation).toHaveBeenCalledWith("pending-1");
  });

  it("cancel button calls cancelPendingCreation", () => {
    const pending = makePending({ status: "creating" });
    mockStoreState = { pendingSessions: new Map([["pending-1", pending]]) };
    render(<SessionCreationView pendingId="pending-1" />);

    fireEvent.click(screen.getByText("Cancel"));
    expect(mockCancelPendingCreation).toHaveBeenCalledWith("pending-1");
  });
});
