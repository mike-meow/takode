<p align="center">
  <img src="screenshot.png" alt="Takode" width="100%" />
</p>

<h1 align="center">Takode</h1>
<p align="center"><strong>Web orchestration UI for Claude Code and Codex sessions.</strong></p>
<p align="center">Run multiple agents, inspect every tool call, and coordinate work across sessions.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

Takode started as a fork of The-Vibe-Company/companion but has since heavily diverged with its own feature set.

## What makes Takode different
- **Cross-session orchestration**: leader/worker workflows powered by the Takode CLI, herd events, and injected coordination messages.
- **Questmaster workflow**: persistent quest/task tracking across sessions, with lifecycle transitions and verification inbox flows.
- **Git worktree isolation**: lightweight per-session isolation via git worktrees (preferred over upstream's Docker-first model).
- **Multi-backend support**: first-class support for both Claude Code and Codex via adapter-based protocol normalization.
- **Protocol recordings**: raw NDJSON/JSON-RPC recording and replay tooling for debugging protocol drift.
- **Voice + STT integration**: built-in voice input and speech-to-text endpoints for prompt creation.
- **Landing page + product surface**: includes the takode.sh-facing landing app alongside the main session UI.

## Quick start
Requirements:
- Bun
- Claude Code and/or Codex CLI available on your machine

Run:
```bash
bunx the-companion
```
Open `http://localhost:3456`.

Alternative foreground command:
```bash
the-companion serve
```

## Architecture (simple)
```text
Browser (React)
  <-> ws://localhost:3456/ws/browser/:session
Takode server (Bun + Hono)
  <-> ws://localhost:3456/ws/cli/:session
Claude Code / Codex backends
```

## Development
```bash
make dev
```

Manual:
```bash
cd web
bun install
bun run dev
```

Checks:
```bash
cd web
bun run typecheck
bun run test
```

## Docs
- Protocol reverse engineering: [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md)
- Contributor and architecture guide: [`CLAUDE.md`](CLAUDE.md)

## License
MIT
