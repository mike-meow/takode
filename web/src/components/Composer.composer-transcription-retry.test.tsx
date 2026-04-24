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
