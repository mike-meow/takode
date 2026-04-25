"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BASE_URL,
  buildPanelHtml,
  getCspConnectOrigins,
  getEmbeddedAppUrl,
  getHealthUrl,
  normalizeBaseUrl,
} = require("../src/panel");
const {
  buildSelectionPayload,
  formatSelectionContext,
  getInclusiveEndLine,
  getSelectedLineCount,
  getSelectedLineCountFromRange,
} = require("../src/editor-context");

test("normalizeBaseUrl falls back to the default localhost URL", () => {
  assert.equal(normalizeBaseUrl(""), DEFAULT_BASE_URL + "/");
});

test("normalizeBaseUrl accepts bare localhost hosts for convenience", () => {
  assert.equal(normalizeBaseUrl("127.0.0.1:3456"), "http://localhost:3456/");
});

test("normalizeBaseUrl rejects non-http protocols so the iframe target stays predictable", () => {
  assert.throws(
    () => normalizeBaseUrl("file:///tmp/takode"),
    /Takode URL must use http:\/\/ or https:\/\//,
  );
});

test("getHealthUrl always points at the Takode root health endpoint", () => {
  assert.equal(
    getHealthUrl("http://127.0.0.1:5174/#/session/demo"),
    "http://127.0.0.1:5174/api/health",
  );
});

test("getEmbeddedAppUrl marks the iframe session as a VS Code host", () => {
  assert.equal(
    getEmbeddedAppUrl("http://localhost:5174/#/session/demo"),
    "http://localhost:5174/?takodeHost=vscode#/session/demo",
  );
});

test("buildPanelHtml embeds the Takode iframe URL and the health probe target", () => {
  const html = buildPanelHtml({
    baseUrl: "http://127.0.0.1:5174/",
    cspSource: "vscode-webview://test",
    nonce: "nonce-123",
  });

  // This keeps the test focused on the prototype behavior: the iframe must
  // load the exact Takode origin, while health checks keep the panel honest
  // when the local server is missing or restarted.
  assert.match(html, /<iframe[\s\S]*id="takode-frame"/);
  assert.match(html, /"http:\/\/127\.0\.0\.1:5174\/"/);
  assert.match(html, /"http:\/\/127\.0\.0\.1:5174\/\?takodeHost=vscode"/);
  assert.match(html, /"http:\/\/127\.0\.0\.1:5174\/api\/health"/);
  assert.match(html, /takode:vscode-context/);
  assert.match(html, /takode:vscode-ready/);
  assert.match(html, /takode:open-file/);
  assert.match(html, /targetKind: event\.data\.payload\.targetKind/);
  assert.match(html, /endLine: event\.data\.payload\.endLine/);
  assert.match(html, /postMessage\([\s\S]*"\*"\)/);
  assert.doesNotMatch(html, /selection-label/);
});

test("buildPanelHtml can load the iframe through a VS Code-forwarded URL", () => {
  const html = buildPanelHtml({
    baseUrl: "http://localhost:5174/",
    resolvedBaseUrl: "https://forwarded.example/vscode-remote-resource/takode/",
    cspSource: "vscode-webview://test",
    nonce: "nonce-123",
  });

  assert.match(html, /"https:\/\/forwarded\.example\/vscode-remote-resource\/takode\/\?takodeHost=vscode"/);
  assert.match(html, /"https:\/\/forwarded\.example\/vscode-remote-resource\/takode\/api\/health"/);
  assert.match(html, /frame-src[^"]*https:\/\/forwarded\.example/);
  assert.match(html, /connect-src[^"]*https:\/\/forwarded\.example/);
  assert.match(html, /loadingUrl\.textContent = baseUrl/);
  assert.match(html, /retryConnection/);
});

test("getCspConnectOrigins allows forwarded VS Code origins in addition to localhost defaults", () => {
  assert.deepEqual(
    getCspConnectOrigins(
      "http://localhost:3456/",
      "https://forwarded.example/vscode-remote-resource/takode/",
    ),
    [
      "http://127.0.0.1:*",
      "http://localhost:*",
      "https://127.0.0.1:*",
      "https://localhost:*",
      "http://localhost:3456",
      "https://forwarded.example",
    ],
  );
});

test("formatSelectionContext renders an inline cursor label when the selection is empty", () => {
  assert.equal(
    formatSelectionContext({
      pathLabel: "web/src/App.tsx",
      startLine: 42,
      startCharacter: 7,
      isEmpty: true,
      lineText: "const route = useMemo(() => parseHash(hash), [hash]);",
    }),
    "App.tsx:42",
  );
});

test("formatSelectionContext renders the selection range and preview text", () => {
  assert.equal(
    formatSelectionContext({
      pathLabel: "web/src/Composer.tsx",
      startLine: 12,
      startCharacter: 3,
      endLine: 14,
      endCharacter: 9,
      isEmpty: false,
      selectedText: "selected\ntext",
    }),
    "Composer.tsx:12-14",
  );
});

test("buildSelectionPayload counts full-line selections using VS Code range semantics", () => {
  assert.deepEqual(
    buildSelectionPayload({
      absolutePath: "/workspace/project/web/src/App.tsx",
      pathLabel: "web/src/App.tsx",
      startLine: 42,
      startCharacter: 1,
      endLine: 45,
      endCharacter: 1,
      isEmpty: false,
      selectedText: "line 42\nline 43\nline 44\n",
    }),
    {
      absolutePath: "/workspace/project/web/src/App.tsx",
      relativePath: "web/src/App.tsx",
      displayPath: "App.tsx",
      startLine: 42,
      endLine: 44,
      lineCount: 3,
    },
  );
});

test("buildSelectionPayload keeps cursor-only editor context as a single-line payload", () => {
  assert.deepEqual(
    buildSelectionPayload({
      absolutePath: "/workspace/project/web/src/App.tsx",
      pathLabel: "web/src/App.tsx",
      startLine: 42,
      startCharacter: 7,
      isEmpty: true,
      lineText: "const route = useMemo(() => parseHash(hash), [hash]);",
    }),
    {
      absolutePath: "/workspace/project/web/src/App.tsx",
      relativePath: "web/src/App.tsx",
      displayPath: "App.tsx",
      startLine: 42,
      endLine: 42,
      lineCount: 1,
    },
  );
});

test("getSelectedLineCount ignores a trailing newline in full-line selections", () => {
  assert.equal(getSelectedLineCount("line one\nline two\n"), 2);
});

test("getInclusiveEndLine treats end-of-next-line selections as inclusive of the prior line", () => {
  assert.equal(
    getInclusiveEndLine({
      startLine: 10,
      endLine: 13,
      endCharacter: 1,
      isEmpty: false,
    }),
    12,
  );
});

test("getSelectedLineCountFromRange uses the normalized inclusive end line", () => {
  assert.equal(
    getSelectedLineCountFromRange({
      startLine: 10,
      endLine: 13,
      endCharacter: 1,
      isEmpty: false,
    }),
    3,
  );
});
