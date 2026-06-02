import { basename } from "node:path";
import { homedir } from "node:os";
import { shouldAttemptAutoApproval } from "../auto-approver.js";
import type { AutoApprovalConfig } from "../auto-approval-store.js";
import type { BackendType, PermissionRequest, PermissionUpdate } from "../session-types.js";
import { isClaudeFamily } from "../session-types.js";
import { detectLongSleepBashCommand, LONG_SLEEP_DENY_MESSAGE, LONG_SLEEP_REMINDER_TEXT } from "./bash-sleep-policy.js";
import { shouldSettingsRuleApprove } from "./settings-rule-matcher.js";

export type PermissionRequestBackend = "claude-ws" | "claude-sdk" | "codex";

export interface IncomingPermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: PermissionUpdate[];
  description?: string;
  tool_use_id: string;
  agent_id?: string;
}

export interface PermissionPipelineSession {
  id: string;
  backendType: BackendType;
  state: {
    permissionMode?: string;
    cwd?: string;
    repo_root?: string;
    slackThreadChild?: { readOnly?: boolean } | null;
  };
  pendingPermissions: Map<string, PermissionRequest>;
}

export interface PermissionPipelineDeps<S extends PermissionPipelineSession> {
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  broadcastPermissionRequest: (session: S, request: PermissionRequest) => void;
  persistSession: (session: S) => void;
  setAttentionAction: (session: S) => void;
  emitTakodePermissionRequest: (session: S, request: PermissionRequest) => void;
  schedulePermissionNotification?: (session: S, request: PermissionRequest) => void;
}

export interface HandlePermissionRequestOptions {
  activityReason: string;
  enableModeAutoApprove?: boolean;
  enableLlmAutoApproval?: boolean;
  enableSettingsRuleApprove?: boolean;
}

export type PermissionPipelineResult =
  | {
      kind: "mode_auto_approved";
      request: PermissionRequest;
    }
  | {
      kind: "settings_rule_approved";
      request: PermissionRequest;
      matchedRule: string;
    }
  | {
      kind: "queued_for_llm_auto_approval";
      request: PermissionRequest;
      autoApprovalConfig: AutoApprovalConfig;
    }
  | {
      kind: "hard_denied";
      request: PermissionRequest;
      message: string;
      reminder: string;
    }
  | {
      kind: "pending_human";
      request: PermissionRequest;
    };

/** Tools that require user interaction and can never be auto-approved. */
export const NEVER_AUTO_APPROVE: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** Tools auto-approved in acceptEdits mode. */
export const ACCEPT_EDITS_AUTO_APPROVE: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "Read",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "Skill",
]);

const THREAD_READ_ONLY_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "TodoWrite",
  "apply_patch",
  "functions.apply_patch",
]);

const THREAD_READ_ONLY_BASH_WRITE_RE =
  /(?:^|[;&|]\s*)(?:(?:echo|printf|cat)\b[^;&|]*>\s*|tee\b|sed\s+-i\b|perl\s+-pi\b|touch\b|rm\b|mv\b|cp\b|mkdir\b|rmdir\b|chmod\b|chown\b|ln\b|truncate\b|dd\b|install\b|bun\s+(?:add|install|update|remove)\b|npm\s+(?:install|i|update|uninstall|remove|ci)\b|pnpm\s+(?:install|add|update|remove)\b|yarn\s+(?:install|add|remove|upgrade)\b|git\s+(?:checkout|switch|reset|clean|commit|merge|rebase|pull|push|add|restore)\b)/i;

export function isSensitiveConfigPath(filePath: string): boolean {
  if (!filePath) return false;
  const name = basename(filePath);
  if (name === "CLAUDE.md") return true;
  if (name === ".mcp.json" || name === ".claude.json") return true;
  if (filePath.includes("/.claude/")) {
    if (name === "settings.json" || name === "settings.local.json" || name === ".credentials.json") return true;
    if (/\/\.claude\/(commands|agents|skills|hooks)\//.test(filePath)) return true;
  }
  const home = homedir();
  if (
    filePath.startsWith(`${home}/.companion/settings.json`) ||
    filePath.startsWith(`${home}/.companion/envs/`) ||
    filePath.startsWith(`${home}/.companion/auto-approval/`)
  ) {
    return true;
  }
  if (filePath.startsWith(`${home}/.companion/`) && /settings(-\d+)?\.json$/.test(filePath)) {
    return true;
  }
  if (filePath === `${home}/.claude.json`) return true;
  return false;
}

export function isSensitiveBashCommand(command: string): boolean {
  if (!command) return false;
  const sensitive = [
    "CLAUDE.md",
    ".claude/settings",
    ".claude/hooks/",
    ".claude/commands/",
    ".claude/agents/",
    ".claude/skills/",
    ".mcp.json",
    ".claude.json",
    ".companion/settings",
    ".companion/auto-approval/",
    ".companion/envs/",
  ];
  return sensitive.some((p) => command.includes(p));
}

function shouldModeAutoApprove(permissionMode: string | undefined, toolName: string): boolean {
  return (
    !NEVER_AUTO_APPROVE.has(toolName) &&
    (permissionMode === "bypassPermissions" ||
      (permissionMode === "acceptEdits" && toolName !== "Bash" && ACCEPT_EDITS_AUTO_APPROVE.has(toolName)))
  );
}

function isLlmAutoApprovalEligible<S extends PermissionPipelineSession>(
  session: S,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const isFileEdit =
    toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit" || toolName === "NotebookEdit";
  const filePath = isFileEdit ? String(input.file_path ?? "") : "";
  const bashCommand = toolName === "Bash" ? String(input.command ?? "") : "";

  return (
    isClaudeFamily(session.backendType) &&
    !NEVER_AUTO_APPROVE.has(toolName) &&
    !(isFileEdit && isSensitiveConfigPath(filePath)) &&
    !(toolName === "Bash" && isSensitiveBashCommand(bashCommand))
  );
}

function toPermissionRequest(request: IncomingPermissionRequest): PermissionRequest {
  return {
    request_id: request.request_id,
    tool_name: request.tool_name,
    input: request.input,
    permission_suggestions: request.permission_suggestions,
    description: request.description,
    tool_use_id: request.tool_use_id,
    agent_id: request.agent_id,
    timestamp: Date.now(),
  };
}

function getHardDeniedPermission<S extends PermissionPipelineSession>(
  session: S,
  perm: PermissionRequest,
): Extract<PermissionPipelineResult, { kind: "hard_denied" }> | null {
  if (session.state.slackThreadChild?.readOnly) {
    if (THREAD_READ_ONLY_MUTATING_TOOLS.has(perm.tool_name)) {
      return {
        kind: "hard_denied",
        request: perm,
        message:
          "Thread turns are read-only. Continue in the root conversation or a normal quest workflow to edit files.",
        reminder: "This Slack-like thread is read-only for repository and file state.",
      };
    }
    if (perm.tool_name === "Bash") {
      const command = String(perm.input.command ?? "");
      if (!command.trim() || THREAD_READ_ONLY_BASH_WRITE_RE.test(command)) {
        return {
          kind: "hard_denied",
          request: perm,
          message:
            "Thread turns are read-only. This shell command may mutate repository or file state, so it cannot be allowed here.",
          reminder: "Use read-only shell commands in this thread, or move edit work to the root conversation.",
        };
      }
    }
  }
  if (perm.tool_name !== "Bash") return null;
  const command = String(perm.input.command ?? "");
  if (!detectLongSleepBashCommand(command)) return null;
  return {
    kind: "hard_denied",
    request: perm,
    message: LONG_SLEEP_DENY_MESSAGE,
    reminder: LONG_SLEEP_REMINDER_TEXT,
  };
}

export function handlePermissionRequest<S extends PermissionPipelineSession>(
  session: S,
  request: IncomingPermissionRequest,
  _backend: PermissionRequestBackend,
  deps: PermissionPipelineDeps<S>,
  options: HandlePermissionRequestOptions,
): PermissionPipelineResult | Promise<PermissionPipelineResult> {
  const perm = toPermissionRequest(request);
  const modeAutoApproveEnabled = options.enableModeAutoApprove !== false;
  const llmAutoApproveEnabled = options.enableLlmAutoApproval !== false;
  const toolName = perm.tool_name;
  const input = perm.input;

  const hardDenied = getHardDeniedPermission(session, perm);
  if (hardDenied) return hardDenied;

  const complete = (autoApprovalConfig: AutoApprovalConfig | null): PermissionPipelineResult => {
    if (autoApprovalConfig) {
      perm.evaluating = "queued";
    }

    session.pendingPermissions.set(perm.request_id, perm);
    deps.onSessionActivityStateChanged(session.id, options.activityReason);
    deps.broadcastPermissionRequest(session, perm);

    // Always emit takode permission_request — the herd leader needs visibility
    // into ALL pending permissions, including ones queued for LLM auto-approval.
    // Without this, the leader has a blind spot while the LLM evaluates: the
    // worker is blocked but the leader doesn't know about it (q-205).
    deps.emitTakodePermissionRequest(session, perm);

    if (autoApprovalConfig) {
      deps.persistSession(session);
      return {
        kind: "queued_for_llm_auto_approval",
        request: perm,
        autoApprovalConfig,
      };
    }

    deps.setAttentionAction(session);
    deps.persistSession(session);
    deps.schedulePermissionNotification?.(session, perm);
    return { kind: "pending_human", request: perm };
  };

  if (modeAutoApproveEnabled && shouldModeAutoApprove(session.state.permissionMode, toolName)) {
    return { kind: "mode_auto_approved", request: perm };
  }

  // Helper: set deferralReason when sensitive file/command blocks auto-approval
  const setSensitiveDeferralReason = (): void => {
    if (NEVER_AUTO_APPROVE.has(toolName)) return; // UI handles AskUserQuestion/ExitPlanMode specially
    const isFileEdit =
      toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit" || toolName === "NotebookEdit";
    const filePath = isFileEdit ? String(input.file_path ?? "") : "";
    const bashCommand = toolName === "Bash" ? String(input.command ?? "") : "";
    if (isFileEdit && isSensitiveConfigPath(filePath)) {
      perm.deferralReason = "Sensitive file — requires manual approval";
    } else if (toolName === "Bash" && isSensitiveBashCommand(bashCommand)) {
      perm.deferralReason = "Modifies sensitive config — requires manual approval";
    }
  };

  // Tier 2: Settings.json rule matching — fast static check against user allow rules.
  // Enabled for all backends. SDK sessions bypass the CLI's built-in rule engine
  // (--permission-prompt-tool stdio), Codex has no CLI-side engine, and WebSocket
  // sessions may forward requests the CLI couldn't approve (e.g. Bash commands
  // not matching the CLI's narrower rule set, or requests during plan mode).
  // Skip tools that can never be auto-approved (they'd just return null anyway).
  const settingsRuleEnabled = options.enableSettingsRuleApprove !== false && !NEVER_AUTO_APPROVE.has(toolName);
  if (settingsRuleEnabled) {
    return shouldSettingsRuleApprove(toolName, input, session.state.cwd).then((matchedRule) => {
      if (matchedRule) {
        return { kind: "settings_rule_approved" as const, request: perm, matchedRule };
      }
      // Fall through to LLM/human
      if (!llmAutoApproveEnabled || !isLlmAutoApprovalEligible(session, toolName, input)) {
        setSensitiveDeferralReason();
        return complete(null);
      }
      return shouldAttemptAutoApproval(
        session.state.cwd ?? "",
        session.state.repo_root ? [session.state.repo_root] : undefined,
      ).then((autoApprovalConfig) => complete(autoApprovalConfig));
    });
  }

  if (!llmAutoApproveEnabled || !isLlmAutoApprovalEligible(session, toolName, input)) {
    setSensitiveDeferralReason();
    return complete(null);
  }

  return shouldAttemptAutoApproval(
    session.state.cwd ?? "",
    session.state.repo_root ? [session.state.repo_root] : undefined,
  ).then((autoApprovalConfig) => complete(autoApprovalConfig));
}
