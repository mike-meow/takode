---
name: takode-orchestration
description: "Cross-session orchestration for Takode. Use when you need to interact with other sessions: listing active sessions, peeking at session activity, reading messages, sending instructions to workers, or spawning new sessions. Triggers: 'check on workers', 'send to session', 'orchestrate', 'coordinate agents', 'list sessions', 'peek at session', 'what are my sessions doing', 'check session status'."
---

# Takode — Cross-Session CLI Reference

The `takode` CLI lets you interact with other sessions managed by the Companion server. Read-only commands work for all sessions. Mutation commands (send, herd, spawn, stop) require the orchestrator role (`TAKODE_ROLE=orchestrator` env var).

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

**Tip:** Run `takode tasks` first when investigating an unfamiliar session — it gives you a high-level map of what the agent has been working on.

### `takode peek <session> [--from N] [--count N] [--detail --turns N] [--task N] [--json]`

View session activity with progressive detail.

**Default mode** (smart overview):
```bash
takode peek 1
```

**Range browsing** (paged history):
```bash
takode peek 1 --from 500
takode peek 1 --from 500 --count 50
```

**Task browsing**:
```bash
takode peek 1 --task 3
```

**Detail mode**:
```bash
takode peek 1 --detail --turns 3
```

#### Navigation workflow

```
1. takode info 1               → Session metadata: backend, git, quest, metrics
2. takode tasks 1              → Table of contents: tasks with msg ranges
3. takode peek 1               → Overview: collapsed turns + expanded last turn
4. takode peek 1 --task 3      → Browse task 3's messages
5. takode peek 1 --from 800    → Browse messages [800]-[830] in detail
6. takode read 1 815           → Full content of message 815
```

### `takode read <session> <msg-id> [--offset N] [--limit N] [--json]`

Read full content of a specific message, with line numbers and pagination.

```bash
takode read 1 42
takode read 1 42 --offset 0 --limit 50
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

### `takode spawn [--backend claude|codex] [--count N] [--message "..."] [--cwd DIR] [--no-worktree] [--json]`

Create worker sessions and auto-herd them to yourself.

```bash
takode spawn
takode spawn --backend claude --count 3 --cwd ~/repos/app --message "Run tests"
takode spawn --no-worktree
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

## Session Identification

Commands accept multiple formats:
- **Integer number**: `1`, `3`, `5` — the short form from `takode list`
- **UUID prefix**: `abc123` — first chars of the full UUID
- **Full UUID**: `550e8400-e29b-41d4-a716-446655440000`

Prefer integer numbers — they're stable within a server session and easy to type.

## Disconnected Sessions

A `✗ disconnected` session just means its CLI process was killed (usually by the idle manager). The session history, worktree, and quest claim are fully intact. **Do not avoid disconnected sessions** -- if one is the right fit for a task, use it. `takode send` auto-relaunches the CLI before delivering the message, so no extra reconnect step is needed.

## Tips

- **Use `peek` over `read`** to protect your context window -- peek gives truncated summaries.
- **Use `--json` for programmatic decisions.** Parse JSON output when you need to branch on event data.
- **Mixed backends work seamlessly.** The `takode` CLI talks to the Companion server, not to any backend directly.
- **Coordinate with quests.** Use the `quest` CLI alongside `takode` for task tracking.

## Archiving Sessions

When your herd exceeds 5 sessions, archive the ones **least likely to be reused**. Archiving doesn't lose anything -- archived sessions' full conversation history remains readable via `takode peek` and `takode read`, and the Takode UI. If you later discover an archived session's context would be valuable, you can have a new worker read that history for context.
