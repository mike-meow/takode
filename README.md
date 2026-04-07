<p align="center">
  <img src="screenshot.png" alt="Takode" width="100%" />
</p>

<h1 align="center">Takode</h1>
<p align="center"><strong>A web workspace for running and coordinating Claude Code and Codex sessions.</strong></p>
<p align="center">See every tool call. Run agents in parallel. Let a leader session orchestrate the whole team.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

---

## Quick Start

**Requirements:** [Bun](https://bun.sh) and either [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) CLI installed.

```bash
git clone https://github.com/MrVPlusOne/takode.git
cd takode && bun install --cwd web
make serve
```

Open <http://localhost:3456>. Create a session, point it at your project, and start chatting.

`make serve` runs the production server with support for server restarts (the server can restart itself to pick up code changes).

---

## What You Can Do

### Let a leader coordinate workers

This is Takode's signature workflow. One session acts as a **leader** that spawns and manages **worker** sessions:

1. The leader creates worker sessions, each in an isolated **git worktree**
2. Workers get dispatched to quests (persistent tasks) and work independently
3. The leader receives **herd events** whenever a worker finishes, needs permission, or hits an issue
4. The leader reviews work, sends follow-up instructions, and coordinates porting changes to the main branch

Workers can't interfere with each other -- each worktree is its own branch. No Docker needed.

### Track work with quests

Quests are persistent tasks that survive server restarts and span across sessions:

- Create quests from the built-in UI, or ask any agent to create one for you
- Quests have a lifecycle: **idea** → **refined** → **in progress** → **needs verification** → **done**
- A verification inbox collects completed work for your review, with checklists and a feedback loop

The leader can run a full **Quest Journey** -- dispatching, reviewing with a skeptic, grooming for quality, porting, and verifying -- all through coordinated sessions.

> Most Takode features -- quests, orchestration, session management, notifications -- are accessible to agents via built-in CLI tools. This is how leader sessions coordinate workers autonomously.

### Run multiple sessions at once

Each session is a full Claude Code or Codex instance with its own conversation, working directory, and git branch. Organize them into sidebar groups by project. Switch between sessions instantly -- multiple browser tabs work too.

### See everything the agent does

Every tool call is visible in the chat: file edits, bash commands, grep searches, file reads. Tool calls are grouped and collapsible, so you can skim the high-level flow or expand any tool block to see exactly what happened. Results stream in real time.

### Two permission modes

Each session runs in either **agent mode** (the agent executes tools freely) or **plan mode** (the agent proposes a plan for your approval before making changes). An **ask flag** can be toggled on to require approval for individual tool calls. Permission requests show up as banners -- approve, reject, or add feedback with a click.

### Talk to your agents

Click the microphone to dictate a prompt. Takode transcribes and sends it. If transcription fails, your recording is saved so you can retry.

### Get notified when you're needed

- **In-app badges** with summary text on sessions that need your attention
- **Pushover notifications** for mobile alerts when you're away from the screen

---

## The Typical Workflow

**Solo use:** Create a session, point it at your repo, chat with it. You get the full Claude Code / Codex experience with better visibility into tool calls and a persistent conversation that survives server restarts.

**Team of agents:** Start a leader session. Tell it what you want built. It creates quests, spawns workers, reviews their output, and ports clean commits to your main branch. You approve plans, verify results, and give feedback -- the leader handles the rest.

```
You
 └─ Leader session
      ├─ Worker #1 (feat/auth)     → worktree, own branch
      ├─ Worker #2 (fix/sidebar)   → worktree, own branch
      ├─ Worker #3 (refactor/api)  → worktree, own branch
      └─ Reviewer sessions         → skeptic + groom passes
```

---

## Works with Both Backends

Takode supports **Claude Code** and **Codex** side by side. Each session can use a different backend. The UI works identically regardless of which CLI is behind it.

---

## CLI

Takode includes a CLI for server and session management:

```bash
takode install        # Install as a background service (launchd / systemd)
takode start / stop   # Start or stop the background service
takode status         # Show service status
takode logs           # Tail service logs
```

```bash
takode sessions list  # List all sessions
takode export         # Export session data to an archive
takode import         # Import session data from an archive
```

---

## Development

```bash
# Dev server (backend :3456 + Vite HMR :5174)
make dev

# Type checking and tests
cd web && bun run typecheck && bun run test

# Production build
cd web && bun run build && bun run start
```

## Documentation

- [WebSocket Protocol Reference](WEBSOCKET_PROTOCOL_REVERSED.md)
- [Architecture & Contributor Guide](CLAUDE.md)

## Origin

Takode started as a fork of [The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion) and has since heavily diverged with its own architecture and feature set.

## License

MIT
