// @vitest-environment jsdom
import { api } from "../api.js";
import {
  ensureVsCodeEditorPreference,
  openFileInEmbeddedVsCode,
  resolveEmbeddedVsCodePath,
} from "./vscode-bridge.js";

vi.mock("../api.js", () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

describe("vscode-bridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
    vi.mocked(api.getSettings).mockReset();
    vi.mocked(api.updateSettings).mockReset();
  });

  it("resolves relative file paths against the session cwd", () => {
    expect(resolveEmbeddedVsCodePath("src/app.ts", "/workspace/project")).toBe("/workspace/project/src/app.ts");
  });

  it("keeps absolute file paths unchanged", () => {
    expect(resolveEmbeddedVsCodePath("/workspace/project/src/app.ts", "/workspace/project")).toBe("/workspace/project/src/app.ts");
  });

  it("posts file-open requests to the VS Code wrapper when embedded", () => {
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    const postMessageSpy = vi.spyOn(window.parent, "postMessage");

    expect(openFileInEmbeddedVsCode({ absolutePath: "/workspace/project/src/app.ts", line: 42, column: 3 })).toBe(true);
    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        source: "takode-vscode-prototype",
        type: "takode:open-file",
        payload: {
          absolutePath: "/workspace/project/src/app.ts",
          line: 42,
          column: 3,
        },
      },
      "*",
    );
  });

  it("does not post file-open requests outside the VS Code embed", () => {
    const postMessageSpy = vi.spyOn(window.parent, "postMessage");

    expect(openFileInEmbeddedVsCode({ absolutePath: "/workspace/project/src/app.ts", line: 42 })).toBe(false);
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it("switches the persisted editor preference to vscode when embedded", async () => {
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    vi.mocked(api.getSettings).mockResolvedValue({ editorConfig: { editor: "none" } } as Awaited<ReturnType<typeof api.getSettings>>);
    vi.mocked(api.updateSettings).mockResolvedValue({ editorConfig: { editor: "vscode" } } as Awaited<ReturnType<typeof api.updateSettings>>);

    await ensureVsCodeEditorPreference();

    expect(api.updateSettings).toHaveBeenCalledWith({ editorConfig: { editor: "vscode" } });
  });

  it("keeps the existing editor preference when it is already vscode", async () => {
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    vi.mocked(api.getSettings).mockResolvedValue({ editorConfig: { editor: "vscode" } } as Awaited<ReturnType<typeof api.getSettings>>);

    await ensureVsCodeEditorPreference();

    expect(api.updateSettings).not.toHaveBeenCalled();
  });
});
