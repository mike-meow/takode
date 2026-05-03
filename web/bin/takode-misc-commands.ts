import {
  apiDelete,
  apiGet,
  apiPost,
  err,
  formatInlineText,
  formatTimestampCompact,
  getCallerSessionId,
  parseFlags,
  printTimerRows,
  TIMER_CREATE_GUIDANCE,
  type SessionTimerDetail,
} from "./takode-core.js";

export async function handleRefreshBranch(base: string, args: string[]): Promise<void> {
  const sessionRef = args[0];
  if (!sessionRef) err("Usage: takode refresh-branch <session> [--json]");

  const flags = parseFlags(args.slice(1));
  const jsonMode = flags.json === true;

  const result = (await apiPost(base, `/sessions/${encodeURIComponent(sessionRef)}/refresh-branch`)) as {
    ok: boolean;
    gitBranch: string | null;
    gitDefaultBranch: string | null;
    diffBaseBranch: string | null;
    gitAhead: number;
    gitBehind: number;
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Branch: ${result.gitBranch || "(unknown)"}`);
  if (result.gitDefaultBranch) console.log(`Default: ${result.gitDefaultBranch}`);
  if (result.diffBaseBranch) console.log(`Diff Base: ${result.diffBaseBranch}`);
  const ahead = result.gitAhead ? `${result.gitAhead}↑` : "";
  const behind = result.gitBehind ? `${result.gitBehind}↓` : "";
  const delta = [ahead, behind].filter(Boolean).join(" ");
  if (delta) console.log(`Status: ${delta}`);
}

export async function handleBranch(base: string, args: string[]): Promise<void> {
  const subcommand = args[0] || "status";
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "status": {
      const flags = parseFlags(subArgs);
      const jsonMode = flags.json === true;

      const result = (await apiGet(base, `/sessions/self/branch/status`)) as {
        ok: boolean;
        gitBranch: string | null;
        diffBaseBranch: string | null;
        gitDefaultBranch: string | null;
        gitHeadSha: string | null;
        gitAhead: number;
        gitBehind: number;
        totalLinesAdded: number;
        totalLinesRemoved: number;
        isWorktree: boolean;
      };

      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Branch Info:`);
      console.log(`  Current branch: ${result.gitBranch || "(unknown)"}`);
      console.log(`  Base branch:    ${result.diffBaseBranch || "(default)"}`);
      if (result.gitDefaultBranch) console.log(`  Default branch: ${result.gitDefaultBranch}`);
      if (result.gitHeadSha) console.log(`  HEAD SHA:       ${result.gitHeadSha.slice(0, 8)}`);
      const ahead = result.gitAhead || 0;
      const behind = result.gitBehind || 0;
      console.log(`  Ahead:          ${ahead}`);
      console.log(`  Behind:         ${behind}`);
      if (result.totalLinesAdded || result.totalLinesRemoved) {
        console.log(`  Lines added:    +${result.totalLinesAdded || 0}`);
        console.log(`  Lines removed:  -${result.totalLinesRemoved || 0}`);
      }
      if (result.isWorktree) console.log(`  Worktree:       yes`);
      break;
    }
    case "set-base": {
      const branch = subArgs[0];
      if (!branch) err("Usage: takode branch set-base <branch> [--json]");
      const flags = parseFlags(subArgs.slice(1));
      const jsonMode = flags.json === true;

      const result = (await apiPost(base, `/sessions/self/branch/set-base`, { branch })) as {
        ok: boolean;
        diffBaseBranch: string | null;
        gitBranch: string | null;
        gitAhead: number;
        gitBehind: number;
      };

      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Base branch set to: ${result.diffBaseBranch || "(default)"}`);
      const ahead = result.gitAhead ? `${result.gitAhead}↑` : "";
      const behind = result.gitBehind ? `${result.gitBehind}↓` : "";
      const delta = [ahead, behind].filter(Boolean).join(" ");
      if (delta) console.log(`Status: ${delta}`);
      break;
    }
    default:
      err(`Unknown branch subcommand: ${subcommand}. Use 'status' or 'set-base'.`);
  }
}

// ─── Scan handler ────────────────────────────────────────────────────────────

export async function handleTimer(base: string, args: string[]): Promise<void> {
  const sub = args[0];
  const sessionId = getCallerSessionId();

  switch (sub) {
    case "create": {
      // Parse: takode timer create "Check build health" --desc "Inspect the latest failing shard." --in 30m
      //        takode timer create "Deploy reminder" --at 3pm
      //        takode timer create "Refresh context" --every 10m
      const title = args[1];
      if (!title) {
        err("Usage: takode timer create <title> [--desc <description>] --in|--at|--every <spec>");
      }

      const body: Record<string, string> = { title };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--in" && args[i + 1]) {
          body.in = args[++i];
        } else if (args[i] === "--at" && args[i + 1]) {
          body.at = args[++i];
        } else if (args[i] === "--every" && args[i + 1]) {
          body.every = args[++i];
        } else if ((args[i] === "--desc" || args[i] === "--description") && args[i + 1]) {
          body.description = args[++i];
        }
      }

      if (!body.in && !body.at && !body.every) {
        err(
          "Usage: takode timer create <title> [--desc <description>] --in|--at|--every <spec>\n" +
            "  e.g. --in 30m, --at 3pm, --every 10m\n" +
            `  ${TIMER_CREATE_GUIDANCE}`,
        );
      }

      const result = (await apiPost(base, `/sessions/${sessionId}/timers`, body)) as {
        timer: {
          id: string;
          type: string;
          nextFireAt: number;
          originalSpec: string;
          title: string;
          description: string;
        };
      };
      const t = result.timer;
      const fireAt = new Date(t.nextFireAt).toLocaleTimeString();
      console.log(`Created timer ${t.id} (${t.type}): "${formatInlineText(t.title)}" -- next fire at ${fireAt}`);
      if (t.description) console.log(`Description: ${formatInlineText(t.description)}`);
      break;
    }
    case "list": {
      const result = (await apiGet(base, `/sessions/${sessionId}/timers`)) as {
        timers: SessionTimerDetail[];
      };
      if (result.timers.length === 0) {
        console.log("No active timers.");
        break;
      }
      console.log(`Active timers (${result.timers.length}):\n`);
      printTimerRows(result.timers);
      break;
    }
    case "cancel": {
      const timerId = args[1];
      if (!timerId) err("Usage: takode timer cancel <timer-id>");

      await apiDelete(base, `/sessions/${sessionId}/timers/${timerId}`);
      console.log(`Cancelled timer ${timerId}`);
      break;
    }
    default:
      err(
        "Usage: takode timer <subcommand>\n\n" +
          "Subcommands:\n" +
          "  create <title> [--desc <description>] --in|--at|--every <spec>   Create a timer\n" +
          "  list                                       List active timers\n" +
          "  cancel <timer-id>                          Cancel a timer\n\n" +
          `${TIMER_CREATE_GUIDANCE}\n\n` +
          "Examples:\n" +
          '  takode timer create "Check build health" --desc "Inspect the latest failing shard if red." --in 30m\n' +
          '  takode timer create "Deploy reminder" --at 3pm\n' +
          '  takode timer create "Refresh context" --desc "Summarize new blockers since the last run." --every 10m\n' +
          "  takode timer list\n" +
          "  takode timer cancel t1",
      );
  }
}
