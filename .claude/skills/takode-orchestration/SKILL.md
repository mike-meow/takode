---
name: takode-orchestration
description: "Cross-session orchestration for Takode. Use when you need to interact with other sessions: listing active sessions, peeking at session activity, reading messages, sending instructions to workers, or spawning new sessions. Triggers: 'check on workers', 'send to session', 'orchestrate', 'coordinate agents', 'list sessions', 'peek at session', 'what are my sessions doing', 'check session status'."
---

# Takode — Cross-Session CLI Reference

The `takode` CLI lets you interact with other sessions managed by the Companion server. Read-only commands work for all sessions. Mutation commands (send, rename, herd, spawn, stop) require the orchestrator role (`TAKODE_ROLE=orchestrator` env var).

## Environment

- `TAKODE_API_PORT` — the Companion server port (used automatically by the CLI)
- `COMPANION_SESSION_ID` — your own session ID
- The `takode` command is available at `~/.companion/bin/takode` (or on PATH)
- Works with both **Claude Code** and **Codex** sessions

## Read-Only Commands

These commands work for any session.

### `takode list [--active] [--all] [--json]`

List sessions. For leaders, the default view shows only herded sessions (your flock). Use `--active` to see all unarchived sessions, or `--all` to include archived.

```bash
takode list
takode list --active
takode list --all
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

Use `--json` for programmatic access to all fields.

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

Each turn shows the trigger message and the assistant's response:
```
Turn 42 · [821]-[827] · 18:17-18:17 (15s) · 2 tools · ✓
  user: "check how #89 is doing"
  ...
  asst: "#89 has been idle since 2:02 PM..."
```

Use this to quickly understand what a session worked on across its entire history without reading every message. Drill into interesting turns with `takode peek <session> --turn <N>`.

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

#### Navigation workflow

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

### `takode read <session> <msg-id> [--offset N] [--limit N] [--json]`

Read full content of a specific message, with line numbers and pagination.

```bash
takode read 1 42
takode read 1 42 --offset 0 --limit 50
```

### `takode grep <session> <pattern> [--type user|assistant|result] [--count N] [--json]`

Search within a session's message history. Supports regex patterns (case-insensitive). Falls back to literal substring if the pattern is invalid regex. Optional `--type` filter restricts matches to a specific message type.

```bash
takode grep 1 "authentication"
takode grep 1 "q-5[0-9]"                    # regex pattern
takode grep 1 "error" --type user            # only user messages
takode grep 1 "commit.*synced" --type result  # only result messages
takode grep 1 "reward hacking" --count 20
```

Each match shows `[msg-id] time type turnNum snippet`. Use `takode read <session> <msg-id>` to see the full message, or `takode peek <session> --turn <N>` for the turn's context.

### `takode export <session> <path>`

Export a session's full conversation history to a text file. The exported file includes turn headers and all message content, suitable for searching with standard tools (grep, etc).

```bash
takode export 1 /tmp/session-1.txt
```

### `takode notify <category>`

Alert the user when they need to take action. Available to all sessions (not orchestrator-only). The notification anchors to your most recent assistant message.

Categories: `needs-input`, `review`

```bash
takode notify needs-input    # user needs to decide/answer something
takode notify review         # something is ready for the user's eyes
```

### `takode pending <session>`

Show pending permission requests for a session (questions, plans awaiting approval).

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

### `takode herd <session> [<session> ...]`

Claim worker sessions under your orchestrator. Each session can only have one leader.

```bash
takode herd 2 3 5
```

### `takode spawn [--backend claude|codex] [--count N] [--message "..."] [--cwd DIR] [--no-worktree] [--fixed-name "..."] [--json]`

Create worker sessions and auto-herd them to yourself. Use `--fixed-name` to set a stable session name and disable auto-naming.

```bash
takode spawn
takode spawn --backend claude --count 3 --cwd ~/repos/app --message "Run tests"
takode spawn --no-worktree
takode spawn --fixed-name "Skeptic review of #5" --no-worktree --message "Review this PR"
```

### `takode rename <session> <name>`

Rename a session.

```bash
takode rename 5 "Auth refactor worker"
```

### `takode stop <session>`

Gracefully stop a herded worker session (sends SIGTERM).

```bash
takode stop 2
```

### `takode answer <session> <response>`

Answer a worker's pending question or plan approval request.

```bash
takode answer 2 1                          # pick option 1
takode answer 2 "custom answer"            # free text
takode answer 2 approve                    # approve a plan
takode answer 2 reject "add error handling" # reject with feedback
```

### `takode board [show|set|advance|rm]`

Quest Journey work board. Tracks quests through the lifecycle: PLANNED -> DISPATCHED -> PLAN_APPROVED -> SKEPTIC_REVIEWED -> GROOM_SENT -> GROOMED -> PORT_REQUESTED -> (removed). Only available to orchestrator sessions.

```bash
takode board show                                                         # Display board with states and next-action hints
takode board set <quest-id> [--worker N] [--status STATE] [--wait-for q-X,q-Y]  # Add or update a row
takode board advance <quest-id>                                           # Transition to next Quest Journey state
takode board rm <quest-id> [<quest-id> ...]                               # Remove row(s) manually
```

**States** (each = a leader action that just happened):
- `PLANNED` -- leader planned the work. Next: dispatch to a worker
- `DISPATCHED` -- leader dispatched to worker. Next: wait for ExitPlanMode, then review plan
- `PLAN_APPROVED` -- leader approved the plan. Next: wait for turn_end, then spawn skeptic reviewer
- `SKEPTIC_REVIEWED` -- skeptic review passed. Next: tell worker to run /groom
- `GROOM_SENT` -- leader told worker to run /groom. Next: wait for report, then send findings to reviewer
- `GROOMED` -- reviewer confirmed groom compliance. Next: tell worker to port
- `PORT_REQUESTED` -- leader told worker to port. Next: wait for confirmation, then remove

**advance** transitions to the next state automatically. At the final state (PORT_REQUESTED), advance removes the row from the board.

**wait-for** column: list of quest IDs this quest is blocked on. When all entries are resolved (no longer on the board), the actual next action shows instead of "blocked".

Every command outputs the full board after the operation. The board is stored server-side per leader session and persists across server restarts. Rows are also auto-removed when a quest transitions to `needs_verification` or `done`.

## Session Identification

Commands accept multiple formats:
- **Integer number**: `1`, `3`, `5` — the short form from `takode list`
- **UUID prefix**: `abc123` — first chars of the full UUID
- **Full UUID**: `550e8400-e29b-41d4-a716-446655440000`

Prefer integer numbers — they're stable within a server session and easy to type.

## Disconnected Sessions

A `✗ disconnected` session just means its CLI process was killed (usually by the idle manager). The session history, worktree, and quest claim are fully intact. **Do not avoid disconnected sessions** -- if one is the right fit for a task, use it. `takode send` auto-relaunches the CLI before delivering the message, so no extra reconnect step is needed.

## Tips

- **Use `peek` over `read`** to protect your context window -- peek gives truncated summaries. Drill into specific messages with `read` only when the summary isn't enough. Paginate long messages with `--offset`/`--limit`.
- **Use `--json` for programmatic decisions.** Parse JSON output when you need to branch on event data.
- **Verify spawn settings.** After `takode spawn`, check the output to confirm worktree and other settings match your intent. If the spawned worker shouldn't use a worktree (e.g., HQ workers where the repo isn't being edited), use `--no-worktree`. If you see `worktree=yes` unexpectedly, stop and fix before sending tasks.
- **Mixed backends work seamlessly.** The `takode` CLI talks to the Companion server, not to any backend directly. You can orchestrate both Claude Code and Codex sessions from either backend.
- **Coordinate with quests.** Use the `quest` CLI alongside `takode` for task tracking. Always create a quest for non-trivial work before dispatching.
- **Batch related messages.** If you need to send context + instructions to a worker, send it as one message rather than multiple.
- **Don't stop idle workers.** `takode stop` interrupts the worker's current turn. Only use it to redirect active work. Workers that finished a quest are already idle -- don't stop them unnecessarily.
- **Events are push-based.** Herd events arrive automatically as user messages when you go idle. No polling needed.
- **One task at a time per worker.** Don't send an unrelated new task to a busy worker. Mid-task steering (scope refinement, corrections, urgent interventions) is fine.

## Archiving Sessions

Maintain at most **5 sessions in your herd**. Before spawning a new worker, check `takode list`. If you already have 5, archive the one least likely to be reused -- typically the one whose work is most complete, least related to upcoming tasks, or oldest. Archiving doesn't lose anything -- archived sessions' full conversation history remains readable via `takode peek` and `takode read`, and the Takode UI. If you later discover an archived session's context would be valuable, you can have a new worker read that history for context.
