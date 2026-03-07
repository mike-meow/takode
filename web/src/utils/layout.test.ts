// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  getEffectiveViewportWidth,
  isDesktopShellLayout,
  isDesktopTaskPanelLayout,
  isNarrowComposerLayout,
} from "./layout.js";

describe("layout utilities", () => {
  it("uses zoom-adjusted viewport width for responsive layout decisions", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 720 });

    expect(getEffectiveViewportWidth(0.8)).toBe(900);
    expect(isDesktopShellLayout(0.8)).toBe(true);
    expect(isDesktopTaskPanelLayout(0.8)).toBe(false);
    expect(isNarrowComposerLayout(0.8)).toBe(false);
  });

  it("treats the same viewport as compact when the zoom level is 1", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 720 });

    expect(isDesktopShellLayout(1)).toBe(false);
    expect(isNarrowComposerLayout(1)).toBe(false);
  });
});
