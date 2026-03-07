import { useState, useRef, useCallback, useEffect } from "react";

export interface UseVoiceInputOptions {
  /** Called with the recorded audio blob when recording stops */
  onAudioReady?: (blob: Blob) => void;
}

export type TranscriptionPhase = "transcribing" | "enhancing" | null;
export type VoiceInputUnsupportedReason =
  | "insecure-context"
  | "missing-media-devices"
  | "missing-media-recorder"
  | "unsupported-environment";

export interface UseVoiceInputReturn {
  isRecording: boolean;
  isSupported: boolean;
  unsupportedReason: VoiceInputUnsupportedReason | null;
  unsupportedMessage: string | null;
  isTranscribing: boolean;
  /** Current transcription phase: "transcribing" (STT in progress), "enhancing" (LLM enhancement), or null */
  transcriptionPhase: TranscriptionPhase;
  error: string | null;
  /** Normalized volume level 0–1 while recording, 0 otherwise */
  volumeLevel: number;
  setIsTranscribing: (v: boolean) => void;
  setTranscriptionPhase: (phase: TranscriptionPhase) => void;
  setError: (e: string | null) => void;
  startRecording: () => void;
  stopRecording: () => void;
  toggleRecording: () => void;
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

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const support = getVoiceInputSupport();
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionPhase, setTranscriptionPhase] = useState<TranscriptionPhase>(null);
  const [error, setError] = useState<string | null>(null);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

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

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!support.isSupported) {
      setError(support.unsupportedMessage ?? "Voice input is unavailable.");
      return;
    }

    setError(null);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

        if (chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          chunksRef.current = [];
          optionsRef.current.onAudioReady?.(blob);
        }
      };

      recorder.onerror = () => {
        setError("Recording failed");
        setIsRecording(false);
        stopVolumeMonitor();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
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

  // Auto-clear errors after 4 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      stopVolumeMonitor();
    };
  }, [stopVolumeMonitor]);

  return {
    isRecording,
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
    toggleRecording,
  };
}
