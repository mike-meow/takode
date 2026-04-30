import type {
  BackendType,
  BrowserIncomingMessage,
  CLIResultMessage,
  CodexOutboundTurn,
  ContentBlock,
  ToolResultPreview,
} from "../session-types.js";
import type { CodexResumeTurnSnapshot } from "../codex-adapter.js";
import { sessionTag } from "../session-tag.js";
export interface ToolResultRecoverySessionLike {
  id: string;
  backendType: BackendType;
  messageHistory: BrowserIncomingMessage[];
  toolResults: Map<string, { content: string; is_error: boolean; timestamp: number }>;
  toolStartTimes: Map<string, number>;
  toolProgressOutput: Map<string, string>;
  codexToolResultWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
  codexAdapter: { isConnected(): boolean } | null;
}
export interface ToolResultRecoveryDeps {
  getToolUseBlockInHistory: (
    session: ToolResultRecoverySessionLike,
    toolUseId: string,
  ) => Extract<ContentBlock, { type: "tool_use" }> | null;
  hasToolResultPreviewReplay: (session: ToolResultRecoverySessionLike, toolUseId: string) => boolean;
  clearCodexToolResultWatchdog: (session: ToolResultRecoverySessionLike, toolUseId: string) => void;
  broadcastToBrowsers: (session: ToolResultRecoverySessionLike, msg: BrowserIncomingMessage) => void;
  persistSession: (session: ToolResultRecoverySessionLike) => void;
  getCodexTurnInRecovery: (
    session: ToolResultRecoverySessionLike,
  ) => { resumeConfirmedAt: number | null; disconnectedAt: number | null } | null;
  codexToolResultWatchdogMs: number;
  takodeBoardResultPreviewLimit: number;
  defaultToolResultPreviewLimit: number;
}
export function clearCodexToolResultWatchdog(session: ToolResultRecoverySessionLike, toolUseId: string): void {
  const timer = session.codexToolResultWatchdogs.get(toolUseId);
  if (!timer) return;
  clearTimeout(timer);
  session.codexToolResultWatchdogs.delete(toolUseId);
}
export function clearAllCodexToolResultWatchdogs(session: ToolResultRecoverySessionLike): void {
  for (const timer of session.codexToolResultWatchdogs.values()) {
    clearTimeout(timer);
  }
  session.codexToolResultWatchdogs.clear();
}
export function findToolUseBlockInHistory(
  session: ToolResultRecoverySessionLike,
  toolUseId: string,
): Extract<ContentBlock, { type: "tool_use" }> | null {
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    const msg = session.messageHistory[i];
    if (msg.type !== "assistant") continue;
    const content = (msg as { message?: { content?: ContentBlock[] } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.id === toolUseId) return block;
    }
  }
  return null;
}
export function getToolUseNameInHistory(session: ToolResultRecoverySessionLike, toolUseId: string): string | null {
  return findToolUseBlockInHistory(session, toolUseId)?.name ?? null;
}
export function shouldTrackCodexToolResultRecovery(block: Extract<ContentBlock, { type: "tool_use" }>): boolean {
  return !isCodexPlanningStateToolUse(block);
}
export function collectCompletedToolStartTimes(
  session: ToolResultRecoverySessionLike,
  toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
): number[] {
  const completedToolStartTimes: number[] = [];
  for (const block of toolResults) {
    const startedAt = session.toolStartTimes.get(block.tool_use_id);
    if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
      completedToolStartTimes.push(startedAt);
    }
  }
  return completedToolStartTimes;
}
export function emitSyntheticToolResultPreview(
  session: ToolResultRecoverySessionLike,
  toolUseId: string,
  content: string,
  isError: boolean,
  reason: string,
  deps: ToolResultRecoveryDeps,
): void {
  if (!session.toolStartTimes.has(toolUseId)) return;
  if (deps.hasToolResultPreviewReplay(session, toolUseId)) {
    deps.clearCodexToolResultWatchdog(session, toolUseId);
    session.toolStartTimes.delete(toolUseId);
    return;
  }
  deps.clearCodexToolResultWatchdog(session, toolUseId);

  const retainedOutput = session.toolProgressOutput.get(toolUseId)?.trim();
  if (retainedOutput) {
    content = retainedOutput;
  }

  const previewLimit = getToolResultPreviewLimit(session, toolUseId, deps);
  const totalSize = Buffer.byteLength(content, "utf-8");
  const isTruncated = content.length > previewLimit;
  const startedAt = session.toolStartTimes.get(toolUseId);
  const ageMs = startedAt != null ? Math.max(0, Date.now() - startedAt) : undefined;
  const durationSeconds = startedAt != null ? Math.round((Date.now() - startedAt) / 100) / 10 : undefined;
  session.toolStartTimes.delete(toolUseId);
  session.toolProgressOutput.delete(toolUseId);
  session.toolResults.set(toolUseId, {
    content,
    is_error: isError,
    timestamp: Date.now(),
  });

  const preview: ToolResultPreview = {
    tool_use_id: toolUseId,
    content: isTruncated ? content.slice(-previewLimit) : content,
    is_error: isError,
    total_size: totalSize,
    is_truncated: isTruncated,
    duration_seconds: durationSeconds,
  };
  const browserMsg: BrowserIncomingMessage = {
    type: "tool_result_preview",
    previews: [preview],
  };
  session.messageHistory.push(browserMsg);
  deps.broadcastToBrowsers(session, browserMsg);
  deps.persistSession(session);
  console.warn(
    `[ws-bridge] Synthesized tool_result_preview for orphaned tool ${toolUseId} in session ${sessionTag(session.id)} ` +
      `(${reason}; ageMs=${ageMs ?? "unknown"}; bytes=${totalSize}; retainedOutput=${retainedOutput ? "yes" : "no"})`,
  );
}
export function finalizeSupersededCodexTerminalTools(
  session: ToolResultRecoverySessionLike,
  completedToolStartTimes: number[],
  deps: ToolResultRecoveryDeps,
): void {
  if (session.backendType !== "codex") return;
  if (completedToolStartTimes.length === 0) return;

  const newestCompletedToolStart = Math.max(...completedToolStartTimes);
  const now = Date.now();
  for (const [toolUseId, startedAt] of [...session.toolStartTimes.entries()]) {
    if (!(startedAt < newestCompletedToolStart)) continue;
    if (getToolUseNameInHistory(session, toolUseId) !== "Bash") continue;
    if (now - startedAt < deps.codexToolResultWatchdogMs) continue;
    emitSyntheticToolResultPreview(
      session,
      toolUseId,
      "Terminal command did not deliver a final result after a later tool completed.",
      false,
      "superseded_by_later_completed_tool",
      deps,
    );
  }
}
export function getToolResultPreviewLimit(
  session: ToolResultRecoverySessionLike,
  toolUseId: string,
  deps: ToolResultRecoveryDeps,
): number {
  const block = deps.getToolUseBlockInHistory(session, toolUseId);
  if (!block || block.name !== "Bash") return deps.defaultToolResultPreviewLimit;
  const command = typeof block.input.command === "string" ? block.input.command.trim() : "";
  if (/^takode\s+board(?:\s|$)/.test(command)) {
    return deps.takodeBoardResultPreviewLimit;
  }
  return deps.defaultToolResultPreviewLimit;
}
export function pruneToolResultsForCurrentHistory(session: ToolResultRecoverySessionLike): void {
  if (session.toolResults.size === 0) return;
  const reachableToolUseIds = new Set<string>();
  for (const msg of session.messageHistory) {
    if (msg.type !== "tool_result_preview") continue;
    for (const preview of msg.previews || []) {
      reachableToolUseIds.add(preview.tool_use_id);
    }
  }
  const nextToolResults = new Map(
    [...session.toolResults.entries()].filter(([toolUseId]) => reachableToolUseIds.has(toolUseId)),
  );
  if (nextToolResults.size === session.toolResults.size) {
    const membershipUnchanged = [...session.toolResults.keys()].every((toolUseId) => nextToolResults.has(toolUseId));
    if (membershipUnchanged) return;
  }
  session.toolResults = nextToolResults;
}
export function collectUnresolvedToolStartTimesFromHistory(
  session: ToolResultRecoverySessionLike,
): Map<string, number> {
  const starts = new Map<string, number>();
  const resolved = new Set<string>();
  for (const msg of session.messageHistory) {
    if (msg.type === "assistant") {
      const toolUsesById = new Map<string, Extract<ContentBlock, { type: "tool_use" }>>();
      const content = (msg as { message?: { content?: ContentBlock[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.id) toolUsesById.set(block.id, block);
        }
      }

      const raw = (msg as Record<string, unknown>).tool_start_times;
      if (raw && typeof raw === "object") {
        for (const [toolUseId, ts] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
          const toolUse = toolUsesById.get(toolUseId);
          if (toolUse && !shouldTrackCodexToolResultRecovery(toolUse)) {
            starts.delete(toolUseId);
            continue;
          }
          const prev = starts.get(toolUseId);
          if (prev == null || ts < prev) starts.set(toolUseId, ts);
        }
      }
    } else if (msg.type === "tool_result_preview") {
      for (const preview of msg.previews || []) {
        if (typeof preview.tool_use_id === "string") {
          resolved.add(preview.tool_use_id);
        }
      }
    }
  }
  for (const toolUseId of resolved) {
    starts.delete(toolUseId);
  }
  return starts;
}
export function recoverToolStartTimesFromHistory(session: ToolResultRecoverySessionLike): void {
  const unresolved = collectUnresolvedToolStartTimesFromHistory(session);
  if (unresolved.size === 0) return;
  for (const [toolUseId, startedAt] of unresolved) {
    if (!session.toolStartTimes.has(toolUseId)) {
      session.toolStartTimes.set(toolUseId, startedAt);
    }
  }
}
export function finalizeRecoveredDisconnectedTerminalTools(
  session: ToolResultRecoverySessionLike,
  reason: string,
  deps: ToolResultRecoveryDeps,
): void {
  if (session.backendType !== "codex") return;
  const now = Date.now();
  for (const [toolUseId, startedAt] of session.toolStartTimes) {
    if (shouldDeferCodexToolResultWatchdog(session, toolUseId, deps)) continue;
    if (now - startedAt < deps.codexToolResultWatchdogMs) continue;
    if (getToolUseNameInHistory(session, toolUseId) !== "Bash") continue;
    emitSyntheticToolResultPreview(
      session,
      toolUseId,
      "Terminal command was interrupted while backend was disconnected; final output was not recovered.",
      true,
      reason,
      deps,
    );
  }
}
export function finalizeOrphanedTerminalToolsOnResult(
  session: ToolResultRecoverySessionLike,
  msg: CLIResultMessage,
  deps: ToolResultRecoveryDeps,
): void {
  if (session.backendType !== "codex") return;
  if (session.toolStartTimes.size === 0) return;
  const stopReason = typeof msg.stop_reason === "string" ? msg.stop_reason.toLowerCase() : "";
  const interrupted = stopReason.includes("interrupt") || stopReason.includes("cancel");
  const failed = !!msg.is_error || interrupted;
  for (const toolUseId of [...session.toolStartTimes.keys()]) {
    if (getToolUseNameInHistory(session, toolUseId) !== "Bash") continue;
    const content = interrupted
      ? "Terminal command was interrupted before the final tool result was delivered."
      : failed
        ? "Terminal command failed before the final tool result was delivered."
        : "Terminal command completed, but no output was captured.";
    emitSyntheticToolResultPreview(session, toolUseId, content, failed, "result_orphaned_terminal", deps);
  }
}
export function scheduleCodexToolResultWatchdogs(
  session: ToolResultRecoverySessionLike,
  reason: string,
  deps: ToolResultRecoveryDeps,
): void {
  if (session.backendType !== "codex") return;
  for (const toolUseId of [...session.toolStartTimes.keys()]) {
    const toolUse = deps.getToolUseBlockInHistory(session, toolUseId);
    if (toolUse && !shouldTrackCodexToolResultRecovery(toolUse)) {
      session.toolStartTimes.delete(toolUseId);
      session.toolProgressOutput.delete(toolUseId);
      continue;
    }
    if (session.codexToolResultWatchdogs.has(toolUseId)) continue;
    const timer = setTimeout(() => {
      session.codexToolResultWatchdogs.delete(toolUseId);
      if (!session.toolStartTimes.has(toolUseId)) return;
      if (shouldDeferCodexToolResultWatchdog(session, toolUseId, deps)) {
        scheduleCodexToolResultWatchdogs(session, "backend_connected", deps);
        return;
      }
      emitSyntheticToolResultPreview(
        session,
        toolUseId,
        "Tool call was interrupted by backend disconnect; final result was not recovered.",
        true,
        reason,
        deps,
      );
    }, deps.codexToolResultWatchdogMs);
    session.codexToolResultWatchdogs.set(toolUseId, timer);
  }
}
function isCodexPlanningStateToolUse(block: Extract<ContentBlock, { type: "tool_use" }>): boolean {
  return block.id.startsWith("codex-plan-") || block.name === "TodoWrite" || block.name === "TaskUpdate";
}
export function shouldDeferCodexToolResultWatchdog(
  session: ToolResultRecoverySessionLike,
  toolUseId: string,
  deps: ToolResultRecoveryDeps,
): boolean {
  if (!session.codexAdapter?.isConnected()) return false;
  const pending = deps.getCodexTurnInRecovery(session);
  if (!pending) return true;
  if (pending.resumeConfirmedAt == null) return true;
  if (pending.disconnectedAt == null) return true;
  const startedAt = session.toolStartTimes.get(toolUseId);
  if (typeof startedAt !== "number") return true;
  return startedAt > pending.disconnectedAt;
}
export function synthesizeCodexToolResultsFromResumedTurn(
  session: ToolResultRecoverySessionLike,
  turn: CodexResumeTurnSnapshot,
  pending: CodexOutboundTurn,
  deps: ToolResultRecoveryDeps,
): number {
  const turnStatus = typeof turn.status === "string" ? turn.status : null;
  if (!turnStatus || turnStatus === "inProgress") return 0;
  const disconnectedAt = pending.disconnectedAt ?? Date.now();
  const unresolvedToolIds = new Set<string>();
  for (const [toolUseId, startedAt] of session.toolStartTimes) {
    if (startedAt <= disconnectedAt) unresolvedToolIds.add(toolUseId);
  }
  if (unresolvedToolIds.size === 0) return 0;
  let synthesized = 0;
  for (const rawItem of turn.items) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const itemId = typeof item.id === "string" ? item.id : "";
    if (!itemId || !unresolvedToolIds.has(itemId)) continue;
    const itemType = typeof item.type === "string" ? item.type : "";
    const itemStatus = typeof item.status === "string" ? item.status : turnStatus;
    let isError = itemStatus === "failed" || itemStatus === "declined";
    let content = "";
    if (itemType === "commandExecution") {
      const output = firstNonEmptyString(item, [
        "stdout",
        "aggregatedOutput",
        "aggregated_output",
        "formatted_output",
        "output",
      ]);
      const stderr = firstNonEmptyString(item, ["stderr", "errorOutput", "error_output"]);
      const combinedOutput = [output, stderr].filter(Boolean).join("\n").trim();
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      if (exitCode !== null && exitCode !== 0) isError = true;
      if (combinedOutput) {
        content = combinedOutput;
        if (exitCode !== null && exitCode !== 0) {
          content = `${content}\nExit code: ${exitCode}`;
        }
      } else if (exitCode !== null) {
        content = `Command ${isError ? "failed" : "completed"} before reconnect recovery finished.\nExit code: ${exitCode}`;
      } else {
        content = `Command ${isError ? "failed" : "completed"} before reconnect recovery finished.`;
      }
    } else {
      content = `Tool call ${isError ? "failed" : "completed"} before reconnect recovery finished.`;
    }
    emitSyntheticToolResultPreview(session, itemId, content, isError, "resume_snapshot", deps);
    unresolvedToolIds.delete(itemId);
    synthesized++;
  }
  for (const toolUseId of unresolvedToolIds) {
    emitSyntheticToolResultPreview(
      session,
      toolUseId,
      `Tool call ${turnStatus} before reconnect recovery finished; final output was not recovered.`,
      turnStatus === "failed" || turnStatus === "declined",
      "resume_snapshot_fallback",
      deps,
    );
    synthesized++;
  }
  return synthesized;
}
export function buildToolResultPreviews(
  session: ToolResultRecoverySessionLike,
  toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  deps: ToolResultRecoveryDeps,
): ToolResultPreview[] {
  const previews: ToolResultPreview[] = [];
  for (const block of toolResults) {
    let resultContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    if (block.is_error && typeof block.content === "string") {
      resultContent = deduplicateCliErrorOutput(resultContent);
    }
    const previewLimit = getToolResultPreviewLimit(session, block.tool_use_id, deps);
    const totalSize = Buffer.byteLength(resultContent, "utf-8");
    const isTruncated = resultContent.length > previewLimit;
    const startTime = session.toolStartTimes.get(block.tool_use_id);
    const durationSeconds = startTime != null ? Math.round((Date.now() - startTime) / 100) / 10 : undefined;
    deps.clearCodexToolResultWatchdog(session, block.tool_use_id);
    session.toolStartTimes.delete(block.tool_use_id);
    session.toolProgressOutput.delete(block.tool_use_id);
    session.toolResults.set(block.tool_use_id, {
      content: resultContent,
      is_error: !!block.is_error,
      timestamp: Date.now(),
    });
    previews.push({
      tool_use_id: block.tool_use_id,
      content: isTruncated ? resultContent.slice(-previewLimit) : resultContent,
      is_error: !!block.is_error,
      total_size: totalSize,
      is_truncated: isTruncated,
      duration_seconds: durationSeconds,
    });
  }
  return previews;
}
export function getIndexedToolResult(
  session: ToolResultRecoverySessionLike,
  toolUseId: string,
): { content: string; is_error: boolean } | null {
  const indexed = session.toolResults.get(toolUseId);
  if (!indexed) return null;
  return { content: indexed.content, is_error: indexed.is_error };
}
function firstNonEmptyString(obj: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}
function deduplicateCliErrorOutput(content: string): string {
  const nlIdx = content.indexOf("\n");
  if (nlIdx < 0 || !content.startsWith("Exit code ")) return content;
  const body = content.slice(nlIdx + 1);
  let sepIdx = body.indexOf("\n\n");
  while (sepIdx >= 0) {
    if (body.slice(0, sepIdx) === body.slice(sepIdx + 2)) {
      return content.slice(0, nlIdx + 1) + body.slice(0, sepIdx);
    }
    sepIdx = body.indexOf("\n\n", sepIdx + 1);
  }
  return content;
}
