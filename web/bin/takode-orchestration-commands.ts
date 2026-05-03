import type { HerdSessionsResponse } from "../shared/herd-types.ts";
import { HERD_WORKER_SLOT_LIMIT, TAKODE_PEEK_CONTENT_LIMIT, formatQuotedContent } from "../shared/takode-constants.ts";
import { isValidQuestId } from "../shared/quest-journey.ts";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  assertKnownFlags,
  err,
  fetchSessionInfo,
  formatInlineText,
  formatRelativeTime,
  formatTime,
  getCredentials,
  getCallerSessionId,
  getCliDefaultModelForBackend,
  parseFlags,
  readOptionalRichTextOption,
  readOptionTextFile,
  readStdinText,
  resolveBooleanToggleFlag,
  resolveStringFlag,
  takodeAuthHeaders,
  truncate,
  type TakodeSessionInfo,
} from "./takode-core.js";
import { printSessionLine } from "./takode-session-commands.js";

const USER_MESSAGE_HELP = `Usage: takode user-message --text-file <path|-> [--json]

Deprecated compatibility command. Publish a user-visible Markdown message from a text file or stdin.
`;

const THREAD_HELP = `Usage: takode thread attach <quest-id> --message <index> [more-indices...] [--json]
       takode thread attach <quest-id> --message 174 175 --json
       takode thread attach <quest-id> --range 174-182
       takode thread attach <quest-id> --turn 3
`;

const ANSWER_HELP = `Usage: takode answer <session> [--message <msg-id> | --target <id> | --thread <main|q-N> | --quest <q-N>] <response> [--json]

Answer a pending needs-input question or approve/reject an ExitPlanMode prompt from a herded session.
`;

const NOTIFY_HELP = `Usage: takode notify <category> <summary> [--suggest <answer>]... [--json]
       takode notify list [--json]
       takode notify resolve <notification-id> [--json]
`;

const WORKER_STREAM_HELP = `Usage: takode worker-stream [--json]

Stream the current worker/reviewer turn activity to the leader as an internal herd checkpoint.
`;

const PHASES_HELP = `Usage: takode phases [--json]

List available Quest Journey phases from phase metadata, including exact leader/assignee brief paths.
`;

async function ensureTakodeAccess(base: string, options?: { requireOrchestrator?: boolean }): Promise<void> {
  const me = (await apiGet(base, "/takode/me")) as { isOrchestrator?: boolean };
  if (options?.requireOrchestrator && me.isOrchestrator !== true) {
    err("takode commands require an orchestrator session.");
  }
}

interface QuestJourneyPhaseCatalogEntry {
  id: string;
  label: string;
  boardState: string;
  assigneeRole: string;
  contract: string;
  nextLeaderAction: string;
  aliases: string[];
  sourceType: string;
  sourcePath: string;
  phaseJsonPath: string;
  leaderBriefPath: string;
  assigneeBriefPath: string;
  phaseJsonDisplayPath: string;
  leaderBriefDisplayPath: string;
  assigneeBriefDisplayPath: string;
}

export async function handleSend(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  const usage =
    "Usage: takode send <session> <message> [--correction] [--json]\n       takode send <session> --stdin [--correction] [--json]";
  const flags = parseFlags(args.slice(1));
  assertKnownFlags(flags, new Set(["json", "correction", "stdin"]), usage);

  const jsonMode = flags.json === true;
  const isCorrection = flags.correction === true;
  const useStdin = flags.stdin === true;

  const messageParts = args.slice(1).filter((arg) => arg !== "--json" && arg !== "--correction" && arg !== "--stdin");

  if (!sessionRef) err(usage);
  if (useStdin && messageParts.length > 0) {
    err("Cannot combine --stdin with a positional message.");
  }

  const cleanContent = useStdin ? await readStdinText() : messageParts.join(" ");

  if (!cleanContent.trim()) err(usage);

  // Guard: orchestrators can only send to herded sessions
  const callerSessionId = getCredentials()?.sessionId;
  if (callerSessionId) {
    try {
      // Resolve target to a full UUID
      const targetSession = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}`)) as {
        sessionId: string;
        sessionNum?: number;
        name?: string;
        isGenerating?: boolean;
        archived?: boolean;
      };
      const targetId = targetSession.sessionId;
      if (targetSession.archived) {
        const label = targetSession.name
          ? `#${targetSession.sessionNum ?? "?"} ${targetSession.name}`
          : `#${targetSession.sessionNum ?? sessionRef}`;
        err(`Cannot send to archived session ${label}.`);
      }

      // Guard: block sends to running sessions unless --correction is used
      if (targetSession.isGenerating && !isCorrection) {
        const label = targetSession.name
          ? `#${targetSession.sessionNum ?? "?"} ${targetSession.name}`
          : `#${targetSession.sessionNum ?? sessionRef}`;
        err(
          `Session ${label} is currently working. ` +
            `Queue this task and send it after the session finishes. ` +
            `Use "takode send ${sessionRef} <message> --correction" if this is a steering message for the current task.`,
        );
      }

      // Check herd membership
      const herdList = (await apiGet(base, `/sessions/${encodeURIComponent(callerSessionId)}/herd`)) as Array<{
        sessionId: string;
      }>;
      if (!herdList.some((s) => s.sessionId === targetId)) {
        err(`Cannot send to session ${sessionRef} — not in your herd. Run \`takode herd ${sessionRef}\` first.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If error is from our own guards (herd check, running check), re-throw
      if (msg.includes("not in your herd") || msg.includes("currently working") || msg.includes("archived session")) {
        throw e;
      }
      // Other errors (session not found, etc.) — let the send call handle it
    }
  }

  // Identify the calling session so the receiver can show an agent badge
  let agentSource: { sessionId: string; sessionLabel?: string } | undefined;
  if (callerSessionId) {
    let sessionLabel: string | undefined;
    try {
      const sessions = (await apiGet(base, "/takode/sessions")) as Array<{
        sessionId: string;
        sessionNum?: number;
        name?: string;
      }>;
      const own = sessions.find((s) => s.sessionId === callerSessionId);
      if (own) {
        sessionLabel = own.name
          ? `#${own.sessionNum ?? "?"} ${own.name}`
          : `#${own.sessionNum ?? callerSessionId.slice(0, 8)}`;
      }
    } catch {
      // Non-critical — send without label
    }
    agentSource = { sessionId: callerSessionId, ...(sessionLabel ? { sessionLabel } : {}) };
  }

  const result = await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/message`, {
    content: cleanContent,
    ...(agentSource ? { agentSource } : {}),
  });

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const delivery = (result as { delivery?: string }).delivery;
  if (delivery === "queued") {
    console.log(
      `[${formatTime(Date.now())}] \u2713 Message queued for session ${formatInlineText(sessionRef)} (session restarting)`,
    );
  } else {
    console.log(`[${formatTime(Date.now())}] \u2713 Message sent to session ${formatInlineText(sessionRef)}`);
  }
}

export async function handleUserMessage(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, new Set(["json", "text-file"]), USER_MESSAGE_HELP.trim());
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--text-file") {
      i++;
      continue;
    }
    if (arg === "--json") continue;
    if (arg.startsWith("--")) continue;
    positional.push(arg);
  }
  if (positional.length > 0) {
    err(`${USER_MESSAGE_HELP.trim()}\n\nDo not pass message text positionally. Use --text-file <path|->.`);
  }

  const textFile = flags["text-file"];
  if (textFile === undefined) {
    err(`${USER_MESSAGE_HELP.trim()}\n\n--text-file is required.`);
  }
  if (textFile === true) {
    err(`${USER_MESSAGE_HELP.trim()}\n\n--text-file requires a path or '-' for stdin.`);
  }
  const content = await readOptionTextFile(textFile, "--text-file");
  if (!content.trim()) err("User-visible message content is required.");

  const selfId = getCallerSessionId();
  const result = await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/user-message`, { content });
  if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`[${formatTime(Date.now())}] \u2713 User-visible message published`);
}

export async function handleThread(base: string, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "attach") err(THREAD_HELP.trim());

  const questId = args[1]?.trim().toLowerCase();
  if (!questId) err(THREAD_HELP.trim());
  if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);

  const optionArgs = args.slice(2);
  const flags = parseFlags(optionArgs);
  assertKnownFlags(flags, new Set(["json", "message", "range", "turn"]), THREAD_HELP.trim());
  const messages = collectThreadAttachMessageIndices(optionArgs);
  const range = flags.range;
  const turn = flags.turn;
  if (messages.length === 0 && range === undefined && turn === undefined) {
    err(`${THREAD_HELP.trim()}\n\nProvide --message <index>, --range <start-end>, or --turn <turn>.`);
  }
  if (range !== undefined && range === true) err("--range requires a start-end value.");
  if (turn !== undefined && turn === true) err("--turn requires a visible turn number from takode scan/peek.");

  const body: Record<string, unknown> = { questId };
  if (messages.length === 1) {
    body.message = messages[0];
  } else if (messages.length > 1) {
    body.messages = messages;
  }
  if (range !== undefined) {
    if (!/^\d+-\d+$/.test(range)) err("--range must use start-end message indices, e.g. 174-182.");
    body.range = range;
  }
  if (turn !== undefined) {
    const parsed = Number(turn);
    if (!Number.isInteger(parsed) || parsed < 0) err("--turn must be a non-negative integer turn number.");
    body.turn = parsed;
  }

  const selfId = getCallerSessionId();
  const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/thread/attach`, body)) as {
    attached?: number[];
    outOfRange?: number[];
  };
  if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const attached = result.attached?.join(", ") || "none";
  const skipped = result.outOfRange?.length ? ` (${result.outOfRange.length} out of range)` : "";
  console.log(`[${formatTime(Date.now())}] \u2713 Attached ${attached} to ${questId}${skipped}`);
}

function collectThreadAttachMessageIndices(args: string[]): number[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--message") continue;
    index++;
    let sawValue = false;
    while (index < args.length && !args[index].startsWith("--")) {
      sawValue = true;
      values.push(
        ...args[index]
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
      index++;
    }
    index--;
    if (!sawValue) err("--message requires at least one numeric history index.");
  }
  const parsed = values.map((value) => Number(value));
  if (parsed.some((value) => !Number.isInteger(value) || value < 0)) {
    err("--message values must be non-negative integer history indices.");
  }
  return [...new Set(parsed)];
}

// ─── Spawn handler ───────────────────────────────────────────────────────────

export const SPAWN_FLAG_USAGE = `Usage: takode spawn [options]

  Create and auto-herd new worker sessions.

Options:
  --backend <type>             AI backend: "claude", "codex", or "claude-sdk" (default: inherit from leader)
  --cwd <path>                 Working directory (default: current directory)
  --count <n>                  Number of sessions to spawn (default: 1)
  --message <text>             Short inline initial message
  --message-file <path>|-      Read the initial message from a file or stdin
  --model <id>                 Override the session model
  --ask / --no-ask             Override inherited ask mode
  --internet / --no-internet   Codex-only: enable or disable internet access
  --reasoning-effort <level>   Codex-only: low, medium, or high
  --no-worktree                Disable worktree creation
  --fixed-name <name>          Set a fixed session name (disables auto-naming)
  --reviewer <session>         Create a reviewer session tied to a parent worker (by session number)
  --json                       Output in JSON format

Examples:
  takode spawn --backend claude-sdk --count 2
  takode spawn --backend codex --model gpt-5.4 --reasoning-effort high --internet
  takode spawn --count 3 --no-worktree
  takode spawn --message-file /tmp/dispatch.txt
  printf '%s\n' 'Review q-10' 'Treat \`$(nope)\` as literal text.' | takode spawn --reviewer 42 --message-file -`;

const SPAWN_ALLOWED_FLAGS = new Set([
  "backend",
  "cwd",
  "count",
  "message",
  "message-file",
  "model",
  "ask",
  "no-ask",
  "internet",
  "no-internet",
  "reasoning",
  "reasoning-effort",
  "no-worktree",
  "fixed-name",
  "reviewer",
  "json",
  "help",
  "h",
]);

const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);

function resolveReasoningEffort(flags: Record<string, string | boolean>): string | undefined {
  const primary = flags["reasoning-effort"];
  const alias = flags.reasoning;
  if (primary !== undefined && alias !== undefined) {
    err("Cannot combine --reasoning-effort and --reasoning.");
  }
  const raw = primary ?? alias;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") err("--reasoning-effort requires a value: low, medium, or high.");
  const normalized = raw.trim().toLowerCase();
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    err(`Invalid --reasoning-effort: ${raw}. Expected low, medium, or high.`);
  }
  return normalized;
}

function buildSpawnDetailParts(session: TakodeSessionInfo): string[] {
  const parts: string[] = [];
  if (session.model) parts.push(`model=${session.model}`);
  if (typeof session.askPermission === "boolean") {
    parts.push(`ask=${session.askPermission ? "on" : "off"}`);
  }
  parts.push(`worktree=${session.isWorktree ? "yes" : "no"}`);
  if (session.backendType === "codex") {
    if (session.codexReasoningEffort) parts.push(`reasoning=${session.codexReasoningEffort}`);
    if (typeof session.codexInternetAccess === "boolean") {
      parts.push(`internet=${session.codexInternetAccess ? "on" : "off"}`);
    }
  }
  return parts;
}

function printSpawnedSession(session: TakodeSessionInfo): void {
  const num = session.sessionNum != null ? `#${session.sessionNum}` : session.sessionId.slice(0, 8);
  const name = formatInlineText(session.name || "(unnamed)");
  const backend = session.backendType === "codex" ? " [codex]" : "";
  const wt = session.isWorktree ? " wt" : "";
  const branch = formatInlineText(session.actualBranch || session.branch || "");
  const branchLabel = branch ? `  ${branch}` : "";
  const cwdLabel = session.cwd ? formatInlineText(session.cwd.replace(/\/$/, "").split("/").pop() || session.cwd) : "";
  console.log(`[${formatTime(Date.now())}] \u2713 Spawned ${num} "${name}"${backend}${wt}`);
  console.log(`        ${cwdLabel}${branchLabel}  ${formatInlineText(session.sessionId)}`);
  const detailParts = buildSpawnDetailParts(session);
  if (detailParts.length > 0) {
    console.log(`        ${detailParts.map((part) => formatInlineText(part)).join("  ")}`);
  }
}

export async function handleSpawn(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, SPAWN_ALLOWED_FLAGS, SPAWN_FLAG_USAGE);

  if (flags.help === true || flags.h === true) {
    console.log(`\n${SPAWN_FLAG_USAGE}\n`);
    return;
  }

  await ensureTakodeAccess(base, { requireOrchestrator: true });

  const jsonMode = flags.json === true;
  const leaderSessionId = getCallerSessionId();

  // Fetch leader session first -- we need backendType for default resolution
  // and permissionMode for bypass inheritance.
  const leader = (await apiGet(base, `/sessions/${encodeURIComponent(leaderSessionId)}`)) as {
    sessionId: string;
    sessionNum?: number | null;
    name?: string | null;
    permissionMode?: string;
    backendType?: string;
  };
  const leaderSessionLabel = leader.name
    ? `#${leader.sessionNum ?? "?"} ${leader.name}`
    : leader.sessionNum != null
      ? `#${leader.sessionNum}`
      : undefined;

  // Inherit backend from leader when --backend is not explicitly provided.
  const backendRaw = typeof flags.backend === "string" ? flags.backend : leader.backendType || "claude";
  if (backendRaw !== "claude" && backendRaw !== "codex" && backendRaw !== "claude-sdk") {
    err(`Invalid backend: ${backendRaw}. Expected "claude", "codex", or "claude-sdk".`);
  }

  let cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const useWorktree = flags["no-worktree"] === true ? false : true;
  const fixedName = typeof flags["fixed-name"] === "string" ? flags["fixed-name"].trim() : "";
  if (flags["fixed-name"] !== undefined && !fixedName) {
    err("--fixed-name requires a non-empty name value.");
  }
  const message =
    (await readOptionalRichTextOption(flags, {
      inlineFlag: "message",
      fileFlag: "message-file",
      label: "Initial message",
    })) ?? "";
  const model = resolveStringFlag(flags, "model", "model");
  const askOverride = resolveBooleanToggleFlag(flags, "ask", "no-ask");
  const internetOverride = resolveBooleanToggleFlag(flags, "internet", "no-internet");
  const reasoningEffort = resolveReasoningEffort(flags);

  // --reviewer <session-number>: create a reviewer session tied to a parent worker
  const reviewerRaw = flags.reviewer;
  let reviewerOfNum: number | undefined;
  if (reviewerRaw !== undefined) {
    const parsed = Number(String(reviewerRaw).replace(/^#/, ""));
    if (!Number.isInteger(parsed) || parsed < 0) {
      err("--reviewer requires a valid session number (e.g. --reviewer 42).");
    }
    reviewerOfNum = parsed;
  }

  const countRaw = flags.count;
  const count = countRaw === undefined ? 1 : Number(countRaw);
  if (!Number.isInteger(count) || count < 1) {
    err("Invalid --count. Expected a positive integer.");
  }
  if (backendRaw !== "codex" && internetOverride !== undefined) {
    err("--internet and --no-internet are only supported for Codex sessions.");
  }
  if (backendRaw !== "codex" && reasoningEffort !== undefined) {
    err("--reasoning-effort is only supported for Codex sessions.");
  }

  // Reviewer-specific validations
  if (reviewerOfNum !== undefined) {
    if (count > 1) {
      err("--reviewer cannot be combined with --count > 1. Only one reviewer per parent.");
    }

    // Check that no existing active reviewer already targets this parent
    try {
      const allSessions = (await apiGet(base, "/takode/sessions")) as Array<{
        sessionId: string;
        archived?: boolean;
        reviewerOf?: number;
        name?: string;
        sessionNum?: number;
        cwd?: string;
      }>;
      const existingReviewer = allSessions.find((s) => !s.archived && s.reviewerOf === reviewerOfNum);
      if (existingReviewer) {
        const existingLabel =
          existingReviewer.sessionNum !== undefined
            ? `#${existingReviewer.sessionNum}`
            : existingReviewer.sessionId.slice(0, 8);
        err(
          `Session #${reviewerOfNum} already has an active reviewer (${existingLabel}). ` +
            `Archive it first with \`takode archive ${existingLabel}\`.`,
        );
      }

      // Inherit the parent worker's cwd so the reviewer lands in the same
      // sidebar project group. repoRoot is inferred by the server from cwd.
      const parentSession = allSessions.find((s) => s.sessionNum === reviewerOfNum && !s.archived);
      if (parentSession?.cwd?.trim() && typeof flags.cwd !== "string") {
        cwd = parentSession.cwd;
      }
    } catch (e) {
      // Only re-throw our own errors (from err()); skip API fetch failures
      if (e instanceof Error && e.message.startsWith("Session #")) throw e;
    }
  }

  const inheritBypass = leader.permissionMode === "bypassPermissions";

  const spawned: TakodeSessionInfo[] = [];
  for (let i = 0; i < count; i++) {
    const createPayload: Record<string, unknown> = {
      backend: backendRaw,
      cwd,
      useWorktree: reviewerOfNum !== undefined ? false : useWorktree,
      createdBy: leaderSessionId,
    };

    // Reviewer sessions: auto-set name and suppress auto-naming
    if (reviewerOfNum !== undefined) {
      createPayload.reviewerOf = reviewerOfNum;
      createPayload.noAutoName = true;
      if (!fixedName) {
        createPayload.fixedName = `Reviewer of #${reviewerOfNum}`;
      } else {
        createPayload.fixedName = fixedName;
      }
    } else if (fixedName) {
      createPayload.noAutoName = true;
      createPayload.fixedName = fixedName;
    }
    if (model) {
      createPayload.model = model;
    }

    const askPermission = askOverride ?? (inheritBypass ? false : undefined);
    if (askPermission !== undefined) {
      createPayload.askPermission = askPermission;
      if (backendRaw === "codex" && askPermission === false) {
        createPayload.permissionMode = "bypassPermissions";
      }
    }

    if (backendRaw === "codex") {
      createPayload.codexReasoningEffort = reasoningEffort || "high";
      if (internetOverride !== undefined) {
        createPayload.codexInternetAccess = internetOverride;
      } else if (inheritBypass) {
        createPayload.codexInternetAccess = true;
      }
    }

    const created = (await apiPost(base, "/sessions/create", createPayload)) as { sessionId: string };

    if (message) {
      await apiPost(base, `/sessions/${encodeURIComponent(created.sessionId)}/message`, {
        content: message,
        agentSource: {
          sessionId: leaderSessionId,
          ...(leaderSessionLabel ? { sessionLabel: leaderSessionLabel } : {}),
        },
      });
    }

    spawned.push(await fetchSessionInfo(base, created.sessionId));
  }

  // Check worker-slot usage and warn if over the limit.
  let herdWarning: { workerSlotsUsed: number; excessWorkers: number; limit: number } | null = null;
  try {
    const allSessions = (await apiGet(base, "/takode/sessions")) as Array<{
      sessionId: string;
      archived?: boolean;
      herdedBy?: string;
      reviewerOf?: number;
    }>;
    const activeHerdWorkers = allSessions.filter(
      (s) => !s.archived && s.herdedBy === leaderSessionId && s.reviewerOf === undefined,
    );
    if (activeHerdWorkers.length > HERD_WORKER_SLOT_LIMIT) {
      herdWarning = {
        workerSlotsUsed: activeHerdWorkers.length,
        excessWorkers: activeHerdWorkers.length - HERD_WORKER_SLOT_LIMIT,
        limit: HERD_WORKER_SLOT_LIMIT,
      };
    }
  } catch {
    // Non-critical — skip warning if we can't fetch sessions
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          count: spawned.length,
          backend: backendRaw,
          cwd,
          useWorktree,
          leaderSessionId,
          leaderPermissionMode: leader.permissionMode || null,
          inheritedAskPermission: askOverride === undefined && inheritBypass ? false : null,
          defaultModel: backendRaw === "codex" && !model ? getCliDefaultModelForBackend("codex") : null,
          message: message || null,
          sessions: spawned,
          ...(herdWarning ? { herdWarning } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const session of spawned) {
    printSpawnedSession(session);
  }
  if (herdWarning) {
    console.log(
      `\n\u26a0 Worker slots used: ${herdWarning.workerSlotsUsed}/${herdWarning.limit}. Please archive ${herdWarning.excessWorkers} worker session${herdWarning.excessWorkers === 1 ? "" : "s"} least likely to be reused. Reviewers do not use worker slots, and archiving reviewers will not free worker-slot capacity. Archived sessions' history remains readable via takode peek/read.`,
    );
  }
}

// ─── Rename handler ─────────────────────────────────────────────────────────

export async function handleRename(base: string, args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const sessionRef = positional[0];
  const name = positional.slice(1).join(" ");
  const jsonMode = args.includes("--json");
  if (!sessionRef || !name.trim()) err("Usage: takode rename <session> <name>");

  const result = (await apiPatch(base, `/sessions/${encodeURIComponent(sessionRef)}/name`, {
    name: name.trim(),
  })) as { ok: boolean; name?: string; error?: string };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `[${formatTime(Date.now())}] ✓ Renamed session ${formatInlineText(sessionRef)} → "${formatInlineText(result.name || name.trim())}"`,
  );
}

// ─── Interrupt handler ──────────────────────────────────────────────────────

export async function handleInterrupt(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode interrupt <session>");

  const mySessionId = getCallerSessionId();

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/interrupt`, {
    callerSessionId: mySessionId,
  })) as { ok: boolean; sessionId?: string; error?: string };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[${formatTime(Date.now())}] \u2713 Interrupted session ${formatInlineText(sessionRef)}`);
}

// ─── Archive handler ─────────────────────────────────────────────────────────

export async function handleArchive(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode archive <session>");

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/archive`, {})) as {
    ok: boolean;
    error?: string;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.ok) {
    console.log(`[${formatTime(Date.now())}] \u2713 Archived session ${formatInlineText(sessionRef)}`);
  } else {
    console.log(
      `[${formatTime(Date.now())}] \u2717 Failed to archive session ${formatInlineText(sessionRef)}: ${result.error || "unknown error"}`,
    );
  }
}

// ─── Herd/Unherd handlers ───────────────────────────────────────────────────

export async function handleHerd(base: string, args: string[]): Promise<void> {
  const jsonMode = args.includes("--json");
  const forceMode = args.includes("--force");
  // Parse comma/space-separated session refs (filtering out flags)
  const refs = args
    .filter((a) => !a.startsWith("--"))
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (refs.length === 0) err("Usage: takode herd [--force] <session1,session2,...>");

  const mySessionId = getCallerSessionId();

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(mySessionId)}/herd`, {
    workerIds: refs,
    ...(forceMode ? { force: true } : {}),
  })) as HerdSessionsResponse;

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    if (result.conflicts?.length > 0 && !forceMode) {
      const suggestionRefs = result.conflicts.map((c) => c.id).join(",");
      err(
        `Herd request conflicted with existing ownership. Rerun with \`takode herd --force ${suggestionRefs}\` if takeover is intended.`,
      );
    }
    return;
  }

  if (result.herded.length > 0) {
    console.log(`[${formatTime(Date.now())}] \u2713 Herded ${result.herded.length} session(s)`);
    await Promise.all(
      result.herded.map(async (sid) => {
        try {
          const info = await fetchSessionInfo(base, sid);
          printSessionLine(info);
        } catch (err) {
          console.error(`  Failed to fetch info for ${formatInlineText(sid)}: ${err}`);
        }
      }),
    );
  }
  if (result.reassigned.length > 0) {
    for (const reassigned of result.reassigned) {
      console.log(
        `[${formatTime(Date.now())}] \u21ba Reassigned ${formatInlineText(reassigned.id)} from ${formatInlineText(reassigned.fromLeader)}`,
      );
    }
  }
  if (result.notFound.length > 0) {
    console.log(
      `[${formatTime(Date.now())}] \u2717 Not found: ${result.notFound.map((ref) => formatInlineText(ref)).join(", ")}`,
    );
  }
  if (result.conflicts?.length > 0) {
    for (const c of result.conflicts) {
      console.log(
        `[${formatTime(Date.now())}] \u2717 Conflict: ${formatInlineText(c.id)} already herded by ${formatInlineText(c.herder)}`,
      );
    }
    if (!forceMode) {
      const suggestionRefs = result.conflicts.map((c) => c.id).join(",");
      err(
        `Herd request conflicted with existing ownership. Rerun with \`takode herd --force ${suggestionRefs}\` if takeover is intended.`,
      );
    }
  }
  if (result.leaders.length > 0) {
    for (const lid of result.leaders) {
      console.log(`[${formatTime(Date.now())}] \u2717 Cannot herd leader session: ${formatInlineText(lid)}`);
    }
  }
}

export async function handleUnherd(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode unherd <session>");

  const mySessionId = getCallerSessionId();

  const result = (await apiDelete(
    base,
    `/sessions/${encodeURIComponent(mySessionId)}/herd/${encodeURIComponent(sessionRef)}`,
  )) as { ok: boolean; removed: boolean };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.removed) {
    console.log(`[${formatTime(Date.now())}] \u2713 Unherded session ${formatInlineText(sessionRef)}`);
  } else {
    console.log(`[${formatTime(Date.now())}] Session ${formatInlineText(sessionRef)} was not herded by you`);
  }
}

// ─── Pending/Answer handlers ────────────────────────────────────────────────

export async function handlePending(base: string, args: string[]): Promise<void> {
  const sessionRef = args.filter((a) => !a.startsWith("--"))[0];
  const jsonMode = args.includes("--json");
  if (!sessionRef) err("Usage: takode pending <session>");
  const safeSessionRef = formatInlineText(sessionRef);

  const result = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/pending`)) as {
    pending: Array<{
      kind?: "permission" | "notification";
      request_id?: string;
      tool_name: string;
      timestamp: number;
      notification_id?: string;
      summary?: string;
      suggestedAnswers?: string[];
      msg_index?: number;
      threadKey?: string;
      questId?: string;
      questions?: Array<{
        header?: string;
        question: string;
        options?: Array<{ label: string; description?: string }>;
      }>;
      plan?: string;
      allowedPrompts?: Array<{ tool: string; prompt: string }>;
    }>;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.pending.length === 0) {
    console.log("No pending questions, needs-input prompts, or plans to answer.");
    return;
  }

  const buildAnswerTargetHint = (pendingItem: (typeof result.pending)[number]): string => {
    if (typeof pendingItem.msg_index === "number") return ` --message ${pendingItem.msg_index}`;
    if (typeof pendingItem.request_id === "string" && pendingItem.request_id)
      return ` --target ${pendingItem.request_id}`;
    if (typeof pendingItem.notification_id === "string" && pendingItem.notification_id) {
      return ` --target ${pendingItem.notification_id}`;
    }
    return "";
  };

  for (const p of result.pending) {
    const msgRef = typeof p.msg_index === "number" ? ` [msg ${p.msg_index}]` : "";
    const targetHint = buildAnswerTargetHint(p);

    if (p.kind === "notification" || p.tool_name === "takode.notify") {
      const summary = p.summary?.trim() || "Needs input";
      console.log(`\n[needs-input]${msgRef} ${formatInlineText(summary)}`);
      if (msgRef) {
        console.log(`\nFull message: takode read ${safeSessionRef} ${p.msg_index}`);
      }
      if (p.suggestedAnswers?.length) {
        console.log(`Suggestions: ${p.suggestedAnswers.map((answer) => formatInlineText(answer)).join(", ")}`);
      }
      console.log(`Answer: takode answer ${safeSessionRef}${targetHint} <response>`);
    } else if (p.tool_name === "AskUserQuestion" && p.questions) {
      for (const q of p.questions) {
        console.log(`\n[AskUserQuestion]${msgRef} ${formatInlineText(q.question)}`);
        if (q.options) {
          for (let i = 0; i < q.options.length; i++) {
            const opt = q.options[i];
            console.log(
              `  ${i + 1}. ${formatInlineText(opt.label)}${opt.description ? ` -- ${formatInlineText(opt.description)}` : ""}`,
            );
          }
        }
        if (msgRef) {
          console.log(`\nFull message: takode read ${safeSessionRef} ${p.msg_index}`);
        }
        console.log(`Answer: takode answer ${safeSessionRef}${targetHint} <option-number-or-text>`);
      }
    } else if (p.tool_name === "ExitPlanMode") {
      const planPreview = typeof p.plan === "string" ? p.plan.slice(0, TAKODE_PEEK_CONTENT_LIMIT) : "(no plan text)";
      console.log(`\n[ExitPlanMode]${msgRef} Plan approval requested`);
      console.log(formatInlineText(planPreview));
      if (typeof p.plan === "string" && p.plan.length > 500) {
        console.log("  ...(truncated)");
      }
      if (msgRef) {
        console.log(`\nFull plan: takode read ${safeSessionRef} ${p.msg_index}`);
      }
      console.log(`Approve: takode answer ${safeSessionRef}${targetHint} approve`);
      console.log(`Reject:  takode answer ${safeSessionRef}${targetHint} reject 'feedback here'`);
    }
  }
}

export async function handleAnswer(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  const flags = parseFlags(args.slice(1));
  assertKnownFlags(flags, new Set(["json", "message", "target", "thread", "quest"]), ANSWER_HELP.trim());
  const jsonMode = flags.json === true;
  const targetId = typeof flags.target === "string" ? flags.target.trim() : "";
  const threadKey = typeof flags.thread === "string" ? flags.thread.trim() : "";
  const questId = typeof flags.quest === "string" ? flags.quest.trim() : "";
  if (flags.thread === true) err("--thread requires main or q-N.");
  if (flags.quest === true) err("--quest requires q-N.");
  if (threadKey && questId) err("Use either --thread or --quest, not both.");
  const msgIndexRaw = typeof flags.message === "string" ? flags.message.trim() : "";
  const msgIndex = msgIndexRaw ? Number.parseInt(msgIndexRaw, 10) : undefined;
  if (msgIndexRaw && !Number.isInteger(msgIndex)) {
    err(ANSWER_HELP.trim());
  }
  if (!sessionRef || sessionRef.startsWith("--")) {
    err(ANSWER_HELP.trim());
  }
  const responseParts: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (arg === "--message" || arg === "--target" || arg === "--thread" || arg === "--quest") {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    responseParts.push(arg);
  }
  const response = responseParts.join(" ");

  if (!response) err(ANSWER_HELP.trim());

  const mySessionId = getCallerSessionId();

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/answer`, {
    response,
    callerSessionId: mySessionId,
    ...(targetId ? { targetId } : {}),
    ...(msgIndex !== undefined ? { msgIndex } : {}),
    ...(threadKey ? { threadKey } : {}),
    ...(questId ? { questId } : {}),
  })) as {
    ok: boolean;
    kind?: "permission" | "notification";
    tool_name: string;
    answer?: string;
    action?: string;
    feedback?: string;
    error?: string;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.kind === "notification" || result.tool_name === "takode.notify") {
    console.log(`[${formatTime(Date.now())}] \u2713 Answered needs-input prompt: "${formatInlineText(result.answer)}"`);
  } else if (result.tool_name === "AskUserQuestion") {
    console.log(`[${formatTime(Date.now())}] \u2713 Answered: "${formatInlineText(result.answer)}"`);
  } else if (result.tool_name === "ExitPlanMode") {
    if (result.action === "approved") {
      console.log(`[${formatTime(Date.now())}] \u2713 Plan approved`);
    } else {
      console.log(`[${formatTime(Date.now())}] \u2717 Plan rejected: ${formatInlineText(result.feedback)}`);
    }
  }
}

// ─── Search handler ──────────────────────────────────────────────────────────

export async function handleSearch(base: string, args: string[]): Promise<void> {
  const query = args
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (!query) err("Usage: takode search <query> [--all] [--json]");

  const flags = parseFlags(args);
  const showAll = flags.all === true;
  const jsonMode = flags.json === true;

  const sessions = (await apiGet(base, "/takode/sessions")) as Array<{
    sessionId: string;
    sessionNum?: number;
    name?: string;
    state: string;
    archived?: boolean;
    cwd: string;
    createdAt: number;
    lastActivityAt?: number;
    backendType?: string;
    cliConnected?: boolean;
    lastMessagePreview?: string;
    gitBranch?: string;
    isWorktree?: boolean;
    isOrchestrator?: boolean;
    isAssistant?: boolean;
    repoRoot?: string;
    taskHistory?: Array<{ title: string }>;
    keywords?: string[];
  }>;

  const params = new URLSearchParams({ q: query });
  if (!showAll) {
    params.set("includeArchived", "false");
  }
  const searchResp = (await apiGet(base, `/sessions/search?${params.toString()}`)) as {
    query: string;
    tookMs: number;
    totalMatches: number;
    results: Array<{
      sessionId: string;
      score: number;
      matchedField: "name" | "task" | "keyword" | "branch" | "path" | "repo" | "user_message";
      matchContext: string | null;
      matchedAt: number;
      messageMatch?: {
        id?: string;
        timestamp: number;
        snippet: string;
      };
    }>;
  };

  const sessionsById = new Map(sessions.map((s) => [s.sessionId, s]));
  const fieldLabel = (field: "name" | "task" | "keyword" | "branch" | "path" | "repo" | "user_message"): string => {
    if (field === "user_message") return "message";
    return field;
  };
  const snippetFromContext = (context: string | null): string => {
    if (!context) return "";
    const m = context.match(/^[a-z_]+:\s*(.*)$/i);
    return (m?.[1] ?? context).trim();
  };

  type SearchResultRow = {
    session: (typeof sessions)[number] | undefined;
    match: (typeof searchResp.results)[number];
    matchReason: string;
    snippet: string;
    messageId: string | null;
    matchedFieldLabel: string;
  };

  const mappedResults: SearchResultRow[] = searchResp.results.map((match) => {
    const session = sessionsById.get(match.sessionId);
    const fallbackName = session?.name || "(unnamed)";
    const snippet =
      match.messageMatch?.snippet?.trim() ||
      snippetFromContext(match.matchContext) ||
      (match.matchedField === "name" ? fallbackName : "");
    const matchReason = match.matchContext || `${fieldLabel(match.matchedField)} match`;
    const messageId = match.matchedField === "user_message" ? match.messageMatch?.id || null : null;
    return {
      session,
      match,
      matchReason,
      snippet,
      messageId,
      matchedFieldLabel: fieldLabel(match.matchedField),
    };
  });

  const results = mappedResults.filter((row): row is SearchResultRow & { session: (typeof sessions)[number] } => {
    if (!row.session) return false; // Drop stale search rows that no longer map to a visible session.
    if (showAll) return true;
    return !row.session.archived && row.session.state !== "exited";
  });

  if (jsonMode) {
    console.log(
      JSON.stringify(
        results.map((r) => ({
          ...r.session,
          matchedField: r.match.matchedField,
          matchReason: r.matchReason,
          matchContext: r.match.matchContext,
          snippet: r.snippet,
          messageId: r.messageId,
          matchedAt: r.match.matchedAt,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (results.length === 0) {
    console.log(`No sessions matching "${formatInlineText(query)}".`);
    return;
  }

  console.log(`${results.length} session(s) matching "${formatInlineText(query)}":`);
  console.log("");

  for (const row of results) {
    const s = row.session;
    const num = s.sessionNum !== undefined ? `#${s.sessionNum}` : "  ";
    const name = formatInlineText(s.name || "(unnamed)");
    const status = s.cliConnected ? (s.state === "running" ? "●" : "○") : s.archived ? "⊘" : "✗";
    const activity = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : "";
    const sessionRef = s.sessionNum != null ? String(s.sessionNum) : s.sessionId;

    console.log(`  ${num.padEnd(5)} ${status} ${name}`);
    console.log(
      `        field: ${formatInlineText(row.matchedFieldLabel)}  reason: ${formatInlineText(row.matchReason)}`,
    );
    if (row.snippet) {
      console.log(`        snippet: ${truncate(row.snippet, TAKODE_PEEK_CONTENT_LIMIT)}`);
    }
    if (row.messageId) {
      const messageId = formatInlineText(row.messageId);
      console.log(`        message id: ${messageId} (takode peek ${sessionRef} --from ${messageId})`);
    }
    if (activity) {
      console.log(`        activity: ${activity}`);
    }
    console.log("");
  }
}

// ─── Branch management commands ──────────────────────────────────────────────

export async function handleSetBase(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode set-base <session> <branch> [--json]");
  const branch = args[1];
  if (branch === undefined) err("Usage: takode set-base <session> <branch> [--json]");

  const flags = parseFlags(args.slice(2));
  const jsonMode = flags.json === true;

  const result = (await apiPatch(base, `/sessions/${encodeURIComponent(sessionRef)}/diff-base`, { branch })) as {
    ok: boolean;
    diff_base_branch: string;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Diff base set to: ${result.diff_base_branch || "(default)"}`);
}

function parseNotifyCreateArgs(args: string[]): {
  jsonMode: boolean;
  summary: string | undefined;
  suggestedAnswers: string[];
} {
  let jsonMode = false;
  const suggestedAnswers: string[] = [];
  const summaryParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      jsonMode = true;
      continue;
    }
    if (arg === "--suggest") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        err("Usage: takode notify needs-input <summary> --suggest <answer> [--suggest <answer>]...");
      }
      suggestedAnswers.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      err(`Unknown notify option: ${arg}`);
    }
    summaryParts.push(arg);
  }

  return {
    jsonMode,
    summary: summaryParts.length > 0 ? summaryParts.join(" ") : undefined,
    suggestedAnswers,
  };
}

export async function handleNotify(base: string, args: string[]): Promise<void> {
  const subcommand = args[0];
  const selfId = getCallerSessionId();

  if (subcommand === "list") {
    const flags = parseFlags(args.slice(1));
    const jsonMode = flags.json === true;
    const result = (await apiGet(base, `/sessions/${encodeURIComponent(selfId)}/notifications/needs-input/self`)) as {
      notifications: Array<{
        notificationId: number;
        rawNotificationId: string;
        summary?: string;
        suggestedAnswers?: string[];
        timestamp: number;
        messageId: string | null;
      }>;
      resolvedCount: number;
    };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.notifications.length === 0) {
      console.log(`No unresolved same-session needs-input notifications. Resolved: ${result.resolvedCount}.`);
      return;
    }
    console.log(
      `Unresolved same-session needs-input notifications: ${result.notifications.length}. Resolved: ${result.resolvedCount}.`,
    );
    for (const notification of result.notifications) {
      const summary = notification.summary?.trim() || "(no summary)";
      console.log(`  ${notification.notificationId}. ${formatInlineText(summary)}`);
      if (notification.suggestedAnswers?.length) {
        console.log(
          `     suggestions: ${notification.suggestedAnswers.map((answer) => formatInlineText(answer)).join(", ")}`,
        );
      }
    }
    return;
  }

  if (subcommand === "resolve") {
    const notificationArg = args.slice(1).find((arg) => !arg.startsWith("--"));
    if (!notificationArg) err("Usage: takode notify resolve <notification-id> [--json]");
    const notificationId = Number.parseInt(notificationArg, 10);
    if (!Number.isInteger(notificationId) || notificationId <= 0) {
      err("Usage: takode notify resolve <notification-id> [--json]");
    }
    const flags = parseFlags(args.slice(1));
    const jsonMode = flags.json === true;
    const result = (await apiPost(
      base,
      `/sessions/${encodeURIComponent(selfId)}/notifications/needs-input/${notificationId}/resolve`,
      {},
    )) as {
      ok: boolean;
      notificationId: number;
      rawNotificationId: string;
      changed: boolean;
    };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.changed) {
      console.log(`Resolved needs-input notification ${result.notificationId}.`);
    } else {
      console.log(`Needs-input notification ${result.notificationId} was already resolved.`);
    }
    return;
  }

  const category = subcommand;
  if (!category || (category !== "needs-input" && category !== "review")) {
    err(`${NOTIFY_HELP.trim()}\n`);
  }
  const parsed = parseNotifyCreateArgs(args.slice(1));
  const summary = parsed.summary;
  if (!summary) {
    err("Usage: takode notify <category> <summary>\nSummary is required -- describe what needs attention.");
  }
  const payload: Record<string, unknown> = { category };
  if (summary) payload.summary = summary;
  if (parsed.suggestedAnswers.length > 0) payload.suggestedAnswers = parsed.suggestedAnswers;
  const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/notify`, payload)) as {
    ok: boolean;
    category: string;
    anchoredMessageId: string | null;
    notificationId: number | null;
    rawNotificationId: string;
    suggestedAnswers?: string[];
  };
  if (parsed.jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const notificationLabel =
    typeof result.notificationId === "number"
      ? String(result.notificationId)
      : formatInlineText(result.rawNotificationId);
  console.log(`Notification sent (${category}, id ${notificationLabel})`);
}

export async function handleWorkerStream(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, new Set(["json"]), WORKER_STREAM_HELP.trim());
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 0) err(WORKER_STREAM_HELP.trim());

  const selfId = getCallerSessionId();
  const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/worker-stream`, {})) as {
    ok: boolean;
    streamed: boolean;
    reason: string;
    msgRange?: { from: number; to: number };
  };
  if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.streamed) {
    const range = result.msgRange ? ` [${result.msgRange.from}]-[${result.msgRange.to}]` : "";
    console.log(`Worker stream checkpoint queued${range}.`);
    return;
  }

  const reason =
    result.reason === "not_generating"
      ? "session is not currently generating"
      : result.reason === "dispatcher_unavailable"
        ? "herd event dispatcher is unavailable"
        : "no new activity to stream";
  console.log(`No worker stream checkpoint sent: ${reason}.`);
}

export async function handlePhases(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 0) err(PHASES_HELP.trim());

  const result = (await apiGet(base, "/takode/quest-journey-phases")) as {
    phases: QuestJourneyPhaseCatalogEntry[];
  };

  if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Quest Journey phases (${result.phases.length}):`);
  for (const phase of result.phases) {
    const aliases = phase.aliases.length > 0 ? ` aliases: ${phase.aliases.join(", ")}` : "";
    console.log(`\n${phase.id} -- ${phase.label} [${phase.sourceType}]`);
    console.log(`  role: ${phase.assigneeRole}  board: ${phase.boardState}${aliases}`);
    console.log(`  contract: ${formatInlineText(phase.contract)}`);
    console.log(`  assignee brief: ${phase.assigneeBriefDisplayPath}`);
    console.log(`  leader brief: ${phase.leaderBriefDisplayPath}`);
    console.log(`  phase metadata: ${phase.phaseJsonDisplayPath}`);
  }
}
