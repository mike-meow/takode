"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BASE_URL,
  buildPanelHtml,
  getHealthUrl,
  normalizeBaseUrl,
} = require("../src/panel");
const { formatSelectionContext, getSelectedLineCount } = require("../src/editor-context");

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
  assert.match(html, /"http:\/\/127\.0\.0\.1:5174\/api\/health"/);
  assert.match(html, /takode:vscode-context/);
  assert.match(html, /takode:vscode-ready/);
  assert.match(html, /postMessage\([\s\S]*"\*"\)/);
  assert.doesNotMatch(html, /selection-label/);
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
    "Composer.tsx:12-13",
  );
});

test("buildSelectionPayload returns null for an empty selection", () => {
  const { buildSelectionPayload } = require("../src/editor-context");
  assert.equal(
    buildSelectionPayload({
      pathLabel: "web/src/App.tsx",
      startLine: 42,
      startCharacter: 7,
      isEmpty: true,
      lineText: "const route = useMemo(() => parseHash(hash), [hash]);",
    }),
    null,
  );
});

test("getSelectedLineCount ignores a trailing newline in full-line selections", () => {
  assert.equal(getSelectedLineCount("line one\nline two\n"), 2);
});
