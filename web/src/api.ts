import type { SdkSessionInfo } from "./types.js";

const BASE = "/api";

async function post<T = unknown>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function get<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(res.statusText);
  }
  return res.json();
}

async function put<T = unknown>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function patch<T = unknown>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function del<T = unknown>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ContainerCreateOpts {
  image?: string;
  ports?: number[];
  volumes?: string[];
  env?: Record<string, string>;
}

export interface ContainerStatus {
  available: boolean;
  version: string | null;
}

export interface CloudProviderPlan {
  provider: "modal";
  sessionId: string;
  image: string;
  cwd: string;
  mappedPorts: Array<{ containerPort: number; hostPort: number }>;
  commandPreview: string;
}

export interface CreateSessionOpts {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  codexInternetAccess?: boolean;
  allowedTools?: string[];
  envSlug?: string;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  backend?: "claude" | "codex";
  container?: ContainerCreateOpts;
  assistantMode?: boolean;
  askPermission?: boolean;
  /** CLI session ID to resume (from an external CLI session, e.g. VS Code or terminal) */
  resumeCliSessionId?: string;
}

export interface CliSession {
  id: string;
  cwd: string | null;
  slug: string | null;
  gitBranch: string | null;
  lastModified: number;
  sizeBytes: number;
}

export interface BackendInfo {
  id: string;
  name: string;
  available: boolean;
}

export interface BackendModelInfo {
  value: string;
  label: string;
  description: string;
}

export interface GitRepoInfo {
  repoRoot: string;
  repoName: string;
  currentBranch: string;
  defaultBranch: string;
  isWorktree: boolean;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  worktreePath: string | null;
  ahead: number;
  behind: number;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
  isDirty: boolean;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  branch: string;
  isNew: boolean;
}

export interface CompanionEnv {
  name: string;
  slug: string;
  variables: Record<string, string>;
  dockerfile?: string;
  imageTag?: string;
  baseImage?: string;
  buildStatus?: "idle" | "building" | "success" | "error";
  buildError?: string;
  lastBuiltAt?: number;
  ports?: number[];
  volumes?: string[];
  initScript?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListResult {
  path: string;
  dirs: DirEntry[];
  home: string;
  error?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export interface UsageLimits {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

export interface AppSettings {
  serverName: string;
  serverId: string;
  pushoverConfigured: boolean;
  pushoverEnabled: boolean;
  pushoverDelaySeconds: number;
  pushoverBaseUrl: string;
  claudeBinary: string;
  codexBinary: string;
  maxKeepAlive: number;
  autoApprovalEnabled: boolean;
  autoApprovalModel: string;
  restartSupported: boolean;
}

// ─── Auto-Approval Types ─────────────────────────────────────────────────────

export interface AutoApprovalConfig {
  projectPath: string;
  label: string;
  slug: string;
  criteria: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AutoApprovalLogIndexEntry {
  id: number;
  sessionId: string;
  timestamp: number;
  toolName: string;
  parsed: { decision: string; reason: string } | null;
  projectPath: string;
  durationMs: number;
  promptLength: number;
}

export interface AutoApprovalLogEntry extends AutoApprovalLogIndexEntry {
  systemPrompt: string;
  prompt: string;
  rawResponse: string | null;
}

export interface GitHubPRInfo {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: { name: string; status: string; conclusion: string | null }[];
  checksSummary: { total: number; success: number; failure: number; pending: number };
  reviewThreads: { total: number; resolved: number; unresolved: number };
}

export interface PRStatusResponse {
  available: boolean;
  pr: GitHubPRInfo | null;
}

export interface CronJobInfo {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  recurring: boolean;
  backendType: "claude" | "codex";
  model: string;
  cwd: string;
  envSlug?: string;
  enabled: boolean;
  permissionMode: string;
  codexInternetAccess?: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  consecutiveFailures: number;
  totalRuns: number;
  nextRunAt?: number | null;
}

export interface CronJobExecution {
  sessionId: string;
  jobId: string;
  startedAt: number;
  completedAt?: number;
  success?: boolean;
  error?: string;
  costUsd?: number;
}

// ─── Namer Log Types ────────────────────────────────────────────────────────

export interface NamerLogIndexEntry {
  id: number;
  sessionId: string;
  timestamp: number;
  parsed: { action: string; title?: string } | null;
  currentName: string | null;
  durationMs: number;
  promptLength: number;
}

export interface NamerLogEntry extends NamerLogIndexEntry {
  systemPrompt: string;
  prompt: string;
  rawResponse: string | null;
}

// ─── SSE Session Creation ────────────────────────────────────────────────────

export interface CreationProgressEvent {
  step: string;
  label: string;
  status: "in_progress" | "done" | "error";
  detail?: string;
}

export interface CreateSessionStreamResult {
  sessionId: string;
  state: string;
  cwd: string;
}

/**
 * Create a session with real-time progress streaming via SSE.
 * Uses fetch + ReadableStream (EventSource is GET-only, this is POST).
 */
export async function createSessionStream(
  opts: CreateSessionOpts | undefined,
  onProgress: (progress: CreationProgressEvent) => void,
): Promise<CreateSessionStreamResult> {
  const res = await fetch(`${BASE}/sessions/create-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CreateSessionStreamResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events: split on double newlines
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      let eventType = "";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (!data) continue;

      const parsed = JSON.parse(data);
      if (eventType === "progress") {
        onProgress(parsed as CreationProgressEvent);
      } else if (eventType === "done") {
        result = parsed as CreateSessionStreamResult;
      } else if (eventType === "error") {
        throw new Error((parsed as { error: string }).error || "Session creation failed");
      }
    }
  }

  if (!result) {
    throw new Error("Stream ended without session creation result");
  }

  return result;
}

export const api = {
  createSession: (opts?: CreateSessionOpts) =>
    post<{ sessionId: string; state: string; cwd: string }>(
      "/sessions/create",
      opts,
    ),

  listSessions: () => get<SdkSessionInfo[]>("/sessions"),

  killSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/kill`),

  deleteSession: (sessionId: string) =>
    del(`/sessions/${encodeURIComponent(sessionId)}`),

  relaunchSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/relaunch`),

  forceCompact: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/force-compact`),

  revertToMessage: (sessionId: string, messageId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/revert`, { messageId }),

  archiveSession: (sessionId: string, opts?: { force?: boolean }) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/archive`, opts),

  unarchiveSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/unarchive`),

  getToolResult: (sessionId: string, toolUseId: string) =>
    get<{ content: string; is_error: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/tool-result/${encodeURIComponent(toolUseId)}`,
    ),

  renameSession: (sessionId: string, name: string) =>
    patch<{ ok: boolean; name: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/name`,
      { name },
    ),

  markSessionRead: (sessionId: string) =>
    patch<{ ok: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/read`,
    ),

  markSessionUnread: (sessionId: string) =>
    patch<{ ok: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/unread`,
    ),

  markAllSessionsRead: () =>
    post<{ ok: boolean }>("/sessions/mark-all-read"),

  setDiffBase: (sessionId: string, branch: string) =>
    patch<{ ok: boolean; diff_base_branch: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/diff-base`,
      { branch },
    ),

  listDirs: (path?: string) =>
    get<DirListResult>(
      `/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

  getHome: () => get<{ home: string; cwd: string }>("/fs/home"),

  // Environments
  listEnvs: () => get<CompanionEnv[]>("/envs"),
  getEnv: (slug: string) =>
    get<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`),
  createEnv: (name: string, variables: Record<string, string>, docker?: {
    dockerfile?: string;
    baseImage?: string;
    ports?: number[];
    volumes?: string[];
    initScript?: string;
  }) =>
    post<CompanionEnv>("/envs", { name, variables, ...docker }),
  updateEnv: (
    slug: string,
    data: {
      name?: string;
      variables?: Record<string, string>;
      dockerfile?: string;
      baseImage?: string;
      ports?: number[];
      volumes?: string[];
      initScript?: string;
    },
  ) => put<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`, data),
  deleteEnv: (slug: string) => del(`/envs/${encodeURIComponent(slug)}`),

  // Environment Docker builds
  buildEnvImage: (slug: string) =>
    post<{ ok: boolean; imageTag: string }>(`/envs/${encodeURIComponent(slug)}/build`),
  getEnvBuildStatus: (slug: string) =>
    get<{ buildStatus: string; buildError?: string; lastBuiltAt?: number; imageTag?: string }>(
      `/envs/${encodeURIComponent(slug)}/build-status`,
    ),
  buildBaseImage: () =>
    post<{ ok: boolean; tag: string }>("/docker/build-base"),
  getBaseImageStatus: () =>
    get<{ exists: boolean; tag: string }>("/docker/base-image"),

  // Server control
  restartServer: () => post<{ ok: boolean }>("/server/restart", {}),

  // Settings
  getSettings: () => get<AppSettings>("/settings"),
  updateSettings: (data: {
    serverName?: string;
    pushoverUserKey?: string; pushoverApiToken?: string; pushoverDelaySeconds?: number;
    pushoverEnabled?: boolean; pushoverBaseUrl?: string;
    claudeBinary?: string; codexBinary?: string;
    maxKeepAlive?: number;
    autoApprovalEnabled?: boolean; autoApprovalModel?: string;
  }) => put<AppSettings>("/settings", data),
  testBinary: (binary: string) =>
    post<{ ok: boolean; resolvedPath?: string; version?: string }>("/settings/test-binary", { binary }),
  testPushover: () => post<{ ok: boolean }>("/pushover/test"),

  // Git operations
  getRepoInfo: (path: string) =>
    get<GitRepoInfo>(`/git/repo-info?path=${encodeURIComponent(path)}`),
  listBranches: (repoRoot: string) =>
    get<GitBranchInfo[]>(
      `/git/branches?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  getRecentCommits: (repoRoot: string, limit = 20) =>
    get<{ commits: { sha: string; shortSha: string; message: string; timestamp: number }[] }>(
      `/git/commits?repoRoot=${encodeURIComponent(repoRoot)}&limit=${limit}`,
    ),
  gitFetch: (repoRoot: string) =>
    post<{ success: boolean; output: string }>("/git/fetch", { repoRoot }),
  gitPull: (cwd: string, sessionId?: string) =>
    post<{
      success: boolean;
      output: string;
      git_ahead: number;
      git_behind: number;
    }>("/git/pull", { cwd, sessionId }),

  // Git worktrees
  listWorktrees: (repoRoot: string) =>
    get<GitWorktreeInfo[]>(
      `/git/worktrees?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  createWorktree: (
    repoRoot: string,
    branch: string,
    opts?: { baseBranch?: string; createBranch?: boolean },
  ) =>
    post<WorktreeCreateResult>("/git/worktree", {
      repoRoot,
      branch,
      ...opts,
    }),
  removeWorktree: (repoRoot: string, worktreePath: string, force?: boolean) =>
    del("/git/worktree", { repoRoot, worktreePath, force }),

  // GitHub PR status
  getPRStatus: (cwd: string, branch: string) =>
    get<PRStatusResponse>(
      `/git/pr-status?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}`,
    ),

  // Backends
  getBackends: () => get<BackendInfo[]>("/backends"),
  getBackendModels: (backendId: string) =>
    get<BackendModelInfo[]>(`/backends/${encodeURIComponent(backendId)}/models`),

  // Containers
  getContainerStatus: () => get<ContainerStatus>("/containers/status"),
  getContainerImages: () => get<string[]>("/containers/images"),
  getCloudProviderPlan: (provider: "modal", cwd: string, sessionId: string) =>
    get<CloudProviderPlan>(
      `/cloud/providers/${encodeURIComponent(provider)}/plan?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`,
    ),

  // Editor
  startEditor: (sessionId: string) =>
    post<{ url: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/editor/start`,
    ),

  // Editor filesystem
  getFileTree: (path: string) =>
    get<{ path: string; tree: TreeNode[] }>(
      `/fs/tree?path=${encodeURIComponent(path)}`,
    ),
  readFile: (path: string) =>
    get<{ path: string; content: string }>(
      `/fs/read?path=${encodeURIComponent(path)}`,
    ),
  getFsImageUrl: (path: string) =>
    `${BASE}/fs/image?path=${encodeURIComponent(path)}`,
  writeFile: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/write", { path, content }),
  getFileDiff: (path: string, base?: string) => {
    let url = `/fs/diff?path=${encodeURIComponent(path)}`;
    if (base) url += `&base=${encodeURIComponent(base)}`;
    return get<{ path: string; diff: string; baseBranch?: string }>(url);
  },
  getDiffStats: (files: string[], repoRoot: string, base?: string) =>
    post<{ stats: Record<string, { additions: number; deletions: number }>; baseBranch?: string }>(
      "/fs/diff-stats",
      { files, repoRoot, base: base || undefined },
    ),
  getClaudeMdFiles: (cwd: string) =>
    get<{ cwd: string; files: { path: string; content: string; writable?: boolean }[] }>(
      `/fs/claude-md?cwd=${encodeURIComponent(cwd)}`,
    ),
  saveClaudeMd: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/claude-md", { path, content }),

  // Audio transcription
  transcribe: async (audio: Blob, backend?: "gemini" | "openai"): Promise<{ text: string; backend: string }> => {
    const form = new FormData();
    form.append("audio", audio, "recording.webm");
    if (backend) form.append("backend", backend);
    const res = await fetch(`${BASE}/transcribe`, { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error || res.statusText);
    }
    return res.json();
  },

  getTranscriptionStatus: () =>
    get<{ backends: string[]; default: string | null }>("/transcribe/status"),

  // Usage limits
  getUsageLimits: () => get<UsageLimits>("/usage-limits"),
  getSessionUsageLimits: (sessionId: string) =>
    get<UsageLimits>(`/sessions/${encodeURIComponent(sessionId)}/usage-limits`),

  // Terminal
  spawnTerminal: (cwd: string, cols?: number, rows?: number) =>
    post<{ terminalId: string }>("/terminal/spawn", { cwd, cols, rows }),
  killTerminal: () =>
    post<{ ok: boolean }>("/terminal/kill"),
  getTerminal: () =>
    get<{ active: boolean; terminalId?: string; cwd?: string }>("/terminal"),

  // Cron jobs
  listCronJobs: () => get<CronJobInfo[]>("/cron/jobs"),
  getCronJob: (id: string) => get<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`),
  createCronJob: (data: Partial<CronJobInfo>) => post<CronJobInfo>("/cron/jobs", data),
  updateCronJob: (id: string, data: Partial<CronJobInfo>) =>
    put<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`, data),
  deleteCronJob: (id: string) => del(`/cron/jobs/${encodeURIComponent(id)}`),
  toggleCronJob: (id: string) => post<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}/toggle`),
  runCronJob: (id: string) => post(`/cron/jobs/${encodeURIComponent(id)}/run`),
  getCronJobExecutions: (id: string) =>
    get<CronJobExecution[]>(`/cron/jobs/${encodeURIComponent(id)}/executions`),

  // Cross-session messaging
  sendSessionMessage: (sessionId: string, content: string) =>
    post<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/message`, { content }),

  // Namer debug logs
  getNamerLogs: () =>
    get<NamerLogIndexEntry[]>("/namer-logs"),
  getNamerLogEntry: (id: number) =>
    get<NamerLogEntry>(`/namer-logs/${id}`),

  // Auto-Approval configs
  getAutoApprovalConfigs: () =>
    get<AutoApprovalConfig[]>("/auto-approval/configs"),
  getAutoApprovalConfig: (slug: string) =>
    get<AutoApprovalConfig>(`/auto-approval/configs/${encodeURIComponent(slug)}`),
  /** Find the matching auto-approval config for a given cwd (longest prefix match).
   *  Pass repoRoot for worktree sessions whose cwd differs from the main repo. */
  getAutoApprovalConfigForPath: (cwd: string, repoRoot?: string) => {
    let url = `/auto-approval/configs/match?cwd=${encodeURIComponent(cwd)}`;
    if (repoRoot) url += `&repo_root=${encodeURIComponent(repoRoot)}`;
    return get<{ config: AutoApprovalConfig | null }>(url);
  },
  createAutoApprovalConfig: (data: { projectPath: string; label: string; criteria: string; enabled?: boolean }) =>
    post<AutoApprovalConfig>("/auto-approval/configs", data),
  updateAutoApprovalConfig: (slug: string, data: { label?: string; criteria?: string; enabled?: boolean }) =>
    put<AutoApprovalConfig>(`/auto-approval/configs/${encodeURIComponent(slug)}`, data),
  deleteAutoApprovalConfig: (slug: string) =>
    del(`/auto-approval/configs/${encodeURIComponent(slug)}`),

  // Auto-Approval debug logs
  getAutoApprovalLogs: () =>
    get<AutoApprovalLogIndexEntry[]>("/auto-approval/logs"),
  getAutoApprovalLogEntry: (id: number) =>
    get<AutoApprovalLogEntry>(`/auto-approval/logs/${id}`),

  // CLI session discovery (for resume)
  listCliSessions: () =>
    get<{ sessions: CliSession[] }>("/cli-sessions"),

  // Questmaster
  listQuests: (filters?: { status?: string; parentId?: string; sessionId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.parentId) params.set("parentId", filters.parentId);
    if (filters?.sessionId) params.set("sessionId", filters.sessionId);
    const qs = params.toString();
    return get<import("./types.js").QuestmasterTask[]>(`/quests${qs ? `?${qs}` : ""}`);
  },
  getQuest: (id: string) =>
    get<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}`),
  getQuestHistory: (id: string) =>
    get<import("./types.js").QuestmasterTask[]>(`/quests/${encodeURIComponent(id)}/history`),
  createQuest: (input: import("./types.js").QuestCreateInput) =>
    post<import("./types.js").QuestmasterTask>("/quests", input),
  patchQuest: (id: string, body: import("./types.js").QuestPatchInput) =>
    patch<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}`, body),
  transitionQuest: (id: string, input: import("./types.js").QuestTransitionInput) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/transition`, input),
  deleteQuest: (id: string) =>
    del(`/quests/${encodeURIComponent(id)}`),
  claimQuest: (id: string, sessionId: string) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/claim`, { sessionId }),
  completeQuest: (id: string, verificationItems: import("./types.js").QuestVerificationItem[]) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/complete`, { verificationItems }),
  markQuestDone: (id: string) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/done`),
  checkQuestVerification: (id: string, index: number, checked: boolean) =>
    patch<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/verification/${index}`, { checked }),
  addQuestFeedback: (id: string, text: string, author: "human" | "agent" = "human", images?: import("./types.js").QuestImage[]) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/feedback`, { text, author, images }),
  editQuestFeedback: (id: string, index: number, updates: { text?: string; images?: import("./types.js").QuestImage[] }) =>
    patch<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/feedback/${index}`, updates),
  toggleFeedbackAddressed: (id: string, index: number) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/feedback/${index}/addressed`, {}),

  // Quest images

  /** Upload an image without attaching to any quest (for use during quest creation). */
  uploadStandaloneQuestImage: async (file: File): Promise<import("./types.js").QuestImage> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/quests/_images`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  /** Upload an image and attach it to an existing quest. */
  uploadQuestImage: async (questId: string, file: File): Promise<import("./types.js").QuestmasterTask> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/quests/${encodeURIComponent(questId)}/images`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },
  removeQuestImage: (questId: string, imageId: string) =>
    del<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(questId)}/images/${encodeURIComponent(imageId)}`),
  /** URL for displaying a quest image in the browser */
  questImageUrl: (imageId: string) => `${BASE}/quests/_images/${encodeURIComponent(imageId)}`,

  // Session export/import
  /** Trigger a .tar.zst download of all session data. */
  exportSessionsUrl: () => `${BASE}/migration/export`,

  /** Upload a .tar.zst archive to import sessions. Streams progress via callback. */
  importSessions: async (
    file: File,
    onProgress?: (step: string, message: string, pct?: number) => void,
  ): Promise<ImportStats> => {
    const form = new FormData();
    form.append("archive", file);

    onProgress?.("uploading", `Uploading archive (${(file.size / 1024 / 1024).toFixed(0)} MB)...`);
    const resp = await fetch(`${BASE}/migration/import`, { method: "POST", body: form });

    if (!resp.body) {
      // Fallback: non-streaming response (shouldn't happen)
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      return data as ImportStats;
    }

    // Read streaming NDJSON progress lines
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: ImportStats | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.step === "done") {
            result = event.result as ImportStats;
          } else if (event.step === "error") {
            throw new Error(event.error);
          } else {
            onProgress?.(event.step, event.message, event.pct);
          }
        } catch (e) {
          if (e instanceof Error && e.message !== line) throw e;
          // Skip malformed lines
        }
      }
    }

    if (!result) throw new Error("Import stream ended without a result");
    return result;
  },
};

export interface ImportStats {
  sessionsNew: number;
  sessionsUpdated: number;
  sessionsSkipped: number;
  worktreeSessionsNeedingRecreation: number;
  claudeSessionsRestored: number;
  pathsRewritten: boolean;
  filesImported: number;
  filesSkipped: number;
  warnings: string[];
}
