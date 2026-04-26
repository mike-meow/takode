import type { SdkSessionInfo, TreeGroup, ChatMessage, BrowserIncomingMessage, StreamRecord } from "./types.js";
import { encodeLogQuery, type LogQuery, type LogQueryResponse } from "../shared/logging.js";
import type { HerdSessionsResponse } from "../shared/herd-types.js";
import { normalizeHistoryMessageToChatMessages } from "./utils/history-message-normalization.js";

const BASE = "/api";
const TRANSCRIPTION_REQUEST_BASE_TIMEOUT_MS = 45_000;
const TRANSCRIPTION_REQUEST_TIMEOUT_CAP_MS = 180_000;
const TRANSCRIPTION_REQUEST_BYTES_PER_EXTRA_SECOND = 64 * 1024;

/**
 * The transcription route does not start streaming SSE until after the browser
 * finishes sending the request body and the server starts the SSE response. A
 * fixed 45s timeout is fine for short dictation, but longer mobile recordings
 * can spend most of that budget just getting audio to the server on a slow uplink.
 *
 * Scale the pre-response timeout with audio size while keeping short clips at
 * the existing baseline and capping the total wait to avoid hanging forever.
 */
export function getTranscriptionRequestTimeoutMs(audioSizeBytes: number): number {
  if (!Number.isFinite(audioSizeBytes) || audioSizeBytes <= 0) {
    return TRANSCRIPTION_REQUEST_BASE_TIMEOUT_MS;
  }
  const extraSeconds = Math.max(0, Math.ceil(audioSizeBytes / TRANSCRIPTION_REQUEST_BYTES_PER_EXTRA_SECOND) - 1);
  return Math.min(TRANSCRIPTION_REQUEST_BASE_TIMEOUT_MS + extraSeconds * 1_000, TRANSCRIPTION_REQUEST_TIMEOUT_CAP_MS);
}

export function resolveAudioUploadFilename(audioType: string): string {
  const normalizedAudioType = audioType.split(";")[0]?.trim().toLowerCase();
  switch (normalizedAudioType) {
    case "audio/mp4":
    case "video/mp4":
      return "recording.mp4";
    case "audio/ogg":
    case "video/ogg":
      return "recording.ogg";
    case "audio/wav":
    case "audio/x-wav":
      return "recording.wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "recording.mp3";
    case "audio/flac":
      return "recording.flac";
    default:
      return "recording.webm";
  }
}

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

async function get<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, signal ? { signal } : undefined);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
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
  const start = performance.now();
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) });
    const elapsed = performance.now() - start;
    if (elapsed > 5000) {
      console.warn(`[health] slow response: ${Math.round(elapsed)}ms`);
    }
    return res.ok;
  } catch (err) {
    const elapsed = performance.now() - start;
    console.warn(
      `[health] failed after ${Math.round(elapsed)}ms:`,
      err instanceof Error ? err.message : err,
      `visibility=${document.visibilityState}`,
    );
    return false;
  }
}

export function buildLogStreamUrl(query?: LogQuery & { tail?: number }): string {
  const qs = query ? encodeLogQuery(query) : "";
  return `${BASE}/logs/stream${qs ? `?${qs}` : ""}`;
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

export interface StreamGroupView {
  group: TreeGroup;
  scope: string;
  streams: StreamRecord[];
  counts: {
    total: number;
    active: number;
    archived: number;
    blocked: number;
    risk: number;
    alerts: number;
    contradictions: number;
    handoffs: number;
  };
}

export interface StreamGroupsResponse {
  serverId: string;
  includeArchived: boolean;
  query: string;
  groups: StreamGroupView[];
}

export interface StreamDetailResponse {
  scope: string;
  stream: StreamRecord;
  children: StreamRecord[];
}

export interface CreateSessionOpts {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  codexInternetAccess?: boolean;
  codexReasoningEffort?: string;
  allowedTools?: string[];
  envSlug?: string;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  backend?: "claude" | "codex" | "claude-sdk";
  container?: ContainerCreateOpts;
  assistantMode?: boolean;
  askPermission?: boolean;
  /** Session role: "orchestrator" gets TAKODE_ROLE + TAKODE_API_PORT env vars */
  role?: "worker" | "orchestrator";
  /** Server-side session group assignment for durable group membership. */
  treeGroupId?: string;
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
  /** Which CLI backend produced this session ("claude" or "codex"). */
  backend?: "claude" | "codex";
}

export type SessionSearchMatchedField = "name" | "task" | "keyword" | "branch" | "path" | "repo" | "user_message";

export interface SessionSearchResult {
  sessionId: string;
  score: number;
  matchedField: SessionSearchMatchedField;
  matchContext: string | null;
  matchedAt: number;
  messageMatch?: {
    id?: string;
    timestamp: number;
    snippet: string;
  };
}

export interface SessionSearchResponse {
  query: string;
  tookMs: number;
  totalMatches: number;
  results: SessionSearchResult[];
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

export interface ActiveTimerSession {
  sessionId: string;
  sessionNum: number | null;
  name?: string;
  backendType: "claude" | "codex" | "claude-sdk";
  state: string;
  cliConnected: boolean;
  cwd: string;
  gitBranch: string;
  timers: import("./types.js").SessionTimer[];
}

export interface PreparedUserMessageImages {
  imageRefs: import("./types.js").ImageRef[];
  paths: string[];
  attachmentAnnotation: string;
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

export interface QuestCommitLookup {
  sha: string;
  shortSha?: string;
  message?: string;
  timestamp?: number;
  additions?: number;
  deletions?: number;
  diff?: string;
  truncated?: boolean;
  available: boolean;
  reason?: "repo_unavailable" | "commit_not_available";
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
  pushoverEventFilters?: PushoverEventFilters;
  pushoverDelaySeconds: number;
  pushoverBaseUrl: string;
  claudeBinary: string;
  codexBinary: string;
  maxKeepAlive: number;
  heavyRepoModeEnabled: boolean;
  autoApprovalEnabled: boolean;
  autoApprovalModel: string;
  autoApprovalMaxConcurrency: number;
  autoApprovalTimeoutSeconds: number;
  namerConfig: NamerConfig;
  autoNamerEnabled: boolean;
  transcriptionConfig: TranscriptionConfig;
  editorConfig: EditorConfig;
  defaultClaudeBackend: "claude" | "claude-sdk";
  sleepInhibitorEnabled: boolean;
  sleepInhibitorDurationMinutes: number;
  questmasterViewMode: QuestmasterViewMode;
  restartSupported: boolean;
  logFile?: string | null;
  claudeDefaultModel?: string;
}

export interface PushoverEventFilters {
  needsInput: boolean;
  review: boolean;
  error: boolean;
}

export type QuestmasterViewMode = "cards" | "compact";

/** Discriminated union for session auto-namer backend. */
export type NamerConfig =
  | { backend: "claude"; model?: string }
  | { backend: "openai"; apiKey: string; baseUrl: string; model: string };

/** Voice transcription configuration (STT + optional LLM enhancement). */
export interface TranscriptionConfig {
  apiKey: string;
  baseUrl: string;
  enhancementEnabled: boolean;
  enhancementModel: string;
  customVocabulary?: string;
  enhancementMode?: "default" | "bullet";
  sttModel?: string;
  /** Preferred voice capture mode when composer has text: "edit" or "append". */
  voiceCaptureMode?: "edit" | "append";
}

export type EditorKind = "vscode-local" | "vscode-remote" | "cursor" | "none";

export interface EditorConfig {
  editor: EditorKind;
}

export interface VsCodeRemoteOpenFileTarget {
  absolutePath: string;
  line?: number;
  column?: number;
  endLine?: number;
  targetKind?: "file" | "directory";
}

export interface VsCodeRemoteOpenFileResponse {
  ok: true;
  sourceId: string;
  commandId: string;
}

// ─── Auto-Approval Types ─────────────────────────────────────────────────────

export interface AutoApprovalConfig {
  projectPath: string;
  projectPaths?: string[];
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
  model: string;
  parsed: { decision: string; reason: string } | null;
  projectPath: string;
  durationMs: number;
  promptLength: number;
  queueWaitMs?: number;
  failureReason?: string;
  failureDetail?: string;
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
  codexReasoningEffort?: string;
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

// ─── Transcription Debug Logs ────────────────────────────────────────────────

export interface TranscriptionLogIndexEntry {
  id: number;
  timestamp: number;
  sessionId: string | null;
  mode?: "dictation" | "edit" | "append";
  /** Browser upload + server request-body read/setup time before SSE begins. */
  uploadDurationMs: number;
  sttModel: string;
  sttDurationMs: number;
  rawTranscript: string;
  audioSizeBytes: number;
  enhancement: {
    model: string;
    enhancedText: string | null;
    durationMs: number;
    skipReason?: string;
  } | null;
}

export interface TranscriptionLogEntry extends TranscriptionLogIndexEntry {
  sttPrompt: string;
  enhancement: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    enhancedText: string | null;
    durationMs: number;
    skipReason?: string;
  } | null;
}

export type VoiceTranscriptionMode = "dictation" | "edit" | "append";
export type VoiceTranscriptionPhase = "preparing" | "transcribing" | "enhancing" | "editing" | "appending";

export interface VoiceTranscriptionResult {
  mode?: VoiceTranscriptionMode;
  text: string;
  rawText?: string;
  instructionText?: string;
  backend: string;
  enhanced: boolean;
}

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
  signal?: AbortSignal,
): Promise<CreateSessionStreamResult> {
  const res = await fetch(`${BASE}/sessions/create-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
    signal,
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
    post<{ sessionId: string; state: string; cwd: string }>("/sessions/create", opts),

  listSessions: () => get<SdkSessionInfo[]>("/sessions"),

  searchSessions: async (
    query: string,
    options?: {
      limit?: number;
      includeArchived?: boolean;
      includeReviewers?: boolean;
      messageLimitPerSession?: number;
      signal?: AbortSignal;
    },
  ) => {
    const params = new URLSearchParams();
    params.set("q", query);
    if (typeof options?.limit === "number") {
      params.set("limit", String(options.limit));
    }
    if (typeof options?.includeArchived === "boolean") {
      params.set("includeArchived", options.includeArchived ? "true" : "false");
    }
    if (typeof options?.includeReviewers === "boolean") {
      params.set("includeReviewers", options.includeReviewers ? "true" : "false");
    }
    if (typeof options?.messageLimitPerSession === "number") {
      params.set("messageLimitPerSession", String(options.messageLimitPerSession));
    }

    const res = await fetch(`${BASE}/sessions/search?${params.toString()}`, {
      signal: options?.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json() as Promise<SessionSearchResponse>;
  },

  killSession: (sessionId: string) => post(`/sessions/${encodeURIComponent(sessionId)}/kill`),

  deleteSession: (sessionId: string) => del(`/sessions/${encodeURIComponent(sessionId)}`),

  relaunchSession: (sessionId: string) => post(`/sessions/${encodeURIComponent(sessionId)}/relaunch`),

  upgradeTransport: (sessionId: string) =>
    post<{ ok: boolean; error?: string }>(`/sessions/${encodeURIComponent(sessionId)}/upgrade-transport`),

  downgradeTransport: (sessionId: string) =>
    post<{ ok: boolean; error?: string }>(`/sessions/${encodeURIComponent(sessionId)}/downgrade-transport`),

  forceCompact: (sessionId: string) => post(`/sessions/${encodeURIComponent(sessionId)}/force-compact`),

  prepareUserMessageImages: async (
    sessionId: string,
    images: Array<{ mediaType: string; data: string }>,
    signal?: AbortSignal,
  ) => {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/images/prepare-user-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json() as Promise<PreparedUserMessageImages>;
  },

  deletePreparedUserMessageImage: async (sessionId: string, imageId: string) => {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json() as Promise<{ ok: boolean }>;
  },

  revertToMessage: (sessionId: string, messageId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/revert`, { messageId }),

  archiveSession: (sessionId: string, opts?: { force?: boolean }) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/archive`, opts),

  archiveGroup: (sessionId: string) =>
    post<{ ok: boolean; archived: number; failed: number }>(`/sessions/${encodeURIComponent(sessionId)}/archive-group`),

  unarchiveSession: (sessionId: string) => post(`/sessions/${encodeURIComponent(sessionId)}/unarchive`),

  listActiveTimers: () => get<ActiveTimerSession[]>("/timers/active"),

  cancelTimer: (sessionId: string, timerId: string) =>
    del(`/sessions/${encodeURIComponent(sessionId)}/timers/${encodeURIComponent(timerId)}`),

  getToolResult: (sessionId: string, toolUseId: string) =>
    get<{ content: string; is_error: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/tool-result/${encodeURIComponent(toolUseId)}`,
    ),

  renameSession: (sessionId: string, name: string) =>
    patch<{ ok: boolean; name: string }>(`/sessions/${encodeURIComponent(sessionId)}/name`, { name }),

  markSessionRead: (sessionId: string) => patch<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/read`),

  markSessionUnread: (sessionId: string) => patch<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/unread`),

  markAllSessionsRead: () => post<{ ok: boolean }>("/sessions/mark-all-read"),

  markNotificationDone: (sessionId: string, notifId: string, done = true) =>
    post<{ ok: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/notifications/${encodeURIComponent(notifId)}/done`,
      { done },
    ),

  markAllNotificationsDone: (sessionId: string, done = true) =>
    post<{ ok: boolean; count: number }>(`/sessions/${encodeURIComponent(sessionId)}/notifications/done-all`, { done }),

  setDiffBase: (sessionId: string, branch: string) =>
    patch<{ ok: boolean; diff_base_branch: string }>(`/sessions/${encodeURIComponent(sessionId)}/diff-base`, {
      branch,
    }),

  // Cat herding (orchestrator→worker relationships)
  herdSessions: (orchId: string, workerIds: string[], opts?: { force?: boolean }) =>
    post<HerdSessionsResponse>(`/sessions/${encodeURIComponent(orchId)}/herd`, {
      workerIds,
      ...(opts?.force ? { force: true } : {}),
    }),

  herdWorkerToLeader: (workerId: string, leaderSessionId: string, opts?: { force?: boolean }) =>
    post<HerdSessionsResponse>(`/sessions/${encodeURIComponent(workerId)}/herd-to`, {
      leaderSessionId,
      ...(opts?.force ? { force: true } : {}),
    }),

  unherdSession: (orchId: string, workerId: string) =>
    del<{ ok: boolean; removed: boolean }>(
      `/sessions/${encodeURIComponent(orchId)}/herd/${encodeURIComponent(workerId)}`,
    ),

  getHerdedSessions: (orchId: string) => get<SdkSessionInfo[]>(`/sessions/${encodeURIComponent(orchId)}/herd`),

  // Tree groups (herd-centric sidebar grouping)
  getTreeGroups: () =>
    get<{ groups: TreeGroup[]; assignments: Record<string, string>; nodeOrder: Record<string, string[]> }>(
      "/tree-groups",
    ),

  updateTreeGroups: (state: { groups: TreeGroup[]; assignments: Record<string, string> }) =>
    put<{ ok: boolean }>("/tree-groups", state),

  createTreeGroup: (name: string) => post<{ ok: boolean; group: TreeGroup }>("/tree-groups/groups", { name }),

  renameTreeGroup: (id: string, name: string) =>
    patch<{ ok: boolean }>(`/tree-groups/groups/${encodeURIComponent(id)}`, { name }),

  deleteTreeGroup: (id: string) => del<{ ok: boolean }>(`/tree-groups/groups/${encodeURIComponent(id)}`),

  assignSessionToTreeGroup: (sessionId: string, groupId: string) =>
    patch<{ ok: boolean }>("/tree-groups/assign", { sessionId, groupId }),

  updateTreeNodeOrder: (groupId: string, orderedIds: string[]) =>
    patch<{ ok: boolean }>("/tree-groups/node-order", { groupId, orderedIds }),

  // Streams (session-group observability/debugging)
  listStreamGroups: (opts?: { includeArchived?: boolean; query?: string }) => {
    const params = new URLSearchParams();
    if (opts?.includeArchived) params.set("includeArchived", "1");
    const query = opts?.query?.trim();
    if (query) params.set("q", query);
    const qs = params.toString();
    return get<StreamGroupsResponse>(`/streams/groups${qs ? `?${qs}` : ""}`);
  },

  getStreamDetail: (scope: string, ref: string) => {
    const params = new URLSearchParams({ scope });
    return get<StreamDetailResponse>(`/streams/${encodeURIComponent(ref)}?${params.toString()}`);
  },

  getHerdDiagnostics: (sessionId: string) =>
    get<Record<string, unknown>>(`/sessions/${encodeURIComponent(sessionId)}/herd-diagnostics`),

  getSessionSystemPrompt: (sessionId: string) =>
    get<{ prompt: string | null }>(`/sessions/${encodeURIComponent(sessionId)}/system-prompt`),

  listDirs: (path?: string, opts?: { hidden?: boolean }) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (opts?.hidden) params.set("hidden", "1");
    const qs = params.toString();
    return get<DirListResult>(`/fs/list${qs ? `?${qs}` : ""}`);
  },

  getHome: () => get<{ home: string; cwd: string }>("/fs/home"),

  // Environments
  listEnvs: () => get<CompanionEnv[]>("/envs"),
  getEnv: (slug: string) => get<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`),
  createEnv: (
    name: string,
    variables: Record<string, string>,
    docker?: {
      dockerfile?: string;
      baseImage?: string;
      ports?: number[];
      volumes?: string[];
      initScript?: string;
    },
  ) => post<CompanionEnv>("/envs", { name, variables, ...docker }),
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
  buildEnvImage: (slug: string) => post<{ ok: boolean; imageTag: string }>(`/envs/${encodeURIComponent(slug)}/build`),
  getEnvBuildStatus: (slug: string) =>
    get<{ buildStatus: string; buildError?: string; lastBuiltAt?: number; imageTag?: string }>(
      `/envs/${encodeURIComponent(slug)}/build-status`,
    ),
  buildBaseImage: () => post<{ ok: boolean; tag: string }>("/docker/build-base"),
  getBaseImageStatus: () => get<{ exists: boolean; tag: string }>("/docker/base-image"),

  // Server control
  restartServer: () => post<{ ok: boolean }>("/server/restart", {}),

  openVsCodeRemoteFile: (target: VsCodeRemoteOpenFileTarget) =>
    post<VsCodeRemoteOpenFileResponse>("/vscode/open-file", target),

  // Settings
  getSettings: () => get<AppSettings>("/settings"),
  getCodexDefaultModel: () => get<{ model: string }>("/settings/codex-default-model"),
  getLogs: (query?: LogQuery) => {
    const qs = query ? encodeLogQuery(query) : "";
    return get<LogQueryResponse>(`/logs${qs ? `?${qs}` : ""}`);
  },
  updateSettings: (data: {
    serverName?: string;
    pushoverUserKey?: string;
    pushoverApiToken?: string;
    pushoverDelaySeconds?: number;
    pushoverEnabled?: boolean;
    pushoverEventFilters?: Partial<PushoverEventFilters>;
    pushoverBaseUrl?: string;
    claudeBinary?: string;
    codexBinary?: string;
    maxKeepAlive?: number;
    heavyRepoModeEnabled?: boolean;
    autoApprovalEnabled?: boolean;
    autoApprovalModel?: string;
    autoApprovalMaxConcurrency?: number;
    autoApprovalTimeoutSeconds?: number;
    namerConfig?: NamerConfig;
    autoNamerEnabled?: boolean;
    transcriptionConfig?: Partial<TranscriptionConfig>;
    editorConfig?: EditorConfig;
    defaultClaudeBackend?: "claude" | "claude-sdk";
    sleepInhibitorEnabled?: boolean;
    sleepInhibitorDurationMinutes?: number;
    questmasterViewMode?: QuestmasterViewMode;
  }) => put<AppSettings>("/settings", data),
  testBinary: (binary: string) =>
    post<{ ok: boolean; resolvedPath?: string; version?: string }>("/settings/test-binary", { binary }),
  testPushover: () => post<{ ok: boolean }>("/pushover/test"),
  getCaffeinateStatus: () =>
    get<{ active: boolean; engagedAt: number | null; expiresAt: number | null }>("/caffeinate-status"),

  // Git operations
  getRepoInfo: (path: string) => get<GitRepoInfo>(`/git/repo-info?path=${encodeURIComponent(path)}`),
  listBranches: (repoRoot: string, opts?: { localOnly?: boolean }) =>
    get<GitBranchInfo[]>(
      `/git/branches?repoRoot=${encodeURIComponent(repoRoot)}${opts?.localOnly ? "&localOnly=1" : ""}`,
    ),
  getRecentCommits: (repoRoot: string, limit = 20) =>
    get<{ commits: { sha: string; shortSha: string; message: string; timestamp: number }[] }>(
      `/git/commits?repoRoot=${encodeURIComponent(repoRoot)}&limit=${limit}`,
    ),
  gitFetch: (repoRoot: string) => post<{ success: boolean; output: string }>("/git/fetch", { repoRoot }),
  gitPull: (cwd: string, sessionId?: string) =>
    post<{
      success: boolean;
      output: string;
      git_ahead: number;
      git_behind: number;
    }>("/git/pull", { cwd, sessionId }),

  // Git worktrees
  listWorktrees: (repoRoot: string) =>
    get<GitWorktreeInfo[]>(`/git/worktrees?repoRoot=${encodeURIComponent(repoRoot)}`),
  createWorktree: (repoRoot: string, branch: string, opts?: { baseBranch?: string; createBranch?: boolean }) =>
    post<WorktreeCreateResult>("/git/worktree", {
      repoRoot,
      branch,
      ...opts,
    }),
  removeWorktree: (repoRoot: string, worktreePath: string, force?: boolean) =>
    del("/git/worktree", { repoRoot, worktreePath, force }),

  // GitHub PR status
  getPRStatus: (cwd: string, branch: string) =>
    get<PRStatusResponse>(`/git/pr-status?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}`),

  // Backends
  getBackends: () => get<BackendInfo[]>("/backends"),
  getBackendModels: (backendId: string) => get<BackendModelInfo[]>(`/backends/${encodeURIComponent(backendId)}/models`),

  // Containers
  getContainerStatus: () => get<ContainerStatus>("/containers/status"),
  getContainerImages: () => get<string[]>("/containers/images"),
  getCloudProviderPlan: (provider: "modal", cwd: string, sessionId: string) =>
    get<CloudProviderPlan>(
      `/cloud/providers/${encodeURIComponent(provider)}/plan?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`,
    ),

  // Editor
  startEditor: (sessionId: string) => post<{ url: string }>(`/sessions/${encodeURIComponent(sessionId)}/editor/start`),

  // File search for @ mentions
  searchFiles: (root: string, query: string, signal?: AbortSignal) =>
    get<{
      results: Array<{ relativePath: string; absolutePath: string; fileName: string }>;
      root: string;
    }>(`/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`, signal),
  resolveMentions: (mentions: Array<{ path: string; startLine?: number; endLine?: number }>) =>
    post<{
      resolved: Array<{ path: string; content?: string; totalLines?: number; error?: string }>;
    }>("/fs/resolve-mentions", { mentions }),

  // Editor filesystem
  getFileTree: (path: string) => get<{ path: string; tree: TreeNode[] }>(`/fs/tree?path=${encodeURIComponent(path)}`),
  readFile: (path: string) => get<{ path: string; content: string }>(`/fs/read?path=${encodeURIComponent(path)}`),
  getFsImageUrl: (path: string) => `${BASE}/fs/image?path=${encodeURIComponent(path)}`,
  writeFile: (path: string, content: string) => put<{ ok: boolean; path: string }>("/fs/write", { path, content }),
  getFileDiff: (path: string, base?: string, opts?: { includeContents?: boolean; sessionId?: string }) => {
    let url = `/fs/diff?path=${encodeURIComponent(path)}`;
    if (base) url += `&base=${encodeURIComponent(base)}`;
    if (opts?.includeContents) url += "&includeContents=1";
    if (opts?.sessionId) url += `&sessionId=${encodeURIComponent(opts.sessionId)}`;
    return get<{
      path: string;
      diff: string;
      truncated?: boolean;
      baseBranch?: string;
      oldText?: string;
      newText?: string;
    }>(url);
  },
  getDiffStats: (files: string[], repoRoot: string, base?: string, sessionId?: string) =>
    post<{ stats: Record<string, { additions: number; deletions: number }>; baseBranch?: string }>("/fs/diff-stats", {
      files,
      repoRoot,
      base: base || undefined,
      sessionId: sessionId || undefined,
    }),
  getDiffFiles: (cwd: string, base: string, sessionId?: string) =>
    get<{
      files: Array<{ path: string; status: "A" | "M" | "D" | "R"; oldPath?: string }>;
      repoRoot: string;
      base: string;
      truncated?: boolean;
    }>(
      `/fs/diff-files?cwd=${encodeURIComponent(cwd)}&base=${encodeURIComponent(base)}${
        sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""
      }`,
    ),
  getClaudeMdFiles: (cwd: string) =>
    get<{ cwd: string; files: { path: string; content: string; writable?: boolean }[] }>(
      `/fs/claude-md?cwd=${encodeURIComponent(cwd)}`,
    ),
  saveClaudeMd: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/claude-md", { path, content }),

  // Audio transcription (SSE streaming: stt_complete → result)
  transcribe: async (
    audio: Blob,
    options?: {
      backend?: "gemini" | "openai";
      mode?: VoiceTranscriptionMode;
      sessionId?: string;
      composerText?: string;
      /** Called when transcription phase changes (e.g. first stream ack -> "transcribing"). */
      onPhase?: (phase: VoiceTranscriptionPhase) => void;
    },
  ): Promise<VoiceTranscriptionResult> => {
    const mode = options?.mode ?? "dictation";
    const audioFileName = resolveAudioUploadFilename(audio.type);
    const canUseRawAudioTransport = mode === "dictation" && options?.composerText === undefined;
    const query = new URLSearchParams();
    if (options?.backend) query.set("backend", options.backend);
    if (mode) query.set("mode", mode);
    if (options?.sessionId) query.set("sessionId", options.sessionId);
    const path = `${BASE}/transcribe${query.size > 0 ? `?${query.toString()}` : ""}`;
    const headers = new Headers();
    let body: BodyInit;
    if (canUseRawAudioTransport) {
      body = audio;
      headers.set("Content-Type", audio.type || "application/octet-stream");
      headers.set("X-Companion-Audio-Filename", audioFileName);
    } else {
      const form = new FormData();
      form.append("audio", audio, audioFileName);
      if (options?.backend) form.append("backend", options.backend);
      if (mode) form.append("mode", mode);
      if (options?.sessionId) form.append("sessionId", options.sessionId);
      if (options?.composerText !== undefined) form.append("composerText", options.composerText);
      body = form;
    }
    // This timeout only covers the pre-SSE phase (audio upload/body read +
    // route startup). Once the response body starts streaming, the reader below
    // owns the rest of the request lifecycle.
    const controller = new AbortController();
    const timeoutMs = getTranscriptionRequestTimeoutMs(audio.size);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    options?.onPhase?.("preparing");
    try {
      res = await fetch(path, { method: "POST", body, headers, signal: controller.signal });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          `Transcription timed out after ${Math.round(timeoutMs / 1000)}s — sending audio or starting transcription took too long.`,
        );
      }
      throw err;
    }
    clearTimeout(timeout);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error || res.statusText);
    }

    // Parse SSE stream for phase-aware progress
    if (!res.body) throw new Error("No response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: VoiceTranscriptionResult | null = null;
    let phaseAcked = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

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
        if (!phaseAcked && eventType !== "phase") {
          options?.onPhase?.("transcribing");
          phaseAcked = true;
        }

        const parsed = JSON.parse(data);
        if (eventType === "phase") {
          const nextPhase = parsed.phase as VoiceTranscriptionPhase | null | undefined;
          if (nextPhase) {
            options?.onPhase?.(nextPhase);
            phaseAcked = true;
          }
        } else if (eventType === "stt_complete") {
          const nextPhase = parsed.nextPhase as VoiceTranscriptionPhase | null | undefined;
          if (nextPhase) {
            options?.onPhase?.(nextPhase);
          } else if (parsed.willEnhance) {
            options?.onPhase?.("enhancing");
          }
        } else if (eventType === "result") {
          result = parsed;
        } else if (eventType === "error") {
          throw new Error(parsed.error || "Transcription failed");
        }
      }
    }

    if (!result) throw new Error("Stream ended without transcription result");
    return result;
  },

  getTranscriptionStatus: () =>
    get<{ available: boolean; enhancementEnabled: boolean; backend: string | null }>("/transcribe/status"),

  // Usage limits
  getUsageLimits: () => get<UsageLimits>("/usage-limits"),
  getSessionUsageLimits: (sessionId: string) =>
    get<UsageLimits>(`/sessions/${encodeURIComponent(sessionId)}/usage-limits`),
  refreshSessionSkills: (sessionId: string) =>
    post<{ ok: boolean; skills: string[] }>(`/sessions/${encodeURIComponent(sessionId)}/skills/refresh`, {}),

  // Terminal
  spawnTerminal: (cwd: string, cols?: number, rows?: number, sessionId?: string) =>
    post<{ terminalId: string }>("/terminal/spawn", { cwd, cols, rows, sessionId }),
  killTerminal: () => post<{ ok: boolean }>("/terminal/kill"),
  getTerminal: (sessionId?: string) =>
    get<{ active: boolean; terminalId?: string; cwd?: string }>(
      sessionId ? `/terminal?sessionId=${encodeURIComponent(sessionId)}` : "/terminal",
    ),

  // Cron jobs
  listCronJobs: () => get<CronJobInfo[]>("/cron/jobs"),
  getCronJob: (id: string) => get<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`),
  createCronJob: (data: Partial<CronJobInfo>) => post<CronJobInfo>("/cron/jobs", data),
  updateCronJob: (id: string, data: Partial<CronJobInfo>) =>
    put<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`, data),
  deleteCronJob: (id: string) => del(`/cron/jobs/${encodeURIComponent(id)}`),
  toggleCronJob: (id: string) => post<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}/toggle`),
  runCronJob: (id: string) => post(`/cron/jobs/${encodeURIComponent(id)}/run`),
  getCronJobExecutions: (id: string) => get<CronJobExecution[]>(`/cron/jobs/${encodeURIComponent(id)}/executions`),

  // Cross-session messaging
  sendSessionMessage: (sessionId: string, content: string) =>
    post<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/message`, { content }),

  // Transcription debug logs
  getTranscriptionLogs: () => get<TranscriptionLogIndexEntry[]>("/transcription-logs"),
  getTranscriptionLogEntry: (id: number) => get<TranscriptionLogEntry>(`/transcription-logs/${id}`),

  // Enhancement tester (debug tool in Settings)
  testEnhancement: (text: string, mode: "default" | "bullet", sessionId?: string) =>
    post<{
      enhanced: string;
      wasEnhanced: boolean;
      debug: {
        model: string;
        systemPrompt: string;
        userMessage: string;
        durationMs: number;
        skipReason?: string;
      } | null;
    }>("/transcription/test-enhance", { text, mode, sessionId }),

  // Namer debug logs
  getNamerLogs: () => get<NamerLogIndexEntry[]>("/namer-logs"),
  getNamerLogEntry: (id: number) => get<NamerLogEntry>(`/namer-logs/${id}`),

  // Auto-Approval configs
  getAutoApprovalConfigs: () => get<AutoApprovalConfig[]>("/auto-approval/configs"),
  getAutoApprovalConfig: (slug: string) =>
    get<AutoApprovalConfig>(`/auto-approval/configs/${encodeURIComponent(slug)}`),
  /** Find the matching auto-approval config for a given cwd (longest prefix match).
   *  Pass repoRoot for worktree sessions whose cwd differs from the main repo. */
  getAutoApprovalConfigForPath: (cwd: string, repoRoot?: string) => {
    let url = `/auto-approval/configs/match?cwd=${encodeURIComponent(cwd)}`;
    if (repoRoot) url += `&repo_root=${encodeURIComponent(repoRoot)}`;
    return get<{ config: AutoApprovalConfig | null }>(url);
  },
  createAutoApprovalConfig: (data: {
    projectPath: string;
    projectPaths?: string[];
    label: string;
    criteria: string;
    enabled?: boolean;
  }) => post<AutoApprovalConfig>("/auto-approval/configs", data),
  updateAutoApprovalConfig: (
    slug: string,
    data: { label?: string; criteria?: string; enabled?: boolean; projectPaths?: string[] },
  ) => put<AutoApprovalConfig>(`/auto-approval/configs/${encodeURIComponent(slug)}`, data),
  deleteAutoApprovalConfig: (slug: string) => del(`/auto-approval/configs/${encodeURIComponent(slug)}`),

  // Auto-Approval debug logs
  getAutoApprovalLogs: () => get<AutoApprovalLogIndexEntry[]>("/auto-approval/logs"),
  getAutoApprovalLogEntry: (id: number) => get<AutoApprovalLogEntry>(`/auto-approval/logs/${id}`),

  // CLI session discovery (for resume)
  listCliSessions: (backend?: "claude" | "codex") =>
    get<{ sessions: CliSession[] }>(`/cli-sessions${backend ? `?backend=${backend}` : ""}`),

  // Questmaster
  listQuests: (filters?: { status?: string; parentId?: string; sessionId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.parentId) params.set("parentId", filters.parentId);
    if (filters?.sessionId) params.set("sessionId", filters.sessionId);
    const qs = params.toString();
    return get<import("./types.js").QuestmasterTask[]>(`/quests${qs ? `?${qs}` : ""}`);
  },
  getQuest: (id: string) => get<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}`),
  getQuestHistory: (id: string) =>
    get<import("./types.js").QuestmasterTask[]>(`/quests/${encodeURIComponent(id)}/history`),
  getQuestCommit: (id: string, sha: string) =>
    get<QuestCommitLookup>(`/quests/${encodeURIComponent(id)}/commits/${encodeURIComponent(sha)}`),
  createQuest: (input: import("./types.js").QuestCreateInput) =>
    post<import("./types.js").QuestmasterTask>("/quests", input),
  patchQuest: (id: string, body: import("./types.js").QuestPatchInput) =>
    patch<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}`, body),
  transitionQuest: (id: string, input: import("./types.js").QuestTransitionInput) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/transition`, input),
  deleteQuest: (id: string) => del(`/quests/${encodeURIComponent(id)}`),
  claimQuest: (id: string, sessionId: string) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/claim`, { sessionId }),
  completeQuest: (id: string, verificationItems: import("./types.js").QuestVerificationItem[], commitShas?: string[]) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/complete`, {
      verificationItems,
      ...(commitShas?.length ? { commitShas } : {}),
    }),
  markQuestDone: (
    id: string,
    input?: {
      verificationItems?: import("./types.js").QuestVerificationItem[];
      notes?: string;
      cancelled?: boolean;
    },
  ) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/transition`, {
      status: "done",
      ...(input ?? {}),
    }),
  checkQuestVerification: (id: string, index: number, checked: boolean) =>
    patch<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/verification/${index}`, { checked }),
  markQuestVerificationRead: (id: string) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/verification/read`, {}),
  markQuestVerificationInbox: (id: string) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/verification/inbox`, {}),
  addQuestFeedback: (
    id: string,
    text: string,
    author: "human" | "agent" = "human",
    images?: import("./types.js").QuestImage[],
  ) =>
    post<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/feedback`, { text, author, images }),
  editQuestFeedback: (
    id: string,
    index: number,
    updates: { text?: string; images?: import("./types.js").QuestImage[] },
  ) => patch<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/feedback/${index}`, updates),
  deleteQuestFeedback: (id: string, index: number) =>
    del<import("./types.js").QuestmasterTask>(`/quests/${encodeURIComponent(id)}/feedback/${index}`),
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
    del<import("./types.js").QuestmasterTask>(
      `/quests/${encodeURIComponent(questId)}/images/${encodeURIComponent(imageId)}`,
    ),
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

  // Takode: fetch a single message snippet for hover previews
  fetchMessageSnippet: async (
    sessionId: string,
    messageIndex: number,
  ): Promise<{ role: string; snippet: string } | null> => {
    try {
      const res = await fetch(
        `${BASE}/takode/sessions/${encodeURIComponent(sessionId)}/messages/${messageIndex}?limit=3`,
      );
      if (!res.ok) return null;
      const data = await res.json();
      const text: string = data.text || data.content || "";
      return { role: data.role || "unknown", snippet: text.slice(0, 200) };
    } catch {
      return null;
    }
  },

  // Takode: fetch a single message payload for message-link hover previews
  fetchMessagePreview: async (sessionId: string, messageIndex: number): Promise<ChatMessage | null> => {
    try {
      const data = await get<{
        idx: number;
        type: string;
        ts: number;
        content: string;
        rawMessage?: BrowserIncomingMessage;
      }>(`/sessions/${encodeURIComponent(sessionId)}/messages/${messageIndex}/preview`);

      if (data.rawMessage) {
        const normalized = normalizeHistoryMessageToChatMessages(data.rawMessage, messageIndex, {
          includeSuccessfulResult: true,
          fallbackTimestamp: data.ts,
        });
        return normalized[0] ?? null;
      }

      return null;
    } catch {
      return null;
    }
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
