# CLAUDE.md

This file provides guidance to Claude Code & Codex when working with code in this repository.

## What This Is

Takode — a web orchestration UI for Claude Code & Codex.
It began as a Companion fork and now provides a multi-session workspace with cross-session coordination, Questmaster workflows, tool-call visibility, and permission control.

## Project Progress

Use Questmaster to track project progress for this repository. Treat project tasks/todos as quests and keep status current via the `quest` CLI and Questmaster workflow.

## Skills (Auto-Installed)

The Takode server symlinks project skills into global skill directories at startup (see `web/server/skill-symlink.ts` and `web/server/index.ts`). Each skill is symlinked into three locations: `~/.claude/skills/` (Claude Code), `~/.codex/skills/` (legacy Codex), and `~/.agents/skills/` (new agents format). The canonical source is `.claude/skills/` in the project repo -- edit skills there, not in the global directories. If a backend-specific override exists (e.g. `.codex/skills/<slug>/`), that version is used for that backend instead.

| Skill | Source | Purpose |
|-------|--------|---------|
| `takode-orchestration` | `.claude/skills/takode-orchestration/` | Cross-session orchestration: CLI reference, quest journey, board, herd events |
| `leader-dispatch` | `.claude/skills/leader-dispatch/` | Leader dispatch workflow: worker selection, templates, discipline rules |
| `self-groom` | `.claude/skills/self-groom/` | Multi-perspective self-review via parallel subagents |
| `reviewer-groom` | `.claude/skills/reviewer-groom/` | Reviewer-owned quality review for another agent's change |
| `skeptic-review` | `.claude/skills/skeptic-review/` | Adversarial work integrity review of worker output |
| `worktree-rules` (`/port-changes`) | `.claude/skills/worktree-rules/` | Worktree-to-main-repo porting workflow; `worktree-rules` is the underlying skill slug and `/port-changes` is the user-facing command/alias |
| `playwright-e2e-tester` | `.claude/skills/playwright-e2e-tester/` | E2E browser testing via Playwright MCP |

Additionally, `quest-integration.ts` generates and installs the `quest` skill docs (from `web/server/templates/quest-skill-docs.md`) into both Claude and Codex skill directories at startup.

## Development Commands

```bash
# Dev server (Hono backend on :3456 + Vite HMR on :5174)
cd web && bun install && bun run dev

# Or from repo root
make dev

# Type checking
cd web && bun run typecheck

# Production build + serve
cd web && bun run build && bun run start

# Landing page (takode.sh) — idempotent: starts if down, no-op if up
# IMPORTANT: Always use this script to run the landing page. Never cd into landing/ and run bun/vite manually.
./scripts/landing-start.sh          # start
./scripts/landing-start.sh --stop   # stop
```

## Codex Shell PATH Note

- In Codex tool calls, prefer a non-login shell (`login: false`) for command execution. In this environment, login shells can drop `~/.bun/bin` and `~/.nvm/.../bin` from `PATH`.
- Before running tests/builds, verify runtime availability with `command -v bun && bun --version` (and optionally `command -v node && node -v`).
- If PATH is still wrong, use absolute binaries as a fallback:
  - `/home/jiayiwei/.bun/bin/bun`
  - `/home/jiayiwei/.nvm/versions/node/v22.21.1/bin/node`

## Testing

```bash
# Run tests
cd web && bun run test

# Watch mode
cd web && bun run test:watch

# Current lint/format-equivalent gate
cd web && bun run format:check
```

- All new backend (`web/server/`) and frontend (`web/src/`) code **must** include tests when possible.
- Tests use Vitest. Server tests live alongside source files (e.g. `routes.test.ts` next to `routes.ts`).
- A husky pre-commit hook runs typecheck and tests automatically before each commit.
- For refactor quests, the current full pre-commit-equivalent automated gate before merge or final acceptance is:
  - `cd web && bun run typecheck`
  - `cd web && bun run test`
  - `cd web && bun run format:check`
- `format:check` is the current lint/format-equivalent gate in this repo; there is no separate `lint` script right now.
- If a full run is infeasible, document the exception explicitly in your quest summary, review handoff, or other acceptance notes before asking for merge or final acceptance.
- **Never remove or delete existing tests.** If a test is failing, fix the code or the test. If you believe a test should be removed, you must first explain to the user why and get explicit approval before removing it.
- When creating test, make sure to document what the test is validating, and any important context or edge cases in comments within the test code.

## File Size Guardrail

- Files must stay at or under 2000 lines.
- If a change would push a file over 2000 lines, split the file before committing instead of extending it further.
- The pre-commit limit is enforced against staged file contents only, so exactly 2000 lines is allowed and anything over 2000 lines fails the commit.

## Verification

- After implementing changes, verify them end-to-end when possible. For CLI tools, run the command in your worktree. For scripts, execute them. For logic changes, write a test that exercises the actual code path.
- When end-to-end verification requires a shared resource (running dev server, UI), document what should be manually verified post-deploy in the quest's verification items.

## Component Playground

All UI components used in the message/chat flow **must** be represented in the Playground page (`web/src/components/Playground.tsx`, accessible at `#/playground`). When adding or modifying a message-related component (e.g. `MessageBubble`, `ToolBlock`, `PermissionBanner`, `Composer`, streaming indicators, tool groups, subagent groups), update the Playground to include a mock of the new or changed state.

## Architecture

### Data Flow

```
Browser (React) ←→ WebSocket ←→ Hono Server (Bun) ←→ WebSocket (NDJSON) ←→ Claude Code CLI
     :5174              /ws/browser/:id        :3456        /ws/cli/:id         (--sdk-url)
```

1. Browser sends a "create session" REST call to the server
2. Server spawns `claude --sdk-url ws://localhost:3456/ws/cli/SESSION_ID` as a subprocess
3. CLI connects back to the server over WebSocket using NDJSON protocol
4. Server bridges messages between CLI WebSocket and browser WebSocket
5. Tool calls arrive as `control_request` (subtype `can_use_tool`) — browser renders approval UI, server relays `control_response` back

### All code lives under `web/`

- **`web/server/`** — Hono + Bun backend (runs on port 3456)
  - `index.ts` — Server bootstrap, Bun.serve with dual WebSocket upgrade (CLI vs browser)
  - `ws-bridge.ts` — Core message router. Maintains per-session state (backend socket, browser sockets, message history, pending permissions) and broadcasts canonical session updates.
  - `bridge/` — Extracted bridge subsystems (permission pipeline, generation lifecycle, quest detection) shared by `ws-bridge.ts`.
  - `cli-launcher.ts` — Spawns/kills/relaunches Claude Code CLI processes. Handles `--resume` for session recovery. Persists session state across server restarts.
  - `claude-sdk-adapter.ts` / `codex-adapter.ts` — Backend protocol adapters (Claude NDJSON and Codex JSON-RPC) normalized into the bridge's common event format.
  - `session-store.ts` — JSON file persistence to `~/.companion/sessions/` (port-scoped subdirectories when needed). Debounced writes.
  - `session-types.ts` — All TypeScript types for CLI messages (NDJSON), browser messages, session state, permissions.
  - `routes.ts` — Thin API entrypoint that mounts domain route modules from `routes/`.
  - `routes/` — Domain-specific REST modules (`sessions`, `quests`, `settings`, `filesystem`, `git`, `takode`, `recordings`, `system`, `transcription`, plus shared auth/helpers).
  - `quest-store.ts` / `quest-integration.ts` / `quest-cli.ts` — Quest persistence and lifecycle integration with session activity.
  - `takode-integration.ts` / `takode-messages.ts` — Takode orchestration integration and event/message handling.
  - `container-manager.ts` — Optional containerized session runtime setup and lifecycle.
  - `idle-manager.ts` — Idle-time monitoring and automatic session cleanup behavior.
  - `perf-tracer.ts` — Lightweight server-side performance tracing utilities.
  - `transcription.ts` / `transcription-enhancer.ts` — Speech-to-text endpoint and transcript post-processing pipeline.
  - `env-manager.ts` — CRUD for environment profiles stored in `~/.companion/envs/`.

- **`web/src/`** — React 19 frontend
  - `store.ts` — Zustand store. All state keyed by session ID (messages, streaming text, permissions, tasks, connection status).
  - `ws-transport.ts` / `ws-handlers.ts` / `ws.ts` — Browser WebSocket transport + message handlers, with `ws.ts` as compatibility facade.
  - `types.ts` — Re-exports server types + client-only types (`ChatMessage`, `TaskItem`, `SdkSessionInfo`).
  - `api.ts` — REST client for session management.
  - `App.tsx` — Root layout with sidebar, chat view, task panel. Hash routing (`#/playground`).
  - `components/` — UI: `ChatView`, `MessageFeed`, `MessageBubble`, `ToolBlock`, `Composer`, `Sidebar`, `TopBar`, `TaskPanel`, `PermissionBanner`, `EnvManager`, `SessionCreationView`, `QuestmasterPage`, `CronManager`, `Playground`.

- **`web/bin/cli.ts`** — Main CLI entry point (currently invoked as `bunx the-companion`). Sets `__COMPANION_PACKAGE_ROOT` and imports the server.

### WebSocket Protocol

Claude Code uses NDJSON (newline-delimited JSON), while Codex uses JSON-RPC through `codex-adapter.ts`; both are normalized by the bridge. Common message categories include `system` (init/status), `assistant`, `result`, `stream_event`, `control_request`/`control_response`, tool progress/summary updates, and `keep_alive`.

Full protocol documentation is in `WEBSOCKET_PROTOCOL_REVERSED.md`.

### Session Lifecycle

Sessions persist to disk (`~/.companion/sessions/`) and survive server restarts. On restart, live CLI processes are detected by PID and given a grace period to reconnect their WebSocket. If they don't, they're killed and relaunched with `--resume` using the CLI's internal session ID.

### Raw Protocol Recordings

The server automatically records **all raw protocol messages** (both Claude Code NDJSON and Codex JSON-RPC) to JSONL files. This is useful for debugging, understanding the protocol, and building replay-based tests.

- **Location**: `$TMPDIR/companion-recordings/` by default (fast local tmpfs). Override with `COMPANION_RECORDINGS_DIR` for persistent storage (e.g. `~/.companion/recordings/`).
- **Format**: JSONL — one JSON object per line. First line is a header with session metadata, subsequent lines are raw message entries.
- **File naming**: `{sessionId}_{backendType}_{ISO-timestamp}_{randomSuffix}.jsonl`
- **Disable**: set `COMPANION_RECORD=0` or `COMPANION_RECORD=false`
- **Rotation**: automatic cleanup when total lines exceed 500k (configurable via `COMPANION_RECORDINGS_MAX_LINES`)

Each entry captures:
```json
{"ts": 1771153996875, "dir": "in", "raw": "{\"type\":\"system\",...}", "ch": "cli"}
```
- `dir`: `"in"` (received by server) or `"out"` (sent by server)
- `ch`: `"cli"` (Claude Code / Codex process) or `"browser"` (frontend WebSocket)
- `raw`: the exact original string — never re-serialized, preserving the true protocol payload

**REST API**:
- `GET /api/recordings` — list all recording files with metadata
- `GET /api/sessions/:id/recording/status` — check if a session is recording + file path
- `POST /api/sessions/:id/recording/start` / `stop` — enable/disable per session

**Code**: `web/server/recorder.ts` (recorder + manager), `web/server/replay.ts` (load & filter utilities).

## Fork Policy: Takode + Worktrees

Takode was originally forked from [The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion), but it has since heavily diverged in architecture and features.

Git worktrees are the preferred isolation model for this project. Container support remains available for compatibility, but new workflow guidance should continue to prioritize worktree-based development.

## Key Architectural Principles
(please keep these updated as you work on the codebase)

- **Server is the single source of truth for all session state.** The browser must never optimistically mutate session state (messages, permission mode, model, metrics, session name, etc.) locally. Instead, the browser sends requests to the server, and the server broadcasts authoritative state updates back to ALL connected browsers. This ensures multi-browser consistency: desktop, mobile, or any number of tabs always show the same state. The only exception is purely local UI state (scroll position, sidebar open/closed, composer draft, dark mode, etc.) which is never shared across browsers.
- **Server history is authoritative.** The browser `message_history` handler must always replace local state with what the server sends — never merge/dedup. Merging causes cross-session message contamination because stale messages from a previous session are never removed. The server's `session.messageHistory` is the single source of truth.
- **Resume replay must be idempotent for history-backed messages.** CLI `--resume` and reconnect replay can resend historical `assistant`, `result`, `compact_marker`, and `tool_result_preview` payloads. Any server path that appends to `session.messageHistory` for replayable messages must deduplicate against existing history first; otherwise replay artifacts become permanently persisted hot-tail growth and later inflate `history_sync`/session-store costs.
- **`messageHistory` is browser-only.** The server's `session.messageHistory` array is only used for replaying history to browsers on (re)connect. It is never sent to the CLI. Compaction only affects the CLI's internal context — changes to `messageHistory` (like appending compact markers) don't interfere with Claude Code's session.
- **CLI protocol types can diverge from TypeScript definitions.** The CLI sometimes sends fields in unexpected formats (e.g. compaction summary as a plain `string` instead of `ContentBlock[]`). Always handle both forms defensively and update the types in `session-types.ts` to match observed behavior. Protocol recordings in `~/.companion/recordings/` are the ground truth.
- **Use `process.execPath` in tests**, not `"bun"`. Bun may not be on the default PATH (e.g. installed in `~/.bun/bin`). `process.execPath` resolves to whatever runtime is executing the tests.
- **Browser localStorage is scoped per server instance.** Each server has a stable UUID (`serverId`) in `~/.companion/settings.json`, exposed via `GET /api/settings`. The frontend caches this in `localStorage["cc-server-id"]` and uses `web/src/utils/scoped-storage.ts` to prefix all server-specific keys (sessions, selected backend, recent dirs, etc.) with `{serverId}:`. Global user preferences (dark mode, zoom, notifications, telemetry) are never prefixed. When adding new localStorage keys, use `scopedGetItem`/`scopedSetItem`/`scopedRemoveItem` for server-specific state, or raw `localStorage` for global preferences. Add new global keys to the `GLOBAL_KEYS` set in `scoped-storage.ts`.
- **Minimize localStorage for session-derived state.** localStorage should only store purely local UI preferences (dark mode, zoom, sidebar state, composer drafts) and session creation defaults (selected backend, recent dirs). Any state derived from session activity (attention/unread badges, pending permissions, session names) must be reset from the server on every reconnect — never trust localStorage as the source of truth for these. When `message_history` arrives, it signals a fresh state delivery; clear all browser-side derived state for that session before processing. This prevents stale data from surviving server restarts or multi-browser usage.
- **Never use synchronous file I/O in server code.** The server may run on NFS where a single `writeFileSync` can block 100ms+, stalling all WebSocket messages and HTTP responses (causing "Server unreachable" banners). Rules:
  - **All file reads/writes** must use `node:fs/promises` (`readFile`, `writeFile`, `readdir`, `unlink`, `stat`, `access`) — never `readFileSync`, `writeFileSync`, etc.
  - **All shell commands** in request handlers must use `execAsync`/`execPromise` — never `execSync`. The only exception is server startup (before the event loop serves requests).
  - **Fire-and-forget writes** (session saves, launcher state): call the async function without `await`, add `.catch()` for error logging. Keep the caller's signature `void` for API compatibility.
  - **Chained async writes** for stateful stores: use the `_pendingWrite.then(...)` pattern so writes execute in order and `_flushForTest()` can await all writes. See `settings-manager.ts` and `session-names.ts` as canonical examples.
  - **Buffered async writes** for high-throughput logging: buffer lines in memory, flush every 200ms via async `appendFile`. See `server-logger.ts` and `recorder.ts` as canonical examples.
  - **`mkdirSync` in constructors** is the only acceptable sync fs call — it's a cold path (once at startup) and prevents race conditions with concurrent async mkdirs.
  - **`// sync-ok` escape hatch**: Sync calls on documented cold paths (startup, session creation, CLI-only code) must have a `// sync-ok: <reason>` comment on the same line. The `architecture-guards.test.ts` Vitest test scans all `web/server/` source files and fails on any unannotated sync I/O call.
  - **Git commands** must include `--no-optional-locks` to avoid NFS lock contention on `.git/index.lock`.
  - **Recordings** default to `$TMPDIR/companion-recordings/` (local tmpfs, ~37× faster than NFS). They are ephemeral debugging data — never read by production code.
  - **Session data** stays on the home directory for persistence across reboots — it is critical user data. Optimize with async writes and debouncing, not by moving to tmpfs.
- **CLI connection liveness is maintained through three layers:**
  1. **Heartbeat pings (10s):** The server pings all CLI WebSockets every 10s via `ws.ping()`. Bun doesn't expose pong callbacks, so this is polling-based — if `ping()` throws, the socket is dead. The protocol also includes application-level `keep_alive` messages, but heartbeat ping/pong + send-failure detection remain the primary liveness signals.
  2. **Send failure detection:** When the server tries to send a message to a dead CLI socket, `ws.send()` throws. The catch handler closes the socket, which triggers `handleCLIClose` and the auto-relaunch mechanism. This gives instant detection on the next outbound message.
  3. **Auto-relaunch on disconnect:** When a CLI disconnects (via `handleCLIClose`), the server proactively requests a relaunch after a 2-second delay — no need to wait for a browser to connect and discover the dead session. The delay avoids relaunching during transient network blips. Safety: `relaunchingSet` (5s throttle) prevents concurrent relaunches, `killedByIdleManager` check skips intentional kills, and cli-launcher's fast-exit retry handles crash loops.
  - **Worktree setup must be fully async.** Creating a new worktree session involves file I/O (guardrails injection, git exclude, settings symlinks) and git commands (`update-index --skip-worktree`). On NFS, synchronous versions of these operations can block the event loop for 10+ seconds, killing all CLI WebSocket connections. All worktree setup methods in `cli-launcher.ts` (`injectWorktreeGuardrails`, `addWorktreeGitExclude`, `symlinkProjectSettings`) must use async I/O.

## Browser Exploration

Always use `agent-browser` CLI command to explore the browser. Never use playwright or other browser automation libraries.
When running E2E tests, use the dark theme, as it is the primary theme of this app.
When running E2E tests, use a viewport at least as large as a normal iPhone Pro/Max screen (for example `430x932`).

## Pull Requests

When submitting a pull request:
- use commitzen to format the commit message and the PR title
- Add a screenshot of the changes in the PR description if its a visual change
- Explain simply what the PR does and why it's needed
- Tell me if the code was reviewed by a human or simply generated directly by an AI. 

### How To Open A PR With GitHub CLI

Use this flow from the repository root:

```bash
# 1) Create a branch
git checkout -b fix/short-description (commitzen)

# 2) Commit using commitzen format
git add <files>
git commit -m "fix(scope): short summary" (commitzen)

# 3) Push and set upstream
git push -u origin fix/short-description

# 4) Create PR (title should follow commitzen style)
gh pr create --base main --head fix/short-description --title "fix(scope): short summary"
```

For multi-line PR descriptions, prefer a body file to avoid shell quoting issues:

```bash
cat > /tmp/pr_body.md <<'EOF'
## Summary
- what changed

## Why
- why this is needed

## Testing
- what was run

## Review provenance
- Implemented by AI agent / Human
- Human review: yes/no
EOF

gh pr edit --body-file /tmp/pr_body.md
```

## Codex & Claude Code
- All features must be compatible with both Codex and Claude Code. If a feature is only compatible with one, it must be gated behind a clear UI affordance (e.g. "This feature requires Claude Code") and the incompatible option should be hidden or disabled.
- When implementing a new feature, always consider how it will work with both models and test with both if possible. If a feature is only implemented for one model, document that clearly in the code and in the UI.
