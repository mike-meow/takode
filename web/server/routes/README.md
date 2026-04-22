# `web/server/routes/`

Domain-oriented REST API modules for the backend.

This directory was split out from the former monolithic `server/routes.ts`.
Each file owns a route domain and is mounted by [index.ts](./index.ts).

## Structure

- [index.ts](./index.ts)
  - Composition root for route modules.
  - Builds shared `RouteContext` and mounts each domain router.
- [context.ts](./context.ts)
  - Shared dependency/context contract passed to every route module.
- [auth.ts](./auth.ts)
  - Common Takode auth validation helpers.

## Domain modules

- [sessions.ts](./sessions.ts)
  - Session create/list/search/lifecycle APIs (archive, relaunch, naming, ordering).
- [sessions-archive-routes.ts](./sessions-archive-routes.ts)
  - Session archive/unarchive endpoints, worktree recreation for archived sessions.
- [takode.ts](./takode.ts)
  - Orchestration APIs (`takode list/herd/send/peek/read/answer`).
- [quests.ts](./quests.ts)
  - Quest CRUD, transitions, claims, feedback, verification inbox actions.
- [settings.ts](./settings.ts)
  - Settings reads/writes, auto-approval configuration, logs.
- [filesystem.ts](./filesystem.ts)
  - Directory browsing, file preview, diff and diff-stat endpoints.
- [git.ts](./git.ts)
  - Repo info, branch listing, worktree creation/removal helpers.
- [transcription.ts](./transcription.ts)
  - STT/transcription API and transcription debug endpoints.
- [recordings.ts](./recordings.ts)
  - Raw protocol recording list/start/stop/status endpoints.
- [logs.ts](./logs.ts)
  - Server log streaming (SSE) and log level/time filtering.
- [timers.ts](./timers.ts)
  - Session-scoped timer CRUD and listing endpoints.
- [system.ts](./system.ts)
  - Health, service/system endpoints, migration/export/import, backend discovery.

## Helper modules

- [quest-helpers.ts](./quest-helpers.ts)
  - Shared quest transition helper used by quest routes.
- [sessions-helpers.ts](./sessions-helpers.ts)
  - Shared session creation helpers: backend detection, auth context, archive source resolution.

## How it fits together

1. `createRoutes(...)` in [index.ts](./index.ts) constructs `RouteContext`.
2. Each `create*Routes(ctx)` module registers its own endpoints on a local `Hono` router.
3. Routers are mounted onto the top-level API router.
4. Shared behavior (auth, shell exec, ID resolution, prompts, dependency handles) comes from `RouteContext`.

## Practical guidance

- Add new REST endpoints by extending the relevant domain module first.
- Put cross-domain reusable logic in `context.ts`, `auth.ts`, or a focused helper file.
- Keep route handlers thin; delegate long-running/session logic to `ws-bridge`, launcher, stores, or managers.
