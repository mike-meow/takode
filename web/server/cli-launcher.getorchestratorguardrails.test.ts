import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

// Mock randomUUID and randomBytes so session IDs and auth tokens are deterministic
vi.mock("node:crypto", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    randomUUID: () => "test-session-id",
    randomBytes: (n: number) => ({ toString: () => "a".repeat(n * 2) }),
  };
});

// Mock child_process.exec to prevent actual git commands from running in tests
const mockExec = vi.hoisted(() =>
  vi.fn((_cmd: string, _opts: any, cb: any) => {
    if (_cmd.includes("git --no-optional-locks ls-files --error-unmatch --")) {
      const err = Object.assign(new Error("Command failed: git ls-files"), {
        code: 1,
        stderr: "error: pathspec '.claude/settings.json' did not match any file(s) known to git",
      });
      if (typeof _opts === "function") {
        _opts(err, "", "");
        return;
      }
      if (cb) cb(err, "", "");
      return;
    }
    // Simulate immediate success (exec callback signature: err, stdout, stderr)
    if (typeof _opts === "function") {
      _opts(null, "", "");
      return;
    }
    if (cb) cb(null, "", "");
  }),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    exec: mockExec,
  };
});

// Mock path-resolver for binary resolution
const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string): string | null => "/usr/bin/claude"));
const mockGetEnrichedPath = vi.hoisted(() => vi.fn(() => "/usr/bin:/usr/local/bin"));
const mockCaptureUserShellPath = vi.hoisted(() => vi.fn(() => "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"));
const mockCaptureUserShellEnv = vi.hoisted(() => vi.fn((): Record<string, string> => ({})));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  getEnrichedPath: mockGetEnrichedPath,
  captureUserShellPath: mockCaptureUserShellPath,
  captureUserShellEnv: mockCaptureUserShellEnv,
}));

// Mock container-manager for container validation in relaunch
const mockIsContainerAlive = vi.hoisted(() => vi.fn((): "running" | "stopped" | "missing" => "running"));
const mockHasBinaryInContainer = vi.hoisted(() => vi.fn((): boolean => true));
const mockStartContainer = vi.hoisted(() => vi.fn());
vi.mock("./container-manager.js", () => ({
  containerManager: {
    isContainerAlive: mockIsContainerAlive,
    hasBinaryInContainer: mockHasBinaryInContainer,
    startContainer: mockStartContainer,
  },
}));

// Mock fs operations for worktree guardrails (CLAUDE.md in .claude dirs)
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((..._args: any[]) => false));
const mockReadFileSync = vi.hoisted(() => vi.fn((..._args: any[]) => ""));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());
const mockSymlinkSync = vi.hoisted(() => vi.fn());
const mockLstatSync = vi.hoisted(() =>
  vi.fn((_path?: string): any => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
);
const isMockedPath = vi.hoisted(() => (path: string): boolean => {
  return (
    path.includes(".claude") ||
    path.includes(".codex") ||
    path.includes(".companion") ||
    path.startsWith("/tmp/worktrees/") ||
    path.startsWith("/tmp/main-repo")
  );
});

// Async mock functions for node:fs/promises — delegate to sync mocks so test
// setups (mockExistsSync.mockImplementation, mockReadFileSync.mockImplementation, etc.)
// and assertions (expect(mockSymlinkSync).toHaveBeenCalledWith, etc.) still work.
const mockMkdir = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockMkdirSync(...args);
  }),
);
const mockAccess = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    if (!mockExistsSync(args[0])) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
);
const mockReadFile = vi.hoisted(() => vi.fn(async (...args: any[]) => mockReadFileSync(...args)));
const mockCopyFile = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    // no-op for mocked paths
  }),
);
const mockCp = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => {
    // no-op for mocked paths
  }),
);
const mockReaddir = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any[]> => []));
const mockStat = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => ({
    isFile: () => true,
    mtimeMs: 1,
  })),
);
const mockRealpath = vi.hoisted(() => vi.fn(async (...args: any[]) => args[0]));
const mockWriteFile = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockWriteFileSync(...args);
  }),
);
const mockUnlink = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockUnlinkSync(...args);
  }),
);
const mockSymlink = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockSymlinkSync(...args);
  }),
);
const mockLstat = vi.hoisted(() => vi.fn(async (...args: any[]) => mockLstatSync(...args)));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    mkdirSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockMkdirSync(...args);
      }
      return actual.mkdirSync(...args);
    },
    existsSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockExistsSync(...args);
      }
      return actual.existsSync(...args);
    },
    readFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReadFileSync(...args);
      }
      return actual.readFileSync(...args);
    },
    writeFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockWriteFileSync(...args);
      }
      return actual.writeFileSync(...args);
    },
    unlinkSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockUnlinkSync(...args);
      }
      return actual.unlinkSync(...args);
    },
    symlinkSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockSymlinkSync(...args);
      }
      return actual.symlinkSync(...args);
    },
    lstatSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockLstatSync(...args);
      }
      return actual.lstatSync(...args);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    mkdir: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockMkdir(...args);
      }
      return actual.mkdir(...args);
    },
    access: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockAccess(...args);
      }
      return actual.access(...args);
    },
    readFile: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReadFile(...args);
      }
      return actual.readFile(...args);
    },
    copyFile: async (...args: any[]) => {
      if (
        (typeof args[0] === "string" && isMockedPath(args[0])) ||
        (typeof args[1] === "string" && isMockedPath(args[1]))
      ) {
        return mockCopyFile(...args);
      }
      return actual.copyFile(...args);
    },
    cp: async (...args: any[]) => {
      if (
        (typeof args[0] === "string" && isMockedPath(args[0])) ||
        (typeof args[1] === "string" && isMockedPath(args[1]))
      ) {
        return mockCp(...args);
      }
      return actual.cp(...args);
    },
    readdir: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReaddir(...args);
      }
      return actual.readdir(...args);
    },
    stat: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockStat(...args);
      }
      return actual.stat(...args);
    },
    writeFile: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockWriteFile(...args);
      }
      return actual.writeFile(...args);
    },
    unlink: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockUnlink(...args);
      }
      return actual.unlink(...args);
    },
    symlink: async (...args: any[]) => {
      // symlink(target, path) — route by target path
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockSymlink(...args);
      }
      return actual.symlink(...args);
    },
    lstat: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockLstat(...args);
      }
      return actual.lstat(...args);
    },
    realpath: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockRealpath(...args);
      }
      return actual.realpath(...args);
    },
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { SessionStore } from "./session-store.js";
import { CliLauncher } from "./cli-launcher.js";
import { HerdEventDispatcher } from "./herd-event-dispatcher.js";
import { createLauncherHerdChangeHandler } from "./herd-change-handler.js";
import type { TakodeEvent, TakodeHerdReassignedEventData } from "./session-types.js";

// ─── Bun.spawn mock ─────────────────────────────────────────────────────────

let exitResolve: (code: number) => void;

function createMockProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  exitResolve = resolve!;
  return {
    pid,
    kill: vi.fn(),
    exited: exitedPromise,
    stdout: null,
    stderr: null,
  };
}

function createMockCodexProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  exitResolve = resolve!;
  return {
    pid,
    kill: vi.fn(),
    exited: exitedPromise,
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
  };
}

const mockSpawn = vi.fn();
const bunGlobal = globalThis as typeof globalThis & { Bun?: any };
const hadBunGlobal = typeof bunGlobal.Bun !== "undefined";
const originalBunSpawn = hadBunGlobal ? bunGlobal.Bun!.spawn : undefined;
if (hadBunGlobal) {
  // In Bun runtime, globalThis.Bun is non-configurable; patch spawn directly.
  (bunGlobal.Bun as { spawn?: unknown }).spawn = mockSpawn;
} else {
  bunGlobal.Bun = { spawn: mockSpawn };
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
let store: SessionStore;
let launcher: CliLauncher;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply default: lstatSync throws ENOENT (file doesn't exist), matching real behavior
  mockLstatSync.mockImplementation(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  delete process.env.COMPANION_CONTAINER_SDK_HOST;
  delete process.env.COMPANION_FORCE_BYPASS_IN_CONTAINER;
  tempDir = mkdtempSync(join(tmpdir(), "launcher-test-"));
  store = new SessionStore(tempDir);
  launcher = new CliLauncher(3456, { serverId: "test-server-id" });
  launcher.setStore(store);
  mockSpawn.mockReturnValue(createMockProc());
  mockResolveBinary.mockReturnValue("/usr/bin/claude");
  mockGetEnrichedPath.mockReturnValue("/usr/bin:/usr/local/bin");
  mockCaptureUserShellPath.mockReturnValue("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  mockCaptureUserShellEnv.mockReturnValue({});
  mockCopyFile.mockReset();
  mockReaddir.mockReset();
  mockStat.mockReset();
  mockReaddir.mockResolvedValue([]);
  mockStat.mockResolvedValue({
    isFile: () => true,
    mtimeMs: 1,
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  if (hadBunGlobal) {
    (bunGlobal.Bun as { spawn?: unknown }).spawn = originalBunSpawn;
  } else {
    delete bunGlobal.Bun;
  }
});

// ─── launch ──────────────────────────────────────────────────────────────────

describe("getOrchestratorGuardrails", () => {
  it("returns Claude-family guardrails with skill loading and sub-skill references", () => {
    // getOrchestratorGuardrails returns a trimmed system prompt that references
    // sub-skill files for detailed workflows. Detailed content (worker selection
    // rules, full quest journey transitions, CLI docs) lives in sub-skill .md files.
    const guardrails = launcher.getOrchestratorGuardrails("claude");
    expect(guardrails).toContain("Takode -- Cross-Session Orchestration");
    // CLI, quest, and leader-dispatch references point to skills loaded on startup
    expect(guardrails).toContain("takode-orchestration");
    expect(guardrails).toContain("leader-dispatch");
    expect(guardrails).toContain("confirm");
    expect(guardrails).toContain("quest");
    expect(guardrails).toContain("/quest-design");
    expect(guardrails).toContain("sub-agent");
    // Core leader behaviors remain inline
    expect(guardrails).toContain("Create a quest for any non-trivial work");
    expect(guardrails).toContain("Never implement non-trivial changes yourself");
    // Quest Journey phase table kept inline as quick reference
    expect(guardrails).toContain("Quest Journey");
    expect(guardrails).toContain("QUEUED");
    expect(guardrails).toContain("IMPLEMENTING");
    expect(guardrails).toContain("Code Review");
    expect(guardrails).toContain("BOOKKEEPING");
    expect(guardrails).toContain("~/.companion/quest-journey-phases/<phase-id>/");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/alignment/leader.md`");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/alignment/assignee.md`");
    expect(guardrails).toContain("one confirmation can approve quest text, Journey, and dispatch plan");
    expect(guardrails).toContain("board-owned draft-or-active state for the quest");
    expect(guardrails).toContain("Work Board");
    // Spawn backend default note
    expect(guardrails).toContain("default to your own backend type");
    expect(guardrails).toContain("The 5-slot limit applies to workers only");
    expect(guardrails).toContain("archiving reviewers does not free worker-slot capacity");
    // Skill references: /leader-dispatch for dispatch workflow, sub-files for quest-journey and board-usage
    expect(guardrails).toContain("/leader-dispatch");
    expect(guardrails).toContain("quest-journey.md");
    expect(guardrails).toContain("board-usage.md");
    // Leader discipline: wait for user answer, follow the board-approved Journey
    expect(guardrails).toContain("WAIT for their answer");
    expect(guardrails).toContain("Follow the board-approved Quest Journey");
    expect(guardrails).toContain("recommended, not mandatory");
    expect(guardrails).toContain("ask what it contributes over merging that work into a later phase");
    expect(guardrails).toContain("`implement` includes normal investigation, root-cause analysis");
    expect(guardrails).toContain("routine `explore -> implement`");
    expect(guardrails).toContain("User Checkpoint is an intermediate user-participation stop");
    expect(guardrails).toContain("write the approved Journey to the board before or with dispatch");
    expect(guardrails).toContain("Do not use sleep-based waits");
    expect(guardrails).toContain("repeated `takode peek` / `takode scan` checks");
    expect(guardrails).toContain("wait for the next herd event");
    expect(guardrails).toContain("Only inspect a worker after a herd event");
    expect(guardrails).toContain(
      "prefer the plain-text forms of `takode info`, `takode peek`, `takode scan`, and `quest show`",
    );
    expect(guardrails).toContain("Use `--json` only when you need exact structured fields");
    expect(guardrails).toContain("quest feedback list --json");
    expect(guardrails).toContain("quest feedback list/latest/show");
    expect(guardrails).toContain("`commitShas`");
    expect(guardrails).toContain("Make every worker instruction phase-explicit");
    expect(guardrails).toContain("Initial dispatch authorizes **alignment only**");
    expect(guardrails).toContain("Initial Journey approval comes before dispatch");
    expect(guardrails).toContain("write the approved Journey to the board before or with dispatch");
    expect(guardrails).toContain(
      "The worker alignment phase then returns a lightweight read-in inside that approved Journey",
    );
    expect(guardrails).toContain("not a routine second user-approval gate");
    expect(guardrails).toContain("Alignment approval is leader-owned by default");
    expect(guardrails).toContain("Escalate alignment back to the user only");
    expect(guardrails).toContain("significant ambiguity, scope change, Journey revision, user-visible tradeoff");
    expect(guardrails).toContain("point the worker at the exact prior messages, quests, or discussions");
    expect(guardrails).toContain("Fresh human feedback resets the active cycle");
    expect(guardrails).toContain("do not let stale old-scope completions advance the quest");
    expect(guardrails).toContain("Zero-tracked-change quests still use explicit Journey phases");
    expect(guardrails).toContain("zero git-tracked changes");
    expect(guardrails).toContain("Initial pre-dispatch approval is a combined contract");
    expect(guardrails).toContain("expected worker choice or fresh-spawn intent");
    expect(guardrails).toContain("spawn fresh and dispatch immediately if approved");
    expect(guardrails).toContain(
      "Docs, skills, prompts, templates, and other text-only tracked-file edits are commit-producing work",
    );
    expect(guardrails).toContain("attach their synced SHAs with `quest complete ... --commit/--commits`");
    expect(guardrails).toContain("local CLI reminder switch");
    expect(guardrails).toContain("Leaders do not own worker quests");
    expect(guardrails).toContain("worker doing the job claims and completes the quest");
    expect(guardrails).toContain("Archiving a worktree worker removes its worktree and any uncommitted changes");
    expect(guardrails).toContain("ported, committed, or otherwise synced");
    expect(guardrails).toContain("Every active phase needs durable quest documentation");
    expect(guardrails).toContain("quest feedback add q-N --text-file /tmp/phase.md --tldr-file /tmp/phase-tldr.md");
    expect(guardrails).toContain("Phase-note TLDRs should preserve conclusions, decisions, evidence, blockers, risks");
    expect(guardrails).toContain("raw SHAs, branch names, exhaustive command lists");
    expect(guardrails).toContain("use explicit `--phase`, `--phase-position`, `--phase-occurrence`");
    expect(guardrails).toContain("final debrief metadata after port when the port worker could not reliably create it");
    expect(guardrails).toContain("Port handoff must also settle final debrief ownership");
    expect(guardrails).toContain("perform exactly the approved next phase, document the current phase on the quest");
    expect(guardrails).toContain("Reviewers should judge phase documentation quality, not just presence");
    expect(guardrails).toContain("Do **not** tell the worker to port yet");
    expect(guardrails).toContain(
      "Use `mental-simulation` when the question is whether a design, workflow, or responsibility split makes sense",
    );
    expect(guardrails).toContain("reviewers may do only small bounded reruns or repros");
    expect(guardrails).toContain("approval-gated runs rather than a reviewer acceptance pass");
    expect(guardrails).toContain("route back deliberately: `implement`");
    expect(guardrails).toContain("investigation, design, or other zero-tracked-change quests");
    expect(guardrails).toContain("address code-review findings");
    expect(guardrails).toContain("Leaders may revise the remaining Journey");
    expect(guardrails).toContain("what artifact to produce and to stop afterward");
    expect(guardrails).toContain("omit `port` from the Journey instead of using a separate board shortcut");
    expect(guardrails).toContain("send an explicit **port now** instruction");
    expect(guardrails).toContain("prefer `quest grep <pattern>` over manually scanning many `quest show` results");
    expect(guardrails).toContain("Use `quest list --text` for broad list filtering and `quest grep`");
    expect(guardrails).toContain("takode notify");
    expect(guardrails).toContain("needs-input");
    expect(guardrails).toContain("review");
    expect(guardrails).toContain("takode notify list");
    expect(guardrails).toContain("takode notify resolve <notification-id>");
    expect(guardrails).toContain("After the user answers a same-session `takode notify needs-input` prompt");
    expect(guardrails).toContain("Use this only for notifications created by your current session");
    expect(guardrails).toContain("Do not rely on deprecated leader reply suffixes");
    expect(guardrails).toContain("use marked leader responses plus `takode notify`");
    expect(guardrails).toContain("Every time you ask the user a question");
    expect(guardrails).toContain("First send the detailed question or decision text");
    expect(guardrails).toContain("`[thread:main]` or `[thread:q-N]`");
    expect(guardrails).toContain("then call `takode notify needs-input`");
    expect(guardrails).toContain("takode notify list");
    expect(guardrails).toContain("takode notify resolve <notification-id>");
    expect(guardrails).toContain("After the user answers a same-session `takode notify needs-input` prompt");
    expect(guardrails).toContain("Use this only for notifications created by your current session");
    expect(guardrails).toContain("so the user never misses it");
    expect(guardrails).toContain("Fresh human feedback outranks stale completions");
    expect(guardrails).toContain("Do **not** call `takode notify review` for quest completion");
    expect(guardrails).toContain("Takode already sends that review notification automatically");
    // Detailed content moved to sub-skill files, not inline
    expect(guardrails).not.toContain("takode list [--active] [--all]");
    expect(guardrails).not.toContain("takode peek <session> [--from N]");
    expect(guardrails).not.toContain("Maintain at most 5 sessions");
    // Worker selection details now in /leader-dispatch skill
    expect(guardrails).not.toContain("Queue if the best worker is busy");
    // Full phase transitions now in quest-journey.md
    expect(guardrails).not.toContain("QUEUED -> PLANNING");
  });

  it("returns Codex guardrails without Claude-only or sub-agent guidance", () => {
    const guardrails = launcher.getOrchestratorGuardrails("codex");
    expect(guardrails).toContain("leader session");
    expect(guardrails).toContain("Delegate all major work");
    // Skill references for detailed workflows
    expect(guardrails).toContain("/leader-dispatch");
    expect(guardrails).toContain("/quest-design");
    expect(guardrails).toContain("quest-journey.md");
    // Quest Journey phase table inline as quick reference
    expect(guardrails).toContain("Quest Journey");
    expect(guardrails).toContain("Code Review");
    expect(guardrails).toContain("~/.companion/quest-journey-phases/<phase-id>/");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/alignment/leader.md`");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/alignment/assignee.md`");
    // CLI reference delegated to skill
    expect(guardrails).toContain("takode-orchestration");
    expect(guardrails).toContain("default to your own backend type");
    expect(guardrails).toContain("The 5-slot limit applies to workers only");
    expect(guardrails).toContain("archiving reviewers does not free worker-slot capacity");
    expect(guardrails).toContain("Do not use sleep-based waits");
    expect(guardrails).toContain("wait for the next herd event");
    expect(guardrails).toContain("Make every worker instruction phase-explicit");
    expect(guardrails).toContain("Initial dispatch authorizes **alignment only**");
    expect(guardrails).toContain("Initial Journey approval comes before dispatch");
    expect(guardrails).toContain("write the approved Journey to the board before or with dispatch");
    expect(guardrails).toContain("Follow the board-approved Quest Journey");
    expect(guardrails).toContain("ask what it contributes over merging that work into a later phase");
    expect(guardrails).toContain("USER_CHECKPOINTING");
    expect(guardrails).toContain("User Checkpoint");
    expect(guardrails).toContain("not a routine second user-approval gate");
    expect(guardrails).toContain("Alignment approval is leader-owned by default");
    expect(guardrails).toContain("Escalate alignment back to the user only");
    expect(guardrails).toContain("board-owned draft-or-active state for the quest");
    expect(guardrails).toContain("point the worker at the exact prior messages, quests, or discussions");
    expect(guardrails).toContain("Initial pre-dispatch approval is a combined contract");
    expect(guardrails).toContain("expected worker choice or fresh-spawn intent");
    expect(guardrails).toContain("spawn fresh and dispatch immediately if approved");
    expect(guardrails).toContain("Leaders do not own worker quests");
    expect(guardrails).toContain("worker doing the job claims and completes the quest");
    expect(guardrails).toContain("Archiving a worktree worker removes its worktree and any uncommitted changes");
    expect(guardrails).toContain("ported, committed, or otherwise synced");
    expect(guardrails).toContain("Every active phase needs durable quest documentation");
    expect(guardrails).toContain("quest feedback add q-N --text-file /tmp/phase.md --tldr-file /tmp/phase-tldr.md");
    expect(guardrails).toContain("Phase-note TLDRs should preserve conclusions, decisions, evidence, blockers, risks");
    expect(guardrails).toContain("raw SHAs, branch names, exhaustive command lists");
    expect(guardrails).toContain("use explicit `--phase`, `--phase-position`, `--phase-occurrence`");
    expect(guardrails).toContain("perform exactly the approved next phase, document the current phase on the quest");
    expect(guardrails).toContain("Reviewers should judge phase documentation quality, not just presence");
    expect(guardrails).toContain("Do **not** tell the worker to port yet");
    expect(guardrails).toContain("Use `outcome-review` when a reviewer should make an acceptance judgment");
    expect(guardrails).toContain("small bounded reruns or repros");
    expect(guardrails).toContain("approval-gated runs rather than a reviewer acceptance pass");
    expect(guardrails).toContain("address code-review findings");
    expect(guardrails).toContain("Leaders may revise the remaining Journey");
    expect(guardrails).toContain("what artifact to produce and to stop afterward");
    expect(guardrails).toContain("send an explicit **port now** instruction");
    expect(guardrails).toContain("Every time you ask the user a question");
    expect(guardrails).toContain("First send the detailed question or decision text");
    expect(guardrails).toContain("`[thread:main]` or `[thread:q-N]`");
    expect(guardrails).toContain("then call `takode notify needs-input`");
    expect(guardrails).toContain("so the user never misses it");
    expect(guardrails).toContain("Do not rely on deprecated leader reply suffixes");
    expect(guardrails).toContain("Do **not** call `takode notify review` for quest completion");
    expect(guardrails).toContain("Takode already sends that review notification automatically");
    // No verbose CLI command docs
    expect(guardrails).not.toContain("takode list [--active] [--all]");
    expect(guardrails).not.toContain("CLAUDE.md");
    expect(guardrails).not.toContain("sub-agent");
    expect(guardrails).not.toMatch(/\bagent\b/i);
  });
});
