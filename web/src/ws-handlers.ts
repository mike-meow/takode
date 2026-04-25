import { useStore } from "./store.js";
import { api } from "./api.js";
import { createComposerDraftImage } from "./components/composer-image-utils.js";
import type { BrowserIncomingMessage, ContentBlock, ChatMessage, TaskItem } from "./types.js";
import { generateUniqueSessionName } from "./utils/names.js";
import { playNotificationSound, playReviewSound, playNeedsInputSound } from "./utils/notification-sound.js";
import { extractTextFromBlocks, normalizeHistoryMessageToChatMessages } from "./utils/history-message-normalization.js";
import { questOwnsSessionName } from "./utils/quest-helpers.js";

const taskCounters = new Map<string, number>();
const pendingCliDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Track processed tool_use IDs to prevent duplicate task creation */
const processedToolUseIds = new Map<string, Set<string>>();
/** Debounce timer for session_created events -- coalesce rapid bursts into a single API call. */
let sessionCreatedTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounce guard: prevent overlapping notification sounds from rapid updates. */
let lastNotificationSoundAt = 0;
const NOTIFICATION_SOUND_DEBOUNCE_MS = 1000;
/** Delay transient backend_disconnected flips to avoid sidebar flicker during fast relaunches. */
const CLI_DISCONNECT_DEBOUNCE_MS = 250;

export interface WsMessageHandlerDeps {
  disconnectSession: (sessionId: string) => void;
}

function clearPendingCliDisconnect(sessionId: string): void {
  const timer = pendingCliDisconnectTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingCliDisconnectTimers.delete(sessionId);
}

function applyCliDisconnected(sessionId: string, reason: "idle_limit" | "broken" | null): void {
  const store = useStore.getState();
  store.setCliConnected(sessionId, false);
  store.setCliDisconnectReason(sessionId, reason);
  store.setSessionStatus(sessionId, null);
  store.clearStreamingState(sessionId);
  store.clearToolProgress(sessionId);
}

function normalizePath(path: string): string {
  const isAbs = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return `${isAbs ? "/" : ""}${out.join("/")}`;
}

export function resolveSessionFilePath(filePath: string, cwd?: string): string {
  if (filePath.startsWith("/")) return normalizePath(filePath);
  if (!cwd) return normalizePath(filePath);
  return normalizePath(`${cwd}/${filePath}`);
}

function isPathInSessionScope(filePath: string, cwd?: string): boolean {
  if (!cwd) return true;
  const normalizedCwd = normalizePath(cwd);
  return filePath === normalizedCwd || filePath.startsWith(`${normalizedCwd}/`);
}

function getProcessedSet(sessionId: string): Set<string> {
  let set = processedToolUseIds.get(sessionId);
  if (!set) {
    set = new Set();
    processedToolUseIds.set(sessionId, set);
  }
  return set;
}

function extractTasksFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const processed = getProcessedSet(sessionId);
  let hadTaskUpdate = false;

  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input, id: toolUseId } = block;

    // Deduplicate by tool_use_id
    if (toolUseId) {
      if (processed.has(toolUseId)) continue;
      processed.add(toolUseId);
    }

    // TodoWrite: full replacement — { todos: [{ content, status, activeForm }] }
    if (name === "TodoWrite") {
      const todos = input.todos as { content?: string; status?: string; activeForm?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const tasks: TaskItem[] = todos.map((t, i) => ({
          id: String(i + 1),
          subject: t.content || "Task",
          description: "",
          activeForm: t.activeForm,
          status: (t.status as TaskItem["status"]) || "pending",
        }));
        store.setTasks(sessionId, tasks);
        taskCounters.set(sessionId, tasks.length);
        hadTaskUpdate = true;
      }
      continue;
    }

    // TaskCreate: incremental add — { subject, description, activeForm }
    if (name === "TaskCreate") {
      const count = (taskCounters.get(sessionId) || 0) + 1;
      taskCounters.set(sessionId, count);
      const task = {
        id: String(count),
        subject: (input.subject as string) || "Task",
        description: (input.description as string) || "",
        activeForm: input.activeForm as string | undefined,
        status: "pending" as const,
      };
      store.addTask(sessionId, task);
      hadTaskUpdate = true;
      continue;
    }

    // TaskUpdate: incremental update — { taskId, status, owner, activeForm, addBlockedBy }
    if (name === "TaskUpdate") {
      const taskId = input.taskId as string;
      if (taskId) {
        const updates: Partial<TaskItem> = {};
        if (input.status) updates.status = input.status as TaskItem["status"];
        if (input.owner) updates.owner = input.owner as string;
        if (input.activeForm !== undefined) updates.activeForm = input.activeForm as string;
        if (input.addBlockedBy) updates.blockedBy = input.addBlockedBy as string[];
        store.updateTask(sessionId, taskId, updates);
        hadTaskUpdate = true;
      }
    }
  }

  // Update sidebar task preview: show the first in_progress task's activeForm
  if (hadTaskUpdate) {
    const tasks = useStore.getState().sessionTasks.get(sessionId);
    const active = tasks?.find((t) => t.status === "in_progress");
    store.setSessionTaskPreview(sessionId, active ? active.activeForm || active.subject : null);
  }
}

function extractChangedFilesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const session = store.sessions.get(sessionId);
  const sessionCwd = session?.cwd || store.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd;
  // Use repo root as scope so files outside session cwd (e.g. repo-root CLAUDE.md) are tracked.
  // For worktrees, repo_root points to the main repo (not the worktree directory), so fall
  // back to cwd when repo_root isn't an ancestor of cwd.
  const scope = session?.repo_root && sessionCwd?.startsWith(session.repo_root + "/") ? session.repo_root : sessionCwd;
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input } = block;
    const filePath = name === "NotebookEdit" ? input.notebook_path : input.file_path;
    if (
      (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") &&
      typeof filePath === "string"
    ) {
      const resolvedPath = resolveSessionFilePath(filePath, sessionCwd);
      if (isPathInSessionScope(resolvedPath, scope)) {
        store.addChangedFile(sessionId, resolvedPath);
      }
    }
  }
}

function sendBrowserNotification(title: string, body: string, tag: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  new Notification(title, { body, tag });
}

function shouldNotifyOnResult(sessionId: string, store: ReturnType<typeof useStore.getState>): boolean {
  const sdk = store.sdkSessions.find((s) => s.sessionId === sessionId);
  if (sdk?.herdedBy) return false;
  if (!sdk?.isOrchestrator) return true;

  const messages = store.messages.get(sessionId) || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    return !!msg.notification;
  }
  return false;
}

let idCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}`;
}

/** Merge content blocks from two versions of the same assistant message.
 *  Deduplicates tool_use blocks by their unique `id` and text/thinking
 *  blocks by content equality. Returns all unique blocks in order. */
function mergeToolUseInputValues(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };

  for (const [key, value] of Object.entries(incoming)) {
    if (value == null) continue;
    if (typeof value === "string") {
      if (value.trim().length > 0 || !(key in merged)) merged[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 0 || !(key in merged)) merged[key] = value;
      continue;
    }
    if (typeof value === "object") {
      const previous = merged[key];
      if (previous && typeof previous === "object" && !Array.isArray(previous)) {
        merged[key] = mergeToolUseInputValues(previous as Record<string, unknown>, value as Record<string, unknown>);
      } else if (!(key in merged) || Object.keys(value as Record<string, unknown>).length > 0) {
        merged[key] = value;
      }
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

function mergeContentBlocks(existing: ContentBlock[], incoming: ContentBlock[]): ContentBlock[] {
  const seenToolIds = new Set<string>();
  const toolIdToIndex = new Map<string, number>();
  const seenTexts = new Set<string>();
  const result: ContentBlock[] = [];

  for (const block of existing) {
    if (block.type === "tool_use" && block.id) {
      seenToolIds.add(block.id);
      toolIdToIndex.set(block.id, result.length);
    } else if (block.type === "text") {
      seenTexts.add(block.text);
    } else if (block.type === "thinking") {
      seenTexts.add(`thinking:${block.thinking}`);
    }
    result.push(block);
  }

  for (const block of incoming) {
    if (block.type === "tool_use" && block.id) {
      if (seenToolIds.has(block.id)) {
        const idx = toolIdToIndex.get(block.id);
        if (idx != null) {
          const previous = result[idx];
          if (previous?.type === "tool_use") {
            result[idx] = {
              ...previous,
              name: block.name || previous.name,
              input: mergeToolUseInputValues(previous.input || {}, block.input || {}),
            };
          }
        }
        continue;
      }
      seenToolIds.add(block.id);
      toolIdToIndex.set(block.id, result.length);
    } else if (block.type === "text") {
      if (seenTexts.has(block.text)) continue;
      seenTexts.add(block.text);
    } else if (block.type === "thinking") {
      if (seenTexts.has(`thinking:${block.thinking}`)) continue;
      seenTexts.add(`thinking:${block.thinking}`);
    }
    result.push(block);
  }

  return result;
}

function normalizeHistoryMessages(
  sessionId: string,
  historyMessages: BrowserIncomingMessage[],
  startIndex = 0,
): { chatMessages: ChatMessage[]; frozenCount: number } {
  const store = useStore.getState();
  const pendingUploads = store.pendingUserUploads.get(sessionId) ?? [];
  const restorationUploads = [...(store.pendingUserUploadRestorations.get(sessionId)?.values() ?? [])];
  const pendingLocalImagesByClientMsgId = new Map(
    [...pendingUploads, ...restorationUploads]
      .filter((upload) => upload.images.length > 0)
      .map(
        (upload) =>
          [
            upload.id,
            upload.images.map(({ name, base64, mediaType }) => ({
              name,
              base64,
              mediaType,
            })),
          ] as const,
      ),
  );
  const chatMessages: ChatMessage[] = [];
  let frozenCount = 0;

  for (let i = 0; i < historyMessages.length; i++) {
    const histMsg = historyMessages[i];
    const historyIndex = startIndex + i;
    if (histMsg.type === "assistant") {
      const msg = histMsg.message;
      chatMessages.push(...normalizeHistoryMessageToChatMessages(histMsg, historyIndex));
      if (msg.content?.length) {
        extractTasksFromBlocks(sessionId, msg.content);
        extractChangedFilesFromBlocks(sessionId, msg.content);
      }
      const histToolStartTimes = (histMsg as Record<string, unknown>).tool_start_times as
        | Record<string, number>
        | undefined;
      if (histToolStartTimes) {
        store.setToolStartTimestamps(sessionId, histToolStartTimes);
      }
    } else if (histMsg.type === "user_message") {
      chatMessages.push(
        ...normalizeHistoryMessageToChatMessages(histMsg, historyIndex, {
          pendingLocalImagesByClientMsgId,
        }),
      );
    } else if (histMsg.type === "tool_result_preview") {
      for (const preview of histMsg.previews) {
        store.setToolResult(sessionId, preview.tool_use_id, preview);
      }
    } else if (histMsg.type === "task_notification") {
      if (histMsg.tool_use_id) {
        store.setBackgroundAgentNotif(sessionId, histMsg.tool_use_id, {
          status: histMsg.status,
          outputFile: histMsg.output_file,
          summary: histMsg.summary,
        });
      }
      chatMessages.push(...normalizeHistoryMessageToChatMessages(histMsg, historyIndex));
    } else if (histMsg.type === "result") {
      store.setTasks(sessionId, []);
      store.setSessionTaskPreview(sessionId, null);
      chatMessages.push(...normalizeHistoryMessageToChatMessages(histMsg, historyIndex));
      frozenCount = chatMessages.length;
    } else if (
      histMsg.type === "compact_marker" ||
      histMsg.type === "permission_denied" ||
      histMsg.type === "permission_approved"
    ) {
      chatMessages.push(...normalizeHistoryMessageToChatMessages(histMsg, historyIndex));
    }
  }

  return { chatMessages, frozenCount };
}

function updateSessionPreviewFromHistory(
  sessionId: string,
  historyMessages: BrowserIncomingMessage[],
  options?: { allowOlderHistory?: boolean },
): void {
  const store = useStore.getState();
  if (options?.allowOlderHistory === false) return;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (msg.type === "user_message" && msg.content) {
      store.setSessionPreview(sessionId, msg.content.slice(0, 80));
      break;
    }
  }
}

function clearPendingUploadsCoveredByHistory(sessionId: string, historyMessages: BrowserIncomingMessage[]): void {
  const pendingIds = new Set<string>();
  for (const msg of historyMessages) {
    if (msg.type !== "user_message" || typeof msg.client_msg_id !== "string") continue;
    pendingIds.add(msg.client_msg_id);
  }
  if (pendingIds.size === 0) return;
  const store = useStore.getState();
  for (const pendingId of pendingIds) {
    store.consumePendingUserUpload(sessionId, pendingId);
  }
}

function collectRetainedToolUseIds(messages: ChatMessage[]): Set<string> {
  const retained = new Set<string>();
  for (const message of messages) {
    if (message.parentToolUseId) retained.add(message.parentToolUseId);
    for (const block of message.contentBlocks || []) {
      if (block.type === "tool_use" && block.id) retained.add(block.id);
    }
  }
  return retained;
}

function resetAuthoritativeHistoryState(
  sessionId: string,
  options?: { preserveToolStateIds?: Iterable<string> },
): void {
  const store = useStore.getState();
  store.resetSessionForAuthoritativeHistory(sessionId, options);
}

/** Resolve a pending message-index scroll from deep link navigation (session:N:M). */
function resolvePendingMessageScroll(sessionId: string, messages: ChatMessage[]): void {
  const store = useStore.getState();

  // Resolve pending message ID scroll (from /msg/<id> deep links in new tabs).
  const pendingMsgId = store.pendingScrollToMessageId.get(sessionId);
  if (pendingMsgId) {
    store.clearPendingScrollToMessageId(sessionId);
    store.requestScrollToMessage(sessionId, pendingMsgId);
    store.setExpandAllInTurn(sessionId, pendingMsgId);
    return; // ID-based scroll takes precedence over index-based
  }

  // Resolve pending message index scroll (from legacy ?msg=N deep links).
  const pendingIdx = store.pendingScrollToMessageIndex.get(sessionId);
  if (pendingIdx == null) return;
  const hasRawHistoryIndexes = messages.some((msg) => typeof msg.historyIndex === "number");
  const targetMsg = hasRawHistoryIndexes
    ? messages.find((msg) => msg.historyIndex === pendingIdx)
    : messages[pendingIdx];
  if (!targetMsg) return;

  store.clearPendingScrollToMessageIndex(sessionId);
  store.requestScrollToMessage(sessionId, targetMsg.id);
  store.setExpandAllInTurn(sessionId, targetMsg.id);
}

function historyWindowStartIndex(data: Extract<BrowserIncomingMessage, { type: "history_window_sync" }>): number {
  const startIndex = data.window.start_index;
  return typeof startIndex === "number" && Number.isFinite(startIndex) ? Math.max(0, Math.floor(startIndex)) : 0;
}

function handleParsedMessage(sessionId: string, data: BrowserIncomingMessage, deps: WsMessageHandlerDeps) {
  const store = useStore.getState();

  switch (data.type) {
    case "session_init": {
      const existingSession = store.sessions.get(sessionId);
      store.addSession(data.session);
      // Do NOT set cliConnected here — session_init is just a state snapshot.
      // Connection status comes from explicit backend_connected/backend_disconnected messages.
      if (!existingSession) {
        store.setSessionStatus(sessionId, "idle");
      }
      if (!store.sessionNames.has(sessionId)) {
        const existingNames = new Set(store.sessionNames.values());
        const name = generateUniqueSessionName(existingNames);
        store.setSessionName(sessionId, name);
      }
      // Sync askPermission from server state
      if (typeof data.session.askPermission === "boolean") {
        store.setAskPermission(sessionId, data.session.askPermission);
      }
      // Restore quest name and styling from persisted session state (on reconnect).
      // This is the most reliable path since session_init fires on every WS connect.
      const isOrchestrator = data.session.isOrchestrator === true;
      if (
        data.session.claimedQuestId &&
        data.session.claimedQuestTitle &&
        !isOrchestrator &&
        questOwnsSessionName(data.session.claimedQuestStatus)
      ) {
        store.setSessionName(sessionId, data.session.claimedQuestTitle);
        store.markQuestNamed(sessionId);
      } else if (
        data.session.claimedQuestId &&
        !isOrchestrator &&
        questOwnsSessionName(data.session.claimedQuestStatus)
      ) {
        store.markQuestNamed(sessionId);
      } else {
        store.clearQuestNamed(sessionId);
      }
      break;
    }

    case "session_update": {
      store.updateSession(sessionId, data.session);
      // Sync askPermission if updated
      if (typeof data.session.askPermission === "boolean") {
        store.setAskPermission(sessionId, data.session.askPermission);
      }
      // Sync session name if included (e.g. after a rename via REST API)
      if (typeof (data.session as Record<string, unknown>).name === "string") {
        store.setSessionName(sessionId, (data.session as Record<string, unknown>).name as string);
      }
      // Sync server-authoritative attention state
      if (data.session.attentionReason !== undefined) {
        const isViewing = useStore.getState().currentSessionId === sessionId;
        if (isViewing && data.session.attentionReason) {
          // User is viewing this session — suppress badge, tell server we've read it
          api.markSessionRead?.(sessionId).catch(() => {});
        } else {
          const sessionAttention = new Map(useStore.getState().sessionAttention);
          sessionAttention.set(sessionId, data.session.attentionReason ?? null);
          useStore.setState({ sessionAttention });
        }
      }
      break;
    }

    case "session_activity_update": {
      const targetSessionId = data.session_id;
      if (!targetSessionId) break;
      const update = data.session ?? {};
      store.updateSdkSession(targetSessionId, {
        ...(update.attentionReason !== undefined ? { attentionReason: update.attentionReason } : {}),
        ...(update.lastReadAt !== undefined ? { lastReadAt: update.lastReadAt } : {}),
        ...(update.pendingPermissionCount !== undefined
          ? { pendingPermissionCount: update.pendingPermissionCount }
          : {}),
        ...(update.pendingPermissionSummary !== undefined
          ? { pendingPermissionSummary: update.pendingPermissionSummary }
          : {}),
      });
      if (update.status !== undefined) {
        store.setSessionStatus(targetSessionId, update.status === "compacting" ? "compacting" : update.status);
      }
      if (update.attentionReason !== undefined) {
        const isViewing = useStore.getState().currentSessionId === targetSessionId;
        if (isViewing && update.attentionReason) {
          api.markSessionRead?.(targetSessionId).catch(() => {});
        } else {
          const sessionAttention = new Map(useStore.getState().sessionAttention);
          sessionAttention.set(targetSessionId, update.attentionReason ?? null);
          useStore.setState({ sessionAttention });
        }
      }
      break;
    }

    case "codex_pending_inputs": {
      store.setPendingCodexInputs(sessionId, data.inputs);
      break;
    }

    case "codex_pending_input_cancelled": {
      const fallbackImages = data.input.draftImages?.length
        ? data.input.draftImages.map((img) => ({
            ...createComposerDraftImage(
              {
                name: img.name,
                base64: img.base64,
                mediaType: img.mediaType,
              },
              { status: "uploading" },
            ),
          }))
        : (data.input.clientMsgId
            ? useStore.getState().getPendingUserUploadRestoration(sessionId, data.input.clientMsgId)?.images
            : undefined) || [];
      store.setComposerDraft(sessionId, {
        text: data.input.content,
        images: fallbackImages,
      });
      break;
    }

    case "vscode_selection_state": {
      store.setVsCodeSelectionContext(data.state);
      break;
    }

    case "assistant": {
      const msg = data.message;
      const textContent = extractTextFromBlocks(msg.content);
      const chatMsg: ChatMessage = {
        id: msg.id,
        role: "assistant",
        content: textContent,
        contentBlocks: msg.content,
        timestamp: data.timestamp || Date.now(),
        parentToolUseId: data.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
        turnDurationMs: data.turn_duration_ms,
        cliUuid: (data as Record<string, unknown>).uuid as string | undefined,
        ...(data.notification ? { notification: data.notification } : {}),
      };
      // Server accumulates content blocks for same-ID messages (parallel tool calls).
      // If this ID already exists, merge content blocks rather than replace — this
      // handles both accumulated messages (server sends full set) and non-accumulated
      // messages (old server sends partial blocks) correctly.
      const existingMsgs = store.messages.get(sessionId) || [];
      const existing = msg.id ? existingMsgs.find((m) => m.id === msg.id) : undefined;
      if (existing) {
        const mergedBlocks = mergeContentBlocks(existing.contentBlocks || [], msg.content || []);
        store.updateMessage(sessionId, msg.id!, {
          content: extractTextFromBlocks(mergedBlocks),
          contentBlocks: mergedBlocks,
          timestamp: data.timestamp || existing.timestamp,
          stopReason: msg.stop_reason || existing.stopReason,
          ...(data.notification ? { notification: data.notification } : {}),
          ...(typeof data.turn_duration_ms === "number" ? { turnDurationMs: data.turn_duration_ms } : {}),
        });
      } else {
        store.appendMessage(sessionId, chatMsg);
      }
      store.setStreaming(sessionId, null, data.parent_tool_use_id);
      if (msg.content?.some((block) => block.type === "thinking")) {
        store.setStreamingThinking(sessionId, null, data.parent_tool_use_id);
      }
      // Clear progress only for completed tools (tool_result blocks), not all tools.
      // Blanket clear would cause flickering during concurrent tool execution.
      if (msg.content?.length) {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            store.clearToolProgress(sessionId, block.tool_use_id);
          }
        }
      }
      // Rebroadcasted assistant messages with turn_duration_ms arrive AFTER the
      // turn completes (post-result). Don't flip status to "running" for those —
      // the result handler will set "idle" momentarily, but setting "running" here
      // causes a brief incorrect status flicker.
      if (typeof data.turn_duration_ms !== "number") {
        store.setSessionStatus(sessionId, "running");
      }

      // Store server-provided tool start timestamps for live duration display
      if (data.tool_start_times && typeof data.tool_start_times === "object") {
        store.setToolStartTimestamps(sessionId, data.tool_start_times as Record<string, number>);
      }

      // Start timer if not already started (for non-streaming tool calls)
      if (!store.streamingStartedAt.has(sessionId)) {
        store.setStreamingStats(sessionId, { startedAt: Date.now() });
      }

      // Extract tasks and changed files from tool_use content blocks
      if (msg.content?.length) {
        extractTasksFromBlocks(sessionId, msg.content);
        extractChangedFilesFromBlocks(sessionId, msg.content);
      }

      break;
    }

    case "stream_event": {
      const evt = data.event as Record<string, unknown>;
      if (evt && typeof evt === "object") {
        // message_start → mark generation start time
        if (evt.type === "message_start") {
          if (!store.streamingStartedAt.has(sessionId)) {
            store.setStreamingStats(sessionId, { startedAt: Date.now(), outputTokens: 0 });
          }
        }

        if (evt.type === "content_block_start") {
          const block = evt.content_block as Record<string, unknown> | undefined;
          if (block?.type === "thinking") {
            store.setStreamingThinking(
              sessionId,
              typeof block.thinking === "string" ? block.thinking : "",
              data.parent_tool_use_id,
            );
          }
        }

        // content_block_delta → accumulate streaming text
        if (evt.type === "content_block_delta") {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const parentToolUseId = data.parent_tool_use_id;
            const current = parentToolUseId
              ? store.streamingByParentToolUseId.get(sessionId)?.get(parentToolUseId) || ""
              : store.streaming.get(sessionId) || "";
            store.setStreaming(sessionId, current + delta.text, parentToolUseId);
          }
          if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            const parentToolUseId = data.parent_tool_use_id;
            const current = parentToolUseId
              ? store.streamingThinkingByParentToolUseId.get(sessionId)?.get(parentToolUseId) || ""
              : store.streamingThinking.get(sessionId) || "";
            store.setStreamingThinking(sessionId, current + delta.thinking, parentToolUseId);
          }
        }

        // message_delta → extract output token count
        if (evt.type === "message_delta") {
          const usage = (evt as { usage?: { output_tokens?: number } }).usage;
          if (usage?.output_tokens) {
            store.setStreamingStats(sessionId, { outputTokens: usage.output_tokens });
          }
        }
      }
      break;
    }

    case "result": {
      const r = data.data;
      const sessionUpdates: Partial<{
        total_cost_usd: number;
        num_turns: number;
        context_used_percent: number;
        total_lines_added: number;
        total_lines_removed: number;
      }> = {
        total_cost_usd: r.total_cost_usd,
        num_turns: r.num_turns,
      };
      // Forward lines changed if present
      if (typeof r.total_lines_added === "number") {
        sessionUpdates.total_lines_added = r.total_lines_added;
      }
      if (typeof r.total_lines_removed === "number") {
        sessionUpdates.total_lines_removed = r.total_lines_removed;
      }
      store.updateSession(sessionId, sessionUpdates);
      store.clearStreamingState(sessionId);
      store.clearToolProgress(sessionId);
      store.setSessionStatus(sessionId, "idle");
      store.setSessionStuck(sessionId, false);
      store.setTasks(sessionId, []);
      store.setSessionTaskPreview(sessionId, null);
      const notifyOnResult = shouldNotifyOnResult(sessionId, store);
      // Play notification sound if enabled and tab is not focused
      if (notifyOnResult && !document.hasFocus() && store.notificationSound) {
        const sdk = store.sdkSessions.find((s) => s.sessionId === sessionId);
        console.log(
          `[notification] result sound: session=${sessionId.slice(0, 8)} isOrch=${!!sdk?.isOrchestrator} herdedBy=${sdk?.herdedBy ?? "none"}`,
        );
        playNotificationSound();
      }
      if (notifyOnResult && !document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification("Session completed", "Claude finished the task", sessionId);
      }
      if (r.is_error && !data.interrupted) {
        const errorText = r.errors?.length ? r.errors.join(", ") : r.result || "An error occurred";
        const isContextLimit = errorText.toLowerCase().includes("prompt is too long");

        // If user tried /compact but it failed because context is full,
        // auto-recover by killing the CLI and relaunching with --resume.
        // The SDK protocol doesn't intercept slash commands from user messages,
        // so /compact gets treated as a regular prompt and overflows again.
        if (isContextLimit) {
          const msgs = store.messages.get(sessionId) || [];
          const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
          if (lastUserMsg?.content.trim().toLowerCase() === "/compact") {
            store.appendMessage(sessionId, {
              id: nextId(),
              role: "system",
              content: "Context is full — restarting session to compact...",
              timestamp: Date.now(),
              variant: "info",
              ephemeral: true,
            });
            fetch(`/api/sessions/${encodeURIComponent(sessionId)}/force-compact`, { method: "POST" }).catch(() => {
              store.appendMessage(sessionId, {
                id: nextId(),
                role: "system",
                content: `Error: ${errorText}`,
                timestamp: Date.now(),
                variant: "error",
                ephemeral: true,
              });
            });
            break;
          }
        }

        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Error: ${errorText}`,
          timestamp: Date.now(),
          variant: "error",
        });
      }
      store.commitMessagesAsFrozen(sessionId);
      break;
    }

    case "permission_request": {
      store.addPermission(sessionId, data.request);
      // If evaluating via LLM auto-approver, don't pause timer or notify —
      // the agent isn't waiting on the user yet.
      if (!data.request.evaluating) {
        store.pauseStreamingTimer(sessionId);
        if (!document.hasFocus() && store.notificationDesktop) {
          const req = data.request;
          console.log(`[notification] permission_request: session=${sessionId.slice(0, 8)} tool=${req.tool_name}`);
          sendBrowserNotification("Permission needed", `${req.tool_name}: approve or deny`, req.request_id);
        }
      }
      // Also extract tasks and changed files from permission requests
      const req = data.request;
      if (req.tool_name && req.input) {
        const permBlocks = [
          {
            type: "tool_use" as const,
            id: req.tool_use_id,
            name: req.tool_name,
            input: req.input,
          },
        ];
        extractTasksFromBlocks(sessionId, permBlocks);
        extractChangedFilesFromBlocks(sessionId, permBlocks);
      }
      break;
    }

    case "permission_cancelled": {
      store.removePermission(sessionId, data.request_id);
      break;
    }

    case "permission_denied": {
      if (data.request_id) store.removePermission(sessionId, data.request_id);
      const denialMsg: ChatMessage = {
        id: data.id,
        role: "system",
        content: data.summary,
        timestamp: data.timestamp,
        variant: "denied",
      };
      store.appendMessage(sessionId, denialMsg);
      break;
    }

    case "permission_approved": {
      // Delay permission removal slightly so the "Approved" stamping animation
      // has time to play before the component unmounts. The permission is already
      // resolved on the server — this delay is purely cosmetic (400ms matches
      // the paw-approve animation duration).
      const approvedReqId = data.request_id;
      if (approvedReqId) {
        setTimeout(() => store.removePermission(sessionId, approvedReqId), 400);
      }
      const approvedMsg: ChatMessage = {
        id: data.id,
        role: "system",
        content: data.summary,
        timestamp: data.timestamp,
        variant: "approved",
        ...(data.answers?.length ? { metadata: { answers: data.answers } } : {}),
      };
      store.appendMessage(sessionId, approvedMsg);
      break;
    }

    case "permission_auto_approved": {
      // Don't remove — mark as auto-approved so PermissionBanner can decide
      // whether to dismiss silently or show an "auto-approved" indicator
      // (depending on whether the user had expanded the evaluating dialog).
      store.markPermissionAutoApproved(sessionId, data.request_id, data.reason || "Auto-approved");
      // Summary shows what was approved; reason (LLM rationale) is passed via metadata
      // for separate rendering in the AutoApprovedChip.
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.summary ?? `Auto-approved: ${data.tool_name}`,
        timestamp: data.timestamp,
        variant: "approved",
        ephemeral: true,
        ...(data.reason ? { metadata: { autoApprovalReason: data.reason } } : {}),
      });
      break;
    }

    case "permission_auto_denied": {
      // LLM auto-approver declined — transition from evaluating to normal pending state.
      // The permission stays pending for the user (LLM deny = "not confident, ask human").
      store.updatePermissionEvaluating(sessionId, data.request_id, undefined);
      // NOW pause timer and send notification since this needs user attention
      store.pauseStreamingTimer(sessionId);
      if (!document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification("Permission needed", `${data.tool_name}: approve or deny`, data.request_id);
      }
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: `Auto-approver declined ${data.tool_name}: ${data.reason}`,
        timestamp: data.timestamp,
        variant: "info",
        ephemeral: true,
      });
      break;
    }

    case "permission_needs_attention": {
      // LLM evaluation deferred, failed, or timed out — transition to normal pending state.
      // Store the deferral reason so PermissionBanner can explain WHY.
      store.updatePermissionEvaluating(sessionId, data.request_id, undefined);
      if (data.reason) {
        store.updatePermissionDeferralReason(sessionId, data.request_id, data.reason);
      }
      store.pauseStreamingTimer(sessionId);
      if (!document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification(
          "Permission needed",
          data.reason || "Auto-approval evaluation finished — needs your input",
          data.request_id,
        );
      }
      break;
    }

    case "leader_group_idle": {
      console.log(
        `[notification] leader_group_idle: leader=${data.leader_label} members=${data.member_count} idle_for=${data.idle_for_ms}ms focus=${document.hasFocus()} sound=${store.notificationSound}`,
      );
      if (!document.hasFocus() && store.notificationSound) {
        playNotificationSound();
      }
      if (!document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification(
          "Leader group idle",
          `${data.leader_label} is idle and waiting for attention`,
          `leader-group-idle:${data.leader_session_id}`,
        );
      }
      break;
    }

    case "permission_evaluating_status": {
      // Auto-approver status transition (e.g., "queued" → "evaluating")
      store.updatePermissionEvaluating(sessionId, data.request_id, data.evaluating);
      break;
    }

    case "tool_progress": {
      store.setToolProgress(sessionId, data.tool_use_id, {
        toolName: data.tool_name,
        elapsedSeconds: data.elapsed_time_seconds,
        outputDelta: typeof data.output_delta === "string" ? data.output_delta : undefined,
      });
      break;
    }

    case "tool_use_summary": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.summary,
        timestamp: Date.now(),
        ephemeral: true,
      });
      break;
    }

    case "tool_result_preview": {
      for (const preview of data.previews) {
        const retainedProgress = store.toolProgress.get(sessionId)?.get(preview.tool_use_id);
        const shouldRetainTerminalTranscript =
          store.sessions.get(sessionId)?.backend_type === "codex" && retainedProgress?.toolName === "Bash";
        store.setToolResult(sessionId, preview.tool_use_id, preview);
        // Preserve completed Codex Bash output so the inline card can keep the
        // captured transcript after the live terminal chip disappears.
        if (!shouldRetainTerminalTranscript) {
          store.clearToolProgress(sessionId, preview.tool_use_id);
        }
      }
      break;
    }

    case "user_message": {
      // Server-authoritative: user messages are broadcast by the server to all
      // browsers. The browser never adds user messages to the store locally.
      const pendingUpload =
        typeof data.client_msg_id === "string"
          ? useStore.getState().consumePendingUserUpload(sessionId, data.client_msg_id)
          : null;
      const userMsg: ChatMessage = {
        id: data.id || nextId(),
        role: "user",
        content: data.content,
        timestamp: data.timestamp || Date.now(),
        ...(data.images?.length ? { images: data.images } : {}),
        ...(pendingUpload?.images?.length
          ? {
              localImages: pendingUpload.images.map(({ name, base64, mediaType }) => ({
                name,
                base64,
                mediaType,
              })),
            }
          : {}),
        ...(typeof data.client_msg_id === "string" ? { clientMsgId: data.client_msg_id } : {}),
        ...(data.vscodeSelection ? { metadata: { vscodeSelection: data.vscodeSelection } } : {}),
        ...(data.agentSource ? { agentSource: data.agentSource } : {}),
      };
      store.appendMessage(sessionId, userMsg);
      store.setSessionPreview(sessionId, data.content.slice(0, 80));
      break;
    }

    case "status_change": {
      if (data.status === "compacting") {
        store.setSessionStatus(sessionId, "compacting");
      } else {
        store.setSessionStatus(sessionId, data.status);
      }
      // Any status change clears stuck flag
      store.setSessionStuck(sessionId, false);
      break;
    }

    case "session_stuck": {
      store.setSessionStuck(sessionId, true);
      break;
    }

    case "session_unstuck": {
      store.setSessionStuck(sessionId, false);
      break;
    }

    case "session_deleted": {
      // Another browser or the API deleted a session — remove it from the store
      // so the sidebar updates immediately without waiting for the next poll.
      // Also disconnect the WebSocket to prevent reconnect attempts.
      const deletedId = data.session_id;
      if (deletedId && typeof deletedId === "string") {
        console.log(`[ws] session_deleted: removing ${deletedId} from store`);
        store.removeSession(deletedId);
        deps.disconnectSession(deletedId);
      }
      break;
    }

    case "session_created": {
      // Another browser or the API created a session — debounce the refresh
      // to coalesce rapid bursts (e.g., multiple sessions created in quick succession).
      const createdId = data.session_id;
      if (createdId && typeof createdId === "string") {
        if (sessionCreatedTimer) clearTimeout(sessionCreatedTimer);
        sessionCreatedTimer = setTimeout(() => {
          sessionCreatedTimer = null;
          api
            .listSessions()
            .then((list) => {
              store.setSdkSessions(list);
            })
            .catch((err) => {
              console.warn("[ws] Failed to refresh sessions after session_created:", err);
            });
        }, 1_000);
      }
      break;
    }

    case "notification_anchored": {
      // Stamp the notification onto the matching assistant message in the store
      // so the chat feed can render a visual marker.
      const targetId = data.messageId;
      if (targetId) {
        store.updateMessage(sessionId, targetId, {
          notification: data.notification,
        });
      }
      break;
    }

    case "board_updated": {
      // Update Zustand board state so the persistent WorkBoardBar widget
      // and any future live-updating inline boards stay current.
      store.setSessionBoard(sessionId, data.board ?? []);
      store.setSessionCompletedBoard(sessionId, data.completedBoard ?? []);
      break;
    }

    case "timer_update": {
      // Server-authoritative timer list for this session.
      store.setSessionTimers(sessionId, data.timers ?? []);
      break;
    }

    case "notification_update": {
      // Server-authoritative notification inbox for this session.
      const newNotifications = data.notifications ?? [];
      const oldNotifications = store.sessionNotifications?.get(sessionId) ?? [];

      // Detect newly added unaddressed notifications by comparing IDs
      const oldIds = new Set(oldNotifications.map((n: { id: string }) => n.id));
      const added = newNotifications.filter((n: { id: string; done: boolean }) => !n.done && !oldIds.has(n.id));

      store.setSessionNotifications(sessionId, newNotifications);

      // Play differentiated sounds for new notifications (when tab is not focused).
      // Debounce to prevent overlapping sounds from rapid notification_update messages.
      const now = Date.now();
      if (
        added.length > 0 &&
        !document.hasFocus() &&
        store.notificationSound &&
        now - lastNotificationSoundAt >= NOTIFICATION_SOUND_DEBOUNCE_MS
      ) {
        lastNotificationSoundAt = now;
        const hasNeedsInput = added.some((n: { category: string }) => n.category === "needs-input");
        if (hasNeedsInput) {
          playNeedsInputSound();
        } else {
          playReviewSound();
        }
      }
      break;
    }

    case "permissions_cleared": {
      store.clearPermissions(sessionId);
      break;
    }

    case "state_snapshot": {
      // Authoritative state from server — overrides any stale transient state
      store.setSessionStatus(sessionId, data.sessionStatus as "idle" | "running" | "compacting" | "reverting" | null);
      store.setCliConnected(sessionId, data.backendConnected);
      // state_snapshot is sent after subscribe replay completes. If no
      // message_history/history_sync arrived, this was an empty-history
      // session and the optimistic loading placeholder should be cleared.
      store.setHistoryLoading(sessionId, false);
      if (data.backendState !== undefined || data.backendError !== undefined) {
        store.updateSession(sessionId, {
          ...(data.backendState !== undefined ? { backend_state: data.backendState } : {}),
          ...(data.backendError !== undefined ? { backend_error: data.backendError } : {}),
        });
      }
      if (data.backendConnected) store.setCliEverConnected(sessionId);
      if (data.askPermission !== undefined) {
        store.setAskPermission(sessionId, data.askPermission);
      }
      // Clear stale streaming state when session is not actively generating.
      // This handles: server restart (event_replay sets stale timers),
      // CLI crash mid-generation, and any other state desync.
      if (data.sessionStatus !== "running") {
        store.clearStreamingState(sessionId);
        store.clearToolProgress(sessionId);
        store.setSessionStuck(sessionId, false);
      } else if (data.generationStartedAt && !store.streamingStartedAt.has(sessionId)) {
        // Restore generation timer from server so switching sessions
        // doesn't reset the "Purring..." counter.
        store.setStreamingStats(sessionId, { startedAt: data.generationStartedAt });
      }
      // Sync server-authoritative attention state
      if (data.attentionReason !== undefined) {
        const isViewing = useStore.getState().currentSessionId === sessionId;
        if (isViewing && data.attentionReason) {
          api.markSessionRead?.(sessionId).catch(() => {});
        } else {
          const sessionAttention = new Map(useStore.getState().sessionAttention);
          sessionAttention.set(sessionId, data.attentionReason ?? null);
          useStore.setState({ sessionAttention });
        }
      }
      // Sync board state from server on connect/reconnect
      if (data.board) {
        store.setSessionBoard(sessionId, data.board);
      }
      if (data.completedBoard) {
        store.setSessionCompletedBoard(sessionId, data.completedBoard);
      }
      // Sync notification inbox from server on connect/reconnect
      if (data.notifications) {
        store.setSessionNotifications(sessionId, data.notifications);
      }
      break;
    }

    case "auth_status": {
      if (data.error) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Auth error: ${data.error}`,
          timestamp: Date.now(),
          variant: "error",
          ephemeral: true,
        });
      }
      break;
    }

    case "error": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.message,
        timestamp: Date.now(),
        variant: "error",
        ephemeral: true,
      });
      break;
    }

    case "backend_disconnected": {
      clearPendingCliDisconnect(sessionId);
      const reason = data.reason ?? null;
      const timer = setTimeout(() => {
        pendingCliDisconnectTimers.delete(sessionId);
        applyCliDisconnected(sessionId, reason);
      }, CLI_DISCONNECT_DEBOUNCE_MS);
      pendingCliDisconnectTimers.set(sessionId, timer);
      break;
    }

    case "backend_connected": {
      clearPendingCliDisconnect(sessionId);
      store.setCliConnected(sessionId, true);
      break;
    }

    case "tree_groups_update": {
      const groups = Array.isArray(data.treeGroups) ? data.treeGroups : [];
      const assignments =
        data.treeAssignments && typeof data.treeAssignments === "object"
          ? (data.treeAssignments as Record<string, string>)
          : {};
      const nodeOrder =
        data.treeNodeOrder && typeof data.treeNodeOrder === "object"
          ? (data.treeNodeOrder as Record<string, string[]>)
          : {};
      store.setTreeGroups(groups, assignments, nodeOrder);
      break;
    }

    case "session_name_update": {
      // Server is authoritative for all name updates (auto-naming, manual rename, etc.)
      const prevName = store.sessionNames.get(sessionId);
      const claimedQuest = store.sessions.get(sessionId);
      const claimedQuestStatus = claimedQuest?.claimedQuestStatus;
      const claimedQuestTitle = claimedQuest?.claimedQuestTitle;
      console.log(
        `[ws] session_name_update for ${sessionId}: "${prevName}" → "${data.name}" source=${(data as Record<string, unknown>).source ?? "none"}`,
      );
      // When a quest is actively claiming the session name, ignore non-quest name updates
      // (prevents auto-namer race conditions from overwriting the quest title)
      if (
        store.questNamedSessions.has(sessionId) &&
        data.source !== "quest" &&
        questOwnsSessionName(claimedQuestStatus) &&
        (!claimedQuestTitle || data.name === claimedQuestTitle)
      ) {
        console.log(`[ws] Ignoring non-quest name update for quest-named session ${sessionId}`);
        break;
      }
      if (prevName !== data.name) {
        store.setSessionName(sessionId, data.name);
        store.markRecentlyRenamed(sessionId);
      }
      // Track whether this name was set by a quest claim (for amber styling)
      if (
        data.source === "quest" ||
        (questOwnsSessionName(claimedQuestStatus) && !!claimedQuestTitle && data.name === claimedQuestTitle)
      ) {
        store.markQuestNamed(sessionId);
      } else {
        store.clearQuestNamed(sessionId);
      }
      break;
    }

    case "session_task_history": {
      store.setSessionTaskHistory(sessionId, data.tasks);
      break;
    }

    case "pr_status_update": {
      store.setPRStatus(sessionId, { available: data.available, pr: data.pr });
      break;
    }

    case "compact_boundary": {
      // CLI has compacted — preserve existing messages and insert a compact marker divider
      const markerTs = typeof data.timestamp === "number" ? data.timestamp : Date.now();
      const markerId = data.id || `compact-boundary-${markerTs}`;
      store.appendMessage(sessionId, {
        id: markerId,
        role: "system",
        content: "Conversation compacted",
        timestamp: markerTs,
        variant: "info",
      });
      break;
    }

    case "compact_summary": {
      // Update the most recent compact marker with the full summary text
      const msgs = store.messages.get(sessionId) || [];
      const lastCompact = [...msgs].reverse().find((m) => m.role === "system" && m.id.startsWith("compact-boundary-"));
      if (lastCompact) {
        store.updateMessage(sessionId, lastCompact.id, { content: data.summary });
      }
      break;
    }

    case "mcp_status": {
      store.setMcpServers(sessionId, data.servers);
      break;
    }

    case "task_notification": {
      if (data.tool_use_id) {
        store.setBackgroundAgentNotif(sessionId, data.tool_use_id, {
          status: data.status,
          outputFile: data.output_file,
          summary: data.summary,
        });
      }
      // Add a visible system message so the user can see what background task
      // completed and why the model may start a new auto-triggered turn.
      if (data.summary) {
        store.appendMessage(sessionId, {
          id: `task-notif-${data.task_id || Date.now()}`,
          role: "system",
          content: data.summary,
          timestamp: Date.now(),
          variant: "task_completed",
        });
      }
      break;
    }

    case "quest_list_updated": {
      store.refreshQuests({ background: true, force: true });
      break;
    }

    case "session_quest_claimed": {
      console.log(`[ws] session_quest_claimed for ${sessionId}:`, data.quest);
      const prevStatus = store.sessions.get(sessionId)?.claimedQuestStatus;
      const prevQuestId = store.sessions.get(sessionId)?.claimedQuestId;
      const prevTitle = store.sessions.get(sessionId)?.claimedQuestTitle;
      store.updateSession(sessionId, {
        claimedQuestId: data.quest?.id ?? undefined,
        claimedQuestTitle: data.quest?.title ?? undefined,
        claimedQuestStatus: data.quest?.status ?? undefined,
      });
      const isOrchestrator =
        store.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.isOrchestrator === true ||
        store.sessions.get(sessionId)?.isOrchestrator === true;
      if (data.quest?.id && data.quest?.title && questOwnsSessionName(data.quest?.status) && !isOrchestrator) {
        // Override session name with quest title and mark as quest-named
        // through review handoff so the checkbox prefix stays stable until
        // the quest claim is actually cleared.
        store.setSessionName(sessionId, data.quest.title);
        store.markRecentlyRenamed(sessionId);
        store.markQuestNamed(sessionId);
      } else {
        store.clearQuestNamed(sessionId);
      }
      // Insert a chat feed message for quest lifecycle events
      if (data.quest?.id) {
        const questId = data.quest.id;
        const isStatusChange = prevQuestId === questId && prevStatus && prevStatus !== data.quest.status;
        const isTitleOnly = prevQuestId === questId && !isStatusChange && prevTitle !== data.quest.title;
        // Title-only retitle: update existing quest chips instead of creating duplicates
        if (isTitleOnly) {
          store.updateQuestTitleInMessages(sessionId, questId, data.quest.title);
          break;
        }
        const isSubmitted = isStatusChange && data.quest.status === "needs_verification";
        const variant = isSubmitted ? ("quest_submitted" as const) : ("quest_claimed" as const);
        const label = isSubmitted ? "Quest submitted" : "Quest claimed";
        // Only insert chat message for new claims or submission — skip redundant status updates
        if (!isStatusChange || isSubmitted) {
          api
            .getQuest(questId)
            .then((quest) => {
              const questMeta: ChatMessage["metadata"] = {
                quest: {
                  questId: quest.questId,
                  title: quest.title,
                  description: "description" in quest ? quest.description : undefined,
                  status: quest.status,
                  tags: quest.tags,
                  images: quest.images,
                  verificationItems: "verificationItems" in quest ? quest.verificationItems : undefined,
                },
              };
              useStore.getState().appendMessage(sessionId, {
                id: `${variant}-${questId}-${Date.now()}`,
                role: "system",
                content: `${label}: ${quest.title}`,
                timestamp: Date.now(),
                variant,
                metadata: questMeta,
                ephemeral: true,
              });
            })
            .catch(() => {
              useStore.getState().appendMessage(sessionId, {
                id: `${variant}-${questId}-${Date.now()}`,
                role: "system",
                content: `${label}: ${data.quest!.title}`,
                timestamp: Date.now(),
                variant,
                ephemeral: true,
                metadata: {
                  quest: {
                    questId: questId,
                    title: data.quest!.title,
                    status: data.quest!.status ?? (isSubmitted ? "needs_verification" : "in_progress"),
                  },
                },
              });
            });
        }
      }
      break;
    }

    case "message_history": {
      resetAuthoritativeHistoryState(sessionId);
      const { chatMessages, frozenCount } = normalizeHistoryMessages(sessionId, data.messages);
      store.setMessages(sessionId, chatMessages, { frozenCount });
      clearPendingUploadsCoveredByHistory(sessionId, data.messages);
      store.setHistoryWindow(sessionId, null);
      store.setHistoryLoading(sessionId, false);
      if (chatMessages.length > 0) {
        store.setCliEverConnected(sessionId);
      }
      processedToolUseIds.delete(sessionId);
      taskCounters.delete(sessionId);
      updateSessionPreviewFromHistory(sessionId, data.messages);
      resolvePendingMessageScroll(sessionId, chatMessages);
      break;
    }

    case "history_sync": {
      const existingMessages = store.messages.get(sessionId) || [];
      const existingFrozenCount = Math.max(
        0,
        Math.min(store.messageFrozenCounts.get(sessionId) ?? 0, existingMessages.length),
      );
      const reusableFrozenCount = Math.max(0, Math.min(existingFrozenCount, data.frozen_base_count));
      const frozenPrefix = reusableFrozenCount > 0 ? existingMessages.slice(0, reusableFrozenCount) : [];
      const preservedToolStateIds = collectRetainedToolUseIds(frozenPrefix);
      resetAuthoritativeHistoryState(sessionId, { preserveToolStateIds: preservedToolStateIds });
      const { chatMessages: frozenDeltaMessages } = normalizeHistoryMessages(
        sessionId,
        data.frozen_delta,
        data.frozen_base_count,
      );
      const { chatMessages: hotMessages } = normalizeHistoryMessages(sessionId, data.hot_messages, data.frozen_count);
      const mergedMessages = [...frozenPrefix, ...frozenDeltaMessages, ...hotMessages];
      const nextFrozenCount = Math.max(
        frozenPrefix.length,
        Math.min(data.frozen_count, frozenPrefix.length + frozenDeltaMessages.length),
      );
      store.setMessages(sessionId, mergedMessages, {
        frozenCount: nextFrozenCount,
        frozenHash: data.expected_frozen_hash,
      });
      clearPendingUploadsCoveredByHistory(sessionId, [...data.frozen_delta, ...data.hot_messages]);
      store.setHistoryWindow(sessionId, null);
      store.setHistoryLoading(sessionId, false);
      if (mergedMessages.length > 0) {
        store.setCliEverConnected(sessionId);
      }
      processedToolUseIds.delete(sessionId);
      taskCounters.delete(sessionId);
      updateSessionPreviewFromHistory(sessionId, [...data.frozen_delta, ...data.hot_messages]);
      resolvePendingMessageScroll(sessionId, mergedMessages);
      break;
    }

    case "history_window_sync": {
      resetAuthoritativeHistoryState(sessionId);
      const { chatMessages, frozenCount } = normalizeHistoryMessages(
        sessionId,
        data.messages,
        historyWindowStartIndex(data),
      );
      store.setMessages(sessionId, chatMessages, { frozenCount });
      clearPendingUploadsCoveredByHistory(sessionId, data.messages);
      store.setHistoryWindow(sessionId, data.window);
      store.setHistoryLoading(sessionId, false);
      if (chatMessages.length > 0) {
        store.setCliEverConnected(sessionId);
      }
      processedToolUseIds.delete(sessionId);
      taskCounters.delete(sessionId);
      updateSessionPreviewFromHistory(sessionId, data.messages, {
        allowOlderHistory: data.window.from_turn + data.window.turn_count >= data.window.total_turns,
      });
      resolvePendingMessageScroll(sessionId, chatMessages);
      break;
    }
  }
}

export function createWsMessageHandler(deps: WsMessageHandlerDeps) {
  return (sessionId: string, data: BrowserIncomingMessage) => {
    handleParsedMessage(sessionId, data, deps);
  };
}
