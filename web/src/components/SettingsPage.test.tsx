// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  showUsageBars: boolean;
  zoomLevel: number;
  currentSessionId: string | null;
  sdkSessions: Array<{ sessionId: string; createdAt: number; archived?: boolean; cronJobId?: string }>;
  toggleDarkMode: ReturnType<typeof vi.fn>;
  toggleNotificationSound: ReturnType<typeof vi.fn>;
  setNotificationDesktop: ReturnType<typeof vi.fn>;
  toggleShowUsageBars: ReturnType<typeof vi.fn>;
  setZoomLevel: ReturnType<typeof vi.fn>;
  setServerRestarting: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    darkMode: false,
    notificationSound: true,
    notificationDesktop: false,
    showUsageBars: false,
    zoomLevel: 1.0,
    currentSessionId: null,
    sdkSessions: [],
    toggleDarkMode: vi.fn(),
    toggleNotificationSound: vi.fn(),
    setNotificationDesktop: vi.fn(),
    toggleShowUsageBars: vi.fn(),
    setZoomLevel: vi.fn(),
    setServerRestarting: vi.fn(),
    ...overrides,
  };
}

const mockApi = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getNamerLogs: vi.fn(),
  getNamerLogEntry: vi.fn(),
  testPushover: vi.fn(),
  getAutoApprovalConfigs: vi.fn().mockResolvedValue([]),
  getAutoApprovalConfig: vi.fn(),
  createAutoApprovalConfig: vi.fn(),
  updateAutoApprovalConfig: vi.fn(),
  deleteAutoApprovalConfig: vi.fn(),
  getAutoApprovalLogs: vi.fn().mockResolvedValue([]),
  getAutoApprovalLogEntry: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    getNamerLogs: (...args: unknown[]) => mockApi.getNamerLogs(...args),
    getNamerLogEntry: (...args: unknown[]) => mockApi.getNamerLogEntry(...args),
    testPushover: (...args: unknown[]) => mockApi.testPushover(...args),
    getAutoApprovalConfigs: (...args: unknown[]) => mockApi.getAutoApprovalConfigs(...args),
    getAutoApprovalConfig: (...args: unknown[]) => mockApi.getAutoApprovalConfig(...args),
    createAutoApprovalConfig: (...args: unknown[]) => mockApi.createAutoApprovalConfig(...args),
    updateAutoApprovalConfig: (...args: unknown[]) => mockApi.updateAutoApprovalConfig(...args),
    deleteAutoApprovalConfig: (...args: unknown[]) => mockApi.deleteAutoApprovalConfig(...args),
    getAutoApprovalLogs: (...args: unknown[]) => mockApi.getAutoApprovalLogs(...args),
    getAutoApprovalLogEntry: (...args: unknown[]) => mockApi.getAutoApprovalLogEntry(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

// These panels are tested in their own files; keep SettingsPage tests focused
// on page-level wiring and interactions to avoid cross-test contention.
vi.mock("./NamerDebugPanel.js", () => ({
  NamerDebugPanel: () => <div>Session Namer Debug</div>,
}));
vi.mock("./AutoApprovalDebugPanel.js", () => ({
  AutoApprovalDebugPanel: () => null,
}));
vi.mock("./TranscriptionDebugPanel.js", () => ({
  TranscriptionDebugPanel: () => null,
}));
vi.mock("./FolderPicker.js", () => ({
  FolderPicker: () => null,
}));

import { SettingsPage } from "./SettingsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = createMockState();
  window.location.hash = "#/settings";
  // Clear collapse and scroll state between tests
  localStorage.removeItem("cc-settings-collapsed");
  localStorage.removeItem("cc-settings-scroll");
  mockApi.getSettings.mockResolvedValue({
    serverName: "",
    serverId: "test-id",
    pushoverConfigured: false,
    pushoverEnabled: true,
    pushoverDelaySeconds: 30,
    pushoverBaseUrl: "",
    claudeBinary: "",
    codexBinary: "",
    maxKeepAlive: 0,
    editorConfig: { editor: "none" },
  });
  mockApi.updateSettings.mockResolvedValue({
    serverName: "",
    serverId: "test-id",
    pushoverConfigured: false,
    pushoverEnabled: true,
    pushoverDelaySeconds: 30,
    pushoverBaseUrl: "",
    claudeBinary: "",
    codexBinary: "",
    maxKeepAlive: 0,
    editorConfig: { editor: "none" },
  });
  mockApi.getNamerLogs.mockResolvedValue([]);
});

describe("SettingsPage", () => {
  it("loads settings on mount", async () => {
    render(<SettingsPage />);

    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    // Wait for loading to complete — section headings are visible
    await screen.findByText("Notifications");
  });

  it("shows error if initial load fails", async () => {
    mockApi.getSettings.mockRejectedValueOnce(new Error("load failed"));

    render(<SettingsPage />);

    expect(await screen.findByText("load failed")).toBeInTheDocument();
  });

  it("navigates back when Back button is clicked", async () => {
    render(<SettingsPage />);
    await screen.findByText("Notifications");

    fireEvent.click(screen.getByText("Back"));
    expect(window.location.hash).toBe("");
  });

  it("hides Back button in embedded mode", async () => {
    render(<SettingsPage embedded />);
    await screen.findByText("Notifications");
    expect(screen.queryByText("Back")).not.toBeInTheDocument();
  });

  it("toggles sound notifications from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Notifications");

    fireEvent.click(screen.getByText(/^Sound$/));
    expect(mockState.toggleNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("toggles theme from settings", async () => {
    mockState = createMockState({ darkMode: true });
    render(<SettingsPage />);
    await screen.findByText("Notifications");

    fireEvent.click(screen.getByText(/^Theme$/));
    expect(mockState.toggleDarkMode).toHaveBeenCalledTimes(1);
  });

  it("navigates to environments page from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Notifications");

    fireEvent.click(screen.getByText("Manage Environments"));
    expect(window.location.hash).toBe("#/environments");
  });

  it("updates editor preference from settings dropdown", async () => {
    mockApi.getSettings.mockResolvedValue({
      serverName: "",
      serverId: "test-id",
      pushoverConfigured: false,
      pushoverEnabled: true,
      pushoverDelaySeconds: 30,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      editorConfig: { editor: "vscode" },
    });
    mockApi.updateSettings.mockResolvedValue({
      serverName: "",
      serverId: "test-id",
      pushoverConfigured: false,
      pushoverEnabled: true,
      pushoverDelaySeconds: 30,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      editorConfig: { editor: "cursor" },
    });

    render(<SettingsPage />);
    const select = await screen.findByLabelText("Editor");
    fireEvent.change(select, { target: { value: "cursor" } });

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ editorConfig: { editor: "cursor" } });
    });
  });

  it("requests desktop permission before enabling desktop alerts", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission,
    });

    try {
      render(<SettingsPage />);
      await screen.findByText("Notifications");
      fireEvent.click(screen.getByText(/^Desktop Alerts$/));

      await waitFor(() => {
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(mockState.setNotificationDesktop).toHaveBeenCalledWith(true);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not show OpenRouter section", async () => {
    // OpenRouter has been removed in favor of Haiku-based session naming
    render(<SettingsPage />);
    await screen.findByText("Notifications");

    expect(screen.queryByText("OpenRouter")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("OpenRouter API Key")).not.toBeInTheDocument();
  });

  it("shows namer debug panel", async () => {
    render(<SettingsPage />);
    // NamerDebugPanel renders the "Session Namer Debug" heading
    expect(await screen.findByText("Session Namer Debug")).toBeInTheDocument();
  });

  it("edits auto-approval rules in a modal", async () => {
    mockApi.getAutoApprovalConfigs.mockResolvedValue([
      {
        slug: "companion",
        label: "companion",
        projectPath: "/mnt/home/jiayiwei/companion",
        projectPaths: ["/mnt/home/jiayiwei/companion"],
        criteria: "Allow harmless commands",
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    mockApi.updateAutoApprovalConfig.mockResolvedValue({});

    render(<SettingsPage />);
    await screen.findByText("companion");

    fireEvent.click(screen.getByText("Edit"));

    const dialog = screen.getByRole("dialog", { name: "Edit auto-approval rule" });
    expect(dialog).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Rule criteria"), {
      target: { value: "Allow harmless commands and test commands" },
    });
    fireEvent.click(within(dialog).getByText("Save"));

    await waitFor(() => {
      expect(mockApi.updateAutoApprovalConfig).toHaveBeenCalledWith(
        "companion",
        expect.objectContaining({
          label: "companion",
          criteria: "Allow harmless commands and test commands",
          projectPaths: ["/mnt/home/jiayiwei/companion"],
        }),
      );
    });
  });

  // ── Collapsible section tests ──────────────────────────────────────────────

  it("collapses a section when header is clicked", async () => {
    render(<SettingsPage />);
    await screen.findByText("Notifications");

    // Sound toggle should be visible initially.
    expect(screen.getByText(/^Sound$/)).toBeInTheDocument();

    // Click the Notifications section header to collapse it
    fireEvent.click(screen.getByText("Notifications"));

    // Sound toggle should be hidden after collapsing.
    expect(screen.queryByText(/^Sound$/)).not.toBeInTheDocument();
  });

  it("expands a collapsed section when header is clicked again", async () => {
    render(<SettingsPage />);
    await screen.findByText("Notifications");

    // Collapse
    fireEvent.click(screen.getByText("Notifications"));
    expect(screen.queryByText(/^Sound$/)).not.toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByText("Notifications"));
    expect(screen.getByText(/^Sound$/)).toBeInTheDocument();
  });

  it("persists collapse state to localStorage", async () => {
    render(<SettingsPage />);
    await screen.findByText("Notifications");

    // Collapse the notifications section
    fireEvent.click(screen.getByText("Notifications"));

    // Verify localStorage was updated
    const stored = JSON.parse(localStorage.getItem("cc-settings-collapsed") || "[]");
    expect(stored).toContain("notifications");
  });

  it("restores collapse state from localStorage on mount", async () => {
    // Pre-set collapse state
    localStorage.setItem("cc-settings-collapsed", JSON.stringify(["notifications"]));

    render(<SettingsPage />);
    await screen.findByText("Appearance & Display"); // wait for render

    // Notifications section should be collapsed — Sound toggle not visible
    expect(screen.queryByRole("button", { name: /Sound/i })).not.toBeInTheDocument();
    // But the section heading should still be visible
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  it("renders all 7 section headings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Notifications");

    expect(screen.getByText("Appearance & Display")).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByText("CLI & Backends")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Push Notifications (Pushover)")).toBeInTheDocument();
    expect(screen.getByText("Auto-Approval (LLM)")).toBeInTheDocument();
    expect(screen.getByText("Server & Diagnostics")).toBeInTheDocument();
  });
});
