import { Hono } from "hono";
import * as questStore from "../quest-store.js";
import type { QuestFeedbackEntry, QuestmasterTask } from "../quest-types.js";
import { SERVER_GIT_CMD } from "../constants.js";
import { broadcastQuestUpdate } from "./quest-helpers.js";
import type { RouteContext } from "./context.js";

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

function findLatestAgentSummaryFeedbackIndex(entries: QuestFeedbackEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.author !== "agent") continue;
    if (isAgentSummaryFeedback(entry.text)) return index;
  }
  return -1;
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

export function createQuestRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, wsBridge, imageStore, authenticateCompanionCallerOptional, execCaptureStdoutAsync } = ctx;

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
    const quest = await questStore.transitionQuest(questId, input);
    if (!quest) return null;

    const nextSessionId = "sessionId" in quest && typeof quest.sessionId === "string" ? quest.sessionId : null;
    if (currentSessionId && currentSessionId !== nextSessionId) {
      wsBridge.setSessionClaimedQuest(currentSessionId, null);
    }
    if (nextSessionId) {
      wsBridge.setSessionClaimedQuest(nextSessionId, {
        id: quest.questId,
        title: quest.title,
        status: quest.status,
      });
    }

    broadcastQuestUpdate(wsBridge);
    return quest;
  };

  api.get("/quests", async (c) => {
    const statusFilter = c.req.query("status")?.split(",") as import("../quest-types.js").QuestStatus[] | undefined;
    const parentId = c.req.query("parentId");
    const sessionId = c.req.query("sessionId");
    let quests = await questStore.listQuests();
    if (statusFilter?.length) quests = quests.filter((q) => statusFilter.includes(q.status));
    if (parentId) quests = quests.filter((q) => q.parentId === parentId);
    if (sessionId)
      quests = quests.filter((q) => "sessionId" in q && (q as { sessionId: string }).sessionId === sessionId);
    return c.json(quests);
  });

  api.get("/quests/:questId", async (c) => {
    const quest = await questStore.getQuest(c.req.param("questId"));
    if (!quest) return c.json({ error: "Quest not found" }, 404);
    return c.json(quest);
  });

  api.get("/quests/:questId/history", async (c) => {
    const history = await questStore.getQuestHistory(c.req.param("questId"));
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
    const body = await c.req.json().catch(() => ({}));
    try {
      const quest = await questStore.createQuest(body);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.patch("/quests/:questId", async (c) => {
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
        wsBridge.setSessionClaimedQuest(quest.sessionId, {
          id: quest.questId,
          title: quest.title,
          status: quest.status,
        });
        // Update task history entries that reference this quest
        wsBridge.updateQuestTaskEntries(quest.sessionId, quest.questId, quest.title);
      }
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/transition", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const questId = c.req.param("questId");
      const quest = await transitionQuestAndSync(questId, body);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
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
    try {
      const quest = await questStore.claimQuest(c.req.param("questId"), sessionId, {
        allowArchivedOwnerTakeover: true,
        isSessionArchived: (sid: string) => !!launcher.getSession(sid)?.archived,
      });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      // setSessionClaimedQuest broadcasts session_quest_claimed + session_name_update
      // source:quest, cancels in-flight namers, and persists the name via callback.
      wsBridge.setSessionClaimedQuest(sessionId, { id: quest.questId, title: quest.title, status: quest.status });
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
      wsBridge.addTaskEntry(sessionId, {
        title: quest.title,
        action: "new",
        timestamp: Date.now(),
        triggerMessageId: triggerMsgId,
        source: "quest",
        questId: quest.questId,
      });
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/complete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const items = body.verificationItems as import("../quest-types.js").QuestVerificationItem[] | undefined;
    if (!items || !Array.isArray(items)) return c.json({ error: "verificationItems array is required" }, 400);
    try {
      const commitShas = Array.isArray(body.commitShas) ? body.commitShas : undefined;
      const quest = await questStore.completeQuest(c.req.param("questId"), items, { commitShas });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      // Update session's quest status so browsers can show "pending review" badge
      if ("sessionId" in quest) {
        const sid = (quest as { sessionId: string }).sessionId;
        wsBridge.setSessionClaimedQuest(sid, { id: quest.questId, title: quest.title, status: quest.status });
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
        wsBridge.setSessionClaimedQuest(current.sessionId, null);
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
      if (authorSessionId) entry.authorSessionId = authorSessionId;
      const hasImagesField = body.images !== undefined;
      if (Array.isArray(body.images) && body.images.length > 0) entry.images = body.images;

      let nextFeedback = [...existing, entry];
      if (author === "agent" && isAgentSummaryFeedback(entry.text)) {
        const summaryIndex = findLatestAgentSummaryFeedbackIndex(existing);
        if (summaryIndex !== -1) {
          nextFeedback = [...existing];
          const previousEntry = nextFeedback[summaryIndex]!;
          nextFeedback[summaryIndex] = {
            ...previousEntry,
            text: entry.text,
            ts: entry.ts,
            ...(authorSessionId ? { authorSessionId } : {}),
            ...(hasImagesField ? { images: entry.images } : {}),
          };
        }
      }

      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: nextFeedback });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
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
      if (existing[index]?.author !== "agent") return c.json({ error: "Only agent feedback can be edited" }, 400);
      const updated = [...existing];
      if (typeof body.text === "string" && body.text.trim())
        updated[index] = { ...updated[index], text: body.text.trim() };
      if (body.images !== undefined)
        updated[index] = {
          ...updated[index],
          images: Array.isArray(body.images) && body.images.length > 0 ? body.images : undefined,
        };
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
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
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated });
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
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated });
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
