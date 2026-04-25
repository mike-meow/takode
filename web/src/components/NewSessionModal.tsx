import { useState, useRef, useEffect } from "react";
import {
  api,
  type CompanionEnv,
  type GitRepoInfo,
  type GitBranchInfo,
  type BackendInfo,
  type CliSession,
} from "../api.js";
import { getRecentDirs } from "../utils/recent-dirs.js";
import { queuePendingSession } from "../utils/pending-creation.js";
import {
  CODEX_REASONING_EFFORTS,
  getModelsForBackend,
  getModesForBackend,
  getDefaultModel,
  getDefaultMode,
  toModelOptions,
  resolveCodexCliMode,
  resolveClaudeCliMode,
  deriveCodexUiMode,
  deriveCodexAskPermission,
  type ModelOption,
} from "../utils/backends.js";
import type { BackendType } from "../types.js";
import { scopedGetItem, scopedSetItem } from "../utils/scoped-storage.js";
import {
  getGlobalNewSessionDefaults,
  getGroupNewSessionDefaults,
  saveLastSessionCreationContext,
  saveGroupNewSessionDefaults,
  type NewSessionBackend,
} from "../utils/new-session-defaults.js";
import { EnvManager } from "./EnvManager.js";
import { FolderPicker } from "./FolderPicker.js";
import { YarnBallSpinner } from "./CatIcons.js";

// ─── Branch persistence helpers ─────────────────────────────────────────────

function getSavedBranches(): Record<string, string> {
  try {
    return JSON.parse(scopedGetItem("cc-branch") || "{}");
  } catch {
    return {};
  }
}

function saveBranch(repoRoot: string, branchName: string) {
  const map = getSavedBranches();
  map[repoRoot] = branchName;
  const keys = Object.keys(map);
  if (keys.length > 20) {
    delete map[keys[0]];
  }
  scopedSetItem("cc-branch", JSON.stringify(map));
}

export function NewSessionModal({
  open,
  onClose,
  groupKey,
  groupCwd,
  treeGroupId,
  newSessionDefaultsKey,
}: {
  open: boolean;
  onClose: () => void;
  /** When set, pre-fill from this group's saved defaults */
  groupKey?: string;
  /** Working directory to pre-fill (typically the group's project root) */
  groupCwd?: string;
  /** Tree-view group to assign the new session to after creation */
  treeGroupId?: string;
  /** Explicit storage key for per-group new-session defaults */
  newSessionDefaultsKey?: string;
}) {
  // Resolve defaults: group-specific when opening for a group, global otherwise
  const defaultsKey = newSessionDefaultsKey?.trim() || groupKey?.trim() || "";
  const defaults = defaultsKey ? getGroupNewSessionDefaults(defaultsKey) : getGlobalNewSessionDefaults();
  const persistGlobalDefaults = defaultsKey.length === 0;

  function persistGlobalDefault(key: string, value: string): void {
    if (!persistGlobalDefaults) return;
    scopedSetItem(key, value);
  }

  const [backend, setBackend] = useState<BackendType>(() => defaults.backend);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [model, setModel] = useState(() => defaults.model);
  const [mode, setMode] = useState(() => defaults.mode);
  const [cwd, setCwd] = useState(() => groupCwd || defaults.cwd || getRecentDirs(defaultsKey)[0] || "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [dynamicModels, setDynamicModels] = useState<ModelOption[] | null>(null);
  const [codexDefaultModel, setCodexDefaultModel] = useState("");
  const [codexInternetAccess, setCodexInternetAccess] = useState(() => defaults.codexInternetAccess);
  const [codexReasoningEffort, setCodexReasoningEffort] = useState(() => defaults.codexReasoningEffort);
  const [askPermission, setAskPermission] = useState(() => defaults.askPermission);

  // Resume mode state
  const [resumeMode, setResumeMode] = useState(false);
  const [cliSessions, setCliSessions] = useState<CliSession[]>([]);
  const [loadingCliSessions, setLoadingCliSessions] = useState(false);
  const [selectedCliSession, setSelectedCliSession] = useState<string>("");
  const [manualSessionId, setManualSessionId] = useState("");

  const MODELS = dynamicModels || getModelsForBackend(backend);

  // Environment state
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [selectedEnv, setSelectedEnv] = useState(() => defaults.envSlug);
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);
  const [showEnvManager, setShowEnvManager] = useState(false);

  // Dropdown states
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showReasoningDropdown, setShowReasoningDropdown] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  // Git branch state
  const [gitRepoInfo, setGitRepoInfo] = useState<GitRepoInfo | null>(null);
  const [repoInfoLoading, setRepoInfoLoading] = useState(false);
  const [useWorktree, setUseWorktree] = useState(() => defaults.useWorktree);
  const [sessionRole, setSessionRole] = useState<"worker" | "leader">(() => defaults.sessionRole);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");
  const [isNewBranch, setIsNewBranch] = useState(false);

  // Branch freshness check state
  const [pullPrompt, setPullPrompt] = useState<{ behind: number; branchName: string } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState("");

  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const reasoningDropdownRef = useRef<HTMLDivElement>(null);
  const envDropdownRef = useRef<HTMLDivElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  // Reset all form state when the modal opens (with potentially new group context).
  // useState initializers only run on first mount, so this effect is needed to
  // reinitialize when re-opening with different props.
  useEffect(() => {
    if (!open) return;
    const d = defaultsKey ? getGroupNewSessionDefaults(defaultsKey) : getGlobalNewSessionDefaults();
    setBackend(d.backend);
    setModel(d.model);
    setMode(d.mode);
    setCwd(groupCwd || d.cwd || getRecentDirs(defaultsKey)[0] || "");
    setAskPermission(d.askPermission);
    setSelectedEnv(d.envSlug);
    setUseWorktree(d.useWorktree);
    setCodexInternetAccess(d.codexInternetAccess);
    setCodexReasoningEffort(d.codexReasoningEffort);
    setSessionRole(d.sessionRole);
    setSelectedBranch("");
    setBranches([]);
    setIsNewBranch(false);
    setError("");
    setSending(false);
    setResumeMode(false);
    setPullPrompt(null);
    setPullError("");
    setDynamicModels(null);
  }, [open, defaultsKey, groupCwd, treeGroupId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load server home/cwd and available backends on mount
  useEffect(() => {
    if (!open) return;
    api
      .getHome()
      .then(({ home, cwd: serverCwd }) => {
        if (!cwd) {
          setCwd(serverCwd || home);
        }
      })
      .catch(() => {});
    api
      .listEnvs()
      .then(setEnvs)
      .catch(() => {});
    api
      .getCodexDefaultModel()
      .then(({ model }) => setCodexDefaultModel(model || ""))
      .catch(() => setCodexDefaultModel(""));
    api
      .getBackends()
      .then(setBackends)
      .catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateMode(value: string) {
    setMode(value);
    persistGlobalDefault("cc-mode", value);
  }

  function switchBackend(newBackend: BackendType) {
    setBackend(newBackend);
    persistGlobalDefault("cc-backend", newBackend);
    setDynamicModels(null);

    const savedModel = scopedGetItem(`cc-model-${newBackend}`);
    const statics = getModelsForBackend(newBackend);
    if (savedModel && (statics.some((m) => m.value === savedModel) || newBackend === "codex")) {
      setModel(savedModel);
    } else {
      setModel(newBackend === "codex" ? "" : getDefaultModel(newBackend));
    }

    updateMode(getDefaultMode(newBackend));
  }

  // Fetch dynamic models from the server (LiteLLM proxy discovery).
  // Works for all backends — falls back to static defaults if unavailable.
  useEffect(() => {
    if (!open) {
      setDynamicModels(null);
      return;
    }
    api
      .getBackendModels(backend)
      .then((models) => {
        if (models.length > 0) {
          const options = toModelOptions(models);
          // Always prepend the "Default" option (value="") so users can use
          // whatever model is configured in settings.json / cloud config.
          const staticModels = getModelsForBackend(backend);
          const defaultOpt = staticModels.find((m) => m.value === "");
          const withDefault = defaultOpt ? [defaultOpt, ...options.filter((m) => m.value !== "")] : options;
          setDynamicModels(withDefault);
          if (!withDefault.some((m) => m.value === model)) {
            setModel(withDefault[0].value);
            persistGlobalDefault(`cc-model-${backend}`, withDefault[0].value);
          }
        }
      })
      .catch(() => {});
  }, [open, backend]); // eslint-disable-line react-hooks/exhaustive-deps

  // Migrate legacy Codex mode values from older builds.
  useEffect(() => {
    if (backend !== "codex") return;
    if (mode !== "suggest" && mode !== "bypassPermissions") return;
    const uiMode = deriveCodexUiMode(mode);
    const ask = deriveCodexAskPermission(mode);
    setMode(uiMode);
    setAskPermission(ask);
    persistGlobalDefault("cc-mode", uiMode);
    persistGlobalDefault("cc-ask-permission", String(ask));
  }, [backend, mode]);

  // Close dropdowns on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (reasoningDropdownRef.current && !reasoningDropdownRef.current.contains(e.target as Node)) {
        setShowReasoningDropdown(false);
      }
      if (envDropdownRef.current && !envDropdownRef.current.contains(e.target as Node)) {
        setShowEnvDropdown(false);
      }
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, [open]);

  // Detect git repo when cwd changes; restore saved branch if valid
  useEffect(() => {
    if (!open || !cwd) {
      setGitRepoInfo(null);
      setRepoInfoLoading(false);
      return;
    }
    setRepoInfoLoading(true);
    api
      .getRepoInfo(cwd)
      .then((info) => {
        setGitRepoInfo(info);
        setIsNewBranch(false);
        api
          .listBranches(info.repoRoot)
          .then((branchList) => {
            setBranches(branchList);
            const saved = getSavedBranches()[info.repoRoot];
            if (saved && branchList.some((b) => b.name === saved)) {
              setSelectedBranch(saved);
            } else {
              setSelectedBranch(info.currentBranch);
            }
          })
          .catch(() => {
            setBranches([]);
            setSelectedBranch(info.currentBranch);
          });
      })
      .catch(() => {
        setGitRepoInfo(null);
      })
      .finally(() => {
        setRepoInfoLoading(false);
      });
  }, [open, cwd]);

  // Load CLI sessions when entering resume mode or switching backend
  const resumeBackend = backend === "codex" ? "codex" : ("claude" as const);
  useEffect(() => {
    if (!open || !resumeMode) return;
    setLoadingCliSessions(true);
    setSelectedCliSession("");
    api
      .listCliSessions(resumeBackend)
      .then(({ sessions }) => setCliSessions(sessions))
      .catch(() => setCliSessions([]))
      .finally(() => setLoadingCliSessions(false));
  }, [open, resumeMode, resumeBackend]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const displayModels =
    backend === "codex"
      ? MODELS.map((entry) =>
          entry.value === ""
            ? {
                ...entry,
                label: codexDefaultModel ? `Default (${codexDefaultModel})` : "Default",
              }
            : entry,
        )
      : MODELS;
  const selectedModel = displayModels.find((m) => m.value === model) || displayModels[0];

  const dirLabel = cwd ? cwd.split("/").pop() || cwd : "Select folder";

  async function handleCreate() {
    if (sending) return;

    setSending(true);
    setError("");
    setPullError("");

    // Branch freshness check
    if (gitRepoInfo) {
      const effectiveBranch = selectedBranch || gitRepoInfo.currentBranch;
      if (effectiveBranch && effectiveBranch === gitRepoInfo.currentBranch) {
        const branchInfo = branches.find((b) => b.name === effectiveBranch && !b.isRemote);
        if (branchInfo && branchInfo.behind > 0) {
          setSending(false);
          setPullPrompt({ behind: branchInfo.behind, branchName: effectiveBranch });
          return;
        }
      }
    }

    await doCreateSession();
  }

  async function doCreateSession() {
    const branchName = selectedBranch.trim() || (useWorktree ? gitRepoInfo?.currentBranch : undefined) || undefined;
    const cwdSnapshot = cwd;
    const permissionMode =
      backend === "codex" ? resolveCodexCliMode(mode, askPermission) : resolveClaudeCliMode(mode, askPermission);

    // Build creation opts (stored in pending session for retry)
    const createOpts = {
      model: backend === "codex" && model === "" ? codexDefaultModel || undefined : model,
      permissionMode,
      cwd: cwdSnapshot || undefined,
      envSlug: selectedEnv || undefined,
      branch: branchName,
      createBranch: branchName && isNewBranch ? true : undefined,
      useWorktree: useWorktree || undefined,
      backend,
      codexInternetAccess: backend === "codex" ? codexInternetAccess : undefined,
      codexReasoningEffort: backend === "codex" ? codexReasoningEffort || undefined : undefined,
      assistantMode: undefined,
      askPermission,
      role: sessionRole === "leader" ? ("orchestrator" as const) : undefined,
    };

    const defaultsGroupKey = (defaultsKey || gitRepoInfo?.repoRoot || cwdSnapshot || "").trim();
    if (defaultsGroupKey) {
      saveGroupNewSessionDefaults(defaultsGroupKey, {
        backend: backend as NewSessionBackend,
        model,
        mode,
        askPermission,
        sessionRole,
        envSlug: selectedEnv,
        cwd: cwdSnapshot,
        useWorktree,
        codexInternetAccess,
        codexReasoningEffort,
      });
    }

    saveLastSessionCreationContext({
      cwd: cwdSnapshot,
      treeGroupId: treeGroupId || undefined,
      newSessionDefaultsKey: defaultsGroupKey || undefined,
    });

    // Close modal and navigate to the pending session
    onClose();
    setSending(false);
    queuePendingSession({
      backend,
      createOpts,
      cwd: cwdSnapshot || null,
      treeGroupId: treeGroupId || undefined,
      recentDirsKey: defaultsKey || undefined,
    });
  }

  async function handlePullAndContinue() {
    setPulling(true);
    setPullError("");
    try {
      if (!gitRepoInfo) throw new Error("No repo info");
      await api.gitPull(gitRepoInfo.repoRoot);
      const refreshed = await api.listBranches(gitRepoInfo.repoRoot);
      setBranches(refreshed);
      setPullPrompt(null);
      await doCreateSession();
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setPullError(errMsg);
    } finally {
      setPulling(false);
    }
  }

  async function handleSkipPull() {
    setPullPrompt(null);
    setSending(true);
    await doCreateSession();
  }

  function handleCancelPull() {
    setPullPrompt(null);
    setPullError("");
    setSending(false);
  }

  const resumeSessionId = selectedCliSession || manualSessionId.trim();

  async function handleResume() {
    if (sending || !resumeSessionId) return;
    setSending(true);
    setError("");

    const createOpts = {
      backend,
      cwd: cwd || undefined,
      envSlug: selectedEnv || undefined,
      resumeCliSessionId: resumeSessionId,
      askPermission,
    };

    onClose();
    setSending(false);
    queuePendingSession({
      backend,
      createOpts,
      cwd: cwd || null,
      recentDirsKey: defaultsKey || undefined,
    });
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop — transparent click-away */}
      <div
        className="fixed inset-0 z-50"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* Popover card — anchored near the top-left, next to sidebar */}
        <div
          className="absolute left-[272px] top-2 bg-cc-card border border-cc-border rounded-2xl shadow-2xl w-[400px] max-w-[calc(100vw-2rem)] max-md:left-2 max-md:right-2 max-md:w-auto overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-cc-border">
            <h2 className="text-sm font-semibold text-cc-fg">{resumeMode ? "Resume Session" : "New Session"}</h2>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {resumeMode ? (
            /* ── Resume Mode UI ─────────────────────────────────── */
            <>
              <div className="px-5 py-4 space-y-3">
                {backends.length > 1 && (
                  <div>
                    <label className="text-[11px] text-cc-muted uppercase tracking-wider mb-1 block">Backend</label>
                    <div className="flex items-center bg-cc-hover/50 rounded-lg p-0.5">
                      {backends.map((b) => (
                        <button
                          key={b.id}
                          onClick={() => b.available && switchBackend(b.id as BackendType)}
                          disabled={!b.available}
                          title={b.available ? b.name : `${b.name} CLI not found in PATH`}
                          className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${
                            !b.available
                              ? "text-cc-muted/40 cursor-not-allowed"
                              : backend === b.id
                                ? "bg-cc-primary/15 text-cc-primary font-medium cursor-pointer"
                                : "text-cc-muted hover:text-cc-fg cursor-pointer"
                          }`}
                        >
                          {b.name}
                          {!b.available && (
                            <svg
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              className="w-3 h-3 text-cc-error/60"
                            >
                              <circle cx="8" cy="8" r="6" />
                              <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Manual session ID input */}
                <div>
                  <label className="text-[11px] text-cc-muted uppercase tracking-wider mb-1 block">Session ID</label>
                  <input
                    type="text"
                    value={manualSessionId}
                    onChange={(e) => {
                      setManualSessionId(e.target.value);
                      if (e.target.value.trim()) setSelectedCliSession("");
                    }}
                    placeholder="Paste a CLI session ID..."
                    className="w-full px-3 py-2 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                  />
                </div>

                {/* Recent CLI sessions list — server-filtered by selected backend */}
                <div>
                  <label className="text-[11px] text-cc-muted uppercase tracking-wider mb-1 block">
                    Recent Sessions
                  </label>
                  <div className="max-h-[240px] overflow-y-auto border border-cc-border rounded-lg">
                    {loadingCliSessions ? (
                      <div className="flex items-center justify-center py-6 gap-2">
                        <YarnBallSpinner className="w-4 h-4 text-cc-muted" />
                        <span className="text-xs text-cc-muted">Loading sessions...</span>
                      </div>
                    ) : cliSessions.length === 0 ? (
                      <div className="py-6 text-center text-xs text-cc-muted">
                        No {resumeBackend === "codex" ? "Codex" : "Claude Code"} CLI sessions found
                      </div>
                    ) : (
                      cliSessions.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => {
                            setSelectedCliSession(s.id);
                            setManualSessionId("");
                            if (s.cwd) setCwd(s.cwd);
                          }}
                          className={`w-full px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer border-b border-cc-border last:border-b-0 ${
                            selectedCliSession === s.id ? "bg-cc-primary/10" : ""
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-cc-fg truncate">
                              {s.slug || s.id.slice(0, 8)}
                            </span>
                            {s.gitBranch && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code shrink-0">
                                {s.gitBranch}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {s.cwd && (
                              <span className="text-[10px] text-cc-muted font-mono-code truncate">{s.cwd}</span>
                            )}
                            <span className="text-[10px] text-cc-muted ml-auto shrink-0">
                              {new Date(s.lastModified).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>

                {/* Optional folder + env overrides */}
                <div className="flex items-center gap-1 flex-wrap">
                  <div>
                    <button
                      onClick={() => setShowFolderPicker(true)}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                        <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                      </svg>
                      <span className="max-w-[120px] truncate font-mono-code">{dirLabel}</span>
                    </button>
                    {showFolderPicker && (
                      <FolderPicker
                        initialPath={cwd || ""}
                        recentDirsKey={defaultsKey || undefined}
                        onSelect={(path) => {
                          setCwd(path);
                        }}
                        onClose={() => setShowFolderPicker(false)}
                      />
                    )}
                  </div>
                  <div className="relative" ref={envDropdownRef}>
                    <button
                      onClick={() => {
                        if (!showEnvDropdown) {
                          api
                            .listEnvs()
                            .then(setEnvs)
                            .catch(() => {});
                        }
                        setShowEnvDropdown(!showEnvDropdown);
                      }}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                        <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
                      </svg>
                      <span className="max-w-[120px] truncate">
                        {selectedEnv ? envs.find((e) => e.slug === selectedEnv)?.name || "Env" : "No env"}
                      </span>
                    </button>
                    {showEnvDropdown && (
                      <div className="absolute left-0 top-full mt-1 w-56 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                        <button
                          onClick={() => {
                            setSelectedEnv("");
                            persistGlobalDefault("cc-selected-env", "");
                            setShowEnvDropdown(false);
                          }}
                          className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${!selectedEnv ? "text-cc-primary font-medium" : "text-cc-fg"}`}
                        >
                          No environment
                        </button>
                        {envs.map((env) => (
                          <button
                            key={env.slug}
                            onClick={() => {
                              setSelectedEnv(env.slug);
                              persistGlobalDefault("cc-selected-env", env.slug);
                              setShowEnvDropdown(false);
                            }}
                            className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${env.slug === selectedEnv ? "text-cc-primary font-medium" : "text-cc-fg"}`}
                          >
                            {env.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Error message */}
                {error && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-error/5 border border-cc-error/20">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-error shrink-0">
                      <path
                        fillRule="evenodd"
                        d="M8 15A7 7 0 108 1a7 7 0 000 14zm1-3a1 1 0 11-2 0 1 1 0 012 0zM7.5 5.5a.5.5 0 011 0v3a.5.5 0 01-1 0v-3z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <p className="text-xs text-cc-error">{error}</p>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-cc-border space-y-2">
                <button
                  onClick={handleResume}
                  disabled={sending || !resumeSessionId}
                  className="w-full py-2.5 px-4 text-sm font-medium rounded-xl bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {sending ? (
                    <>
                      <YarnBallSpinner className="w-4 h-4 text-white" />
                      Resuming...
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M4 2l10 6-10 6z" />
                      </svg>
                      Resume Session
                    </>
                  )}
                </button>
                <button
                  onClick={() => {
                    setResumeMode(false);
                    setError("");
                  }}
                  className="w-full py-1.5 text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                >
                  Back to new session
                </button>
              </div>
            </>
          ) : (
            /* ── Normal Mode UI ───────────────────────────────────── */
            <>
              {/* Config selectors */}
              <div className="px-5 py-4 space-y-3">
                {/* Row 1: Backend toggle + Mode selector */}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Backend toggle */}
                  {backends.length > 1 && (
                    <div className="flex items-center bg-cc-hover/50 rounded-lg p-0.5">
                      {backends.map((b) => (
                        <button
                          key={b.id}
                          onClick={() => b.available && switchBackend(b.id as BackendType)}
                          disabled={!b.available}
                          title={b.available ? b.name : `${b.name} CLI not found in PATH`}
                          className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${
                            !b.available
                              ? "text-cc-muted/40 cursor-not-allowed"
                              : backend === b.id
                                ? "bg-cc-primary/15 text-cc-primary font-medium cursor-pointer"
                                : "text-cc-muted hover:text-cc-fg cursor-pointer"
                          }`}
                        >
                          {b.name}
                          {!b.available && (
                            <svg
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              className="w-3 h-3 text-cc-error/60"
                            >
                              <circle cx="8" cy="8" r="6" />
                              <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Mode selector: shared Plan/Agent + Ask toggle */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center bg-cc-hover/50 rounded-lg p-0.5">
                      <button
                        onClick={() => updateMode("plan")}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer select-none ${
                          mode === "plan" ? "bg-cc-primary/15 text-cc-primary" : "text-cc-muted hover:text-cc-fg"
                        }`}
                        title="Plan mode: agent creates a plan before executing"
                      >
                        Plan
                      </button>
                      <button
                        onClick={() => updateMode("agent")}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer select-none ${
                          mode === "agent" ? "bg-cc-primary/15 text-cc-primary" : "text-cc-muted hover:text-cc-fg"
                        }`}
                        title="Agent mode: executes tools directly"
                      >
                        Agent
                      </button>
                    </div>

                    <button
                      onClick={() => {
                        const next = !askPermission;
                        setAskPermission(next);
                        persistGlobalDefault("cc-ask-permission", String(next));
                      }}
                      className="flex items-center justify-center w-7 h-7 rounded-md transition-colors cursor-pointer select-none hover:bg-cc-hover"
                      title={
                        askPermission ? "Permissions: will ask before tool use" : "Permissions: auto-approving tool use"
                      }
                    >
                      {askPermission ? (
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-primary">
                          <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                          <path
                            d="M6.5 8.5L7.5 9.5L10 7"
                            stroke="white"
                            strokeWidth="1.5"
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          className="w-4 h-4 text-cc-muted"
                        >
                          <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {/* Row 2: Folder + Worktree + Branch + Leader */}
                <div className="flex items-center gap-1 flex-wrap">
                  {/* Codex internet access toggle */}
                  {backend === "codex" && (
                    <>
                      <button
                        onClick={() => {
                          const next = !codexInternetAccess;
                          setCodexInternetAccess(next);
                          persistGlobalDefault("cc-codex-internet-access", next ? "1" : "0");
                        }}
                        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                          codexInternetAccess
                            ? "bg-cc-primary/15 text-cc-primary font-medium"
                            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                        }`}
                        title="Allow Codex internet/network access for this session"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-70">
                          <path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1.5c.8 0 1.55.22 2.2.61-.39.54-.72 1.21-.95 1.98H6.75c-.23-.77-.56-1.44-.95-1.98A4.47 4.47 0 018 3.5zm-3.2 1.3c.3.4.57.86.78 1.37H3.83c.24-.53.57-1.01.97-1.37zm-.97 2.87h2.15c.07.44.12.9.12 1.38 0 .48-.05.94-.12 1.38H3.83A4.56 4.56 0 013.5 9c0-.47.12-.92.33-1.33zm2.03 4.08c.39-.54.72-1.21.95-1.98h2.38c.23.77.56 1.44.95 1.98A4.47 4.47 0 018 12.5c-.8 0-1.55-.22-2.2-.61zm4.34-1.37c.07-.44.12-.9.12-1.38 0-.48-.05-.94-.12-1.38h2.15c.21.41.33.86.33 1.33 0 .47-.12.92-.33 1.33H10.2zm1.37-3.58h-1.75c-.21-.51-.48-.97-.78-1.37.4.36.73.84.97 1.37z" />
                        </svg>
                        <span>Internet</span>
                      </button>

                      <div className="relative" ref={reasoningDropdownRef}>
                        <button
                          onClick={() => setShowReasoningDropdown(!showReasoningDropdown)}
                          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                          title="Codex reasoning effort"
                        >
                          <span>
                            reasoning:
                            {CODEX_REASONING_EFFORTS.find(
                              (x) => x.value === codexReasoningEffort,
                            )?.label.toLowerCase() || "default"}
                          </span>
                          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                            <path d="M4 6l4 4 4-4" />
                          </svg>
                        </button>
                        {showReasoningDropdown && (
                          <div className="absolute left-0 top-full mt-1 w-40 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                            {CODEX_REASONING_EFFORTS.map((effort) => (
                              <button
                                key={effort.value || "default"}
                                onClick={() => {
                                  setCodexReasoningEffort(effort.value);
                                  persistGlobalDefault("cc-codex-reasoning-effort", effort.value);
                                  setShowReasoningDropdown(false);
                                }}
                                className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                                  effort.value === codexReasoningEffort ? "text-cc-primary font-medium" : "text-cc-fg"
                                }`}
                              >
                                {effort.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {/* Folder selector */}
                  <div>
                    <button
                      onClick={() => setShowFolderPicker(true)}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                        <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                      </svg>
                      <span className="max-w-[120px] truncate font-mono-code">{dirLabel}</span>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    </button>
                    {showFolderPicker && (
                      <FolderPicker
                        initialPath={cwd || ""}
                        recentDirsKey={defaultsKey || undefined}
                        onSelect={(path) => {
                          setCwd(path);
                        }}
                        onClose={() => setShowFolderPicker(false)}
                      />
                    )}
                  </div>

                  {/* Worktree toggle -- disabled for leader sessions (leaders don't use worktrees) */}
                  {(gitRepoInfo || repoInfoLoading || useWorktree) && (
                    <button
                      onClick={() => {
                        if (sessionRole === "leader") return;
                        const next = !useWorktree;
                        setUseWorktree(next);
                        persistGlobalDefault("cc-worktree", String(next));
                      }}
                      disabled={sessionRole === "leader"}
                      className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
                        sessionRole === "leader"
                          ? "opacity-40 cursor-not-allowed text-cc-muted"
                          : useWorktree
                            ? "bg-cc-primary/15 text-cc-primary font-medium cursor-pointer"
                            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                      }`}
                      title={
                        sessionRole === "leader"
                          ? "Leader sessions don't use worktrees"
                          : repoInfoLoading
                            ? "Worktree metadata is loading"
                            : "Create an isolated worktree for this session"
                      }
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-70">
                        <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                      </svg>
                      <span>Worktree</span>
                    </button>
                  )}

                  {/* Branch picker — only shown for worktree sessions where the branch determines
                  which ref the worktree is created from. Non-worktree sessions work directly
                  in the repo and the agent can checkout any branch. */}
                  {gitRepoInfo && useWorktree && (
                    <div className="relative" ref={branchDropdownRef}>
                      <button
                        onClick={() => {
                          if (!showBranchDropdown && gitRepoInfo) {
                            api
                              .gitFetch(gitRepoInfo.repoRoot)
                              .catch(() => {})
                              .finally(() => {
                                api
                                  .listBranches(gitRepoInfo.repoRoot)
                                  .then(setBranches)
                                  .catch(() => setBranches([]));
                              });
                          }
                          setShowBranchDropdown(!showBranchDropdown);
                          setBranchFilter("");
                        }}
                        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60">
                          <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.378A2.5 2.5 0 007.5 8h1a1 1 0 010 2h-1A2.5 2.5 0 005 12.5v.128a2.25 2.25 0 101.5 0V12.5a1 1 0 011-1h1a2.5 2.5 0 000-5h-1a1 1 0 01-1-1V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                        </svg>
                        <span className="max-w-[100px] truncate font-mono-code">
                          {selectedBranch || gitRepoInfo.currentBranch}
                        </span>
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                          <path d="M4 6l4 4 4-4" />
                        </svg>
                      </button>
                      {showBranchDropdown && (
                        <div className="absolute left-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 overflow-hidden">
                          <div className="px-2 py-2 border-b border-cc-border">
                            <input
                              type="text"
                              value={branchFilter}
                              onChange={(e) => setBranchFilter(e.target.value)}
                              placeholder="Filter or create branch..."
                              className="w-full px-2 py-1 text-base sm:text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  setShowBranchDropdown(false);
                                }
                              }}
                            />
                          </div>
                          <div className="max-h-[240px] overflow-y-auto py-1">
                            {(() => {
                              const filter = branchFilter.toLowerCase().trim();
                              const localBranches = branches.filter(
                                (b) => !b.isRemote && (!filter || b.name.toLowerCase().includes(filter)),
                              );
                              const remoteBranches = branches.filter(
                                (b) => b.isRemote && (!filter || b.name.toLowerCase().includes(filter)),
                              );
                              const exactMatch = branches.some((b) => b.name.toLowerCase() === filter);
                              const hasResults = localBranches.length > 0 || remoteBranches.length > 0;

                              return (
                                <>
                                  {localBranches.length > 0 && (
                                    <>
                                      <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider">
                                        Local
                                      </div>
                                      {localBranches.map((b) => (
                                        <button
                                          key={b.name}
                                          onClick={() => {
                                            setSelectedBranch(b.name);
                                            setIsNewBranch(false);
                                            if (gitRepoInfo) saveBranch(gitRepoInfo.repoRoot, b.name);
                                            setShowBranchDropdown(false);
                                          }}
                                          className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                            b.name === selectedBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                          }`}
                                        >
                                          <span className="truncate font-mono-code">{b.name}</span>
                                          <span className="ml-auto flex items-center gap-1.5 shrink-0">
                                            {b.ahead > 0 && (
                                              <span className="text-[9px] text-green-500">{b.ahead}&#8593;</span>
                                            )}
                                            {b.behind > 0 && (
                                              <span className="text-[9px] text-amber-500">{b.behind}&#8595;</span>
                                            )}
                                            {b.worktreePath && (
                                              <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400">
                                                wt
                                              </span>
                                            )}
                                            {b.isCurrent && (
                                              <span className="text-[9px] px-1 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400">
                                                current
                                              </span>
                                            )}
                                          </span>
                                        </button>
                                      ))}
                                    </>
                                  )}
                                  {remoteBranches.length > 0 && (
                                    <>
                                      <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider mt-1">
                                        Remote
                                      </div>
                                      {remoteBranches.map((b) => (
                                        <button
                                          key={`remote-${b.name}`}
                                          onClick={() => {
                                            setSelectedBranch(b.name);
                                            setIsNewBranch(false);
                                            if (gitRepoInfo) saveBranch(gitRepoInfo.repoRoot, b.name);
                                            setShowBranchDropdown(false);
                                          }}
                                          className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                            b.name === selectedBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                          }`}
                                        >
                                          <span className="truncate font-mono-code">{b.name}</span>
                                          <span className="text-[9px] px-1 py-0.5 rounded bg-cc-hover text-cc-muted ml-auto shrink-0">
                                            remote
                                          </span>
                                        </button>
                                      ))}
                                    </>
                                  )}
                                  {!hasResults && filter && (
                                    <div className="px-3 py-2 text-xs text-cc-muted text-center">
                                      No matching branches
                                    </div>
                                  )}
                                  {filter && !exactMatch && (
                                    <div className="border-t border-cc-border mt-1 pt-1">
                                      <button
                                        onClick={() => {
                                          const name = branchFilter.trim();
                                          setSelectedBranch(name);
                                          setIsNewBranch(true);
                                          if (gitRepoInfo) saveBranch(gitRepoInfo.repoRoot, name);
                                          setShowBranchDropdown(false);
                                        }}
                                        className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-primary"
                                      >
                                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
                                          <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
                                        </svg>
                                        <span>
                                          Create{" "}
                                          <span className="font-mono-code font-medium">{branchFilter.trim()}</span>
                                        </span>
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

                  {/* Leader role toggle -- toggling leader on disables worktree */}
                  <button
                    onClick={() => {
                      const nextRole = sessionRole === "leader" ? "worker" : "leader";
                      setSessionRole(nextRole);
                      if (nextRole === "leader") {
                        setUseWorktree(false);
                      }
                    }}
                    className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                      sessionRole === "leader"
                        ? "bg-cc-primary/15 text-cc-primary font-medium"
                        : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                    }`}
                    title="Leader session: gets TAKODE_ROLE and TAKODE_API_PORT env vars for cross-session coordination"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-70">
                      <path d="M8 2a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM3.5 5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12.5 5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM8 4.5v2M5 7.5L7 6M11 7.5L9 6M3.5 8v2.5a1 1 0 001 1h7a1 1 0 001-1V8" />
                    </svg>
                    <span>Leader</span>
                  </button>
                </div>

                {/* Row 3: Env + Model */}
                <div className="flex items-center gap-1 flex-wrap">
                  {/* Environment selector */}
                  <div className="relative" ref={envDropdownRef}>
                    <button
                      onClick={() => {
                        if (!showEnvDropdown) {
                          api
                            .listEnvs()
                            .then(setEnvs)
                            .catch(() => {});
                        }
                        setShowEnvDropdown(!showEnvDropdown);
                      }}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                        <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
                      </svg>
                      <span className="max-w-[120px] truncate">
                        {selectedEnv ? envs.find((e) => e.slug === selectedEnv)?.name || "Env" : "No env"}
                      </span>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    </button>
                    {showEnvDropdown && (
                      <div className="absolute left-0 top-full mt-1 w-56 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                        <button
                          onClick={() => {
                            setSelectedEnv("");
                            persistGlobalDefault("cc-selected-env", "");
                            setShowEnvDropdown(false);
                          }}
                          className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                            !selectedEnv ? "text-cc-primary font-medium" : "text-cc-fg"
                          }`}
                        >
                          No environment
                        </button>
                        {envs.map((env) => (
                          <button
                            key={env.slug}
                            onClick={() => {
                              setSelectedEnv(env.slug);
                              persistGlobalDefault("cc-selected-env", env.slug);
                              setShowEnvDropdown(false);
                            }}
                            className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-1 ${
                              env.slug === selectedEnv ? "text-cc-primary font-medium" : "text-cc-fg"
                            }`}
                          >
                            <span className="truncate">{env.name}</span>
                            <span className="text-cc-muted ml-auto shrink-0">
                              {Object.keys(env.variables).length} var
                              {Object.keys(env.variables).length !== 1 ? "s" : ""}
                            </span>
                          </button>
                        ))}
                        <div className="border-t border-cc-border mt-1 pt-1">
                          <button
                            onClick={() => {
                              setShowEnvManager(true);
                              setShowEnvDropdown(false);
                            }}
                            className="w-full px-3 py-2 text-xs text-left text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                          >
                            Manage environments...
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Model selector */}
                  <div className="relative" ref={modelDropdownRef}>
                    <button
                      onClick={() => setShowModelDropdown(!showModelDropdown)}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
                    >
                      <span>{selectedModel.icon}</span>
                      <span>{selectedModel.label}</span>
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    </button>
                    {showModelDropdown && (
                      <div className="absolute left-0 top-full mt-1 w-48 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
                        {displayModels.map((m) => (
                          <button
                            key={m.value}
                            onClick={() => {
                              setModel(m.value);
                              persistGlobalDefault(`cc-model-${backend}`, m.value);
                              setShowModelDropdown(false);
                            }}
                            className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                              m.value === model ? "text-cc-primary font-medium" : "text-cc-fg"
                            }`}
                          >
                            <span>{m.icon}</span>
                            {m.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Branch behind remote warning */}
                {pullPrompt && (
                  <div className="p-3 rounded-[10px] bg-amber-500/10 border border-amber-500/20">
                    <div className="flex items-start gap-2.5">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-amber-500 shrink-0 mt-0.5">
                        <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-cc-fg leading-snug">
                          <span className="font-mono-code font-medium">{pullPrompt.branchName}</span> is{" "}
                          <span className="font-semibold text-amber-500">
                            {pullPrompt.behind} commit{pullPrompt.behind !== 1 ? "s" : ""} behind
                          </span>{" "}
                          remote. Pull before starting?
                        </p>
                        {pullError && (
                          <div className="mt-2 px-2 py-1.5 rounded-md bg-cc-error/10 border border-cc-error/20 text-[11px] text-cc-error font-mono-code whitespace-pre-wrap">
                            {pullError}
                          </div>
                        )}
                        <div className="flex gap-2 mt-2.5">
                          <button
                            onClick={handleCancelPull}
                            disabled={pulling}
                            className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSkipPull}
                            disabled={pulling}
                            className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                          >
                            Continue anyway
                          </button>
                          <button
                            onClick={handlePullAndContinue}
                            disabled={pulling}
                            className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25 transition-colors cursor-pointer flex items-center gap-1.5"
                          >
                            {pulling ? (
                              <>
                                <YarnBallSpinner className="w-3 h-3 text-cc-primary" />
                                Pulling...
                              </>
                            ) : (
                              "Pull and continue"
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Error message */}
                {error && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-error/5 border border-cc-error/20">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-error shrink-0">
                      <path
                        fillRule="evenodd"
                        d="M8 15A7 7 0 108 1a7 7 0 000 14zm1-3a1 1 0 11-2 0 1 1 0 012 0zM7.5 5.5a.5.5 0 011 0v3a.5.5 0 01-1 0v-3z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <p className="text-xs text-cc-error">{error}</p>
                  </div>
                )}
              </div>

              {/* Footer with Create button */}
              <div className="px-5 py-4 border-t border-cc-border space-y-2">
                <button
                  onClick={handleCreate}
                  disabled={sending}
                  className="w-full py-2.5 px-4 text-sm font-medium rounded-xl bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {sending ? (
                    <>
                      <YarnBallSpinner className="w-4 h-4 text-white" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="w-3.5 h-3.5"
                      >
                        <path d="M8 3v10M3 8h10" />
                      </svg>
                      Create Session
                    </>
                  )}
                </button>
                <button
                  onClick={() => {
                    setResumeMode(true);
                    setError("");
                  }}
                  className="w-full py-1.5 text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                >
                  Resume from an existing CLI session
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Environment manager modal */}
      {showEnvManager && (
        <EnvManager
          onClose={() => {
            setShowEnvManager(false);
            api
              .listEnvs()
              .then(setEnvs)
              .catch(() => {});
          }}
        />
      )}
    </>
  );
}
