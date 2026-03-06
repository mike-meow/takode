export interface VsCodeSelectionContextPayload {
  relativePath: string;
  displayPath: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

export interface VsCodeSelectionContext extends VsCodeSelectionContextPayload {
  updatedAt: number;
}

export const VSCODE_CONTEXT_SOURCE = "takode-vscode-prototype";
export const VSCODE_CONTEXT_MESSAGE_TYPE = "takode:vscode-context";
export const VSCODE_READY_MESSAGE_TYPE = "takode:vscode-ready";

export function isVsCodeSelectionContextPayload(value: unknown): value is VsCodeSelectionContextPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.relativePath === "string"
    && typeof record.displayPath === "string"
    && typeof record.startLine === "number"
    && typeof record.endLine === "number"
    && typeof record.lineCount === "number"
  );
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

export function buildVsCodeSelectionPrompt(
  context: VsCodeSelectionContext | VsCodeSelectionContextPayload,
): string {
  if (context.startLine === context.endLine) {
    return `[user selection in VSCode: ${context.relativePath} line ${context.startLine}] (this may or may not be relevant)`;
  }
  return `[user selection in VSCode: ${context.relativePath} lines ${context.startLine}-${context.endLine}] (this may or may not be relevant)`;
}

export function maybeReadVsCodeSelectionContext(
  value: unknown,
): VsCodeSelectionContextPayload | null | undefined {
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
