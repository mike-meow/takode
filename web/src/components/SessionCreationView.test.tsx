// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CreateSessionOpts } from "../api.js";
import { SessionCreationView } from "./SessionCreationView.js";

const mockStartPendingCreation = vi.fn();
const mockCancelPendingCreation = vi.fn();
const mockRetryPendingCreation = vi.fn();
const mockSaveGroupNewSessionDefaults = vi.fn();

vi.mock("../utils/pending-creation.js", () => ({
  startPendingCreation: (...args: unknown[]) => mockStartPendingCreation(...args),
  cancelPendingCreation: (...args: unknown[]) => mockCancelPendingCreation(...args),
  retryPendingCreation: (...args: unknown[]) => mockRetryPendingCreation(...args),
}));

vi.mock("../utils/new-session-defaults.js", () => ({
  saveGroupNewSessionDefaults: (...args: unknown[]) => mockSaveGroupNewSessionDefaults(...args),
}));

const mockApi = {
  listEnvs: vi.fn().mockResolvedValue([{ name: "Prod", slug: "prod", variables: {}, createdAt: 0, updatedAt: 0 }]),
  getBackends: vi.fn().mockResolvedValue([{ id: "claude", available: true }, { id: "codex", available: true }]),
  getBackendModels: vi.fn().mockResolvedValue([]),
  getRepoInfo: vi.fn().mockResolvedValue({
    repoRoot: "/repo",
    repoName: "repo",
    currentBranch: "main",
    defaultBranch: "main",
    isWorktree: false,
  }),
};

vi.mock("../api.js", () => ({
  api: {
    listEnvs: (...args: unknown[]) => mockApi.listEnvs(...args),
    getBackends: (...args: unknown[]) => mockApi.getBackends(...args),
    getBackendModels: (...args: unknown[]) => mockApi.getBackendModels(...args),
    getRepoInfo: (...args: unknown[]) => mockApi.getRepoInfo(...args),
  },
}));

let mockStoreState: Record<string, unknown>;
const listeners = new Set<() => void>();
function notifyStore() { listeners.forEach((listener) => listener()); }

vi.mock("../store.js", async () => {
  const React = await import("react");
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

function makePending(overrides: Partial<{
  backend: "claude" | "codex";
  createOpts: CreateSessionOpts;
  status: "draft" | "creating" | "error" | "succeeded";
  cwd: string | null;
  groupKey: string | null;
}> = {}) {
  return {
    id: "pending-1",
    backend: "codex" as const,
    createOpts: {
      backend: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "bypassPermissions",
      cwd: "/repo",
      envSlug: "prod",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
      askPermission: false,
    },
    progress: [],
    error: null,
    status: "draft" as const,
    realSessionId: null,
    cwd: "/repo",
    groupKey: "/repo",
    createdAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const pendingSessions = new Map([["pending-1", makePending()]]);
  mockStoreState = {
    pendingSessions,
    updatePendingSession: vi.fn((id: string, updates: Record<string, unknown>) => {
      const existing = pendingSessions.get(id);
      if (!existing) return;
      pendingSessions.set(id, { ...existing, ...updates });
      notifyStore();
    }),
  };
});

describe("SessionCreationView draft mode", () => {
  it("renders the draft form prefilled with the pending session settings", async () => {
    render(<SessionCreationView pendingId="pending-1" />);

    expect(await screen.findByText("New Session")).toBeTruthy();
    expect(screen.getByDisplayValue("/repo")).toBeTruthy();
    expect(screen.getByText("GPT-5.4")).toBeTruthy();
  });

  it("updates the pending draft and starts creation when confirmed", async () => {
    render(<SessionCreationView pendingId="pending-1" />);

    const cwdInput = await screen.findByDisplayValue("/repo");
    fireEvent.change(cwdInput, { target: { value: "/repo/subdir" } });
    fireEvent.click(screen.getByText("Create Session"));

    await waitFor(() => {
      expect((mockStoreState.updatePendingSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        "pending-1",
        expect.objectContaining({
          status: "creating",
          cwd: "/repo/subdir",
          createOpts: expect.objectContaining({
            backend: "codex",
            cwd: "/repo/subdir",
            envSlug: "prod",
            askPermission: false,
          }),
        }),
      );
    });
    expect(mockSaveGroupNewSessionDefaults).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        backend: "codex",
        model: "gpt-5.4",
      }),
    );
    expect(mockStartPendingCreation).toHaveBeenCalledWith("pending-1");
  });
});
