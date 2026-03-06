# `web/bin/`

CLI entry points for Takode tooling.

These executables provide local command interfaces for running the server,
managing sessions/settings, and orchestrating/working quests.

## Files

- [cli.ts](./cli.ts)
  - Main `companion` entrypoint.
  - Handles service lifecycle commands (`start/stop/status/install/...`),
    foreground server boot (`serve`), export/import, and command dispatch.
  - Delegates management subcommands to `ctl.ts`.

- [ctl.ts](./ctl.ts)
  - REST-backed management command handler for `companion sessions/envs/cron/skills/settings/assistant`.
  - Maps subcommands to `/api/*` endpoints and prints JSON output.

- [takode.ts](./takode.ts)
  - `takode` orchestration CLI.
  - Uses authenticated Takode headers to call orchestration APIs.
  - Supports worker/session discovery, herding, peek/read, send, and answer flows.

- [quest.ts](./quest.ts)
  - `quest` CLI (Questmaster operations).
  - Works directly with `quest-store` for data mutations and best-effort server notify for UI refresh.
  - Supports list/claim/transition/feedback/verification inbox workflows.

- [takode.test.ts](./takode.test.ts)
  - CLI behavior/regression tests for Takode command paths.

## How pieces fit together

1. User runs `companion ...` / `takode ...` / `quest ...`.
2. `cli.ts` is the top-level dispatcher for Takode runtime commands.
3. Management/orchestration commands call server APIs on `localhost`.
4. Takode/Quest commands use session auth context from env vars or `~/.companion/session-auth/`.

## Notes

- `cli.ts` and `takode.ts` are executable entrypoints (`#!/usr/bin/env bun`).
- Keep command output machine-friendly (JSON where possible) to support automation and agent usage.

## Command routing model

- `companion` command:
  - runtime/service commands handled directly in `cli.ts`
  - management subcommands delegated to `ctl.ts`
  - orchestration subcommand delegated to `takode.ts`

- `quest` command:
  - performs local quest-store operations
  - sends best-effort notify to running server for UI refresh

- `takode` command:
  - requires authenticated orchestrator context
  - performs server-authoritative cross-session operations via `/api/takode/*`

## Auth and environment conventions

- Session auth is read from env (`COMPANION_SESSION_ID`, `COMPANION_AUTH_TOKEN`) or
  centralized auth files at `~/.companion/session-auth/<cwd-hash>-<server-id>.json`.
- If multiple Companion instances share the same cwd, the CLI fails closed instead of
  guessing which server namespace to use.
- Port defaults to `3456` unless overridden by `--port` or env.
- Most commands assume a local Takode server is available on `localhost`.

## When adding a new CLI command

1. Decide whether it belongs under `companion`, `takode`, or `quest`.
2. Reuse existing HTTP/auth helper patterns in the corresponding file.
3. Keep error output deterministic for scripting/agent usage.
4. Add or update tests for command behavior and error cases.
