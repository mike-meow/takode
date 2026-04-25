// @vitest-environment jsdom
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  colorTheme: string;
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  showUsageBars: boolean;
  shortcutSettings: {
    enabled: boolean;
    preset: "standard" | "vscode-light" | "vim-light";
    overrides: Record<string, string | null>;
  };
  zoomLevel: number;
  currentSessionId: string | null;
  sdkSessions: Array<{ sessionId: string; createdAt: number; archived?: boolean; cronJobId?: string }>;
  setColorTheme: ReturnType<typeof vi.fn>;
  toggleDarkMode: ReturnType<typeof vi.fn>;
  toggleNotificationSound: ReturnType<typeof vi.fn>;
  setNotificationDesktop: ReturnType<typeof vi.fn>;
  toggleShowUsageBars: ReturnType<typeof vi.fn>;
  setShortcutsEnabled: ReturnType<typeof vi.fn>;
  setShortcutPreset: ReturnType<typeof vi.fn>;
  setShortcutOverride: ReturnType<typeof vi.fn>;
  resetShortcutOverrides: ReturnType<typeof vi.fn>;
  setZoomLevel: ReturnType<typeof vi.fn>;
  setServerRestarting: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    colorTheme: "light",
    darkMode: false,
    notificationSound: true,
    notificationDesktop: false,
    showUsageBars: false,
    shortcutSettings: {
      enabled: false,
      preset: "standard",
      overrides: {},
    },
    zoomLevel: 1.0,
    currentSessionId: null,
    sdkSessions: [],
    setColorTheme: vi.fn(),
    toggleDarkMode: vi.fn(),
    toggleNotificationSound: vi.fn(),
    setNotificationDesktop: vi.fn(),
    toggleShowUsageBars: vi.fn(),
    setShortcutsEnabled: vi.fn(),
    setShortcutPreset: vi.fn(),
    setShortcutOverride: vi.fn(),
    resetShortcutOverrides: vi.fn(),
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
  getCaffeinateStatus: vi.fn(),
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
    getCaffeinateStatus: (...args: unknown[]) => mockApi.getCaffeinateStatus(...args),
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
  return {
    useStore: useStoreFn,
    COLOR_THEMES: [
      { id: "light", label: "Light" },
      { id: "dark", label: "Dark" },
      { id: "vscode-dark", label: "VS Code" },
    ],
  };
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
  Element.prototype.scrollIntoView = vi.fn();
  mockState = createMockState();
  window.location.hash = "#/settings";
  // Clear scroll state between tests.
  localStorage.removeItem("cc-settings-collapsed");
  localStorage.removeItem("cc-settings-scroll");
  mockApi.getSettings.mockResolvedValue({
    serverName: "",
    serverId: "test-id",
    pushoverConfigured: false,
    pushoverEnabled: true,
    pushoverEventFilters: { needsInput: true, review: true, error: true },
    pushoverDelaySeconds: 30,
    pushoverBaseUrl: "",
    claudeBinary: "",
    codexBinary: "",
    maxKeepAlive: 0,
    heavyRepoModeEnabled: false,
    editorConfig: { editor: "none" },
  });
  mockApi.updateSettings.mockResolvedValue({
    serverName: "",
    serverId: "test-id",
    pushoverConfigured: false,
    pushoverEnabled: true,
    pushoverEventFilters: { needsInput: true, review: true, error: true },
    pushoverDelaySeconds: 30,
    pushoverBaseUrl: "",
    claudeBinary: "",
    codexBinary: "",
    maxKeepAlive: 0,
    heavyRepoModeEnabled: false,
    editorConfig: { editor: "none" },
  });
  mockApi.getNamerLogs.mockResolvedValue([]);
  mockApi.getCaffeinateStatus.mockResolvedValue({ active: false, engagedAt: null, expiresAt: null });
});

async function waitForSettingsPage() {
  await screen.findAllByText("Notifications");
}

function settingsSection(title: string): HTMLElement {
  const heading = screen.getAllByText(title).find((node) => node.closest("[data-settings-section-id]"));
  if (!heading) throw new Error(`Missing settings section: ${title}`);
  const section = heading.closest("section, form");
  if (!section) throw new Error(`Missing section wrapper: ${title}`);
  return section as HTMLElement;
}

describe("SettingsPage", () => {
  it("loads settings on mount", async () => {
    render(<SettingsPage />);

    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    // Wait for loading to complete — section headings are visible
    await waitForSettingsPage();
  });

  it("shows shortcuts disabled by default in a compact state", async () => {
    render(<SettingsPage />);

    await waitForSettingsPage();
    const shortcutsSection = settingsSection("Shortcuts");
    expect(within(shortcutsSection as HTMLElement).getByText("Off")).toBeInTheDocument();
    expect(
      within(shortcutsSection as HTMLElement).getByText("Enable shortcuts to edit presets and bindings."),
    ).toBeInTheDocument();
    expect(within(shortcutsSection as HTMLElement).queryByLabelText("Preset")).not.toBeInTheDocument();
    expect(within(shortcutsSection as HTMLElement).queryByText("Search Current Session")).not.toBeInTheDocument();
  });

  it("shows shortcut preset controls when shortcuts are enabled", async () => {
    mockState = createMockState({
      shortcutSettings: {
        enabled: true,
        preset: "standard",
        overrides: {},
      },
    });

    render(<SettingsPage />);

    await waitForSettingsPage();
    expect(screen.getByLabelText("Preset")).toHaveValue("standard");
    expect(screen.getByText("Search Current Session")).toBeInTheDocument();
  });

  it("records and clears a custom shortcut override", async () => {
    mockState = createMockState({
      shortcutSettings: {
        enabled: true,
        preset: "standard",
        overrides: { search_session: "Ctrl+K" },
      },
    });

    render(<SettingsPage />);

    await waitForSettingsPage();
    fireEvent.click(screen.getByRole("button", { name: "Record new shortcut" }));
    fireEvent.keyDown(window, { key: "l", ctrlKey: true });

    expect(mockState.setShortcutOverride).toHaveBeenCalledWith("search_session", "Ctrl+L");

    const resetButton = screen
      .getAllByRole("button", { name: "Use preset default" })
      .find((button) => !button.hasAttribute("disabled"));
    fireEvent.click(resetButton as HTMLButtonElement);
    expect(mockState.setShortcutOverride).toHaveBeenCalledWith("search_session", undefined);
  });

  it("allows disabling an individual shortcut with Off", async () => {
    mockState = createMockState({
      shortcutSettings: {
        enabled: true,
        preset: "standard",
        overrides: {},
      },
    });

    render(<SettingsPage />);

    await waitForSettingsPage();
    const offButtons = screen.getAllByRole("button", { name: "Off" });
    fireEvent.click(offButtons[0]);

    expect(mockState.setShortcutOverride).toHaveBeenCalledWith("global_search", null);
  });

  it("does not start settings-page background work while inactive", () => {
    vi.useFakeTimers();
    try {
      render(<SettingsPage isActive={false} />);

      // Regression coverage for q-352: the hidden settings/logs-adjacent UI
      // must not fetch settings or start page-level polling while closed.
      vi.advanceTimersByTime(20_000);

      expect(mockApi.getSettings).not.toHaveBeenCalled();
      expect(mockApi.getAutoApprovalConfigs).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads persisted custom transcription vocabulary from settings", async () => {
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
      heavyRepoModeEnabled: false,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      editorConfig: { editor: "none" },
      transcriptionConfig: {
        apiKey: "***",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: true,
        enhancementModel: "gpt-5-mini",
        customVocabulary: "Takode, WsBridge, Questmaster",
      },
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText("Custom Vocabulary")).toHaveValue("Takode, WsBridge, Questmaster");
    });
  });

  it("loads and saves pushover event filters", async () => {
    mockApi.getSettings.mockResolvedValue({
      serverName: "",
      serverId: "test-id",
      pushoverConfigured: true,
      pushoverEnabled: true,
      pushoverEventFilters: { needsInput: true, review: false, error: true },
      pushoverDelaySeconds: 30,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      heavyRepoModeEnabled: false,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: {
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: true,
        enhancementModel: "gpt-5-mini",
      },
      editorConfig: { editor: "none" },
    });
    mockApi.updateSettings.mockResolvedValue({
      serverName: "",
      serverId: "test-id",
      pushoverConfigured: true,
      pushoverEnabled: true,
      pushoverEventFilters: { needsInput: true, review: true, error: true },
      pushoverDelaySeconds: 30,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      heavyRepoModeEnabled: false,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: {
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: true,
        enhancementModel: "gpt-5-mini",
      },
      editorConfig: { editor: "none" },
    });

    render(<SettingsPage />);

    await waitForSettingsPage();
    const pushoverForm = settingsSection("Push Notifications (Pushover)");

    await waitFor(() => {
      expect(within(pushoverForm).getAllByRole("checkbox").length).toBeGreaterThanOrEqual(3);
    });
    const reviewToggle = within(pushoverForm).getAllByRole("checkbox")[1] as HTMLInputElement;
    expect(reviewToggle).not.toBeChecked();

    fireEvent.click(reviewToggle);
    fireEvent.submit(reviewToggle.closest("form")!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          pushoverEventFilters: { needsInput: true, review: true, error: true },
        }),
      );
    });
  });

  it("shows error if initial load fails", async () => {
    mockApi.getSettings.mockRejectedValueOnce(new Error("load failed"));

    render(<SettingsPage />);

    expect(await screen.findByText("load failed")).toBeInTheDocument();
  });

  it("navigates back when Back button is clicked", async () => {
    render(<SettingsPage />);
    await waitForSettingsPage();

    fireEvent.click(screen.getByText("Back"));
    expect(window.location.hash).toBe("");
  });

  it("hides Back button in embedded mode", async () => {
    render(<SettingsPage embedded />);
    await waitForSettingsPage();
    expect(screen.queryByText("Back")).not.toBeInTheDocument();
  });

  it("toggles sound notifications from settings", async () => {
    render(<SettingsPage />);
    await waitForSettingsPage();

    fireEvent.click(screen.getByText(/^Sound$/));
    expect(mockState.toggleNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("cycles theme from settings", async () => {
    mockState = createMockState({ colorTheme: "light", darkMode: false });
    render(<SettingsPage />);
    await waitForSettingsPage();

    // Click the Theme button — should cycle to next theme ("dark")
    fireEvent.click(screen.getByText(/^Theme$/));
    expect(mockState.setColorTheme).toHaveBeenCalledWith("dark");
  });

  it("navigates to environments page from settings", async () => {
    render(<SettingsPage />);
    await waitForSettingsPage();

    fireEvent.click(screen.getByText("Manage Environments"));
    expect(window.location.hash).toBe("#/environments");
  });

  it("navigates to logs page from settings", async () => {
    // The log viewer should be grouped under Server & Diagnostics rather than exposed as a standalone Logs section.
    render(<SettingsPage />);
    await waitForSettingsPage();

    expect(screen.queryByText(/^Logs$/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Open Log Viewer"));
    expect(window.location.hash).toBe("#/logs");
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
      heavyRepoModeEnabled: false,
      editorConfig: { editor: "vscode-local" },
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
      heavyRepoModeEnabled: false,
      editorConfig: { editor: "cursor" },
    });

    render(<SettingsPage />);
    const select = await screen.findByLabelText("Editor");
    fireEvent.change(select, { target: { value: "cursor" } });

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ editorConfig: { editor: "cursor" } });
    });
  });

  it("updates heavy repo mode from the Sessions settings section", async () => {
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
      heavyRepoModeEnabled: true,
      editorConfig: { editor: "none" },
    });

    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Heavy Repo Mode Off/ }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ heavyRepoModeEnabled: true });
    });
    expect(screen.getByRole("button", { name: /Heavy Repo Mode On/ })).toBeInTheDocument();
  });

  it("ignores stale Sessions collapse state while polling sleep inhibitor status", async () => {
    vi.useFakeTimers();
    localStorage.setItem("cc-settings-collapsed", JSON.stringify(["sessions"]));
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
      heavyRepoModeEnabled: false,
      sleepInhibitorEnabled: true,
      sleepInhibitorDurationMinutes: 5,
      editorConfig: { editor: "none" },
    });

    try {
      render(<SettingsPage />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(settingsSection("Notifications")).toBeInTheDocument();

      expect(mockApi.getCaffeinateStatus).toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });

      expect(mockApi.getCaffeinateStatus).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses sleep inhibitor polling while the tab is hidden and resumes on visibility", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
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
      heavyRepoModeEnabled: false,
      sleepInhibitorEnabled: true,
      sleepInhibitorDurationMinutes: 5,
      editorConfig: { editor: "none" },
    });

    try {
      render(<SettingsPage />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(settingsSection("Notifications")).toBeInTheDocument();

      expect(mockApi.getCaffeinateStatus).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      expect(mockApi.getCaffeinateStatus).not.toHaveBeenCalled();

      visibilityState = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockApi.getCaffeinateStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(mockApi.getCaffeinateStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses the sleep inhibitor countdown while the tab is hidden", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T12:00:00.000Z"));
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
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
      heavyRepoModeEnabled: false,
      sleepInhibitorEnabled: true,
      sleepInhibitorDurationMinutes: 5,
      editorConfig: { editor: "none" },
    });
    mockApi.getCaffeinateStatus.mockResolvedValue({
      active: true,
      engagedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    try {
      render(<SettingsPage />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByText("Awake for 0s · expires in 1m 0s")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByText("Awake for 1s · expires in 59s")).toBeInTheDocument();

      visibilityState = "hidden";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByText("Awake for 1s · expires in 59s")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests desktop permission before enabling desktop alerts", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission,
    });

    try {
      render(<SettingsPage />);
      await waitForSettingsPage();
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
    await waitForSettingsPage();

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

  // ── Search and section navigation tests ───────────────────────────────────

  it("keeps sections expanded when section headers are clicked", async () => {
    render(<SettingsPage />);
    await waitForSettingsPage();

    expect(screen.getByText(/^Sound$/)).toBeInTheDocument();

    fireEvent.click(settingsSection("Notifications").querySelector("h2") as HTMLElement);

    expect(screen.getByText(/^Sound$/)).toBeInTheDocument();
    expect(localStorage.getItem("cc-settings-collapsed")).toBeNull();
  });

  it("ignores stale persisted collapse state and renders sections expanded", async () => {
    localStorage.setItem("cc-settings-collapsed", JSON.stringify(["notifications", "sessions"]));

    render(<SettingsPage />);
    await waitForSettingsPage();

    expect(screen.getByText(/^Sound$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Max Keep-Alive/i)).toBeInTheDocument();
  });

  it("filters sections with fuzzy search across labels and aliases", async () => {
    render(<SettingsPage />);
    await waitForSettingsPage();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "vscode" } });

    const cliSection = settingsSection("CLI & Backends");
    expect(cliSection).toBeVisible();
    expect(settingsSection("Shortcuts")).toBeVisible();
    expect(settingsSection("Appearance & Display")).not.toBeVisible();
    expect(within(cliSection).getByLabelText("Editor")).toBeVisible();
    expect(within(cliSection).getByLabelText("Claude Code")).not.toBeVisible();
  });

  it("shows an empty state when no settings match", async () => {
    render(<SettingsPage />);
    await waitForSettingsPage();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
      target: { value: "definitelynotasetting" },
    });

    expect(screen.getByText('No settings match "definitelynotasetting".')).toBeInTheDocument();
    expect(settingsSection("Notifications")).not.toBeVisible();
  });

  it("jumps to settings sections from the desktop nav and mobile control", async () => {
    render(<SettingsPage />);
    await waitForSettingsPage();

    fireEvent.click(screen.getByRole("button", { name: /^Sessions$/ }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox", { name: "Jump to settings section" }), {
      target: { value: "server" },
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("renders all section headings", async () => {
    render(<SettingsPage />);
    await waitForSettingsPage();

    expect(settingsSection("Appearance & Display")).toBeInTheDocument();
    expect(settingsSection("Notifications")).toBeInTheDocument();
    expect(settingsSection("CLI & Backends")).toBeInTheDocument();
    expect(settingsSection("Sessions")).toBeInTheDocument();
    expect(settingsSection("Push Notifications (Pushover)")).toBeInTheDocument();
    expect(settingsSection("Auto-Approval (LLM)")).toBeInTheDocument();
    expect(settingsSection("Session Namer")).toBeInTheDocument();
    expect(settingsSection("Voice Transcription")).toBeInTheDocument();
    expect(settingsSection("Server & Diagnostics")).toBeInTheDocument();
  });
});
