import { Hono } from "hono";
import * as questStore from "../quest-store.js";
import type { QuestFeedbackEntry, QuestmasterTask } from "../quest-types.js";
import { hasQuestReviewMetadata } from "../quest-types.js";
import { applyQuestListFilters } from "../quest-list-filters.js";
import { SERVER_GIT_CMD } from "../constants.js";
import {
  addTaskEntry as addTaskEntryController,
  setSessionClaimedQuest as setSessionClaimedQuestController,
  updateQuestTaskEntries as updateQuestTaskEntriesController,
} from "../bridge/session-registry-controller.js";
import { broadcastQuestUpdate } from "./quest-helpers.js";
import type { OptionalAuthResult, RouteContext } from "./context.js";
import { isSharpUnavailableError, SHARP_UNAVAILABLE_MESSAGE } from "../image-store.js";
import { normalizeTldr, QUEST_TLDR_WARNING_HEADER, tldrWarningForContent } from "../quest-tldr.js";
import {
  QUEST_PHASE_DOCUMENTATION_WARNING_HEADER,
  resolveQuestFeedbackDocumentation,
  sameQuestFeedbackDocumentationScope,
  type QuestBoardRowCandidate,
} from "../quest-phase-docs.js";

const DIFF_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const SUMMARY_FEEDBACK_PREFIXES = ["summary:", "refreshed summary:"];

function normalizeRequestedCommitSha(value: string): string | null {
  const sha = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

function parseNumstatTotals(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of output.split("\n")) {
    const [add, del] = line.trim().split("\t");
    if (!add || !del) continue;
    additions += add === "-" ? 0 : Number.parseInt(add, 10) || 0;
    deletions += del === "-" ? 0 : Number.parseInt(del, 10) || 0;
  }

  return { additions, deletions };
}

function isAgentSummaryFeedback(text: string): boolean {
  const normalized = text.trimStart().toLowerCase();
  return SUMMARY_FEEDBACK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function findLatestAgentSummaryFeedbackIndex(entries: QuestFeedbackEntry[], target?: QuestFeedbackEntry): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.author !== "agent") continue;
    if (target && !sameQuestFeedbackDocumentationScope(entry, target)) continue;
    if (isAgentSummaryFeedback(entry.text)) return index;
  }
  return -1;
}

function setTldrWarningHeader(c: { header: (name: string, value: string) => void }, warning: string | null): void {
  if (warning) c.header(QUEST_TLDR_WARNING_HEADER, warning);
}

function isAuthenticatedCompanionCaller(
  auth: OptionalAuthResult,
): auth is Exclude<OptionalAuthResult, null | { response: Response }> {
  return auth !== null && !("response" in auth);
}

function setDescriptionTldrWarningHeaderForAgentWrite(
  c: { header: (name: string, value: string) => void },
  auth: OptionalAuthResult,
  description: unknown,
  tldr: unknown,
): void {
  if (!isAuthenticatedCompanionCaller(auth)) return;
  setTldrWarningHeader(c, tldrWarningForContent("description", description, tldr));
}

function feedbackEntryWithoutTldr(entry: QuestFeedbackEntry): QuestFeedbackEntry {
  const { tldr: _tldr, ...rest } = entry;
  return rest;
}

function questRepoCandidates(quest: QuestmasterTask, launcher: RouteContext["launcher"]): string[] {
  const sessionIds = [
    ...("sessionId" in quest && typeof quest.sessionId === "string" ? [quest.sessionId] : []),
    ...(Array.isArray(quest.previousOwnerSessionIds) ? quest.previousOwnerSessionIds : []),
  ];
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const sessionId of sessionIds) {
    const session = launcher.getSession(sessionId);
    if (!session) continue;
    for (const path of [session.repoRoot, session.cwd]) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }

  return paths;
}

function resolveClaimLeaderSessionId(
  launcher: RouteContext["launcher"],
  workerSession: { herdedBy?: string } | null | undefined,
): string | undefined {
  const leaderSessionId = typeof workerSession?.herdedBy === "string" ? workerSession.herdedBy.trim() : "";
  if (!leaderSessionId) return undefined;
  const leaderSession = launcher.getSession(leaderSessionId);
  return leaderSession?.isOrchestrator === true ? leaderSessionId : undefined;
}

export function createQuestRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, wsBridge, imageStore, authenticateCompanionCallerOptional, execCaptureStdoutAsync } = ctx;

  const setClaimedQuest = (
    sessionId: string,
    quest: {
      id: string;
      title: string;
      status?: string;
      verificationInboxUnread?: boolean;
      leaderSessionId?: string;
    } | null,
  ) => {
    const session = wsBridge.getSession(sessionId);
    if (!session) return;
    setSessionClaimedQuestController(session, quest, {
      broadcastToBrowsers: (_session, msg) => wsBridge.broadcastToSession(sessionId, msg as any),
      persistSession: () => wsBridge.persistSessionById(sessionId),
      getLauncherSessionInfo: (targetSessionId) => launcher.getSession(targetSessionId),
      onSessionNamedByQuest: (targetSessionId, title) =>
        (wsBridge as any).onSessionNamedByQuest?.(targetSessionId, title),
    });
  };
  const claimedQuestEvent = (quest: QuestmasterTask) => ({
    id: quest.questId,
    title: quest.title,
    status: quest.status,
    ...(hasQuestReviewMetadata(quest) ? { verificationInboxUnread: quest.verificationInboxUnread } : {}),
    ...(quest.leaderSessionId ? { leaderSessionId: quest.leaderSessionId } : {}),
  });
  const boardRowCandidatesForQuest = (quest: QuestmasterTask): QuestBoardRowCandidate[] => {
    const leaderIds = new Set<string>();
    if (quest.leaderSessionId) leaderIds.add(quest.leaderSessionId);
    for (const session of launcher.listSessions()) {
      const sessionId = typeof session.sessionId === "string" ? session.sessionId : undefined;
      if (sessionId && session.isOrchestrator === true && session.archived !== true) leaderIds.add(sessionId);
    }
    const candidates: QuestBoardRowCandidate[] = [];
    for (const leaderSessionId of leaderIds) {
      const leaderSession = launcher.getSession(leaderSessionId);
      if (leaderSession?.archived === true) continue;
      const row = wsBridge.getSession(leaderSessionId)?.board?.get(quest.questId);
      if (row) candidates.push({ leaderSessionId, row });
    }
    return candidates;
  };

  const persistSessionTaskHistory = (sessionId: string) => {
    const session = wsBridge.getSession(sessionId);
    if (!session) return;
    wsBridge.broadcastToSession(sessionId, { type: "session_task_history", tasks: session.taskHistory } as any);
    wsBridge.persistSessionById(sessionId);
  };

  // ─── Questmaster (~/.companion/questmaster/) ──────────────────────

  // ─── Quest image upload/serve ────────────────────────────────────
  // Must be registered before parameterized /:questId routes.

  api.post("/quests/_images", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") {
        return c.json({ error: "file field is required (multipart)" }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const image = await questStore.saveQuestImage(file.name, buf, file.type);
      return c.json(image, 201);
    } catch (e: unknown) {
      if (isSharpUnavailableError(e)) {
        return c.json({ error: SHARP_UNAVAILABLE_MESSAGE }, 503);
      }
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/quests/_images/:imageId", async (c) => {
    const result = await questStore.readQuestImageFile(c.req.param("imageId"));
    if (!result) return c.json({ error: "Image not found" }, 404);
    return new Response(new Uint8Array(result.data), {
      headers: {
        "Content-Type": result.mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  // Notification endpoint for the quest CLI tool — triggers browser refresh.
  // Must be registered before parameterized /:questId routes.
  api.post("/quests/_notify", (c) => {
    broadcastQuestUpdate(wsBridge);
    return c.json({ ok: true });
  });

  const transitionQuestAndSync = async (
    questId: string,
    input: import("../quest-types.js").QuestTransitionInput,
  ): Promise<import("../quest-types.js").QuestmasterTask | null> => {
    const current = await questStore.getQuest(questId);
    const currentSessionId =
      current && "sessionId" in current && typeof current.sessionId === "string" ? current.sessionId : null;
    const currentReviewOwnerSessionId =
      current && hasQuestReviewMetadata(current)
        ? (current.previousOwnerSessionIds?.[current.previousOwnerSessionIds.length - 1] ?? null)
        : null;
    const quest = await questStore.transitionQuest(questId, input);
    if (!quest) return null;

    const nextSessionId = "sessionId" in quest && typeof quest.sessionId === "string" ? quest.sessionId : null;
    if (currentSessionId && currentSessionId !== nextSessionId) {
      setClaimedQuest(currentSessionId, null);
    }
    if (currentReviewOwnerSessionId && !hasQuestReviewMetadata(quest)) {
      setClaimedQuest(currentReviewOwnerSessionId, null);
    }
    if (nextSessionId) {
      setClaimedQuest(nextSessionId, claimedQuestEvent(quest));
    } else if (hasQuestReviewMetadata(quest)) {
      const reviewOwner = quest.previousOwnerSessionIds?.[quest.previousOwnerSessionIds.length - 1];
      if (reviewOwner) {
        setClaimedQuest(reviewOwner, claimedQuestEvent(quest));
      }
    }

    broadcastQuestUpdate(wsBridge);
    return quest;
  };

  api.get("/quests", async (c) => {
    const parentId = c.req.query("parentId");
    const sessionId = c.req.query("sessionId");
    let quests = applyQuestListFilters(await questStore.listQuests(), {
      status: c.req.query("status"),
      verification: c.req.query("verification"),
      tags: c.req.query("tags"),
      tag: c.req.query("tag"),
      text: c.req.query("text"),
    });
    if (parentId) quests = quests.filter((q) => q.parentId === parentId);
    if (sessionId)
      quests = quests.filter((q) => {
        const activeOwner = "sessionId" in q ? (q as { sessionId?: string }).sessionId : undefined;
        const previousOwners = Array.isArray(q.previousOwnerSessionIds) ? q.previousOwnerSessionIds : [];
        return activeOwner === sessionId || previousOwners.includes(sessionId);
      });
    return c.json(quests);
  });

  api.get("/quests/:questId", async (c) => {
    const quest = await questStore.getQuest(c.req.param("questId"));
    if (!quest) return c.json({ error: "Quest not found" }, 404);
    return c.json(quest);
  });

  api.get("/quests/:questId/history", async (c) => {
    const history = await questStore.getQuestHistoryView(c.req.param("questId"));
    return c.json(history);
  });

  api.get("/quests/:questId/commits/:sha", async (c) => {
    const quest = await questStore.getQuest(c.req.param("questId"));
    if (!quest) return c.json({ error: "Quest not found" }, 404);

    const sha = normalizeRequestedCommitSha(c.req.param("sha"));
    if (!sha) return c.json({ error: "Invalid commit SHA" }, 400);
    if (!quest.commitShas?.some((storedSha) => storedSha.toLowerCase() === sha)) {
      return c.json({ error: "Commit not attached to this quest" }, 404);
    }

    const repoCandidates = questRepoCandidates(quest, launcher);
    if (repoCandidates.length === 0) {
      return c.json({ sha, available: false, reason: "repo_unavailable" });
    }

    for (const repoRoot of repoCandidates) {
      try {
        const fullSha = (
          await execCaptureStdoutAsync(`${SERVER_GIT_CMD} rev-parse --verify "${sha}^{commit}"`, repoRoot)
        ).trim();
        if (!fullSha) continue;
        const metadata = await execCaptureStdoutAsync(
          `${SERVER_GIT_CMD} show -s --format="%H%x00%h%x00%s%x00%ct" "${fullSha}"`,
          repoRoot,
        );
        if (!metadata.trim()) continue;
        const numstat = await execCaptureStdoutAsync(
          `${SERVER_GIT_CMD} show --format= --numstat --no-renames "${fullSha}"`,
          repoRoot,
        );
        let diff = await execCaptureStdoutAsync(
          `${SERVER_GIT_CMD} show --format= --patch --no-color "${fullSha}"`,
          repoRoot,
          { maxBuffer: DIFF_MAX_BUFFER },
        );
        let truncated = false;
        if (Buffer.byteLength(diff, "utf-8") > MAX_DIFF_BYTES) {
          diff = Buffer.from(diff, "utf-8").subarray(0, MAX_DIFF_BYTES).toString("utf-8");
          truncated = true;
        }

        const [resolvedSha, shortSha, message, ts] = metadata.trim().split("\0");
        if (!resolvedSha) continue;
        const totals = parseNumstatTotals(numstat);
        return c.json({
          sha: resolvedSha || fullSha,
          shortSha: shortSha || fullSha.slice(0, 7),
          message: message || "",
          timestamp: Number.parseInt(ts || "0", 10) * 1000,
          additions: totals.additions,
          deletions: totals.deletions,
          diff,
          truncated,
          available: true,
        });
      } catch {
        // Try the next known repo candidate for this quest.
      }
    }

    return c.json({ sha, available: false, reason: "commit_not_available" });
  });

  api.get("/quests/:questId/version/:versionId", async (c) => {
    const version = await questStore.getQuestVersion(c.req.param("versionId"));
    if (!version) return c.json({ error: "Version not found" }, 404);
    return c.json(version);
  });

  api.post("/quests", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    try {
      const quest = await questStore.createQuest(body);
      broadcastQuestUpdate(wsBridge);
      setDescriptionTldrWarningHeaderForAgentWrite(c, auth, body.description, body.tldr);
      return c.json(quest, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.patch("/quests/:questId", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    try {
      const quest = await questStore.patchQuest(c.req.param("questId"), body);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      if (
        typeof body.title === "string" &&
        "sessionId" in quest &&
        quest.status === "in_progress" &&
        typeof quest.sessionId === "string" &&
        body.title.trim().length > 0
      ) {
        // Keep quest-owned session names in sync when a claimed quest is retitled.
        // setSessionClaimedQuest broadcasts session_quest_claimed + session_name_update
        // source:quest, and persists the name via callback.
        setClaimedQuest(quest.sessionId, claimedQuestEvent(quest));
        // Update task history entries that reference this quest
        const session = wsBridge.getSession(quest.sessionId);
        if (session) {
          updateQuestTaskEntriesController(session, quest.questId, quest.title, {
            broadcastTaskHistory: () => persistSessionTaskHistory(quest.sessionId),
            persistSession: () => wsBridge.persistSessionById(quest.sessionId),
          });
        }
      }
      broadcastQuestUpdate(wsBridge);
      if (body.description !== undefined || body.tldr !== undefined) {
        const warningTldr =
          body.tldr !== undefined ? body.tldr : body.description !== undefined ? undefined : quest.tldr;
        const warningDescription =
          body.description !== undefined ? body.description : "description" in quest ? quest.description : undefined;
        setDescriptionTldrWarningHeaderForAgentWrite(c, auth, warningDescription, warningTldr);
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/transition", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    try {
      const questId = c.req.param("questId");
      const quest = await transitionQuestAndSync(questId, body);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      if (body.description !== undefined || body.tldr !== undefined) {
        const warningTldr =
          body.tldr !== undefined ? body.tldr : body.description !== undefined ? undefined : quest.tldr;
        const warningDescription =
          body.description !== undefined ? body.description : "description" in quest ? quest.description : undefined;
        setDescriptionTldrWarningHeaderForAgentWrite(c, auth, warningDescription, warningTldr);
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/quests/:questId", async (c) => {
    const questId = c.req.param("questId");
    const deleted = await questStore.deleteQuest(questId);
    if (!deleted) return c.json({ error: "Quest not found" }, 404);
    wsBridge.removeBoardRowFromAll(questId);
    broadcastQuestUpdate(wsBridge);
    return c.json({ ok: true });
  });

  api.post("/quests/:questId/claim", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    const rawSessionId = body.sessionId as string | undefined;
    const bodySessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
    const authSessionId = auth ? auth.callerId : "";
    if (authSessionId && bodySessionId && bodySessionId !== authSessionId) {
      return c.json({ error: "sessionId does not match authenticated caller" }, 403);
    }
    const sessionId = bodySessionId || authSessionId;
    if (!sessionId) {
      return c.json({ error: "sessionId is required (or provide Companion auth headers)" }, 400);
    }
    const knownSession = launcher.getSession(sessionId);
    if (!knownSession) {
      return c.json(
        {
          error:
            `Unknown sessionId: ${sessionId}. ` +
            "Claim a quest from an active Companion session or choose a valid session in Questmaster.",
        },
        400,
      );
    }
    // Hard enforcement: leader/orchestrator sessions cannot claim quests (q-87)
    if (knownSession.isOrchestrator) {
      return c.json({ error: "Leader sessions cannot claim quests. Dispatch to a worker instead." }, 403);
    }
    const leaderSessionId = resolveClaimLeaderSessionId(launcher, knownSession);
    try {
      const quest = await questStore.claimQuest(c.req.param("questId"), sessionId, {
        allowArchivedOwnerTakeover: true,
        isSessionArchived: (sid: string) => !!launcher.getSession(sid)?.archived,
        ...(leaderSessionId ? { leaderSessionId } : {}),
      });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      // setSessionClaimedQuest broadcasts session_quest_claimed + session_name_update
      // source:quest, cancels in-flight namers, and persists the name via callback.
      setClaimedQuest(sessionId, claimedQuestEvent(quest));
      console.log(`[quest-claim] Setting session name for ${sessionId} to "${quest.title}" (quest ${quest.questId})`);
      // Use the last user message as trigger so clicking the quest chip scrolls
      // to the user message that initiated the claim (matches auto-namer behavior).
      const session = wsBridge.getSession(sessionId);
      let triggerMsgId = "quest-" + quest.questId;
      if (session) {
        for (let i = session.messageHistory.length - 1; i >= 0; i--) {
          const m = session.messageHistory[i];
          if (m.type === "user_message" && m.id) {
            triggerMsgId = m.id;
            break;
          }
        }
      }
      const trackedSession = wsBridge.getSession(sessionId);
      if (trackedSession) {
        addTaskEntryController(
          trackedSession,
          {
            title: quest.title,
            action: "new",
            timestamp: Date.now(),
            triggerMessageId: triggerMsgId,
            source: "quest",
            questId: quest.questId,
          },
          {
            broadcastTaskHistory: () => persistSessionTaskHistory(sessionId),
            persistSession: () => wsBridge.persistSessionById(sessionId),
          },
        );
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/complete", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    const items = body.verificationItems as import("../quest-types.js").QuestVerificationItem[] | undefined;
    if (!items || !Array.isArray(items)) return c.json({ error: "verificationItems array is required" }, 400);
    const rawSessionId = body.sessionId as string | undefined;
    const bodySessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
    const authSessionId = auth ? auth.callerId : "";
    const authIsOrchestrator = auth ? auth.caller.isOrchestrator : false;
    if (authSessionId && bodySessionId && bodySessionId !== authSessionId && !authIsOrchestrator) {
      return c.json({ error: "sessionId does not match authenticated caller" }, 403);
    }
    const targetSessionId = bodySessionId;
    if (targetSessionId && !launcher.getSession(targetSessionId)) {
      return c.json({ error: "sessionId does not belong to a known companion session" }, 400);
    }
    try {
      if (authSessionId && !targetSessionId) {
        const currentQuest = await questStore.getQuest(c.req.param("questId"));
        if (!currentQuest) return c.json({ error: "Quest not found" }, 404);
        const currentOwnerSessionId =
          "sessionId" in currentQuest && typeof currentQuest.sessionId === "string" ? currentQuest.sessionId : "";
        if (currentOwnerSessionId && currentOwnerSessionId !== authSessionId && !authIsOrchestrator) {
          return c.json({ error: "Only leader sessions can complete a quest owned by another session" }, 403);
        }
      }
      const currentQuest = await questStore.getQuest(c.req.param("questId"));
      const currentOwnerSessionId =
        currentQuest && "sessionId" in currentQuest && typeof currentQuest.sessionId === "string"
          ? currentQuest.sessionId
          : "";
      const commitShas = Array.isArray(body.commitShas) ? body.commitShas : undefined;
      const quest = await questStore.completeQuest(c.req.param("questId"), items, {
        commitShas,
        ...(targetSessionId ? { sessionId: targetSessionId } : {}),
      });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      // Update session's quest status so browsers can show review-pending state.
      const reviewOwnerSessionId =
        targetSessionId ||
        currentOwnerSessionId ||
        quest.previousOwnerSessionIds?.[quest.previousOwnerSessionIds.length - 1] ||
        "";
      if (reviewOwnerSessionId && hasQuestReviewMetadata(quest)) {
        setClaimedQuest(reviewOwnerSessionId, claimedQuestEvent(quest));
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/done", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { notes?: string; cancelled?: boolean };
      const quest = await transitionQuestAndSync(c.req.param("questId"), {
        status: "done",
        ...(body.notes ? { notes: body.notes } : {}),
        ...(body.cancelled ? { cancelled: true } : {}),
      });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      c.header("X-Companion-Deprecated", 'Use /api/quests/:questId/transition with {status:"done"}');
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/cancel", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { notes?: string };
      const current = await questStore.getQuest(c.req.param("questId"));
      const quest = await questStore.cancelQuest(c.req.param("questId"), body.notes);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      // Clear the claimed quest from the active owner session since it's now cancelled.
      if (current && "sessionId" in current && typeof current.sessionId === "string") {
        setClaimedQuest(current.sessionId, null);
      }
      if (current && hasQuestReviewMetadata(current)) {
        const reviewOwner = current.previousOwnerSessionIds?.[current.previousOwnerSessionIds.length - 1];
        if (reviewOwner) setClaimedQuest(reviewOwner, null);
      }
      wsBridge.removeBoardRowFromAll(c.req.param("questId"));
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.patch("/quests/:questId/verification/:index", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const index = parseInt(c.req.param("index"), 10);
    if (Number.isNaN(index)) return c.json({ error: "Invalid index" }, 400);
    try {
      const quest = await questStore.checkVerificationItem(c.req.param("questId"), index, body.checked ?? false);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/verification/read", async (c) => {
    try {
      const quest = await questStore.markQuestVerificationRead(c.req.param("questId"));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      if (hasQuestReviewMetadata(quest)) {
        const reviewOwner = quest.previousOwnerSessionIds?.[quest.previousOwnerSessionIds.length - 1];
        if (reviewOwner) {
          setClaimedQuest(reviewOwner, claimedQuestEvent(quest));
        }
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/verification/inbox", async (c) => {
    try {
      const quest = await questStore.markQuestVerificationInboxUnread(c.req.param("questId"));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      if (hasQuestReviewMetadata(quest)) {
        const reviewOwner = quest.previousOwnerSessionIds?.[quest.previousOwnerSessionIds.length - 1];
        if (reviewOwner) {
          setClaimedQuest(reviewOwner, claimedQuestEvent(quest));
        }
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Append a feedback entry to a quest's thread
  api.post("/quests/:questId/feedback", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    const text = body.text;
    const tldr = normalizeTldr(body.tldr);
    const author = body.author === "agent" ? "agent" : "human";
    const rawAuthorSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authSessionId = auth ? auth.callerId : "";
    if (authSessionId && rawAuthorSessionId && rawAuthorSessionId !== authSessionId) {
      return c.json({ error: "sessionId does not match authenticated caller" }, 403);
    }
    const resolvedAuthorSessionId = rawAuthorSessionId || authSessionId;
    if (author === "agent" && resolvedAuthorSessionId.length === 0) {
      return c.json({ error: "sessionId is required for agent feedback (or provide Companion auth headers)" }, 400);
    }
    const authorSessionId = author === "agent" ? resolvedAuthorSessionId : undefined;
    if (!text || typeof text !== "string" || !text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }
    if (authorSessionId && !launcher.getSession(authorSessionId)) {
      return c.json(
        {
          error:
            `Unknown sessionId: ${authorSessionId}. ` + "Agent feedback must include a valid Companion session ID.",
        },
        400,
      );
    }
    try {
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("../quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current
          ? ((current as { feedback?: import("../quest-types.js").QuestFeedbackEntry[] }).feedback ?? [])
          : [];
      const entry: import("../quest-types.js").QuestFeedbackEntry = { author, text: text.trim(), ts: Date.now() };
      if (tldr) entry.tldr = tldr;
      if (authorSessionId) entry.authorSessionId = authorSessionId;
      const hasImagesField = body.images !== undefined;
      if (Array.isArray(body.images) && body.images.length > 0) entry.images = body.images;
      const documentation = resolveQuestFeedbackDocumentation({
        quest: current,
        authorSessionId,
        request: body,
        boardRows: boardRowCandidatesForQuest(current),
      });
      if (documentation.error)
        return c.json({ error: documentation.error }, (documentation.status ?? 400) as 400 | 409);
      Object.assign(entry, documentation.entryPatch);
      if (documentation.warning) c.header(QUEST_PHASE_DOCUMENTATION_WARNING_HEADER, documentation.warning);

      let nextFeedback = [...existing, entry];
      let entryForWarning = entry;
      if (author === "agent" && isAgentSummaryFeedback(entry.text)) {
        const summaryIndex = findLatestAgentSummaryFeedbackIndex(existing, entry);
        if (summaryIndex !== -1) {
          nextFeedback = [...existing];
          const previousEntry = nextFeedback[summaryIndex]!;
          const hasTldrField = body.tldr !== undefined;
          const shouldCarryPreviousTldr = !hasTldrField && previousEntry.text === entry.text;
          const previousBase = shouldCarryPreviousTldr ? previousEntry : feedbackEntryWithoutTldr(previousEntry);
          const updatedEntry = {
            ...previousBase,
            text: entry.text,
            ...(hasTldrField && entry.tldr ? { tldr: entry.tldr } : {}),
            ts: entry.ts,
            ...(authorSessionId ? { authorSessionId } : {}),
            ...(hasImagesField ? { images: entry.images } : {}),
          };
          nextFeedback[summaryIndex] = updatedEntry;
          entryForWarning = updatedEntry;
        }
      }

      const quest = await questStore.patchQuest(
        c.req.param("questId"),
        {
          feedback: nextFeedback,
          ...(documentation.journeyRuns ? { journeyRuns: documentation.journeyRuns } : {}),
        },
        { current },
      );
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      if (author === "agent") {
        setTldrWarningHeader(c, tldrWarningForContent("feedback", entryForWarning.text, entryForWarning.tldr));
      }
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Edit an existing feedback entry by index
  api.patch("/quests/:questId/feedback/:index", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const index = parseInt(c.req.param("index"), 10);
      if (isNaN(index) || index < 0) return c.json({ error: "Invalid index" }, 400);
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("../quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current
          ? ((current as { feedback?: import("../quest-types.js").QuestFeedbackEntry[] }).feedback ?? [])
          : [];
      if (index >= existing.length) return c.json({ error: "Index out of range" }, 400);
      const updated = [...existing];
      if (typeof body.text === "string" && body.text.trim())
        updated[index] = { ...updated[index], text: body.text.trim() };
      if (body.tldr !== undefined) {
        updated[index] = { ...updated[index], tldr: normalizeTldr(body.tldr) };
      }
      if (body.images !== undefined)
        updated[index] = {
          ...updated[index],
          images: Array.isArray(body.images) && body.images.length > 0 ? body.images : undefined,
        };
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated }, { current });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      if (updated[index]?.author === "agent") {
        setTldrWarningHeader(c, tldrWarningForContent("feedback", updated[index]?.text, updated[index]?.tldr));
      }
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Delete an existing feedback entry by index
  api.delete("/quests/:questId/feedback/:index", async (c) => {
    try {
      const index = parseInt(c.req.param("index"), 10);
      if (isNaN(index) || index < 0) return c.json({ error: "Invalid index" }, 400);
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("../quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current
          ? ((current as { feedback?: import("../quest-types.js").QuestFeedbackEntry[] }).feedback ?? [])
          : [];
      if (index >= existing.length) return c.json({ error: "Index out of range" }, 400);
      if (existing[index]?.author !== "agent") return c.json({ error: "Only agent feedback can be deleted" }, 400);
      const updated = existing.filter((_, feedbackIndex) => feedbackIndex !== index);
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated }, { current });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Toggle addressed status on a feedback entry
  api.post("/quests/:questId/feedback/:index/addressed", async (c) => {
    try {
      const index = parseInt(c.req.param("index"), 10);
      if (isNaN(index) || index < 0) return c.json({ error: "Invalid index" }, 400);
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("../quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current
          ? ((current as { feedback?: import("../quest-types.js").QuestFeedbackEntry[] }).feedback ?? [])
          : [];
      if (index >= existing.length) return c.json({ error: "Index out of range" }, 400);
      const updated = [...existing];
      updated[index] = { ...updated[index], addressed: !updated[index].addressed };
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated }, { current });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/images", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") {
        return c.json({ error: "file field is required (multipart)" }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const image = await questStore.saveQuestImage(file.name, buf, file.type);
      const quest = await questStore.addQuestImages(c.req.param("questId"), [image]);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      if (isSharpUnavailableError(e)) {
        return c.json({ error: SHARP_UNAVAILABLE_MESSAGE }, 503);
      }
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.delete("/quests/:questId/images/:imageId", async (c) => {
    try {
      const quest = await questStore.removeQuestImage(c.req.param("questId"), c.req.param("imageId"));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  return api;
}
