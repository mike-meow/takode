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

  it("sends reply metadata in history content and concise delivery content to the assistant", () => {
    (mockStoreState.replyContexts as Map<string, { messageId: string; previewText: string }>).set("s1", {
      messageId: "codex-agent-long-random-id",
      previewText: "Original answer",
    });
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea")!;

    fireEvent.change(textarea, { target: { value: "continue the work" } });
    fireEvent.click(screen.getByTitle("Send message"));

    expect(mockSendToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
        content: "continue the work",
        deliveryContent: "[reply] Original answer\n\ncontinue the work",
        replyContext: {
          messageId: "codex-agent-long-random-id",
          previewText: "Original answer",
        },
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
    expect(screen.getByTitle("Send message").closest("button")!.hasAttribute("disabled")).toBe(true);

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
