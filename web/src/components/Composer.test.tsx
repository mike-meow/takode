// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionState } from "../../server/session-types.js";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

// Polyfill matchMedia for jsdom — default to desktop (min-width: 640px matches)
// so the Composer renders its full expanded view in tests
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: query === "(min-width: 640px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const mockSendToSession = vi.fn().mockReturnValue(true);

// Build a controllable mock store state
let mockStoreState: Record<string, unknown> = {};

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

vi.mock("../api.js", () => ({
  api: {
    gitPull: vi.fn().mockResolvedValue({ success: true, output: "", git_ahead: 0, git_behind: 0 }),
    getBackendModels: vi.fn().mockResolvedValue([]),
  },
}));

// Mock useStore as a function that takes a selector
const mockAppendMessage = vi.fn();
const mockUpdateSession = vi.fn();
const mockSetPreviousPermissionMode = vi.fn();
const mockSetSessionPreview = vi.fn();
const mockSetAskPermission = vi.fn();

// Shared listener set for mock store reactivity
const mockStoreListeners = new Set<() => void>();
function notifyMockStore() { mockStoreListeners.forEach((l) => l()); }

vi.mock("../store.js", async () => {
  const React = await import("react");
  // Create a mock store function that acts like zustand's useStore with subscribe support
  const useStore: any = (selector: (state: Record<string, unknown>) => unknown) => {
    const [, forceUpdate] = React.useReducer((c: number) => c + 1, 0);
    React.useEffect(() => {
      mockStoreListeners.add(forceUpdate);
      return () => { mockStoreListeners.delete(forceUpdate); };
    }, []);
    return selector(mockStoreState);
  };
  // Add getState for imperative access (used by Composer for clearComposerDraft etc.)
  useStore.getState = () => mockStoreState;
  return { useStore };
});

import { Composer } from "./Composer.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "s1",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: [],
    permissionMode: "acceptEdits",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

function setupMockStore(overrides: {
  isConnected?: boolean;
  sessionStatus?: "idle" | "running" | "compacting" | null;
  session?: Partial<SessionState>;
  sdkSessionTotals?: { added: number; removed: number };
  vscodeSelectionContext?: {
    relativePath: string;
    displayPath: string;
    startLine: number;
    endLine: number;
    lineCount: number;
    updatedAt: number;
  } | null;
} = {}) {
  const {
    isConnected = true,
    sessionStatus = "idle",
    session = {},
    sdkSessionTotals,
    vscodeSelectionContext = null,
  } = overrides;

  const sessionsMap = new Map<string, SessionState>();
  sessionsMap.set("s1", makeSession(session));

  const cliConnectedMap = new Map<string, boolean>();
  cliConnectedMap.set("s1", isConnected);

  const sessionStatusMap = new Map<string, "idle" | "running" | "compacting" | null>();
  sessionStatusMap.set("s1", sessionStatus);

  const previousPermissionModeMap = new Map<string, string>();
  previousPermissionModeMap.set("s1", "acceptEdits");

  const askPermissionMap = new Map<string, boolean>();
  askPermissionMap.set("s1", true);

  mockStoreState = {
    sessions: sessionsMap,
    cliConnected: cliConnectedMap,
    sessionStatus: sessionStatusMap,
    previousPermissionMode: previousPermissionModeMap,
    askPermission: askPermissionMap,
    composerDrafts: new Map(),
    appendMessage: mockAppendMessage,
    updateSession: mockUpdateSession,
    setPreviousPermissionMode: mockSetPreviousPermissionMode,
    setSessionPreview: mockSetSessionPreview,
    setAskPermission: mockSetAskPermission,
    vscodeSelectionContext,
    sdkSessions: sdkSessionTotals ? [{
      sessionId: "s1",
      totalLinesAdded: sdkSessionTotals.added,
      totalLinesRemoved: sdkSessionTotals.removed,
    }] : [],
    setComposerDraft: vi.fn((sessionId: string, draft: { text: string; images: unknown[] }) => {
      (mockStoreState.composerDrafts as Map<string, unknown>).set(sessionId, draft);
      notifyMockStore();
    }),
    clearComposerDraft: vi.fn((sessionId: string) => {
      (mockStoreState.composerDrafts as Map<string, unknown>).delete(sessionId);
      notifyMockStore();
    }),
    collapsibleTurnIds: new Map(),
    turnActivityOverrides: new Map(),
    collapseAllTurnActivity: vi.fn(),
    pendingPermissions: new Map(),
    removePermission: vi.fn(),
    diffFileStats: new Map(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMockStore();
});

// ─── Basic rendering ────────────────────────────────────────────────────────

describe("Composer basic rendering", () => {
  it("renders textarea and send button", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    // Send button (the round one with the arrow SVG) - identified by title
    const sendBtn = screen.getByTitle("Send message");
    expect(sendBtn).toBeTruthy();
  });

  it("uses explicit zero diff stats from bridge state instead of stale sdk fallback", () => {
    setupMockStore({
      session: { total_lines_added: 0, total_lines_removed: 0 },
      sdkSessionTotals: { added: 34, removed: 8 },
    });
    render(<Composer sessionId="s1" />);

    expect(screen.queryByText("+34")).toBeNull();
    expect(screen.queryByText("-8")).toBeNull();
  });
});

// ─── Send button disabled state ──────────────────────────────────────────────

describe("Composer send button state", () => {
  it("send button is disabled when text is empty", () => {
    render(<Composer sessionId="s1" />);
    const sendBtn = screen.getByTitle("Send message");
    expect(sendBtn.hasAttribute("disabled")).toBe(true);
  });

  it("send button is disabled when CLI is not connected", () => {
    setupMockStore({ isConnected: false });
    render(<Composer sessionId="s1" />);
    const sendBtn = screen.getByTitle("Send message");
    expect(sendBtn.hasAttribute("disabled")).toBe(true);
  });

  it("typing text enables the send button", async () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "Hello world" } });

    const sendBtn = screen.getByTitle("Send message");
    expect(sendBtn.hasAttribute("disabled")).toBe(false);
  });
});

// ─── Sending messages ────────────────────────────────────────────────────────

describe("Composer sending messages", () => {
  it("pressing Enter sends the message via sendToSession", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "test message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "test message",
      session_id: "s1",
    }));
  });

  it("pressing Shift+Enter does NOT send the message", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "line 1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("clicking the send button sends the message", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "click send" } });
    fireEvent.click(screen.getByTitle("Send message"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "click send",
    }));
  });

  it("sends VS Code selection metadata separately from the visible user message", () => {
    setupMockStore({
      vscodeSelectionContext: {
        relativePath: "web/src/App.tsx",
        displayPath: "App.tsx",
        startLine: 42,
        endLine: 44,
        lineCount: 3,
        updatedAt: 1,
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "check this bug" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "check this bug",
      vscodeSelection: {
        relativePath: "web/src/App.tsx",
        displayPath: "App.tsx",
        startLine: 42,
        endLine: 44,
        lineCount: 3,
      },
    }));
  });

  it("does not send VS Code metadata when there is no selection", () => {
    setupMockStore({ vscodeSelectionContext: null });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "check this bug" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "check this bug",
    }));
    expect(mockSendToSession.mock.calls.at(-1)?.[1]).not.toHaveProperty("vscodeSelection");
  });

  it("textarea is cleared after sending", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "to be cleared" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(textarea.value).toBe("");
  });

  it("treats /plan as a Codex mode switch (not a user message)", () => {
    setupMockStore({
      session: {
        backend_type: "codex",
        model: "gpt-5.3-codex",
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/plan" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_permission_mode",
      mode: "plan",
    });
    expect(mockSendToSession).not.toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
    }));
  });

  it("treats /suggest as a Codex mode switch to suggest mode", () => {
    setupMockStore({
      session: {
        backend_type: "codex",
        model: "gpt-5.3-codex",
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/suggest" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_permission_mode",
      mode: "suggest",
    });
    expect(mockSendToSession).not.toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
    }));
  });
});

// ─── Mode cycling ───────────────────────────────────────────────────────────

describe("Composer mode cycling", () => {
  it("pressing Shift+Tab toggles from agent to plan mode", () => {
    // Start in acceptEdits (Agent mode with askPermission=true)
    setupMockStore({ session: { permissionMode: "acceptEdits" } });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

    // Should switch to plan mode (CLI mode is "plan")
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_permission_mode",
      mode: "plan",
    });
  });

  it("pressing Shift+Tab toggles from plan back to agent mode", () => {
    // Start in plan mode — should toggle to agent
    setupMockStore({ session: { permissionMode: "plan" } });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

    // Should switch to agent mode; with askPermission=true → CLI mode is "acceptEdits"
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_permission_mode",
      mode: "acceptEdits",
    });
  });
});

// ─── Mode toggle buttons ────────────────────────────────────────────────────

describe("Composer mode toggle", () => {
  it("renders mode toggle button for Claude sessions", () => {
    // Start in acceptEdits (Agent mode) — single toggle shows "Agent"
    setupMockStore({ session: { permissionMode: "acceptEdits" } });
    render(<Composer sessionId="s1" />);

    const toggleBtn = screen.getByTitle("Agent mode: executes tools directly (Shift+Tab to toggle)");
    expect(toggleBtn).toBeTruthy();
  });

  it("clicking mode toggle in agent mode sends set_permission_mode with plan", () => {
    // Start in agent mode — clicking toggles to plan
    setupMockStore({ session: { permissionMode: "acceptEdits" } });
    render(<Composer sessionId="s1" />);

    const toggleBtn = screen.getByTitle("Agent mode: executes tools directly (Shift+Tab to toggle)");
    fireEvent.click(toggleBtn);

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_permission_mode",
      mode: "plan",
    });
  });

  it("clicking mode toggle in plan mode sends set_permission_mode with acceptEdits when askPermission is true", () => {
    // Start in plan mode — clicking toggles to agent
    setupMockStore({ session: { permissionMode: "plan" } });
    render(<Composer sessionId="s1" />);

    const toggleBtn = screen.getByTitle("Plan mode: agent creates a plan before executing (Shift+Tab to toggle)");
    fireEvent.click(toggleBtn);

    // askPermission defaults to true → CLI mode should be acceptEdits
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_permission_mode",
      mode: "acceptEdits",
    });
  });

  it("prefers server uiMode over stale permissionMode for the mode toggle label", () => {
    // Regression: SDK/session replay can transiently report a stale CLI mode
    // while server uiMode is already authoritative.
    setupMockStore({ session: { permissionMode: "acceptEdits", uiMode: "plan" } });
    render(<Composer sessionId="s1" />);

    const toggleBtn = screen.getByTitle("Plan mode: agent creates a plan before executing (Shift+Tab to toggle)");
    expect(toggleBtn).toBeTruthy();
  });

  it("mode toggle is disabled when CLI is not connected", () => {
    setupMockStore({ isConnected: false, session: { permissionMode: "acceptEdits" } });
    render(<Composer sessionId="s1" />);

    const toggleBtn = screen.getByTitle("Agent mode: executes tools directly (Shift+Tab to toggle)");
    expect(toggleBtn.hasAttribute("disabled")).toBe(true);
  });

  it("codex reasoning dropdown sends set_codex_reasoning_effort", async () => {
    setupMockStore({
      session: {
        backend_type: "codex",
        model: "gpt-5.3-codex",
        permissionMode: "plan",
      },
    });
    render(<Composer sessionId="s1" />);

    const trigger = screen.getByTitle("Reasoning effort (relaunch required)");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByText("High"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_codex_reasoning_effort",
      effort: "high",
    });
  });
});

// ─── Ask Permission toggle ──────────────────────────────────────────────────

describe("Composer ask permission toggle", () => {
  it("renders ask permission shield icon for Claude sessions", () => {
    setupMockStore({ session: { permissionMode: "acceptEdits" } });
    render(<Composer sessionId="s1" />);

    // The toggle should render a shield button with a title indicating permission mode
    const shieldButton = screen.getByTitle(/Permissions:/);
    expect(shieldButton).toBeTruthy();
  });
});

describe("Composer VS Code context", () => {
  it("renders the current VS Code selection line when context is available", () => {
    setupMockStore({
      vscodeSelectionContext: {
        relativePath: "web/src/components/Composer.tsx",
        displayPath: "Composer.tsx",
        startLine: 12,
        endLine: 14,
        lineCount: 3,
        updatedAt: 1,
      },
    });
    render(<Composer sessionId="s1" />);

    expect(screen.getByText("3 lines selected")).toBeTruthy();
  });
});

// ─── Interrupt button ────────────────────────────────────────────────────────

describe("Composer interrupt button", () => {
  it("interrupt button appears when session is running alongside send button", () => {
    setupMockStore({ sessionStatus: "running" });
    render(<Composer sessionId="s1" />);

    expect(screen.getByTitle("Stop generation")).toBeTruthy();
    // Send button is always present (users can send follow-up messages while agent is running)
    expect(screen.getByTitle("Send message")).toBeTruthy();
  });

  it("interrupt button sends interrupt message", () => {
    setupMockStore({ sessionStatus: "running" });
    render(<Composer sessionId="s1" />);

    fireEvent.click(screen.getByTitle("Stop generation"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "interrupt" });
  });

  it("send button appears when session is idle", () => {
    setupMockStore({ sessionStatus: "idle" });
    render(<Composer sessionId="s1" />);

    expect(screen.getByTitle("Send message")).toBeTruthy();
    // Stop button is always rendered (disabled when idle) so layout doesn't shift
    const stopBtn = screen.getByTitle("Stop generation") as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();
    expect(stopBtn.disabled).toBe(true);
  });
});

// ─── Slash menu ──────────────────────────────────────────────────────────────

describe("Composer slash menu", () => {
  it("slash menu opens when typing /", () => {
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    // Commands should appear in the menu
    expect(screen.getByText("/help")).toBeTruthy();
    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.getByText("/commit")).toBeTruthy();
  });

  it("slash commands are filtered as user types", () => {
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/cl" } });

    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.queryByText("/help")).toBeNull();
    // "commit" does not match "cl" so it should not appear either
    expect(screen.queryByText("/commit")).toBeNull();
  });

  it("slash menu does not open when there are no commands", () => {
    setupMockStore({
      session: {
        slash_commands: [],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    // No command items should appear
    expect(screen.queryByText("/help")).toBeNull();
  });

  it("slash menu shows command types", () => {
    setupMockStore({
      session: {
        slash_commands: ["help"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    // Each command should display its type
    expect(screen.getByText("command")).toBeTruthy();
    expect(screen.getByText("skill")).toBeTruthy();
  });
});

// ─── Disabled state ──────────────────────────────────────────────────────────

describe("Composer disabled state", () => {
  it("textarea is always enabled so users can draft while waiting for CLI", () => {
    setupMockStore({ isConnected: false });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    expect(textarea.disabled).toBe(false);
  });

  it("textarea shows correct placeholder when connected", () => {
    setupMockStore({ isConnected: true });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    expect(textarea.placeholder).toContain("Type a message");
  });

  it("textarea shows normal placeholder when not connected", () => {
    setupMockStore({ isConnected: false });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    // Textarea is enabled for drafting; placeholder is the same as connected state
    expect(textarea.placeholder).toContain("Type a message");
  });
});
