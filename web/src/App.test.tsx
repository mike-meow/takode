// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  colorTheme: string;
  darkMode: boolean;
  zoomLevel: number;
  currentSessionId: string | null;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  sidebarOpen: boolean;
  taskPanelOpen: boolean;
  activeTab: "chat" | "diff";
  newSessionModalState: null;
  serverRestarting: boolean;
  serverReachable: boolean;
  setServerReachable: ReturnType<typeof vi.fn>;
  setCurrentSession: ReturnType<typeof vi.fn>;
  markSessionViewed: ReturnType<typeof vi.fn>;
  closeNewSessionModal: ReturnType<typeof vi.fn>;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  sessions: Map<string, { backend_type?: string }>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    colorTheme: "dark",
    darkMode: true,
    zoomLevel: 1,
    currentSessionId: "s1",
    connectionStatus: new Map([["s1", "connected"]]),
    sidebarOpen: false,
    taskPanelOpen: false,
    activeTab: "chat",
    newSessionModalState: null,
    serverRestarting: false,
    serverReachable: true,
    setServerReachable: vi.fn(),
    setCurrentSession: vi.fn(),
    markSessionViewed: vi.fn(),
    closeNewSessionModal: vi.fn(),
    setSidebarOpen: vi.fn(),
    sessions: new Map([["s1", { backend_type: "claude" }]]),
    ...overrides,
  };
}

vi.mock("./store.js", () => {
  const useStore: any = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStore.getState = () => mockState;
  return { useStore };
});

const mockCheckHealth = vi.fn().mockResolvedValue(true);
const mockMarkSessionRead = vi.fn().mockResolvedValue({ ok: true });

vi.mock("./api.js", () => ({
  api: {
    markSessionRead: (...args: unknown[]) => mockMarkSessionRead(...args),
  },
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

vi.mock("./ws.js", () => ({
  connectSession: vi.fn(),
  disconnectSession: vi.fn(),
  sendVsCodeSelectionUpdate: vi.fn(),
}));

vi.mock("./components/Sidebar.js", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock("./components/TaskPanel.js", () => ({
  TaskPanel: () => <div data-testid="task-panel" />,
}));

vi.mock("./components/TopBar.js", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));

vi.mock("./components/ChatView.js", () => ({
  ChatView: () => <div data-testid="chat-view" />,
}));

vi.mock("./components/EmptyState.js", () => ({
  EmptyState: () => <div data-testid="empty-state" />,
}));

vi.mock("./components/DiffPanel.js", () => ({
  DiffPanel: () => <div data-testid="diff-panel" />,
}));

vi.mock("./components/Playground.js", () => ({
  Playground: () => <div data-testid="playground" />,
}));

vi.mock("./components/SettingsPage.js", () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));

vi.mock("./components/LogsPage.js", () => ({
  LogsPage: () => <div data-testid="logs-page" />,
}));

vi.mock("./components/EnvManager.js", () => ({
  EnvManager: () => <div data-testid="env-manager" />,
}));

vi.mock("./components/ActiveTimersPage.js", () => ({
  ActiveTimersPage: () => <div data-testid="active-timers-page" />,
}));

vi.mock("./components/TerminalPage.js", () => ({
  TerminalPage: () => <div data-testid="terminal-page" />,
}));

vi.mock("./components/SessionCreationView.js", () => ({
  SessionCreationView: () => <div data-testid="session-creation-view" />,
}));

vi.mock("./components/NewSessionModal.js", () => ({
  NewSessionModal: () => null,
}));

vi.mock("./components/QuestmasterPage.js", () => ({
  QuestmasterPage: () => <div data-testid="questmaster-page" />,
}));

vi.mock("./components/QuestDetailPanel.js", () => ({
  QuestDetailPanel: () => null,
}));

vi.mock("./utils/vscode-context.js", () => ({
  announceVsCodeReady: vi.fn(),
  maybeReadVsCodeSelectionContext: vi.fn(() => undefined),
}));

vi.mock("./utils/vscode-bridge.js", () => ({
  ensureVsCodeEditorPreference: vi.fn().mockResolvedValue(undefined),
}));

import App from "./App.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  window.location.hash = "#/session/s1";
});

describe("App hidden panels", () => {
  it("does not mount the sidebar while it is closed", () => {
    resetStore({ sidebarOpen: false, taskPanelOpen: false });

    render(<App />);

    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.queryByTestId("task-panel")).toBeNull();
  });

  it("mounts the sidebar and task panel only when opened", () => {
    resetStore({ sidebarOpen: true, taskPanelOpen: true });

    render(<App />);

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("task-panel")).toBeInTheDocument();
  });

  it("mounts ActiveTimersPage on the scheduled route", () => {
    window.location.hash = "#/scheduled";

    render(<App />);

    expect(screen.getByTestId("active-timers-page")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-view")).toBeNull();
  });

  it("suppresses the server unreachable banner while the active chat session is connected", () => {
    resetStore({
      serverReachable: false,
      activeTab: "chat",
      currentSessionId: "s1",
      connectionStatus: new Map([["s1", "connected"]]),
    });

    render(<App />);

    expect(screen.queryByText("Server unreachable")).toBeNull();
  });

  it("keeps the server unreachable banner on non-chat views even if the session transport is connected", () => {
    resetStore({
      serverReachable: false,
      activeTab: "diff",
      currentSessionId: "s1",
      connectionStatus: new Map([["s1", "connected"]]),
    });

    render(<App />);

    expect(screen.getByText("Server unreachable")).toBeInTheDocument();
  });
});
