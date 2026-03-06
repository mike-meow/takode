"use strict";

const vscode = require("vscode");
const { buildPanelHtml, DEFAULT_BASE_URL, normalizeBaseUrl } = require("./panel");
const { buildSelectionPayload } = require("./editor-context");

const VIEW_TYPE = "takode.panelPrototype";

let lastSelectionPayload = null;

function getNonce() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function getConfiguredBaseUrl() {
  const configured = vscode.workspace
    .getConfiguration()
    .get("takodePrototype.baseUrl", DEFAULT_BASE_URL);

  try {
    return normalizeBaseUrl(configured);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `Invalid Takode URL "${configured}". Falling back to ${DEFAULT_BASE_URL}. ${message}`,
    );
    return normalizeBaseUrl(DEFAULT_BASE_URL);
  }
}

function getRetainContextWhenHidden() {
  return vscode.workspace
    .getConfiguration()
    .get("takodePrototype.retainContextWhenHidden", true);
}

function getPortMappings(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return [];
  }
  if (url.hostname !== "localhost") {
    return [];
  }
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  if (!Number.isFinite(port) || port <= 0) {
    return [];
  }
  return [{ webviewPort: port, extensionHostPort: port }];
}

function renderPanel(panel, baseUrl) {
  panel.title = "Takode";
  panel.webview.html = buildPanelHtml({
    baseUrl,
    cspSource: panel.webview.cspSource,
    nonce: getNonce(),
  });
}

function getPathLabel(editor) {
  if (!editor) {
    return "";
  }
  const { document } = editor;
  if (document.isUntitled) {
    return document.fileName || "Untitled";
  }
  return vscode.workspace.asRelativePath(document.uri, false);
}

function getSelectionContext(editor = vscode.window.activeTextEditor) {
  if (!editor) {
    return null;
  }
  const selection = editor.selection;
  const start = selection.start;
  const end = selection.end;
  const lineText = editor.document.lineAt(selection.active.line).text;

  return buildSelectionPayload({
    pathLabel: getPathLabel(editor),
    startLine: start.line + 1,
    startCharacter: start.character + 1,
    endLine: end.line + 1,
    endCharacter: end.character + 1,
    isEmpty: selection.isEmpty,
    selectedText: selection.isEmpty ? "" : editor.document.getText(selection),
    lineText,
  });
}

function pushSelectionContext(panel) {
  if (!panel) {
    return;
  }
  if (vscode.window.activeTextEditor) {
    lastSelectionPayload = getSelectionContext(vscode.window.activeTextEditor);
  }
  void panel.webview.postMessage({
    type: "selectionContext",
    payload: lastSelectionPayload,
  });
}

function refreshSelectionContext(editor = vscode.window.activeTextEditor) {
  if (!editor) {
    return lastSelectionPayload;
  }
  lastSelectionPayload = getSelectionContext(editor);
  return lastSelectionPayload;
}

function attachPanel(panel, state) {
  const initialBaseUrl = getConfiguredBaseUrl();

  panel.webview.options = {
    enableScripts: true,
    portMapping: getPortMappings(initialBaseUrl),
  };

  renderPanel(panel, initialBaseUrl);

  panel.webview.onDidReceiveMessage((message) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "openExternal" && typeof message.url === "string") {
      void vscode.env.asExternalUri(vscode.Uri.parse(message.url)).then((externalUri) => {
        void vscode.env.openExternal(externalUri);
      });
      return;
    }

    if (message.type === "readyForSelectionContext") {
      pushSelectionContext(panel);
      return;
    }

    if (message.type === "info" && typeof message.text === "string") {
      void vscode.window.showInformationMessage(message.text);
    }
  });

  pushSelectionContext(panel);
}

function activate(context) {
  let panelRef;

  const showPanel = () => {
    if (panelRef) {
      panelRef.reveal(vscode.ViewColumn.Beside);
      return panelRef;
    }

    panelRef = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Takode",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: getRetainContextWhenHidden(),
      },
    );

    attachPanel(panelRef);

    panelRef.onDidDispose(() => {
      panelRef = undefined;
    });

    return panelRef;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("takodePrototype.openPanel", () => {
      showPanel();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("takodePrototype.reloadPanel", () => {
      const panel = showPanel();
      panel.webview.postMessage({ type: "reload" });
      pushSelectionContext(panel);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      refreshSelectionContext(editor);
      pushSelectionContext(panelRef);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      refreshSelectionContext(event.textEditor);
      pushSelectionContext(panelRef);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("takodePrototype") || !panelRef) {
        return;
      }

      renderPanel(panelRef, getConfiguredBaseUrl());
      pushSelectionContext(panelRef);
    }),
  );

  if (typeof vscode.window.registerWebviewPanelSerializer === "function") {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        async deserializeWebviewPanel(webviewPanel, state) {
          panelRef = webviewPanel;
          attachPanel(webviewPanel, state);
          webviewPanel.onDidDispose(() => {
            panelRef = undefined;
          });
        },
      }),
    );
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
