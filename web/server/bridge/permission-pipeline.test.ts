/**
 * Tests for the permission pipeline's takode event emission behavior (q-205).
 *
 * Validates that emitTakodePermissionRequest is called for ALL pipeline outcomes
 * that create a pending permission (both queued_for_llm_auto_approval and
 * pending_human), ensuring herded workers' permissions are always visible
 * to the leader session.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handlePermissionRequest,
  type PermissionPipelineSession,
  type PermissionPipelineDeps,
} from "./permission-pipeline.js";
import type { AutoApprovalConfig } from "../auto-approval-store.js";

// Mock the async dependencies so we can control the pipeline
vi.mock("../auto-approver.js", () => ({
  shouldAttemptAutoApproval: vi.fn(),
}));

vi.mock("./settings-rule-matcher.js", () => ({
  shouldSettingsRuleApprove: vi.fn(),
}));

import { shouldAttemptAutoApproval } from "../auto-approver.js";
import { shouldSettingsRuleApprove } from "./settings-rule-matcher.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_AUTO_APPROVAL_CONFIG: AutoApprovalConfig = {
  enabled: true,
  criteria: "approve safe operations",
  projectPath: "/tmp/test",
  label: "test",
  slug: "test-slug",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function makeSession(overrides: Partial<PermissionPipelineSession> = {}): PermissionPipelineSession {
  return {
    id: "session-1",
    backendType: "claude",
    state: { permissionMode: "default", cwd: "/tmp/test" },
    pendingPermissions: new Map(),
    ...overrides,
  };
}

function makeDeps(): PermissionPipelineDeps<PermissionPipelineSession> {
  return {
    onSessionActivityStateChanged: vi.fn(),
    broadcastPermissionRequest: vi.fn(),
    persistSession: vi.fn(),
    setAttentionAction: vi.fn(),
    emitTakodePermissionRequest: vi.fn(),
    schedulePermissionNotification: vi.fn(),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("permission pipeline takode event emission (q-205)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: settings rules don't match, auto-approval not configured
    vi.mocked(shouldSettingsRuleApprove).mockResolvedValue(null);
    vi.mocked(shouldAttemptAutoApproval).mockResolvedValue(null);
  });

  it("emits takode permission_request when permission is pending_human (no auto-approval)", async () => {
    // When LLM auto-approval is not available, the pipeline should emit the
    // takode event so the herd leader has visibility.
    const session = makeSession();
    const deps = makeDeps();

    const result = await handlePermissionRequest(
      session,
      {
        request_id: "req-1",
        tool_name: "Bash",
        input: { command: "echo test" },
        tool_use_id: "tu-1",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result.kind).toBe("pending_human");
    expect(deps.emitTakodePermissionRequest).toHaveBeenCalledTimes(1);
    expect(deps.emitTakodePermissionRequest).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        request_id: "req-1",
        tool_name: "Bash",
      }),
    );
  });

  it("emits takode permission_request when permission is queued for LLM auto-approval (SDK sessions)", async () => {
    // Regression test (q-205): previously, queued_for_llm_auto_approval did NOT
    // emit the takode event, leaving the herd leader blind to permissions being
    // evaluated by the LLM auto-approver.
    // Note: LLM auto-approval requires isClaudeFamily(backend), which is true for
    // "claude-sdk" but NOT for "claude-ws". SDK sessions also go through the
    // settings rule tier first, so we mock that to return no match.
    vi.mocked(shouldAttemptAutoApproval).mockResolvedValue(MOCK_AUTO_APPROVAL_CONFIG);

    const session = makeSession({ backendType: "claude-sdk" });
    const deps = makeDeps();

    const result = await handlePermissionRequest(
      session,
      {
        request_id: "req-2",
        tool_name: "Edit",
        input: { file_path: "/tmp/test/foo.ts", old_string: "a", new_string: "b" },
        tool_use_id: "tu-2",
      },
      "claude-sdk",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result.kind).toBe("queued_for_llm_auto_approval");
    // Key assertion: emitTakodePermissionRequest MUST be called even for
    // queued_for_llm_auto_approval so the herd leader has visibility
    expect(deps.emitTakodePermissionRequest).toHaveBeenCalledTimes(1);
    expect(deps.emitTakodePermissionRequest).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        request_id: "req-2",
        tool_name: "Edit",
      }),
    );
  });

  it("does NOT emit takode permission_request for mode_auto_approved (bypassPermissions)", () => {
    // Mode auto-approved permissions are resolved instantly and never need
    // leader attention -- no takode event should be emitted.
    const session = makeSession({
      state: { permissionMode: "bypassPermissions", cwd: "/tmp/test" },
    });
    const deps = makeDeps();

    const result = handlePermissionRequest(
      session,
      {
        request_id: "req-3",
        tool_name: "Bash",
        input: { command: "echo test" },
        tool_use_id: "tu-3",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    // mode_auto_approved returns synchronously (not a Promise)
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { kind: string }).kind).toBe("mode_auto_approved");
    expect(deps.emitTakodePermissionRequest).not.toHaveBeenCalled();
  });

  it("auto-approves sensitive ordinary tools in bypassPermissions mode", () => {
    // Regression coverage for q-626: no-ask Claude WebSocket sessions should
    // not turn sensitive file protection into a manual gate for ordinary tools.
    const session = makeSession({
      state: { permissionMode: "bypassPermissions", cwd: "/tmp/test" },
    });
    const deps = makeDeps();

    const result = handlePermissionRequest(
      session,
      {
        request_id: "req-sensitive-bypass",
        tool_name: "Write",
        input: { file_path: "/tmp/test/CLAUDE.md", content: "updated instructions" },
        tool_use_id: "tu-sensitive-bypass",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { kind: string }).kind).toBe("mode_auto_approved");
    expect(session.pendingPermissions.size).toBe(0);
    expect(deps.broadcastPermissionRequest).not.toHaveBeenCalled();
    expect(deps.emitTakodePermissionRequest).not.toHaveBeenCalled();
  });

  it("auto-approves sensitive file edits covered by acceptEdits mode", () => {
    // acceptEdits is still a mode-level auto-approval path for file edits. If a
    // sensitive edit reaches the pipeline, it should match that mode instead of
    // falling through to the sensitive manual deferral path.
    const session = makeSession({
      state: { permissionMode: "acceptEdits", cwd: "/tmp/test" },
    });
    const deps = makeDeps();

    const result = handlePermissionRequest(
      session,
      {
        request_id: "req-sensitive-accept-edits",
        tool_name: "Edit",
        input: { file_path: "/tmp/test/CLAUDE.md", old_string: "old", new_string: "new" },
        tool_use_id: "tu-sensitive-accept-edits",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { kind: string }).kind).toBe("mode_auto_approved");
    expect(session.pendingPermissions.size).toBe(0);
    expect(deps.broadcastPermissionRequest).not.toHaveBeenCalled();
  });

  it("keeps sensitive ordinary tools pending for manual approval outside auto-approve modes", async () => {
    // Sensitive protection still matters in manual sessions: edits to approval
    // rules/instructions should be visible to a human instead of LLM-approved.
    const session = makeSession({
      state: { permissionMode: "default", cwd: "/tmp/test" },
    });
    const deps = makeDeps();

    const result = await handlePermissionRequest(
      session,
      {
        request_id: "req-sensitive-manual",
        tool_name: "Write",
        input: { file_path: "/tmp/test/CLAUDE.md", content: "updated instructions" },
        tool_use_id: "tu-sensitive-manual",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result.kind).toBe("pending_human");
    expect(result.request.deferralReason).toBe("Sensitive file — requires manual approval");
    expect(session.pendingPermissions.has("req-sensitive-manual")).toBe(true);
    expect(deps.broadcastPermissionRequest).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        request_id: "req-sensitive-manual",
        deferralReason: "Sensitive file — requires manual approval",
      }),
    );
  });

  it("keeps interactive tools answerable in bypassPermissions mode", () => {
    // AskUserQuestion and ExitPlanMode are control-flow interactions, not
    // ordinary tool permissions, so no-ask mode must still surface them.
    const session = makeSession({
      state: { permissionMode: "bypassPermissions", cwd: "/tmp/test" },
    });
    const deps = makeDeps();

    const askResult = handlePermissionRequest(
      session,
      {
        request_id: "req-ask-interactive",
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Which approach?", options: ["A", "B"] }] },
        tool_use_id: "tu-ask-interactive",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    const planResult = handlePermissionRequest(
      session,
      {
        request_id: "req-plan-interactive",
        tool_name: "ExitPlanMode",
        input: { plan: "Proceed with implementation" },
        tool_use_id: "tu-plan-interactive",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    expect(askResult).not.toBeInstanceOf(Promise);
    expect(planResult).not.toBeInstanceOf(Promise);
    expect((askResult as { kind: string }).kind).toBe("pending_human");
    expect((planResult as { kind: string }).kind).toBe("pending_human");
    expect(session.pendingPermissions.has("req-ask-interactive")).toBe(true);
    expect(session.pendingPermissions.has("req-plan-interactive")).toBe(true);
    expect(deps.broadcastPermissionRequest).toHaveBeenCalledTimes(2);
  });

  it("schedules notification only for pending_human, not for queued_for_llm", async () => {
    // Notifications should only fire when a human needs to act. When the LLM
    // is evaluating, the notification is premature.
    vi.mocked(shouldAttemptAutoApproval).mockResolvedValue(MOCK_AUTO_APPROVAL_CONFIG);

    const session = makeSession({ backendType: "claude-sdk" });
    const deps = makeDeps();

    const result = await handlePermissionRequest(
      session,
      {
        request_id: "req-4",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "tu-4",
      },
      "claude-sdk",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result.kind).toBe("queued_for_llm_auto_approval");
    // schedulePermissionNotification should NOT be called for LLM-queued permissions
    expect(deps.schedulePermissionNotification).not.toHaveBeenCalled();
    // But emitTakodePermissionRequest MUST still be called (q-205 fix)
    expect(deps.emitTakodePermissionRequest).toHaveBeenCalledTimes(1);
  });

  it("does NOT emit takode permission_request for settings_rule_approved", async () => {
    // Settings-rule-approved permissions are resolved instantly (like mode
    // auto-approve) and never need leader attention. The pipeline should
    // return settings_rule_approved without emitting a takode event.
    vi.mocked(shouldSettingsRuleApprove).mockResolvedValue("Bash(mkdir *)");

    const session = makeSession({ backendType: "claude-sdk" });
    const deps = makeDeps();

    const result = await handlePermissionRequest(
      session,
      {
        request_id: "req-5",
        tool_name: "Bash",
        input: { command: "mkdir -p /tmp/test-dir" },
        tool_use_id: "tu-5",
      },
      "claude-sdk",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result.kind).toBe("settings_rule_approved");
    expect(deps.emitTakodePermissionRequest).not.toHaveBeenCalled();
  });

  it("hard-denies file mutation tools in read-only Slack thread sessions before mode auto-approval", () => {
    // Thread turns have no Allow path. Even bypassPermissions must not permit
    // file mutation from a hidden child backend session.
    const session = makeSession({
      state: {
        permissionMode: "bypassPermissions",
        cwd: "/tmp/test",
        slackThreadChild: { readOnly: true },
      },
    });
    const deps = makeDeps();

    const result = handlePermissionRequest(
      session,
      {
        request_id: "req-thread-edit",
        tool_name: "Write",
        input: { file_path: "/tmp/test/file.ts", content: "mutate" },
        tool_use_id: "tu-thread-edit",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { kind: string }).kind).toBe("hard_denied");
    expect(session.pendingPermissions.size).toBe(0);
    expect(deps.broadcastPermissionRequest).not.toHaveBeenCalled();
    expect(deps.emitTakodePermissionRequest).not.toHaveBeenCalled();
  });

  it("hard-denies obvious shell writes in read-only Slack thread sessions", () => {
    // Shell commands are conservatively screened in thread turns so redirects
    // and common write/install commands cannot reach human approval.
    const session = makeSession({
      state: {
        permissionMode: "default",
        cwd: "/tmp/test",
        slackThreadChild: { readOnly: true },
      },
    });
    const deps = makeDeps();

    const result = handlePermissionRequest(
      session,
      {
        request_id: "req-thread-bash",
        tool_name: "Bash",
        input: { command: "echo changed > src/file.ts" },
        tool_use_id: "tu-thread-bash",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { kind: string }).kind).toBe("hard_denied");
    expect(session.pendingPermissions.size).toBe(0);
  });

  it("hard-denies long sleep Bash commands before any auto-approval path", () => {
    const session = makeSession({
      state: { permissionMode: "bypassPermissions", cwd: "/tmp/test" },
    });
    const deps = makeDeps();

    const result = handlePermissionRequest(
      session,
      {
        request_id: "req-sleep-deny",
        tool_name: "Bash",
        input: { command: "echo hi && sleep 61" },
        tool_use_id: "tu-sleep-deny",
      },
      "claude-sdk",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { kind: string }).kind).toBe("hard_denied");
    expect(session.pendingPermissions.size).toBe(0);
    expect(deps.emitTakodePermissionRequest).not.toHaveBeenCalled();
  });

  it("hard-denies backgrounded long sleep Bash commands", () => {
    const session = makeSession({
      state: { permissionMode: "bypassPermissions", cwd: "/tmp/test" },
    });
    const deps = makeDeps();

    const result = handlePermissionRequest(
      session,
      {
        request_id: "req-sleep-background",
        tool_name: "Bash",
        input: { command: "env FOO=bar sleep 61 &" },
        tool_use_id: "tu-sleep-background",
      },
      "claude-sdk",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { kind: string }).kind).toBe("hard_denied");
    expect(session.pendingPermissions.size).toBe(0);
  });

  it("hard-denies wrapper-option long sleep Bash commands", () => {
    const session = makeSession({
      state: { permissionMode: "bypassPermissions", cwd: "/tmp/test" },
    });
    const deps = makeDeps();

    const result = handlePermissionRequest(
      session,
      {
        request_id: "req-sleep-wrapper",
        tool_name: "Bash",
        input: { command: "env -i sleep 61" },
        tool_use_id: "tu-sleep-wrapper",
      },
      "claude-sdk",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { kind: string }).kind).toBe("hard_denied");
    expect(session.pendingPermissions.size).toBe(0);
  });

  it("allows sleep 60 and shorter to continue through the normal pipeline", async () => {
    const session = makeSession();
    const deps = makeDeps();

    const result = await handlePermissionRequest(
      session,
      {
        request_id: "req-sleep-allow",
        tool_name: "Bash",
        input: { command: "sleep 60" },
        tool_use_id: "tu-sleep-allow",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result.kind).toBe("pending_human");
    expect(session.pendingPermissions.has("req-sleep-allow")).toBe(true);
  });

  it("allows short sleep commands with file-descriptor redirections", async () => {
    const session = makeSession();
    const deps = makeDeps();

    const result = await handlePermissionRequest(
      session,
      {
        request_id: "req-sleep-redirect",
        tool_name: "Bash",
        input: { command: "sleep 60 2>&1" },
        tool_use_id: "tu-sleep-redirect",
      },
      "claude-ws",
      deps,
      { activityReason: "permission_request" },
    );

    expect(result.kind).toBe("pending_human");
    expect(session.pendingPermissions.has("req-sleep-redirect")).toBe(true);
  });
});
