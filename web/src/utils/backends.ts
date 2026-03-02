import type { BackendType } from "../types.js";
import { assertNever } from "../types.js";
import type { BackendModelInfo } from "../api.js";

export interface ModelOption {
  value: string;
  label: string;
  icon: string;
}

export interface ModeOption {
  value: string;
  label: string;
}

// ─── Icon assignment for dynamically fetched models ──────────────────────────

const MODEL_ICONS: Record<string, string> = {
  "codex": "\u2733",    // ✳ for codex-optimized models
  "max": "\u25A0",      // ■ for max/flagship
  "mini": "\u26A1",     // ⚡ for mini/fast
};

function pickIcon(slug: string, index: number): string {
  for (const [key, icon] of Object.entries(MODEL_ICONS)) {
    if (slug.includes(key)) return icon;
  }
  const fallback = ["\u25C6", "\u25CF", "\u25D5", "\u2726"]; // ◆ ● ◕ ✦
  return fallback[index % fallback.length];
}

/** Convert server model info to frontend ModelOption with icons. */
export function toModelOptions(models: BackendModelInfo[]): ModelOption[] {
  return models.map((m, i) => ({
    value: m.value,
    label: m.label || m.value,
    icon: pickIcon(m.value, i),
  }));
}

// ─── Static fallbacks ────────────────────────────────────────────────────────

export const CLAUDE_MODELS: ModelOption[] = [
  { value: "", label: "Default", icon: "\u25C6" },
  { value: "claude-opus-4-6", label: "Opus", icon: "\u2733" },
  { value: "claude-sonnet-4-5-20250929", label: "Sonnet", icon: "\u25D5" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku", icon: "\u26A1" },
];

export const CODEX_MODELS: ModelOption[] = [
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", icon: "\u2733" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", icon: "\u25C6" },
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Max", icon: "\u25A0" },
  { value: "gpt-5.2", label: "GPT-5.2", icon: "\u25CF" },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Mini", icon: "\u26A1" },
];

export const CLAUDE_MODES: ModeOption[] = [
  { value: "agent", label: "Agent" },
  { value: "plan", label: "Plan" },
];

export const CODEX_MODES: ModeOption[] = [
  { value: "agent", label: "Agent" },
  { value: "plan", label: "Plan" },
];

export const CODEX_REASONING_EFFORTS: ModeOption[] = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

// ─── Getters ─────────────────────────────────────────────────────────────────

export function getModelsForBackend(backend: BackendType): ModelOption[] {
  switch (backend) {
    case "claude":
    case "claude-sdk":  return CLAUDE_MODELS;
    case "codex":       return CODEX_MODELS;
    default:            return assertNever(backend);
  }
}

export function getModesForBackend(backend: BackendType): ModeOption[] {
  switch (backend) {
    case "claude":
    case "claude-sdk":  return CLAUDE_MODES;
    case "codex":       return CODEX_MODES;
    default:            return assertNever(backend);
  }
}

export function getDefaultModel(backend: BackendType): string {
  switch (backend) {
    case "claude":
    case "claude-sdk":  return CLAUDE_MODELS[0].value;
    case "codex":       return CODEX_MODELS[0].value;
    default:            return assertNever(backend);
  }
}

export function getDefaultMode(backend: BackendType): string {
  switch (backend) {
    case "claude":
    case "claude-sdk":  return CLAUDE_MODES[0].value;
    case "codex":       return CODEX_MODES[0].value;
    default:            return assertNever(backend);
  }
}

/** Cycle to the next mode; falls back to first mode if currentMode is unknown. */
export function getNextMode(currentMode: string, modes: ModeOption[]): string {
  const idx = modes.findIndex((m) => m.value === currentMode);
  return modes[(idx + 1) % modes.length].value;
}

/** Format model ID for display (strip trailing date suffix like -20250929). */
export function formatModel(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

// ─── Claude Code mode mapping ─────────────────────────────────────────────────
//
// The Companion simplifies Claude Code's 6 CLI permission modes into a 2-mode
// toggle (Plan / Agent) plus an "Ask" switch. The mapping:
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ UI              │ CLI Mode           │ Behavior                      │
//   │─────────────────│────────────────────│───────────────────────────────│
//   │ Plan            │ plan               │ Read-only. All writes prompt. │
//   │ Agent + Ask ON  │ acceptEdits        │ Edits auto-approved locally,  │
//   │                 │                    │ Bash & other tools prompted.  │
//   │ Agent + Ask OFF │ bypassPermissions  │ Everything auto-approved,     │
//   │                 │                    │ nothing sent over the wire.   │
//   └──────────────────────────────────────────────────────────────────────┘
//
// Key behaviors:
//   - In `bypassPermissions`, the CLI never sends `can_use_tool` — tools are
//     approved locally and the Companion never sees permission requests.
//   - In `acceptEdits`, file edits (Edit/Write) are approved locally; only
//     non-edit tools (Bash, etc.) send `can_use_tool` over the wire.
//   - In `plan`, ALL write operations send `can_use_tool` over the wire.
//
// Plan mode lifecycle:
//   1. User or agent enters plan mode → CLI set to "plan"
//   2. Agent explores, then calls ExitPlanMode
//   3. User approves/denies via the plan overlay UI
//   4. On approval, the SERVER must send `set_permission_mode` to the CLI
//      to switch it to `acceptEdits` or `bypassPermissions`. The CLI does
//      NOT auto-transition — without an explicit mode switch it stays in
//      `plan` and keeps prompting for every write.
//
// The other CLI modes (default, delegate, dontAsk) are not exposed in the UI.

/**
 * Maps the UI mode ("plan" or "agent") + askPermission toggle to the actual
 * Claude Code CLI permission mode string.
 *
 * | UI Mode | Ask Permission | CLI Mode          |
 * |---------|---------------|-------------------|
 * | plan    | true/false    | "plan"            |
 * | agent   | true          | "acceptEdits"     |
 * | agent   | false         | "bypassPermissions"|
 */
export function resolveClaudeCliMode(uiMode: string, askPermission: boolean): string {
  if (uiMode === "plan") return "plan";
  // agent mode
  return askPermission ? "acceptEdits" : "bypassPermissions";
}

/**
 * After a plan is approved (ExitPlanMode), determine the CLI mode to switch to.
 *
 * | Ask Permission | Post-Plan CLI Mode   |
 * |---------------|---------------------|
 * | true          | "acceptEdits"       |
 * | false         | "bypassPermissions" |
 */
export function resolvePostPlanMode(askPermission: boolean): string {
  return askPermission ? "acceptEdits" : "bypassPermissions";
}

/**
 * Derive the UI mode from a raw CLI permission mode string.
 * Used to translate server-reported permissionMode back to the UI concept.
 */
export function deriveUiMode(cliMode: string): "plan" | "agent" {
  return cliMode === "plan" ? "plan" : "agent";
}

// ─── Codex mode mapping ────────────────────────────────────────────────────────

/**
 * Maps the shared UI mode ("plan" or "agent") + askPermission toggle to the
 * raw Codex mode string consumed by the server/launcher.
 *
 * | UI Mode | Ask Permission | Codex Mode          |
 * |---------|----------------|---------------------|
 * | plan    | true           | "plan"              |
 * | plan    | false          | "plan"              |
 * | agent   | true           | "suggest"           |
 * | agent   | false          | "bypassPermissions" |
 */
export function resolveCodexCliMode(uiMode: string, askPermission: boolean): string {
  if (uiMode === "plan") return "plan";
  return askPermission ? "suggest" : "bypassPermissions";
}

/** Derive the shared UI mode from a raw Codex mode string. */
export function deriveCodexUiMode(cliMode: string): "plan" | "agent" {
  return cliMode === "plan" ? "plan" : "agent";
}

/** Derive askPermission state from a raw Codex mode string. */
export function deriveCodexAskPermission(cliMode: string): boolean {
  return cliMode !== "bypassPermissions";
}
