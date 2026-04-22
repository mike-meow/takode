import { isEmbeddedInVsCode } from "./utils/embed-context.js";
import { scopedGetItem } from "./utils/scoped-storage.js";

type ColorTheme = "light" | "dark" | "vscode-dark";

function isDarkThemeLocal(theme: ColorTheme): boolean {
  return theme !== "light";
}

export function getInitialSessionNames(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    return new Map(JSON.parse(scopedGetItem("cc-session-names") || "[]"));
  } catch {
    return new Map();
  }
}

export function getInitialSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return scopedGetItem("cc-current-session") || null;
}

export function getInitialColorTheme(): ColorTheme {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem("cc-color-theme");
  if (stored === "light" || stored === "dark" || stored === "vscode-dark") return stored;
  const legacyDark = localStorage.getItem("cc-dark-mode");
  if (legacyDark !== null) return legacyDark === "true" ? "dark" : "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getInitialDarkMode(): boolean {
  return isDarkThemeLocal(getInitialColorTheme());
}

export function getInitialNotificationSound(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem("cc-notification-sound");
  if (stored !== null) return stored === "true";
  return true;
}

export function getInitialNotificationDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-notification-desktop");
  if (stored !== null) return stored === "true";
  return false;
}

export function getInitialZoomLevel(): number {
  if (typeof window === "undefined") return 0.9;
  const stored = localStorage.getItem("cc-zoom-level");
  if (stored !== null) {
    const val = parseFloat(stored);
    if (!isNaN(val) && val >= 0.2 && val <= 4.0) return val;
  }
  if (isEmbeddedInVsCode()) {
    return 0.8;
  }
  return 0.9;
}

export function getInitialCollapsedSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(scopedGetItem(key) || "[]"));
  } catch {
    return new Set();
  }
}
