<p align="center">
  <img src="docs/screenshots/readme-leader-workflow.jpeg" alt="Takode leader session with live work board" width="100%" />
</p>

<h1 align="center">Takode</h1>
<p align="center"><strong>A better local workspace for Claude Code and Codex.</strong></p>
<p align="center">Use either backend through one cleaner UI on desktop or mobile, keep full visibility into tool calls, and stay in control of your data. When you want more, add quests and leader-managed parallel work.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

Takode is useful even if you only want one session.

It gives you a cleaner way to run Claude Code or Codex on your own machine:

- **One consistent UI** for both Claude Code and Codex
- **Full tool-call visibility** instead of opaque terminal output
- **Multi-session management** in one workspace, including mobile
- **Local-first operation**: everything runs on your laptop
- **Optional quest and leader workflows** when one session is no longer enough

---

## Why Switch

### A nicer everyday interface

If you already use Claude Code or Codex directly, Takode gives you a better surface for the same core workflows:

- grouped, readable tool calls in chat
- easier session switching and monitoring
- a UI that works well on desktop and mobile
- persistent session history that survives restarts

You can use Takode as a better front-end for a single coding agent and stop there.

### Works with both backends

Takode supports **Claude Code** and **Codex** side by side. Each session can use a different backend, and the workspace gives them a consistent interface for sessions, chat, permissions, and tool visibility.

### Local-first and under your control

Takode runs on your machine and works with local project directories.

- your sessions run locally
- your files stay local
- your session coordination, quest state, and history stay under your control
- there is no Takode-hosted backend you have to trust with your code

The only external dependency you need is the model provider used by Claude Code or Codex.

## When You Need More Than One Chat

### Quest-driven work when chat is not enough

When a request should survive beyond one chat turn, Takode can track it as a **quest**: a persistent task with status, history, feedback, screenshots, and verification items.

- You can ask an agent to write, polish, split, or update quests for you, similar to how you would manage GitHub issues
- A bug report or feature idea can become a quest
- An existing quest like `q-430` can be reassigned, reviewed, or sent back for rework
- Completed work lands in a **verification inbox** instead of disappearing into chat history
- New user feedback can restart the same quest cleanly instead of creating messy side conversations

<p align="center">
  <img src="docs/screenshots/readme-quests.jpeg" alt="Takode quest inbox and search" width="72%" />
</p>

### A leader session can coordinate the team

Takode's most powerful workflow is optional, not required. One session can act as a **leader** that coordinates the rest:

1. It turns your request into one or more refined quests
2. It dispatches workers, usually in isolated **git worktrees**
3. It reacts to worker updates as work finishes, gets blocked, or needs review
4. It pushes each quest through a phase-based journey: planning, quest-specific execution/review phases, and porting when needed

That makes Takode feel much closer to working with a small engineering team than with a single coding chat.

<p align="center">
  <img src="docs/screenshots/readme-leader-workflow.jpeg" alt="Takode leader session with live work board" width="100%" />
</p>

### Review is part of the workflow

Takode is built around a quest journey, not just “agent says done”:

`PLANNING → IMPLEMENTING → CODE REVIEW → PORTING`

In plain terms: leaders assemble the Journey from reusable phases like explore, implement, code-review, mental-simulation, execute, outcome-review, bookkeeping, and port. Zero-tracked-change quests use the same model and simply omit `port` from the planned phases.

### You can actually see what your agents are doing

Every session is a real Claude Code or Codex instance with its own conversation, working directory, and git branch. Takode puts them in one workspace and exposes the details that matter:

- live tool calls, grouped in chat
- session status and pending actions
- permission banners and plan approvals
- notifications when a session needs your attention
- a mobile-friendly UI for checking in away from your desk

<p align="center">
  <img src="docs/screenshots/readme-mobile.jpeg" alt="Takode running on mobile" width="36%" />
</p>

> Most Takode features -- quests, orchestration, session management, notifications -- are accessible to agents via built-in CLI tools. That is what lets leader sessions coordinate workers autonomously.

---

## The Typical Workflow

**Solo use:** Create a session, point it at your repo, and use Takode as a better window into Claude Code or Codex: grouped tool calls, persistent session history, permissions UI, and multi-session visibility.

**Quest workflow:** When you need more structure, create quests for bugs or features and work through them in Takode. You can also ask an agent to draft or refine those quests for you so the task description stays clean and actionable.

**Leader workflow:** When you want parallel execution, start a leader session and give it a bug, idea, screenshot, or quest ID. The leader turns that into tracked work, dispatches the right workers, routes review, and moves finished work into verification. You stay focused on direction and feedback instead of micromanaging every terminal.

```
You
 └─ Leader session
      ├─ Worker #1 (fix/mobile)    → worktree, own branch
      ├─ Worker #2 (search/cli)    → worktree, own branch
      ├─ Worker #3 (investigation) → worktree, own branch
      └─ Reviewer sessions         → skeptic + groom review
```

---

## Also Included

- **Permission controls**: run in agent mode or plan mode, with optional per-tool approvals
- **Voice input**: dictate prompts directly in the app
- **Notifications**: in-app badges and optional Pushover alerts
- **Responsive UI**: check on sessions, approve work, and send messages from mobile
- **Bonus: VS Code integration**: Takode can build and install the VS Code extension for you, and once installed, VS Code cursor selections can be streamed into Takode in real time even if Takode is open in a separate browser window

<p align="center">
  <img src="docs/screenshots/readme-vscode.jpeg" alt="Takode running alongside VS Code with editor context" width="100%" />
</p>

---

## Quick Start

**Requirements:** [Bun](https://bun.sh) and either [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) CLI installed and already authenticated.

```bash
git clone https://github.com/MrVPlusOne/takode.git
cd takode && bun install --cwd web
make serve
```

`make serve` starts the local Takode server and web app.

Then:

1. Open <http://localhost:3456>
2. Create a session
3. Choose Claude Code or Codex as the backend
4. Select the local project directory you want the session to work in
5. Start chatting

Takode runs locally. There is no required third-party service besides the model provider behind the CLI you choose.

---

## Development

```bash
# Install web dependencies once before the first local dev run,
# and rerun after pulling dependency changes
bun install --cwd web

# Dev server (backend :3456 + Vite HMR :5174)
make dev

# Type checking and tests
cd web && bun run typecheck && bun run test

# Production build
cd web && bun run build && bun run start
```

`make dev` assumes the `web/` dependencies are already installed. On a fresh
clone or after dependency changes, run `bun install --cwd web` first.

## Documentation

- [Changelog](CHANGELOG.md)
- [WebSocket Protocol Reference](WEBSOCKET_PROTOCOL_REVERSED.md)
- [Architecture & Contributor Guide](CLAUDE.md)

## Origin

Takode started as a fork of [The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion) and has since heavily diverged with its own architecture and feature set.

## License

MIT
