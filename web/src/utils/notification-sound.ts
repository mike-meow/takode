let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/** Play a single tone with attack-decay envelope. Shared by all notification sounds. */
function playTone(ctx: AudioContext, freq: number, start: number, gain: number, duration: number, type: OscillatorType): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.001, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/**
 * Blue (review/done) -- completion chime.
 * Short ascending two-note tone (C5 → E5), triangle wave, ~450ms.
 * Warm, satisfying -- like a task-complete ding.
 */
export function playReviewSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    playTone(ctx, 523.25, now, 0.25, 0.25, "triangle");        // C5
    playTone(ctx, 659.25, now + 0.15, 0.25, 0.3, "triangle");  // E5
  } catch {
    // Silently fail if Web Audio API is not available
  }
}

/**
 * Amber (needs-input) -- attention tone.
 * Two identical A5 notes with a short pause (gentle double-tap), triangle wave, ~600ms.
 * Brighter than the review chime -- "someone's waiting for you."
 */
export function playNeedsInputSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    playTone(ctx, 880.0, now, 0.2, 0.15, "triangle");       // A5, first tap
    playTone(ctx, 880.0, now + 0.33, 0.2, 0.15, "triangle"); // A5, second tap
  } catch {
    // Silently fail if Web Audio API is not available
  }
}

/** Backward-compatible alias for the review completion chime. */
export function playNotificationSound(): void {
  playReviewSound();
}
