import { randomUUID, createHash } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access, copyFile, cp, readFile, realpath, writeFile, unlink, symlink, lstat } from "node:fs/promises";

const execPromise = promisify(execCb);
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Subprocess } from "bun";
import type { SessionStore } from "./session-store.js";
import type { BackendType } from "./session-types.js";
import { assertNever, isClaudeFamily } from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import { CodexAdapter } from "./codex-adapter.js";
import { resolveBinary, getEnrichedPath, captureUserShellEnv, captureUserShellPath } from "./path-resolver.js";
import { containerManager } from "./container-manager.js";
import { getLegacyCodexHome, resolveCompanionCodexSessionHome } from "./codex-home.js";
import { TAKODE_LINK_SYNTAX_INSTRUCTIONS } from "./link-syntax.js";
import { sessionTag } from "./session-tag.js";
import { getSessionAuthDir, getSessionAuthPath } from "../shared/session-auth.js";

/** Check if a file exists (async equivalent of existsSync). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

async function readProcessCmdline(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return raw.replace(/\0/g, " ").trim() || null;
  } catch {
    return null;
  }
}

function sanitizeSpawnArgsForLog(args: string[]): string {
  const secretKeyPattern = /(token|key|secret|password)/i;
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "-e" && i + 1 < out.length) {
      const envPair = out[i + 1];
      const eqIdx = envPair.indexOf("=");
      if (eqIdx > 0) {
        const k = envPair.slice(0, eqIdx);
        if (secretKeyPattern.test(k)) {
          out[i + 1] = `${k}=***`;
        }
      }
    }
  }
  return out.join(" ");
}

function mapCodexApprovalPolicy(permissionMode?: string, askPermission?: boolean): "never" | "untrusted" {
  const effectiveAskPermission =
    typeof askPermission === "boolean" ? askPermission : permissionMode !== "bypassPermissions";
  if (!effectiveAskPermission) return "never";
  return permissionMode === "bypassPermissions" ? "never" : "untrusted";
}

function resolveCodexSandbox(
  permissionMode?: string,
  requested?: "workspace-write" | "danger-full-access",
): "workspace-write" | "danger-full-access" {
  if (requested) return requested;
  return permissionMode === "bypassPermissions" ? "danger-full-access" : "workspace-write";
}

const SHELL_ENV_POLICY_SECTION = "shell_environment_policy";
const SHELL_ENV_POLICY_HEADER = `[${SHELL_ENV_POLICY_SECTION}]`;
const CODEX_FEATURES_SECTION = "features";
const CODEX_FEATURES_HEADER = `[${CODEX_FEATURES_SECTION}]`;
const CODEX_MULTI_AGENT_FEATURE = "multi_agent";

function mergeUniqueStrings(existing: string[], additions: string[]): string[] {
  const merged = [...existing];
  for (const value of additions) {
    if (!merged.includes(value)) merged.push(value);
  }
  return merged;
}

function extractQuotedStrings(input: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1].replace(/\\"/g, '"'));
  }
  return out;
}

function renderIncludeOnlyArray(vars: string[]): string[] {
  return ["include_only = [", ...vars.map((v) => `    "${v}",`), "]"];
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergePathStrings(paths: Array<string | undefined>): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const pathValue of paths) {
    for (const entry of (pathValue || "").split(":")) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(":");
}

function upsertShellEnvironmentIncludeOnly(configToml: string, requiredVars: string[]): string {
  if (requiredVars.length === 0) return configToml;
  const normalizedRequired = Array.from(new Set(requiredVars)).sort();
  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === SHELL_ENV_POLICY_HEADER.toLowerCase());

  if (sectionStart === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(SHELL_ENV_POLICY_HEADER);
    out.push(...renderIncludeOnlyArray(normalizedRequired));
    return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let includeStart = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (/^\s*include_only\s*=\s*\[/.test(lines[i])) {
      includeStart = i;
      break;
    }
  }

  if (includeStart === -1) {
    const out = [...lines];
    const insertAt = sectionStart + 1;
    out.splice(insertAt, 0, ...renderIncludeOnlyArray(normalizedRequired));
    return out.join("\n") + (endsWithNewline ? "\n" : "");
  }

  let includeEnd = includeStart;
  while (includeEnd < sectionEnd) {
    if (lines[includeEnd].includes("]")) break;
    includeEnd++;
  }
  if (includeEnd >= sectionEnd) includeEnd = includeStart;
  const includeBlock = lines.slice(includeStart, includeEnd + 1).join("\n");
  const existingVars = extractQuotedStrings(includeBlock);
  const mergedVars = mergeUniqueStrings(existingVars, normalizedRequired);
  const replacement = renderIncludeOnlyArray(mergedVars);
  const out = [...lines];
  out.splice(includeStart, includeEnd - includeStart + 1, ...replacement);
  return out.join("\n") + (endsWithNewline ? "\n" : "");
}

function upsertBooleanSettingInSection(configToml: string, sectionHeader: string, key: string, value: boolean): string {
  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === sectionHeader.toLowerCase());
  const renderedLine = `${key} = ${value ? "true" : "false"}`;

  if (sectionStart === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(sectionHeader);
    out.push(renderedLine);
    return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const keyIndex = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && keyPattern.test(line),
  );

  const out = [...lines];
  if (keyIndex === -1) {
    out.splice(sectionStart + 1, 0, renderedLine);
  } else {
    out[keyIndex] = renderedLine;
  }
  return out.join("\n") + (endsWithNewline ? "\n" : "");
}

export interface SdkSessionInfo {
  sessionId: string;
  /** Monotonic integer ID assigned at runtime (not persisted — regenerated on restart) */
  sessionNum?: number;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  /** Whether permission prompts are enabled (shared UI state; backend-specific mapping). */
  askPermission?: boolean;
  cwd: string;
  createdAt: number;
  /** Epoch ms of last user or CLI activity (used by idle manager) */
  lastActivityAt?: number;
  /** The CLI's internal session ID (from system.init), used for --resume */
  cliSessionId?: string;
  archived?: boolean;
  /** Epoch ms when this session was archived */
  archivedAt?: number;
  /** User-facing session name */
  name?: string;
  /** Which backend this session uses */
  backendType?: BackendType;
  /** Git branch from bridge state (enriched by REST API) */
  gitBranch?: string;
  /** Git ahead count (enriched by REST API) */
  gitAhead?: number;
  /** Git behind count (enriched by REST API) */
  gitBehind?: number;
  /** Total lines added (enriched by REST API) */
  totalLinesAdded?: number;
  /** Total lines removed (enriched by REST API) */
  totalLinesRemoved?: number;
  /** Whether internet/web search is enabled for Codex sessions */
  codexInternetAccess?: boolean;
  /** Sandbox mode selected for Codex sessions */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Reasoning effort selected for Codex sessions (e.g. low/medium/high). */
  codexReasoningEffort?: string;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** Set by idle manager before killing — lets the UI show a less alarming indicator */
  killedByIdleManager?: boolean;
  /** Whether --resume has already been retried once after a fast exit */
  resumeRetried?: boolean;

  // Worktree fields
  /** Whether this session uses a git worktree */
  isWorktree?: boolean;
  /** The original repo root path */
  repoRoot?: string;
  /** Conceptual branch this session is working on (what user selected) */
  branch?: string;
  /** Actual git branch in the worktree (may differ for -wt-N branches) */
  actualBranch?: string;

  /** Whether this is an assistant-mode session */
  isAssistant?: boolean;
  /** Whether this is an orchestrator session (has herd/orchestration privileges) */
  isOrchestrator?: boolean;
  /** Session UUID of the leader that has herded this worker (single leader per session) */
  herdedBy?: string;
  /** Env profile slug used at creation, for re-resolving env vars on relaunch */
  envSlug?: string;
  /** When true, the session auto-namer is suppressed (e.g. temporary reviewer sessions) */
  noAutoName?: boolean;
  /** Server-issued secret used to authenticate privileged REST calls from this session. */
  sessionAuthToken?: string;
  /** One-shot: resume-session-at UUID for revert (cleared after use) */
  resumeAt?: string;
  /** The Companion-injected system prompt constructed at launch time (for debugging in Session Info). */
  injectedSystemPrompt?: string;

  // Container fields
  /** Docker container ID when session runs inside a container */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
}

export interface LaunchOptions {
  model?: string;
  permissionMode?: string;
  /** Whether permission prompts are enabled (shared UI state; backend-specific mapping). */
  askPermission?: boolean;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  backendType?: BackendType;
  /** Codex sandbox mode. */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Whether Codex internet/web search should be enabled for this session. */
  codexInternetAccess?: boolean;
  /** Codex reasoning effort (e.g. low/medium/high). */
  codexReasoningEffort?: string;
  /** Optional override for CODEX_HOME used by Codex sessions. */
  codexHome?: string;
  /** Docker container ID — when set, CLI runs inside container via docker exec */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
  /** Pre-resolved worktree info from the session creation flow */
  worktreeInfo?: {
    isWorktree: boolean;
    repoRoot: string;
    branch: string;
    actualBranch: string;
    worktreePath: string;
  };
  /** CLI session ID to resume (from an external CLI session, e.g. VS Code or terminal) */
  resumeCliSessionId?: string;
  /** Plugin directories to load for SDK sessions (maps to --plugin-dir CLI flags). */
  pluginDirs?: string[];
  /** Extra instructions appended to the system prompt (e.g., orchestrator guardrails). */
  extraInstructions?: string;
}

// ─── Companion instruction injection (system prompt) ────────────────────────

/**
 * Build the Companion-specific instructions string injected into every session
 * via the system prompt. This is the single source of truth for all backends
 * (Claude CLI, SDK, Codex). Worktree-specific guardrails are included when
 * the session runs in a git worktree.
 */
function buildCompanionInstructions(opts?: {
  worktree?: { branch: string; repoRoot: string; parentBranch?: string };
  extraInstructions?: string;
}): string {
  const parts: string[] = [];

  if (opts?.worktree) {
    const { branch, repoRoot, parentBranch } = opts.worktree;
    const branchLabel = parentBranch ? `\`${branch}\` (created from \`${parentBranch}\`)` : `\`${branch}\``;
    const syncBaseBranch = parentBranch || branch;

    parts.push(`# Worktree Session — Branch Guardrails

You are working on branch: ${branchLabel}
This is a git worktree. The main repository is at: \`${repoRoot}\`

**Rules:**
1. DO NOT run \`git checkout\`, \`git switch\`, or any command that changes the current branch
2. All your work MUST stay on the \`${branch}\` branch
3. When committing, commit to \`${branch}\` only
4. If you need to reference code from another branch, use \`git show other-branch:path/to/file\`

## Porting Commits to the Main Repo

When asked to port, sync, or push commits from this worktree to the main repository (e.g. "sync to main repo", "port to main repo", "push to main repo"), follow this workflow **exactly**:

### Sync Context (Critical)

Use this context for port/sync/push requests in this session:
- Base repo checkout: \`${repoRoot}\`
- Base branch: \`${syncBaseBranch}\`

By default, "sync/port/push to main repo" means syncing to the base branch above.
Only sync to a different remote branch if the user explicitly names it (for example: \`origin/main\`).

1. **Check the main repo first.** Pull remote changes first: \`git -C ${repoRoot} fetch origin ${syncBaseBranch} && git -C ${repoRoot} pull --rebase origin ${syncBaseBranch}\` (development may happen on multiple machines). Then run \`git -C ${repoRoot} status\` — if there are uncommitted changes, **stop and tell the user** — another agent may have work in progress. Never run \`git reset --hard\`, \`git checkout .\`, or \`git clean\` on the main repo without explicit user approval. Read any new commits briefly to understand what changed since your branch diverged.
2. **Rebase in the worktree.** Rebase your worktree branch onto the main repo's local base branch. Since all worktrees share the same git object store, the main repo's local branch is directly visible as a ref — no fetch needed. Use \`git rebase ${syncBaseBranch}\`. Resolve all merge conflicts here in the worktree — this is the safe place to do it without affecting other agents.
3. **Cherry-pick clean commits to main.** Once the worktree branch is cleanly rebased with your new commits on top, cherry-pick only your new commits into the main repo using \`git -C ${repoRoot} cherry-pick <commit-hash>\`. Cherry-pick one at a time in chronological order.
4. **Handle unexpected conflicts.** If cherry-pick still conflicts (it shouldn't after a clean rebase), tell the user the conflicting files and ask how to proceed. Do not force-resolve or abort without asking.
5. **Verify and push.** Run \`git -C ${repoRoot} log --oneline -5\` to confirm the commits landed correctly, then \`git -C ${repoRoot} push origin ${syncBaseBranch}\` to push to the remote.
6. **Sync both worktree and local main branch.**
   - Reset this worktree branch to match local base branch: \`git reset --hard ${syncBaseBranch}\`.
   - Also fast-forward local base branch in the main repo checkout: \`git -C ${repoRoot} checkout ${syncBaseBranch} && git -C ${repoRoot} merge --ff-only origin/${syncBaseBranch}\`.
7. **Run tests post-merge.** After resetting, run the project's unit tests in the worktree to verify nothing broke from merging with main. If tests fail: (a) if the fix is straightforward, fix it in the worktree, commit, and re-sync following steps 1–6 above; (b) otherwise, explain the failures to the user and ask how to proceed.

### Completion Checklist

Do NOT report the sync as complete until ALL of the following are true:
- [ ] Main repo log shows the cherry-picked commits
- [ ] Worktree has been reset to match the main repo branch
- [ ] Tests have been run **after the reset** AND passed (or failures reported to user)
- [ ] Changes have been pushed to the remote

### Quest Status Rule

If you are working on a quest from this worktree session, do **NOT** transition it to \`needs_verification\` (or say it is ready for verification) until the sync workflow above is fully complete, the main repo contains the changes, and the branch has been pushed. If sync is still pending, leave the quest \`in_progress\`.`);
  }

  // Link syntax — always included (useful for all sessions)
  parts.push(`## Link Syntax

${TAKODE_LINK_SYNTAX_INSTRUCTIONS}`);

  // Source tag explanation so models understand message prefixes from startup
  parts.push(
    "## Message Source Tags\n\n" +
      "User messages are prefixed with a source tag: " +
      "`[User <time>]` = human operator, " +
      "`[Leader <time>]` = orchestrator session managing this worker.",
  );

  // User notification instructions
  parts.push(
    "## User notifications\n\n" +
      "Use `takode notify` to alert the user when they should come look at your work.\n\n" +
      "    takode notify <category>\n\n" +
      "Categories:\n" +
      "- **`needs-input`**: The user needs to provide information or make a decision, and no built-in tool covers it. " +
      "Note: AskUserQuestion and ExitPlanMode already notify the user -- do not call `takode notify` in addition to those.\n" +
      "- **`review`**: Something is ready for the user's eyes -- a quest reached verification, code is synced and testable, or a significant deliverable is complete.\n\n" +
      "Do not notify for routine progress or intermediate steps.",
  );

  if (opts?.extraInstructions) {
    parts.push(opts.extraInstructions);
  }

  return parts.join("\n\n");
}

interface OrchestratorGuardrailCopy {
  orchestratorRole: string;
  forwardedSessionLine: string;
  interruptedSubject: string;
  delegationLine: string;
}

function getClaudeOrchestratorGuardrailCopy(): OrchestratorGuardrailCopy {
  return {
    orchestratorRole: "agent",
    forwardedSessionLine:
      "- **`[Agent #N name HH:MM]`** -- a message sent by another agent session (via `takode send`)",
    interruptedSubject: "agent",
    delegationLine:
      "- **Always use async sub-agents.** When spinning up sub-agents via the Task tool, always use `run_in_background: true`. Synchronous sub-agents block your turn and prevent you from receiving and reacting to herd events or user messages until they complete.",
  };
}

function getCodexOrchestratorGuardrailCopy(): OrchestratorGuardrailCopy {
  return {
    orchestratorRole: "leader session",
    forwardedSessionLine: "- A forwarded message from another session may also appear with its own source tag",
    interruptedSubject: "worker session",
    delegationLine:
      "- **Delegate all major work.** Keep your own work to triage, coordination, and short spot checks. Send implementation, deeper investigation, and verification to worker sessions.",
  };
}

function renderOrchestratorGuardrails(port: number, copy: OrchestratorGuardrailCopy): string {
  return `# Takode -- Cross-Session Orchestration

You are an **orchestrator ${copy.orchestratorRole}**. You coordinate multiple worker sessions, monitor their progress, and decide when to intervene, send follow-up instructions, or notify the human.

The \`takode-orchestration\` and \`quest\` skills are loaded on startup with full CLI references. Use them as your source of truth for command syntax and detailed usage. When spawning workers, default to your own backend type unless the user specifies otherwise. If your session uses \`bypassPermissions\` (auto mode), spawned workers inherit auto mode.

## Quests as the Unit of Work

Always use **quests** as the basic unit of verifiable work. Quests carry context between sessions, and the comment system provides a persistent timeline that survives session archival. Create a quest for any non-trivial work before dispatching.

Workers have the same tools and skills you do. Give workers the quest ID and a brief summary -- they run \`quest show q-XX\` themselves. Don't paste quest content into messages.

## Herd Event Workflow

Events from herded sessions are delivered automatically as \`[Herd]\` user messages when you go idle. No polling needed.

**Message sources** -- every user message has a source tag:
- **\`[User HH:MM]\`** -- human operator
- **\`[Herd HH:MM]\`** -- automatic event summary from herded sessions
${copy.forwardedSessionLine}

**Reacting to events:**
- **\`turn_end\` (✓)**: Peek at output, send follow-up or mark done
- **\`turn_end\` (✗)**: Diagnose, send recovery instructions
- **\`turn_end\` (⊘)**: User stopped this ${copy.interruptedSubject} -- check if it needs redirection
- **\`permission_request\`**: Answer \`AskUserQuestion\`/\`ExitPlanMode\` with \`takode answer\`. Tool permissions are human-only. If \`(user-initiated)\`, don't answer
- **\`permission_resolved\`**: Worker unblocked, no action needed
- **\`session_error\`**: Investigate, decide whether to retry
- **\`user_message [User]\`**: Human sent a message directly to a worker -- may indicate new instructions

## Task Dispatch Lifecycle

Every dispatched task follows this sequence. Do not skip steps.

### 0. Refine (if needed)
- If no quest exists or it's in \`idea\` state, work with the user first to gather requirements
- Ask clarifying questions until the WHAT and WHY are unambiguous
- Create or update the quest with a clear description containing the full context a worker needs
- Do NOT dispatch until the quest is refined -- a vague quest produces vague work

### 1. Dispatch
- Choose a worker (see Worker Selection below)
- Send: quest ID, brief summary, and "Plan your approach before implementing."
- Instruct: \`quest claim <id>\` at start, \`quest complete <id> --items '...'\` when done, report lines changed
- Update the work board: \`takode board add <quest-id> --worker <N> --status "dispatched"\`

### 2. Plan Review
- Wait for the \`permission_request\` herd event (ExitPlanMode)
- **Read the full plan** -- don't just peek. Verify the worker fully understood the task and aligned with the goal
- Be skeptical and adversarial: does the plan actually address the root problem? Are there misunderstandings or shortcuts that would produce wrong results?
- It's better to reject and redirect now than to let the worker implement the wrong thing
- Approve or reject with specific feedback via \`takode answer\`

### 3. Monitor
- React to herd events as they arrive -- don't poll
- Steer if needed: scope refinements, corrections, additional context for the current task
- Do NOT send unrelated new tasks to a busy worker -- queue them and wait
- **When the user is directly steering a herded worker**: stay out of it. The user's direct instructions take priority. Don't intercept questions or redirect work. Resume normal coordination once the user stops interacting and the worker goes idle

### 4. Review Completion
When \`turn_end\` (✓) arrives with a quest transition:

**4a. Understand the work:**
- Run \`takode scan <session>\` to get the full turn history
- Peek and read important parts to understand the solution at a high level (no need to understand every implementation detail, but you must understand what was done and why)

**4b. Skeptic review:**
- Spawn a reviewer session (see Skeptic Review Workflow below) unless the task is trivial with very low misimplementation risk
- If the reviewer finds major issues: send findings to the worker for rework, then ask the same reviewer to re-review. Iterate until no major issues remain

**4c. Groom self-review:**
- Only after skeptic review passes: tell the worker to run \`/groom\` for self-review and incorporate suggestions

**4d. Groom compliance review:**
- After the worker reports back from groom, send the groom findings to the skeptic reviewer session and ask it to:
  1. Read the full groom output (what was recommended)
  2. Read what the worker actually addressed vs skipped
  3. Judge whether all reasonable groom recommendations have been properly addressed
  4. Return ACCEPT or CHALLENGE
- If CHALLENGE: send findings back to the worker, iterate
- Only proceed to step 5 when the skeptic reviewer ACCEPTs both implementation quality AND groom compliance

### 5. Port & Verify
- Tell the worker: "Port your changes to the main repo."
- Wait for the worker to confirm sync is complete (commits landed, tests passed, pushed to remote)
- Only after port is confirmed: transition the quest to \`needs_verification\`
- Update work board: \`takode board set <quest-id> --status "ported, needs_verification"\`

### 6. Next Task or Cleanup
- **Prefer sequential routing for related work.** When two tasks are closely related or likely to touch the same files (risking merge conflicts), route the follow-up to the same worker -- even if that means queuing and waiting. Work quality matters more than maximum parallelism
- **Spawn fresh for unrelated work.** Don't reuse a session for unrelated tasks. A fresh session with context pointers (relevant quest IDs, past session IDs) performs better than a stale session carrying irrelevant context
- **Only archive to make room.** Don't archive sessions unnecessarily. Only archive when spawning a new session would exceed the herd limit. Disconnected sessions are just like idle sessions -- sending them a message triggers reconnect
- Remove completed rows from the work board: \`takode board rm <quest-id>\`

## Worker Selection
- **Reuse** when the next task is a natural continuation of the worker's recent work (same feature, same files, direct follow-up)
- **Spawn fresh** when the task is unrelated or you're unsure. Point the new worker to relevant quests or past sessions for context
- Default to your own backend type. Only use a different backend if the user specifies

## Session Naming Behavior

Sessions start with random names. Use \`--fixed-name\` when spawning to set a permanent name (e.g., skeptic review sessions).

Auto-rename happens on first message and on turn completion. Quest claiming changes the session name to the quest title and pauses auto-naming while the quest is active. Quest completion re-enables auto-naming.

When referencing sessions, use session numbers (\`#107\`) which are stable -- names can change.

## Skeptic Review Workflow

Reviewer sessions are persistent quality gates for their parent worker:

- Spawn with: \`takode spawn --fixed-name 'Skeptic review of #XX' --no-worktree --message "..."\`
- The reviewer persists as long as the parent worker is alive -- reuse it for follow-up reviews and groom compliance checks
- Reviewer sessions do NOT count toward the 5-session herd limit
- When the parent worker is archived, delete (not archive) the reviewer session
- See the \`/skeptic-review\` skill for the full spawn template and review criteria

## Work Board

Use \`takode board\` to maintain a visible record of active and queued work:

- Display the board when dispatching new work, queueing work, or transitioning status
- Remove rows when quests reach \`needs_verification\` or \`done\`
- The board is your primary coordination tool -- it helps you track state and gives the user visibility into what's happening

## Leader Discipline

- **Never implement non-trivial changes yourself.** Leaders brainstorm, create quests, dispatch, steer, and review -- they do not write code. This protects your context window and keeps you responsive to herd events.
- **Include source conversation references.** When dispatching quests from a brainstorming discussion, include the session ID and message range so workers can inspect design rationale.
- **Don't let herd events override your decision to wait for the user.** If you asked the user a question, keep waiting even if herd events arrive. Acknowledge events briefly, but don't proceed until the user responds.
- **After context compaction, refresh state.** Run \`takode list --tasks\` to see your herd with each worker's recent task history before making dispatch decisions.
${copy.delegationLine}

**Task delegation style:**
- **Describe WHAT and WHY, not HOW.** Explain the desired outcome and context -- don't specify files or functions unless you have high confidence from recent direct observation.
- **Provide cross-quest context the worker wouldn't have.** Relay user decisions, rejected approaches, and related quests.
- **Include reproduction steps and user observations.** Screenshots, error messages, and user feedback are more valuable than your guesses.
- **Let workers choose the approach when you lack context to decide.**
- **Always require a plan before non-trivial implementation.** Append "Plan your approach before implementing."`;
}

/**
 * Manages CLI backend processes (Claude Code via --sdk-url WebSocket,
 * or Codex via app-server stdio).
 */
export class CliLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, Subprocess>();
  /** Runtime-only env vars per session (kept out of persisted launcher state). */
  private sessionEnvs = new Map<string, Record<string, string>>();
  private port: number;
  private serverId: string;
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  private onCodexAdapter: ((sessionId: string, adapter: CodexAdapter) => void) | null = null;
  private onClaudeSdkAdapter:
    | ((sessionId: string, adapter: import("./claude-sdk-adapter.js").ClaudeSdkAdapter) => void)
    | null = null;
  private onBeforeRelaunch: ((sessionId: string, backendType: BackendType) => void) | null = null;
  private exitHandlers: ((sessionId: string, exitCode: number | null) => void)[] = [];
  private settingsGetter: (() => { claudeBinary: string; codexBinary: string }) | null = null;
  /** Callback to resolve env profile variables by slug (set by server bootstrap). */
  private envResolver: ((slug: string) => Promise<Record<string, string> | null>) | null = null;

  /** Callback when herd relationships change (set by server bootstrap). */
  onHerdChanged: ((orchId: string) => void) | null = null;

  // ─── Integer session ID tracking ───────────────────────────────────────────
  private nextSessionNum = 0;
  /** UUID → integer session number */
  private sessionNumMap = new Map<string, number>();
  /** Integer session number → UUID */
  private sessionByNum = new Map<number, string>();

  constructor(port: number, options?: { serverId?: string }) {
    this.port = port;
    this.serverId = options?.serverId?.trim() || "unknown-server";
  }

  /** Get the server port number. */
  getPort(): number {
    return this.port;
  }

  /** Register a callback for when a CodexAdapter is created (WsBridge needs to attach it). */
  onCodexAdapterCreated(cb: (sessionId: string, adapter: CodexAdapter) => void): void {
    this.onCodexAdapter = cb;
  }

  /** Register a callback for when a ClaudeSdkAdapter is created (WsBridge needs to attach it). */
  onClaudeSdkAdapterCreated(
    cb: (sessionId: string, adapter: import("./claude-sdk-adapter.js").ClaudeSdkAdapter) => void,
  ): void {
    this.onClaudeSdkAdapter = cb;
  }

  /** Register a callback for when a CLI/Codex process exits. */
  onSessionExited(cb: (sessionId: string, exitCode: number | null) => void): void {
    this.exitHandlers.push(cb);
  }

  /** Register a callback invoked just before relaunch kills the old process.
   *  Lets ws-bridge mark the disconnect as intentional to prevent redundant
   *  auto-relaunch requests from the adapter disconnect handler. */
  onBeforeRelaunchCallback(cb: (sessionId: string, backendType: BackendType) => void): void {
    this.onBeforeRelaunch = cb;
  }

  /** Attach a persistent store for surviving server restarts. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  /** Attach a settings getter so relaunch() can read current binary settings. */
  setSettingsGetter(fn: () => { claudeBinary: string; codexBinary: string }): void {
    this.settingsGetter = fn;
  }

  /** Attach an env resolver so relaunch() can re-resolve env profiles after restart. */
  setEnvResolver(fn: (slug: string) => Promise<Record<string, string> | null>): void {
    this.envResolver = fn;
  }

  private async terminateKnownProcess(
    sessionId: string,
    pid: number | undefined,
    proc?: Subprocess,
    reason?: string,
  ): Promise<void> {
    if (!pid) return;

    try {
      if (proc) {
        proc.kill("SIGTERM");
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {}

    const exitedGracefully = proc
      ? await Promise.race([
          proc.exited.then(() => true).catch(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
        ])
      : await waitForProcessExit(pid, 2000);
    if (exitedGracefully) return;

    console.warn(
      `[cli-launcher] Process ${pid} for session ${sessionTag(sessionId)} did not exit after SIGTERM` +
        `${reason ? ` (${reason})` : ""}; escalating to SIGKILL`,
    );
    if (!proc) {
      const cmdline = await readProcessCmdline(pid);
      console.warn(
        `[cli-launcher] Refusing SIGKILL for untracked persisted pid ${pid} on session ${sessionTag(sessionId)}` +
          `${cmdline ? ` (still running: ${cmdline})` : ""}`,
      );
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await waitForProcessExit(pid, 1000);
  }

  // ─── Integer session ID management ─────────────────────────────────────────

  /** Assign a monotonic integer ID to a session. */
  private assignSessionNum(sessionId: string): number {
    const existing = this.sessionNumMap.get(sessionId);
    if (existing !== undefined) return existing;
    const num = this.nextSessionNum++;
    this.sessionNumMap.set(sessionId, num);
    this.sessionByNum.set(num, sessionId);
    return num;
  }

  /**
   * Resolve a session identifier to a full UUID.
   * Accepts: integer session number, full UUID, or UUID prefix (min 4 chars).
   * Returns null if no match found.
   */
  resolveSessionId(idOrNum: string): string | null {
    // Try integer lookup first
    const num = parseInt(idOrNum, 10);
    if (!isNaN(num) && String(num) === idOrNum) {
      return this.sessionByNum.get(num) ?? null;
    }
    // Exact UUID match
    if (this.sessions.has(idOrNum)) return idOrNum;
    // Prefix match (min 4 chars to avoid ambiguity)
    if (idOrNum.length >= 4) {
      const lower = idOrNum.toLowerCase();
      let match: string | null = null;
      for (const uuid of this.sessions.keys()) {
        if (uuid.toLowerCase().startsWith(lower)) {
          if (match !== null) return null; // ambiguous — multiple matches
          match = uuid;
        }
      }
      return match;
    }
    return null;
  }

  /** Get the integer session number for a UUID. */
  getSessionNum(sessionId: string): number | undefined {
    return this.sessionNumMap.get(sessionId);
  }

  /** Ensure a session has an auth token and return it. */
  private ensureSessionAuthToken(info: SdkSessionInfo): string {
    if (!info.sessionAuthToken) {
      info.sessionAuthToken = randomUUID();
      this.persistState();
    }
    return info.sessionAuthToken;
  }

  /** Get the auth token for a session, generating one for legacy sessions if missing. */
  getSessionAuthToken(sessionId: string): string | undefined {
    const info = this.sessions.get(sessionId);
    if (!info) return undefined;
    return this.ensureSessionAuthToken(info);
  }

  /** Verify a session auth token for privileged API operations. */
  verifySessionAuthToken(sessionId: string, token: string): boolean {
    if (!token) return false;
    const expected = this.getSessionAuthToken(sessionId);
    return !!expected && token === expected;
  }

  /** Persist launcher state to disk (debounced).
   *  Coalesces rapid calls into a single write. On NFS, each writeFile takes
   *  100-500ms and saturates the libuv threadpool, causing event loop stalls
   *  that break CLI ping/pong (10s timeout). */
  private persistState(): void {
    if (!this.store) return;
    if (this.persistTimer) return; // already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const data = Array.from(this.sessions.values());
      this.store!.saveLauncher(data);
    }, 150);
  }
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Restore sessions from disk and check which PIDs are still alive.
   * Returns the number of recovered sessions.
   */
  async restoreFromDisk(): Promise<number> {
    if (!this.store) return 0;
    const data = await this.store.loadLauncher<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let recovered = 0;
    for (const info of data) {
      if (this.sessions.has(info.sessionId)) continue;

      // Migrate legacy herdedBy array → string (pre-single-leader refactor)
      if (Array.isArray(info.herdedBy)) {
        info.herdedBy = (info.herdedBy as unknown as string[])[0] ?? undefined;
      }

      // Check if the process is still alive
      if (info.pid && info.state !== "exited") {
        try {
          process.kill(info.pid, 0); // signal 0 = just check if alive
          info.state = "starting"; // WS not yet re-established, wait for CLI to reconnect
          this.sessions.set(info.sessionId, info);
          recovered++;
        } catch {
          // Process is dead
          info.state = "exited";
          info.exitCode = -1;
          this.sessions.set(info.sessionId, info);
        }
      } else if (info.backendType === "claude-sdk" && info.state !== "exited") {
        // SDK sessions have no PID — the in-memory adapter is gone after server
        // restart.  Mark them as "exited" so handleBrowserOpen() will trigger
        // relaunch instead of optimistically assuming the adapter is alive.
        info.state = "exited";
        info.exitCode = -1;
        this.sessions.set(info.sessionId, info);
      } else {
        // Already exited or no PID
        this.sessions.set(info.sessionId, info);
      }
    }
    if (recovered > 0) {
      console.log(`[cli-launcher] Recovered ${recovered} live session(s) from disk`);
    }

    // Restore persisted session numbers, then assign new ones for legacy sessions without them.
    // This ensures integer IDs are stable across restarts — once assigned, they never change.
    const allSessions = Array.from(this.sessions.values());

    // Phase 1: Restore persisted sessionNums and find the max to set nextSessionNum
    let maxNum = -1;
    for (const info of allSessions) {
      if (info.sessionNum !== undefined && info.sessionNum !== null) {
        this.sessionNumMap.set(info.sessionId, info.sessionNum);
        this.sessionByNum.set(info.sessionNum, info.sessionId);
        if (info.sessionNum > maxNum) maxNum = info.sessionNum;
      }
    }
    this.nextSessionNum = maxNum + 1;

    // Phase 2: Assign new numbers to sessions that don't have one yet (legacy/pre-migration)
    const sorted = allSessions
      .filter((s) => s.sessionNum === undefined || s.sessionNum === null)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const info of sorted) {
      info.sessionNum = this.assignSessionNum(info.sessionId);
    }
    if (sorted.length > 0) {
      // Persist the newly assigned numbers so they're stable on next restart
      this.persistState();
    }
    console.log(
      `[cli-launcher] Session numbers: ${allSessions.length} total, ${sorted.length} newly assigned, next=#${this.nextSessionNum}`,
    );

    return recovered;
  }

  /**
   * Merge launcher data from disk into existing in-memory sessions.
   * Used after import to pick up cliSessionId and rewritten paths
   * without clobbering active session state (connected sockets, PIDs, etc.).
   */
  async mergeFromDisk(): Promise<number> {
    if (!this.store) return 0;
    const data = await this.store.loadLauncher<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let merged = 0;
    for (const info of data) {
      const existing = this.sessions.get(info.sessionId);
      if (!existing) continue; // handled by restoreFromDisk

      let changed = false;
      // Merge cliSessionId (critical for --resume after import)
      if (info.cliSessionId && !existing.cliSessionId) {
        existing.cliSessionId = info.cliSessionId;
        changed = true;
      }
      // Merge rewritten cwd (import rewrites paths for new machine)
      if (info.cwd && info.cwd !== existing.cwd) {
        existing.cwd = info.cwd;
        changed = true;
      }
      // Merge rewritten repoRoot
      if (info.repoRoot && info.repoRoot !== existing.repoRoot) {
        existing.repoRoot = info.repoRoot;
        changed = true;
      }
      if (changed) merged++;
    }
    if (merged > 0) {
      this.persistState();
      console.log(`[cli-launcher] Merged ${merged} session(s) from import`);
    }
    return merged;
  }

  /**
   * Launch a new CLI session (Claude Code or Codex).
   */
  async launch(options: LaunchOptions = {}): Promise<SdkSessionInfo> {
    const sessionId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const backendType = options.backendType || "claude";

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      permissionMode: options.permissionMode,
      askPermission: options.askPermission,
      cwd,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      backendType,
    };

    if (backendType === "codex") {
      info.codexInternetAccess = options.codexInternetAccess === true;
      info.codexSandbox = options.codexSandbox;
      info.codexReasoningEffort = options.codexReasoningEffort;
    }

    // Store container metadata if provided
    if (options.containerId) {
      info.containerId = options.containerId;
      info.containerName = options.containerName;
      info.containerImage = options.containerImage;
    }

    // Store worktree metadata if provided
    if (options.worktreeInfo) {
      info.isWorktree = options.worktreeInfo.isWorktree;
      info.repoRoot = options.worktreeInfo.repoRoot;
      info.branch = options.worktreeInfo.branch;
      info.actualBranch = options.worktreeInfo.actualBranch;
    }

    // Inject backend-specific worktree guardrails.
    if (info.isWorktree && info.branch) {
      await this.injectWorktreeGuardrails(
        info.cwd,
        info.actualBranch || info.branch,
        info.repoRoot || "",
        backendType,
        info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
      );
    }

    // Pre-set cliSessionId for resume so subsequent relaunches also use --resume
    if (options.resumeCliSessionId) {
      info.cliSessionId = options.resumeCliSessionId;
    }

    this.sessions.set(sessionId, info);

    // Assign monotonic integer session number
    info.sessionNum = this.assignSessionNum(sessionId);

    // Server-issued token for authenticating privileged REST requests.
    const sessionAuthToken = this.ensureSessionAuthToken(info);

    // Always inject companion identity/auth vars so agents can identify and authenticate themselves.
    const envWithSessionId = {
      ...options.env,
      COMPANION_SERVER_ID: this.serverId,
      COMPANION_SESSION_ID: sessionId,
      COMPANION_SESSION_NUMBER: String(info.sessionNum),
      COMPANION_AUTH_TOKEN: sessionAuthToken,
    };
    this.sessionEnvs.set(sessionId, envWithSessionId);
    options = { ...options, env: envWithSessionId };

    // Write session-auth file so takode/quest CLIs can authenticate when env vars are missing
    // (e.g., after CLI relaunch). Fire-and-forget — non-blocking.
    this.writeSessionAuthFile(cwd, sessionId, sessionAuthToken, this.port).catch(() => {});

    switch (backendType) {
      case "codex":
        this.spawnCodex(sessionId, info, options).catch((err) => {
          console.error(`[cli-launcher] Codex spawn failed for ${sessionTag(sessionId)}:`, err);
        });
        break;
      case "claude-sdk":
        // Await SDK spawn so the adapter is attached before launch() returns.
        // This ensures the browser sees backend_connected in the state_snapshot.
        await this.spawnClaudeSdk(sessionId, info, options);
        break;
      case "claude":
        this.spawnCLI(sessionId, info, {
          ...options,
          ...(options.resumeCliSessionId ? { resumeSessionId: options.resumeCliSessionId } : {}),
        });
        break;
      default:
        assertNever(backendType);
    }
    return info;
  }

  /**
   * Relaunch a CLI process for an existing session.
   * Kills the old process if still alive, then spawns a fresh CLI
   * that connects back to the same session in the WsBridge.
   */
  async relaunch(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };
    const binSettings = this.settingsGetter?.() ?? { claudeBinary: "", codexBinary: "" };

    // Kill old process if still alive
    const oldProc = this.processes.get(sessionId);
    // Notify ws-bridge before killing so it can mark the upcoming adapter
    // disconnect as intentional — prevents the disconnect handler from
    // requesting a redundant auto-relaunch that races with this one.
    const bt = info.backendType ?? "claude";
    if (oldProc || info.pid) {
      this.onBeforeRelaunch?.(sessionId, bt);
    }
    if (oldProc) {
      await this.terminateKnownProcess(sessionId, oldProc.pid, oldProc, "relaunch");
      this.processes.delete(sessionId);
    } else if (info.pid) {
      // Process from a previous server instance — kill by PID
      await this.terminateKnownProcess(sessionId, info.pid, undefined, "relaunch");
    }

    // Pre-flight validation for containerized sessions
    if (info.containerId) {
      const containerLabel = info.containerName || info.containerId.slice(0, 12);
      const containerState = containerManager.isContainerAlive(info.containerId);

      if (containerState === "missing") {
        console.error(
          `[cli-launcher] Container ${containerLabel} no longer exists for session ${sessionTag(sessionId)}`,
        );
        info.state = "exited";
        info.exitCode = 1;
        this.persistState();
        return {
          ok: false,
          error: `Container "${containerLabel}" was removed externally. Please create a new session.`,
        };
      }

      if (containerState === "stopped") {
        try {
          containerManager.startContainer(info.containerId);
          console.log(
            `[cli-launcher] Restarted stopped container ${containerLabel} for session ${sessionTag(sessionId)}`,
          );
        } catch (e) {
          info.state = "exited";
          info.exitCode = 1;
          this.persistState();
          return {
            ok: false,
            error: `Container "${containerLabel}" is stopped and could not be restarted: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }

      // Validate the configured CLI binary exists inside the container.
      const configuredBinary = (
        info.backendType === "codex" ? binSettings.codexBinary : binSettings.claudeBinary
      ).trim();
      const binary = (configuredBinary || (info.backendType === "codex" ? "codex" : "claude")).split(/\s+/)[0];

      if (!containerManager.hasBinaryInContainer(info.containerId, binary)) {
        console.error(
          `[cli-launcher] "${binary}" not found in container ${containerLabel} for session ${sessionTag(sessionId)}`,
        );
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return {
          ok: false,
          error: `"${binary}" command not found inside container "${containerLabel}". The container image may need to be rebuilt.`,
        };
      }
    }

    info.state = "starting";
    info.killedByIdleManager = false;

    console.log(
      `[cli-launcher] Relaunching session ${sessionTag(sessionId)} (cliSessionId: ${info.cliSessionId || "none"}, state: ${info.state}, backendType: ${info.backendType || "claude"})`,
    );
    this.recorder?.recordServerEvent(
      sessionId,
      "cli_relaunch",
      {
        cliSessionId: info.cliSessionId || null,
        hasResume: !!info.cliSessionId,
        backendType: info.backendType || "claude",
      },
      info.backendType || "claude",
      info.cwd,
    );

    let runtimeEnv = this.sessionEnvs.get(sessionId);
    const sessionAuthToken = this.ensureSessionAuthToken(info);

    // Ensure runtime env always carries the auth token (covers legacy in-memory maps).
    if (runtimeEnv && runtimeEnv.COMPANION_AUTH_TOKEN !== sessionAuthToken) {
      runtimeEnv = { ...runtimeEnv, COMPANION_AUTH_TOKEN: sessionAuthToken };
      this.sessionEnvs.set(sessionId, runtimeEnv);
    }

    // After server restart, sessionEnvs is empty (not persisted to disk).
    // Reconstruct essential env vars from persisted SdkSessionInfo fields
    // and re-resolve the env profile if one was used at creation time.
    if (!runtimeEnv) {
      const sessionNum = this.getSessionNum(sessionId);
      const reconstructed: Record<string, string> = {
        COMPANION_SERVER_ID: this.serverId,
        COMPANION_SESSION_ID: sessionId,
        COMPANION_SESSION_NUMBER: sessionNum !== undefined ? String(sessionNum) : "",
        COMPANION_AUTH_TOKEN: sessionAuthToken,
        COMPANION_PORT: String(this.port),
      };
      if (info.isOrchestrator) {
        reconstructed.TAKODE_ROLE = "orchestrator";
        reconstructed.TAKODE_API_PORT = String(this.port);
      }
      if (info.envSlug && this.envResolver) {
        const profileVars = await this.envResolver(info.envSlug);
        if (profileVars) Object.assign(reconstructed, profileVars);
      }
      this.sessionEnvs.set(sessionId, reconstructed);
      runtimeEnv = reconstructed;
    }

    try {
      const bt = info.backendType ?? "claude";
      switch (bt) {
        case "codex":
          await this.spawnCodex(sessionId, info, {
            model: info.model,
            permissionMode: info.permissionMode,
            askPermission: info.askPermission,
            cwd: info.cwd,
            codexBinary: binSettings.codexBinary || undefined,
            codexSandbox: info.codexSandbox,
            codexInternetAccess: info.codexInternetAccess,
            codexReasoningEffort: info.codexReasoningEffort,
            containerId: info.containerId,
            containerName: info.containerName,
            containerImage: info.containerImage,
            env: runtimeEnv,
          });
          break;
        case "claude-sdk":
          await this.spawnClaudeSdk(sessionId, info, {
            model: info.model,
            permissionMode: info.permissionMode,
            cwd: info.cwd,
            claudeBinary: binSettings.claudeBinary || undefined,
            env: runtimeEnv,
          });
          break;
        case "claude":
          this.spawnCLI(sessionId, info, {
            model: info.model,
            permissionMode: info.permissionMode,
            cwd: info.cwd,
            claudeBinary: binSettings.claudeBinary || undefined,
            resumeSessionId: info.cliSessionId,
            containerId: info.containerId,
            containerName: info.containerName,
            containerImage: info.containerImage,
            env: runtimeEnv,
          });
          break;
        default:
          assertNever(bt);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cli-launcher] Spawn failed during relaunch for session ${sessionTag(sessionId)}: ${msg}`);
      info.state = "exited";
      info.exitCode = 1;
      this.persistState();
      return { ok: false, error: `Failed to spawn process: ${msg}` };
    }

    // spawnCLI may fail silently (marks state="exited" and returns).
    // Re-read state since spawnCLI mutates info as a side effect.
    if ((info.state as string) === "exited") {
      return { ok: false, error: "Failed to spawn process (binary not found)" };
    }
    return { ok: true };
  }

  /**
   * Relaunch a CLI process, truncating conversation history to a specific
   * assistant message UUID via --resume-session-at.
   */
  async relaunchWithResumeAt(sessionId: string, resumeAt: string): Promise<{ ok: boolean; error?: string }> {
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };
    info.resumeAt = resumeAt;
    const result = await this.relaunch(sessionId);
    delete info.resumeAt;
    return result;
  }

  /**
   * Get all sessions in "starting" state (awaiting CLI WebSocket connection).
   */
  getStartingSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "starting");
  }

  private spawnCLI(
    sessionId: string,
    info: SdkSessionInfo,
    options: LaunchOptions & { resumeSessionId?: string },
  ): void {
    const isContainerized = !!options.containerId;

    // For containerized sessions, the CLI binary lives inside the container.
    // For host sessions, resolve the binary on the host.
    let binary = options.claudeBinary || "claude";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    // Allow overriding the host alias used by containerized Claude sessions.
    // Useful when host.docker.internal is unavailable in a given Docker setup.
    const containerSdkHost =
      (process.env.COMPANION_CONTAINER_SDK_HOST || "host.docker.internal").trim() || "host.docker.internal";

    // When running inside a container, the SDK URL should target the host alias
    // so the CLI can connect back to the Hono server running on the host.
    const sdkUrl = isContainerized
      ? `ws://${containerSdkHost}:${this.port}/ws/cli/${sessionId}`
      : `ws://localhost:${this.port}/ws/cli/${sessionId}`;

    // Claude Code rejects bypassPermissions when running with root/sudo. Most
    // container images run as root by default, so downgrade to acceptEdits unless
    // explicitly forced.
    let effectivePermissionMode = options.permissionMode;
    if (
      isContainerized &&
      options.permissionMode === "bypassPermissions" &&
      process.env.COMPANION_FORCE_BYPASS_IN_CONTAINER !== "1"
    ) {
      console.warn(
        `[cli-launcher] Session ${sessionId}: downgrading container permission mode ` +
          `from bypassPermissions to acceptEdits (set COMPANION_FORCE_BYPASS_IN_CONTAINER=1 to force bypass).`,
      );
      effectivePermissionMode = "acceptEdits";
      info.permissionMode = "acceptEdits";
    }

    const args: string[] = [
      "--sdk-url",
      sdkUrl,
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (effectivePermissionMode) {
      args.push("--permission-mode", effectivePermissionMode);
    }
    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    // Always pass -p "" for headless mode. When relaunching, also pass --resume
    // to restore the CLI's conversation context.
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
      console.log(`[cli-launcher] Passing --resume ${options.resumeSessionId}`);
    } else {
      console.warn(`[cli-launcher] No cliSessionId — starting fresh session`);
    }
    if (info.resumeAt) {
      args.push("--resume-session-at", info.resumeAt);
    }
    args.push("-p", "");

    // Inject Companion-specific instructions via system prompt (link syntax,
    // worktree branch guardrails, orchestrator guardrails, sync workflow).
    // This replaces the old approach of writing files into the user's repo.
    const companionInstructions = buildCompanionInstructions({
      ...(info.isWorktree && info.branch
        ? {
            worktree: {
              branch: info.actualBranch || info.branch,
              repoRoot: info.repoRoot || "",
              parentBranch: info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
            },
          }
        : {}),
      extraInstructions: options.extraInstructions,
    });
    if (companionInstructions) {
      args.push("--append-system-prompt", companionInstructions);
      info.injectedSystemPrompt = companionInstructions;
    }

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run CLI inside the container via docker exec -i.
      // Keeping stdin open avoids premature EOF-driven exits in SDK mode.
      // Environment variables are passed via -e flags to docker exec.
      const dockerArgs = ["docker", "exec", "-i"];

      // Pass env vars via -e flags
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      // Ensure CLAUDECODE is unset inside container
      dockerArgs.push("-e", "CLAUDECODE=");

      dockerArgs.push(options.containerId!);
      // Use a login shell so ~/.bashrc is sourced and nvm/bun/deno/etc are on PATH
      const innerCmd = [binary, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      // Host env for the docker CLI itself
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined; // cwd is set inside the container via -w at creation
    } else {
      // Host-based spawn (original behavior)
      spawnCmd = [binary, ...args];
      spawnEnv = {
        ...process.env,
        CLAUDECODE: undefined,
        ...options.env,
        PATH: getEnrichedPath(),
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning session ${sessionTag(sessionId)}${isContainerized ? " (container)" : ""}: ` +
        sanitizeSpawnArgsForLog(spawnCmd),
    );

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(spawnCmd, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cli-launcher] Failed to spawn CLI for session ${sessionTag(sessionId)}: ${msg}`);
      info.state = "exited";
      info.exitCode = 1;
      this.persistState();
      return;
    }

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Stream stdout/stderr for debugging
    this.pipeOutput(sessionId, proc);

    // Monitor process exit
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      const uptime = Date.now() - spawnedAt;
      console.log(`[cli-launcher] Session ${sessionTag(sessionId)} exited (code=${exitCode}, uptime=${uptime}ms)`);
      this.recorder?.recordServerEvent(
        sessionId,
        "cli_exit",
        {
          exitCode,
          uptime,
          hadResume: !!options.resumeSessionId,
        },
        info.backendType || "claude",
        info.cwd,
      );

      // Guard against stale exits: if a new process was already spawned
      // (e.g. relaunch timeout), this exit belongs to the old process.
      if (this.processes.get(sessionId) !== proc) {
        console.log(`[cli-launcher] Ignoring stale exit for session ${sessionTag(sessionId)}`);
        return;
      }

      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;

        // If the process exited almost immediately with --resume, the resume likely failed.
        if (uptime < 5000 && options.resumeSessionId) {
          if (!session.resumeRetried) {
            // First failure: retry once (the CLI might have been killed mid-write)
            console.warn(`[cli-launcher] --resume failed (${uptime}ms), retrying once...`);
            session.resumeRetried = true;
            // Don't clear cliSessionId — relaunch will retry with --resume
          } else {
            // Second failure: give up and start fresh
            console.error(`[cli-launcher] --resume failed twice. Clearing cliSessionId for fresh start.`);
            session.cliSessionId = undefined;
            session.resumeRetried = false;
          }
        }
      }
      this.processes.delete(sessionId);
      this.persistState();
      for (const handler of this.exitHandlers) {
        try {
          handler(sessionId, exitCode);
        } catch {}
      }
    });

    this.persistState();
  }

  /**
   * Spawn a Codex app-server subprocess for a session.
   * Unlike Claude Code (which connects back via WebSocket), Codex uses stdio.
   */

  /**
   * Spawn a Claude Code session using the Agent SDK (stdio transport).
   * No WebSocket — the SDK manages the process and communicates via stdin/stdout.
   * Eliminates 5-minute disconnect cycles and all associated reliability issues.
   */
  private async spawnClaudeSdk(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): Promise<void> {
    const { ClaudeSdkAdapter } = await import("./claude-sdk-adapter.js");
    const sdkInstructions = buildCompanionInstructions({
      ...(info.isWorktree && info.branch
        ? {
            worktree: {
              branch: info.actualBranch || info.branch,
              repoRoot: info.repoRoot || "",
              parentBranch: info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
            },
          }
        : {}),
      extraInstructions: options.extraInstructions,
    });
    if (sdkInstructions) info.injectedSystemPrompt = sdkInstructions;
    const adapter = new ClaudeSdkAdapter(sessionId, {
      model: options.model,
      cwd: info.cwd,
      permissionMode: options.permissionMode,
      cliSessionId: info.cliSessionId,
      env: options.env as Record<string, string | undefined>,
      claudeBinary: options.claudeBinary,
      recorder: this.recorder,
      pluginDirs: options.pluginDirs,
      instructions: sdkInstructions || undefined,
    });

    if (this.onClaudeSdkAdapter) {
      this.onClaudeSdkAdapter(sessionId, adapter);
    }

    info.state = "connected";
    this.persistState();
    console.log(`[cli-launcher] Claude SDK session ${sessionTag(sessionId)} started`);
  }

  /** Check if a path exists (async). */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prepare the Codex home directory with user-level artifacts.
   * Uses async fs operations to avoid blocking the event loop on NFS.
   */
  private async prepareCodexHome(codexHome: string): Promise<void> {
    await mkdir(codexHome, { recursive: true });

    const legacyHome = getLegacyCodexHome();
    if (resolve(legacyHome) === resolve(codexHome) || !(await this.pathExists(legacyHome))) {
      return;
    }

    // Bootstrap only the user-level artifacts Codex needs (auth/config/skills),
    // while intentionally skipping sessions/sqlite to avoid stale rollout indexes.
    const fileSeeds = ["auth.json", "config.toml", "models_cache.json", "version.json"];
    for (const name of fileSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!(await this.pathExists(dest)) && (await this.pathExists(src))) {
          await copyFile(src, dest);
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name} from legacy home:`, e);
      }
    }

    const dirSeeds = ["skills", "vendor_imports", "prompts", "rules"];
    for (const name of dirSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!(await this.pathExists(dest)) && (await this.pathExists(src))) {
          await cp(src, dest, { recursive: true });
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name}/ from legacy home:`, e);
      }
    }
  }

  /**
   * Ensure per-session Codex config includes Companion shell env access and
   * experimental multi-agent support for fresh/relaunched sessions.
   */
  private async ensureCodexSessionConfig(codexHome: string, envVars: string[]): Promise<void> {
    const configPath = join(codexHome, "config.toml");
    let current = "";
    try {
      current = await readFile(configPath, "utf-8");
    } catch {
      // No existing config is fine; we'll create one.
    }
    let next = upsertBooleanSettingInSection(current, CODEX_FEATURES_HEADER, CODEX_MULTI_AGENT_FEATURE, true);
    next = upsertShellEnvironmentIncludeOnly(next, ["PATH", ...envVars]);
    if (next !== current) {
      await writeFile(configPath, next, "utf-8");
    }
  }

  private async spawnCodex(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): Promise<void> {
    const isContainerized = !!options.containerId;

    let binary = options.codexBinary || "codex";
    if (!isContainerized) {
      const resolved = resolveBinary(binary);
      if (resolved) {
        binary = resolved;
      } else {
        console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
        info.state = "exited";
        info.exitCode = 127;
        this.persistState();
        return;
      }
    }

    const approvalPolicy = mapCodexApprovalPolicy(options.permissionMode, options.askPermission);
    const sandboxMode = resolveCodexSandbox(options.permissionMode, options.codexSandbox);
    // Set process-level defaults so Codex starts in the intended approval mode
    // before any JSON-RPC thread calls are made.
    const args: string[] = ["-a", approvalPolicy, "-s", sandboxMode, "app-server"];
    const internetEnabled = options.codexInternetAccess === true;
    args.push("-c", `tools.webSearch=${internetEnabled ? "true" : "false"}`);
    if (options.codexReasoningEffort) {
      args.push("-c", `model_reasoning_effort=${options.codexReasoningEffort}`);
    }
    const codexHome = resolveCompanionCodexSessionHome(sessionId, options.codexHome);
    const shellEnvVars = Object.keys(options.env || {}).filter(
      (name) => name.startsWith("COMPANION_") || name.startsWith("TAKODE_"),
    );
    if (!isContainerized) {
      await this.prepareCodexHome(codexHome);
      await this.ensureCodexSessionConfig(codexHome, shellEnvVars);
    }

    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (isContainerized) {
      // Run Codex inside the container via docker exec -i (stdin required for JSON-RPC)
      const dockerArgs = ["docker", "exec", "-i"];
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      dockerArgs.push("-e", "CLAUDECODE=");
      // Point Codex at /root/.codex where container-manager seeded auth/config
      dockerArgs.push("-e", "CODEX_HOME=/root/.codex");
      dockerArgs.push(options.containerId!);
      // Use a login shell so ~/.bashrc is sourced and nvm/bun/deno/etc are on PATH
      const innerCmd = [binary, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      dockerArgs.push("bash", "-lc", innerCmd);

      spawnCmd = dockerArgs;
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined;
    } else {
      // Host-based spawn — resolve node/shebang issues
      // The codex binary is a Node.js script with `#!/usr/bin/env node` shebang.
      // When Bun.spawn executes it, the kernel resolves `node` via /usr/bin/env
      // which may find the system Node (e.g. v12) instead of the nvm-managed one.
      // To guarantee the correct Node version, we resolve the `node` binary that
      // lives alongside `codex` and spawn `node <codex.js>` directly.
      const binaryDir = resolve(binary, "..");
      const siblingNode = join(binaryDir, "node");
      const companionBinDir = join(homedir(), ".companion", "bin");
      const localBinDir = join(homedir(), ".local", "bin");
      const bunBinDir = join(homedir(), ".bun", "bin");
      const enrichedPath = getEnrichedPath();
      const userShellPath = captureUserShellPath();
      const spawnPath = mergePathStrings([
        binaryDir,
        companionBinDir,
        localBinDir,
        bunBinDir,
        userShellPath,
        enrichedPath,
      ]);

      if (await fileExists(siblingNode)) {
        let codexScript: string;
        try {
          codexScript = await realpath(binary);
        } catch {
          codexScript = binary;
        }
        spawnCmd = [siblingNode, codexScript, ...args];
      } else {
        spawnCmd = [binary, ...args];
      }

      // Capture LiteLLM env vars from the user's login shell. When the
      // Companion server runs outside the user's normal shell (e.g. started
      // via `bun server/index.ts` without sourcing mai-agents .env), these
      // vars are missing from process.env. The Codex config.toml references
      // them via env_key but Codex can only read them from its own process
      // environment. For Claude sessions this isn't needed because the
      // configured claudeBinary typically points to claude.sh which sources
      // the env vars itself.
      const shellEnv = captureUserShellEnv(["LITELLM_API_KEY", "LITELLM_PROXY_URL", "LITELLM_BASE_URL"]);

      spawnEnv = {
        ...process.env,
        ...shellEnv,
        CLAUDECODE: undefined,
        ...options.env,
        CODEX_HOME: codexHome,
        PATH: spawnPath,
      };
      spawnCwd = info.cwd;
    }

    console.log(
      `[cli-launcher] Spawning Codex session ${sessionTag(sessionId)}${isContainerized ? " (container)" : ""}: ` +
        sanitizeSpawnArgsForLog(spawnCmd),
    );

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(spawnCmd, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cli-launcher] Failed to spawn Codex for session ${sessionTag(sessionId)}: ${msg}`);
      info.state = "exited";
      info.exitCode = 1;
      this.persistState();
      throw err;
    }

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stderr for debugging (stdout is used for JSON-RPC)
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    // Create the CodexAdapter which handles JSON-RPC and message translation
    // Pass the raw permission mode — the adapter maps it to Codex's approval policy
    const codexInstructions = buildCompanionInstructions({
      ...(info.isWorktree && info.branch
        ? {
            worktree: {
              branch: info.actualBranch || info.branch,
              repoRoot: info.repoRoot || "",
              parentBranch: info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
            },
          }
        : {}),
      extraInstructions: options.extraInstructions,
    });
    if (codexInstructions) info.injectedSystemPrompt = codexInstructions;
    const adapter = new CodexAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      approvalMode: options.permissionMode,
      askPermission: options.askPermission,
      threadId: info.cliSessionId,
      sandbox: sandboxMode,
      reasoningEffort: options.codexReasoningEffort,
      recorder: this.recorder ?? undefined,
      instructions: codexInstructions || undefined,
    });

    // Handle init errors — mark session as exited so UI shows failure.
    // Also clear cliSessionId so the next relaunch starts a fresh thread
    // instead of trying to resume one whose rollout may be missing.
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex session ${sessionTag(sessionId)} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      if (this.processes.get(sessionId) === proc) {
        this.processes.delete(sessionId);
      }
      void this.terminateKnownProcess(sessionId, proc.pid, proc, "codex_init_error").catch((err) => {
        console.error(
          `[cli-launcher] Failed to terminate broken Codex process for session ${sessionTag(sessionId)}:`,
          err,
        );
      });
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    if (this.onCodexAdapter) {
      this.onCodexAdapter(sessionId, adapter);
    }

    // Mark as connected immediately (no WS handshake needed for stdio)
    info.state = "connected";

    // Monitor process exit
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Codex session ${sessionTag(sessionId)} exited (code=${exitCode})`);

      // Guard against stale exits: if a new process was already spawned
      // (e.g. during relaunch), this exit belongs to the old process.
      // Without this guard, the stale handler stomps state to "exited" and
      // deletes the new process entry — causing zombie sessions where the
      // adapter is alive but the launcher thinks the session is dead.
      if (this.processes.get(sessionId) !== proc) {
        console.log(`[cli-launcher] Ignoring stale Codex exit for session ${sessionTag(sessionId)}`);
        return;
      }

      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
      for (const handler of this.exitHandlers) {
        try {
          handler(sessionId, exitCode);
        } catch {}
      }
    });

    this.persistState();
  }

  /**
   * Set up worktree environment: symlink project settings.
   * Guardrails content is now injected via system prompt (--append-system-prompt,
   * developer_instructions, appendSystemPrompt) instead of writing files.
   *
   * Only runs for actual worktree directories, never the main repo.
   */
  private async injectWorktreeGuardrails(
    worktreePath: string,
    branch: string,
    repoRoot: string,
    backendType: BackendType,
    _parentBranch?: string,
  ): Promise<void> {
    // Safety: never inject into the main repository itself
    if (worktreePath === repoRoot) {
      console.warn(`[cli-launcher] Skipping worktree setup: worktree path is the main repo (${repoRoot})`);
      return;
    }

    // Safety: only run if the worktree directory actually exists
    if (!(await fileExists(worktreePath))) {
      console.warn(`[cli-launcher] Skipping worktree setup: worktree path does not exist (${worktreePath})`);
      return;
    }

    // Claude and Claude SDK: symlink project settings (.claude/settings.json)
    // so the worktree inherits the main repo's settings.
    if (backendType === "claude" || backendType === "claude-sdk") {
      try {
        await this.symlinkProjectSettings(worktreePath, repoRoot);
        console.log(
          `[cli-launcher] Worktree setup complete for branch ${branch} (settings symlinked, guardrails via system prompt)`,
        );
      } catch (e) {
        console.warn(`[cli-launcher] Failed to symlink project settings for worktree:`, e);
      }
    }
    // Codex: no file setup needed — instructions go via developer_instructions in turn/start
  }

  /**
   * Return orchestrator identity and instructions for system prompt injection.
   * Previously wrote to .claude/CLAUDE.md; now returned as a string and
   * injected via system prompt (--append-system-prompt / developer_instructions).
   */
  getOrchestratorGuardrails(port: number, backend: BackendType = "claude"): string {
    return backend === "codex"
      ? renderOrchestratorGuardrails(port, getCodexOrchestratorGuardrailCopy())
      : renderOrchestratorGuardrails(port, getClaudeOrchestratorGuardrailCopy());
  }

  /**
   * Add an entry to the worktree-local .git/info/exclude file.
   * This is a local-only gitignore that doesn't modify the repo's .gitignore.
   */
  private async addWorktreeGitExclude(worktreePath: string, pattern: string): Promise<void> {
    try {
      const dotGitPath = join(worktreePath, ".git");
      let gitDir: string;

      if (await fileExists(dotGitPath)) {
        const stat = (await readFile(dotGitPath, "utf-8")).trim();
        // Worktrees have a .git file with "gitdir: <path>"
        if (stat.startsWith("gitdir: ")) {
          gitDir = stat.slice("gitdir: ".length);
        } else {
          return; // unexpected format
        }
      } else {
        return; // no .git entry
      }

      const excludeDir = join(gitDir, "info");
      const excludePath = join(excludeDir, "exclude");

      await mkdir(excludeDir, { recursive: true });

      if (await fileExists(excludePath)) {
        const existing = await readFile(excludePath, "utf-8");
        if (existing.includes(pattern)) return; // already present
      }

      const existingContent = (await fileExists(excludePath)) ? await readFile(excludePath, "utf-8") : "";
      await writeFile(excludePath, existingContent + `\n${pattern}\n`, "utf-8");
      console.log(`[cli-launcher] Added "${pattern}" to worktree git exclude`);
    } catch (e) {
      console.warn(`[cli-launcher] Failed to add git exclude entry:`, e);
    }
  }

  /**
   * Symlink .claude/settings.json and .claude/settings.local.json in a worktree
   * to the main repo's copies. This ensures all worktrees for the same repo share
   * the same project-level permission rules.
   *
   * On every launch:
   * - If the worktree file doesn't exist → create symlink to main repo file
   * - If the worktree file is already a symlink → leave it (previous run)
   * - If the worktree file is a real file → merge its contents into the main
   *   repo file, replace with symlink. This handles the case where Claude Code's
   *   atomic write (write-to-temp-then-rename) broke a previous symlink.
   */
  private async symlinkProjectSettings(worktreePath: string, repoRoot: string): Promise<void> {
    if (!repoRoot) return;

    const SETTINGS_FILES = ["settings.json", "settings.local.json"];
    const worktreeClaudeDir = join(worktreePath, ".claude");
    const repoClaudeDir = join(repoRoot, ".claude");

    // Ensure the main repo's .claude/ directory exists so the CLI can create
    // the settings file at the symlink target.
    try {
      await mkdir(repoClaudeDir, { recursive: true });
    } catch {
      return; // can't create target directory — skip
    }

    for (const filename of SETTINGS_FILES) {
      const worktreeFile = join(worktreeClaudeDir, filename);
      const repoFile = join(repoClaudeDir, filename);

      try {
        // Seed the target file if it doesn't exist, so the symlink is never
        // dangling. A dangling symlink gets replaced by a real file when the
        // CLI does an atomic write (write-temp-then-rename).
        if (!(await fileExists(repoFile))) {
          await writeFile(repoFile, "{}\n", "utf-8");
          console.log(`[cli-launcher] Seeded ${repoFile} for symlink target`);
        }

        // Use lstat (doesn't follow symlinks) to detect dangling symlinks
        // and real files that replaced a previous symlink.
        let worktreeFileStat: import("node:fs").Stats | null = null;
        try {
          worktreeFileStat = await lstat(worktreeFile);
        } catch {
          // file doesn't exist — create symlink below
        }

        if (worktreeFileStat) {
          if (worktreeFileStat.isSymbolicLink()) {
            continue; // already a symlink (from previous run) — leave it
          }

          // Real file exists — Claude Code's atomic write broke a previous
          // symlink. Merge its contents into the main repo file, then replace.
          await this.mergeSettingsIntoRepo(worktreeFile, repoFile);
          await unlink(worktreeFile);
          console.log(`[cli-launcher] Merged and removed real ${worktreeFile} (was broken symlink)`);
        }

        await symlink(repoFile, worktreeFile);
        console.log(`[cli-launcher] Symlinked ${worktreeFile} → ${repoFile}`);

        // Add to git exclude so symlink doesn't show as untracked
        await this.addWorktreeGitExclude(worktreePath, `.claude/${filename}`);
      } catch (e) {
        console.warn(`[cli-launcher] Failed to symlink .claude/${filename}:`, e);
      }
    }
  }

  /**
   * Merge permission rules from a worktree's settings file into the main
   * repo's settings file. Deduplicates rules so merging is idempotent.
   */
  private async mergeSettingsIntoRepo(worktreeFile: string, repoFile: string): Promise<void> {
    try {
      const wtRaw = await readFile(worktreeFile, "utf-8");
      const wtData = JSON.parse(wtRaw) as Record<string, unknown>;

      let repoData: Record<string, unknown> = {};
      try {
        const repoRaw = await readFile(repoFile, "utf-8");
        repoData = JSON.parse(repoRaw) as Record<string, unknown>;
      } catch {
        /* empty or corrupt — start fresh */
      }

      // Merge permissions.allow and permissions.deny arrays
      const wtPerms = (wtData.permissions ?? {}) as Record<string, unknown>;
      const repoPerms = (repoData.permissions ?? {}) as Record<string, unknown>;

      for (const key of ["allow", "deny"] as const) {
        const wtRules = Array.isArray(wtPerms[key]) ? (wtPerms[key] as string[]) : [];
        const repoRules = Array.isArray(repoPerms[key]) ? (repoPerms[key] as string[]) : [];
        const merged = [...new Set([...repoRules, ...wtRules])];
        if (merged.length > 0) {
          repoPerms[key] = merged;
        }
      }

      if (Object.keys(repoPerms).length > 0) {
        repoData.permissions = repoPerms;
      }

      await writeFile(repoFile, JSON.stringify(repoData, null, 2) + "\n", "utf-8");
    } catch (e) {
      console.warn(`[cli-launcher] Failed to merge settings into repo:`, e);
    }
  }

  /**
   * Mark a session as connected (called when CLI establishes WS connection).
   */
  markConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && (session.state === "starting" || session.state === "connected")) {
      session.state = "connected";
      console.log(`[cli-launcher] Session ${sessionTag(sessionId)} connected via WebSocket`);
      this.persistState();
    }
  }

  /**
   * Store the CLI's internal session ID (from system.init message).
   * This is needed for --resume on relaunch.
   */
  setCLISessionId(sessionId: string, cliSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cliSessionId = cliSessionId;
      this.persistState();
    }
  }

  /**
   * Kill a session's CLI process.
   * For subprocess-based sessions (claude, codex): sends SIGTERM/SIGKILL.
   * For SDK sessions: marks the session as exited so the bridge will
   * disconnect the adapter on its next check. Returns true if the session
   * was found and marked for termination.
   */
  async kill(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill("SIGTERM");

      // Wait up to 5s for graceful exit, then force kill
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);

      if (!exited) {
        console.log(`[cli-launcher] Force-killing session ${sessionTag(sessionId)}`);
        proc.kill("SIGKILL");
      }

      this.processes.delete(sessionId);
    }

    // Mark session as exited regardless of whether a subprocess existed.
    // SDK sessions don't have a subprocess — they use an in-process adapter
    // that the bridge will disconnect when it sees state === "exited".
    session.state = "exited";
    session.exitCode = -1;
    this.persistState();
    return true;
  }

  /**
   * Upgrade a WebSocket ("claude") session to SDK ("claude-sdk") transport.
   *
   * This kills the CLI WebSocket process, changes the backendType to "claude-sdk",
   * and relaunches using the Agent SDK with the same cliSessionId. The SDK calls
   * unstable_v2_resumeSession() to resume the conversation, preserving full
   * history and context from the original WebSocket session.
   *
   * Returns { ok, sessionId, cliSessionId, previousBackend } on success.
   */
  async upgradeToSdk(
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string; sessionId?: string; cliSessionId?: string; previousBackend?: string }> {
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };
    if (info.backendType === "claude-sdk") return { ok: false, error: "Session is already using SDK transport" };
    if (info.backendType === "codex") return { ok: false, error: "Cannot upgrade Codex sessions to SDK" };
    if (!info.cliSessionId) return { ok: false, error: "Session has no cliSessionId — cannot resume via SDK" };

    const previousBackend = info.backendType || "claude";
    const cliSessionId = info.cliSessionId;
    console.log(
      `[cli-launcher] Upgrading session ${sessionTag(sessionId)} from ${previousBackend} to claude-sdk (cliSessionId: ${cliSessionId})`,
    );

    // Kill the WebSocket CLI process if running
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill("SIGTERM");
      await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]).then((exited) => {
        if (!exited) proc.kill("SIGKILL");
      });
      this.processes.delete(sessionId);
    }

    // Switch backend type and mark as exited so relaunch() will spawn fresh
    info.backendType = "claude-sdk";
    info.state = "exited";
    this.persistState();

    // Relaunch with new backend — relaunch() reads info.backendType and
    // routes to spawnClaudeSdk(), which passes info.cliSessionId to the
    // SDK adapter for resumption via unstable_v2_resumeSession().
    const result = await this.relaunch(sessionId);
    if (!result.ok) {
      // Revert on failure
      info.backendType = previousBackend as "claude";
      this.persistState();
      return { ok: false, error: result.error || "Relaunch failed after transport upgrade" };
    }

    return { ok: true, sessionId, cliSessionId, previousBackend };
  }

  /**
   * Downgrade an SDK ("claude-sdk") session to WebSocket ("claude") transport.
   *
   * Disconnects the SDK adapter, changes backendType to "claude", and relaunches
   * using the WebSocket CLI with --resume and the same cliSessionId. Symmetric
   * to upgradeToSdk().
   */
  async downgradeToWebSocket(
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string; sessionId?: string; cliSessionId?: string; previousBackend?: string }> {
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };
    if (info.backendType === "claude") return { ok: false, error: "Session is already using WebSocket transport" };
    if (info.backendType === "codex") return { ok: false, error: "Cannot downgrade Codex sessions to WebSocket" };
    if (!info.cliSessionId) return { ok: false, error: "Session has no cliSessionId — cannot resume via WebSocket" };

    const previousBackend = info.backendType;
    const cliSessionId = info.cliSessionId;
    console.log(
      `[cli-launcher] Downgrading session ${sessionTag(sessionId)} from ${previousBackend} to claude (cliSessionId: ${cliSessionId})`,
    );

    // Switch backend type and mark as exited so relaunch() will spawn WebSocket CLI.
    // The SDK adapter will be disconnected by the bridge when it detects the state change.
    info.backendType = "claude";
    info.state = "exited";
    this.persistState();

    // Relaunch with WebSocket backend — relaunch() reads info.backendType and
    // routes to spawnCLI(), which passes --resume with the cliSessionId.
    const result = await this.relaunch(sessionId);
    if (!result.ok) {
      // Revert on failure
      info.backendType = previousBackend as "claude-sdk";
      this.persistState();
      return { ok: false, error: result.error || "Relaunch failed after transport downgrade" };
    }

    return { ok: true, sessionId, cliSessionId, previousBackend };
  }
  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists and is alive (not exited).
   */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /**
   * Update the last activity timestamp for a session.
   */
  touchActivity(sessionId: string): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.lastActivityAt = Date.now();
      this.persistState();
    }
  }

  /**
   * Update worktree-related fields on a session (e.g. after recreating a
   * worktree for an unarchived session).
   */
  updateWorktree(sessionId: string, updates: { cwd: string; actualBranch: string }): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.cwd = updates.cwd;
      info.actualBranch = updates.actualBranch;
      this.persistState();
    }
  }

  /**
   * Set the archived flag on a session.
   */
  setArchived(sessionId: string, archived: boolean): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.archived = archived;
      info.archivedAt = archived ? Date.now() : undefined;
      // Clean up herd relationships when a leader is archived
      if (archived && info.isOrchestrator) {
        for (const worker of this.sessions.values()) {
          if (worker.herdedBy === sessionId) {
            worker.herdedBy = undefined;
          }
        }
        this.onHerdChanged?.(sessionId);
      }
      this.persistState();
    }
  }

  // ─── Cat herding (orchestrator→worker relationships) ─────────────────────

  /**
   * Herd worker sessions under an orchestrator. Each session can only have
   * one leader — if already herded by someone else, it's reported as a conflict.
   * Re-herding by the same orchestrator is idempotent.
   */
  herdSessions(
    orchId: string,
    workerIds: string[],
  ): { herded: string[]; notFound: string[]; conflicts: Array<{ id: string; herder: string }>; leaders: string[] } {
    const herded: string[] = [];
    const notFound: string[] = [];
    const conflicts: Array<{ id: string; herder: string }> = [];
    const leaders: string[] = [];
    for (const wid of workerIds) {
      const worker = this.sessions.get(wid);
      if (!worker) {
        notFound.push(wid);
        continue;
      }
      // Leaders/orchestrators cannot be herded — they are not workers
      if (worker.isOrchestrator) {
        leaders.push(wid);
        continue;
      }
      if (worker.herdedBy && worker.herdedBy !== orchId) {
        conflicts.push({ id: wid, herder: worker.herdedBy });
        continue;
      }
      worker.herdedBy = orchId;
      herded.push(wid);
    }
    if (herded.length > 0) {
      this.persistState();
      this.onHerdChanged?.(orchId);
    }
    return { herded, notFound, conflicts, leaders };
  }

  /**
   * Remove an orchestrator's herding claim from a worker session.
   * Returns true if the relationship existed and was removed.
   */
  unherdSession(orchId: string, workerId: string): boolean {
    const worker = this.sessions.get(workerId);
    if (!worker?.herdedBy || worker.herdedBy !== orchId) return false;
    worker.herdedBy = undefined;
    this.persistState();
    this.onHerdChanged?.(orchId);
    return true;
  }

  /**
   * Get all sessions herded by a specific orchestrator.
   */
  getHerdedSessions(orchId: string): SdkSessionInfo[] {
    const result: SdkSessionInfo[] = [];
    for (const s of this.sessions.values()) {
      if (s.herdedBy === orchId) result.push(s);
    }
    return result;
  }

  /**
   * Remove a session from the internal map (after kill or cleanup).
   */
  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
    this.sessionEnvs.delete(sessionId);
    this.persistState();
  }

  /**
   * Write a session-auth file to ~/.companion/session-auth/.
   * Keyed by cwd hash + server id so multiple Companion instances sharing
   * the same repo/worktree do not overwrite each other's auth context.
   */
  private async writeSessionAuthFile(cwd: string, sessionId: string, authToken: string, port: number): Promise<void> {
    const authFilePath = getSessionAuthPath(cwd, this.serverId);
    try {
      await mkdir(getSessionAuthDir(), { recursive: true });
      const data = JSON.stringify({ sessionId, authToken, port, serverId: this.serverId }, null, 2);
      await writeFile(authFilePath, data, { mode: 0o600 });
    } catch (err) {
      console.warn(`[cli-launcher] Failed to write session-auth file to ${authFilePath}:`, err);
    }
  }

  /**
   * Remove exited sessions from the list.
   */
  pruneExited(): number {
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === "exited") {
        this.sessions.delete(id);
        this.sessionEnvs.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Kill all sessions.
   */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const log = label === "stdout" ? console.log : console.error;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.trim()) {
          log(`[session:${sessionId}:${label}] ${text.trimEnd()}`);
        }
      }
    } catch {
      // stream closed
    }
  }

  private pipeOutput(sessionId: string, proc: Subprocess): void {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (stdout && typeof stdout !== "number") {
      this.pipeStream(sessionId, stdout, "stdout");
    }
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }
  }
}
