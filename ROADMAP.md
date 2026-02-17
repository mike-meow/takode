# Roadmap

Tracking ongoing work, planned features, and ideas for The Companion.

## In Progress

_Nothing currently in progress._

## Planned


## Completed

- [x] **Remove auto-update checker** — Removed all update-checking code: server-side checker, UI banner, settings page section, Playground demos, polling intervals. ~960 lines removed across 13 files. _Manual verification: confirm no update prompts appear in the UI or server logs._
- [x] **Copy Claude Code session ID from UI** — Added copy button in 3 places: TopBar (clipboard icon next to session name), sidebar right-click context menu ("Copy CLI Session ID" option), and session hover card (shows truncated ID). _Manual verification: click the copy button and run `claude --resume <pasted-id>` in terminal to confirm it works._
- [x] **Sidebar session status indicators** — New `SessionStatusDot` component shows colored dots: green pulsing (running), amber pulsing (permission needed or compacting), dim green (idle), red (disconnected), gray (archived). Extracted from inline logic in `SessionItem.tsx` into a standalone component with 21 tests. _Manual verification: start a session and watch the dot change from idle to running when the agent works. Disconnect the CLI process and verify the dot turns red._
- [x] **Simplified permission model** — Replaced 3-mode dropdown with Plan/Agent toggle + "Ask Permission" switch. After plan approval, server auto-switches CLI to `bypassPermissions` (if ask=true) or `acceptEdits` (if ask=false). Codex sessions unaffected. _Manual verification: (1) Set Plan + Ask ON, submit a task, approve the plan, then verify Claude executes without further permission prompts. (2) Set Agent + Ask OFF, verify Claude runs in full bypass mode. (3) Toggle Ask Permission mid-session and verify the mode change takes effect immediately._
- [x] **Image & message lightbox** — Clicking any image thumbnail in a user message opens a fullscreen lightbox modal (dark backdrop, image at natural size constrained to 90vw/90vh). Close via backdrop click, Escape key, or X button. Playground updated with lightbox demos. _Manual verification: paste an image in the composer, send it, then click the thumbnail in chat to verify the lightbox opens. Also verify the message chip lightbox aspect was not implemented — only image thumbnails are clickable for now._

## Ideas

- [ ] **Collapsible agent activity between user messages** — In long conversations, scrolling past many tool calls and agent messages to find previous user messages is tedious. Add a toggle to collapse all agent activity between two consecutive user messages into a single compact row. When collapsed, show a brief indicator (e.g. "12 agent actions"). Bonus: call Claude Haiku to generate a short summary of the collapsed agent activity so users can skim what happened without expanding.
- [ ] **Investigate Claude Code hooks compatibility** — User hooks (configured in `~/.claude/settings.json` or `.claude/settings.json`) may not fire correctly when sessions run inside Companion. Investigate whether Companion or the CLI launcher modifies/overrides hook configuration. If Companion does inject its own hooks, ensure they are composed with the user's existing hooks (e.g. chained or merged) rather than replacing them.
- [ ] **Claude-Mem integration** — Connect the Claude-Mem observation database to the Companion UI. Claude-Mem runs an async worker that extracts learnings/summaries from each tool call. Once those observations are available, attach them to the corresponding tool call chips in the message stream. Users could expand a tool call to see what learnings were extracted from it (e.g. discoveries, decisions, bug findings). Requires querying the Claude-Mem API/DB and matching observations back to tool calls by session/timestamp.
