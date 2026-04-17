let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  // Recreate if the context was closed (browser can close it when tab is
  // backgrounded for extended periods or under memory pressure).
  if (audioContext && audioContext.state !== "closed") {
    return audioContext;
  }
  audioContext = new AudioContext();
  return audioContext;
}

/** Play a single tone with attack-decay envelope. Shared by all notification sounds. */
function playTone(
  ctx: AudioContext,
  freq: number,
  start: number,
  gain: number,
  duration: number,
  type: OscillatorType,
): void {
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
 * Short ascending two-note tone (E5 → G5), sine wave, ~500ms.
 * Warm, satisfying -- like a task-complete ding.
 */
export async function playReviewSound(): Promise<void> {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    const now = ctx.currentTime;
    playTone(ctx, 659.25, now, 0.3, 0.3, "sine"); // E5
    playTone(ctx, 783.99, now + 0.15, 0.3, 0.35, "sine"); // G5
  } catch {
    // Web Audio API not available
  }
}

/**
 * Amber (needs-input) -- attention tone.
 * Two identical E5 notes with a short pause (gentle double-tap), sine wave, ~450ms.
 * Brighter than the review chime -- "someone's waiting for you."
 */
export async function playNeedsInputSound(): Promise<void> {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    const now = ctx.currentTime;
    playTone(ctx, 659.25, now, 0.3, 0.15, "sine"); // E5, first tap
    playTone(ctx, 659.25, now + 0.3, 0.3, 0.15, "sine"); // E5, second tap
  } catch {
    // Web Audio API not available
  }
}

/** Backward-compatible alias for the review completion chime. */
export async function playNotificationSound(): Promise<void> {
  await playReviewSound();
}
