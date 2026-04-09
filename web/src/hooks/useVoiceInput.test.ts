// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  getVoiceInputSupport,
  normalizeMeterLevel,
  resolveRecordedMimeType,
  useVoiceInput,
} from "./useVoiceInput.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

/** Create a mock MediaStream with configurable track readyState */
function makeMockStream(trackState: "live" | "ended" = "live"): MediaStream {
  const track = {
    readyState: trackState,
    stop: vi.fn(),
    kind: "audio",
    id: "mock-track",
    enabled: true,
  };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Minimal MediaRecorder mock that exposes start/stop controls.
 *  Tracks the last created instance via MockMediaRecorder.lastInstance for tests
 *  that need to trigger error events after recording starts. */
class MockMediaRecorder {
  static lastInstance: MockMediaRecorder | null = null;

  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockMediaRecorder.lastInstance = this;
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    // Deliver a small data chunk, then fire onstop
    // (matches real browser behavior where onstop fires after ondataavailable)
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
    this.onstop?.();
  }

  /** Test helper: simulate a recording error mid-recording */
  triggerError() {
    this.state = "inactive";
    this.onerror?.();
  }
}

/** Stub AudioContext so volume metering setup doesn't throw */
class MockAudioContext {
  state = "running";
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createAnalyser() {
    return {
      fftSize: 1024,
      smoothingTimeConstant: 0,
      getByteTimeDomainData: vi.fn(),
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

let getUserMediaMock: ReturnType<typeof vi.fn>;

// Volume monitor uses requestAnimationFrame/cancelAnimationFrame which may not exist in jsdom.
// Define them once at module level so they survive through React cleanup (unmount) which
// fires stopVolumeMonitor -> cancelAnimationFrame after the test's afterEach runs.
if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
}
if (typeof globalThis.cancelAnimationFrame === "undefined") {
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
}

beforeEach(() => {
  vi.useFakeTimers();

  getUserMediaMock = vi.fn().mockResolvedValue(makeMockStream());

  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: getUserMediaMock,
    },
  });
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  vi.stubGlobal("AudioContext", MockAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Pure function tests (existing) ─────────────────────────────────────────

describe("normalizeMeterLevel", () => {
  it("keeps silence at zero", () => {
    expect(normalizeMeterLevel(0, 0)).toBe(0);
  });

  it("filters low-level background noise near the floor", () => {
    expect(normalizeMeterLevel(0.009, 0)).toBe(0);
  });

  it("boosts speech-like RMS values for a responsive meter", () => {
    const level = normalizeMeterLevel(0.05, 0);
    expect(level).toBeGreaterThan(0.1);
    expect(level).toBeLessThan(0.35);
  });

  it("uses slower release smoothing so bars do not snap to zero", () => {
    const rising = normalizeMeterLevel(0.12, 0);
    const falling = normalizeMeterLevel(0, rising);
    expect(rising).toBeGreaterThan(0.25);
    expect(falling).toBeGreaterThan(0.2);
    expect(falling).toBeLessThan(rising);
  });
});

describe("getVoiceInputSupport", () => {
  it("reports insecure contexts explicitly instead of hiding voice input", () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    expect(getVoiceInputSupport()).toEqual({
      isSupported: false,
      unsupportedReason: "insecure-context",
      unsupportedMessage: "Voice input requires HTTPS or localhost in this browser.",
    });
  });

  it("reports full support when browser recording APIs are available", () => {
    expect(getVoiceInputSupport()).toEqual({
      isSupported: true,
      unsupportedReason: null,
      unsupportedMessage: null,
    });
  });
});

describe("resolveRecordedMimeType", () => {
  it("prefers the recorder mime type when the browser provides one", () => {
    const chunks = [new Blob(["data"], { type: "audio/webm" })];
    expect(resolveRecordedMimeType("audio/mp4", chunks)).toBe("audio/mp4");
  });

  it("falls back to the first chunk mime type when recorder.mimeType is empty", () => {
    const chunks = [new Blob(["data"], { type: "audio/ogg" })];
    expect(resolveRecordedMimeType("", chunks)).toBe("audio/ogg");
  });

  it("defaults to audio/webm when no type is available anywhere", () => {
    const chunks = [new Blob(["data"])];
    expect(resolveRecordedMimeType("", chunks)).toBe("audio/webm");
  });
});

// ── Hook tests: isPreparing transitions ────────────────────────────────────

describe("useVoiceInput — isPreparing", () => {
  it("isPreparing is true while getUserMedia is pending, then false once recording starts", async () => {
    // Make getUserMedia hang until we resolve it manually
    let resolveStream!: (stream: MediaStream) => void;
    getUserMediaMock.mockImplementation(
      () => new Promise<MediaStream>((r) => { resolveStream = r; }),
    );

    const { result } = renderHook(() => useVoiceInput());

    expect(result.current.isPreparing).toBe(false);
    expect(result.current.isRecording).toBe(false);

    // Start recording -- should immediately set isPreparing
    act(() => { result.current.startRecording(); });
    // isPreparing goes true synchronously in the same microtask as the setState
    expect(result.current.isPreparing).toBe(true);
    expect(result.current.isRecording).toBe(false);

    // Resolve getUserMedia -- recording should start and isPreparing should clear
    await act(async () => { resolveStream(makeMockStream()); });
    expect(result.current.isPreparing).toBe(false);
    expect(result.current.isRecording).toBe(true);
  });

  it("isPreparing clears when getUserMedia rejects (permission denied)", async () => {
    getUserMediaMock.mockRejectedValue(new DOMException("Not allowed", "NotAllowedError"));

    const { result } = renderHook(() => useVoiceInput());

    await act(async () => { result.current.startRecording(); });

    expect(result.current.isPreparing).toBe(false);
    expect(result.current.isRecording).toBe(false);
    expect(result.current.error).toBe("Microphone access denied");
  });

  it("cancelRecording clears isPreparing during the preparing phase", async () => {
    // Make getUserMedia hang forever
    getUserMediaMock.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useVoiceInput());

    act(() => { result.current.startRecording(); });
    expect(result.current.isPreparing).toBe(true);

    // Cancel while still preparing (before getUserMedia resolves)
    act(() => { result.current.cancelRecording(); });
    expect(result.current.isPreparing).toBe(false);
    expect(result.current.isRecording).toBe(false);
  });
});

// ── Hook tests: warmMicrophone ─────────────────────────────────────────────

describe("useVoiceInput — warmMicrophone", () => {
  it("calls getUserMedia once on first warmMicrophone call", async () => {
    const { result } = renderHook(() => useVoiceInput());

    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
  });

  it("no-ops on repeated warmMicrophone calls when stream is already cached and live", async () => {
    const { result } = renderHook(() => useVoiceInput());

    // First call caches the stream
    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // Second call should be a no-op (cached stream tracks are "live")
    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it("silently swallows getUserMedia rejection without setting error", async () => {
    getUserMediaMock.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    const { result } = renderHook(() => useVoiceInput());

    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // warmMicrophone should NOT set error -- it's a background pre-warm
    expect(result.current.error).toBeNull();
  });

  it("no-ops when voice input is not supported", () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    const { result } = renderHook(() => useVoiceInput());

    act(() => { result.current.warmMicrophone(); });
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it("startRecording reuses pre-warmed stream and skips getUserMedia", async () => {
    const { result } = renderHook(() => useVoiceInput());

    // Pre-warm
    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // Start recording -- should reuse cached stream
    await act(async () => { result.current.startRecording(); });
    expect(result.current.isRecording).toBe(true);
    expect(result.current.isPreparing).toBe(false);
    // No additional getUserMedia call
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it("releases cached stream after idle timeout (30s)", async () => {
    const mockStream = makeMockStream();
    getUserMediaMock.mockResolvedValue(mockStream);

    const { result } = renderHook(() => useVoiceInput());

    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // Advance past the 30s idle timeout
    act(() => { vi.advanceTimersByTime(31_000); });

    // Stream tracks should have been stopped
    expect(mockStream.getTracks()[0].stop).toHaveBeenCalled();

    // Next warmMicrophone should request a fresh stream
    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
  });
});

// ── Hook tests: stale stream fallback ──────────────────────────────────────

describe("useVoiceInput — stale stream fallback", () => {
  it("falls back to fresh getUserMedia when cached stream tracks have ended", async () => {
    // First warm returns a stream whose tracks will be "ended"
    const staleStream = makeMockStream("ended");
    const freshStream = makeMockStream("live");
    getUserMediaMock
      .mockResolvedValueOnce(staleStream)   // for warmMicrophone
      .mockResolvedValueOnce(freshStream);  // for startRecording fallback

    const { result } = renderHook(() => useVoiceInput());

    // Pre-warm with what will become a stale stream
    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // Start recording -- stale stream should be detected, fresh getUserMedia triggered
    await act(async () => { result.current.startRecording(); });
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    expect(result.current.isRecording).toBe(true);
    expect(result.current.isPreparing).toBe(false);
  });

  it("warmMicrophone re-requests stream when cached tracks have ended", async () => {
    // First warm: live stream that we'll mark as ended
    const stream = makeMockStream("live");
    getUserMediaMock.mockResolvedValue(stream);

    const { result } = renderHook(() => useVoiceInput());

    // Warm and cache
    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // Simulate permission revocation by marking track as ended
    (stream.getTracks()[0] as { readyState: string }).readyState = "ended";

    // Next warmMicrophone should detect stale tracks and request fresh stream
    act(() => { result.current.warmMicrophone(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
  });
});

// ── Hook tests: onAudioReady callback ──────────────────────────────────────

describe("useVoiceInput — onAudioReady", () => {
  it("fires onAudioReady with recorded blob when recording stops normally", async () => {
    const onAudioReady = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onAudioReady }));

    await act(async () => { result.current.startRecording(); });
    expect(result.current.isRecording).toBe(true);

    act(() => { result.current.stopRecording(); });
    expect(result.current.isRecording).toBe(false);
    expect(onAudioReady).toHaveBeenCalledTimes(1);
    expect(onAudioReady.mock.calls[0][0]).toBeInstanceOf(Blob);
  });

  it("does NOT fire onAudioReady when recording is cancelled", async () => {
    const onAudioReady = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onAudioReady }));

    await act(async () => { result.current.startRecording(); });
    act(() => { result.current.cancelRecording(); });

    expect(result.current.isRecording).toBe(false);
    expect(onAudioReady).not.toHaveBeenCalled();
  });
});

// ── Hook tests: recorder error handling ────────────────────────────────────

describe("useVoiceInput — recorder.onerror", () => {
  it("sets error and clears recording state when MediaRecorder errors mid-recording", async () => {
    const onAudioReady = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onAudioReady }));

    await act(async () => { result.current.startRecording(); });
    expect(result.current.isRecording).toBe(true);

    // Simulate a recorder error via the mock's triggerError helper
    const recorder = MockMediaRecorder.lastInstance!;
    act(() => { recorder.triggerError(); });

    expect(result.current.isRecording).toBe(false);
    expect(result.current.isPreparing).toBe(false);
    expect(result.current.error).toBe("Recording failed");
    expect(onAudioReady).not.toHaveBeenCalled();
  });
});

// ── Hook tests: warming promise race prevention ────────────────────────────

describe("useVoiceInput — warming promise coalescing", () => {
  it("startRecording awaits in-flight warmMicrophone instead of duplicating getUserMedia", async () => {
    // Make getUserMedia hang until we resolve it manually
    let resolveStream!: (stream: MediaStream) => void;
    getUserMediaMock.mockImplementation(
      () => new Promise<MediaStream>((r) => { resolveStream = r; }),
    );

    const { result } = renderHook(() => useVoiceInput());

    // Start warming (fires getUserMedia, hangs on promise)
    act(() => { result.current.warmMicrophone(); });

    // Immediately start recording before warm resolves -- should NOT fire a second getUserMedia
    act(() => { result.current.startRecording(); });
    expect(result.current.isPreparing).toBe(true);

    // Resolve the single getUserMedia call
    await act(async () => { resolveStream(makeMockStream()); });

    expect(result.current.isRecording).toBe(true);
    expect(result.current.isPreparing).toBe(false);
    // Only ONE getUserMedia call total (not two)
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it("concurrent warmMicrophone calls do not fire duplicate getUserMedia requests", async () => {
    const { result } = renderHook(() => useVoiceInput());

    // Fire warmMicrophone twice in quick succession
    act(() => {
      result.current.warmMicrophone();
      result.current.warmMicrophone();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Only one getUserMedia call despite two warmMicrophone calls
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });
});
