import type { VsCodeSelectionState } from "../types.js";

export interface VsCodeSelectionContextPayload {
  absolutePath: string;
  relativePath: string;
  displayPath: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

export interface VsCodeSelectionContext extends VsCodeSelectionContextPayload {
  updatedAt: number;
}

type VsCodeSelectionLike =
  | VsCodeSelectionContext
  | VsCodeSelectionContextPayload
  | NonNullable<VsCodeSelectionState["selection"]>;

export const VSCODE_CONTEXT_SOURCE = "takode-vscode-prototype";
export const VSCODE_CONTEXT_MESSAGE_TYPE = "takode:vscode-context";
export const VSCODE_READY_MESSAGE_TYPE = "takode:vscode-ready";

export function isVsCodeSelectionContextPayload(value: unknown): value is VsCodeSelectionContextPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.absolutePath === "string" &&
    typeof record.relativePath === "string" &&
    typeof record.displayPath === "string" &&
    typeof record.startLine === "number" &&
    typeof record.endLine === "number" &&
    typeof record.lineCount === "number"
  );
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function getVsCodeSelectionSessionRoot(repoRoot?: string | null, cwd?: string | null): string | null {
  const normalizedRepoRoot = repoRoot ? normalizePath(repoRoot) : "";
  const normalizedCwd = cwd ? normalizePath(cwd) : "";
  if (normalizedRepoRoot && normalizedCwd.startsWith(normalizedRepoRoot + "/")) {
    return normalizedRepoRoot;
  }
  return normalizedCwd || normalizedRepoRoot || null;
}

export function resolveVsCodeSelectionForSession(
  context: VsCodeSelectionLike,
  sessionRoot: string | null,
): VsCodeSelectionContextPayload {
  const normalizedAbsolutePath = normalizePath(context.absolutePath);
  const normalizedSessionRoot = sessionRoot ? normalizePath(sessionRoot) : "";
  const displayPath =
    "displayPath" in context && typeof context.displayPath === "string" && context.displayPath.trim().length > 0
      ? context.displayPath
      : normalizedAbsolutePath.split("/").filter(Boolean).pop() || normalizedAbsolutePath;
  const sharedFields = {
    absolutePath: normalizedAbsolutePath,
    startLine: context.startLine,
    endLine: context.endLine,
    lineCount: context.lineCount,
  };

  if (!normalizedSessionRoot || !normalizedAbsolutePath.startsWith(normalizedSessionRoot + "/")) {
    return {
      ...sharedFields,
      relativePath: normalizedAbsolutePath,
      displayPath: normalizedAbsolutePath,
    };
  }

  const repoRelativePath = normalizedAbsolutePath.slice(normalizedSessionRoot.length + 1);
  return {
    ...sharedFields,
    relativePath: repoRelativePath,
    displayPath,
  };
}

export function formatVsCodeSelectionSummary(context: VsCodeSelectionContext | VsCodeSelectionContextPayload): string {
  const noun = context.lineCount === 1 ? "line" : "lines";
  return `${context.lineCount} ${noun} selected`;
}

export function formatVsCodeSelectionAttachmentLabel(
  context: VsCodeSelectionContext | VsCodeSelectionContextPayload,
): string {
  if (context.startLine === context.endLine) {
    return `${context.displayPath}:${context.startLine}`;
  }
  return `${context.displayPath}:${context.startLine}-${context.endLine}`;
}

export function buildVsCodeSelectionPrompt(context: VsCodeSelectionContext | VsCodeSelectionContextPayload): string {
  if (context.startLine === context.endLine) {
    return `[user selection in VSCode: ${context.relativePath} line ${context.startLine}] (this may or may not be relevant)`;
  }
  return `[user selection in VSCode: ${context.relativePath} lines ${context.startLine}-${context.endLine}] (this may or may not be relevant)`;
}

export function maybeReadVsCodeSelectionContext(value: unknown): VsCodeSelectionContextPayload | null | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.source !== VSCODE_CONTEXT_SOURCE || record.type !== VSCODE_CONTEXT_MESSAGE_TYPE) {
    return undefined;
  }
  if (record.payload === null) {
    return null;
  }
  return isVsCodeSelectionContextPayload(record.payload) ? record.payload : undefined;
}

export function announceVsCodeReady(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.parent?.postMessage(
      {
        source: VSCODE_CONTEXT_SOURCE,
        type: VSCODE_READY_MESSAGE_TYPE,
      },
      "*",
    );
  } catch {
    // Ignore cross-origin/window access issues. The browser-only app works without this bridge.
  }
}
