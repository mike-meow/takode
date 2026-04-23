import type { Route } from "./utils/routing.js";

export type ShortcutActionId =
  | "search_session"
  | "toggle_terminal"
  | "previous_session"
  | "next_session"
  | "new_session";

export type ShortcutPresetId = "standard" | "vscode-light" | "vim-light";

export type ShortcutBinding = string;

export interface ShortcutSettings {
  enabled: boolean;
  preset: ShortcutPresetId;
  overrides: Partial<Record<ShortcutActionId, ShortcutBinding | null>>;
}

export interface ShortcutPresetOption {
  id: ShortcutPresetId;
  label: string;
  description: string;
}

export interface ShortcutActionDefinition {
  id: ShortcutActionId;
  label: string;
  description: string;
}

export interface ShortcutBindingOption {
  value: ShortcutBinding | null;
  label: string;
  source: string;
}

export interface ShortcutSessionSummary {
  sessionId: string;
  createdAt: number;
  archived?: boolean;
  cronJobId?: string | null;
}

export interface ShortcutRuntime {
  route: Route;
  currentSessionId: string | null;
  currentSessionCwd: string | null;
  terminalCwd: string | null;
  activeTab: "chat" | "diff";
  isSearchOpen: boolean;
  sessions: ShortcutSessionSummary[];
  openSearch: (sessionId: string) => void;
  closeSearch: (sessionId: string) => void;
  openNewSessionModal: () => void;
  openTerminal: (cwd: string) => void;
  setActiveTab: (tab: "chat" | "diff") => void;
  navigateTo: (path: string) => void;
  navigateToSession: (sessionId: string) => void;
  navigateToMostRecentSession: () => boolean;
}

type ShortcutBindingMap = Record<ShortcutActionId, ShortcutBinding | null>;

const ACTION_ORDER: ShortcutActionId[] = [
  "search_session",
  "toggle_terminal",
  "previous_session",
  "next_session",
  "new_session",
];

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = {
  enabled: false,
  preset: "standard",
  overrides: {},
};

export const SHORTCUT_ACTIONS: ShortcutActionDefinition[] = [
  {
    id: "search_session",
    label: "Search Current Session",
    description: "Open message search for the active chat session.",
  },
  {
    id: "toggle_terminal",
    label: "Open or Return From Terminal",
    description: "Open the terminal page, or return to chat when already there.",
  },
  {
    id: "previous_session",
    label: "Previous Session",
    description: "Move to the previous active chat session.",
  },
  {
    id: "next_session",
    label: "Next Session",
    description: "Move to the next active chat session.",
  },
  {
    id: "new_session",
    label: "New Session",
    description: "Open the new session modal.",
  },
];

export const SHORTCUT_PRESET_OPTIONS: ShortcutPresetOption[] = [
  {
    id: "standard",
    label: "Standard",
    description: "Lightweight app defaults with familiar browser-style find and simple session navigation.",
  },
  {
    id: "vscode-light",
    label: "VS Code Light",
    description: "Editor-inspired bindings, including Ctrl+` for the terminal and Ctrl+PageUp/PageDown tabs.",
  },
  {
    id: "vim-light",
    label: "Vim Light",
    description: "Home-row-friendly navigation using Alt-based motions without introducing modal editing.",
  },
];

const PRESET_BINDINGS: Record<ShortcutPresetId, ShortcutBindingMap> = {
  standard: {
    search_session: "Mod+F",
    toggle_terminal: "Mod+Shift+T",
    previous_session: "Mod+Shift+[",
    next_session: "Mod+Shift+]",
    new_session: "Mod+N",
  },
  "vscode-light": {
    search_session: "Mod+F",
    toggle_terminal: "Ctrl+`",
    previous_session: "Ctrl+PageUp",
    next_session: "Ctrl+PageDown",
    new_session: "Mod+N",
  },
  "vim-light": {
    search_session: "Alt+/",
    toggle_terminal: "Alt+T",
    previous_session: "Alt+H",
    next_session: "Alt+L",
    new_session: "Alt+N",
  },
};

function normalizeKeyToken(key: string): string {
  return key.toUpperCase();
}

function tokenizeBinding(binding: ShortcutBinding): string[] {
  return binding
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeKeyToken);
}

function parseBinding(binding: ShortcutBinding): {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  mod: boolean;
  key: string | null;
} {
  const tokens = tokenizeBinding(binding);
  let key: string | null = null;
  const parsed = {
    alt: false,
    ctrl: false,
    meta: false,
    shift: false,
    mod: false,
    key: null as string | null,
  };

  for (const token of tokens) {
    switch (token) {
      case "ALT":
        parsed.alt = true;
        break;
      case "CTRL":
        parsed.ctrl = true;
        break;
      case "CMD":
      case "META":
        parsed.meta = true;
        break;
      case "SHIFT":
        parsed.shift = true;
        break;
      case "MOD":
        parsed.mod = true;
        break;
      default:
        key = token;
        break;
    }
  }

  parsed.key = key;
  return parsed;
}

function keyFromKeyboardEvent(event: Pick<KeyboardEvent, "key">): string {
  const key = event.key;
  if (key === " ") return "SPACE";
  return key.toUpperCase();
}

function bindingMatchesEventKey(
  bindingKey: string,
  event: Pick<KeyboardEvent, "key"> & { code?: string },
): boolean {
  const eventKey = keyFromKeyboardEvent(event);
  if (bindingKey === eventKey) return true;

  // Shifted bracket bindings emit "{" / "}" on event.key, but the
  // shortcut should still match the underlying [ / ] physical keys.
  if (bindingKey === "[" && event.code === "BracketLeft") return true;
  if (bindingKey === "]" && event.code === "BracketRight") return true;

  return false;
}

function platformIsMac(platform?: string): boolean {
  if (!platform) return false;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function getShortcutPresetBindings(preset: ShortcutPresetId): ShortcutBindingMap {
  return PRESET_BINDINGS[preset];
}

export function getShortcutActionDefinition(actionId: ShortcutActionId): ShortcutActionDefinition {
  return SHORTCUT_ACTIONS.find((action) => action.id === actionId) ?? SHORTCUT_ACTIONS[0]!;
}

export function getEffectiveShortcutBinding(
  settings: ShortcutSettings | null | undefined,
  actionId: ShortcutActionId,
): ShortcutBinding | null {
  const resolved = settings ?? DEFAULT_SHORTCUT_SETTINGS;
  if (Object.prototype.hasOwnProperty.call(resolved.overrides, actionId)) {
    return resolved.overrides[actionId] ?? null;
  }
  return getShortcutPresetBindings(resolved.preset)[actionId] ?? null;
}

export function formatShortcut(binding: ShortcutBinding, platform?: string): string {
  const isMac = platformIsMac(platform);
  return tokenizeBinding(binding)
    .map((token) => {
      switch (token) {
        case "MOD":
          return isMac ? "Cmd" : "Ctrl";
        case "CMD":
        case "META":
          return isMac ? "Cmd" : "Meta";
        case "CTRL":
          return "Ctrl";
        case "ALT":
          return isMac ? "Option" : "Alt";
        case "SHIFT":
          return "Shift";
        case "PAGEUP":
          return "PageUp";
        case "PAGEDOWN":
          return "PageDown";
        case "SPACE":
          return "Space";
        default:
          if (token.length === 1) return token;
          return token.charAt(0) + token.slice(1).toLowerCase();
      }
    })
    .join("+");
}

export function getShortcutHint(
  settings: ShortcutSettings | null | undefined,
  actionId: ShortcutActionId,
  platform?: string,
): string | null {
  const resolved = settings ?? DEFAULT_SHORTCUT_SETTINGS;
  if (!resolved.enabled) return null;
  const binding = getEffectiveShortcutBinding(resolved, actionId);
  return binding ? formatShortcut(binding, platform) : null;
}

export function getShortcutTitle(
  baseTitle: string,
  settings: ShortcutSettings | null | undefined,
  actionId: ShortcutActionId,
  platform?: string,
): string {
  const hint = getShortcutHint(settings, actionId, platform);
  return hint ? `${baseTitle} (${hint})` : baseTitle;
}

export function getShortcutBindingOptions(
  actionId: ShortcutActionId,
  platform?: string,
  preset?: ShortcutPresetId,
): ShortcutBindingOption[] {
  const options: ShortcutBindingOption[] = [];
  const seen = new Set<string>();

  if (preset) {
    const presetBinding = getShortcutPresetBindings(preset)[actionId] ?? null;
    const presetLabel = SHORTCUT_PRESET_OPTIONS.find((option) => option.id === preset)?.label ?? "Preset";
    options.push({
      value: presetBinding,
      label: presetBinding ? `${formatShortcut(presetBinding, platform)} (Preset default)` : "Off (Preset default)",
      source: presetLabel,
    });
    seen.add(presetBinding ?? "__none__");
  }

  for (const option of SHORTCUT_PRESET_OPTIONS) {
    const binding = getShortcutPresetBindings(option.id)[actionId] ?? null;
    const dedupeKey = binding ?? "__none__";
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    options.push({
      value: binding,
      label: binding ? formatShortcut(binding, platform) : "Off",
      source: option.label,
    });
  }

  if (!seen.has("__none__")) {
    options.push({ value: null, label: "Off", source: "Disabled" });
  }

  return options;
}

export function shortcutsEqual(
  left: ShortcutSettings | null | undefined,
  right: ShortcutSettings | null | undefined,
): boolean {
  const a = left ?? DEFAULT_SHORTCUT_SETTINGS;
  const b = right ?? DEFAULT_SHORTCUT_SETTINGS;
  if (a.enabled !== b.enabled || a.preset !== b.preset) return false;
  for (const actionId of ACTION_ORDER) {
    if ((a.overrides[actionId] ?? undefined) !== (b.overrides[actionId] ?? undefined)) return false;
  }
  return true;
}

export function isShortcutEventTargetEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

export function matchesShortcutEvent(
  binding: ShortcutBinding,
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"> & { code?: string },
): boolean {
  const parsed = parseBinding(binding);
  if (!parsed.key || !bindingMatchesEventKey(parsed.key, event)) return false;

  const expectsCtrl = parsed.ctrl || (parsed.mod && !platformIsMac(typeof navigator !== "undefined" ? navigator.platform : undefined));
  const expectsMeta = parsed.meta || (parsed.mod && platformIsMac(typeof navigator !== "undefined" ? navigator.platform : undefined));

  return (
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift &&
    event.ctrlKey === expectsCtrl &&
    event.metaKey === expectsMeta
  );
}

export function getMatchingShortcutAction(
  settings: ShortcutSettings | null | undefined,
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"> & { code?: string },
): ShortcutActionId | null {
  const resolved = settings ?? DEFAULT_SHORTCUT_SETTINGS;
  if (!resolved.enabled) return null;
  for (const actionId of ACTION_ORDER) {
    const binding = getEffectiveShortcutBinding(resolved, actionId);
    if (binding && matchesShortcutEvent(binding, event)) return actionId;
  }
  return null;
}

export function getShortcutSessions(sessions: ShortcutSessionSummary[]): ShortcutSessionSummary[] {
  return [...sessions]
    .filter((session) => !session.archived && !session.cronJobId)
    .sort((left, right) => right.createdAt - left.createdAt);
}

function getAnchorSessionIndex(
  sessions: ShortcutSessionSummary[],
  currentSessionId: string | null,
): number {
  if (!currentSessionId) return 0;
  const index = sessions.findIndex((session) => session.sessionId === currentSessionId);
  return index >= 0 ? index : 0;
}

export function getAdjacentShortcutSessionId(
  sessions: ShortcutSessionSummary[],
  currentSessionId: string | null,
  direction: "previous_session" | "next_session",
): string | null {
  const ordered = getShortcutSessions(sessions);
  if (ordered.length === 0) return null;
  if (ordered.length === 1) return ordered[0]!.sessionId;
  const currentIndex = getAnchorSessionIndex(ordered, currentSessionId);
  const delta = direction === "previous_session" ? -1 : 1;
  const nextIndex = (currentIndex + delta + ordered.length) % ordered.length;
  return ordered[nextIndex]!.sessionId;
}

function getPrimaryShortcutSessionId(runtime: ShortcutRuntime): string | null {
  if (runtime.currentSessionId) return runtime.currentSessionId;
  return getShortcutSessions(runtime.sessions)[0]?.sessionId ?? null;
}

export function performShortcutAction(actionId: ShortcutActionId, runtime: ShortcutRuntime): boolean {
  switch (actionId) {
    case "search_session": {
      const sessionId = getPrimaryShortcutSessionId(runtime);
      if (!sessionId) return false;
      if (runtime.activeTab !== "chat") runtime.setActiveTab("chat");
      if (runtime.route.page !== "session") {
        runtime.navigateToSession(sessionId);
      }
      if (!runtime.isSearchOpen) runtime.openSearch(sessionId);
      return true;
    }
    case "toggle_terminal": {
      if (runtime.route.page === "terminal") {
        if (runtime.currentSessionId) {
          runtime.navigateToSession(runtime.currentSessionId);
          runtime.setActiveTab("chat");
          return true;
        }
        return runtime.navigateToMostRecentSession();
      }
      const cwd = runtime.currentSessionCwd ?? runtime.terminalCwd;
      if (cwd) runtime.openTerminal(cwd);
      runtime.navigateTo("/terminal");
      return true;
    }
    case "previous_session":
    case "next_session": {
      const sessionId = getAdjacentShortcutSessionId(runtime.sessions, runtime.currentSessionId, actionId);
      if (!sessionId) return false;
      runtime.navigateToSession(sessionId);
      runtime.setActiveTab("chat");
      return true;
    }
    case "new_session":
      runtime.openNewSessionModal();
      return true;
    default:
      return false;
  }
}
