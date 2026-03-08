"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getSelectionApiUrl,
  getVsCodeWindowsApiUrl,
  getVsCodeWindowCommandsApiUrl,
  getVsCodeCommandResultApiUrl,
  buildSelectionSyncPayload,
  buildWindowStatePayload,
  createSelectionSyncManager,
} = require("../src/selection-sync");

test("selection-sync URL helpers target the phase-1/phase-2 VSCode REST endpoints", () => {
  assert.equal(
    getSelectionApiUrl("http://localhost:3456/#/session/demo"),
    "http://localhost:3456/api/vscode/selection",
  );
  assert.equal(
    getVsCodeWindowsApiUrl("http://localhost:3456/"),
    "http://localhost:3456/api/vscode/windows",
  );
  assert.equal(
    getVsCodeWindowCommandsApiUrl("http://localhost:3456", "window:a"),
    "http://localhost:3456/api/vscode/windows/window%3Aa/commands",
  );
  assert.equal(
    getVsCodeCommandResultApiUrl("http://localhost:3456", "window:a", "cmd/1"),
    "http://localhost:3456/api/vscode/windows/window%3Aa/commands/cmd%2F1/result",
  );
});

test("buildSelectionSyncPayload keeps selection data absolute-path based", () => {
  assert.deepEqual(
    buildSelectionSyncPayload(
      {
        absolutePath: "/workspace/project/web/src/App.tsx",
        startLine: 10,
        endLine: 12,
        lineCount: 3,
      },
      {
        sourceId: "vscode-window:test",
        sourceType: "vscode-window",
        sourceLabel: "VS Code",
      },
      1234,
    ),
    {
      selection: {
        absolutePath: "/workspace/project/web/src/App.tsx",
        startLine: 10,
        endLine: 12,
        lineCount: 3,
      },
      updatedAt: 1234,
      sourceId: "vscode-window:test",
      sourceType: "vscode-window",
      sourceLabel: "VS Code",
    },
  );
});

test("buildWindowStatePayload publishes workspace roots and activity metadata", () => {
  assert.deepEqual(
    buildWindowStatePayload(
      {
        workspaceRoots: ["/workspace/project", "/workspace/project/packages/app"],
        lastActivityAt: 1111,
      },
      {
        sourceId: "vscode-window:test",
        sourceType: "vscode-window",
        sourceLabel: "Repo",
      },
      1234,
    ),
    {
      sourceId: "vscode-window:test",
      sourceType: "vscode-window",
      sourceLabel: "Repo",
      workspaceRoots: ["/workspace/project", "/workspace/project/packages/app"],
      updatedAt: 1234,
      lastActivityAt: 1111,
    },
  );
});

test("selection sync publishes non-empty selections and clears to all configured base URLs", async () => {
  const calls = [];
  const manager = createSelectionSyncManager({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
    getBaseUrls: () => ["http://localhost:3456", "http://localhost:5174/"],
    getSourceInfo: () => ({
      sourceId: "vscode-window:test",
      sourceType: "vscode-window",
      sourceLabel: "VS Code",
    }),
  });

  await manager.publishSelection({
    absolutePath: "/workspace/project/web/src/App.tsx",
    startLine: 10,
    endLine: 12,
    lineCount: 3,
  });
  await manager.publishSelection(null);

  assert.equal(calls.length, 4);
  const firstPayload = JSON.parse(calls[0].options.body);
  assert.deepEqual(firstPayload.selection, {
    absolutePath: "/workspace/project/web/src/App.tsx",
    startLine: 10,
    endLine: 12,
    lineCount: 3,
  });
  const clearPayload = JSON.parse(calls[2].options.body);
  assert.equal(clearPayload.selection, null);
  assert.equal(clearPayload.sourceType, "vscode-window");
});

test("selection sync retries the same payload after a failed publish", async () => {
  const calls = [];
  let shouldSucceed = false;
  const manager = createSelectionSyncManager({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: shouldSucceed, status: shouldSucceed ? 200 : 503 };
    },
    getBaseUrls: () => ["http://localhost:3456"],
    getSourceInfo: () => ({
      sourceId: "vscode-window:test",
      sourceType: "vscode-window",
    }),
  });

  const selection = {
    absolutePath: "/workspace/project/web/src/App.tsx",
    startLine: 10,
    endLine: 12,
    lineCount: 3,
  };

  assert.equal(await manager.publishSelection(selection), false);
  shouldSucceed = true;
  assert.equal(await manager.publishSelection(selection), true);

  assert.equal(calls.length, 2);
});

test("window sync publishes workspace roots and deduplicates identical heartbeats unless forced", async () => {
  const calls = [];
  const manager = createSelectionSyncManager({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
    getBaseUrls: () => ["http://localhost:3456"],
    getSourceInfo: () => ({
      sourceId: "vscode-window:test",
      sourceType: "vscode-window",
    }),
    getWorkspaceRoots: () => ["/workspace/project"],
  });

  await manager.publishWindow({ lastActivityAt: 2000 });
  await manager.publishWindow({ lastActivityAt: 2001 });
  await manager.publishWindow({ force: true, lastActivityAt: 2002 });

  assert.equal(calls.length, 2);
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.workspaceRoots, ["/workspace/project"]);
  assert.equal(payload.lastActivityAt, 2000);
});

test("window sync retries the same heartbeat after a failed publish", async () => {
  const calls = [];
  let shouldSucceed = false;
  const manager = createSelectionSyncManager({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: shouldSucceed, status: shouldSucceed ? 200 : 503 };
    },
    getBaseUrls: () => ["http://localhost:3456"],
    getSourceInfo: () => ({
      sourceId: "vscode-window:test",
      sourceType: "vscode-window",
    }),
    getWorkspaceRoots: () => ["/workspace/project"],
  });

  assert.equal(await manager.publishWindow({ lastActivityAt: 2000 }), false);
  shouldSucceed = true;
  assert.equal(await manager.publishWindow({ lastActivityAt: 2000 }), true);

  assert.equal(calls.length, 2);
});

test("command polling executes remote open-file requests and posts results", async () => {
  const calls = [];
  const opened = [];
  const manager = createSelectionSyncManager({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (String(url).endsWith("/commands")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            commands: [{
              commandId: "cmd-1",
              sourceId: "vscode-window:test",
              target: {
                absolutePath: "/workspace/project/src/app.ts",
                line: 9,
                column: 2,
              },
              createdAt: 5000,
            }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    getBaseUrls: () => ["http://localhost:3456"],
    getSourceInfo: () => ({
      sourceId: "vscode-window:test",
      sourceType: "vscode-window",
    }),
    openFile: async (target) => {
      opened.push(target);
    },
  });

  await manager.pollCommands();

  assert.deepEqual(opened, [{
    absolutePath: "/workspace/project/src/app.ts",
    line: 9,
    column: 2,
  }]);
  assert.match(calls[0].url, /\/api\/vscode\/windows\/vscode-window%3Atest\/commands$/);
  assert.match(calls[1].url, /\/api\/vscode\/windows\/vscode-window%3Atest\/commands\/cmd-1\/result$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { ok: true });
  assert.match(calls[2].url, /\/api\/vscode\/windows$/);
});
