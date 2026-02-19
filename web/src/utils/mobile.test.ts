// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isTouchDevice } from "./mobile.js";

describe("isTouchDevice", () => {
  // test-setup.ts provides a default matchMedia polyfill for jsdom;
  // each test overrides it to simulate touch vs desktop environments.

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true for touch-only devices (hover: none, pointer: coarse)", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }));
    expect(isTouchDevice()).toBe(true);
  });

  it("returns false for desktop devices (hover: hover, pointer: fine)", () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }));
    expect(isTouchDevice()).toBe(false);
  });
});
