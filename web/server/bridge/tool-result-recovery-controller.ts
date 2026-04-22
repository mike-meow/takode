import type {
  BackendType,
  BrowserIncomingMessage,
  CLIResultMessage,
  CodexOutboundTurn,
  ContentBlock,
  ToolResultPreview,
} from "../session-types.js";
import type { CodexResumeTurnSnapshot } from "../codex-adapter.js";
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
  clearCodexToolResultWatchdog: (session: ToolResultRecoverySessionLike, toolUseId: string) => void;
  emitSyntheticToolResultPreview: (
    session: ToolResultRecoverySessionLike,
    toolUseId: string,
    content: string,
    isError: boolean,
    reason: string,
  ) => void;
  getCodexTurnInRecovery: (
    session: ToolResultRecoverySessionLike,
  ) => { resumeConfirmedAt: number | null; disconnectedAt: number | null } | null;
  codexToolResultWatchdogMs: number;
  takodeBoardResultPreviewLimit: number;
  defaultToolResultPreviewLimit: number;
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
export function collectUnresolvedToolStartTimesFromHistory(session: ToolResultRecoverySessionLike): Map<string, number> {
  const starts = new Map<string, number>();
  const resolved = new Set<string>();
  for (const msg of session.messageHistory) {
    if (msg.type === "assistant") {
      const raw = (msg as Record<string, unknown>).tool_start_times;
      if (raw && typeof raw === "object") {
        for (const [toolUseId, ts] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
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
    const toolName = deps.getToolUseBlockInHistory(session, toolUseId)?.name ?? null;
    if (toolName !== "Bash") continue;
    deps.emitSyntheticToolResultPreview(
      session,
      toolUseId,
      "Terminal command was interrupted while backend was disconnected; final output was not recovered.",
      true,
      reason,
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
    const toolName = deps.getToolUseBlockInHistory(session, toolUseId)?.name ?? null;
    if (toolName !== "Bash") continue;
    const content = interrupted
      ? "Terminal command was interrupted before the final tool result was delivered."
      : failed
        ? "Terminal command failed before the final tool result was delivered."
        : "Terminal command completed, but no output was captured.";
    deps.emitSyntheticToolResultPreview(session, toolUseId, content, failed, "result_orphaned_terminal");
  }
}
export function scheduleCodexToolResultWatchdogs(
  session: ToolResultRecoverySessionLike,
  reason: string,
  deps: ToolResultRecoveryDeps,
): void {
  if (session.backendType !== "codex") return;
  for (const toolUseId of session.toolStartTimes.keys()) {
    if (session.codexToolResultWatchdogs.has(toolUseId)) continue;
    const timer = setTimeout(() => {
      session.codexToolResultWatchdogs.delete(toolUseId);
      if (!session.toolStartTimes.has(toolUseId)) return;
      if (shouldDeferCodexToolResultWatchdog(session, toolUseId, deps)) {
        scheduleCodexToolResultWatchdogs(session, "backend_connected", deps);
        return;
      }
      deps.emitSyntheticToolResultPreview(
        session,
        toolUseId,
        "Tool call was interrupted by backend disconnect; final result was not recovered.",
        true,
        reason,
      );
    }, deps.codexToolResultWatchdogMs);
    session.codexToolResultWatchdogs.set(toolUseId, timer);
  }
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
    deps.emitSyntheticToolResultPreview(session, itemId, content, isError, "resume_snapshot");
    unresolvedToolIds.delete(itemId);
    synthesized++;
  }
  for (const toolUseId of unresolvedToolIds) {
    deps.emitSyntheticToolResultPreview(
      session,
      toolUseId,
      `Tool call ${turnStatus} before reconnect recovery finished; final output was not recovered.`,
      turnStatus === "failed" || turnStatus === "declined",
      "resume_snapshot_fallback",
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
