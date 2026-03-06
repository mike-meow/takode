import { api } from "../api.js";
import { isEmbeddedInVsCode } from "./embed-context.js";

export const VSCODE_BRIDGE_SOURCE = "takode-vscode-prototype";
export const VSCODE_OPEN_FILE_MESSAGE_TYPE = "takode:open-file";

export interface VsCodeOpenFileTarget {
  absolutePath: string;
  line?: number;
  column?: number;
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
          line: Math.max(1, target.line ?? 1),
          column: Math.max(1, target.column ?? 1),
        },
      },
      "*",
    );
    return true;
  } catch {
    return false;
  }
}

export async function ensureVsCodeEditorPreference(): Promise<void> {
  if (!isEmbeddedInVsCode()) {
    return;
  }

  const settings = await api.getSettings();
  if (settings.editorConfig?.editor === "vscode") {
    return;
  }

  await api.updateSettings({
    editorConfig: { editor: "vscode" },
  });
}
