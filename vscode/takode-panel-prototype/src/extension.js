"use strict";

const vscode = require("vscode");
const { buildPanelHtml, normalizeBaseUrl } = require("./panel");
const { buildSelectionPayload } = require("./editor-context");

const PANEL_SPECS = {
  production: {
    kind: "production",
    viewType: "takode.panelPrototype",
    title: "Takode",
    configKey: "productionBaseUrl",
    defaultBaseUrl: "http://localhost:3456",
  },
  dev: {
    kind: "dev",
    viewType: "takode.panelPrototype.dev",
    title: "Takode (Dev)",
    configKey: "devBaseUrl",
    defaultBaseUrl: "http://localhost:5174",
  },
};

let lastSelectionPayload = null;
let outputChannel;

function logDebug(message, details) {
  if (!outputChannel) {
    return;
  }
  const ts = new Date().toISOString();
  if (typeof details === "undefined") {
    outputChannel.appendLine(`[${ts}] ${message}`);
    return;
  }
  outputChannel.appendLine(`[${ts}] ${message} ${JSON.stringify(details)}`);
}

function getNonce() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function getPanelSpec(kind) {
  return PANEL_SPECS[kind] || PANEL_SPECS.production;
}

function getConfiguredBaseUrl(kind) {
  const panelSpec = getPanelSpec(kind);
  const configured = vscode.workspace
    .getConfiguration()
    .get(`takodePrototype.${panelSpec.configKey}`, panelSpec.defaultBaseUrl);

  try {
    return normalizeBaseUrl(configured);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `Invalid Takode URL "${configured}". Falling back to ${panelSpec.defaultBaseUrl}. ${message}`,
    );
    return normalizeBaseUrl(panelSpec.defaultBaseUrl);
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

function renderPanel(panel, kind, baseUrl) {
  const panelSpec = getPanelSpec(kind);
  panel.title = panelSpec.title;
  logDebug("renderPanel", { kind, baseUrl });
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

function getAbsolutePath(editor) {
  if (!editor) {
    return "";
  }
  return editor.document.uri.fsPath || editor.document.fileName || "";
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
    absolutePath: getAbsolutePath(editor),
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
  logDebug("pushSelectionContext", {
    hasPanel: Boolean(panel),
    activeEditor: Boolean(vscode.window.activeTextEditor),
    payload: lastSelectionPayload,
  });
  void panel.webview.postMessage({
    type: "selectionContext",
    payload: lastSelectionPayload,
  });
}

async function openFileInPanelEditor(request) {
  if (!request || typeof request.absolutePath !== "string" || !request.absolutePath) {
    return;
  }

  const line = Math.max(1, Number(request.line) || 1);
  const column = Math.max(1, Number(request.column) || 1);
  const uri = vscode.Uri.file(request.absolutePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.Active,
  });
  const position = new vscode.Position(line - 1, column - 1);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function refreshSelectionContext(editor = vscode.window.activeTextEditor) {
  if (!editor) {
    logDebug("refreshSelectionContext", { editor: null, payload: lastSelectionPayload });
    return lastSelectionPayload;
  }
  lastSelectionPayload = getSelectionContext(editor);
  logDebug("refreshSelectionContext", {
    editor: getPathLabel(editor),
    payload: lastSelectionPayload,
  });
  return lastSelectionPayload;
}

function attachPanel(panel, kind) {
  const initialBaseUrl = getConfiguredBaseUrl(kind);

  panel.webview.options = {
    enableScripts: true,
    portMapping: getPortMappings(initialBaseUrl),
  };

  renderPanel(panel, kind, initialBaseUrl);

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

    if (message.type === "openFile" && typeof message.absolutePath === "string") {
      logDebug("webview->extension openFile", message);
      void openFileInPanelEditor(message).catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        logDebug("openFile failed", { absolutePath: message.absolutePath, error: text });
        void vscode.window.showErrorMessage(`Failed to open file in VS Code: ${text}`);
      });
      return;
    }

    if (message.type === "readyForSelectionContext") {
      logDebug("webview->extension readyForSelectionContext");
      pushSelectionContext(panel);
      return;
    }

    if (message.type === "debug" && typeof message.text === "string") {
      logDebug(`webview->extension ${message.text}`, message.data);
      return;
    }

    if (message.type === "info" && typeof message.text === "string") {
      logDebug(`webview->extension info ${message.text}`);
      void vscode.window.showInformationMessage(message.text);
    }
  });

  pushSelectionContext(panel);
}

function activate(context) {
  const panelsByKind = new Map();
  outputChannel = vscode.window.createOutputChannel("Takode Prototype");
  context.subscriptions.push(outputChannel);
  logDebug("activate");

  const showPanel = (kind) => {
    const existingPanel = panelsByKind.get(kind);
    if (existingPanel) {
      existingPanel.reveal(vscode.ViewColumn.Beside);
      return existingPanel;
    }

    const panelSpec = getPanelSpec(kind);
    const panel = vscode.window.createWebviewPanel(
      panelSpec.viewType,
      panelSpec.title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: getRetainContextWhenHidden(),
      },
    );

    attachPanel(panel, kind);
    panelsByKind.set(kind, panel);

    panel.onDidDispose(() => {
      if (panelsByKind.get(kind) === panel) {
        panelsByKind.delete(kind);
      }
    });

    return panel;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("takodePrototype.openPanel", () => {
      showPanel("production");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("takodePrototype.openDevPanel", () => {
      showPanel("dev");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("takodePrototype.reloadPanel", () => {
      logDebug("command reloadPanel");
      const panels = panelsByKind.size > 0 ? [...panelsByKind.values()] : [showPanel("production")];
      for (const panel of panels) {
        panel.webview.postMessage({ type: "reload" });
        pushSelectionContext(panel);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("takodePrototype.showDebugLog", () => {
      outputChannel.show(true);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      logDebug("event onDidChangeActiveTextEditor", { editor: editor ? getPathLabel(editor) : null });
      refreshSelectionContext(editor);
      for (const panel of panelsByKind.values()) {
        pushSelectionContext(panel);
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      logDebug("event onDidChangeTextEditorSelection", {
        editor: getPathLabel(event.textEditor),
        isEmpty: event.selections.every((selection) => selection.isEmpty),
      });
      refreshSelectionContext(event.textEditor);
      for (const panel of panelsByKind.values()) {
        pushSelectionContext(panel);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("takodePrototype")) {
        return;
      }

      for (const [kind, panel] of panelsByKind.entries()) {
        renderPanel(panel, kind, getConfiguredBaseUrl(kind));
        pushSelectionContext(panel);
      }
    }),
  );

  if (typeof vscode.window.registerWebviewPanelSerializer === "function") {
    for (const panelSpec of Object.values(PANEL_SPECS)) {
      context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(panelSpec.viewType, {
          async deserializeWebviewPanel(webviewPanel) {
            attachPanel(webviewPanel, panelSpec.kind);
            panelsByKind.set(panelSpec.kind, webviewPanel);
            webviewPanel.onDidDispose(() => {
              if (panelsByKind.get(panelSpec.kind) === webviewPanel) {
                panelsByKind.delete(panelSpec.kind);
              }
            });
          },
        }),
      );
    }
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
