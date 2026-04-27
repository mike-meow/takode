# `scripts/`

Repository-level helper scripts for local development and maintenance.

Run these from the repository root unless noted otherwise.

## Shell scripts

- [`dev-start.sh`](./dev-start.sh)
  - Idempotent local dev bootstrap for backend + frontend.
  - Supports:
    - `./scripts/dev-start.sh`
    - `./scripts/dev-start.sh --status`
    - `./scripts/dev-start.sh --stop`

- [`landing-start.sh`](./landing-start.sh)
  - Idempotent startup/status/stop script for the `landing/` site.
  - Supports:
    - `./scripts/landing-start.sh`
    - `./scripts/landing-start.sh --status`
    - `./scripts/landing-start.sh --stop`

- [`sync-codex-protocol.sh`](./sync-codex-protocol.sh)
  - Refreshes offline Codex protocol snapshots under
    `web/server/protocol/codex-upstream/` from upstream `openai/codex`.
  - Updates copied schema files and snapshot README metadata.

## Bun script

- [`audit-recordings.ts`](./audit-recordings.ts)
  - Analyzes raw protocol recordings (`~/.companion/recordings/` by default).
  - Reports message/tool field coverage and protocol-vs-UI gaps.
  - Example:
    - `bun run scripts/audit-recordings.ts`
    - `bun run scripts/audit-recordings.ts --latest`
    - `bun run scripts/audit-recordings.ts --session <session-id>`

- [`migrate-prod-port-3455-to-3456.ts`](./migrate-prod-port-3455-to-3456.ts)
  - One-off operator-run migration for the current local prod state takeover from port `3455` to `3456`.
  - Dry-run / preflight:
    - `bun run scripts/migrate-prod-port-3455-to-3456.ts`
  - Apply after stopping the live `3455` server:
    - `PORT_MIGRATION_APPLY=1 bun run scripts/migrate-prod-port-3455-to-3456.ts`
  - Writes timestamped backups under `~/.companion/port-migrations/` and generates a rollback script alongside the manifest.
  - After restarting prod on `3456`, validate:
    - `3455` is down and `3456` is listening
    - `/api/settings` reports the reused `3455` serverId on `3456`
    - the expected tree groups still appear on `3456` instead of a default-only fallback
    - from a representative existing worktree, `quest status q-922` succeeds without setting `COMPANION_PORT`
  - If any validation fails, stop `3456` and run the generated rollback script.

## When to use this directory

- Use these scripts for reproducible local workflows and protocol maintenance.
- Keep one-off ad hoc commands out of this directory unless they are expected to be reused.

## Conventions

- Prefer idempotent behavior for start/stop scripts.
- Fail fast with clear stderr when prerequisites are missing.
- Keep scripts safe to run from fresh clones and long-lived dev environments.

## Related locations

- `web/scripts/` contains web-app-specific helper scripts used during build/test flows.
- `scripts/` (this directory) is for repository-level operational tooling.

## Typical maintenance workflows

- "Bring up local app stack":
  - `./scripts/dev-start.sh`
- "Run landing page":
  - `./scripts/landing-start.sh`
- "Refresh Codex protocol snapshots for drift tests":
  - `./scripts/sync-codex-protocol.sh`
- "Audit real protocol traces to identify parser/UI gaps":
  - `bun run scripts/audit-recordings.ts --latest`
- "Prepare or run the one-off 3455 -> 3456 prod state migration":
  - `bun run scripts/migrate-prod-port-3455-to-3456.ts`
  - `PORT_MIGRATION_APPLY=1 bun run scripts/migrate-prod-port-3455-to-3456.ts`

## Adding a new script

1. Add a short usage header at the top of the script.
2. Document required env vars/ports/paths.
3. Update this README with purpose + example invocation.
4. Keep behavior deterministic so scripts are CI/automation friendly.
