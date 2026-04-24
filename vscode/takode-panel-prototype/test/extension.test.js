"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

function createEditor(filePath) {
  return {
    document: {
      uri: { fsPath: filePath },
      fileName: filePath,
      isUntitled: false,
      lineAt: () => ({ text: "const answer = 42;" }),
      getText: () => "",
    },
    selection: {
      start: { line: 41, character: 6 },
      end: { line: 41, character: 6 },
      active: { line: 41, character: 6 },
      isEmpty: true,
    },
  };
}

function loadExtensionHarness() {
  const handlers = {
    commands: new Map(),
    panelDispose: [],
  };
  const publishSelectionCalls = [];
  const publishWindowCalls = [];
  const pollCommandsCalls = [];
  const postMessageCalls = [];
  const createdPanels = [];
  const activeEditor = createEditor("/workspace/project/web/src/App.tsx");

  const selectionSync = {
    publishSelection: async (...args) => {
      publishSelectionCalls.push(args);
      return true;
    },
    publishWindow: async (...args) => {
      publishWindowCalls.push(args);
      return true;
    },
    pollCommands: async (...args) => {
      pollCommandsCalls.push(args);
    },
  };

  const vscodeMock = {
    env: {
      sessionId: "",
      asExternalUri: async (uri) => uri,
      openExternal: async () => {},
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({
        get: (_key, defaultValue) => defaultValue,
      }),
      asRelativePath: (uri) => path.relative("/workspace/project", uri.fsPath).replace(/\\/g, "/"),
      onDidChangeWorkspaceFolders: (cb) => {
        handlers.workspaceFolders = cb;
        return { dispose() {} };
      },
      onDidChangeConfiguration: (cb) => {
        handlers.configuration = cb;
        return { dispose() {} };
      },
      openTextDocument: async () => activeEditor.document,
    },
    window: {
      activeTextEditor: activeEditor,
      createOutputChannel: () => ({
        appendLine() {},
        show() {},
        dispose() {},
      }),
      createWebviewPanel: () => {
        const panel = {
          webview: {
            options: {},
            cspSource: "vscode-webview://test",
            html: "",
            postMessage: async (message) => {
              postMessageCalls.push(message);
            },
            onDidReceiveMessage: (cb) => {
              handlers.panelMessage = cb;
              return { dispose() {} };
            },
          },
          title: "",
          reveal() {},
          onDidDispose: (cb) => {
            handlers.panelDispose.push(cb);
            return { dispose() {} };
          },
          dispose() {
            for (const cb of handlers.panelDispose) cb();
          },
        };
        createdPanels.push(panel);
        return panel;
      },
      onDidChangeActiveTextEditor: (cb) => {
        handlers.activeEditor = cb;
        return { dispose() {} };
      },
      onDidChangeTextEditorSelection: (cb) => {
        handlers.selection = cb;
        return { dispose() {} };
      },
      registerWebviewPanelSerializer: () => ({ dispose() {} }),
      showErrorMessage: async () => {},
      showInformationMessage: async () => {},
      showTextDocument: async () => activeEditor,
      ViewColumn: { Beside: 2, Active: 1 },
      TextEditorRevealType: { InCenter: 1 },
    },
    commands: {
      registerCommand: (name, cb) => {
        handlers.commands.set(name, cb);
        return { dispose() {} };
      },
    },
    Uri: {
      parse: (value) => ({ toString: () => value }),
      file: (value) => ({ fsPath: value }),
    },
    Position: class Position {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    Range: class Range {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    Selection: class Selection {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    ViewColumn: { Beside: 2, Active: 1 },
    TextEditorRevealType: { InCenter: 1 },
  };

  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const fakeIntervals = [];
  global.setInterval = (cb, ms) => {
    const handle = { cb, ms };
    fakeIntervals.push(handle);
    return handle;
  };
  global.clearInterval = () => {};

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") return vscodeMock;
    if (request === "./panel") {
      return {
        buildPanelHtml: () => "<html></html>",
        normalizeBaseUrl: (value) => {
          const raw = typeof value === "string" && value ? value : "http://localhost:3456/";
          return raw.endsWith("/") ? raw : `${raw}/`;
        },
      };
    }
    if (request === "./editor-context") {
      return {
        buildSelectionPayload: (input) => ({
          absolutePath: input.absolutePath,
          relativePath: input.pathLabel,
          displayPath: path.basename(input.pathLabel),
          startLine: input.startLine,
          endLine: input.isEmpty ? input.startLine : input.endLine,
          lineCount: input.isEmpty ? 1 : 2,
        }),
      };
    }
    if (request === "./selection-sync") {
      return {
        createSelectionSyncManager: () => selectionSync,
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const extensionPath = path.resolve(__dirname, "../src/extension.js");
  delete require.cache[extensionPath];
  const extension = require(extensionPath);

  function restore() {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    delete require.cache[extensionPath];
  }

  return {
    extension,
    handlers,
    publishSelectionCalls,
    publishWindowCalls,
    pollCommandsCalls,
    postMessageCalls,
    createdPanels,
    restore,
    activeEditor,
  };
}

test("package.json includes an unconditional activation fallback for panel-free background sync", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
  assert.ok(packageJson.activationEvents.includes("*"));
  assert.deepEqual(
    packageJson.activationEvents.filter((event) => event !== "*"),
    [
      "onStartupFinished",
      "onCommand:takodePrototype.openPanel",
      "onCommand:takodePrototype.openDevPanel",
      "onCommand:takodePrototype.reloadPanel",
      "onWebviewPanel:takode.panelPrototype",
      "onWebviewPanel:takode.panelPrototype.dev",
    ],
  );
});

test("background selection sync publishes even when the Takode panel has never been opened", async () => {
  const harness = loadExtensionHarness();
  try {
    const context = { subscriptions: [] };
    harness.extension.activate(context);

    await harness.handlers.selection({ textEditor: harness.activeEditor, selections: [harness.activeEditor.selection] });

    assert.equal(harness.createdPanels.length, 0);
    assert.equal(harness.postMessageCalls.length, 0);
    assert.ok(harness.publishSelectionCalls.length >= 2);
    const latestSelectionArgs = harness.publishSelectionCalls.at(-1);
    assert.deepEqual(latestSelectionArgs[0], {
      absolutePath: "/workspace/project/web/src/App.tsx",
      relativePath: "web/src/App.tsx",
      displayPath: "App.tsx",
      startLine: 42,
      endLine: 42,
      lineCount: 1,
    });
  } finally {
    harness.restore();
  }
});

test("background selection sync keeps publishing after the Takode panel is closed", async () => {
  const harness = loadExtensionHarness();
  try {
    const context = { subscriptions: [] };
    harness.extension.activate(context);

    const openPanel = harness.handlers.commands.get("takodePrototype.openPanel");
    assert.equal(typeof openPanel, "function");
    openPanel();
    assert.equal(harness.createdPanels.length, 1);

    const panel = harness.createdPanels[0];
    panel.dispose();
    await harness.handlers.selection({ textEditor: harness.activeEditor, selections: [harness.activeEditor.selection] });

    assert.ok(harness.publishSelectionCalls.length >= 2);
    const latestSelectionArgs = harness.publishSelectionCalls.at(-1);
    assert.deepEqual(latestSelectionArgs[0], {
      absolutePath: "/workspace/project/web/src/App.tsx",
      relativePath: "web/src/App.tsx",
      displayPath: "App.tsx",
      startLine: 42,
      endLine: 42,
      lineCount: 1,
    });
    assert.equal(harness.postMessageCalls.length > 0, true);
  } finally {
    harness.restore();
  }
});
