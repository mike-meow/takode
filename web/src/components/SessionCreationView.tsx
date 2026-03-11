import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { api, type BackendInfo, type CompanionEnv, type GitRepoInfo, type GitBranchInfo } from "../api.js";
import { retryPendingCreation, cancelPendingCreation, startPendingCreation } from "../utils/pending-creation.js";
import {
  CODEX_REASONING_EFFORTS,
  deriveCodexUiMode,
  deriveUiMode,
  getDefaultModel,
  getModelsForBackend,
  getModesForBackend,
  resolveClaudeCliMode,
  resolveCodexCliMode,
  toModelOptions,
  type ModelOption,
} from "../utils/backends.js";
import type { BackendType } from "../types.js";
import { saveGroupNewSessionDefaults } from "../utils/new-session-defaults.js";
import { YarnBallSpinner } from "./CatIcons.js";
import type { CreationProgressEvent } from "../api.js";

interface Props {
  pendingId: string;
}

/**
 * Inline view shown in the main content area when a pending session is selected.
 * Replaces the old full-screen SessionLaunchOverlay — same visuals, but inline
 * so the user can navigate the sidebar while creation runs in the background.
 */
export function SessionCreationView({ pendingId }: Props) {
  const pending = useStore((s) => s.pendingSessions.get(pendingId));

  if (!pending) {
    return (
      <div className="flex-1 flex items-center justify-center text-cc-muted text-sm">
        Session not found
      </div>
    );
  }

  if (pending.status === "draft") {
    return <DraftSessionEditor pendingId={pendingId} />;
  }

  const { progress, error, status, backend } = pending;
  const logoSrc = backend === "codex" ? "/logo-codex.svg" : "/logo.png";
  const isCreating = status === "creating";
  const hasError = status === "error";
  const isAnyInProgress = progress.some((s) => s.status === "in_progress");

  // Current step label for the subtitle
  const currentStep = [...progress].reverse().find((s) => s.status === "in_progress");
  const lastDone = [...progress].reverse().find((s) => s.status === "done");
  const subtitle = hasError
    ? "Something went wrong"
    : status === "succeeded"
      ? "Launching session..."
      : currentStep?.label || lastDone?.label || "Preparing...";

  return (
    <div className="flex-1 flex flex-col items-center justify-center">
      {/* Pulsing logo */}
      <div className="relative mb-8">
        {isAnyInProgress && !hasError && (
          <div className="absolute inset-0 -m-4 rounded-full bg-cc-primary/10 animate-pulse" />
        )}
        <img
          src={logoSrc}
          alt="Creating session"
          className={`w-20 h-20 relative z-10 transition-transform duration-500 ${
            isAnyInProgress && !hasError ? "scale-110" : ""
          } ${hasError ? "opacity-40 grayscale" : ""}`}
        />
        {/* Spinner ring around logo */}
        {isAnyInProgress && !hasError && (
          <div className="absolute -inset-3 z-0">
            <svg className="w-full h-full animate-spin-slow" viewBox="0 0 100 100">
              <circle
                cx="50" cy="50" r="46"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="60 230"
                strokeLinecap="round"
                className="text-cc-primary/40"
              />
            </svg>
          </div>
        )}
        {/* Success ring */}
        {status === "succeeded" && (
          <div className="absolute -inset-3 z-0 rounded-full border-2 border-cc-success/30" />
        )}
      </div>

      {/* Status text */}
      <p className={`text-sm font-medium mb-6 transition-colors ${
        hasError ? "text-cc-error" : "text-cc-fg"
      }`}>
        {subtitle}
      </p>

      {/* Step list */}
      <StepList steps={progress} />

      {/* Error detail box */}
      {error && (
        <div className="mt-5 w-full max-w-xs px-4">
          <div className="px-3 py-2.5 rounded-lg bg-cc-error/5 border border-cc-error/20">
            <p className="text-[11px] text-cc-error whitespace-pre-wrap font-mono-code leading-relaxed">
              {error}
            </p>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-6 flex items-center gap-3">
        {hasError && (
          <button
            onClick={() => retryPendingCreation(pendingId)}
            className="px-4 py-1.5 text-xs font-medium rounded-lg bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25 transition-colors cursor-pointer"
          >
            Retry
          </button>
        )}
        <button
          onClick={() => cancelPendingCreation(pendingId)}
          className="px-4 py-1.5 text-xs font-medium rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg hover:bg-cc-border transition-colors cursor-pointer"
        >
          {hasError ? "Dismiss" : "Cancel"}
        </button>
      </div>

      {/* Progress bar at the bottom */}
      {isCreating && progress.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-cc-border/30">
          <div
            className="h-full bg-cc-primary/60 transition-all duration-500 ease-out"
            style={{
              width: `${Math.round(
                (progress.filter((s) => s.status === "done").length / Math.max(progress.length, 1)) * 100,
              )}%`,
            }}
          />
        </div>
      )}
    </div>
  );
}

function DraftSessionEditor({ pendingId }: { pendingId: string }) {
  const pending = useStore((s) => s.pendingSessions.get(pendingId));
  if (!pending) return null;
  const pendingSession = pending;

  const initialBackend = (pendingSession.createOpts.backend ?? pendingSession.backend) as Exclude<BackendType, "claude-sdk">;
  const initialPermissionMode = pendingSession.createOpts.permissionMode ?? "acceptEdits";
  const initialAskPermission = pendingSession.createOpts.askPermission ?? true;

  const [backend, setBackend] = useState<Exclude<BackendType, "claude-sdk">>(initialBackend);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [dynamicModels, setDynamicModels] = useState<ModelOption[] | null>(null);
  const [cwd, setCwd] = useState(pendingSession.createOpts.cwd || pendingSession.cwd || "");
  const [model, setModel] = useState(pendingSession.createOpts.model || getDefaultModel(initialBackend));
  const [mode, setMode] = useState<"plan" | "agent">(
    initialBackend === "codex" ? deriveCodexUiMode(initialPermissionMode) : deriveUiMode(initialPermissionMode),
  );
  const [askPermission, setAskPermission] = useState(initialAskPermission);
  const [selectedEnv, setSelectedEnv] = useState(pendingSession.createOpts.envSlug || "");
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [useWorktree, setUseWorktree] = useState(pendingSession.createOpts.useWorktree ?? true);
  const [codexInternetAccess, setCodexInternetAccess] = useState(pendingSession.createOpts.codexInternetAccess ?? false);
  const [codexReasoningEffort, setCodexReasoningEffort] = useState(pendingSession.createOpts.codexReasoningEffort || "");
  const [repoInfoLoading, setRepoInfoLoading] = useState(false);
  const [gitRepoInfo, setGitRepoInfo] = useState<GitRepoInfo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");
  const [isNewBranch, setIsNewBranch] = useState(false);
  const [sessionRole, setSessionRole] = useState<"worker" | "leader">("worker");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  const models = dynamicModels || getModelsForBackend(backend);

  useEffect(() => {
    api.listEnvs().then(setEnvs).catch(() => {});
    api.getBackends().then(setBackends).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getBackendModels(backend).then((available) => {
      if (cancelled || available.length === 0) return;
      const options = toModelOptions(available);
      const statics = getModelsForBackend(backend);
      const defaultOpt = statics.find((entry) => entry.value === "");
      const withDefault = defaultOpt
        ? [defaultOpt, ...options.filter((entry) => entry.value !== "")]
        : options;
      setDynamicModels(withDefault);
      if (!withDefault.some((entry) => entry.value === model)) {
        setModel(withDefault[0].value);
      }
    }).catch(() => {
      if (!cancelled) setDynamicModels(null);
    });
    return () => { cancelled = true; };
  }, [backend, model]);

  useEffect(() => {
    const trimmed = cwd.trim();
    if (!trimmed) {
      setGitRepoInfo(null);
      setBranches([]);
      setRepoInfoLoading(false);
      return;
    }
    setRepoInfoLoading(true);
    api.getRepoInfo(trimmed).then((info) => {
      setGitRepoInfo(info);
      setIsNewBranch(false);
      api.listBranches(info.repoRoot).then((branchList) => {
        setBranches(branchList);
        if (!selectedBranch) {
          setSelectedBranch(info.currentBranch);
        }
      }).catch(() => {
        setBranches([]);
        if (!selectedBranch) {
          setSelectedBranch(info.currentBranch);
        }
      });
    }).catch(() => {
      setGitRepoInfo(null);
      setBranches([]);
    }).finally(() => {
      setRepoInfoLoading(false);
    });
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close branch dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, []);

  function switchBackend(nextBackend: Exclude<BackendType, "claude-sdk">) {
    setBackend(nextBackend);
    setDynamicModels(null);
    setModel(getDefaultModel(nextBackend));
    setMode((getModesForBackend(nextBackend)[0]?.value || "agent") as "plan" | "agent");
  }

  function handleCreate() {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd) {
      setError("Working directory is required");
      return;
    }

    const permissionMode = backend === "codex"
      ? resolveCodexCliMode(mode, askPermission)
      : resolveClaudeCliMode(mode, askPermission);

    const branchName = selectedBranch.trim()
      || (useWorktree ? gitRepoInfo?.currentBranch : undefined)
      || undefined;

    const createOpts = {
      model,
      permissionMode,
      cwd: trimmedCwd,
      envSlug: selectedEnv || undefined,
      branch: useWorktree ? branchName : undefined,
      createBranch: branchName && isNewBranch ? true : undefined,
      useWorktree: useWorktree || undefined,
      backend,
      codexInternetAccess: backend === "codex" ? codexInternetAccess : undefined,
      codexReasoningEffort: backend === "codex" ? (codexReasoningEffort || undefined) : undefined,
      assistantMode: undefined,
      askPermission,
      role: sessionRole === "leader" ? "orchestrator" as const : undefined,
    };

    const groupKey = pendingSession.groupKey?.trim() || pendingSession.cwd?.trim() || "";
    if (groupKey) {
      saveGroupNewSessionDefaults(groupKey, {
        backend,
        model,
        mode,
        askPermission,
        envSlug: selectedEnv,
        useWorktree,
        codexInternetAccess,
        codexReasoningEffort,
      });
    }

    setCreating(true);
    setError(null);
    useStore.getState().updatePendingSession(pendingId, {
      backend,
      createOpts,
      cwd: trimmedCwd,
      status: "creating",
      error: null,
      progress: [],
      realSessionId: null,
    });
    startPendingCreation(pendingId);
  }

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-6 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl border border-cc-border bg-cc-bg shadow-xl p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-cc-fg">New Session</h2>
          <p className="text-sm text-cc-muted mt-1">Review this group&apos;s saved defaults before creating the session.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm text-cc-fg space-y-1.5">
            <span className="block text-xs uppercase tracking-wide text-cc-muted">Backend</span>
            <select
              value={backend}
              onChange={(e) => switchBackend(e.target.value as Exclude<BackendType, "claude-sdk">)}
              className="w-full rounded-lg border border-cc-border bg-cc-input-bg px-3 py-2 text-sm"
            >
              {(backends.length > 0 ? backends : [{ id: "claude" }, { id: "codex" }] as Array<{ id: string }>).map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.id}</option>
              ))}
            </select>
          </label>

          <label className="text-sm text-cc-fg space-y-1.5">
            <span className="block text-xs uppercase tracking-wide text-cc-muted">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-lg border border-cc-border bg-cc-input-bg px-3 py-2 text-sm"
            >
              {models.map((entry) => (
                <option key={entry.value || "__default"} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </label>

          <label className="text-sm text-cc-fg space-y-1.5 md:col-span-2">
            <span className="block text-xs uppercase tracking-wide text-cc-muted">Working directory</span>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              className="w-full rounded-lg border border-cc-border bg-cc-input-bg px-3 py-2 text-sm"
              spellCheck={false}
            />
          </label>

          <label className="text-sm text-cc-fg space-y-1.5">
            <span className="block text-xs uppercase tracking-wide text-cc-muted">Mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "plan" | "agent")}
              className="w-full rounded-lg border border-cc-border bg-cc-input-bg px-3 py-2 text-sm"
            >
              {getModesForBackend(backend).map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </label>

          <label className="text-sm text-cc-fg space-y-1.5">
            <span className="block text-xs uppercase tracking-wide text-cc-muted">Environment</span>
            <select
              value={selectedEnv}
              onChange={(e) => setSelectedEnv(e.target.value)}
              className="w-full rounded-lg border border-cc-border bg-cc-input-bg px-3 py-2 text-sm"
            >
              <option value="">None</option>
              {envs.map((env) => (
                <option key={env.slug} value={env.slug}>{env.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-cc-fg">
            <input
              type="checkbox"
              checked={askPermission}
              onChange={(e) => setAskPermission(e.target.checked)}
            />
            Ask permission before acting
          </label>
          <label className="flex items-center gap-2 text-sm text-cc-fg">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
            />
            Create in a worktree
          </label>
          <label className="flex items-center gap-2 text-sm text-cc-fg">
            <input
              type="checkbox"
              checked={sessionRole === "leader"}
              onChange={(e) => setSessionRole(e.target.checked ? "leader" : "worker")}
            />
            Leader session
          </label>
        </div>

        {backend === "codex" && (
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex items-center gap-2 text-sm text-cc-fg">
              <input
                type="checkbox"
                checked={codexInternetAccess}
                onChange={(e) => setCodexInternetAccess(e.target.checked)}
              />
              Enable web access
            </label>
            <label className="text-sm text-cc-fg space-y-1.5">
              <span className="block text-xs uppercase tracking-wide text-cc-muted">Reasoning</span>
              <select
                value={codexReasoningEffort}
                onChange={(e) => setCodexReasoningEffort(e.target.value)}
                className="w-full rounded-lg border border-cc-border bg-cc-input-bg px-3 py-2 text-sm"
              >
                {CODEX_REASONING_EFFORTS.map((entry) => (
                  <option key={entry.value || "__default"} value={entry.value}>{entry.label}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {/* Branch selector — shown when worktree is enabled and repo detected */}
        {gitRepoInfo && useWorktree && (
          <div className="relative" ref={branchDropdownRef}>
            <label className="text-sm text-cc-fg space-y-1.5">
              <span className="block text-xs uppercase tracking-wide text-cc-muted">Branch</span>
              <button
                type="button"
                onClick={() => {
                  if (!showBranchDropdown && gitRepoInfo) {
                    api.gitFetch(gitRepoInfo.repoRoot).catch(() => {}).finally(() => {
                      api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => setBranches([]));
                    });
                  }
                  setShowBranchDropdown(!showBranchDropdown);
                  setBranchFilter("");
                }}
                className="w-full rounded-lg border border-cc-border bg-cc-input-bg px-3 py-2 text-sm text-left flex items-center gap-2 cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60 shrink-0">
                  <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.378A2.5 2.5 0 007.5 8h1a1 1 0 010 2h-1A2.5 2.5 0 005 12.5v.128a2.25 2.25 0 101.5 0V12.5a1 1 0 011-1h1a2.5 2.5 0 000-5h-1a1 1 0 01-1-1V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                </svg>
                <span className="truncate font-mono-code">
                  {selectedBranch || gitRepoInfo.currentBranch}
                </span>
                {isNewBranch && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-cc-primary/15 text-cc-primary shrink-0">new</span>
                )}
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50 ml-auto shrink-0">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
            </label>
            {showBranchDropdown && (
              <div className="absolute left-0 top-full mt-1 w-full max-h-[280px] bg-cc-card border border-cc-border rounded-lg shadow-lg z-10 overflow-hidden">
                <div className="px-2 py-2 border-b border-cc-border">
                  <input
                    type="text"
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value)}
                    placeholder="Filter or create branch..."
                    className="w-full px-2 py-1 text-sm bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setShowBranchDropdown(false);
                    }}
                  />
                </div>
                <div className="max-h-[220px] overflow-y-auto py-1">
                  {(() => {
                    const filter = branchFilter.toLowerCase().trim();
                    const localBranches = branches.filter((b) => !b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                    const remoteBranches = branches.filter((b) => b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                    const exactMatch = branches.some((b) => b.name.toLowerCase() === filter);
                    const hasResults = localBranches.length > 0 || remoteBranches.length > 0;
                    return (
                      <>
                        {localBranches.length > 0 && (
                          <>
                            <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider">Local</div>
                            {localBranches.map((b) => (
                              <button
                                key={b.name}
                                onClick={() => {
                                  setSelectedBranch(b.name);
                                  setIsNewBranch(false);
                                  setShowBranchDropdown(false);
                                }}
                                className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                  b.name === selectedBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                }`}
                              >
                                <span className="truncate font-mono-code">{b.name}</span>
                                <span className="ml-auto flex items-center gap-1.5 shrink-0">
                                  {b.ahead > 0 && <span className="text-[9px] text-green-500">{b.ahead}&#8593;</span>}
                                  {b.behind > 0 && <span className="text-[9px] text-amber-500">{b.behind}&#8595;</span>}
                                  {b.worktreePath && (
                                    <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400">wt</span>
                                  )}
                                  {b.isCurrent && (
                                    <span className="text-[9px] px-1 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400">current</span>
                                  )}
                                </span>
                              </button>
                            ))}
                          </>
                        )}
                        {remoteBranches.length > 0 && (
                          <>
                            <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider mt-1">Remote</div>
                            {remoteBranches.map((b) => (
                              <button
                                key={`remote-${b.name}`}
                                onClick={() => {
                                  setSelectedBranch(b.name);
                                  setIsNewBranch(false);
                                  setShowBranchDropdown(false);
                                }}
                                className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                  b.name === selectedBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                }`}
                              >
                                <span className="truncate font-mono-code">{b.name}</span>
                                <span className="text-[9px] px-1 py-0.5 rounded bg-cc-hover text-cc-muted ml-auto shrink-0">remote</span>
                              </button>
                            ))}
                          </>
                        )}
                        {!hasResults && filter && (
                          <div className="px-3 py-2 text-xs text-cc-muted text-center">No matching branches</div>
                        )}
                        {filter && !exactMatch && (
                          <div className="border-t border-cc-border mt-1 pt-1">
                            <button
                              onClick={() => {
                                setSelectedBranch(branchFilter.trim());
                                setIsNewBranch(true);
                                setShowBranchDropdown(false);
                              }}
                              className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-primary"
                            >
                              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
                                <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
                              </svg>
                              <span>Create <span className="font-mono-code font-medium">{branchFilter.trim()}</span></span>
                            </button>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="text-xs text-cc-muted min-h-5">
          {repoInfoLoading
            ? "Checking repository info..."
            : useWorktree && gitRepoInfo
              ? `Worktree will branch from ${selectedBranch || gitRepoInfo.currentBranch}.`
              : useWorktree
                ? "Worktree will use the current branch if this directory is a git repo."
                : ""}
        </div>

        {error && (
          <div className="rounded-lg border border-cc-error/20 bg-cc-error/5 px-3 py-2 text-sm text-cc-error">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={() => cancelPendingCreation(pendingId)}
            className="px-4 py-2 rounded-lg bg-cc-hover text-cc-muted hover:text-cc-fg cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 rounded-lg bg-cc-primary text-white disabled:opacity-60 cursor-pointer"
          >
            {creating ? "Starting..." : "Create Session"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Reusable step list used by both SessionCreationView and Playground mocks.
 */
export function StepList({ steps }: { steps: CreationProgressEvent[] }) {
  return (
    <div className="w-full max-w-xs space-y-2 px-4">
      {steps.map((step, i) => (
        <div
          key={step.step}
          className="flex items-center gap-3 transition-all duration-300"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          {/* Icon */}
          <div className="w-5 h-5 flex items-center justify-center shrink-0">
            {step.status === "in_progress" && (
              <YarnBallSpinner className="w-4 h-4 text-cc-primary" />
            )}
            {step.status === "done" && (
              <div className="w-5 h-5 rounded-full bg-cc-success/15 flex items-center justify-center">
                <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 text-cc-success">
                  <path
                    d="M13.25 4.75L6 12 2.75 8.75"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            )}
            {step.status === "error" && (
              <div className="w-5 h-5 rounded-full bg-cc-error/15 flex items-center justify-center">
                <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 text-cc-error">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            )}
          </div>

          {/* Label */}
          <span
            className={`text-xs transition-colors duration-200 ${
              step.status === "in_progress"
                ? "text-cc-fg font-medium"
                : step.status === "done"
                  ? "text-cc-muted"
                  : "text-cc-error font-medium"
            }`}
          >
            {step.label}
          </span>

          {/* Detail */}
          {step.detail && step.status === "in_progress" && (
            <span className="text-[10px] text-cc-muted truncate ml-auto max-w-[120px]">
              {step.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
