// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVoiceInputSupport, normalizeMeterLevel } from "./useVoiceInput.js";

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(),
    },
  });
  vi.stubGlobal("MediaRecorder", class MediaRecorder {});
});

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
