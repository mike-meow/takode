import { useState, useRef, useCallback, useEffect } from "react";

export interface UseVoiceInputOptions {
  /** Called with the recorded audio blob when recording stops */
  onAudioReady?: (blob: Blob) => void;
}

export interface UseVoiceInputReturn {
  isRecording: boolean;
  isSupported: boolean;
  isTranscribing: boolean;
  error: string | null;
  /** Normalized volume level 0–1 while recording, 0 otherwise */
  volumeLevel: number;
  setIsTranscribing: (v: boolean) => void;
  setError: (e: string | null) => void;
  startRecording: () => void;
  stopRecording: () => void;
  toggleRecording: () => void;
}

const isMediaRecorderSupported =
  typeof window !== "undefined" &&
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined";

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
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

  /** Start polling AnalyserNode for volume level */
  const startVolumeMonitor = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const poll = () => {
        analyser.getByteFrequencyData(dataArray);
        // RMS-like average of frequency bins, normalized to 0–1
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length / 255;
        setVolumeLevel(avg);
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
    setVolumeLevel(0);
  }, []);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!isMediaRecorderSupported) return;

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
  }, [startVolumeMonitor, stopVolumeMonitor]);

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
    isSupported: isMediaRecorderSupported,
    isTranscribing,
    error,
    volumeLevel,
    setIsTranscribing,
    setError,
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
