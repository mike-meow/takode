import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVsCodeSelectionPrompt,
  formatVsCodeSelectionAttachmentLabel,
  formatVsCodeSelectionSummary,
  VSCODE_CONTEXT_MESSAGE_TYPE,
  VSCODE_CONTEXT_SOURCE,
  VSCODE_READY_MESSAGE_TYPE,
  announceVsCodeReady,
  isVsCodeSelectionContextPayload,
  maybeReadVsCodeSelectionContext,
} from "./vscode-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("VS Code selection formatting", () => {
  const context = {
    absolutePath: "/workspace/project/web/src/App.tsx",
    relativePath: "web/src/App.tsx",
    displayPath: "App.tsx",
    startLine: 42,
    endLine: 44,
    lineCount: 3,
  };

  it("renders a compact composer summary", () => {
    expect(formatVsCodeSelectionSummary(context)).toBe("3 lines selected");
  });

  it("renders a file attachment label for the message bubble", () => {
    expect(formatVsCodeSelectionAttachmentLabel(context)).toBe("App.tsx:42-44");
  });

  it("builds the separate model prompt with the full relative path", () => {
    expect(buildVsCodeSelectionPrompt(context)).toBe(
      "[user selection in VSCode: web/src/App.tsx lines 42-44] (this may or may not be relevant)",
    );
  });
});

describe("isVsCodeSelectionContextPayload", () => {
  it("accepts the extension payload shape", () => {
    expect(
      isVsCodeSelectionContextPayload({
        absolutePath: "/workspace/project/web/src/App.tsx",
        relativePath: "web/src/App.tsx",
        displayPath: "App.tsx",
        startLine: 42,
        endLine: 44,
        lineCount: 3,
      }),
    ).toBe(true);
  });

  it("rejects incomplete payloads", () => {
    expect(isVsCodeSelectionContextPayload({ displayPath: "App.tsx" })).toBe(false);
  });
});

describe("maybeReadVsCodeSelectionContext", () => {
  it("extracts a valid extension payload", () => {
    expect(
      maybeReadVsCodeSelectionContext({
        source: VSCODE_CONTEXT_SOURCE,
        type: VSCODE_CONTEXT_MESSAGE_TYPE,
        payload: {
          relativePath: "web/src/App.tsx",
          absolutePath: "/workspace/project/web/src/App.tsx",
          displayPath: "App.tsx",
          startLine: 42,
          endLine: 44,
          lineCount: 3,
        },
      }),
    ).toEqual({
      relativePath: "web/src/App.tsx",
      absolutePath: "/workspace/project/web/src/App.tsx",
      displayPath: "App.tsx",
      startLine: 42,
      endLine: 44,
      lineCount: 3,
    });
  });

  it("returns null when the extension explicitly clears context", () => {
    expect(
      maybeReadVsCodeSelectionContext({
        source: VSCODE_CONTEXT_SOURCE,
        type: VSCODE_CONTEXT_MESSAGE_TYPE,
        payload: null,
      }),
    ).toBeNull();
  });

  it("ignores unrelated messages", () => {
    expect(
      maybeReadVsCodeSelectionContext({
        source: "something-else",
        type: VSCODE_CONTEXT_MESSAGE_TYPE,
        payload: null,
      }),
    ).toBeUndefined();
  });
});

describe("resolveVsCodeSelectionForSession", () => {
  const context = {
    absolutePath: "/workspace/project/web/src/App.tsx",
    relativePath: "web/src/App.tsx",
    displayPath: "App.tsx",
    startLine: 42,
    endLine: 44,
    lineCount: 3,
  };

  it("keeps a repo-relative path when the file is inside the session root", async () => {
    const { resolveVsCodeSelectionForSession } = await import("./vscode-context.js");
    expect(resolveVsCodeSelectionForSession(context, "/workspace/project")).toEqual(context);
  });

  it("falls back to the absolute path when the file is outside the session root", async () => {
    const { resolveVsCodeSelectionForSession } = await import("./vscode-context.js");
    expect(resolveVsCodeSelectionForSession(context, "/workspace/other")).toEqual({
      ...context,
      relativePath: "/workspace/project/web/src/App.tsx",
      displayPath: "/workspace/project/web/src/App.tsx",
    });
  });
});

describe("announceVsCodeReady", () => {
  it("notifies the parent window that the app can receive VS Code context", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("window", {
      parent: { postMessage },
    });

    announceVsCodeReady();

    expect(postMessage).toHaveBeenCalledWith(
      {
        source: VSCODE_CONTEXT_SOURCE,
        type: VSCODE_READY_MESSAGE_TYPE,
      },
      "*",
    );
  });
});
