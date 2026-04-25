---
name: takode-orchestration
description: "Cross-session orchestration for Takode. Use when you need to interact with other sessions: listing active sessions, peeking at session activity, reading messages, sending instructions to workers, or spawning new sessions. Triggers: 'check on workers', 'send to session', 'orchestrate', 'coordinate agents', 'list sessions', 'peek at session', 'what are my sessions doing', 'check session status'."
---

# Takode -- Cross-Session CLI Reference

The `takode` CLI lets you interact with other sessions managed by the Companion server. Read-only commands work for all sessions. Mutation commands (send, rename, herd, spawn, interrupt) require the orchestrator role (`TAKODE_ROLE=orchestrator` env var).

## Environment

- `TAKODE_API_PORT` -- the Companion server port (used automatically by the CLI)
- `COMPANION_SESSION_ID` -- your own session ID
- The `takode` command is available at `~/.companion/bin/takode` (or on PATH)
- Works with both **Claude Code** and **Codex** sessions

## Sub-Skill Workflows

Read these files or invoke these skills when performing the corresponding operation:

| Workflow | When to use | Source |
|----------|------------|--------|
| **Dispatching work** | Before choosing a worker and sending a quest | Invoke `/leader-dispatch` |
| **Quest Journey** | Advancing a quest through its phase-based lifecycle, including reviewer-owned groom review | [quest-journey.md](quest-journey.md) |
| **Work board** | Managing the quest board | [board-usage.md](board-usage.md) |

## Key Principles

- **Quests are the unit of work.** Create a quest for any non-trivial task before dispatching.
- **Never implement non-trivial changes yourself.** Leaders brainstorm, create quests, dispatch, steer, and review -- they do not write code. Investigation and research are also work to delegate.
- **Never run `quest claim` yourself.** Workers claim quests when dispatched. Leaders coordinate, workers claim.
- **Leaders do not become the quest owner for implementation work.** The worker doing the job claims and completes the quest; the leader only dispatches, reviews, and coordinates later phase boundaries.
- **Use `/quest-design` before quest creation/refinement.** Before creating a quest or refining an `idea` quest into worker-ready scope, invoke `/quest-design` and wait for user confirmation or correction. A user-approved plan that explicitly covers the quest text counts as this confirmation. Routine feedback, claims, completion, verification checks, board updates, and already-approved lifecycle transitions do not need another round.
- **Before dispatching any quest, *ALWAYS* invoke `/leader-dispatch`.** The dispatch message to the worker must use the standardized template. Do not add extra context, file paths, or investigation instructions -- add any extra information into the quest itself before dispatching.
- **Events are push-based.** Herd events arrive as `[Herd]` user messages when idle. No polling.
- **Reference, don't relay.** Point to source messages instead of paraphrasing.
- **Workers have the same tools you do.** Give them the quest ID; they run `quest show` themselves.
- **One task at a time per worker.** Mid-task steering is fine; unrelated new tasks queue.
- **User feedback triggers full rework.** When a user reports issues with a completed quest, record feedback, set the quest back to `refined`, and dispatch for a full quest journey. Never skip review steps for "small" fixes. New human feedback becomes the source of truth for that quest: reset the board to the earliest valid phase for the fresh cycle and do not let stale in-flight review/port completions from the older scope keep advancing it. See [quest-journey.md](quest-journey.md).
- **Don't echo board state as prose.** `takode board` commands display the board in the terminal with a special UI, and the user already sees the live board state in the Takode Chat UI. Never repeat current board rows as markdown tables or summaries -- just run the command and move on unless the user explicitly asks for a text summary.
- **Do not skip Quest Journey phases for git-tracked changes.** The built-in full-code Quest Journey is planning → implementation → skeptic review → reviewer-groom → porting, represented on the board as PLANNING → IMPLEMENTING → SKEPTIC_REVIEWING → GROOM_REVIEWING → PORTING. These tracked-file changes require normal review, porting, and `quest complete ... --commit/--commits` metadata after sync. The only explicit exception is a true zero-code quest with zero git-tracked changes that has passed skeptic review and was explicitly marked with `takode board set <quest-id> --no-code`; only then may leaders use `takode board advance-no-groom <quest-id>` to skip reviewer-groom and porting.
- **Never use `AskUserQuestion` or `EnterPlanMode`.** These block your turn and prevent herd event processing. Ask clarifying questions in plain text output instead. Every time you ask the user a question, also call `takode notify needs-input` so the user never misses the leader's question.
- **Use `takode notify` at these moments:** `needs-input` every time you ask the user a question or need a decision before work can continue, because that keeps the user from missing the leader's question; `review` only for significant non-quest deliverables that are ready for the user's eyes, not for quest completion.
- **Prefer plain-text inspection by default.** When using `takode info`, `takode peek`, `takode scan`, or `quest show` to read for judgment, scanability, or general situational awareness, use the normal plain-text output first. It is usually more token-efficient and easier to reason about than `--json`.
- **Use `--json` only when exact machine fields matter.** Reach for JSON when you need precise structured data such as feedback `addressed` flags, `commitShas`, version-local quest metadata from `quest history`, exact IDs, or machine-oriented filtering/branching.

## Herd Events

Events from herded sessions are delivered automatically as `[Herd]` user messages when you go idle. No polling needed.

### Message Source Tags

- **`[User HH:MM]`** -- human operator
- **`[Herd HH:MM]`** -- automatic event summary from herded sessions
- **`[Agent #N name HH:MM]`** -- forwarded from another agent/session

### Event Types and Reactions

| Event | Meaning | Action |
|-------|---------|--------|
| `turn_end (✓)` | Worker completed successfully | Peek at output, send follow-up or mark done. In `PLANNING`, this may contain a plain-text plan that should be reviewed and answered with normal `takode send` rather than `takode answer` |
| `turn_end (✗)` | Worker hit an error | Diagnose the issue, send recovery instructions |
| `turn_end (⊘)` | User interrupted the worker | Check if it needs redirection |
| `permission_request` | Worker needs approval | For `AskUserQuestion`/`ExitPlanMode`, answer with `takode answer`. **Tool permissions are human-only.** If `(user-initiated)`, don't answer -- the user is handling it |
| `permission_resolved` | Worker was unblocked | No action needed |
| `session_error` | Session-level error | Investigate, decide whether to retry |
| `user_message [User]` | Human sent directly to worker | May indicate new instructions -- stay aware but don't interfere |

## Session Lifecycle

Three distinct operations -- never confuse them:

| Command | What it does | Session after |
|---------|-------------|---------------|
| `takode interrupt <N>` | Halts the worker's current turn (SIGTERM) | Active, idle, ready for new work |
| `takode archive <N>` | Removes session from active herd | Archived, history still readable |
| Disconnect (idle manager) | CLI process killed automatically | Disconnected (`✗`), auto-relaunches on `takode send` |

**Key rule:** When you interrupt a worker, say "interrupted" -- never "archived" or "stopped".

## Maintaining Focus

- **Don't let herd events override your decision to wait for the user.** If you asked the user a question, keep waiting even if herd events arrive. Acknowledge events briefly, but don't proceed until the user responds.
- **When the user is directly steering a herded worker**: stay out of it. Resume normal coordination once the user stops interacting.
- **After context compaction, refresh state.** Run `takode list` to see your herd with each worker's recent task history before making dispatch decisions.

## User Notifications

Tie `takode notify` calls to Quest Journey phase events:
- **`takode notify needs-input "need decision on auth approach for q-42"`**: every time you ask the user a question or need a decision before work can continue. Always pair the question with `takode notify needs-input` so the user never misses the leader's question.
- **Do not call `takode notify review` for quest completion**: when a work board item is completed, Takode already fires the review notification automatically. Sending another one creates duplicate quest-completion notifications.

Do not notify for routine progress or intermediate steps.

## Read-Only Commands

These commands work for any session.

### `takode list [--herd] [--active] [--all] [--json]`

List sessions. Default shows all unarchived sessions. Use `--herd` (or just `takode list` as leader) to see only your herded sessions. Use `--all` to include archived.

```bash
takode list          # leader default: herded sessions only
takode list --herd   # explicit: herded sessions only
takode list --active # all unarchived sessions
takode list --all    # include archived
```

Output shows: `#N` session number, status icon, name, role labels, quest status, branch info, last activity.

When referencing a session in chat, use `[#N](session:N)` (example: `[#5](session:5)`).

### `takode search <query> [--all] [--json]`

Search sessions by name, keyword, task title, branch, message, or path.

```bash
takode search auth
takode search jwt --all
```

### `takode info <session> [--json]`

Show detailed session metadata: identity, backend, working directory, git state, worktree info, quest claim, metrics, and timestamps.

```bash
takode info 1
takode info 1 --json
```

Human-readable output shows a structured overview with sections for identity (UUID, CLI session ID, PID), backend (type, model, version, permissions), working directory, git state (branch, ahead/behind, diff stats), roles, quest claim, metrics (turns, cost, context usage), MCP servers, and timestamps.

Prefer plain-text for normal inspection. Use `--json` only when you need exact structured fields for a programmatic decision.

### `takode tasks <session> [--json]`

Show the task outline (table of contents) for a session's conversation history.

```bash
takode tasks 1
```

**Tip:** Run `takode tasks` first when investigating an unfamiliar session -- it gives you a high-level map of what the agent has been working on.

### `takode scan <session> [--from N] [--until N] [--count N] [--json]`

Scan session turns as collapsed summaries. Like a table of contents for the conversation -- shows each turn's trigger (user/herd message), assistant response, message range, duration, and tool count. Scans backward from the end by default (most recent turns first). Paginated by turn number (default: 50 turns per page).

```bash
takode scan 1                       # last 50 turns (most recent)
takode scan 1 --from 0              # turns 0-49 (from the beginning)
takode scan 1 --until 100           # 50 turns ending before turn 100 (turns 50-99)
takode scan 1 --from 50 --count 20  # turns 50-69
```

Each turn shows the trigger message and the assistant's response. Compaction events appear as markers between turns:
```
Turn 42 · [821]-[827] · 18:17-18:17 (15s) · 2 tools · ✓
  user: "check how #89 is doing"
  ...
  asst: "#89 has been idle since 2:02 PM..."
── Context compacted [828] (auto) ──
Turn 43 · [829]-[835] · 18:18-18:19 (45s) · 3 tools · ✓
  user: "run the tests"
  ...
  asst: "All 142 tests passed."
```

Use this to quickly understand what a session worked on across its entire history without reading every message. Drill into interesting turns with `takode peek <session> --turn <N>`.
Prefer the plain-text scan output for this triage workflow; it is optimized for human reading. Use `--json` only if you truly need to branch on structured turn fields.

### `takode peek <session> [--from N] [--until N] [--count N] [--turn N] [--task N] [--detail --turns N] [--json]`

View session activity with progressive detail.

**Default mode** (smart overview) -- shows collapsed recent turns + expanded last turn:
```bash
takode peek 1
```
Collapsed turns include message ranges like `Turn 5 · [42]-[58] · 14:22-14:25 (3s) · ✓ "Done"`, so you can quickly identify which messages belong to which turn.

**Expand a specific turn** -- shows all messages in turn N (0-indexed):
```bash
takode peek 1 --turn 5
```
Use this when you see an interesting collapsed turn and want its full messages without guessing message IDs.

**Range browsing** (paged history by message index):
```bash
takode peek 1 --from 500
takode peek 1 --from 500 --count 50
takode peek 1 --until 500
```

**Task browsing** -- expand messages for a specific task number:
```bash
takode peek 1 --task 3
```

**Detail mode** -- legacy full-detail view of the last N turns:
```bash
takode peek 1 --detail --turns 3
```

#### Navigation Workflow

```
1. takode info 1                          → Session metadata: backend, git, quest, metrics
2. takode tasks 1                         → Table of contents: tasks with msg ranges
3. takode scan 1                          → Turn-level scan (most recent first)
4. takode scan 1 --from 0                 → Scan from the beginning
5. takode peek 1                          → Overview: collapsed turns + expanded last turn
6. takode peek 1 --turn 5                 → Expand turn 5 (use turn number from scan)
7. takode peek 1 --task 3                 → Browse task 3's messages
8. takode peek 1 --from 800              → Browse messages [800]-[860] in detail
9. takode read 1 815                      → Full content of message 815
10. takode grep 1 "query"                 → Search within session messages (regex)
11. takode grep 1 "error" --type user     → Search only user messages
12. takode export 1 /tmp/s1.txt           → Dump full session for offline analysis
```

Default to the plain-text forms above when you are reading for judgment. Switch to `--json` only when you need exact machine fields.

### `takode read <session> <msg-id> [--offset N] [--limit N] [--json]`

Read full content of a specific message, with line numbers and pagination.

```bash
takode read 1 42
takode read 1 42 --offset 0 --limit 50
```

### `takode grep <session> <pattern> [--type user|assistant|result] [--count N] [--json]`

Search within a session's message history. Uses **JS/ERE regex** (case-insensitive). Falls back to literal substring if the pattern is invalid regex. Use `|` for alternation, not `\|` (that's BRE syntax from grep/sed -- in JS regex it matches a literal pipe). Optional `--type` filter restricts matches to a specific message type.

```bash
takode grep 1 "authentication"
takode grep 1 "q-5[0-9]"                    # regex pattern
takode grep 1 "image|quality"               # alternation (matches either word)
takode grep 1 "error" --type user            # only user messages
takode grep 1 "commit.*synced" --type result  # only result messages
takode grep 1 "reward hacking" --count 20
```

Each match shows `[msg-id] time type turn snippet`. Use `takode read <session> <msg-id>` to see the full message, or `takode peek <session> --turn <N>` for the turn's context.

### `takode export <session> <path>`

Export a session's full conversation history to a text file. The exported file includes turn headers and all message content, suitable for searching with standard tools (grep, etc).

```bash
takode export 1 /tmp/session-1.txt
```

### `takode notify <category> <summary>`

Alert the user when they need to take action. Available to all sessions (not orchestrator-only). The notification anchors to your most recent assistant message. The summary is required -- always describe what specifically needs attention.

Categories: `needs-input`, `review`

```bash
takode notify needs-input "need decision on auth approach for q-42"
takode notify review "landing page copy draft is ready for review"
```

### `takode pending <session>`

Show leader-answerable prompts for a session: `AskUserQuestion`, `ExitPlanMode`, and active `takode notify needs-input` questions.

## Orchestrator Commands

These commands require `TAKODE_ROLE=orchestrator`. Non-orchestrator sessions will get a permission error.

### `takode send <session> <message> [--correction]`

Send a message to a **herded** worker session (injected as a user message). Requires herding first.

**Syntax:** The session ID must always be the **first** argument after `send`. Flags (`--correction`, `--json`) go **after** the message or at the end. Putting flags before the session ID will cause parse errors.

Use `--correction` to send a steering message to a session that is currently running (without it, sends to running sessions are blocked).

```bash
takode herd 2
takode send 2 "Please also add tests for the edge cases"
takode send 2 "Actually, skip the auth tests" --correction
```

**Shell quoting safety.** Do not put complex text payloads directly inside double quotes if they may contain backticks, `$(...)`, quotes, braces, copied CLI output, or other shell-sensitive content. Your shell can execute or corrupt that text locally before the target command receives it. Use Takode's non-inline input paths instead: `takode send --stdin` for sent messages, and `takode spawn --message-file <path>` or `--message-file -` for spawn dispatches.

```bash
takode send 2 --stdin <<'EOF'
Investigate the failing path.
Treat `foo $(bar)` as literal text, not shell.
EOF
takode spawn --message-file - <<'EOF'
Investigate the failing path.
Treat `foo $(bar)` as literal text, not shell.
EOF
```

For quest comments or summaries, prefer the quest CLI's safer rich-text path instead of inline shell quoting:

```bash
cat >/tmp/quest-feedback.txt <<'EOF'
Port summary: commit abc123 ...
Treat `foo $(bar)` as literal text, not shell.
EOF
quest feedback q-123 --text-file /tmp/quest-feedback.txt

printf '%s\n' 'Port summary: commit abc123 ...' 'Treat `foo $(bar)` as literal text, not shell.' | \
  quest feedback q-123 --text-file -
```

### `takode herd <session> [<session> ...]`

Claim worker sessions under your orchestrator. Each session can only have one leader.

```bash
takode herd 2 3 5
```

### `takode spawn [--backend claude|codex] [--count N] [--message "..."] [--message-file <path>|-] [--cwd DIR] [--no-worktree] [--fixed-name "..."] [--reviewer <session>] [--json]`

Create worker sessions and auto-herd them to yourself. **Sessions always use worktrees by default.** Never pass `--no-worktree` unless the user explicitly asks for it or the project's repo instructions require it -- even investigation and debugging tasks should get worktrees since they almost always lead to code changes. Use `--fixed-name` only for reviewer sessions (regular workers get auto-named from their quest). Use `--reviewer <session>` to create a reviewer session linked to a parent worker.

```bash
takode spawn                                                    # worktree session (default)
takode spawn --backend claude --count 3 --cwd ~/repos/app --message "Run tests"
takode spawn --message-file /tmp/dispatch.txt
takode spawn --reviewer 5 --no-worktree --fixed-name "Skeptic review of #5" --message-file /tmp/reviewer-dispatch.txt
```

Use `--message` only for short inline text. For multiline or shell-like dispatch bodies, prefer `--message-file <path>` or `--message-file -`.

### `takode rename <session> <name>`

Rename a session.

```bash
takode rename 5 "Auth refactor worker"
```

### `takode interrupt <session>`

Interrupt a worker's current turn (sends SIGTERM).

**Interrupt ≠ archive.** Interrupting only halts the worker's current turn -- the session stays active, its history and worktree are intact, and you can send it new work immediately. `takode archive` is a completely separate operation that removes the session from your active herd. Never tell the user you "archived" a session when you only interrupted it.

```bash
takode interrupt 2
```

### `takode answer <session> [--message <msg-id> | --target <id>] <response>`

Answer a worker's pending question, `needs-input` clarification prompt, or plan approval request.

```bash
takode answer 2 --message 41 1                          # pick option 1 for msg [41]
takode answer 2 --message 41 "custom answer"           # free text reply to msg [41]
takode answer 2 --message 52 approve                   # approve the plan shown in msg [52]
takode answer 2 --target req_abc reject "add error handling" # target an exact pending id
```

Use this when a worker or reviewer asked a clarification question through `takode notify needs-input` and is waiting on you. If you can resolve the question from existing context, answer it directly. If the question reveals genuine ambiguity you cannot resolve, ask the user in plain text, pair it with `takode notify needs-input`, and do not advance that quest until the ambiguity is resolved.

### `takode board [show|set|advance|rm]`

Quest Journey work board. See [board-usage.md](board-usage.md) for full usage and coordination patterns.

```bash
takode board show
takode board set <quest-id> [--worker N] [--status STATE] [--wait-for q-X,#Y,free-worker]
takode board advance <quest-id>
takode board rm <quest-id> [<quest-id> ...]
```

## Session Identification

Commands accept multiple formats:
- **Integer number**: `1`, `3`, `5` -- the short form from `takode list`
- **UUID prefix**: `abc123` -- first chars of the full UUID
- **Full UUID**: `550e8400-e29b-41d4-a716-446655440000`

Prefer integer numbers -- they're stable within a server session and easy to type.

## Session Naming

Sessions start with random names and auto-rename on first message and turn completion. Quest claiming changes the session name to the quest title and pauses auto-naming while the quest is active. Only use `--fixed-name` for reviewer sessions -- regular workers should rely on auto-naming from their quest.

When referencing sessions, use session numbers (`#107`) which are stable -- names can change.

## Disconnected Sessions

A `✗ disconnected` session just means its CLI process was killed (usually by the idle manager). The session history, worktree, and quest claim are fully intact. **Do not avoid disconnected sessions** -- if one is the right fit for a task, use it. `takode send` auto-relaunches the CLI before delivering the message, so no extra reconnect step is needed.

If a quest is still active on the board and its worker or reviewer is `idle` or `disconnected`, treat that as a potential stall signal rather than an automatic wait state. Check the quest phase and send the next legal instruction if progress has stalled; `takode send` will auto-relaunch disconnected sessions. Idle or disconnected sessions with active timers may still be healthy, so use timer visibility in `takode` outputs as part of that judgment rather than assuming every idle/disconnected row is stalled.

## Archiving Sessions

Maintain at most **5 worker slots** in your herd. Reviewers can be herded for routing, but they do **not** use worker slots. **Never archive proactively.** Only archive when you are at the 5-worker-slot limit AND need to spawn a new worker. Use the worker-slot summary from `takode list` / `takode spawn` directly -- do **not** infer slot usage from the raw session total. Archiving reviewers does **not** free worker-slot capacity. Idle and disconnected worker sessions retain valuable context -- keep them until you actually need the slot. **Archiving a worktree worker deletes its worktree and any uncommitted changes**, so do not archive until anything worth keeping has been ported, committed, or otherwise synced. When you must archive, choose the worker least likely to be reused -- typically the one whose work is most complete, least related to upcoming tasks, or oldest. Archived sessions' conversation history remains readable via `takode peek`, `takode read`, and the Takode UI, but that history does not preserve uncommitted work from a deleted worktree.

## Tips

- **Use `peek` over `read`** to protect your context window -- peek gives truncated summaries. Drill into specific messages with `read` only when the summary isn't enough. Paginate long messages with `--offset`/`--limit`.
- **Use `--json` only for programmatic decisions.** Parse JSON output when you need to branch on exact event data, IDs, or other structured fields.
- **Verify spawn settings.** After `takode spawn`, check the output to confirm worktree and other settings match your intent. Never use `--no-worktree` unless the user explicitly requests it or the project instructions require it.
- **Mixed backends work seamlessly.** The `takode` CLI talks to the Companion server, not to any backend directly. You can orchestrate both Claude Code and Codex sessions from either backend.
- **Coordinate with quests.** Use the `quest` CLI alongside `takode` for task tracking. Always create a quest for non-trivial work before dispatching.
- **Board immediately.** When you intend to manage a quest (dispatch, review, port), put it on the work board right away (`takode board set`), even if it's QUEUED with `--wait-for`. The board is the tracking mechanism -- never rely on memory for follow-up dispatch. Exception: if the user only asked you to create/file the quest without dispatching, just create it and wait for their go-ahead.
- **Reconcile active rows after restarts/context reloads.** After a server restart, context compaction, or any manual state refresh, immediately compare `takode board show` and `takode list`. If an active board row has an `idle` or `disconnected` worker/reviewer, decide whether the quest is genuinely waiting or whether you need to send the next-phase instruction now.
- **Batch related messages.** If you need to send context + instructions to a worker, send it as one message rather than multiple.
- **Don't interrupt idle workers.** `takode interrupt` halts the worker's current turn. Only use it to redirect active work. Workers that finished a quest are already idle -- don't interrupt them unnecessarily.
- **Say "interrupt", not "stop".** When communicating with the user, prefer "interrupt" over "stop" to avoid confusion with archiving. "Interrupted #5" is unambiguous; "stopped #5" could imply the session was shut down.
- **Events are push-based.** Herd events arrive automatically as user messages when you go idle. No polling needed.
- **One task at a time per worker.** Don't send an unrelated new task to a busy worker. Mid-task steering (scope refinement, corrections, urgent interventions) is fine.
- **Don't repeat corrections.** Before sending a correction to a busy worker, check if you already sent one in the current turn. If yes, wait for the turn to end and evaluate whether the worker incorporated it.
- **For urgent mid-turn redirections:** interrupt the worker first (`takode interrupt`), wait for the interruption herd event, check its conversation to understand where it stopped, then send the corrected instructions as a fresh message.
