import { useState, useRef, useCallback, useEffect } from "react";

export interface UseVoiceInputOptions {
  /** Called with the recorded audio blob when recording stops */
  onAudioReady?: (blob: Blob) => void;
}

export type TranscriptionPhase = "uploading" | "transcribing" | "enhancing" | "editing" | "appending" | null;
export type VoiceInputUnsupportedReason =
  | "insecure-context"
  | "missing-media-devices"
  | "missing-media-recorder"
  | "unsupported-environment";

export interface UseVoiceInputReturn {
  isRecording: boolean;
  /** True while acquiring the mic stream before recording actually starts */
  isPreparing: boolean;
  isSupported: boolean;
  unsupportedReason: VoiceInputUnsupportedReason | null;
  unsupportedMessage: string | null;
  isTranscribing: boolean;
  /** Current transcription phase: "uploading", "transcribing", "enhancing"/"editing", or null */
  transcriptionPhase: TranscriptionPhase;
  error: string | null;
  /** Normalized volume level 0–1 while recording, 0 otherwise */
  volumeLevel: number;
  setIsTranscribing: (v: boolean) => void;
  setTranscriptionPhase: (phase: TranscriptionPhase) => void;
  setError: (e: string | null) => void;
  startRecording: () => void;
  stopRecording: () => void;
  /** Cancel recording: stops the mic but discards audio without triggering onAudioReady */
  cancelRecording: () => void;
  toggleRecording: () => void;
  /** Pre-warm the mic stream so startRecording() is near-instant. Safe to call multiple times. */
  warmMicrophone: () => void;
}

const DEFAULT_RECORDING_MIME_TYPE = "audio/webm";

export function resolveRecordedMimeType(recorderMimeType: string | null | undefined, chunks: Blob[]): string {
  const candidates = [recorderMimeType, ...chunks.map((chunk) => chunk.type)];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_RECORDING_MIME_TYPE;
}

interface VoiceInputSupport {
  isSupported: boolean;
  unsupportedReason: VoiceInputUnsupportedReason | null;
  unsupportedMessage: string | null;
}

export function getVoiceInputSupport(): VoiceInputSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      isSupported: false,
      unsupportedReason: "unsupported-environment",
      unsupportedMessage: "Voice input is unavailable in this environment.",
    };
  }

  if (window.isSecureContext === false) {
    return {
      isSupported: false,
      unsupportedReason: "insecure-context",
      unsupportedMessage: "Voice input requires HTTPS or localhost in this browser.",
    };
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      isSupported: false,
      unsupportedReason: "missing-media-devices",
      unsupportedMessage: "Voice input is unavailable in this browser.",
    };
  }

  if (typeof MediaRecorder === "undefined") {
    return {
      isSupported: false,
      unsupportedReason: "missing-media-recorder",
      unsupportedMessage: "Voice recording is unavailable in this browser.",
    };
  }

  return {
    isSupported: true,
    unsupportedReason: null,
    unsupportedMessage: null,
  };
}

// Meter tuning constants calibrated for speech-level mic input.
const VOLUME_NOISE_FLOOR = 0.01;
const VOLUME_SENSITIVITY = 5.5;
const VOLUME_CURVE = 0.55;
const VOLUME_ATTACK = 0.42;
const VOLUME_RELEASE = 0.14;

export function normalizeMeterLevel(rms: number, previousLevel: number): number {
  const gated = Math.max(0, rms - VOLUME_NOISE_FLOOR);
  const boosted = Math.min(1, Math.pow(gated * VOLUME_SENSITIVITY, VOLUME_CURVE));
  const smoothing = boosted > previousLevel ? VOLUME_ATTACK : VOLUME_RELEASE;
  const next = previousLevel + (boosted - previousLevel) * smoothing;
  return Math.max(0, Math.min(1, next));
}

/** How long to keep a pre-warmed mic stream before releasing it (stops OS mic indicator). */
const STREAM_IDLE_TIMEOUT_MS = 5_000;

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const support = getVoiceInputSupport();
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionPhase, setTranscriptionPhase] = useState<TranscriptionPhase>(null);
  const [error, setError] = useState<string | null>(null);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Pre-warmed mic stream, kept alive between recordings to avoid getUserMedia latency
  const cachedStreamRef = useRef<MediaStream | null>(null);
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks an in-flight getUserMedia call from warmMicrophone so startRecording can
  // await it instead of firing a duplicate request (prevents orphaned stream leaks).
  const warmingPromiseRef = useRef<Promise<MediaStream | null> | null>(null);

  // Web Audio API refs for volume metering
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const previousLevelRef = useRef(0);

  /** Start polling AnalyserNode for volume level */
  const startVolumeMonitor = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      previousLevelRef.current = 0;

      const dataArray = new Uint8Array(analyser.fftSize);
      const poll = () => {
        analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const centered = (dataArray[i] - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        const level = normalizeMeterLevel(rms, previousLevelRef.current);
        previousLevelRef.current = level;
        setVolumeLevel(level);
        animFrameRef.current = requestAnimationFrame(poll);
      };
      animFrameRef.current = requestAnimationFrame(poll);
    } catch {
      // Web Audio API not available — volume will stay at 0
    }
  }, []);

  /** Stop volume monitoring and clean up Web Audio resources */
  const stopVolumeMonitor = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    previousLevelRef.current = 0;
    setVolumeLevel(0);
  }, []);

  /** Release cached pre-warmed stream and clear idle timeout */
  const releaseCachedStream = useCallback(() => {
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = null;
    }
    if (cachedStreamRef.current) {
      cachedStreamRef.current.getTracks().forEach((t) => t.stop());
      cachedStreamRef.current = null;
    }
  }, []);

  /** Reset the idle timeout that auto-releases the cached stream */
  const resetIdleTimeout = useCallback(() => {
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = setTimeout(releaseCachedStream, STREAM_IDLE_TIMEOUT_MS);
  }, [releaseCachedStream]);

  /** Check if the cached pre-warmed stream is still usable (has live tracks). */
  function isCachedStreamLive(): boolean {
    const stream = cachedStreamRef.current;
    if (!stream) return false;
    const tracks = stream.getTracks();
    return tracks.length > 0 && tracks.every((t) => t.readyState === "live");
  }

  /** Pre-warm the microphone stream so startRecording() is near-instant.
   *  Safe to call multiple times -- no-ops if a live stream or in-flight request exists. */
  const warmMicrophone = useCallback(() => {
    if (!support.isSupported) return;
    // Already have a live cached stream or an in-flight warming request
    if (isCachedStreamLive() || warmingPromiseRef.current) return;
    // Clear stale stream ref if tracks ended
    cachedStreamRef.current = null;

    const promise = navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        cachedStreamRef.current = stream;
        resetIdleTimeout();
        return stream;
      })
      .catch(() => {
        // Permission denied or error -- no-op, startRecording will handle it
        return null;
      })
      .finally(() => {
        warmingPromiseRef.current = null;
      });
    warmingPromiseRef.current = promise;
  }, [support.isSupported, resetIdleTimeout]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  const cancelRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      cancelledRef.current = true;
      recorderRef.current.stop();
    }
    // Also clear preparing state in case cancel happens during getUserMedia
    setIsPreparing(false);
  }, []);

  const startRecording = useCallback(async () => {
    if (!support.isSupported) {
      setError(support.unsupportedMessage ?? "Voice input is unavailable.");
      return;
    }

    setError(null);
    chunksRef.current = [];
    cancelledRef.current = false;
    setIsPreparing(true);

    try {
      // If warmMicrophone has an in-flight getUserMedia, await it instead of duplicating
      if (warmingPromiseRef.current) {
        await warmingPromiseRef.current;
      }

      // Attempt to reuse cached pre-warmed stream
      let stream: MediaStream | null = isCachedStreamLive() ? cachedStreamRef.current : null;
      if (!stream) {
        cachedStreamRef.current = null;
        // No cached stream available -- fall back to fresh getUserMedia
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // Clear idle timeout -- we're using the stream now
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      // Detach from cache -- this recording owns the stream.
      // Prevents stopRecording's track.stop() from killing a shared ref.
      cachedStreamRef.current = null;

      streamRef.current = stream;

      // Start volume metering
      startVolumeMonitor(stream);

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        // Stop volume monitor
        stopVolumeMonitor();
        // Release mic
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setIsRecording(false);

        // If cancelled, discard audio without triggering transcription
        if (cancelledRef.current) {
          chunksRef.current = [];
          cancelledRef.current = false;
          return;
        }

        if (chunksRef.current.length > 0) {
          const mimeType = resolveRecordedMimeType(recorder.mimeType, chunksRef.current);
          const blob = new Blob(chunksRef.current, { type: mimeType });
          chunksRef.current = [];
          optionsRef.current.onAudioReady?.(blob);
        }
      };

      recorder.onerror = () => {
        setError("Recording failed");
        setIsRecording(false);
        setIsPreparing(false);
        stopVolumeMonitor();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
      };

      recorder.start();
      setIsPreparing(false);
      setIsRecording(true);
    } catch (err) {
      setIsPreparing(false);
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Microphone access denied");
      } else {
        setError("Could not access microphone");
      }
    }
  }, [startVolumeMonitor, stopVolumeMonitor, support.isSupported, support.unsupportedMessage]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      // Release cached pre-warmed stream
      cachedStreamRef.current?.getTracks().forEach((t) => t.stop());
      cachedStreamRef.current = null;
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      stopVolumeMonitor();
    };
  }, [stopVolumeMonitor]);

  return {
    isRecording,
    isPreparing,
    isSupported: support.isSupported,
    unsupportedReason: support.unsupportedReason,
    unsupportedMessage: support.unsupportedMessage,
    isTranscribing,
    transcriptionPhase,
    error,
    volumeLevel,
    setIsTranscribing,
    setTranscriptionPhase,
    setError,
    startRecording,
    stopRecording,
    cancelRecording,
    toggleRecording,
    warmMicrophone,
  };
}
