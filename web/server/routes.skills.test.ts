import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}));

function addDir(path: string): void {
  if (!state.dirs.has(path)) state.dirs.add(path);
}

function addFile(path: string, content: string): void {
  state.files.set(path, content);
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/") || "/";
    addDir(dir);
  }
}

function listChildDirs(parent: string): Array<{ name: string; isDirectory: () => true }> {
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  const children = new Set<string>();
  for (const dir of state.dirs) {
    if (!dir.startsWith(prefix)) continue;
    const rest = dir.slice(prefix.length);
    if (!rest || rest.includes("/")) continue;
    children.add(rest);
  }
  return Array.from(children).map((name) => ({ name, isDirectory: () => true as const }));
}

vi.mock("node:os", () => ({
  homedir: () => "/home/tester",
  tmpdir: () => "/tmp",
}));

vi.mock("./path-resolver.js", () => ({
  resolveBinary: vi.fn(() => null),
  expandTilde: vi.fn((p: string) => p),
}));

vi.mock("./env-manager.js", () => ({
  listEnvs: vi.fn(() => Promise.resolve([])),
  getEnv: vi.fn(() => Promise.resolve(null)),
  getEffectiveImage: vi.fn(() => Promise.resolve(null)),
  createEnv: vi.fn(() => Promise.resolve(undefined)),
  updateEnv: vi.fn(() => Promise.resolve(undefined)),
  deleteEnv: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("./git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
  listBranches: vi.fn(() => []),
  listWorktrees: vi.fn(() => []),
  ensureWorktree: vi.fn(),
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  checkoutBranch: vi.fn(),
  removeWorktree: vi.fn(),
  isWorktreeDirty: vi.fn(() => false),
  resolveDefaultBranch: vi.fn(() => "main"),
}));

vi.mock("./session-names.js", () => ({
  getName: vi.fn(() => undefined),
  setName: vi.fn(),
  getAllNames: vi.fn(() => ({})),
  removeName: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: "",
    pushoverApiToken: "",
    pushoverDelaySeconds: 30,
    pushoverEnabled: true,
    pushoverBaseUrl: "",
    claudeBinary: "",
    codexBinary: "",
    maxKeepAlive: 0,
    autoApprovalEnabled: false,
    autoApprovalModel: "haiku",
    updatedAt: 0,
  })),
  updateSettings: vi.fn((patch) => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: patch.pushoverUserKey ?? "",
    pushoverApiToken: patch.pushoverApiToken ?? "",
    pushoverDelaySeconds: patch.pushoverDelaySeconds ?? 30,
    pushoverEnabled: patch.pushoverEnabled ?? true,
    pushoverBaseUrl: patch.pushoverBaseUrl ?? "",
    claudeBinary: patch.claudeBinary ?? "",
    codexBinary: patch.codexBinary ?? "",
    maxKeepAlive: patch.maxKeepAlive ?? 0,
    autoApprovalEnabled: patch.autoApprovalEnabled ?? false,
    autoApprovalModel: patch.autoApprovalModel ?? "haiku",
    updatedAt: Date.now(),
  })),
  getServerName: vi.fn(() => ""),
  setServerName: vi.fn(),
  getServerId: vi.fn(() => "test-server-id"),
}));

vi.mock("./usage-limits.js", () => ({
  getUsageLimits: vi.fn(async () => ({ five_hour: null, seven_day: null, extra_usage: null })),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => state.dirs.has(path) || state.files.has(path)),
  readFileSync: vi.fn((path: string) => state.files.get(path) ?? ""),
  writeFileSync: vi.fn((path: string, content: string) => addFile(path, content)),
  unlinkSync: vi.fn((path: string) => {
    state.files.delete(path);
  }),
  mkdirSync: vi.fn((path: string) => addDir(path)),
  rmSync: vi.fn((path: string) => {
    for (const filePath of Array.from(state.files.keys())) {
      if (filePath === path || filePath.startsWith(`${path}/`)) state.files.delete(filePath);
    }
    for (const dirPath of Array.from(state.dirs.values())) {
      if (dirPath === path || dirPath.startsWith(`${path}/`)) state.dirs.delete(dirPath);
    }
  }),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async (path: string) => listChildDirs(path)),
  access: vi.fn(async (path: string) => {
    if (!state.dirs.has(path) && !state.files.has(path)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  }),
  readFile: vi.fn(async (path: string) => state.files.get(path) ?? ""),
  writeFile: vi.fn(async (path: string, content: string) => addFile(path, content)),
  unlink: vi.fn(async (path: string) => {
    state.files.delete(path);
  }),
  mkdir: vi.fn(async (path: string) => addDir(path)),
  rm: vi.fn(async (path: string) => {
    for (const filePath of Array.from(state.files.keys())) {
      if (filePath === path || filePath.startsWith(`${path}/`)) state.files.delete(filePath);
    }
    for (const dirPath of Array.from(state.dirs.values())) {
      if (dirPath === path || dirPath.startsWith(`${path}/`)) state.dirs.delete(dirPath);
    }
  }),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
}));

import { createRoutes } from "./routes.js";

function createMockLauncher() {
  return {
    getPort: vi.fn(() => 3456),
  } as any;
}

function createMockBridge() {
  return {
    getSession: vi.fn(() => null),
    getAllSessions: vi.fn(() => []),
    isBackendConnected: vi.fn(() => false),
    getCodexRateLimits: vi.fn(() => null),
    markSessionRead: vi.fn(() => true),
    markSessionUnread: vi.fn(() => true),
    markAllSessionsRead: vi.fn(),
    getSessionAttentionState: vi.fn(() => null),
    getSessionTaskHistory: vi.fn(() => []),
    getSessionKeywords: vi.fn(() => []),
  } as any;
}

describe("skills routes backend targeting", () => {
  let app: Hono;

  beforeEach(() => {
    state.files.clear();
    state.dirs.clear();

    // Seed independent skills in Claude and Codex homes.
    addFile(
      "/home/tester/.claude/skills/quest/SKILL.md",
      "---\nname: quest\ndescription: Claude quest\n---\n\n# Quest",
    );
    addFile(
      "/home/tester/.codex/skills/codex-only/SKILL.md",
      "---\nname: codex-only\ndescription: Codex skill\n---\n\n# Codex",
    );

    const sessionStore = { setArchived: vi.fn(async () => true), flushAll: vi.fn(async () => {}) } as any;
    const tracker = {
      addMapping: vi.fn(),
      getBySession: vi.fn(() => null),
      removeBySession: vi.fn(),
      isWorktreeInUse: vi.fn(() => false),
    } as any;
    const terminalManager = { getInfo: () => null, spawn: () => "", kill: () => {} } as any;

    app = new Hono();
    app.route("/api", createRoutes(createMockLauncher(), createMockBridge(), sessionStore, tracker, terminalManager));
  });

  it("lists union of skills by default and records which backend has each skill", async () => {
    // Validates default backend=both behavior for GET /api/skills.
    const res = await app.request("/api/skills");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ slug: string; backends: string[] }>;
    expect(json).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "quest", backends: ["claude"] }),
        expect.objectContaining({ slug: "codex-only", backends: ["codex"] }),
      ]),
    );
  });

  it("creates skill only in codex root when backend=codex", async () => {
    // Validates backend scoping for POST /api/skills.
    const res = await app.request("/api/skills?backend=codex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new skill", description: "d", content: "# New" }),
    });
    expect(res.status).toBe(200);
    expect(state.files.has("/home/tester/.codex/skills/new-skill/SKILL.md")).toBe(true);
    expect(state.files.has("/home/tester/.claude/skills/new-skill/SKILL.md")).toBe(false);
  });

  it("returns 400 for invalid backend", async () => {
    // Validates strict backend query parsing so callers don't silently get wrong scope.
    const res = await app.request("/api/skills?backend=foo");
    expect(res.status).toBe(400);
  });
});
