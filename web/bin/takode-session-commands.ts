import type { HerdSessionsResponse } from "../shared/herd-types.ts";
import { HERD_WORKER_SLOT_LIMIT } from "../shared/takode-constants.ts";
import {
  renderLeaderContextResumeText,
  type LeaderContextResumeModel,
} from "../server/takode-leader-context-resume.js";
import {
  apiGet,
  dateKey,
  err,
  fetchSessionInfo,
  formatDate,
  formatDurationSeconds,
  formatInlineText,
  formatRelativeTime,
  formatTime,
  formatTimeShort,
  formatTimestampCompact,
  getCredentials,
  getCallerSessionId,
  parseFlags,
  printTimerRows,
  truncate,
  type SessionTimerDetail,
  type TakodeSessionInfo,
} from "./takode-core.js";

export async function handleList(base: string, args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const showAll = flags.all === true;
  const showActive = flags.active === true;
  const showHerd = flags.herd === true;
  const showTasks = flags.tasks === true;
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
    model?: string;
    backendType?: string;
    isOrchestrator?: boolean;
    isAssistant?: boolean;
    cliConnected?: boolean;
    lastMessagePreview?: string;
    gitBranch?: string;
    gitAhead?: number;
    gitBehind?: number;
    totalLinesAdded?: number;
    totalLinesRemoved?: number;
    attentionReason?: string;
    repoRoot?: string;
    isWorktree?: boolean;
    herdedBy?: string;
    reviewerOf?: number;
    claimedQuestId?: string | null;
    claimedQuestStatus?: string | null;
    claimedQuestVerificationInboxUnread?: boolean;
    pendingTimerCount?: number;
    taskHistory?: Array<{ title: string; timestamp: number }>;
  }>;

  // 3-mode filter:
  //   default      — herded sessions only (orchestrator's flock, excludes self)
  //   --active     — all unarchived sessions (discovery/triage view)
  //   --all        — everything including archived
  const mySessionId = getCredentials()?.sessionId;
  const mySelf = mySessionId ? sessions.find((s) => s.sessionId === mySessionId) : null;
  const isOrchestrator = mySelf?.isOrchestrator === true;

  let filtered: typeof sessions;
  let filterHint = "";
  if (showAll) {
    filtered = sessions;
  } else if (showActive) {
    filtered = sessions.filter((s) => !s.archived);
    filterHint = " (use --all to include archived)";
  } else if (showHerd) {
    if (!isOrchestrator || !mySessionId) {
      err("--herd requires an orchestrator session. Only leaders have herded workers.");
    }
    filtered = sessions.filter((s) => !s.archived && s.herdedBy === mySessionId);
    filterHint =
      filtered.length === 0
        ? " (no herded sessions -- run `takode list --active` to discover, then `takode herd <ids>`)"
        : " (herded only)";
  } else if (isOrchestrator && mySessionId) {
    // Default for orchestrators: show only herded sessions (the flock)
    filtered = sessions.filter((s) => !s.archived && s.herdedBy === mySessionId);
    filterHint =
      filtered.length === 0
        ? " (no herded sessions — run `takode list --active` to discover, then `takode herd <ids>`)"
        : " (herded only — use --active to see all)";
  } else {
    filtered = sessions.filter((s) => !s.archived);
    filterHint = " (use --all to include archived)";
  }

  if (jsonMode) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log("No active sessions.");
    return;
  }

  const shownWorkerCount = filtered.filter((s) => s.reviewerOf === undefined).length;
  const shownReviewerCount = filtered.length - shownWorkerCount;
  const activeHerdWorkerCount =
    isOrchestrator && mySessionId
      ? sessions.filter((s) => !s.archived && s.herdedBy === mySessionId && s.reviewerOf === undefined).length
      : null;

  // Group sessions by project (repo root or cwd).
  // Reviewers are grouped with their parent worker so they don't create
  // separate single-session groups for each worktree.
  const groups = new Map<string, typeof filtered>();
  const archived: typeof filtered = [];

  // Build sessionNum → projectKey lookup so reviewers can join their parent's group
  const sessionProjectKey = new Map<number, string>();
  for (const s of filtered) {
    if (!s.archived && s.sessionNum !== undefined && s.reviewerOf === undefined) {
      sessionProjectKey.set(s.sessionNum, (s.repoRoot || s.cwd || "").replace(/\/+$/, "") || "/");
    }
  }

  for (const s of filtered) {
    if (s.archived) {
      archived.push(s);
      continue;
    }
    // Reviewers inherit their parent's project group when the parent is visible
    const ownKey = (s.repoRoot || s.cwd || "").replace(/\/+$/, "") || "/";
    const projectKey = s.reviewerOf !== undefined ? (sessionProjectKey.get(s.reviewerOf) ?? ownKey) : ownKey;
    if (!groups.has(projectKey)) groups.set(projectKey, []);
    groups.get(projectKey)!.push(s);
  }

  // Sort groups alphabetically by label, render each
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => {
    const labelA = a.split("/").pop() || a;
    const labelB = b.split("/").pop() || b;
    return labelA.localeCompare(labelB);
  });

  let total = 0;
  for (const [projectKey, projectSessions] of sortedGroups) {
    const label = formatInlineText(projectKey.split("/").pop() || projectKey);
    // Single pass to count top-level (non-reviewer) sessions and running sessions
    let topLevelCount = 0;
    let runningCount = 0;
    for (const s of projectSessions) {
      if (s.reviewerOf === undefined) {
        topLevelCount++;
        if (s.cliConnected && s.state === "running") runningCount++;
      }
    }
    const countLabel = runningCount > 0 ? `  (${runningCount} running)` : "";
    console.log(`▸ ${label}  ${topLevelCount}${countLabel}`);

    // Sort: running first, then by most recent activity
    projectSessions.sort((a, b) => {
      const aRunning = a.cliConnected && a.state === "running" ? 1 : 0;
      const bRunning = b.cliConnected && b.state === "running" ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });

    // Build a map of parentSessionNum -> reviewer sessions for nesting display
    total += printNestedSessions(projectSessions, showTasks);
    console.log("");
  }

  // Archived group
  if (archived.length > 0) {
    console.log(`▸ ARCHIVED  ${archived.length}`);
    total += printNestedSessions(archived, showTasks);
    console.log("");
  }

  console.log(
    `${total} session(s) shown (${shownWorkerCount} worker${shownWorkerCount === 1 ? "" : "s"}, ${shownReviewerCount} reviewer${shownReviewerCount === 1 ? "" : "s"})${filterHint}`,
  );
  if (activeHerdWorkerCount !== null) {
    console.log(
      `Worker slots used: ${activeHerdWorkerCount}/${HERD_WORKER_SLOT_LIMIT}. Reviewers do not use worker slots, and archiving reviewers will not free worker-slot capacity.`,
    );
  }
  console.log(
    `Status: ● running  ○ idle  ✗ disconnected  ⊘ archived  ⚠ needs attention  📋 quest  ↑↓ commits ahead/behind`,
  );
}

export function printSessionLine(
  s: {
    sessionNum?: number;
    name?: string;
    state: string;
    cliConnected?: boolean;
    archived?: boolean;
    isOrchestrator?: boolean;
    isAssistant?: boolean;
    herdedBy?: string;
    reviewerOf?: number;
    model?: string;
    backendType?: string;
    cwd?: string;
    gitBranch?: string;
    gitAhead?: number;
    gitBehind?: number;
    totalLinesAdded?: number;
    totalLinesRemoved?: number;
    attentionReason?: string;
    pendingPermissionSummary?: string | null;
    lastActivityAt?: number;
    lastMessagePreview?: string;
    isWorktree?: boolean;
    claimedQuestId?: string | null;
    claimedQuestStatus?: string | null;
    claimedQuestVerificationInboxUnread?: boolean;
    pendingTimerCount?: number;
  },
  opts?: {
    indent?: boolean;
    attachedReviewer?: {
      sessionNum?: number;
      state: string;
      cliConnected?: boolean;
      archived?: boolean;
    } | null;
  },
): void {
  const prefix = opts?.indent ? "        ↳ " : "  ";
  const num = s.sessionNum !== undefined ? `#${s.sessionNum}` : "  ";
  const name = formatInlineText(s.name || "(unnamed)");
  const role = s.isOrchestrator ? " [leader]" : s.reviewerOf !== undefined ? " [reviewer]" : "";
  const herd = s.herdedBy ? " [herd]" : "";
  // Backend type tag: only show for codex (sdk is implied by session details)
  const backend = s.backendType === "codex" ? " [codex]" : "";
  const status = s.cliConnected ? (s.state === "running" ? "●" : "○") : s.archived ? "⊘" : "✗";
  const attention = s.pendingPermissionSummary
    ? ` ⚠ ${formatInlineText(s.pendingPermissionSummary)}`
    : s.attentionReason
      ? ` ⚠ ${formatInlineText(s.attentionReason)}`
      : "";

  // Quest indicator: "📋 q-42 in_progress"
  const questStatus = s.claimedQuestStatus
    ? `${s.claimedQuestStatus}${s.claimedQuestVerificationInboxUnread !== undefined ? " review" : ""}`
    : "";
  const quest = s.claimedQuestId
    ? ` 📋 ${formatInlineText(s.claimedQuestId)}${questStatus ? ` ${formatInlineText(questStatus)}` : ""}`
    : "";
  const timers = ` ⏰${s.pendingTimerCount ?? 0}`;
  let reviewerSummary = "";
  if (!opts?.indent && s.reviewerOf === undefined && opts?.attachedReviewer) {
    const reviewer = opts.attachedReviewer;
    const reviewerStatus = reviewer.cliConnected
      ? reviewer.state === "running"
        ? "running"
        : "idle"
      : reviewer.archived
        ? "archived"
        : "disconnected";
    const reviewerNum = reviewer.sessionNum !== undefined ? `#${reviewer.sessionNum}` : "#?";
    reviewerSummary = ` 👀 ${reviewerNum} ${reviewerStatus}`;
  }

  const branch = s.gitBranch ? `  ${formatInlineText(s.gitBranch)}` : "";

  // Commits ahead/behind: "3↑5↓" (only show non-zero)
  const ahead = s.gitAhead ? `${s.gitAhead}↑` : "";
  const behind = s.gitBehind ? `${s.gitBehind}↓` : "";
  const gitDelta = ahead || behind ? ` ${ahead}${behind}` : "";

  // Uncommitted diff stats: "+114 -10" (only show non-zero)
  const added = s.totalLinesAdded ? `+${s.totalLinesAdded}` : "";
  const removed = s.totalLinesRemoved ? `-${s.totalLinesRemoved}` : "";
  const diffStats = added || removed ? ` ${[added, removed].filter(Boolean).join(" ")}` : "";

  const wt = s.isWorktree ? " wt" : "";
  // Show cwd as the last directory component (folder name) for brevity
  const cwdLabel = s.cwd ? truncate(s.cwd.replace(/\/$/, "").split("/").pop() || s.cwd, 30) : "";
  const activity = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : "";
  const preview = s.lastMessagePreview ? `  "${truncate(s.lastMessagePreview, 50)}"` : "";

  console.log(
    `${prefix}${num.padEnd(5)} ${status} ${name}${role}${herd}${backend}${quest}${timers}${reviewerSummary}${attention}`,
  );
  // Compact display for indented reviewer sessions: skip the detail line (cwd/branch)
  // since reviewers share the parent's worktree and the extra line is just noise
  if (!opts?.indent) {
    console.log(`${prefix}      ${cwdLabel}${branch}${gitDelta}${diffStats}${wt}  ${activity}${preview}`);
  }
}

/**
 * Print a list of sessions with reviewer sessions indented under their parent.
 * Returns the number of sessions printed.
 */
function printNestedSessions(
  sessions: Parameters<typeof printSessionLine>[0] &
    { sessionNum?: number; reviewerOf?: number; taskHistory?: Array<{ title: string; timestamp: number }> }[],
  showTasks: boolean,
): number {
  const reviewersByParent = new Map<number, typeof sessions>();
  const topLevel = sessions.filter((s) => {
    if (s.reviewerOf !== undefined) {
      const list = reviewersByParent.get(s.reviewerOf) || [];
      list.push(s);
      reviewersByParent.set(s.reviewerOf, list);
      return false;
    }
    return true;
  });

  let count = 0;
  for (const s of topLevel) {
    const reviewers = s.sessionNum !== undefined ? reviewersByParent.get(s.sessionNum) : undefined;
    printSessionLine(s, { attachedReviewer: reviewers?.[0] ?? null });
    if (showTasks) printSessionTasks(s.taskHistory);
    count++;
    if (reviewers) {
      for (const r of reviewers) {
        printSessionLine(r, { indent: true });
        if (showTasks) printSessionTasks(r.taskHistory);
        count++;
      }
      reviewersByParent.delete(s.sessionNum!);
    }
  }
  // Orphaned reviewers (parent filtered out or archived). Shown with ↳ indent
  // for visual consistency -- the [reviewer] tag clarifies they're reviewer sessions
  // even though their parent isn't visible in the current listing.
  for (const [, orphans] of reviewersByParent) {
    for (const r of orphans) {
      printSessionLine(r, { indent: true });
      if (showTasks) printSessionTasks(r.taskHistory);
      count++;
    }
  }
  return count;
}

function printSessionTasks(taskHistory?: Array<{ title: string; timestamp: number }>): void {
  if (!taskHistory || taskHistory.length === 0) return;
  const maxDisplay = 8;
  const entries = taskHistory.slice(-maxDisplay);
  const header =
    taskHistory.length > maxDisplay
      ? `       Tasks (showing ${entries.length} of ${taskHistory.length}):`
      : `       Tasks (${entries.length}):`;
  console.log(header);
  for (const t of entries) {
    const time = formatTimeShort(t.timestamp);
    const title = truncate(formatInlineText(t.title), 60);
    console.log(`         ${time}  ${title}`);
  }
}

// ─── Info handler ────────────────────────────────────────────────────────────

export async function handleInfo(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode info <session> [--json]");

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const data = await fetchSessionInfo(base, sessionRef);

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  printSessionInfo(data);
}

export async function handleLeaderContextResume(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode leader-context-resume <session> [--json]");
  const flags = parseFlags(args.slice(1));
  const result = (await apiGet(
    base,
    `/sessions/${encodeURIComponent(sessionRef)}/leader-context-resume`,
  )) as LeaderContextResumeModel;
  if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderLeaderContextResumeText(result));
}

function printSessionInfo(data: TakodeSessionInfo): void {
  // ── Header ──
  const num = data.sessionNum != null ? `#${data.sessionNum}` : "";
  const name = formatInlineText(data.name || "(unnamed)");
  const statusIcon = data.cliConnected ? (data.state === "running" ? "●" : "○") : data.archived ? "⊘" : "✗";
  const statusLabel = data.cliConnected
    ? data.isGenerating
      ? "running (generating)"
      : data.state
    : data.archived
      ? "archived"
      : "disconnected";
  console.log(`${num} ${name}  ${statusIcon} ${statusLabel}`);
  console.log("─".repeat(60));

  // ── Identity ──
  console.log(`  UUID           ${formatInlineText(data.sessionId)}`);
  if (data.cliSessionId) console.log(`  CLI Session    ${formatInlineText(data.cliSessionId)}`);
  if (data.pid) console.log(`  PID            ${data.pid}`);

  // ── Backend ──
  const backend = data.backendType || "claude";
  const model = data.model || "unknown";
  console.log(`  Backend        ${formatInlineText(backend)}  model: ${formatInlineText(model)}`);
  if (data.claudeCodeVersion) console.log(`  CLI Version    ${formatInlineText(data.claudeCodeVersion)}`);
  if (data.permissionMode) console.log(`  Permissions    ${formatInlineText(data.permissionMode)}`);
  if (typeof data.askPermission === "boolean") {
    console.log(`  Ask Mode       ${data.askPermission ? "ask" : "no-ask"}`);
  }
  if (data.uiMode) console.log(`  UI Mode        ${formatInlineText(data.uiMode)}`);
  if (backend === "codex") {
    if (typeof data.codexInternetAccess === "boolean") {
      console.log(`  Internet       ${data.codexInternetAccess ? "enabled" : "disabled"}`);
    }
    if (data.codexReasoningEffort) console.log(`  Reasoning      ${formatInlineText(data.codexReasoningEffort)}`);
    if (data.codexSandbox) console.log(`  Sandbox        ${formatInlineText(data.codexSandbox)}`);
  }

  // ── Working directory ──
  console.log(`  CWD            ${formatInlineText(data.cwd)}`);
  if (data.repoRoot && data.repoRoot !== data.cwd) {
    console.log(`  Repo Root      ${formatInlineText(data.repoRoot)}`);
  }

  // ── Worktree / Container ──
  console.log(`  Worktree       ${data.isWorktree ? "yes" : "no"}`);
  if (data.isWorktree) {
    if (data.branch) console.log(`  WT Branch      ${formatInlineText(data.branch)}`);
    if (data.actualBranch && data.actualBranch !== data.branch) {
      console.log(`  Actual Branch  ${formatInlineText(data.actualBranch)}`);
    }
  }
  if (data.containerId) {
    console.log(`  Container      ${formatInlineText(data.containerName || data.containerId)}`);
    if (data.containerImage) console.log(`  Image          ${formatInlineText(data.containerImage)}`);
  }

  // ── Git ──
  const gitBranch = data.gitBranch || data.branch;
  if (gitBranch) {
    const ahead = data.gitAhead ? `${data.gitAhead}↑` : "";
    const behind = data.gitBehind ? `${data.gitBehind}↓` : "";
    const delta = [ahead, behind].filter(Boolean).join(" ");
    console.log(`  Git Branch     ${formatInlineText(gitBranch)}${delta ? `  ${delta}` : ""}`);
  }
  if (data.gitHeadSha) console.log(`  HEAD           ${data.gitHeadSha.slice(0, 12)}`);
  if (data.gitDefaultBranch) console.log(`  Default Branch ${formatInlineText(data.gitDefaultBranch)}`);
  if (data.diffBaseBranch) console.log(`  Diff Base      ${formatInlineText(data.diffBaseBranch)}`);

  const added = data.totalLinesAdded || 0;
  const removed = data.totalLinesRemoved || 0;
  if (added || removed) {
    console.log(`  Diff Stats     +${added} -${removed}`);
  }

  // ── Roles ──
  const roles: string[] = [];
  if (data.isOrchestrator) roles.push("orchestrator");
  if (data.isAssistant) roles.push("assistant");
  if (data.herdedBy) roles.push(`herded`);
  if (roles.length > 0) console.log(`  Roles          ${roles.join(", ")}`);
  if (data.herdedBy) console.log(`  Herded By      ${formatInlineText(data.herdedBy)}`);

  // ── Quest ──
  if (data.claimedQuestId) {
    const questStatus = data.claimedQuestStatus
      ? `${data.claimedQuestStatus}${data.claimedQuestVerificationInboxUnread !== undefined ? " review" : ""}`
      : "";
    const questLine = `${formatInlineText(data.claimedQuestId)}${questStatus ? ` (${formatInlineText(questStatus)})` : ""}`;
    console.log(`  Quest          ${questLine}`);
    if (data.claimedQuestTitle) console.log(`                 ${formatInlineText(data.claimedQuestTitle)}`);
  }

  // ── Cron ──
  if (data.cronJobId) {
    console.log(`  Cron Job       ${formatInlineText(data.cronJobName || data.cronJobId)}`);
  }
  console.log(`  Timers         ${data.pendingTimerCount ?? 0} pending`);

  // ── Env ──
  if (data.envSlug) console.log(`  Env Profile    ${formatInlineText(data.envSlug)}`);

  // ── Metrics ──
  const turns = data.numTurns || 0;
  const cost = data.totalCostUsd || 0;
  const context = data.contextUsedPercent || 0;
  if (turns || cost || context) {
    console.log("");
    console.log(`  Turns          ${turns}`);
    if (cost > 0) console.log(`  Cost           $${cost.toFixed(4)}`);
    console.log(`  Context Used   ${context}%${data.isCompacting ? " (compacting)" : ""}`);
  }

  // ── MCP Servers ──
  if (data.mcpServers && data.mcpServers.length > 0) {
    console.log("");
    console.log(
      `  MCP Servers    ${data.mcpServers.map((s) => `${formatInlineText(s.name)} (${formatInlineText(s.status)})`).join(", ")}`,
    );
  }

  // ── Tools ──
  if (data.tools && data.tools.length > 0) {
    console.log(`  Tools          ${data.tools.length} available`);
  }

  // ── Attention ──
  if (data.attentionReason) {
    console.log(`  Attention      ⚠ ${formatInlineText(data.attentionReason)}`);
  }

  // ── Timestamps ──
  console.log("");
  console.log(`  Created        ${formatDate(data.createdAt)} ${formatTime(data.createdAt)}`);
  if (data.lastActivityAt) {
    console.log(`  Last Activity  ${formatRelativeTime(data.lastActivityAt)} (${formatTime(data.lastActivityAt)})`);
  }
  if (data.archived && data.archivedAt) {
    console.log(`  Archived       ${formatDate(data.archivedAt)} ${formatTime(data.archivedAt)}`);
  }

  // ── Keywords ──
  if (data.keywords && data.keywords.length > 0) {
    console.log(`  Keywords       ${data.keywords.map((keyword) => formatInlineText(keyword)).join(", ")}`);
  }
}

// ─── Tasks handler ───────────────────────────────────────────────────────────

export async function handleTasks(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode tasks <session> [--json]");
  const safeSessionRef = formatInlineText(sessionRef);

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;

  const data = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/tasks`)) as {
    sessionId: string;
    sessionNum: number;
    sessionName: string;
    totalMessages: number;
    tasks: Array<{
      taskNum: number;
      title: string;
      startIdx: number;
      endIdx: number;
      startedAt: number;
      source: string;
      questId: string | null;
    }>;
  };

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Session #${data.sessionNum} "${formatInlineText(data.sessionName)}"`);
  console.log(`${data.tasks.length} tasks, ${data.totalMessages} messages`);
  console.log("");

  if (data.tasks.length === 0) {
    console.log("  No tasks recorded yet.");
    return;
  }

  // Table header
  console.log(`  #  Started   Task${" ".repeat(50)}Msg Range`);
  console.log(`  ${"─".repeat(78)}`);

  for (const task of data.tasks) {
    const num = String(task.taskNum).padStart(2);
    const time = formatTimeShort(task.startedAt);
    const title = truncate(task.title, 50).padEnd(54);
    const range = `[${task.startIdx}]-[${task.endIdx}]`;
    const quest = task.questId ? ` (${formatInlineText(task.questId)})` : "";
    console.log(`  ${num}  ${time}   ${title}${range}${quest}`);
  }

  console.log("");
  console.log(`Browse: takode peek ${safeSessionRef} --from <msg-id> | Task: takode peek ${safeSessionRef} --task <n>`);
}

// ─── Timers handler ──────────────────────────────────────────────────────────

export async function handleTimers(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode timers <session> [--json]");

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;
  const result = (await apiGet(base, `/sessions/${encodeURIComponent(sessionRef)}/timers`)) as {
    timers: SessionTimerDetail[];
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.timers.length === 0) {
    console.log(`No pending timers for ${formatInlineText(sessionRef)}.`);
    return;
  }

  console.log(`Pending timers for ${formatInlineText(sessionRef)} (${result.timers.length}):\n`);
  printTimerRows(result.timers);
}

// ─── Peek types ──────────────────────────────────────────────────────────────
