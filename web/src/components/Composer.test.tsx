// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Profiler } from "react";
import { render, screen, fireEvent, createEvent, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionState } from "../../server/session-types.js";
import type { VoiceTranscriptionResult } from "../api.js";
import type { ChatMessage, QuestmasterTask, SdkSessionInfo } from "../types.js";

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
    matches: query === "(hover: none) and (pointer: coarse)" ? mediaState.touchDevice : false,
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
const mockTranscribe = vi
  .fn()
  .mockResolvedValue({ mode: "dictation", text: "transcribed text", backend: "openai", enhanced: false });
const mockGetBackendModels = vi.fn().mockResolvedValue([]);
const mockGetSettings = vi.fn().mockResolvedValue({ claudeDefaultModel: "" });
const mockUpdateSettings = vi.fn().mockResolvedValue({});
const mockRefreshSessionSkills = vi.fn().mockResolvedValue({ ok: true, skills: [] });
const mockPrepareUserMessageImages = vi.fn();
const mockDeletePreparedUserMessageImage = vi.fn().mockResolvedValue({ ok: true });

// Build a controllable mock store state
let mockStoreState: Record<string, unknown> = {};

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

vi.mock("../api.js", () => ({
  api: {
    gitPull: vi.fn().mockResolvedValue({ success: true, output: "", git_ahead: 0, git_behind: 0 }),
    getBackendModels: (...args: unknown[]) => mockGetBackendModels(...args),
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    refreshSessionSkills: (...args: unknown[]) => mockRefreshSessionSkills(...args),
    prepareUserMessageImages: (...args: unknown[]) => mockPrepareUserMessageImages(...args),
    deletePreparedUserMessageImage: (...args: unknown[]) => mockDeletePreparedUserMessageImage(...args),
    transcribe: (...args: unknown[]) => mockTranscribe(...args),
  },
}));

const mockVoiceState = {
  isSupportedOverride: null as boolean | null,
  isRecordingOverride: null as boolean | null,
  isPreparingOverride: null as boolean | null,
  isTranscribingOverride: null as boolean | null,
  unsupportedReasonOverride: null as
    | "insecure-context"
    | "missing-media-devices"
    | "missing-media-recorder"
    | "unsupported-environment"
    | null,
  unsupportedMessageOverride: null as string | null,
  onAudioReady: null as ((blob: Blob) => void | Promise<void>) | null,
  warmMicrophone: vi.fn(),
  toggleRecording: vi.fn(),
  cancelRecording: vi.fn(),
};

vi.mock("../hooks/useVoiceInput.js", async () => {
  const React = await import("react");
  return {
    useVoiceInput: (options: { onAudioReady?: (blob: Blob) => void | Promise<void> } = {}) => {
      mockVoiceState.onAudioReady = options.onAudioReady ?? null;
      const isSupported = mockVoiceState.isSupportedOverride ?? window.isSecureContext !== false;
      const unsupportedReason = isSupported
        ? null
        : (mockVoiceState.unsupportedReasonOverride ??
          (window.isSecureContext === false ? "insecure-context" : "unsupported-environment"));
      const unsupportedMessage = isSupported
        ? null
        : (mockVoiceState.unsupportedMessageOverride ??
          (unsupportedReason === "insecure-context"
            ? "Voice input requires HTTPS or localhost in this browser."
            : "Voice input is unavailable."));
      // Use real React state so onAudioReady can drive re-renders for error/isTranscribing
      const [error, setError] = React.useState<string | null>(null);
      const [isTranscribing, setIsTranscribing] = React.useState(false);
      const [transcriptionPhase, setTranscriptionPhase] = React.useState<string | null>(null);
      const resolvedIsRecording = mockVoiceState.isRecordingOverride ?? false;
      const resolvedIsPreparing = mockVoiceState.isPreparingOverride ?? false;
      const resolvedIsTranscribing = mockVoiceState.isTranscribingOverride ?? isTranscribing;
      return {
        isRecording: resolvedIsRecording,
        isPreparing: resolvedIsPreparing,
        isSupported,
        unsupportedReason,
        unsupportedMessage,
        isTranscribing: resolvedIsTranscribing,
        transcriptionPhase,
        error,
        volumeLevel: 0,
        setIsTranscribing,
        setTranscriptionPhase,
        setError,
        startRecording: vi.fn(),
        stopRecording: vi.fn(),
        toggleRecording: mockVoiceState.toggleRecording.mockImplementation(() =>
          options.onAudioReady?.(new Blob(["voice"], { type: "audio/webm" })),
        ),
        cancelRecording: mockVoiceState.cancelRecording,
        warmMicrophone: mockVoiceState.warmMicrophone,
      };
    },
  };
});

// Mock useStore as a function that takes a selector
const mockAppendMessage = vi.fn();
const mockUpdateSession = vi.fn();
const mockSetPreviousPermissionMode = vi.fn();
const mockSetSessionPreview = vi.fn();
const mockSetAskPermission = vi.fn();
const mockRequestBottomAlignOnNextUserMessage = vi.fn();

// Shared listener set for mock store reactivity
const mockStoreListeners = new Set<{
  getSelected: () => unknown;
  lastSelectedRef: { current: unknown };
  notify: () => void;
}>();
function notifyMockStore() {
  mockStoreListeners.forEach((listener) => {
    const nextSelected = listener.getSelected();
    if (!Object.is(nextSelected, listener.lastSelectedRef.current)) {
      listener.lastSelectedRef.current = nextSelected;
      listener.notify();
    }
  });
}

vi.mock("../store.js", async () => {
  const React = await import("react");
  // Create a mock store function that acts like zustand's useStore with subscribe support
  const useStore: any = (selector: (state: Record<string, unknown>) => unknown) => {
    const selectorRef = React.useRef(selector);
    selectorRef.current = selector;
    const selected = selector(mockStoreState);
    const lastSelectedRef = React.useRef(selected);
    lastSelectedRef.current = selected;
    const [, forceUpdate] = React.useReducer((c: number) => c + 1, 0);
    React.useEffect(() => {
      const listener = {
        getSelected: () => selectorRef.current(mockStoreState),
        lastSelectedRef,
        notify: forceUpdate,
      };
      mockStoreListeners.add(listener);
      return () => {
        mockStoreListeners.delete(listener);
      };
    }, []);
    return selected;
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

function makeQuest(overrides: Partial<QuestmasterTask> & { questId: string; title: string }): QuestmasterTask {
  const { questId, title, ...rest } = overrides;
  return {
    id: `${questId}-v1`,
    version: 1,
    questId,
    title,
    description: "",
    status: "refined",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...rest,
  } as QuestmasterTask;
}

function makeSdkSession(
  overrides: Partial<SdkSessionInfo> & { sessionId: string; sessionNum: number },
): SdkSessionInfo {
  const { sessionId, sessionNum, ...rest } = overrides;
  return {
    sessionId,
    sessionNum,
    state: "connected",
    cwd: "/test",
    createdAt: 1,
    ...rest,
  };
}

function makeMessage(overrides: Partial<ChatMessage> & { id: string; content: string }): ChatMessage {
  const { id, content, ...rest } = overrides;
  return {
    id,
    role: "user",
    content,
    timestamp: 1,
    ...rest,
  };
}

function setupMockStore(
  overrides: {
    isConnected?: boolean;
    sessionStatus?: "idle" | "running" | "compacting" | null;
    session?: Partial<SessionState>;
    draftText?: string;
    draft?: { text: string; images: unknown[] };
    zoomLevel?: number;
    sdkSessionTotals?: { added: number; removed: number };
    sdkSessions?: SdkSessionInfo[];
    quests?: QuestmasterTask[];
    sessionNames?: Map<string, string>;
    messages?: ChatMessage[];
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
  } = {},
) {
  const {
    isConnected = true,
    sessionStatus = "idle",
    session = {},
    draftText = "",
    draft,
    zoomLevel = 1,
    sdkSessionTotals,
    sdkSessions = [],
    quests = [],
    sessionNames = new Map(),
    messages = [],
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
    composerDrafts: draft
      ? new Map([["s1", draft]])
      : draftText
        ? new Map([["s1", { text: draftText, images: [] }]])
        : new Map(),
    replyContexts: new Map(),
    appendMessage: mockAppendMessage,
    updateSession: mockUpdateSession,
    setPreviousPermissionMode: mockSetPreviousPermissionMode,
    setSessionPreview: mockSetSessionPreview,
    setAskPermission: mockSetAskPermission,
    requestBottomAlignOnNextUserMessage: mockRequestBottomAlignOnNextUserMessage,
    pendingUserUploads: new Map(),
    zoomLevel,
    vscodeSelectionContext,
    dismissedVsCodeSelectionKey: null,
    sdkSessions:
      sdkSessions.length > 0
        ? sdkSessions
        : sdkSessionTotals
          ? [
              {
                sessionId: "s1",
                totalLinesAdded: sdkSessionTotals.added,
                totalLinesRemoved: sdkSessionTotals.removed,
              },
            ]
          : [],
    quests,
    sessionNames,
    messages: new Map(messages.length > 0 ? [["s1", messages]] : []),
    setComposerDraft: vi.fn((sessionId: string, draft: { text: string; images: unknown[] }) => {
      (mockStoreState.composerDrafts as Map<string, unknown>).set(sessionId, draft);
      notifyMockStore();
    }),
    clearComposerDraft: vi.fn((sessionId: string) => {
      (mockStoreState.composerDrafts as Map<string, unknown>).delete(sessionId);
      notifyMockStore();
    }),
    addPendingUserUpload: vi.fn((sessionId: string, upload: unknown) => {
      const pending = (mockStoreState.pendingUserUploads as Map<string, unknown[]>) ?? new Map();
      const current = pending.get(sessionId) ?? [];
      pending.set(sessionId, [...current, upload]);
      mockStoreState.pendingUserUploads = pending;
      notifyMockStore();
    }),
    updatePendingUserUpload: vi.fn((sessionId: string, uploadId: string, updater: (upload: any) => any) => {
      const pending = (mockStoreState.pendingUserUploads as Map<string, any[]>) ?? new Map();
      const current = pending.get(sessionId) ?? [];
      pending.set(
        sessionId,
        current.map((upload) => (upload.id === uploadId ? updater(upload) : upload)),
      );
      mockStoreState.pendingUserUploads = pending;
      notifyMockStore();
    }),
    removePendingUserUpload: vi.fn((sessionId: string, uploadId: string) => {
      const pending = (mockStoreState.pendingUserUploads as Map<string, any[]>) ?? new Map();
      const current = pending.get(sessionId) ?? [];
      const next = current.filter((upload) => upload.id !== uploadId);
      if (next.length > 0) pending.set(sessionId, next);
      else pending.delete(sessionId);
      mockStoreState.pendingUserUploads = pending;
      notifyMockStore();
    }),
    consumePendingUserUpload: vi.fn((sessionId: string, uploadId: string) => {
      const pending = (mockStoreState.pendingUserUploads as Map<string, any[]>) ?? new Map();
      const current = pending.get(sessionId) ?? [];
      let consumed: any = null;
      const next = current.filter((upload) => {
        if (upload.id !== uploadId) return true;
        consumed = upload;
        return false;
      });
      if (next.length > 0) pending.set(sessionId, next);
      else pending.delete(sessionId);
      mockStoreState.pendingUserUploads = pending;
      notifyMockStore();
      return consumed;
    }),
    setReplyContext: vi.fn(
      (
        sessionId: string,
        context: {
          messageId: string;
          previewText: string;
        } | null,
      ) => {
        const replyContexts = mockStoreState.replyContexts as Map<string, { messageId: string; previewText: string }>;
        if (context) {
          replyContexts.set(sessionId, context);
        } else {
          replyContexts.delete(sessionId);
        }
        notifyMockStore();
      },
    ),
    dismissVsCodeSelection: vi.fn((key: string | null) => {
      mockStoreState.dismissedVsCodeSelectionKey = key;
      notifyMockStore();
    }),
    collapsibleTurnIds: new Map(),
    turnActivityOverrides: new Map(),
    collapseAllTurnActivity: vi.fn(),
    pendingPermissions: new Map(),
    removePermission: vi.fn(),
    diffFileStats: new Map(),
    focusComposer: vi.fn(),
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

function expectNoOverflowHiddenAncestorWithin(node: HTMLElement, stopAt: HTMLElement) {
  let current: HTMLElement | null = node.parentElement;
  while (current && current !== stopAt) {
    expect(current.className).not.toContain("overflow-hidden");
    current = current.parentElement;
  }
  expect(current).toBe(stopAt);
}

function makeImageFile(name: string, type = "image/png") {
  return new File(["fake-image-bytes"], name, { type });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  mockVoiceState.isRecordingOverride = null;
  mockVoiceState.isPreparingOverride = null;
  mockVoiceState.isTranscribingOverride = null;
  mockVoiceState.unsupportedReasonOverride = null;
  mockVoiceState.unsupportedMessageOverride = null;
  mockVoiceState.onAudioReady = null;
  mockVoiceState.warmMicrophone.mockReset();
  mockVoiceState.toggleRecording.mockReset();
  mockVoiceState.cancelRecording.mockReset();
  mockTranscribe.mockResolvedValue({ mode: "dictation", text: "transcribed text", backend: "openai", enhanced: false });
  mockGetBackendModels.mockResolvedValue([]);
  mockGetSettings.mockResolvedValue({ claudeDefaultModel: "" });
  mockUpdateSettings.mockResolvedValue({});
  mockRefreshSessionSkills.mockResolvedValue({ ok: true, skills: [] });
  mockPrepareUserMessageImages.mockReset();
  mockDeletePreparedUserMessageImage.mockReset();
  mockDeletePreparedUserMessageImage.mockResolvedValue({ ok: true });
  mockPrepareUserMessageImages.mockImplementation(
    async (sessionId: string, images: Array<{ mediaType: string }>, _signal?: AbortSignal) => ({
      imageRefs: images.map((image, index) => ({
        imageId: `img-${index + 1}`,
        media_type: image.mediaType,
      })),
      paths: images.map((_image, index) => `/Users/test/.companion/images/${sessionId}/img-${index + 1}.orig.png`),
      attachmentAnnotation: images
        .map(
          (_image, index) =>
            `Attachment ${index + 1}: /Users/test/.companion/images/${sessionId}/img-${index + 1}.orig.png`,
        )
        .join("\n"),
    }),
  );
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

  it("disables browser spellcheck on the composer textarea", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea");

    // Regression coverage for q-352: spellcheck must stay off consistently so
    // the browser does not re-enable per-keystroke decoration in some states.
    expect(textarea?.getAttribute("spellcheck")).toBe("false");
  });

  it("does not rerender for unrelated sessions and sdkSessions churn", async () => {
    setupMockStore({
      session: { git_branch: "main", model: "claude-sonnet-4-5-20250929" },
      sdkSessionTotals: { added: 5, removed: 2 },
    });

    const sessionsMap = mockStoreState.sessions as Map<string, SessionState>;
    sessionsMap.set("s2", makeSession({ session_id: "s2", git_branch: "feature/initial" }));
    mockStoreState.sdkSessions = [
      ...(mockStoreState.sdkSessions as Array<{
        sessionId: string;
        totalLinesAdded: number;
        totalLinesRemoved: number;
      }>),
      { sessionId: "s2", totalLinesAdded: 1, totalLinesRemoved: 1 },
    ];

    let composerCommits = 0;

    render(
      <Profiler id="composer" onRender={() => composerCommits++}>
        <Composer sessionId="s1" />
      </Profiler>,
    );

    // Let mount-time async hydration settle before capturing the baseline.
    await act(async () => {
      await Promise.resolve();
    });

    // After mount-time hydration settles, unrelated session churn must not
    // commit the active Composer subtree at all.
    const baselineCommits = composerCommits;
    expect(baselineCommits).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("sonnet-4.5")).toBeTruthy();

    // Regression coverage for q-352: unrelated session-list polling churn
    // should not commit the active Composer subtree anymore.
    act(() => {
      sessionsMap.set("s2", makeSession({ session_id: "s2", git_branch: "feature/updated", model: "gpt-5.4" }));
      mockStoreState.sdkSessions = [
        {
          sessionId: "s1",
          totalLinesAdded: 5,
          totalLinesRemoved: 2,
        },
        {
          sessionId: "s2",
          totalLinesAdded: 99,
          totalLinesRemoved: 42,
        },
      ];
      notifyMockStore();
    });

    expect(composerCommits).toBe(baselineCommits);
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("sonnet-4.5")).toBeTruthy();
    expect(screen.queryByText("+99")).toBeNull();
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

  it("renders the composer footer after the textarea and keeps session metadata there", () => {
    setupMockStore({
      session: {
        backend_type: "codex",
        permissionMode: "plan",
        git_branch: "feature/composer-footer",
        model: "gpt-5.4",
        codex_reasoning_effort: "high",
      },
    });

    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea");
    const footer = screen.getByTestId("composer-footer-toolbar");
    const meta = screen.getByTestId("composer-footer-meta");
    const sendButton = screen.getByTitle("Send message");
    const modeToggle = screen.getByTitle("Plan mode: agent creates a plan before executing (Shift+Tab to toggle)");

    expect(textarea).toBeTruthy();
    expect(Boolean(textarea && textarea.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(sendButton.closest('[data-testid="composer-footer-toolbar"]')).toBe(footer);
    expect(modeToggle.closest('[data-testid="composer-footer-toolbar"]')).toBe(footer);
    expect(within(meta).getByText("feature/composer-footer")).toBeTruthy();
    expect(within(meta).getByText("gpt-5.4")).toBeTruthy();
    expect(within(meta).getByText("high")).toBeTruthy();
  });

  it("keeps the moved footer popovers outside overflow-hidden ancestors", async () => {
    setupMockStore({
      session: {
        git_branch: "main",
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "acceptEdits",
      },
    });

    render(<Composer sessionId="s1" />);

    const footer = screen.getByTestId("composer-footer-toolbar");
    await userEvent.click(screen.getByTitle("Permissions: asking before tool use (click to change)"));
    expectNoOverflowHiddenAncestorWithin(screen.getByTestId("composer-permission-popover"), footer);

    await userEvent.click(screen.getByTitle("Model: claude-sonnet-4-5-20250929 (click to change)"));
    expectNoOverflowHiddenAncestorWithin(screen.getByTestId("composer-model-menu"), footer);
  });

  it("keeps the moved codex reasoning menu outside overflow-hidden ancestors", async () => {
    setupMockStore({
      session: {
        backend_type: "codex",
        git_branch: "feature/reasoning-menu",
        model: "gpt-5.4",
        permissionMode: "plan",
      },
    });

    render(<Composer sessionId="s1" />);

    const footer = screen.getByTestId("composer-footer-toolbar");
    await userEvent.click(screen.getByTitle("Reasoning effort (relaunch required)"));
    expectNoOverflowHiddenAncestorWithin(screen.getByTestId("composer-reasoning-menu"), footer);
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

  it("keeps the mobile composer expanded once voice capture becomes active", () => {
    vi.useFakeTimers();
    try {
      setViewportWidth(500);
      mediaState.touchDevice = true;

      const { rerender } = render(<Composer sessionId="s1" />);

      fireEvent.click(screen.getAllByLabelText("Voice input")[0]);
      mockVoiceState.isPreparingOverride = true;
      rerender(<Composer sessionId="s1" />);

      act(() => {
        vi.advanceTimersByTime(350);
      });

      expect(screen.getByText("Preparing mic...")).toBeTruthy();
      expect(screen.queryByText("Type a message...")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the collapsed mobile mic interactive while the session is streaming", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    setupMockStore({ sessionStatus: "running" });

    render(<Composer sessionId="s1" />);

    const voiceButton = screen.getAllByLabelText("Voice input")[0];
    expect(voiceButton.hasAttribute("disabled")).toBe(false);
    expect(voiceButton.getAttribute("aria-disabled")).toBe("false");
    expect(voiceButton.className).not.toContain("opacity-30");
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

  it("reveals and keeps the mobile composer open while replying to a message", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;

    render(<Composer sessionId="s1" />);

    // Regression coverage for q-463: a reply picked from the message actions
    // must force the full composer open and keep the reply target visible.
    expect(screen.getByText("Type a message...")).toBeTruthy();

    act(() => {
      (
        mockStoreState.setReplyContext as (
          sessionId: string,
          context: { messageId: string; previewText: string } | null,
        ) => void
      )("s1", {
        messageId: "msg-1",
        previewText: "Good plan from #618. One thing to clarify before approving.",
      });
    });

    expect(screen.queryByText("Type a message...")).toBeNull();
    expect(screen.getByText("Good plan from #618. One thing to clarify before approving.")).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByText("Type a message...")).toBeNull();
    expect(screen.getByText("Good plan from #618. One thing to clarify before approving.")).toBeTruthy();
  });

  it("allows the mobile composer to collapse again after a notification reply is cleared", () => {
    vi.useFakeTimers();
    try {
      setViewportWidth(500);
      mediaState.touchDevice = true;

      render(<Composer sessionId="s1" />);

      // Notification replies also use replyContext; clearing that context should
      // release the expansion lock and restore the compact idle bar.
      act(() => {
        (
          mockStoreState.setReplyContext as (
            sessionId: string,
            context: { messageId: string; previewText: string } | null,
          ) => void
        )("s1", {
          messageId: "notif-1",
          previewText: "Approve q-460 plan? Re-run all 4 datasets before review.",
        });
      });

      expect(screen.queryByText("Type a message...")).toBeNull();
      expect(screen.getByText("Approve q-460 plan? Re-run all 4 datasets before review.")).toBeTruthy();

      fireEvent.click(screen.getByLabelText("Cancel reply"));

      act(() => {
        vi.advanceTimersByTime(350);
      });

      expect(screen.getByText("Type a message...")).toBeTruthy();
      expect(screen.queryByText("Approve q-460 plan? Re-run all 4 datasets before review.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it("waits for the initial settings fetch before the first non-empty recording so the persisted mode wins", async () => {
    setupMockStore({ draftText: "Keep this draft" });
    const settingsLoad = deferred<{
      claudeDefaultModel: string;
      transcriptionConfig: { voiceCaptureMode: "append" };
    }>();
    mockGetSettings.mockReturnValueOnce(settingsLoad.promise);

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Voice input"));

    expect(mockVoiceState.toggleRecording).not.toHaveBeenCalled();

    settingsLoad.resolve({
      claudeDefaultModel: "",
      transcriptionConfig: { voiceCaptureMode: "append" },
    });

    await waitFor(() => {
      expect(mockVoiceState.toggleRecording).toHaveBeenCalledTimes(1);
      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.objectContaining({
          mode: "append",
          sessionId: "s1",
          composerText: "Keep this draft",
        }),
      );
    });
    expect(mockGetSettings).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated pre-hydration mic clicks so only one recording start survives", async () => {
    setupMockStore({ draftText: "Keep this draft" });
    const settingsLoad = deferred<{
      claudeDefaultModel: string;
      transcriptionConfig: { voiceCaptureMode: "append" };
    }>();
    mockGetSettings.mockReturnValueOnce(settingsLoad.promise);

    render(<Composer sessionId="s1" />);
    const voiceButton = screen.getByLabelText("Voice input");
    fireEvent.click(voiceButton);
    fireEvent.click(voiceButton);

    expect(mockVoiceState.toggleRecording).not.toHaveBeenCalled();

    settingsLoad.resolve({
      claudeDefaultModel: "",
      transcriptionConfig: { voiceCaptureMode: "append" },
    });

    await waitFor(() => {
      expect(mockVoiceState.toggleRecording).toHaveBeenCalledTimes(1);
      expect(mockTranscribe).toHaveBeenCalledTimes(1);
      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.objectContaining({
          mode: "append",
          sessionId: "s1",
          composerText: "Keep this draft",
        }),
      );
    });
    expect(mockGetSettings).toHaveBeenCalledTimes(1);
  });

  it("hydrates the persisted voice mode for Codex sessions too", async () => {
    setupMockStore({
      draftText: "Codex should respect append",
      session: { backend_type: "codex" },
    });
    mockGetSettings.mockResolvedValueOnce({
      claudeDefaultModel: "",
      transcriptionConfig: { voiceCaptureMode: "append" },
    });

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.objectContaining({
          mode: "append",
          sessionId: "s1",
          composerText: "Codex should respect append",
        }),
      );
    });
    expect(mockGetSettings).toHaveBeenCalledTimes(1);
  });

  it("shows a preparation state before the transcription stream switches to STT", async () => {
    // q-485/q-566: keep the pre-response wait visible, but avoid claiming the
    // whole period is only network upload work.
    // immediately claiming transcription is already in progress.
    let resolveTranscription: ((value: VoiceTranscriptionResult) => void) | undefined;
    mockTranscribe.mockImplementationOnce(
      () =>
        new Promise<VoiceTranscriptionResult>((resolve) => {
          resolveTranscription = resolve;
        }),
    );

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByText("Preparing transcript...")).toBeTruthy();
    });

    if (!resolveTranscription) throw new Error("mock transcription resolver was not initialized");
    resolveTranscription({ mode: "dictation", text: "done", backend: "openai", enhanced: false });
    await waitFor(() => {
      expect(screen.queryByText("Preparing transcript...")).toBeNull();
    });
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

describe("Composer voice keyboard prewarm", () => {
  it("does not pre-warm when Shift is used for uppercase typing", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    textarea.focus();
    fireEvent.keyDown(document, { key: "Shift" });
    fireEvent.keyDown(document, { key: "A", shiftKey: true });
    fireEvent.keyUp(document, { key: "A", shiftKey: true });
    fireEvent.change(textarea, { target: { value: "A" } });
    fireEvent.keyUp(document, { key: "Shift" });

    expect(mockVoiceState.warmMicrophone).not.toHaveBeenCalled();
    expect(mockVoiceState.toggleRecording).not.toHaveBeenCalled();
  });

  it("pre-warms on the first clean standalone Shift tap and records on the second", () => {
    vi.useFakeTimers();
    try {
      render(<Composer sessionId="s1" />);

      fireEvent.keyDown(document, { key: "Shift" });
      fireEvent.keyUp(document, { key: "Shift" });
      expect(mockVoiceState.warmMicrophone).toHaveBeenCalledTimes(1);
      expect(mockVoiceState.toggleRecording).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);

      fireEvent.keyDown(document, { key: "Shift" });
      fireEvent.keyUp(document, { key: "Shift" });
      expect(mockVoiceState.toggleRecording).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates the armed first Shift tap when non-Shift typing happens between taps", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<Composer sessionId="s1" />);
      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

      textarea.focus();

      fireEvent.keyDown(document, { key: "Shift" });
      fireEvent.keyUp(document, { key: "Shift" });
      expect(mockVoiceState.warmMicrophone).toHaveBeenCalledTimes(1);
      expect(mockVoiceState.toggleRecording).not.toHaveBeenCalled();

      fireEvent.keyDown(document, { key: "a" });
      fireEvent.keyUp(document, { key: "a" });
      fireEvent.change(textarea, { target: { value: "a" } });

      vi.advanceTimersByTime(200);

      fireEvent.keyDown(document, { key: "Shift" });
      fireEvent.keyUp(document, { key: "Shift" });

      expect(mockVoiceState.toggleRecording).not.toHaveBeenCalled();
      expect(mockVoiceState.warmMicrophone).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
  it("blocks send as soon as an image is attached, before local file reading finishes", async () => {
    const previousFileReader = window.FileReader;
    const pendingReaders: Array<{
      complete: () => void;
    }> = [];
    Object.defineProperty(window, "FileReader", {
      configurable: true,
      writable: true,
      value: class MockFileReader {
        result: string | ArrayBuffer | null = null;
        onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
        onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

        readAsDataURL(file: Blob) {
          pendingReaders.push({
            complete: () => {
              this.result = `data:${(file as File).type || "image/png"};base64,ZmFrZQ==`;
              this.onload?.call(this as unknown as FileReader, new ProgressEvent("load") as ProgressEvent<FileReader>);
            },
          });
        }
      },
    });

    try {
      const { container } = render(<Composer sessionId="s1" />);
      const textarea = container.querySelector("textarea")!;
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      fireEvent.change(textarea, { target: { value: "inspect this screenshot" } });
      fireEvent.change(fileInput, { target: { files: [makeImageFile("slow.png")] } });

      await waitFor(() => {
        expect(screen.getByText("Preparing 1 image before upload.")).toBeTruthy();
        expect(screen.getAllByText("Preparing...").length).toBeGreaterThan(0);
      });

      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(mockSendToSession).not.toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({
          type: "user_message",
          content: "inspect this screenshot",
        }),
      );

      await act(async () => {
        pendingReaders[0]?.complete();
        await Promise.resolve();
      });
    } finally {
      Object.defineProperty(window, "FileReader", {
        configurable: true,
        writable: true,
        value: previousFileReader,
      });
    }
  });

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

  it("retries a real local read failure and resumes normal upload preparation", async () => {
    const previousFileReader = window.FileReader;
    let readAttempts = 0;
    Object.defineProperty(window, "FileReader", {
      configurable: true,
      writable: true,
      value: class MockFileReader {
        result: string | ArrayBuffer | null = null;
        onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
        onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

        readAsDataURL(file: Blob) {
          readAttempts += 1;
          if (readAttempts === 1) {
            this.onerror?.call(this as unknown as FileReader, new ProgressEvent("error") as ProgressEvent<FileReader>);
            return;
          }
          this.result = `data:${(file as File).type || "image/png"};base64,ZmFrZQ==`;
          this.onload?.call(this as unknown as FileReader, new ProgressEvent("load") as ProgressEvent<FileReader>);
        }
      },
    });

    try {
      const { container } = render(<Composer sessionId="s1" />);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      fireEvent.change(fileInput, { target: { files: [makeImageFile("read-fail.png")] } });

      await waitFor(() => {
        expect(screen.getByText("Upload failed")).toBeTruthy();
      });
      expect(mockPrepareUserMessageImages).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Retry"));

      await waitFor(() => {
        expect(readAttempts).toBe(2);
        expect(mockPrepareUserMessageImages).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(screen.getByText("Ready")).toBeTruthy();
      });
    } finally {
      Object.defineProperty(window, "FileReader", {
        configurable: true,
        writable: true,
        value: previousFileReader,
      });
    }
  });
});

// ─── Sending messages ────────────────────────────────────────────────────────

describe("Composer sending messages", () => {
  it("pressing Enter sends the message via sendToSession", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "test message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
        content: "test message",
        session_id: "s1",
      }),
    );
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

    expect(mockSendToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
        content: "send from side panel",
      }),
    );
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

    expect(mockSendToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
        content: "click send",
      }),
    );
  });

  it("uploads image attachments immediately and only enables send after preparation completes", async () => {
    const prepared = deferred<{
      imageRefs: Array<{ imageId: string; media_type: string }>;
      paths: string[];
      attachmentAnnotation: string;
    }>();
    mockPrepareUserMessageImages.mockReturnValue(prepared.promise);

    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(textarea, { target: { value: "inspect this screenshot" } });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [makeImageFile("screenshot.png")] } });
    });
    expect(mockPrepareUserMessageImages).toHaveBeenCalledWith(
      "s1",
      [
        expect.objectContaining({
          mediaType: "image/png",
          data: expect.any(String),
        }),
      ],
      expect.any(AbortSignal),
    );
    await waitFor(() => {
      expect(screen.getByAltText("screenshot.png")).toBeTruthy();
    });
    expect(screen.getByText("Uploading...")).toBeTruthy();
    expect(screen.getByTitle("1 image still uploading.")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
      }),
    );

    await act(async () => {
      prepared.resolve({
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
        paths: ["/Users/test/.companion/images/s1/img-1.orig.png"],
        attachmentAnnotation:
          "\n[📎 Image attachments -- read these files with the Read tool before responding:\nAttachment 1: /Users/test/.companion/images/s1/img-1.orig.png]",
      });
      await prepared.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("Ready")).toBeTruthy();
      expect(screen.getByTitle("Send message")).toBeTruthy();
    });

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(mockSendToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
        content: "inspect this screenshot",
        deliveryContent: expect.stringContaining("Attachment 1: /Users/test/.companion/images/s1/img-1.orig.png"),
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
        session_id: "s1",
        client_msg_id: expect.any(String),
      }),
    );
  });

  it("blocks send on failed image preparation until the image is retried or removed", async () => {
    mockPrepareUserMessageImages.mockRejectedValueOnce(new Error("server rejected image")).mockResolvedValueOnce({
      imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
      paths: ["/Users/test/.companion/images/s1/img-1.orig.png"],
      attachmentAnnotation:
        "\n[📎 Image attachments -- read these files with the Read tool before responding:\nAttachment 1: /Users/test/.companion/images/s1/img-1.orig.png]",
    });

    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(textarea, { target: { value: "inspect this screenshot" } });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [makeImageFile("broken.png")] } });
    });

    await waitFor(() => {
      expect(screen.getByText("Upload failed")).toBeTruthy();
      expect(screen.getByText("server rejected image")).toBeTruthy();
    });
    expect(screen.getByText("Remove or retry 1 failed image before sending.")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
        content: "inspect this screenshot",
      }),
    );

    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => {
      expect(screen.getByText("Ready")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Send message"));
    expect(mockSendToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
        content: "inspect this screenshot",
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
      }),
    );
  });

  it("cleans up a prepared attachment when the user removes it before sending", async () => {
    const { container } = render(<Composer sessionId="s1" />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [makeImageFile("cleanup.png")] } });
    });

    await waitFor(() => {
      expect(screen.getByText("Ready")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Remove image cleanup.png"));

    await waitFor(() => {
      expect(mockDeletePreparedUserMessageImage).toHaveBeenCalledWith("s1", "img-1");
    });
  });

  it("cleans up a previously prepared attachment before retrying it", async () => {
    setupMockStore({
      draft: {
        text: "retry this image",
        images: [
          {
            id: "retry-1",
            name: "retry.png",
            base64: "ZmFrZQ==",
            mediaType: "image/png",
            status: "failed",
            error: "previous upload failed",
            prepared: {
              imageRef: { imageId: "img-stale", media_type: "image/png" },
              path: "/Users/test/.companion/images/s1/img-stale.orig.png",
            },
          },
        ],
      },
    });

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => {
      expect(mockDeletePreparedUserMessageImage).toHaveBeenCalledWith("s1", "img-stale");
      expect(mockPrepareUserMessageImages).toHaveBeenCalled();
    });
  });

  it("rejects a pending plan without sending a redundant interrupt before the new user message", () => {
    const removePermission = vi.fn();
    mockStoreState.pendingPermissions = new Map([
      [
        "s1",
        new Map([
          [
            "plan-1",
            {
              request_id: "plan-1",
              tool_name: "ExitPlanMode",
              input: { plan: "## Plan\n\n1. Review the fix" },
            },
          ],
        ]),
      ],
    ]);
    mockStoreState.removePermission = removePermission;

    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "new instructions" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // Regression coverage for q-337: a stale browser-side ExitPlanMode chip
    // must not emit its own bare interrupt and accidentally kill the fresh turn.
    expect(mockSendToSession).toHaveBeenNthCalledWith(1, "s1", {
      type: "permission_response",
      request_id: "plan-1",
      behavior: "deny",
      message: "Plan rejected — user sent a new message",
    });
    expect(mockSendToSession).toHaveBeenNthCalledWith(
      2,
      "s1",
      expect.objectContaining({
        type: "user_message",
        content: "new instructions",
        session_id: "s1",
      }),
    );
    expect(mockSendToSession).not.toHaveBeenCalledWith("s1", { type: "interrupt" });
    expect(removePermission).toHaveBeenCalledWith("s1", "plan-1");
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

    expect(mockSendToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
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
      }),
    );
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

    expect(mockSendToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
        content: "check this bug",
      }),
    );
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

    expect(mockSendToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
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
      }),
    );
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
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
      }),
    );
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
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
      }),
    );
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

  it("codex reasoning dropdown includes XHigh and sends xhigh", async () => {
    // Verifies the extra-high reasoning level is available in the composer menu.
    setupMockStore({
      session: {
        backend_type: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      },
    });
    render(<Composer sessionId="s1" />);

    const trigger = screen.getByTitle("Reasoning effort (relaunch required)");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByText("XHigh"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_codex_reasoning_effort",
      effort: "xhigh",
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
  it("renders the current VS Code selection as an attachment chip", () => {
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
    expect(screen.getByText("Composer.tsx:12-14")).toBeTruthy();
    expect(
      screen.getByTitle(
        "[user selection in VSCode: web/src/components/Composer.tsx lines 12-14] (this may or may not be relevant)",
      ),
    ).toBeTruthy();
  });

  it("keeps a dismissed selection hidden when the composer remounts", () => {
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
    const firstRender = render(<Composer sessionId="s1" />);

    fireEvent.click(screen.getByTitle("Dismiss selection"));

    expect(screen.queryByText("3 lines selected")).toBeNull();
    firstRender.unmount();

    render(<Composer sessionId="s1" />);
    expect(screen.queryByText("3 lines selected")).toBeNull();
  });

  it("shows the selection chip again when a fresh selection update arrives", () => {
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

    fireEvent.click(screen.getByTitle("Dismiss selection"));
    expect(screen.queryByText("3 lines selected")).toBeNull();

    act(() => {
      mockStoreState.vscodeSelectionContext = {
        selection: {
          absolutePath: "/test/web/src/components/Composer.tsx",
          startLine: 12,
          endLine: 14,
          lineCount: 3,
        },
        updatedAt: 2,
        sourceId: "vscode:window-3",
        sourceType: "vscode-window",
      };
      notifyMockStore();
    });

    expect(screen.getByText("3 lines selected")).toBeTruthy();
  });
});

// ─── Interrupt button ────────────────────────────────────────────────────────

describe("Composer interrupt button", () => {
  it("stop button shown when running with empty composer, no send button", () => {
    setupMockStore({ sessionStatus: "running" });
    render(<Composer sessionId="s1" />);

    // Unified button: empty composer + running → stop button
    expect(screen.getByTitle("Stop generation")).toBeTruthy();
    expect(screen.queryByTitle("Send message")).toBeNull();
  });

  it("interrupt button sends interrupt message", () => {
    setupMockStore({ sessionStatus: "running" });
    render(<Composer sessionId="s1" />);

    fireEvent.click(screen.getByTitle("Stop generation"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "interrupt" });
  });

  it("send button appears when session is idle, no stop button", () => {
    setupMockStore({ sessionStatus: "idle" });
    render(<Composer sessionId="s1" />);

    expect(screen.getByTitle("Send message")).toBeTruthy();
    // Unified button: stop button only shows when running + empty composer
    expect(screen.queryByTitle("Stop generation")).toBeNull();
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
    sessions.set(
      "s1",
      makeSession({
        backend_type: "codex",
        slash_commands: [],
        skills: ["review"],
      }),
    );
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

  it("double-prefixes slash-prefixed skill names from session data", () => {
    // Regression guard for q-269: slash menu entries are rendered as `/${name}`,
    // so changing a runtime skill name to `/port-changes` would surface
    // `//port-changes` instead of the intended `/port-changes`.
    setupMockStore({
      session: {
        slash_commands: [],
        skills: ["/port-changes"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "/" } });

    expect(screen.getByText("//port-changes")).toBeTruthy();
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

  it("slash menu opens when / is typed after whitespace mid-sentence", () => {
    // Validates inline slash trigger: q-579
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "hello /", selectionStart: "hello /".length } });

    expect(screen.getByText("/help")).toBeTruthy();
    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.getByText("/commit")).toBeTruthy();
  });

  it("selecting an inline slash command preserves surrounding text", () => {
    // Validates that command insertion replaces only the /query portion: q-579
    setupMockStore({
      session: {
        slash_commands: ["help", "clear"],
        skills: ["commit"],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "please run /cl", selectionStart: "please run /cl".length } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(textarea.value).toBe("please run /clear ");
  });
});

// ─── Dollar mention menu ─────────────────────────────────────────────────────

describe("Composer dollar mention menu", () => {
  it("opens with Codex skills and apps when typing $", () => {
    // Validates the Codex-style `$` mention picker combines skills and enabled apps.
    setupMockStore({
      session: {
        backend_type: "codex",
        skills: ["review"],
        skill_metadata: [
          {
            name: "review",
            path: "/Users/test/.codex/skills/review/SKILL.md",
            description: "Review code changes",
          },
        ],
        apps: [
          {
            id: "connector_google_drive",
            name: "Google Drive",
            description: "Search and edit Drive files",
          },
        ],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "$", selectionStart: 1 } });

    expect(screen.getByText("$review")).toBeTruthy();
    expect(screen.getByText("$Google Drive")).toBeTruthy();
    expect(screen.getByText("Review code changes")).toBeTruthy();
    expect(screen.getByText("Search and edit Drive files")).toBeTruthy();
  });

  it("filters app and skill mentions by the token after $", () => {
    // Validates `$` filtering works inside prose, not just at the start of the prompt.
    setupMockStore({
      session: {
        backend_type: "codex",
        skills: ["review"],
        apps: [
          {
            id: "connector_google_drive",
            name: "Google Drive",
            description: "Search and edit Drive files",
          },
        ],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "Use $goo", selectionStart: "Use $goo".length } });

    expect(screen.getByText("$Google Drive")).toBeTruthy();
    expect(screen.queryByText("$review")).toBeNull();
  });

  it("inserts a skill mention link when a metadata path is available", () => {
    // Codex can resolve `$skill` text itself, but inserting a `[$skill](path)` link
    // lets the backend attach a structured skill input item and avoid extra lookup.
    setupMockStore({
      session: {
        backend_type: "codex",
        skills: ["review"],
        skill_metadata: [
          {
            name: "review",
            path: "/Users/test/.codex/skills/review/SKILL.md",
            description: "Review code changes",
          },
        ],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Run $rev", selectionStart: "Run $rev".length } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(textarea.value).toBe("Run [$review](/Users/test/.codex/skills/review/SKILL.md) ");
  });

  it("inserts an app mention link when selecting an app", () => {
    // Validates app mentions serialize to the `app://` markdown form understood by Codex.
    setupMockStore({
      session: {
        backend_type: "codex",
        apps: [
          {
            id: "connector_google_drive",
            name: "Google Drive",
            description: "Search and edit Drive files",
          },
        ],
      },
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Use $goo", selectionStart: "Use $goo".length } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(textarea.value).toBe("Use [$google-drive](app://connector_google_drive) ");
  });
});

describe("Composer quest/session reference autocomplete", () => {
  it("shows quest title previews and inserts Takode quest links", () => {
    setupMockStore({
      quests: [makeQuest({ questId: "q-41", title: "Autocomplete ranking polish" })],
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: { value: "Please check q-4", selectionStart: "Please check q-4".length },
    });

    expect(screen.getByText("q-41")).toBeTruthy();
    expect(screen.getByText("Autocomplete ranking polish")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(textarea.value).toBe("Please check [q-41](quest:q-41) ");
  });

  it("shows session label previews and inserts Takode session links", () => {
    setupMockStore({
      sdkSessions: [makeSdkSession({ sessionId: "worker-1", sessionNum: 687 })],
      sessionNames: new Map([["worker-1", "Frontend worker"]]),
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: { value: "Hand off to #6", selectionStart: "Hand off to #6".length },
    });

    expect(screen.getByText("#687")).toBeTruthy();
    expect(screen.getByText("Frontend worker")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(textarea.value).toBe("Hand off to [#687](session:687) ");
  });

  it("replaces delimiter-prefixed quest triggers without leaving a stray leading bracket", () => {
    setupMockStore({
      quests: [makeQuest({ questId: "q-41", title: "Autocomplete ranking polish" })],
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: { value: "[q-4", selectionStart: "[q-4".length },
    });

    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(textarea.value).toBe("[q-41](quest:q-41) ");
  });

  it("replaces delimiter-prefixed session triggers without leaving a stray leading bracket", () => {
    setupMockStore({
      sdkSessions: [makeSdkSession({ sessionId: "worker-1", sessionNum: 687 })],
      sessionNames: new Map([["worker-1", "Frontend worker"]]),
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: { value: "[#6", selectionStart: "[#6".length },
    });

    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    expect(textarea.value).toBe("[#687](session:687) ");
  });

  it("boosts recently mentioned quests above newer ids", () => {
    setupMockStore({
      quests: [
        makeQuest({ questId: "q-12", title: "Recent quest" }),
        makeQuest({ questId: "q-88", title: "Higher numeric quest" }),
      ],
      messages: [
        makeMessage({ id: "m1", content: "Older reference to q-88" }),
        makeMessage({ id: "m2", content: "Most recent reference to [q-12](quest:q-12)" }),
      ],
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: { value: "Track q-", selectionStart: "Track q-".length },
    });

    const suggestions = Array.from(container.querySelectorAll("[data-reference-index]"));
    expect(suggestions).toHaveLength(2);
    expect(within(suggestions[0] as HTMLElement).getByText("q-12")).toBeTruthy();
  });

  it("boosts recently mentioned sessions above more active ones", () => {
    setupMockStore({
      sdkSessions: [
        makeSdkSession({ sessionId: "worker-recent", sessionNum: 12, lastActivityAt: 10 }),
        makeSdkSession({ sessionId: "worker-busy", sessionNum: 88, lastActivityAt: 1000 }),
      ],
      sessionNames: new Map([
        ["worker-recent", "Recent worker"],
        ["worker-busy", "Busy worker"],
      ]),
      messages: [makeMessage({ id: "m1", content: "Please sync with [#12](session:12) before merging." })],
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: { value: "Ping #", selectionStart: "Ping #".length },
    });

    const suggestions = Array.from(container.querySelectorAll("[data-reference-index]"));
    expect(suggestions).toHaveLength(2);
    expect(within(suggestions[0] as HTMLElement).getByText("#12")).toBeTruthy();
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

// ─── Transcription retry ────────────────────────────────────────────────────

describe("Composer transcription retry", () => {
  it("shows retry banner with error message when dictation transcription fails", async () => {
    // Simulate a transcription failure by rejecting the mock
    mockTranscribe.mockRejectedValueOnce(new Error("stream ended without transcription"));

    render(<Composer sessionId="s1" />);

    // Trigger voice recording -- toggleRecording calls onAudioReady with a blob
    fireEvent.click(screen.getByLabelText("Voice input"));

    // Wait for the retry banner to appear with the error message
    await waitFor(() => {
      expect(screen.getByText("stream ended without transcription")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByLabelText("Dismiss transcription error")).toBeTruthy();
  });

  it("retries transcription with the same audio blob on Retry click (dictation mode)", async () => {
    // First call fails, second succeeds
    mockTranscribe
      .mockRejectedValueOnce(new Error("server error"))
      .mockResolvedValueOnce({ mode: "dictation", text: "hello world", backend: "openai", enhanced: false });

    render(<Composer sessionId="s1" />);

    // Trigger recording (empty composer -> dictation mode)
    fireEvent.click(screen.getByLabelText("Voice input"));

    // Wait for retry banner
    await waitFor(() => {
      expect(screen.getByText("server error")).toBeTruthy();
    });

    // Click Retry
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // The second transcribe call should succeed and fill the textarea
    await waitFor(() => {
      expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello world");
    });

    // Retry banner should be gone
    expect(screen.queryByText("server error")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    // Both calls should have used the same audio blob
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    const blob1 = mockTranscribe.mock.calls[0][0] as Blob;
    const blob2 = mockTranscribe.mock.calls[1][0] as Blob;
    expect(blob1).toBe(blob2);
  });

  it("re-saves the blob for another retry when retry also fails", async () => {
    // Both calls fail
    mockTranscribe.mockRejectedValueOnce(new Error("timeout")).mockRejectedValueOnce(new Error("still broken"));

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByText("timeout")).toBeTruthy();
    });

    // First retry -- also fails
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("still broken")).toBeTruthy();
    });

    // Retry button is still available for another attempt
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("clears the retry banner when Dismiss is clicked", async () => {
    mockTranscribe.mockRejectedValueOnce(new Error("transcription failed"));

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByText("transcription failed")).toBeTruthy();
    });

    // Click the dismiss X button
    fireEvent.click(screen.getByLabelText("Dismiss transcription error"));

    await waitFor(() => {
      expect(screen.queryByText("transcription failed")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
  });

  it("retries with the saved mode and composer context for edit mode", async () => {
    // Set up a non-empty composer to trigger edit mode
    setupMockStore({ draftText: "Fix the login bug" });

    mockTranscribe.mockRejectedValueOnce(new Error("backend error")).mockResolvedValueOnce({
      mode: "edit",
      text: "Fix the authentication bug in the login flow",
      rawText: "fix the authentication bug",
      instructionText: "fix the authentication bug",
      backend: "openai",
      enhanced: true,
    });

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByText("backend error")).toBeTruthy();
    });

    // Retry should re-send with edit mode
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // Should show the voice edit preview after successful retry
    await waitFor(() => {
      expect(screen.getByText("Voice edit preview")).toBeTruthy();
    });

    // Verify the retry used edit mode with the original composerText
    const retryCall = mockTranscribe.mock.calls[1];
    expect(retryCall[1]).toEqual(
      expect.objectContaining({
        mode: "edit",
        composerText: "Fix the login bug",
      }),
    );
  });

  it("clears failed transcription when a new recording starts", async () => {
    mockTranscribe.mockRejectedValueOnce(new Error("first failure"));

    render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    // Start a new recording -- this should clear the retry banner
    // The toggleRecording mock triggers onAudioReady immediately, which will also call transcribe
    mockTranscribe.mockResolvedValueOnce({
      mode: "dictation",
      text: "new recording",
      backend: "openai",
      enhanced: false,
    });
    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
  });

  it("retries with append mode and preserves cursor context with spacing", async () => {
    // Non-empty composer triggers edit mode by default (preferredVoiceModeRef = "edit").
    // Verify the saved composerText survives failure and is re-sent on retry.
    setupMockStore({ draftText: "" });
    mockTranscribe.mockRejectedValueOnce(new Error("append error")).mockResolvedValueOnce({
      mode: "edit",
      text: "fixed text",
      rawText: "fix this",
      instructionText: "fix this",
      backend: "openai",
      enhanced: true,
    });

    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    // Type text so handleMicClick enters edit mode and captures composerText
    fireEvent.change(textarea, { target: { value: "before after" } });
    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByText("append error")).toBeTruthy();
    });

    // Retry -- verify the original composerText is preserved through failure
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      const retryCall = mockTranscribe.mock.calls[1];
      expect(retryCall[1]).toEqual(
        expect.objectContaining({
          composerText: "before after",
        }),
      );
    });
  });

  it("does not auto-clear voice error when retry is available", async () => {
    vi.useFakeTimers();
    try {
      mockTranscribe.mockRejectedValueOnce(new Error("server unreachable"));

      render(<Composer sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Voice input"));

      // Wait for retry banner to appear (transcription is async)
      await vi.advanceTimersByTimeAsync(0);

      expect(screen.getByText("server unreachable")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

      // Advance well past the 4-second auto-clear window
      await vi.advanceTimersByTimeAsync(10000);

      // Error should still be visible (failedTranscription suppresses auto-clear)
      expect(screen.getByText("server unreachable")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears retry state when switching to a different session", async () => {
    mockTranscribe.mockRejectedValueOnce(new Error("session error"));

    const { rerender } = render(<Composer sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    // Switch session -- retry banner should disappear
    // Need to set up mock store for s2 so the component can render
    const sessionsMap = mockStoreState.sessions as Map<string, unknown>;
    sessionsMap.set("s2", makeSession({ session_id: "s2" }));
    const cliMap = mockStoreState.cliConnected as Map<string, boolean>;
    cliMap.set("s2", true);
    const statusMap = mockStoreState.sessionStatus as Map<string, string | null>;
    statusMap.set("s2", "idle");
    notifyMockStore();

    rerender(<Composer sessionId="s2" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.queryByText("session error")).toBeNull();
    });
  });
});
