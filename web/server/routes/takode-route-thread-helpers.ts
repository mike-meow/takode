import { normalizeThreadTarget } from "../../shared/thread-routing.js";
import { type ThreadRouteMetadata, threadRouteForTarget } from "../thread-routing-metadata.js";

export function normalizeAffectedThreadKey(threadKey: string | undefined): string | null {
  const normalized = threadKey?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized;
}

export function normalizeNotifyThreadRoute(
  body: Record<string, unknown>,
): { ok: true; route?: ThreadRouteMetadata } | { ok: false; error: string } {
  const rawThreadKey = typeof body.threadKey === "string" ? body.threadKey.trim() : "";
  const rawQuestId = typeof body.questId === "string" ? body.questId.trim() : "";
  if (!rawThreadKey && !rawQuestId) return { ok: true };

  const threadTarget = rawThreadKey ? normalizeThreadTarget(rawThreadKey) : null;
  if (rawThreadKey && !threadTarget) return { ok: false, error: "threadKey must be main or q-N" };

  const questTarget = rawQuestId ? normalizeThreadTarget(rawQuestId) : null;
  if (rawQuestId && (!questTarget || questTarget.threadKey === "main")) {
    return { ok: false, error: "questId must be q-N" };
  }

  if (threadTarget && questTarget && threadTarget.threadKey !== questTarget.threadKey) {
    return { ok: false, error: "threadKey and questId must refer to the same thread" };
  }

  const target = threadTarget ?? questTarget;
  return target ? { ok: true, route: threadRouteForTarget(target.threadKey) } : { ok: true };
}
