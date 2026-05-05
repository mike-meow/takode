import type { Hono } from "hono";
import * as questStore from "../quest-store.js";
import {
  FREE_WORKER_WAIT_FOR_TOKEN,
  getQuestJourneyCurrentPhaseIndex,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  getQuestJourneyPhaseIndices,
  getInvalidQuestJourneyPhaseIds,
  getQuestJourneyProposalSignature,
  isValidQuestId,
  isValidWaitForRef,
  normalizeQuestJourneyPhaseIds,
  normalizeQuestJourneyPlan,
  rebaseQuestJourneyPhaseNotes,
  validateQuestJourneyCompletedPrefixRevision,
  type QuestJourneyLifecycleMode,
  type QuestJourneyPhaseId,
  type QuestJourneyPhaseNoteRebaseWarning,
  type QuestJourneyPlanState,
} from "../../shared/quest-journey.js";
import { canonicalizeQuestJourneyLifecycleMode } from "../../shared/quest-journey.js";
import {
  advanceBoardRow as advanceBoardRowController,
  getBoard as getBoardController,
  getBoardQueueWarnings as getBoardQueueWarningsController,
  getBoardWorkerSlotUsage as getBoardWorkerSlotUsageController,
  getCompletedBoard as getCompletedBoardController,
  removeBoardRows as removeBoardRowsController,
  upsertBoardRow as upsertBoardRowController,
} from "../bridge/board-watchdog-controller.js";
import { QUEST_JOURNEY_STATES, type BoardRow } from "../session-types.js";
import type { RouteContext } from "./context.js";

interface PhaseNoteEdit {
  index: number;
  note?: string;
}

interface BoardProposalReviewPayload {
  questId: string;
  title?: string;
  status: string;
  journey: QuestJourneyPlanState;
  presentedAt: number;
  summary?: string;
  scheduling?: Record<string, unknown>;
}

function normalizeJourneyMode(value: unknown): QuestJourneyLifecycleMode | undefined {
  if (typeof value !== "string") return undefined;
  return canonicalizeQuestJourneyLifecycleMode(value) ?? undefined;
}

function normalizePhaseNoteEdits(value: unknown): PhaseNoteEdit[] | null {
  if (!Array.isArray(value)) return null;
  const edits: PhaseNoteEdit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const index = (entry as { index?: unknown }).index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
    const rawNote = (entry as { note?: unknown }).note;
    if (rawNote === null) {
      edits.push({ index });
      continue;
    }
    if (typeof rawNote !== "string") return null;
    const note = rawNote.trim();
    edits.push(note ? { index, note } : { index });
  }
  return edits;
}

function applyPhaseNoteEdits(
  existingNotes: Record<string, string> | undefined,
  edits: readonly PhaseNoteEdit[],
  phaseCount: number,
): Record<string, string> | undefined {
  const nextNotes = new Map<string, string>(Object.entries(existingNotes ?? {}));
  for (const edit of edits) {
    if (edit.index >= phaseCount) {
      throw new Error(`Phase note index ${edit.index + 1} is out of range for the current Journey.`);
    }
    const key = String(edit.index);
    if (edit.note) nextNotes.set(key, edit.note);
    else nextNotes.delete(key);
  }
  return nextNotes.size > 0
    ? Object.fromEntries([...nextNotes.entries()].sort((a, b) => Number(a[0]) - Number(b[0])))
    : undefined;
}

function normalizeProposalMetadata(
  value: unknown,
): Pick<NonNullable<QuestJourneyPlanState["presentation"]>, "summary" | "scheduling"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as { summary?: unknown; scheduling?: unknown };
  const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : undefined;
  const scheduling =
    raw.scheduling && typeof raw.scheduling === "object" && !Array.isArray(raw.scheduling)
      ? { ...(raw.scheduling as Record<string, unknown>) }
      : undefined;
  return {
    ...(summary ? { summary } : {}),
    ...(scheduling ? { scheduling } : {}),
  };
}

function buildProposalReviewPayload(row: {
  questId: string;
  title?: string;
  status?: string;
  journey?: QuestJourneyPlanState;
}): BoardProposalReviewPayload | undefined {
  const journey = row.journey;
  const presentation = journey?.presentation;
  if (!journey || presentation?.state !== "presented" || !presentation.presentedAt) return undefined;
  return {
    questId: row.questId,
    ...(row.title ? { title: row.title } : {}),
    status: row.status ?? "PROPOSED",
    journey,
    presentedAt: presentation.presentedAt,
    ...(presentation.summary ? { summary: presentation.summary } : {}),
    ...(presentation.scheduling ? { scheduling: presentation.scheduling } : {}),
  };
}

function findPreservedPhaseIndex(
  phaseIds: readonly QuestJourneyPhaseId[],
  currentPhaseId: QuestJourneyPhaseId,
  previousIndex: number | undefined,
): number | undefined {
  const matches = phaseIds
    .map((phaseId, index) => ({ phaseId, index }))
    .filter((entry) => entry.phaseId === currentPhaseId)
    .map((entry) => entry.index);
  if (matches.length === 0) return undefined;
  if (previousIndex === undefined) return matches.length === 1 ? matches[0] : undefined;
  return matches.find((index) => index >= previousIndex) ?? matches[matches.length - 1];
}

function parseNotificationNumericId(notificationId: string): number | null {
  const match = /^n-(\d+)$/.exec(notificationId);
  return match ? Number.parseInt(match[1], 10) : null;
}

function normalizeNeedsInputNotificationId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return `n-${value}`;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numericId = Number.parseInt(trimmed, 10);
    return numericId > 0 ? `n-${numericId}` : null;
  }
  const numericId = parseNotificationNumericId(trimmed.toLowerCase());
  return numericId !== null ? `n-${numericId}` : null;
}

interface TakodeBoardRoutesDeps {
  launcher: RouteContext["launcher"];
  wsBridge: RouteContext["wsBridge"];
  authenticateTakodeCaller: RouteContext["authenticateTakodeCaller"];
  resolveId: RouteContext["resolveId"];
  boardWatchdogDeps: any;
  workBoardStateDeps: any;
  buildBoardRowSessionStatuses: (rows: BoardRow[]) => Promise<Record<string, unknown>>;
  resolveSessionDeps: (board: BoardRow[]) => string[];
}

export function registerTakodeBoardRoutes(api: Hono, deps: TakodeBoardRoutesDeps): void {
  const {
    launcher,
    wsBridge,
    authenticateTakodeCaller,
    resolveId,
    boardWatchdogDeps,
    workBoardStateDeps,
    buildBoardRowSessionStatuses,
    resolveSessionDeps,
  } = deps;

  api.get("/sessions/:id/board", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    // Only the session owner can read their own board
    if (id !== auth.callerId) {
      return c.json({ error: "Can only read your own board" }, 403);
    }

    const bridgeSession = wsBridge.getSession(id);
    const board = bridgeSession ? getBoardController(bridgeSession) : [];
    const resolve = c.req.query("resolve") === "true";
    const includeCompleted = c.req.query("include_completed") === "true";
    const completedBoard = includeCompleted && bridgeSession ? getCompletedBoardController(bridgeSession) : [];
    const rowSessionStatuses = await buildBoardRowSessionStatuses([...board, ...completedBoard]);

    return c.json({
      board,
      completedCount: bridgeSession?.completedBoard.size ?? 0,
      rowSessionStatuses,
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      ...(includeCompleted ? { completedBoard } : {}),
      ...(resolve ? { resolvedSessionDeps: resolveSessionDeps(board) } : {}),
    });
  });

  api.post("/sessions/:id/board", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const questId = typeof body.questId === "string" ? body.questId.trim() : "";
    if (!questId) return c.json({ error: "questId is required" }, 400);
    if (!isValidQuestId(questId)) {
      return c.json({ error: `Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)` }, 400);
    }
    if (typeof body.noCode === "boolean") {
      return c.json(
        {
          error:
            "Board no-code markers were removed. Model zero-tracked-change work with explicit phases that omit `port` instead.",
        },
        400,
      );
    }

    // Auto-populate title from quest store if not explicitly provided
    let title: string | undefined = typeof body.title === "string" ? body.title : undefined;
    if (title === undefined) {
      try {
        const quest = await questStore.getQuest(questId);
        if (quest) title = quest.title;
      } catch (e) {
        console.warn(`[routes] Failed to fetch quest title for ${questId}:`, e);
      }
    }

    // Validate and normalize waitFor entries
    let waitFor: string[] | undefined;
    if (Array.isArray(body.waitFor)) {
      const parsed = body.waitFor
        .filter((s: unknown) => typeof s === "string" && s.trim())
        .map((s: string) => s.trim());
      const invalid = parsed.filter((ref: string) => !isValidWaitForRef(ref));
      if (invalid.length > 0) {
        return c.json(
          {
            error: `Invalid wait-for value(s): ${invalid.join(", ")} -- use q-N for quests, #N for sessions, or ${FREE_WORKER_WAIT_FOR_TOKEN}`,
          },
          400,
        );
      }
      waitFor = parsed;
    }
    if (body.waitFor !== undefined && !Array.isArray(body.waitFor)) {
      return c.json({ error: "waitFor must be an array when provided" }, 400);
    }

    let waitForInput: string[] | undefined;
    const clearWaitForInput = body.clearWaitForInput === true;
    if (clearWaitForInput && body.waitForInput !== undefined) {
      return c.json({ error: "Use either waitForInput or clearWaitForInput, not both" }, 400);
    }
    if (Array.isArray(body.waitForInput)) {
      const parsed: Array<{ value: unknown; normalized: string | null }> = body.waitForInput
        .map((value: unknown) => ({ value, normalized: normalizeNeedsInputNotificationId(value) }))
        .filter((entry: { value: unknown; normalized: string | null }) => entry.value !== undefined);
      const invalid = parsed.filter((entry) => entry.normalized === null).map((entry) => String(entry.value).trim());
      if (invalid.length > 0) {
        return c.json(
          {
            error: `Invalid wait-for-input value(s): ${invalid.join(", ")} -- use same-session needs-input notification IDs like 3 or n-3`,
          },
          400,
        );
      }
      const normalizedIds = parsed
        .map((entry) => entry.normalized)
        .filter((notificationId): notificationId is string => typeof notificationId === "string");
      waitForInput = [...new Set(normalizedIds)].sort(
        (a: string, b: string) => Number.parseInt(a.slice(2), 10) - Number.parseInt(b.slice(2), 10),
      );
    } else if (body.waitForInput !== undefined) {
      return c.json({ error: "waitForInput must be an array when provided" }, 400);
    }
    if (clearWaitForInput) waitForInput = [];

    const bridgeSession = wsBridge.getSession(id);
    const existingRow = bridgeSession?.board.get(questId) ?? null;
    if (waitForInput && waitForInput.length > 0) {
      if (!bridgeSession) return c.json({ error: "Session not found in bridge" }, 404);
      const missing = waitForInput.filter(
        (notificationId) =>
          !bridgeSession.notifications.some(
            (notification) =>
              notification.id === notificationId &&
              notification.category === "needs-input" &&
              notification.done !== true,
          ),
      );
      if (missing.length > 0) {
        return c.json(
          {
            error: `Unknown or already-resolved same-session needs-input notification ID(s): ${missing.join(", ")}`,
          },
          400,
        );
      }
    }

    if (body.presentProposal === true) {
      if (!bridgeSession) return c.json({ error: "Session not found in bridge" }, 404);
      if (!existingRow || existingRow.status?.trim().toUpperCase() !== "PROPOSED") {
        return c.json({ error: "Presenting a Journey requires an existing proposed Journey row." }, 400);
      }
      const existingPhaseIds = normalizeQuestJourneyPhaseIds(existingRow.journey?.phaseIds ?? []);
      if (existingRow.journey?.mode !== "proposed" || existingPhaseIds.length === 0) {
        return c.json({ error: "Presenting a Journey requires an existing proposed Journey row with phases." }, 400);
      }
      if (waitFor && waitFor.length > 0) {
        return c.json({ error: "Presented proposed Journey rows do not use queue wait-for dependencies." }, 400);
      }

      const normalizedDraft = normalizeQuestJourneyPlan(existingRow.journey, "PROPOSED");
      const metadata = {
        ...normalizeProposalMetadata(existingRow.journey?.presentation),
        ...normalizeProposalMetadata(body.presentation),
      };
      const presentation = {
        state: "presented" as const,
        signature: getQuestJourneyProposalSignature(normalizedDraft),
        presentedAt: Date.now(),
        ...metadata,
      };
      const board = upsertBoardRowController(
        bridgeSession,
        {
          questId,
          title,
          journey: {
            ...normalizedDraft,
            mode: "proposed",
            presentation,
          },
          status: "PROPOSED",
          waitForInput,
        },
        workBoardStateDeps,
      );
      const presentedRow = board.find((row) => row.questId === questId);
      return c.json({
        board,
        rowSessionStatuses: await buildBoardRowSessionStatuses(board),
        queueWarnings: getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps),
        workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
        resolvedSessionDeps: resolveSessionDeps(board),
        ...(presentedRow ? { proposalReview: buildProposalReviewPayload(presentedRow) } : {}),
      });
    }

    let journey: QuestJourneyPlanState | undefined;
    let firstPlannedPhaseState: string | undefined;
    const explicitStatus = typeof body.status === "string" ? body.status.trim() || undefined : undefined;
    const explicitStatusUpper = explicitStatus?.toUpperCase();
    const explicitStatusPhase = getQuestJourneyPhaseForState(explicitStatus ?? null)?.id;
    const requestedMode = normalizeJourneyMode(body.journeyMode);
    if (body.journeyMode !== undefined && !requestedMode) {
      return c.json({ error: "journeyMode must be `active` or `proposed` when provided" }, 400);
    }
    const existingJourney = existingRow?.journey;
    const existingMode: QuestJourneyLifecycleMode =
      normalizeJourneyMode(existingJourney?.mode) ??
      ((existingRow?.status || "").trim().toUpperCase() === "PROPOSED" ? "proposed" : "active");
    const targetMode = requestedMode ?? (explicitStatusUpper === "PROPOSED" ? "proposed" : (existingMode ?? "active"));
    if (existingRow && existingMode === "active" && targetMode === "proposed") {
      return c.json(
        {
          error:
            "Active Journey rows cannot be converted back to proposed drafts. Revise current/future active phases or append later occurrences instead.",
        },
        400,
      );
    }
    const revisionReason =
      typeof body.revisionReason === "string" && body.revisionReason.trim() ? body.revisionReason.trim() : undefined;
    if (typeof body.revisionReason === "string" && !revisionReason) {
      return c.json({ error: "Journey revision reason must not be empty" }, 400);
    }
    if (revisionReason && !Array.isArray(body.phases)) {
      return c.json({ error: "Journey revision reason requires --phases / phases so the revision is explicit" }, 400);
    }
    const phaseNoteEdits = normalizePhaseNoteEdits(body.phaseNoteEdits);
    if (body.phaseNoteEdits !== undefined && phaseNoteEdits === null) {
      return c.json({ error: "phaseNoteEdits must be an array of { index, note } edits when provided" }, 400);
    }
    const explicitActivePhaseIndex =
      typeof body.activePhaseIndex === "number" && Number.isInteger(body.activePhaseIndex)
        ? body.activePhaseIndex
        : null;
    if (body.activePhaseIndex !== undefined && (explicitActivePhaseIndex === null || explicitActivePhaseIndex < 0)) {
      return c.json({ error: "activePhaseIndex must be a non-negative integer when provided" }, 400);
    }
    if (targetMode === "proposed" && explicitStatus && explicitStatusUpper !== "PROPOSED") {
      return c.json({ error: "Proposed Journey rows must use status PROPOSED." }, 400);
    }
    if (targetMode === "active" && explicitStatusUpper === "PROPOSED") {
      return c.json({ error: "Status PROPOSED is only valid for proposed Journey rows." }, 400);
    }

    let typedPhaseIds: QuestJourneyPhaseId[] | undefined;
    const existingPhaseIds = normalizeQuestJourneyPhaseIds(existingJourney?.phaseIds ?? []);
    if (Array.isArray(body.phases)) {
      const phaseIds = body.phases
        .filter((s: unknown) => typeof s === "string" && s.trim())
        .map((s: string) => s.trim());
      if (phaseIds.length === 0) {
        return c.json({ error: "Quest Journey phases require at least one phase ID" }, 400);
      }
      const invalid = getInvalidQuestJourneyPhaseIds(phaseIds);
      if (invalid.length > 0) {
        return c.json({ error: `Invalid Quest Journey phase(s): ${invalid.join(", ")}` }, 400);
      }
      typedPhaseIds = normalizeQuestJourneyPhaseIds(phaseIds) as QuestJourneyPhaseId[];
      firstPlannedPhaseState = getQuestJourneyPhase(typedPhaseIds[0])?.boardState;
      const existingCurrentPhaseId = getQuestJourneyPhase(existingJourney?.currentPhaseId)?.id;
      if (
        targetMode === "active" &&
        existingCurrentPhaseId &&
        !typedPhaseIds.includes(existingCurrentPhaseId) &&
        !explicitStatus
      ) {
        return c.json(
          {
            error:
              "Revised phases must include the current phase unless you also set an explicit status for the new active boundary.",
          },
          400,
        );
      }
      if (explicitStatusPhase && !typedPhaseIds.includes(explicitStatusPhase)) {
        return c.json(
          {
            error: `Status ${body.status} does not match the revised phase plan. Include its phase in --phases or change --status.`,
          },
          400,
        );
      }
    }

    const resolvedPhaseIds = typedPhaseIds ?? existingPhaseIds;
    if (requestedMode === "active" && (!existingRow || existingMode !== "proposed" || existingPhaseIds.length === 0)) {
      return c.json(
        {
          error:
            "Promoting a Journey requires an existing proposed Journey row. Create or revise it first with `takode board propose`.",
        },
        400,
      );
    }
    if (phaseNoteEdits && resolvedPhaseIds.length === 0) {
      return c.json(
        { error: "Phase notes require an existing Journey row or explicit --phases for the target row." },
        400,
      );
    }
    if (targetMode === "proposed" && explicitActivePhaseIndex !== null) {
      return c.json({ error: "Proposed Journey rows cannot set an activePhaseIndex." }, 400);
    }
    if (targetMode === "active" && explicitActivePhaseIndex !== null && resolvedPhaseIds.length === 0) {
      return c.json({ error: "activePhaseIndex requires an existing Journey row or explicit --phases." }, 400);
    }
    if (
      targetMode === "active" &&
      explicitActivePhaseIndex !== null &&
      explicitActivePhaseIndex >= resolvedPhaseIds.length
    ) {
      return c.json(
        {
          error: `activePhaseIndex ${explicitActivePhaseIndex} is out of range for the current Journey.`,
        },
        400,
      );
    }
    const explicitActivePhaseId =
      explicitActivePhaseIndex !== null && explicitActivePhaseIndex < resolvedPhaseIds.length
        ? resolvedPhaseIds[explicitActivePhaseIndex]
        : undefined;
    if (explicitStatusPhase && explicitActivePhaseId && explicitStatusPhase !== explicitActivePhaseId) {
      return c.json(
        {
          error: `activePhaseIndex ${explicitActivePhaseIndex} points to ${explicitActivePhaseId}, which does not match status ${body.status}.`,
        },
        400,
      );
    }

    if (
      existingJourney &&
      existingMode === "active" &&
      targetMode === "active" &&
      (typedPhaseIds || phaseNoteEdits || explicitActivePhaseIndex !== null || explicitStatusPhase)
    ) {
      const historyError = validateQuestJourneyCompletedPrefixRevision({
        existingPlan: existingJourney,
        existingStatus: existingRow?.status,
        ...(typedPhaseIds ? { nextPhaseIds: typedPhaseIds } : {}),
        ...(phaseNoteEdits ? { phaseNoteEditIndices: phaseNoteEdits.map((edit) => edit.index) } : {}),
        ...(explicitActivePhaseIndex !== null ? { nextActivePhaseIndex: explicitActivePhaseIndex } : {}),
      });
      if (historyError) return c.json({ error: historyError }, 400);
    }

    let phaseNoteRebaseWarnings: QuestJourneyPhaseNoteRebaseWarning[] = [];
    let phaseNotes = existingJourney?.phaseNotes;
    if (typedPhaseIds && existingJourney) {
      const rebaseResult = rebaseQuestJourneyPhaseNotes(existingJourney.phaseNotes, existingPhaseIds, typedPhaseIds);
      phaseNotes = rebaseResult.phaseNotes;
      phaseNoteRebaseWarnings = rebaseResult.warnings;
    }
    if (phaseNoteEdits) {
      try {
        phaseNotes = applyPhaseNoteEdits(phaseNotes, phaseNoteEdits, resolvedPhaseIds.length);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Invalid phase note update." }, 400);
      }
    }

    let activePhaseIndex: number | undefined;
    if (targetMode === "active" && resolvedPhaseIds.length > 0) {
      const existingCurrentPhaseId = getQuestJourneyPhase(existingJourney?.currentPhaseId)?.id;
      const existingCurrentPhaseIndex = getQuestJourneyCurrentPhaseIndex(existingJourney, existingRow?.status);
      if (explicitActivePhaseIndex !== null) {
        activePhaseIndex = explicitActivePhaseIndex;
      } else if (explicitStatusPhase) {
        activePhaseIndex = findPreservedPhaseIndex(resolvedPhaseIds, explicitStatusPhase, existingCurrentPhaseIndex);
      } else if (typedPhaseIds && existingMode === "active" && existingCurrentPhaseId) {
        activePhaseIndex = findPreservedPhaseIndex(resolvedPhaseIds, existingCurrentPhaseId, existingCurrentPhaseIndex);
        if (
          activePhaseIndex === undefined &&
          getQuestJourneyPhaseIndices(resolvedPhaseIds, existingCurrentPhaseId).length > 1
        ) {
          return c.json(
            {
              error:
                "The current Journey phase is repeated but the active occurrence is ambiguous. Re-run with activePhaseIndex (CLI: --active-phase-position).",
            },
            400,
          );
        }
      } else if ((requestedMode === "active" && existingMode === "proposed") || !existingRow?.status) {
        activePhaseIndex = 0;
      }
      if (
        explicitStatusPhase &&
        explicitActivePhaseIndex === null &&
        activePhaseIndex === undefined &&
        getQuestJourneyPhaseIndices(resolvedPhaseIds, explicitStatusPhase).length > 1
      ) {
        return c.json(
          {
            error:
              "Status points to a repeated Journey phase but the active occurrence is ambiguous. Re-run with activePhaseIndex (CLI: --active-phase-position).",
          },
          400,
        );
      }
      if (
        existingJourney &&
        existingMode === "active" &&
        (explicitActivePhaseIndex !== null || explicitStatusPhase) &&
        activePhaseIndex !== undefined
      ) {
        const historyError = validateQuestJourneyCompletedPrefixRevision({
          existingPlan: existingJourney,
          existingStatus: existingRow?.status,
          nextActivePhaseIndex: activePhaseIndex,
        });
        if (historyError) return c.json({ error: historyError }, 400);
      }
    }

    const presentationMetadata = normalizeProposalMetadata(body.presentation);
    const hasPresentationMetadata = Object.keys(presentationMetadata).length > 0;
    const draftMutation =
      targetMode === "proposed" && (typedPhaseIds || phaseNoteEdits || revisionReason || hasPresentationMetadata);
    const presentation =
      targetMode === "proposed"
        ? {
            ...(existingJourney?.presentation ?? {}),
            ...presentationMetadata,
            state: existingJourney?.presentation?.state ?? ("draft" as const),
            ...(draftMutation
              ? {
                  state: "draft" as const,
                  signature: undefined,
                  presentedAt: undefined,
                }
              : {}),
          }
        : undefined;

    if (
      typedPhaseIds ||
      phaseNoteEdits ||
      revisionReason ||
      requestedMode ||
      explicitActivePhaseIndex !== null ||
      hasPresentationMetadata
    ) {
      journey = {
        phaseIds: resolvedPhaseIds.length > 0 ? resolvedPhaseIds : [],
        presetId:
          typedPhaseIds && typeof body.presetId === "string" && body.presetId.trim()
            ? body.presetId.trim()
            : (existingJourney?.presetId ?? (typedPhaseIds ? "custom" : undefined)),
        mode: targetMode,
        ...(targetMode === "active" && activePhaseIndex !== undefined ? { activePhaseIndex } : {}),
        ...(phaseNotes ? { phaseNotes } : {}),
        ...(targetMode === "proposed" ? { presentation } : { presentation: undefined }),
        ...(revisionReason ? { revisionReason } : {}),
      };
    }

    const implicitQueuedStatus =
      !explicitStatus &&
      explicitActivePhaseIndex === null &&
      targetMode === "active" &&
      typeof body.worker !== "string" &&
      waitFor !== undefined &&
      !existingRow?.status
        ? "QUEUED"
        : undefined;
    const explicitActiveStatus =
      explicitActivePhaseId !== undefined ? getQuestJourneyPhase(explicitActivePhaseId)?.boardState : undefined;
    const defaultActiveStatus =
      explicitActiveStatus ??
      firstPlannedPhaseState ??
      (resolvedPhaseIds.length > 0 ? getQuestJourneyPhase(resolvedPhaseIds[0])?.boardState : undefined);
    const mergedStatus =
      explicitStatus ??
      (targetMode === "proposed"
        ? "PROPOSED"
        : (implicitQueuedStatus ??
          ((existingRow?.status || "").trim().toUpperCase() === "PROPOSED"
            ? defaultActiveStatus
            : (existingRow?.status?.trim() ?? defaultActiveStatus))));
    const mergedStatusUpper = (mergedStatus || "").trim().toUpperCase();
    const mergedWaitFor =
      targetMode === "proposed" ? undefined : waitFor !== undefined ? waitFor : existingRow?.waitFor;
    const mergedWaitForInput = waitForInput !== undefined ? waitForInput : existingRow?.waitForInput;
    const mergedIsQueued = mergedStatusUpper === "QUEUED";
    if (targetMode === "proposed" && typeof body.worker === "string" && body.worker.trim()) {
      return c.json({ error: "Proposed Journey rows cannot be assigned to a worker yet." }, 400);
    }
    if (targetMode === "proposed" && waitFor && waitFor.length > 0) {
      return c.json(
        {
          error:
            "Proposed Journey rows do not use queue wait-for dependencies. Use wait-for-input to hold for approval.",
        },
        400,
      );
    }
    if (mergedIsQueued && mergedWaitForInput && mergedWaitForInput.length > 0) {
      return c.json(
        {
          error: "wait-for-input is only valid on active board rows; clear it before moving a row to QUEUED.",
        },
        400,
      );
    }
    if (waitFor && waitFor.length > 0 && waitForInput && waitForInput.length > 0) {
      return c.json(
        {
          error:
            "wait-for and wait-for-input cannot both be set on the same row. Use wait-for for QUEUED rows or wait-for-input for active rows.",
        },
        400,
      );
    }
    if (!mergedIsQueued && waitFor && waitFor.length > 0) {
      return c.json(
        {
          error: "wait-for is only valid on QUEUED board rows; clear it before moving a row active.",
        },
        400,
      );
    }
    if (targetMode === "active" && mergedStatusUpper === "PROPOSED") {
      return c.json({ error: "Active Journey rows cannot keep status PROPOSED." }, 400);
    }
    if (mergedIsQueued && (!mergedWaitFor || mergedWaitFor.length === 0)) {
      return c.json(
        {
          error: `Queued rows require an explicit wait-for reason -- use q-N, #N, or ${FREE_WORKER_WAIT_FOR_TOKEN}`,
        },
        400,
      );
    }

    const statusForUpsert = mergedStatus;
    const workerForUpsert = targetMode === "proposed" ? "" : typeof body.worker === "string" ? body.worker : undefined;
    const workerNumForUpsert =
      targetMode === "proposed" ? undefined : typeof body.workerNum === "number" ? body.workerNum : undefined;

    const board = bridgeSession
      ? upsertBoardRowController(
          bridgeSession,
          {
            questId,
            title,
            worker: workerForUpsert,
            workerNum: workerNumForUpsert,
            journey,
            status: statusForUpsert,
            waitFor: targetMode === "proposed" ? [] : waitFor,
            waitForInput,
          },
          workBoardStateDeps,
        )
      : null;
    if (!board) return c.json({ error: "Session not found in bridge" }, 404);
    return c.json({
      board,
      rowSessionStatuses: await buildBoardRowSessionStatuses(board),
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(board),
      ...(phaseNoteRebaseWarnings.length > 0 ? { phaseNoteRebaseWarnings } : {}),
    });
  });

  api.delete("/sessions/:id/board/:questId", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const questIds = c.req
      .param("questId")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (questIds.length === 0) return c.json({ error: "questId is required" }, 400);
    const invalid = questIds.filter((qid) => !isValidQuestId(qid));
    if (invalid.length > 0) {
      return c.json(
        { error: `Invalid quest ID(s): ${invalid.join(", ")} -- must match q-NNN format (e.g., q-1, q-42)` },
        400,
      );
    }

    const bridgeSession = wsBridge.getSession(id);
    const board = bridgeSession ? removeBoardRowsController(bridgeSession, questIds, workBoardStateDeps) : null;
    if (!board) return c.json({ error: "Session not found in bridge" }, 404);
    return c.json({
      board,
      completedCount: bridgeSession?.completedBoard.size ?? 0,
      rowSessionStatuses: await buildBoardRowSessionStatuses(board),
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(board),
    });
  });

  api.post("/sessions/:id/board/:questId/advance", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const questId = c.req.param("questId").trim();
    if (!questId) return c.json({ error: "questId is required" }, 400);
    if (!isValidQuestId(questId)) {
      return c.json({ error: `Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)` }, 400);
    }

    const bridgeSession = wsBridge.getSession(id);
    const result = bridgeSession
      ? advanceBoardRowController(bridgeSession, questId, QUEST_JOURNEY_STATES, workBoardStateDeps)
      : null;
    if (!result) return c.json({ error: "Quest not found on board" }, 404);
    if ("error" in result) return c.json({ error: result.error }, 409);
    return c.json({
      ...result,
      completedCount: bridgeSession?.completedBoard.size ?? 0,
      rowSessionStatuses: await buildBoardRowSessionStatuses(result.board),
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(result.board),
    });
  });
}
