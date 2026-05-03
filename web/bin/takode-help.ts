import {
  LEASE_ACQUIRE_HELP,
  LEASE_HELP,
  LEASE_RELEASE_HELP,
  LEASE_RENEW_HELP,
  LEASE_STATUS_HELP,
  LEASE_WAIT_HELP,
} from "./takode-lease.js";
import { stripHelpFlags, TIMER_CREATE_GUIDANCE } from "./takode-core.js";
import {
  BOARD_ADVANCE_HELP,
  BOARD_DETAIL_HELP,
  BOARD_HELP,
  BOARD_NOTE_HELP,
  BOARD_PRESENT_HELP,
  BOARD_PROMOTE_HELP,
  BOARD_PROPOSE_HELP,
  BOARD_RM_HELP,
  BOARD_SET_HELP,
} from "./takode-board.js";
import { SPAWN_FLAG_USAGE } from "./takode-orchestration-commands.js";

const LIST_HELP = `Usage: takode list [--herd|--active|--all] [--tasks] [--json]

List sessions.

Options:
  --herd    Show only sessions herded by you
  --active  Show all unarchived sessions
  --all     Include archived sessions
  --tasks   Include recent task history in each row
  --json    Output JSON
`;

const SEARCH_HELP = `Usage: takode search <query> [--all] [--json]

Search sessions by name, task, branch, path, repo, keyword, and user-message content.

Options:
  --all   Include archived sessions
  --json  Output JSON
`;

const INFO_HELP = `Usage: takode info <session> [--json]

Show detailed metadata for a session, including backend, git, quest, and timer state.
`;

const LEADER_CONTEXT_RESUME_HELP = `Usage: takode leader-context-resume <session> [--json]

Recover the minimum leader/orchestrator context needed to resume safely after compaction or interruption.
`;

const TASKS_HELP = `Usage: takode tasks <session> [--json]

Show the high-level task outline for a session's conversation history.
`;

const TIMERS_HELP = `Usage: takode timers <session> [--json]

Show pending timers for a session.
`;

const SCAN_HELP = `Usage: takode scan <session> [--from N] [--until N] [--count N] [--json]

Scan session turns as collapsed summaries.

Options:
  --from <turn>   Start at turn N
  --until <turn>  Show turns ending before turn N
  --count <n>     Number of turns to show (default: 50)
  --json          Output JSON
`;

const PEEK_HELP = `Usage: takode peek <session> [--from N] [--until N] [--count N] [--task N] [--turn N] [--show-tools] [--detail] [--turns N] [--json]

View session activity with progressive detail.

Examples:
  takode peek 1
  takode peek 1 --turn 5
  takode peek 1 --from 500 --count 50
  takode peek 1 --detail --turns 3
`;

const READ_HELP = `Usage: takode read <session> <msg-id> [--offset N] [--limit N] [--json]

Read one full message from a session.
`;

const GREP_HELP = `Usage: takode grep <session> <pattern> [--type user|assistant|result] [--count N] [--json]

Search within a session's messages using JavaScript regex matching.
`;

const LOGS_HELP = `Usage: takode logs [--level warn,error] [--component name] [--session <id>] [--pattern text] [--regex] [--since time] [--until time] [--limit N] [--follow] [--json]

Query and tail structured Companion server logs.
`;

const EXPORT_HELP = `Usage: takode export <session> <path>

Export a session's full history to a text file.
`;

const SEND_HELP = `Usage: takode send <session> <message> [--correction] [--json]
       takode send <session> --stdin [--correction] [--json]

Send a message to a herded session.

Options:
  --stdin       Read the message body from stdin
  --correction  Send steering input to a currently running session
  --json        Output JSON
`;

const USER_MESSAGE_HELP = `Usage: takode user-message --text-file <path|-> [--json]

Deprecated compatibility command. New leader thread routing uses mandatory [thread:main] / [thread:q-N] assistant prefixes instead.

Options:
  --text-file <path|->  Read the complete Markdown message from a file, or '-' for stdin
  --json                Output JSON
`;

const THREAD_HELP = `Usage: takode thread attach <quest-id> --message <index> [more-indices...] [--json]
       takode thread attach <quest-id> --range <start-end> [--json]
       takode thread attach <quest-id> --turn <turn> [--json]

Associate existing Main-thread history entries with a quest thread without moving or duplicating them.
Turn numbers match the visible turn numbers from takode scan/peek.
Message indices may be repeated after --message or comma-separated.
`;

const RENAME_HELP = `Usage: takode rename <session> <name> [--json]

Rename a session.
`;

const HERD_HELP = `Usage: takode herd [--force] <session1,session2,...> [--json]

Herd one or more worker sessions into your leader session.
`;

const UNHERD_HELP = `Usage: takode unherd <session> [--json]

Release a worker from your herd.
`;

const INTERRUPT_HELP = `Usage: takode interrupt <session> [--json]

Interrupt a worker's current turn without archiving it.
`;

const ARCHIVE_HELP = `Usage: takode archive <session> [--json]

Archive a herded session.
`;

const PENDING_HELP = `Usage: takode pending <session> [--json]

Show leader-answerable questions for a herded session, including
\`takode notify needs-input\` prompts and plan approvals.
`;

const ANSWER_HELP = `Usage: takode answer <session> [--message <msg-id> | --target <id> | --thread <main|q-N> | --quest <q-N>] <response> [--json]

Answer a pending question, \`needs-input\` prompt, or approve/reject a pending plan.
`;

const SET_BASE_HELP = `Usage: takode set-base <session> <branch> [--json]

Set the diff base branch for a session.
`;

const REFRESH_BRANCH_HELP = `Usage: takode refresh-branch <session> [--json]

Refresh git branch info for a session after checkout, rebase, or other branch changes.
`;

const NOTIFY_HELP = `Usage: takode notify <category> <summary> [--suggest <answer>]... [--json]
       takode notify list [--json]
       takode notify resolve <notification-id> [--json]

Categories:
  needs-input  User decision or information required
  review       Ready for user review

Options:
  --suggest <answer>  Suggested answer for needs-input notifications (repeat up to 3 times)
`;

const WORKER_STREAM_HELP = `Usage: takode worker-stream [--json]

Stream the current worker/reviewer turn activity to the leader as an internal herd checkpoint.
Use after a substantive nontrivial phase outcome is ready, before finishing remaining paperwork.
`;

const PHASES_HELP = `Usage: takode phases [--json]

List available Quest Journey phases from phase metadata, including exact leader/assignee brief paths.
`;

const BRANCH_HELP = `Usage: takode branch <status|set-base> ...

Branch info and management for the current session.

Subcommands:
  status                  Show current branch, diff base, and ahead/behind state
  set-base <branch>       Set the current session's diff base branch
`;

const BRANCH_STATUS_HELP = `Usage: takode branch status [--json]

Show current branch, diff base, and ahead/behind status for the current session.
`;

const BRANCH_SET_BASE_HELP = `Usage: takode branch set-base <branch> [--json]

Set the current session's diff base branch.
`;

const TIMER_HELP = `Usage: takode timer <create|list|cancel> ...

Session-scoped timers for the current session.

Subcommands:
  create <title> [--desc <description>] --in|--at|--every <spec>
  list
  cancel <timer-id>

${TIMER_CREATE_GUIDANCE}
`;

const TIMER_CREATE_HELP = `Usage: takode timer create <title> [--desc <description>] --in|--at|--every <spec>

Create a session-scoped timer.

Examples:
  takode timer create "Check build health" --desc "Inspect the latest failing shard if red." --in 30m
  takode timer create "Deploy reminder" --at 3pm
  takode timer create "Refresh context" --desc "Summarize new blockers since the last run." --every 10m
`;

const TIMER_LIST_HELP = `Usage: takode timer list

List active timers for the current session.
`;

const TIMER_CANCEL_HELP = `Usage: takode timer cancel <timer-id>

Cancel a session-scoped timer.
`;

export function printCommandHelp(command: string, argv: string[]): boolean {
  const args = stripHelpFlags(argv);
  switch (command) {
    case "list":
      console.log(LIST_HELP);
      return true;
    case "search":
      console.log(SEARCH_HELP);
      return true;
    case "info":
      console.log(INFO_HELP);
      return true;
    case "leader-context-resume":
      console.log(LEADER_CONTEXT_RESUME_HELP);
      return true;
    case "spawn":
      console.log(SPAWN_FLAG_USAGE);
      return true;
    case "tasks":
      console.log(TASKS_HELP);
      return true;
    case "timers":
      console.log(TIMERS_HELP);
      return true;
    case "scan":
      console.log(SCAN_HELP);
      return true;
    case "peek":
      console.log(PEEK_HELP);
      return true;
    case "read":
      console.log(READ_HELP);
      return true;
    case "grep":
      console.log(GREP_HELP);
      return true;
    case "logs":
      console.log(LOGS_HELP);
      return true;
    case "export":
      console.log(EXPORT_HELP);
      return true;
    case "send":
      console.log(SEND_HELP);
      return true;
    case "user-message":
      console.log(USER_MESSAGE_HELP);
      return true;
    case "thread":
      console.log(THREAD_HELP);
      return true;
    case "rename":
      console.log(RENAME_HELP);
      return true;
    case "herd":
      console.log(HERD_HELP);
      return true;
    case "unherd":
      console.log(UNHERD_HELP);
      return true;
    case "interrupt":
      console.log(INTERRUPT_HELP);
      return true;
    case "archive":
      console.log(ARCHIVE_HELP);
      return true;
    case "pending":
      console.log(PENDING_HELP);
      return true;
    case "answer":
      console.log(ANSWER_HELP);
      return true;
    case "set-base":
      console.log(SET_BASE_HELP);
      return true;
    case "refresh-branch":
      console.log(REFRESH_BRANCH_HELP);
      return true;
    case "notify":
      console.log(NOTIFY_HELP);
      return true;
    case "worker-stream":
      console.log(WORKER_STREAM_HELP);
      return true;
    case "phases":
      console.log(PHASES_HELP);
      return true;
    case "board": {
      const sub = args[0];
      if (!sub || sub === "show") {
        console.log(BOARD_HELP);
      } else if (sub === "detail") {
        console.log(BOARD_DETAIL_HELP);
      } else if (sub === "set" || sub === "add") {
        console.log(BOARD_SET_HELP);
      } else if (sub === "propose") {
        console.log(BOARD_PROPOSE_HELP);
      } else if (sub === "present") {
        console.log(BOARD_PRESENT_HELP);
      } else if (sub === "promote") {
        console.log(BOARD_PROMOTE_HELP);
      } else if (sub === "note") {
        console.log(BOARD_NOTE_HELP);
      } else if (sub === "advance") {
        console.log(BOARD_ADVANCE_HELP);
      } else if (sub === "advance-no-groom") {
        console.log(
          "`takode board advance-no-groom` was removed. Use an explicit phase plan that omits `port`, then advance with `takode board advance`.",
        );
      } else if (sub === "rm") {
        console.log(BOARD_RM_HELP);
      } else {
        console.log(BOARD_HELP);
      }
      return true;
    }
    case "branch": {
      const sub = args[0];
      if (!sub) {
        console.log(BRANCH_HELP);
      } else if (sub === "status") {
        console.log(BRANCH_STATUS_HELP);
      } else if (sub === "set-base") {
        console.log(BRANCH_SET_BASE_HELP);
      } else {
        console.log(BRANCH_HELP);
      }
      return true;
    }
    case "timer": {
      const sub = args[0];
      if (!sub) {
        console.log(TIMER_HELP);
      } else if (sub === "create") {
        console.log(TIMER_CREATE_HELP);
      } else if (sub === "list") {
        console.log(TIMER_LIST_HELP);
      } else if (sub === "cancel") {
        console.log(TIMER_CANCEL_HELP);
      } else {
        console.log(TIMER_HELP);
      }
      return true;
    }
    case "lease": {
      const sub = args[0];
      if (!sub) {
        console.log(LEASE_HELP);
      } else if (sub === "acquire") {
        console.log(LEASE_ACQUIRE_HELP);
      } else if (sub === "wait") {
        console.log(LEASE_WAIT_HELP);
      } else if (sub === "status" || sub === "list") {
        console.log(LEASE_STATUS_HELP);
      } else if (sub === "renew" || sub === "heartbeat") {
        console.log(LEASE_RENEW_HELP);
      } else if (sub === "release") {
        console.log(LEASE_RELEASE_HELP);
      } else {
        console.log(LEASE_HELP);
      }
      return true;
    }
    default:
      return false;
  }
}

export function printUsage(): void {
  console.log(`
Usage: takode <command> [options]

Commands:
  list     List sessions (--active: all, --herd: herded only, --all: include archived)
  search   Search sessions via server-side ranking (available to all sessions)
  info     Show detailed metadata for a session
  leader-context-resume  Recover compact leader/orchestrator context for a session
  spawn    Create and auto-herd new worker sessions
  tasks    Show a session task outline (available to all sessions)
  timers   Inspect pending timers for a session
  scan     Scan session turns (collapsed summaries, paginated)
  peek     View session activity (available to all sessions)
  read     Read a full message (available to all sessions)
  grep     Search within a session's messages (JS regex, case-insensitive)
  logs     Query and tail structured server logs
  export   Export full session history to a text file
  send     Send a message to a herded session
  thread   Associate Main history entries with quest threads
  user-message  Deprecated compatibility publisher
  rename   Rename a session (e.g. takode rename 5 My Session Name)
  herd     Herd sessions (e.g. takode herd 5,6,7 or takode herd --force 5)
  unherd   Release a session from your herd (e.g. takode unherd 5)
  interrupt  Interrupt a worker's current turn (e.g. takode interrupt 5)
  archive  Archive a herded session (e.g. takode archive 5)
  pending  Show pending questions/plans from a herded session
  answer   Answer a pending question or approve/reject a plan
  set-base       Set the diff base branch for a session
  refresh-branch Refresh git branch info for a session after checkout/rebase
  branch         Branch info and management for the current session
  notify         Alert the user (e.g. takode notify review "ready for verification")
  worker-stream  Stream a worker/reviewer checkpoint to the leader
  phases        List Quest Journey phases and exact phase brief paths
  board          Quest Journey work board (e.g. takode board show, takode board advance q-12)
  timer          Session-scoped timers (create, list, cancel)
  lease          Global resource leases (acquire, status, renew, release, wait)
  help           Show detailed help for a command or nested subcommand

Peek modes:
  takode peek 1                    Smart overview (collapsed turns + expanded last turn)
  takode peek 1 --from 500         Browse messages starting at index 500
  takode peek 1 --until 530 --count 50  Browse backward ending at message 530 (inclusive)
  takode peek 1 --detail --turns 3 Full detail on last 3 turns

Global options:
  --port <n>    Override API port (default: TAKODE_API_PORT or 3456)
  --json        Output in JSON format

Examples:
  takode list
  takode list --herd
  takode list --all
  takode search "auth"
  takode search "jwt" --all
  takode info 1
  takode info 1 --json
  takode leader-context-resume 1
  takode spawn --backend claude-sdk --count 2
  takode spawn --backend codex --count 3 --message "Check flaky tests"
  takode spawn --message-file /tmp/dispatch.txt
  takode tasks 1
  takode timers 1
  takode scan 1
  takode scan 1 --from 50 --count 20
  takode peek 1
  takode peek 1 --from 200
  takode peek 1 --until 530 --count 30
  takode peek 1 --detail --turns 3
  takode read 1 42
  takode grep 1 "authentication"
  takode logs --level warn,error --component ws-bridge
  takode logs --session abc123 --pattern reconnect --follow
  takode export 1 /tmp/session-1.txt
  takode send 2 "Please add tests for the edge cases"
  printf 'Line 1\\nLine 2 with $HOME and \`code\`\\n' | takode send 2 --stdin
  takode set-base 1 origin/main
  takode refresh-branch 1
  takode branch status
  takode branch set-base origin/main
  takode worker-stream
  takode phases
  takode board --help
  takode board advance q-12
  takode thread attach q-12 --message 42
  takode help timer create
  takode lease acquire dev-server:companion --purpose "Run E2E checks" --ttl 30m
`);
}
