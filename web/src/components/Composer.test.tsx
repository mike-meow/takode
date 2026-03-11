// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, createEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionState } from "../../server/session-types.js";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const mediaState = {
  touchDevice: false,
};

// Polyfill matchMedia for jsdom. Touch capability remains query-driven; layout
// width is controlled via window.innerWidth because the composer now uses
// zoom-adjusted viewport width instead of a raw media query.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches:
      query === "(hover: none) and (pointer: coarse)"
        ? mediaState.touchDevice
        : false,
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
const mockTranscribe = vi.fn().mockResolvedValue({ mode: "dictation", text: "transcribed text", backend: "openai", enhanced: false });
const mockGetBackendModels = vi.fn().mockResolvedValue([]);
const mockRefreshSessionSkills = vi.fn().mockResolvedValue({ ok: true, skills: [] });

// Build a controllable mock store state
let mockStoreState: Record<string, unknown> = {};

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

vi.mock("../api.js", () => ({
  api: {
    gitPull: vi.fn().mockResolvedValue({ success: true, output: "", git_ahead: 0, git_behind: 0 }),
    getBackendModels: (...args: unknown[]) => mockGetBackendModels(...args),
    getSettings: vi.fn().mockResolvedValue({ claudeDefaultModel: "" }),
    refreshSessionSkills: (...args: unknown[]) => mockRefreshSessionSkills(...args),
    transcribe: (...args: unknown[]) => mockTranscribe(...args),
  },
}));

const mockVoiceState = {
  isSupportedOverride: null as boolean | null,
  unsupportedReasonOverride: null as "insecure-context" | "missing-media-devices" | "missing-media-recorder" | "unsupported-environment" | null,
  unsupportedMessageOverride: null as string | null,
  onAudioReady: null as ((blob: Blob) => void | Promise<void>) | null,
};

vi.mock("../hooks/useVoiceInput.js", () => ({
  useVoiceInput: (options: { onAudioReady?: (blob: Blob) => void | Promise<void> } = {}) => {
    mockVoiceState.onAudioReady = options.onAudioReady ?? null;
    const isSupported = mockVoiceState.isSupportedOverride ?? window.isSecureContext !== false;
    const unsupportedReason = isSupported
      ? null
      : (mockVoiceState.unsupportedReasonOverride ?? (window.isSecureContext === false ? "insecure-context" : "unsupported-environment"));
    const unsupportedMessage = isSupported
      ? null
      : (mockVoiceState.unsupportedMessageOverride
        ?? (unsupportedReason === "insecure-context"
          ? "Voice input requires HTTPS or localhost in this browser."
          : "Voice input is unavailable."));
    return {
      isRecording: false,
      isSupported,
      unsupportedReason,
      unsupportedMessage,
      isTranscribing: false,
      transcriptionPhase: null,
      error: null,
      volumeLevel: 0,
      setIsTranscribing: vi.fn(),
      setTranscriptionPhase: vi.fn(),
      setError: vi.fn(),
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      toggleRecording: vi.fn(() => options.onAudioReady?.(new Blob(["voice"], { type: "audio/webm" }))),
    };
  },
}));

// Mock useStore as a function that takes a selector
const mockAppendMessage = vi.fn();
const mockUpdateSession = vi.fn();
const mockSetPreviousPermissionMode = vi.fn();
const mockSetSessionPreview = vi.fn();
const mockSetAskPermission = vi.fn();
const mockRequestBottomAlignOnNextUserMessage = vi.fn();

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
  draftText?: string;
  zoomLevel?: number;
  sdkSessionTotals?: { added: number; removed: number };
  vscodeSelectionContext?: {
    selection: {
      absolutePath: string;
      startLine: number;
      endLine: number;
      lineCount: number;
    } | null;
    updatedAt: number;
    sourceId: string;
    sourceType?: "browser-panel" | "vscode-window";
    sourceLabel?: string;
  } | null;
} = {}) {
  const {
    isConnected = true,
    sessionStatus = "idle",
    session = {},
    draftText = "",
    zoomLevel = 1,
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
    composerDrafts: draftText ? new Map([["s1", { text: draftText, images: [] }]]) : new Map(),
    appendMessage: mockAppendMessage,
    updateSession: mockUpdateSession,
    setPreviousPermissionMode: mockSetPreviousPermissionMode,
    setSessionPreview: mockSetSessionPreview,
    setAskPermission: mockSetAskPermission,
    requestBottomAlignOnNextUserMessage: mockRequestBottomAlignOnNextUserMessage,
    zoomLevel,
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

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

function makeImageFile(name: string, type = "image/png") {
  return new File(["fake-image-bytes"], name, { type });
}

function makeImageDataTransfer(file: File) {
  return {
    files: [file],
    items: [
      {
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVoiceState.isSupportedOverride = null;
  mockVoiceState.unsupportedReasonOverride = null;
  mockVoiceState.unsupportedMessageOverride = null;
  mockVoiceState.onAudioReady = null;
  mockTranscribe.mockResolvedValue({ mode: "dictation", text: "transcribed text", backend: "openai", enhanced: false });
  mockGetBackendModels.mockResolvedValue([]);
  mockRefreshSessionSkills.mockResolvedValue({ ok: true, skills: [] });
  mockRequestBottomAlignOnNextUserMessage.mockReset();
  mediaState.touchDevice = false;
  setViewportWidth(1024);
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "FileReader", {
    configurable: true,
    writable: true,
    value: class MockFileReader {
      result: string | ArrayBuffer | null = null;
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

      readAsDataURL(file: Blob) {
        this.result = `data:${(file as File).type || "image/png"};base64,ZmFrZQ==`;
        this.onload?.call(this as unknown as FileReader, new ProgressEvent("load") as ProgressEvent<FileReader>);
      }
    },
  });
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

  it("does not switch to the collapsed composer on narrow desktop layouts", () => {
    setViewportWidth(500);
    mediaState.touchDevice = false;
    render(<Composer sessionId="s1" />);

    expect(screen.queryByText("Type a message...")).toBeNull();
  });

  it("keeps the voice button visible on mobile even when voice input is unavailable", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    render(<Composer sessionId="s1" />);

    const voiceButtons = screen.getAllByLabelText("Voice input");
    expect(voiceButtons.length).toBeGreaterThan(0);
    expect(voiceButtons[0].hasAttribute("disabled")).toBe(false);
    expect(voiceButtons[0].getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText("Voice input requires HTTPS or localhost in this browser.")).toBeNull();
  });

  it("shows the expanded mobile voice button instead of dropping it from the toolbar", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    setupMockStore({ draftText: "Voice should still have a slot" });

    render(<Composer sessionId="s1" />);

    const voiceButtons = screen.getAllByLabelText("Voice input");
    expect(voiceButtons.length).toBeGreaterThan(0);
    expect(screen.getByTitle("Voice needs HTTPS")).toBeTruthy();
  });

  it("shows the full unavailable-voice explanation only after pressing the voice button", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    render(<Composer sessionId="s1" />);

    expect(screen.queryByText("Voice input requires HTTPS or localhost in this browser.")).toBeNull();

    fireEvent.click(screen.getAllByLabelText("Voice input")[0]);

    expect(screen.getByText("Voice input requires HTTPS or localhost in this browser.")).toBeTruthy();
  });

  it("shows the concise unavailable tooltip without the full message on desktop hover state", () => {
    setViewportWidth(1200);
    mediaState.touchDevice = false;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    render(<Composer sessionId="s1" />);

    expect(screen.getByTitle("Voice needs HTTPS")).toBeTruthy();
    expect(screen.queryByText("Voice input requires HTTPS or localhost in this browser.")).toBeNull();
  });
});

describe("Composer voice edit mode", () => {
  it("keeps empty-composer voice input on the normal dictation path", async () => {
    render(<Composer sessionId="s1" />);

    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.objectContaining({
          mode: "dictation",
          sessionId: "s1",
        }),
      );
    });
    const options = mockTranscribe.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options?.composerText).toBeUndefined();
  });

  it("uses voice edit mode for non-empty drafts and makes the edit explicit and reversible", async () => {
    setupMockStore({ draftText: "Please rewrite this update into two short bullets." });
    mockTranscribe.mockResolvedValueOnce({
      mode: "edit",
      text: "- Bullet one\n- Bullet two",
      rawText: "turn this into two short bullets",
      instructionText: "turn this into two short bullets",
      backend: "openai",
      enhanced: true,
    });

    render(<Composer sessionId="s1" />);

    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.objectContaining({
          mode: "edit",
          sessionId: "s1",
          composerText: "Please rewrite this update into two short bullets.",
        }),
      );
    });

    expect(screen.getByText("Voice edit preview")).toBeTruthy();
    expect(screen.getByText(/Apply instruction:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Please rewrite this update into two short bullets.");
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("- Bullet one\n- Bullet two");
    });
    expect(screen.queryByText("Voice edit preview")).toBeNull();
  });

  it("lets the user undo a pending voice edit and keep the original draft", async () => {
    setupMockStore({ draftText: "Keep this draft as-is." });
    mockTranscribe.mockResolvedValueOnce({
      mode: "edit",
      text: "Edited draft that should be discarded.",
      rawText: "rewrite this",
      instructionText: "rewrite this",
      backend: "openai",
      enhanced: true,
    });

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Voice input"));

    await screen.findByText("Voice edit preview");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => {
      expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Keep this draft as-is.");
    });
    expect(screen.queryByText("Voice edit preview")).toBeNull();
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

describe("Composer image attachments", () => {
  it("attaches selected image files through the upload input", async () => {
    const { container } = render(<Composer sessionId="s1" />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(fileInput, { target: { files: [makeImageFile("upload.png")] } });

    await waitFor(() => {
      expect(screen.getByAltText("upload.png")).toBeTruthy();
    });
  });

  it("attaches pasted images and prevents the browser paste default", async () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    const imageFile = makeImageFile("clipboard.png");
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            type: imageFile.type,
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    fireEvent(textarea, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(container.querySelector('img[alt^="pasted-"]')).toBeTruthy();
    });
  });

  it("attaches dropped images inside the composer instead of letting the browser navigate", async () => {
    render(<Composer sessionId="s1" />);
    const inputCard = screen.getByTestId("composer-input-card");
    const imageFile = makeImageFile("drop.png");
    const dataTransfer = makeImageDataTransfer(imageFile);

    const dragOverEvent = createEvent.dragOver(inputCard, { dataTransfer });
    fireEvent(inputCard, dragOverEvent);

    expect(dragOverEvent.defaultPrevented).toBe(true);
    expect(screen.getByText("Drop images to attach")).toBeTruthy();

    const dropEvent = createEvent.drop(inputCard, { dataTransfer });
    fireEvent(inputCard, dropEvent);

    expect(dropEvent.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(screen.getByAltText("drop.png")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByText("Drop images to attach")).toBeNull();
    });
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
    expect(mockRequestBottomAlignOnNextUserMessage).toHaveBeenCalledWith("s1");
  });

  it("pressing Shift+Enter does NOT send the message", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "line 1" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("pressing Enter still sends on narrow desktop layouts", () => {
    setViewportWidth(500);
    mediaState.touchDevice = false;
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "send from side panel" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "send from side panel",
    }));
  });

  it("keeps the desktop composer layout when zoom makes the effective width wide enough", () => {
    setViewportWidth(720);
    setupMockStore({ zoomLevel: 0.8 });
    render(<Composer sessionId="s1" />);

    expect(screen.queryByText("Type a message...")).toBeNull();
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
        selection: {
          absolutePath: "/test/web/src/App.tsx",
          startLine: 42,
          endLine: 44,
          lineCount: 3,
        },
        updatedAt: 1,
        sourceId: "vscode:window-1",
        sourceType: "vscode-window",
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
        absolutePath: "/test/web/src/App.tsx",
        relativePath: "web/src/App.tsx",
        displayPath: "App.tsx",
        startLine: 42,
        endLine: 44,
        lineCount: 3,
      },
    }));
  });

  it("does not send VS Code metadata when there is no selection", () => {
    setupMockStore({
      vscodeSelectionContext: {
        selection: null,
        updatedAt: 2,
        sourceId: "vscode:window-1",
        sourceType: "vscode-window",
      },
    });
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

  it("falls back to the absolute path when the selection is outside the session root", () => {
    setupMockStore({
      session: {
        cwd: "/test/project-a",
        repo_root: "/test/project-a",
      },
      vscodeSelectionContext: {
        selection: {
          absolutePath: "/test/project-b/src/Other.ts",
          startLine: 7,
          endLine: 9,
          lineCount: 3,
        },
        updatedAt: 1,
        sourceId: "vscode:window-2",
        sourceType: "vscode-window",
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "check this external file" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "check this external file",
      vscodeSelection: {
        absolutePath: "/test/project-b/src/Other.ts",
        relativePath: "/test/project-b/src/Other.ts",
        displayPath: "/test/project-b/src/Other.ts",
        startLine: 7,
        endLine: 9,
        lineCount: 3,
      },
    }));
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
        selection: {
          absolutePath: "/test/web/src/components/Composer.tsx",
          startLine: 12,
          endLine: 14,
          lineCount: 3,
        },
        updatedAt: 1,
        sourceId: "vscode:window-3",
        sourceType: "vscode-window",
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

  it("requests Codex skills when the connected session has none, then renders them after the server updates state", async () => {
    setupMockStore({
      session: {
        backend_type: "codex",
        slash_commands: [],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);

    await waitFor(() => {
      expect(mockRefreshSessionSkills).toHaveBeenCalledWith("s1");
    });

    const sessions = mockStoreState.sessions as Map<string, SessionState>;
    sessions.set("s1", makeSession({
      backend_type: "codex",
      slash_commands: [],
      skills: ["review"],
    }));
    notifyMockStore();

    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "/rev" } });

    expect(screen.getByText("/review")).toBeTruthy();
  });

  it("slash menu still opens for Codex local slash commands when server commands are empty", () => {
    setupMockStore({
      session: {
        backend_type: "codex",
        slash_commands: [],
        skills: [],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    expect(screen.getByText("/plan")).toBeTruthy();
    expect(screen.getByText("/suggest")).toBeTruthy();
    expect(screen.getByText("/accept-edits")).toBeTruthy();
    expect(screen.getByText("/auto")).toBeTruthy();
    expect(screen.getByText("/compact")).toBeTruthy();
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
