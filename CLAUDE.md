# CLAUDE.md

This file provides guidance to Claude Code & Codex when working with code in this repository.

## What This Is

The Companion — a web UI for Claude Code & Codex. 
It reverse-engineers the undocumented `--sdk-url` WebSocket protocol in the Claude Code CLI to provide a browser-based interface for running multiple Claude Code sessions with streaming, tool call visibility, and permission control.

## Project Progress

Use Questmaster to track project progress for this repository. Treat project tasks/todos as quests and keep status current via the `quest` CLI and Questmaster workflow.

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

# Landing page (thecompanion.sh) — idempotent: starts if down, no-op if up
# IMPORTANT: Always use this script to run the landing page. Never cd into landing/ and run bun/vite manually.
./scripts/landing-start.sh          # start
./scripts/landing-start.sh --stop   # stop
```

## Testing

```bash
# Run tests
cd web && bun run test

# Watch mode
cd web && bun run test:watch
```

- All new backend (`web/server/`) and frontend (`web/src/`) code **must** include tests when possible.
- Tests use Vitest. Server tests live alongside source files (e.g. `routes.test.ts` next to `routes.ts`).
- A husky pre-commit hook runs typecheck and tests automatically before each commit.
- **Never remove or delete existing tests.** If a test is failing, fix the code or the test. If you believe a test should be removed, you must first explain to the user why and get explicit approval before removing it.
- When creating test, make sure to document what the test is validating, and any important context or edge cases in comments within the test code.

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
  - `ws-bridge.ts` — Core message router. Maintains per-session state (CLI socket, browser sockets, message history, pending permissions). Parses NDJSON from CLI, translates to typed JSON for browsers.
  - `cli-launcher.ts` — Spawns/kills/relaunches Claude Code CLI processes. Handles `--resume` for session recovery. Persists session state across server restarts.
  - `session-store.ts` — JSON file persistence to `$TMPDIR/vibe-sessions/`. Debounced writes.
  - `session-types.ts` — All TypeScript types for CLI messages (NDJSON), browser messages, session state, permissions.
  - `routes.ts` — REST API: session CRUD, filesystem browsing, environment management.
  - `env-manager.ts` — CRUD for environment profiles stored in `~/.companion/envs/`.

- **`web/src/`** — React 19 frontend
  - `store.ts` — Zustand store. All state keyed by session ID (messages, streaming text, permissions, tasks, connection status).
  - `ws.ts` — Browser WebSocket client. Connects per-session, handles all incoming message types, auto-reconnects. Extracts task items from `TaskCreate`/`TaskUpdate`/`TodoWrite` tool calls.
  - `types.ts` — Re-exports server types + client-only types (`ChatMessage`, `TaskItem`, `SdkSessionInfo`).
  - `api.ts` — REST client for session management.
  - `App.tsx` — Root layout with sidebar, chat view, task panel. Hash routing (`#/playground`).
  - `components/` — UI: `ChatView`, `MessageFeed`, `MessageBubble`, `ToolBlock`, `Composer`, `Sidebar`, `TopBar`, `HomePage`, `TaskPanel`, `PermissionBanner`, `EnvManager`, `Playground`.

- **`web/bin/cli.ts`** — CLI entry point (`bunx the-companion`). Sets `__COMPANION_PACKAGE_ROOT` and imports the server.

### WebSocket Protocol

The CLI uses NDJSON (newline-delimited JSON). Key message types from CLI: `system` (init/status), `assistant`, `result`, `stream_event`, `control_request`, `tool_progress`, `tool_use_summary`, `keep_alive`. Messages to CLI: `user`, `control_response`, `control_request` (for interrupt/set_model/set_permission_mode).

Full protocol documentation is in `WEBSOCKET_PROTOCOL_REVERSED.md`.

### Session Lifecycle

Sessions persist to disk (`$TMPDIR/vibe-sessions/`) and survive server restarts. On restart, live CLI processes are detected by PID and given a grace period to reconnect their WebSocket. If they don't, they're killed and relaunched with `--resume` using the CLI's internal session ID.

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

## Fork Policy: Git Worktree as Primary Workflow

This is a fork of [The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion). Upstream has switched to Docker container-based session isolation. This fork keeps the container code working but intentionally maintains **git worktree as the primary workflow**. Containers add too much friction for certain applications that need direct access to host resources (files, network services, GPU, etc.).

When syncing with upstream: fast-forward `main` to `upstream/main`, then rebase the `jiayi` branch on top. Do not remove upstream container code — just don't extend it.

### Branch naming convention for "main repo" requests

- In this fork, when the user says **"sync to main repo"**, it means **sync to `origin/jiayi`** (the primary working branch), **not** `origin/main`.
- Only sync to `origin/main` when the user explicitly says `main branch` or `origin/main`.
- User testing usually happens by restarting the server from `/home/jiayiwei/companion` on branch `jiayi`. After implementing a fix in a worktree branch, land it in the main repo (`jiayi`) before asking the user to restart and verify.

## Key Architectural Principles
(please keep these updated as you work on the codebase)

- **Server is the single source of truth for all session state.** The browser must never optimistically mutate session state (messages, permission mode, model, metrics, session name, etc.) locally. Instead, the browser sends requests to the server, and the server broadcasts authoritative state updates back to ALL connected browsers. This ensures multi-browser consistency: desktop, mobile, or any number of tabs always show the same state. The only exception is purely local UI state (scroll position, sidebar open/closed, composer draft, dark mode, etc.) which is never shared across browsers.
- **Server history is authoritative.** The browser `message_history` handler must always replace local state with what the server sends — never merge/dedup. Merging causes cross-session message contamination because stale messages from a previous session are never removed. The server's `session.messageHistory` is the single source of truth.
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

## Browser Exploration

Always use `agent-browser` CLI command to explore the browser. Never use playwright or other browser automation libraries.

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
