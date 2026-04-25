import { api, type EditorKind } from "../api.js";
import { isEmbeddedInVsCode } from "./embed-context.js";

export const VSCODE_BRIDGE_SOURCE = "takode-vscode-prototype";
export const VSCODE_OPEN_FILE_MESSAGE_TYPE = "takode:open-file";

export interface VsCodeOpenFileTarget {
  absolutePath: string;
  line?: number;
  column?: number;
  endLine?: number;
  targetKind?: "file" | "directory";
}

export function buildLocalEditorUri(target: VsCodeOpenFileTarget, editor: "vscode-local" | "cursor"): string {
  const scheme = editor === "cursor" ? "cursor" : "vscode";
  const pathUri = `${scheme}://file/${encodeURI(target.absolutePath)}`;
  if (target.targetKind === "directory") {
    return pathUri;
  }
  return `${pathUri}:${Math.max(1, target.line ?? 1)}:${Math.max(1, target.column ?? 1)}`;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

export function resolveEmbeddedVsCodePath(filePath: string, cwd?: string | null): string | null {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) return null;
  if (isAbsolutePath(trimmedPath)) return trimmedPath;

  const trimmedCwd = typeof cwd === "string" ? cwd.trim().replace(/[\\/]+$/, "") : "";
  if (!trimmedCwd) return null;

  const cleanedPath = trimmedPath.replace(/^\.\/+/, "");
  return `${trimmedCwd}/${cleanedPath}`;
}

export function openFileInEmbeddedVsCode(target: VsCodeOpenFileTarget): boolean {
  if (!isEmbeddedInVsCode() || !target.absolutePath) {
    return false;
  }

  try {
    window.parent?.postMessage(
      {
        source: VSCODE_BRIDGE_SOURCE,
        type: VSCODE_OPEN_FILE_MESSAGE_TYPE,
        payload: {
          absolutePath: target.absolutePath,
          ...(target.targetKind === "directory"
            ? { targetKind: "directory" }
            : {
                line: Math.max(1, target.line ?? 1),
                column: Math.max(1, target.column ?? 1),
                ...(Number.isFinite(target.endLine) ? { endLine: Math.max(1, Number(target.endLine)) } : {}),
              }),
        },
      },
      "*",
    );
    return true;
  } catch {
    return false;
  }
}

export function showEditorOpenError(message: string): void {
  if (typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(message);
  }
}

export async function openFileWithEditorPreference(target: VsCodeOpenFileTarget, editor: EditorKind): Promise<boolean> {
  if (editor === "none") {
    return false;
  }

  if (editor === "vscode-remote") {
    await api.openVsCodeRemoteFile(target);
    return true;
  }

  if (editor === "vscode-local" && openFileInEmbeddedVsCode(target)) {
    return true;
  }

  const uri = buildLocalEditorUri(target, editor === "cursor" ? "cursor" : "vscode-local");
  window.open(uri, "_blank", "noopener,noreferrer");
  return true;
}

export async function openPathWithEditorPreference(target: VsCodeOpenFileTarget, editor: EditorKind): Promise<boolean> {
  return openFileWithEditorPreference(target, editor);
}

export async function ensureVsCodeEditorPreference(): Promise<void> {
  if (!isEmbeddedInVsCode()) {
    return;
  }

  const settings = await api.getSettings();
  if (settings.editorConfig?.editor === "vscode-remote") {
    return;
  }

  await api.updateSettings({
    editorConfig: { editor: "vscode-remote" },
  });
}
