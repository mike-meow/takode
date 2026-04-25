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

function loadExtensionHarness(options = {}) {
  const handlers = {
    commands: new Map(),
    panelDispose: [],
  };
  const publishSelectionCalls = [];
  const publishWindowCalls = [];
  const pollCommandsCalls = [];
  const postMessageCalls = [];
  const createdPanels = [];
  const executeCommandCalls = [];
  const openTextDocumentCalls = [];
  let selectionSyncOptions = null;
  const activeEditor = createEditor("/workspace/project/web/src/App.tsx");
  const originalFetch = global.fetch;
  const fetchCalls = [];

  if (options.useRealSelectionSync) {
    global.fetch = async (url, requestOptions = {}) => {
      fetchCalls.push({ url: String(url), options: requestOptions });
      if (requestOptions.method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ commands: [] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    };
  }

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
      asExternalUri: async (uri) => {
        const raw = uri?.toString?.() || String(uri);
        if (raw === "http://localhost:3456/") {
          return { toString: () => "https://forwarded.example/takode/" };
        }
        if (raw === "http://localhost:5174/") {
          return { toString: () => "https://forwarded.example/takode-dev/" };
        }
        return uri;
      },
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
      openTextDocument: async (uri) => {
        openTextDocumentCalls.push(uri);
        return activeEditor.document;
      },
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
      executeCommand: async (...args) => {
        executeCommandCalls.push(args);
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
        this.active = end;
        this.isEmpty = start.line === end.line && start.character === end.character;
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
      if (options.useRealSelectionSync) {
        return originalLoad(request, parent, isMain);
      }
      return {
        createSelectionSyncManager: (options) => {
          selectionSyncOptions = options;
          return selectionSync;
        },
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
    global.fetch = originalFetch;
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
    executeCommandCalls,
    openTextDocumentCalls,
    fetchCalls,
    getSelectionSyncOptions: () => selectionSyncOptions,
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

test("background selection sync includes forwarded VS Code URLs for panel-free publishing", async () => {
  const harness = loadExtensionHarness();
  try {
    const context = { subscriptions: [] };
    harness.extension.activate(context);
    await new Promise((resolve) => setImmediate(resolve));

    const selectionSyncOptions = harness.getSelectionSyncOptions();
    assert.ok(selectionSyncOptions);
    assert.deepEqual(selectionSyncOptions.getBaseUrls(), [
      "http://localhost:3456/",
      "http://localhost:5174/",
      "https://forwarded.example/takode/",
      "https://forwarded.example/takode-dev/",
    ]);
  } finally {
    harness.restore();
  }
});

test("background selection sync POSTs to forwarded endpoints after URL resolution without opening the panel", async () => {
  const harness = loadExtensionHarness({ useRealSelectionSync: true });
  try {
    const context = { subscriptions: [] };
    harness.extension.activate(context);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const postUrls = harness.fetchCalls
      .filter((call) => call.options?.method === "POST")
      .map((call) => call.url);

    assert.ok(postUrls.includes("https://forwarded.example/takode/api/vscode/selection"));
    assert.ok(postUrls.includes("https://forwarded.example/takode/api/vscode/windows"));
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

test("panel directory open requests use VS Code folder open instead of text document open", async () => {
  const harness = loadExtensionHarness();
  try {
    const context = { subscriptions: [] };
    harness.extension.activate(context);

    const openPanel = harness.handlers.commands.get("takodePrototype.openPanel");
    assert.equal(typeof openPanel, "function");
    openPanel();
    assert.equal(typeof harness.handlers.panelMessage, "function");

    harness.handlers.panelMessage({
      type: "openFile",
      absolutePath: "/workspace/project",
      targetKind: "directory",
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(harness.openTextDocumentCalls, []);
    assert.equal(harness.executeCommandCalls.length, 1);
    assert.deepEqual(harness.executeCommandCalls[0], [
      "vscode.openFolder",
      { fsPath: "/workspace/project" },
      true,
    ]);
  } finally {
    harness.restore();
  }
});

test("panel file open requests still open text documents and select the requested range", async () => {
  const harness = loadExtensionHarness();
  try {
    const context = { subscriptions: [] };
    harness.extension.activate(context);

    const openPanel = harness.handlers.commands.get("takodePrototype.openPanel");
    assert.equal(typeof openPanel, "function");
    openPanel();
    assert.equal(typeof harness.handlers.panelMessage, "function");

    harness.handlers.panelMessage({
      type: "openFile",
      absolutePath: "/workspace/project/web/src/App.tsx",
      line: 42,
      column: 7,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(harness.executeCommandCalls, []);
    assert.deepEqual(harness.openTextDocumentCalls, [{ fsPath: "/workspace/project/web/src/App.tsx" }]);
    assert.equal(harness.activeEditor.selection.start.line, 41);
    assert.equal(harness.activeEditor.selection.start.character, 6);
  } finally {
    harness.restore();
  }
});
