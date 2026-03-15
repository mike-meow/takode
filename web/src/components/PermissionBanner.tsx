import { useState, useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { sendToSession } from "../ws.js";
import type { PermissionRequest } from "../types.js";
import type { PermissionUpdate } from "../../server/session-types.js";
import { DiffViewer } from "./DiffViewer.js";
import { CatPawAvatar } from "./CatIcons.js";
import { CopyFormatButton } from "./CopyFormatButton.js";
import { parseEditToolInput, parseWriteToolInput } from "../utils/tool-rendering.js";

/** Human-readable label for a permission suggestion */
function suggestionLabel(s: PermissionUpdate): string {
  if (s.type === "setMode") return `Set mode to "${s.mode}"`;
  const dest = s.destination;
  const scope = dest === "session" ? "for session" : "always";
  if (s.type === "addRules" || s.type === "replaceRules") {
    const rule = s.rules[0];
    if (rule?.ruleContent) return `Allow "${rule.ruleContent}" ${scope}`;
    if (rule?.toolName) return `Allow ${rule.toolName} ${scope}`;
  }
  if (s.type === "addDirectories") {
    return `Trust ${s.directories[0] || "directory"} ${scope}`;
  }
  return `Allow ${scope}`;
}

/** Derive a sensible default pattern from the tool's input */
function deriveDefaultPattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") return typeof input.command === "string" ? input.command : "";
  if (["Edit", "Write", "Read", "MultiEdit", "NotebookEdit"].includes(toolName))
    return typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : "";
  if (toolName === "Glob") return typeof input.pattern === "string" ? input.pattern : "";
  if (toolName === "Grep") return typeof input.pattern === "string" ? input.pattern : "";
  if (toolName === "WebFetch") return typeof input.url === "string" ? input.url : "";
  return "";
}

/** Extract plan preview text from ExitPlanMode permission */
function getPlanPreview(permission: PermissionRequest): string {
  const planText = typeof permission.input?.plan === "string" ? permission.input.plan : "";
  return planText
    ? planText
        .split("\n")
        .find((l: string) => l.trim())
        ?.replace(/^#+\s*/, "")
        .trim() || "Plan approval"
    : "Plan approval requested";
}

// ── Minimize icon SVG (square with horizontal line — reused in plan + permissions headers) ──
function MinimizeIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
      <path d="M4 8h4" />
    </svg>
  );
}

// ── Plan icon SVG (reused in overlay + collapsed chip) ─────────────────────
function PlanIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={`${className} text-cc-primary`}
    >
      <rect x="3" y="2" width="10" height="12" rx="1" />
      <path d="M6 5h4M6 8h4M6 11h2" />
    </svg>
  );
}

// ── PlanReviewOverlay — full-window plan display ───────────────────────────
// Renders as a flex-1 child that fills the chat area when a plan is expanded.
// Buttons are pinned at the bottom (shrink-0) and never scroll off-screen.

export function PlanReviewOverlay({
  permission,
  sessionId,
  onCollapse,
}: {
  permission: PermissionRequest;
  sessionId: string;
  onCollapse: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [stamping, setStamping] = useState(false);
  const removePermission = useStore((s) => s.removePermission);

  const planText = typeof permission.input?.plan === "string" ? permission.input.plan : "";
  const allowedPrompts = Array.isArray(permission.input?.allowedPrompts)
    ? (permission.input.allowedPrompts as Record<string, unknown>[])
    : [];
  const suggestions = permission.permission_suggestions;
  const planContentRef = useRef<HTMLDivElement>(null);

  function handleAllow(updatedInput?: Record<string, unknown>, updatedPermissions?: PermissionUpdate[]) {
    setLoading(true);
    setStamping(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "allow",
      updated_input: updatedInput,
      ...(updatedPermissions?.length ? { updated_permissions: updatedPermissions } : {}),
    });
    // Safety net cleanup. removePermission is idempotent, so this is safe even
    // if the server broadcast already removed the permission.
    setTimeout(() => {
      removePermission(sessionId, permission.request_id);
    }, 3000);
  }

  function handleDeny() {
    setLoading(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "deny",
      message: "Denied by user",
    });
    // Also interrupt so CLI stops and waits for new input (vanilla behavior)
    sendToSession(sessionId, { type: "interrupt" });
    removePermission(sessionId, permission.request_id);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 border-t border-cc-border bg-cc-card animate-[fadeSlideIn_0.2s_ease-out]">
      {/* Header — entire bar is clickable to minimize */}
      <div
        onClick={onCollapse}
        className="shrink-0 px-4 py-2.5 border-b border-cc-border/50 flex items-center gap-2.5 cursor-pointer hover:bg-cc-hover/50 transition-colors"
        role="button"
        title="Minimize plan"
      >
        <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-cc-primary/10 border border-cc-primary/20">
          <PlanIcon className="w-4 h-4" />
        </div>
        <span className="text-xs font-semibold text-cc-primary">Plan</span>
        <span className="ml-auto p-1.5 rounded-md text-cc-muted">
          <MinimizeIcon className="w-3.5 h-3.5" />
        </span>
      </div>

      {/* Scrollable plan body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="max-w-3xl mx-auto">
          {planText ? (
            <div className="relative">
              <div className="absolute top-0 right-0 z-10">
                <CopyFormatButton
                  markdownText={planText}
                  getHtml={() => planContentRef.current?.innerHTML ?? ""}
                  title="Copy plan"
                />
              </div>
              <div ref={planContentRef} className="pr-7">
                <MarkdownContent text={planText} size="sm" />
              </div>
            </div>
          ) : (
            <div className="text-xs text-cc-muted">Plan approval requested</div>
          )}
          {allowedPrompts.length > 0 && (
            <div className="mt-4 space-y-1">
              <div className="text-[10px] text-cc-muted uppercase tracking-wider">Requested permissions</div>
              <div className="space-y-1">
                {allowedPrompts.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-[11px] font-mono-code bg-cc-code-bg/30 rounded-lg px-2.5 py-1.5"
                  >
                    <span className="text-cc-muted shrink-0">{String(p.tool || "")}</span>
                    <span className="text-cc-fg">{String(p.prompt || "")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sticky action bar — always visible at bottom */}
      <div className="shrink-0 border-t border-cc-border px-4 py-3 bg-cc-card">
        <div className="max-w-3xl mx-auto flex items-center gap-2 flex-wrap">
          <button
            onClick={() => handleAllow()}
            disabled={loading}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-cc-success/90 hover:bg-cc-success text-white disabled:opacity-50 transition-colors cursor-pointer ${stamping ? "animate-[paw-approve_400ms_ease-out_forwards]" : ""}`}
          >
            {stamping ? (
              <CatPawAvatar className="w-4 h-4" />
            ) : (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                <path d="M3 8.5l3.5 3.5 6.5-7" />
              </svg>
            )}
            {stamping ? "Approved" : "Allow"}
          </button>

          {!stamping &&
            suggestions?.map((suggestion, i) => (
              <button
                key={i}
                onClick={() => handleAllow(undefined, [suggestion])}
                disabled={loading}
                title={`${suggestion.type}: ${JSON.stringify(suggestion)}`}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-cc-primary/10 hover:bg-cc-primary/20 text-cc-primary border border-cc-primary/20 disabled:opacity-50 transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                  <path d="M3 8.5l3.5 3.5 6.5-7" />
                </svg>
                {suggestionLabel(suggestion)}
              </button>
            ))}

          {!stamping && (
            <button
              onClick={handleDeny}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border disabled:opacity-50 transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
              Deny
            </button>
          )}

          {!stamping && (
            <button
              onClick={onCollapse}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer ml-auto"
            >
              Minimize
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── PlanCollapsedChip — compact plan bar with inline Accept/Deny ───────────

export function PlanCollapsedChip({
  permission,
  sessionId,
  onExpand,
}: {
  permission: PermissionRequest;
  sessionId: string;
  onExpand: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [stamping, setStamping] = useState(false);
  const removePermission = useStore((s) => s.removePermission);
  const planPreview = getPlanPreview(permission);
  const suggestions = permission.permission_suggestions;

  function handleAllow(updatedPermissions?: PermissionUpdate[]) {
    setLoading(true);
    setStamping(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "allow",
      ...(updatedPermissions?.length ? { updated_permissions: updatedPermissions } : {}),
    });
    // Safety net: if the server already resolved this permission, clean up locally
    setTimeout(() => {
      const perms = useStore.getState().pendingPermissions.get(sessionId);
      if (perms?.has(permission.request_id)) {
        removePermission(sessionId, permission.request_id);
      }
    }, 3000);
  }

  function handleDeny() {
    setLoading(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "deny",
      message: "Denied by user",
    });
    sendToSession(sessionId, { type: "interrupt" });
    removePermission(sessionId, permission.request_id);
  }

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-3xl mx-auto flex items-center gap-2">
        {/* Clickable plan preview — expands the overlay */}
        <button
          onClick={onExpand}
          title="Expand plan"
          className="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2 rounded-lg border border-cc-primary/20 bg-cc-primary/5 hover:bg-cc-primary/10 transition-colors cursor-pointer text-left"
        >
          <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-cc-primary/10 border border-cc-primary/20">
            <PlanIcon />
          </div>
          <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary shrink-0">
            Plan
          </span>
          <span className="text-xs text-cc-fg truncate flex-1">{planPreview}</span>
          <svg
            className="w-3 h-3 text-cc-muted shrink-0"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 5l3 3 3-3" />
          </svg>
        </button>

        {/* Inline action buttons */}
        <div className="shrink-0 flex items-center gap-1.5">
          {!stamping &&
            suggestions?.map((suggestion, i) => (
              <button
                key={i}
                onClick={() => handleAllow([suggestion])}
                disabled={loading}
                title={suggestionLabel(suggestion)}
                className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-md bg-cc-primary/10 hover:bg-cc-primary/20 text-cc-primary border border-cc-primary/20 disabled:opacity-50 transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-2.5 h-2.5">
                  <path d="M3 8.5l3.5 3.5 6.5-7" />
                </svg>
                {suggestionLabel(suggestion)}
              </button>
            ))}
          <button
            onClick={() => handleAllow()}
            disabled={loading}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-cc-success/90 hover:bg-cc-success text-white disabled:opacity-50 transition-colors cursor-pointer ${stamping ? "animate-[paw-approve_400ms_ease-out_forwards]" : ""}`}
            title="Accept plan"
          >
            {stamping ? (
              <CatPawAvatar className="w-3.5 h-3.5" />
            ) : (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-2.5 h-2.5">
                <path d="M3 8.5l3.5 3.5 6.5-7" />
              </svg>
            )}
            {stamping ? "Approved" : "Allow"}
          </button>
          {!stamping && (
            <button
              onClick={handleDeny}
              disabled={loading}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border disabled:opacity-50 transition-colors cursor-pointer"
              title="Reject plan"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-2.5 h-2.5">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
              Deny
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── CustomRuleEditor — inline editor for creating custom permission rules ────

type ScopeOption = "session" | "projectSettings" | "userSettings";
const SCOPE_OPTIONS: { value: ScopeOption; label: string; desc: string }[] = [
  { value: "session", label: "Session", desc: "This session only" },
  { value: "projectSettings", label: "Project", desc: "All sessions in this project" },
  { value: "userSettings", label: "User", desc: "All projects" },
];

function CustomRuleEditor({
  toolName,
  input,
  suggestions,
  onApply,
  disabled,
}: {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  onApply: (update: PermissionUpdate) => void;
  disabled: boolean;
}) {
  // Prefer Claude's suggested rule pattern over the raw tool input
  const suggestion = suggestions?.find(
    (s): s is Extract<PermissionUpdate, { type: "addRules" }> =>
      (s.type === "addRules" || s.type === "replaceRules") && !!s.rules[0]?.ruleContent,
  );
  const [pattern, setPattern] = useState(
    () => suggestion?.rules[0]?.ruleContent || deriveDefaultPattern(toolName, input),
  );
  const [scope, setScope] = useState<ScopeOption>(() => (suggestion?.destination as ScopeOption) || "session");

  function handleSubmit() {
    const update: PermissionUpdate = {
      type: "addRules",
      rules: [
        {
          toolName,
          ...(pattern.trim() ? { ruleContent: pattern.trim() } : {}),
        },
      ],
      behavior: "allow",
      destination: scope,
    };
    onApply(update);
  }

  return (
    <div className="mt-2.5 p-3 rounded-lg border border-cc-border/50 bg-cc-code-bg/20 space-y-3 animate-[fadeSlideIn_0.2s_ease-out]">
      {/* Pattern input */}
      <div className="space-y-1">
        <label className="text-[10px] text-cc-muted uppercase tracking-wider font-medium">Pattern</label>
        <input
          type="text"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) handleSubmit();
          }}
          placeholder={`e.g. ${toolName === "Bash" ? "npm test*" : "**/*.ts"}`}
          className="w-full px-2.5 py-1.5 text-xs font-mono-code bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:border-cc-primary/50 transition-colors"
          disabled={disabled}
        />
        <p className="text-[10px] text-cc-muted">
          Leave empty to allow all <span className="font-mono-code">{toolName}</span> calls
        </p>
      </div>

      {/* Scope selector */}
      <div className="space-y-1">
        <span className="text-[10px] text-cc-muted uppercase tracking-wider font-medium">Scope</span>
        <div className="flex gap-0.5 p-0.5 bg-cc-hover/50 rounded-lg w-fit">
          {SCOPE_OPTIONS.map(({ value, label, desc }) => (
            <button
              key={value}
              onClick={() => setScope(value)}
              disabled={disabled}
              title={desc}
              className={`px-3 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
                scope === value
                  ? "bg-cc-card text-cc-fg shadow-sm border border-cc-border/50"
                  : "text-cc-muted hover:text-cc-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Apply button */}
      <button
        onClick={handleSubmit}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary/90 text-white disabled:opacity-50 transition-colors cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
          <path d="M3 8.5l3.5 3.5 6.5-7" />
        </svg>
        Allow with Rule
      </button>
    </div>
  );
}

// ── PermissionBanner — handles all non-ExitPlanMode permissions ─────────────
// ExitPlanMode is handled by PlanReviewOverlay/PlanCollapsedChip via ChatView.

// ── EvaluatingCollapsedChip — compact bar shown while LLM auto-approver is queued/evaluating ──

export function EvaluatingCollapsedChip({
  permission,
  sessionId,
  onExpand,
}: {
  permission: PermissionRequest;
  sessionId: string;
  onExpand: () => void;
}) {
  const toolName = permission.tool_name;
  const desc =
    permission.description ??
    (toolName === "Bash" && typeof permission.input?.command === "string"
      ? (permission.input.command as string)
      : toolName);
  const isQueued = permission.evaluating === "queued";

  return (
    <div className="px-2 sm:px-4 py-2 border-b border-cc-border animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={onExpand}
          title={
            isQueued
              ? "Queued for auto-approval — click to expand and approve manually"
              : "Evaluating for auto-approval — click to expand and approve manually"
          }
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-cc-muted/20 bg-cc-muted/5 hover:bg-cc-muted/10 transition-colors cursor-pointer text-left"
        >
          {/* Icon: clock for queued, spinner for evaluating */}
          <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-cc-muted/10 border border-cc-muted/20">
            {isQueued ? (
              // Clock icon (waiting in queue)
              <svg
                className="w-3.5 h-3.5 text-cc-muted"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="8" cy="8" r="6" />
                <path d="M8 5v3l2 1.5" />
              </svg>
            ) : (
              // Spinner icon (LLM call in progress)
              <svg className="w-3.5 h-3.5 text-cc-muted animate-spin" viewBox="0 0 16 16" fill="none">
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeDasharray="28"
                  strokeDashoffset="7"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </div>
          <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-muted/10 text-cc-muted shrink-0">
            {toolName}
          </span>
          <span className="text-[10px] text-cc-muted/60 shrink-0">{isQueued ? "queued" : "evaluating"}</span>
          <span className="text-xs text-cc-muted truncate flex-1 min-w-0">{desc}</span>
          <svg
            className="w-3 h-3 text-cc-muted shrink-0"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 5l3 3 3-3" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function PermissionBanner({ permission, sessionId }: { permission: PermissionRequest; sessionId: string }) {
  const [loading, setLoading] = useState(false);
  const [stamping, setStamping] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedFromEvaluating, setExpandedFromEvaluating] = useState(false);
  const [customEditorOpen, setCustomEditorOpen] = useState(false);
  const removePermission = useStore((s) => s.removePermission);

  // Auto-dismiss auto-approved permissions that the user wasn't actively viewing.
  // If the user had expanded from evaluating, keep it visible with an indicator.
  useEffect(() => {
    if (permission.autoApproved && !expandedFromEvaluating) {
      const timer = setTimeout(() => {
        removePermission(sessionId, permission.request_id);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [permission.autoApproved, expandedFromEvaluating, sessionId, permission.request_id, removePermission]);

  // Show evaluating collapsed state when permission is being LLM-evaluated,
  // unless the user has already expanded it for manual intervention.
  if (permission.evaluating && !expandedFromEvaluating) {
    return (
      <EvaluatingCollapsedChip
        permission={permission}
        sessionId={sessionId}
        onExpand={() => {
          setExpandedFromEvaluating(true);
          // Cancel auto-approval so the user can review manually
          sendToSession(sessionId, {
            type: "permission_user_viewing",
            request_id: permission.request_id,
          });
        }}
      />
    );
  }

  // Auto-approved: user wasn't looking → render nothing while useEffect auto-dismisses
  if (permission.autoApproved && !expandedFromEvaluating) {
    return null;
  }

  // Auto-approved: user had expanded the evaluating dialog → show "auto-approved" indicator
  if (permission.autoApproved) {
    return (
      <div className="px-2 sm:px-4 py-3 border-b border-cc-border bg-green-500/5 animate-[fadeSlideIn_0.2s_ease-out]">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-green-500 shrink-0">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm3.03 5.28a.75.75 0 00-1.06-1.06L7.25 7.94 6.03 6.72a.75.75 0 00-1.06 1.06l1.75 1.75a.75.75 0 001.06 0l3.25-3.25z" />
            </svg>
            <span className="text-[13px] text-cc-fg truncate">
              Auto-approved: <span className="text-cc-muted">{permission.autoApproved}</span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => removePermission(sessionId, permission.request_id)}
            className="text-[12px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer px-2 py-1 rounded hover:bg-cc-hover shrink-0"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  function handleAllow(updatedInput?: Record<string, unknown>, updatedPermissions?: PermissionUpdate[]) {
    setLoading(true);
    setStamping(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "allow",
      updated_input: updatedInput,
      ...(updatedPermissions?.length ? { updated_permissions: updatedPermissions } : {}),
    });
    // Don't call removePermission locally — the server broadcasts
    // permission_approved which authoritatively removes it via ws.ts.
    // Local removal caused a race: the component would unmount before
    // the stamping animation could play.
    //
    // Safety net: if the server already resolved this permission (e.g.,
    // auto-approver won the race), the broadcast will never come. Clean
    // up locally after a timeout to prevent a stuck zombie dialog.
    setTimeout(() => {
      removePermission(sessionId, permission.request_id);
    }, 3000);
  }

  function handleDeny() {
    setLoading(true);
    sendToSession(sessionId, {
      type: "permission_response",
      request_id: permission.request_id,
      behavior: "deny",
      message: "Denied by user",
    });
    removePermission(sessionId, permission.request_id);
  }

  const isAskUser = permission.tool_name === "AskUserQuestion";
  const suggestions = permission.permission_suggestions;

  // Extract first question info for collapsed preview
  const questions =
    isAskUser && Array.isArray(permission.input?.questions)
      ? (permission.input.questions as Record<string, unknown>[])
      : [];
  const firstQuestion = questions[0];
  const previewHeader = firstQuestion && typeof firstQuestion.header === "string" ? firstQuestion.header : "";
  const previewText =
    firstQuestion && typeof firstQuestion.question === "string" ? firstQuestion.question : "Question from assistant";

  // Collapsed AskUser chip — compact single-line view
  if (isAskUser && collapsed) {
    return (
      <div className="px-2 sm:px-4 py-2 border-b border-cc-border animate-[fadeSlideIn_0.2s_ease-out]">
        <div className="max-w-3xl mx-auto">
          <button
            onClick={() => setCollapsed(false)}
            title="Expand question"
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-cc-primary/20 bg-cc-primary/5 hover:bg-cc-primary/10 transition-colors cursor-pointer text-left"
          >
            {/* Question icon */}
            <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-cc-primary/10 border border-cc-primary/20">
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary">
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
            </div>

            {/* Header badge */}
            {previewHeader && (
              <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary shrink-0">
                {previewHeader}
              </span>
            )}

            {/* Question preview text */}
            <span className="text-xs text-cc-fg truncate flex-1">{previewText}</span>

            {/* Question count badge if multiple questions */}
            {questions.length > 1 && (
              <span className="text-[10px] text-cc-muted shrink-0">{questions.length} questions</span>
            )}

            {/* Expand chevron */}
            <svg
              className="w-3 h-3 text-cc-muted shrink-0"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 5l3 3 3-3" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-2 sm:px-4 py-3 border-b border-cc-border animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start gap-2 sm:gap-3">
          {/* Icon */}
          <div
            className={`w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
              isAskUser
                ? "bg-cc-primary/10 border border-cc-primary/20"
                : "bg-cc-warning/10 border border-cc-warning/20"
            }`}
          >
            {isAskUser ? (
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-cc-primary">
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-cc-warning">
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`text-xs font-semibold ${isAskUser ? "text-cc-primary" : "text-cc-warning"}`}>
                {isAskUser ? "Question" : "Permission Request"}
              </span>
              {!isAskUser && <span className="text-[11px] text-cc-muted font-mono-code">{permission.tool_name}</span>}
              {isAskUser && (
                <button
                  onClick={() => setCollapsed(true)}
                  className="ml-auto p-1 rounded hover:bg-cc-hover transition-colors cursor-pointer text-cc-muted hover:text-cc-fg"
                  title="Minimize question"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 7l-3-3-3 3" />
                  </svg>
                </button>
              )}
            </div>

            {/* Show when user took over from auto-approval */}
            {expandedFromEvaluating && !permission.evaluating && (
              <div className="text-[11px] text-amber-500/70 italic mb-1">Auto-approval cancelled — you took over</div>
            )}

            {/* Show why the auto-approver deferred this permission to the human */}
            {!expandedFromEvaluating && permission.deferralReason && (
              <div className="text-[11px] text-cc-warning/70 italic mb-1">{permission.deferralReason}</div>
            )}

            {isAskUser ? (
              <AskUserQuestionDisplay
                input={permission.input}
                onSelect={(answers) => handleAllow({ ...permission.input, answers })}
                disabled={loading}
              />
            ) : (
              <ToolInputDisplay
                toolName={permission.tool_name}
                input={permission.input}
                description={permission.description}
              />
            )}

            {/* Actions - only for non-AskUserQuestion tools */}
            {!isAskUser && (
              <>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <button
                    onClick={() => handleAllow()}
                    disabled={loading}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-success/90 hover:bg-cc-success text-white disabled:opacity-50 transition-colors cursor-pointer ${stamping ? "animate-[paw-approve_400ms_ease-out_forwards]" : ""}`}
                  >
                    {stamping ? (
                      <CatPawAvatar className="w-3.5 h-3.5" />
                    ) : (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                        <path d="M3 8.5l3.5 3.5 6.5-7" />
                      </svg>
                    )}
                    {stamping ? "Approved" : "Allow"}
                  </button>

                  {/* Permission suggestion buttons — only when CLI provides them */}
                  {!stamping &&
                    suggestions?.map((suggestion, i) => (
                      <button
                        key={i}
                        onClick={() => handleAllow(undefined, [suggestion])}
                        disabled={loading}
                        title={`${suggestion.type}: ${JSON.stringify(suggestion)}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary/10 hover:bg-cc-primary/20 text-cc-primary border border-cc-primary/20 disabled:opacity-50 transition-colors cursor-pointer"
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                          <path d="M3 8.5l3.5 3.5 6.5-7" />
                        </svg>
                        {suggestionLabel(suggestion)}
                      </button>
                    ))}

                  {!stamping && (
                    <button
                      onClick={handleDeny}
                      disabled={loading}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                      Deny
                    </button>
                  )}

                  {/* Custom rule editor toggle */}
                  {!stamping && (
                    <button
                      onClick={() => setCustomEditorOpen(!customEditorOpen)}
                      disabled={loading}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover border border-cc-border/30 disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                        <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" />
                      </svg>
                      Customize
                      <svg
                        className={`w-3 h-3 transition-transform ${customEditorOpen ? "rotate-180" : ""}`}
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M3 5l3 3 3-3" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Custom rule editor panel */}
                {customEditorOpen && !stamping && (
                  <CustomRuleEditor
                    toolName={permission.tool_name}
                    input={permission.input}
                    suggestions={permission.permission_suggestions}
                    onApply={(update) => handleAllow(undefined, [update])}
                    disabled={loading}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolInputDisplay({
  toolName,
  input,
  description,
}: {
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}) {
  if (toolName === "Bash") {
    return <BashDisplay input={input} />;
  }
  if (toolName === "Edit") {
    return <EditDisplay input={input} />;
  }
  if (toolName === "Write") {
    return <WriteDisplay input={input} />;
  }
  if (toolName === "Read") {
    return <ReadDisplay input={input} />;
  }
  if (toolName === "Glob") {
    return <GlobDisplay input={input} />;
  }
  if (toolName === "Grep") {
    return <GrepDisplay input={input} />;
  }
  if (toolName === "ExitPlanMode") {
    return <ExitPlanModeDisplay input={input} />;
  }

  // Fallback: formatted key-value display
  return <GenericDisplay input={input} description={description} />;
}

function BashDisplay({ input }: { input: Record<string, unknown> }) {
  const command = typeof input.command === "string" ? input.command : "";
  const desc = typeof input.description === "string" ? input.description : "";

  return (
    <div className="space-y-1.5">
      {desc && <div className="text-xs text-cc-muted">{desc}</div>}
      <pre className="text-xs text-cc-fg font-mono-code bg-cc-code-bg/30 rounded-lg px-2 sm:px-3 py-2 max-h-32 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words">
        <span className="text-cc-muted select-none">$ </span>
        {command}
      </pre>
    </div>
  );
}

function AskUserQuestionDisplay({
  input,
  onSelect,
  disabled,
}: {
  input: Record<string, unknown>;
  onSelect: (answers: Record<string, string>) => void;
  disabled: boolean;
}) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});

  function handleOptionClick(questionIdx: number, label: string) {
    const key = String(questionIdx);
    setSelections((prev) => ({ ...prev, [key]: label }));
    setShowCustom((prev) => ({ ...prev, [key]: false }));

    // Auto-submit if single question
    if (questions.length <= 1) {
      onSelect({ [key]: label });
    }
  }

  function handleCustomSubmit(questionIdx: number) {
    const key = String(questionIdx);
    const text = customText[key]?.trim();
    if (!text) return;
    setSelections((prev) => ({ ...prev, [key]: text }));

    if (questions.length <= 1) {
      onSelect({ [key]: text });
    }
  }

  function handleSubmitAll() {
    onSelect(selections);
  }

  if (questions.length === 0) {
    // Fallback for simple question string
    const question = typeof input.question === "string" ? input.question : "";
    if (question) {
      return <div className="text-sm text-cc-fg bg-cc-code-bg/30 rounded-lg px-3 py-2">{question}</div>;
    }
    return <GenericDisplay input={input} />;
  }

  return (
    <div className="space-y-3">
      {questions.map((q: Record<string, unknown>, i: number) => {
        const header = typeof q.header === "string" ? q.header : "";
        const text = typeof q.question === "string" ? q.question : "";
        const options = Array.isArray(q.options) ? q.options : [];
        const key = String(i);
        const selected = selections[key];
        const isCustom = showCustom[key];

        return (
          <div key={i} className="space-y-2">
            {header && (
              <span className="inline-block text-[10px] font-semibold text-cc-primary bg-cc-primary/10 px-1.5 py-0.5 rounded">
                {header}
              </span>
            )}
            {text && <p className="text-sm text-cc-fg leading-relaxed">{text}</p>}
            {options.length > 0 && (
              <div className="space-y-1.5">
                {options.map((opt: Record<string, unknown>, j: number) => {
                  const label = typeof opt.label === "string" ? opt.label : String(opt);
                  const desc = typeof opt.description === "string" ? opt.description : "";
                  const isSelected = selected === label;

                  return (
                    <button
                      key={j}
                      onClick={() => handleOptionClick(i, label)}
                      disabled={disabled}
                      className={`w-full text-left px-3 py-2 rounded-lg border transition-all cursor-pointer disabled:opacity-50 ${
                        isSelected
                          ? "border-cc-primary bg-cc-primary/10 ring-1 ring-cc-primary/30"
                          : "border-cc-border bg-cc-hover/50 hover:bg-cc-hover hover:border-cc-primary/30"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                            isSelected ? "border-cc-primary" : "border-cc-muted/40"
                          }`}
                        >
                          {isSelected && <span className="w-2 h-2 rounded-full bg-cc-primary" />}
                        </span>
                        <div>
                          <span className="text-xs font-medium text-cc-fg">{label}</span>
                          {desc && <p className="text-[11px] text-cc-muted mt-0.5 leading-snug">{desc}</p>}
                        </div>
                      </div>
                    </button>
                  );
                })}

                {/* "Other" option */}
                <button
                  onClick={() => setShowCustom((prev) => ({ ...prev, [key]: !prev[key] }))}
                  disabled={disabled}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-all cursor-pointer disabled:opacity-50 ${
                    isCustom
                      ? "border-cc-primary bg-cc-primary/10 ring-1 ring-cc-primary/30"
                      : "border-cc-border bg-cc-hover/50 hover:bg-cc-hover hover:border-cc-primary/30"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        isCustom ? "border-cc-primary" : "border-cc-muted/40"
                      }`}
                    >
                      {isCustom && <span className="w-2 h-2 rounded-full bg-cc-primary" />}
                    </span>
                    <span className="text-xs font-medium text-cc-muted">Other...</span>
                  </div>
                </button>

                {isCustom && (
                  <div className="flex gap-2 pl-6">
                    <input
                      type="text"
                      value={customText[key] || ""}
                      onChange={(e) => setCustomText((prev) => ({ ...prev, [key]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCustomSubmit(i);
                      }}
                      placeholder="Type your answer..."
                      className="flex-1 px-2.5 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                      autoFocus
                    />
                    <button
                      onClick={() => handleCustomSubmit(i)}
                      disabled={!customText[key]?.trim()}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      Send
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Submit all for multi-question */}
      {questions.length > 1 && Object.keys(selections).length > 0 && (
        <button
          onClick={handleSubmitAll}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white disabled:opacity-50 transition-colors cursor-pointer"
        >
          Submit answers
        </button>
      )}
    </div>
  );
}

function EditDisplay({ input }: { input: Record<string, unknown> }) {
  const {
    changes,
    filePath,
    oldText: oldStr,
    newText: newStr,
    unifiedDiff,
  } = parseEditToolInput(input, { fallbackToFirstChangePath: true });

  if (!oldStr && !newStr && unifiedDiff) {
    return <DiffViewer unifiedDiff={unifiedDiff} fileName={filePath} mode="full" />;
  }

  if (!oldStr && !newStr && changes.length > 0) {
    return (
      <div className="text-xs text-cc-muted font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-1">
        {changes.map((change, i) => (
          <div key={`${typeof change.path === "string" ? change.path : "file"}-${i}`}>
            {typeof change.kind === "string" ? change.kind : "modify"}:{" "}
            {typeof change.path === "string" ? change.path : filePath || "(unknown file)"}
          </div>
        ))}
      </div>
    );
  }

  return <DiffViewer oldText={oldStr} newText={newStr} fileName={filePath} mode="full" />;
}

function WriteDisplay({ input }: { input: Record<string, unknown> }) {
  const { filePath, content, changes, unifiedDiff } = parseWriteToolInput(input);

  if (!content && unifiedDiff) {
    return <DiffViewer unifiedDiff={unifiedDiff} fileName={filePath} mode="full" />;
  }

  if (!content && changes.length > 0) {
    return (
      <div className="text-xs text-cc-muted font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-1">
        {changes.map((change, i) => (
          <div key={`${typeof change.path === "string" ? change.path : "file"}-${i}`}>
            {typeof change.kind === "string" ? change.kind : "create"}:{" "}
            {typeof change.path === "string" ? change.path : filePath || "(unknown file)"}
          </div>
        ))}
      </div>
    );
  }

  return <DiffViewer newText={content} fileName={filePath} mode="full" />;
}

function ReadDisplay({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path || "");
  return <div className="text-xs text-cc-muted font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2">{filePath}</div>;
}

function GlobDisplay({ input }: { input: Record<string, unknown> }) {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const path = typeof input.path === "string" ? input.path : "";
  return (
    <div className="text-xs font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-0.5">
      <div className="text-cc-fg">{pattern}</div>
      {path && <div className="text-cc-muted">{path}</div>}
    </div>
  );
}

function GrepDisplay({ input }: { input: Record<string, unknown> }) {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const path = typeof input.path === "string" ? input.path : "";
  const glob = typeof input.glob === "string" ? input.glob : "";
  return (
    <div className="text-xs font-mono-code bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-0.5">
      <div className="text-cc-fg">{pattern}</div>
      {path && <div className="text-cc-muted">{path}</div>}
      {glob && <div className="text-cc-muted">{glob}</div>}
    </div>
  );
}

function ExitPlanModeDisplay({ input }: { input: Record<string, unknown> }) {
  const plan = typeof input.plan === "string" ? input.plan : "";
  const allowedPrompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];

  return (
    <div className="space-y-3">
      {plan && (
        <div className="max-h-[50vh] overflow-y-auto pr-1">
          <MarkdownContent text={plan} size="sm" />
        </div>
      )}
      {allowedPrompts.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-cc-muted uppercase tracking-wider">Requested permissions</div>
          <div className="space-y-1">
            {allowedPrompts.map((p: Record<string, unknown>, i: number) => (
              <div
                key={i}
                className="flex items-center gap-2 text-[11px] font-mono-code bg-cc-code-bg/30 rounded-lg px-2.5 py-1.5"
              >
                <span className="text-cc-muted shrink-0">{String(p.tool || "")}</span>
                <span className="text-cc-fg">{String(p.prompt || "")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!plan && allowedPrompts.length === 0 && <div className="text-xs text-cc-muted">Plan approval requested</div>}
    </div>
  );
}

function GenericDisplay({ input, description }: { input: Record<string, unknown>; description?: string }) {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== "");

  if (entries.length === 0 && description) {
    return <div className="text-xs text-cc-fg">{description}</div>;
  }

  return (
    <div className="space-y-1">
      {description && <div className="text-xs text-cc-muted mb-1">{description}</div>}
      <div className="bg-cc-code-bg/30 rounded-lg px-3 py-2 space-y-1">
        {entries.map(([key, value]) => {
          const displayValue =
            typeof value === "string"
              ? value.length > 200
                ? value.slice(0, 200) + "..."
                : value
              : JSON.stringify(value);
          return (
            <div key={key} className="flex gap-2 text-[11px] font-mono-code">
              <span className="text-cc-muted shrink-0">{key}:</span>
              <span className="text-cc-fg break-all">{displayValue}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── PermissionsCollapsedChip — compact summary when permissions are minimized ──

export function PermissionsCollapsedChip({
  permissions,
  onExpand,
}: {
  permissions: PermissionRequest[];
  onExpand: () => void;
}) {
  const toolNames = permissions.map((p) => p.tool_name);
  const uniqueTools = [...new Set(toolNames)];
  const summary =
    uniqueTools.length <= 3
      ? uniqueTools.join(", ")
      : `${uniqueTools.slice(0, 2).join(", ")} +${uniqueTools.length - 2} more`;

  return (
    <div className="shrink-0 border-t border-cc-border bg-cc-card px-2 sm:px-4 py-2 animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={onExpand}
          title="Expand pending approvals"
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-cc-warning/20 bg-cc-warning/5 hover:bg-cc-warning/10 transition-colors cursor-pointer text-left"
        >
          <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-cc-warning/10 border border-cc-warning/20">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning">
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-cc-warning/10 text-cc-warning shrink-0">
            {permissions.length}
          </span>
          <span className="text-xs text-cc-fg truncate flex-1">
            pending approval{permissions.length !== 1 ? "s" : ""}: {summary}
          </span>
          <svg
            className="w-3 h-3 text-cc-muted shrink-0"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 5l3 3 3-3" />
          </svg>
        </button>
      </div>
    </div>
  );
}
