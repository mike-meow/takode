# Roadmap

Tracking ongoing work, planned features, and ideas for The Companion.

### How to use this document

- **In Progress** — Move items here when you start working on them. Move them out when done.
- **Planned** — Concrete improvements ready to be picked up.
- **To Verify** — Completed features that need manual verification from the user. Each entry should include specific instructions on what to test and why automated testing wasn't sufficient. The user removes entries after verifying.
- **Ideas** — Rough ideas for future consideration.

When a feature is fully complete and doesn't need manual verification, just remove it from this document entirely — there is no "Completed" section. If there are known cases you couldn't test, add the feature to "To Verify" with clear verification instructions instead.

## In Progress

_Nothing currently in progress._

## Planned

- [ ] **Pause generation timer during user waits** — The "Generating... (Xm Xs)" timer keeps counting even when the agent is blocked waiting for user input (permission requests, plan approval, questions). The timer should pause whenever the session enters a waiting-for-user state and resume only when the agent is actively generating again, so it reflects actual generation time.
- [ ] **Show permission denial in chat stream** — When the user denies a permission request, there is no visual record in the chat stream. The permission banner just disappears with no trace. Add a rejection event to the message history (similar to how the Claude Code CLI shows it) so the user can see what was denied and when.
- [ ] **Fix "CLI disconnected" banner on new session startup** — New sessions briefly show a "CLI disconnected" banner with a "Reconnect" button while the CLI process is still starting up. The browser WebSocket connects before the CLI has connected back. Should show a "Starting session..." loading state instead.
- [ ] **Fix restoring archived worktree sessions** — Restoring an archived worktree session reuses whatever worktree path was in the session metadata without checking if it still exists or is claimed by another session. This causes the restored session to share a worktree with an active session. Should either create a fresh worktree or warn the user.
- [ ] **Session branching (fork at earlier conversation point)** — Investigate adding the ability to branch/fork a session at an earlier point in the conversation, creating a new session that starts from that point. Both the Claude Code CLI and the VS Code extension already support this. This is a foundational capability that other features (like plan-approval-with-compaction) could build on top of.
- [ ] **Diff view: show total additions/deletions** — The diff view currently lists changed files but doesn't show aggregate stats. Add a summary line with total additions and deletions (e.g. "+120 -45") similar to the GitHub PR UI, both per-file and as a total across all changed files.
- [ ] **Collapsible question panel** — The `AskUserQuestion` panel takes up too much vertical space, blocking the conversation stream. Add a collapse button that minimizes it back into the in-chat question chip (the same view shown after a question is answered, but in an unanswered state). Clicking the chip expands the full panel again. Ideally, the in-chat chip itself should also be interactable — users could answer directly from it without expanding, for simple single-choice questions.

## To Verify

_Nothing to verify._

## Ideas

- [ ] **Plan approval with partial compaction** — In plan mode, the model often does extensive exploration (many tool calls, back-and-forth corrections) before arriving at the final plan. This consumes a lot of context tokens. Add a third option alongside "approve" and "reject": "approve & compact." This would accept the plan but partially compact the context by summarizing all the exploration and iteration that led to the plan, while keeping the earlier conversation history (before planning started) intact. The model would then see: (1) full pre-planning conversation, (2) a brief summary of the exploration/iteration process, (3) the final approved plan. This saves tokens, slows context growth, and allows more iteration. Implementation likely requires forking/rewriting the chat history at the point where planning began — session branching (see Planned) could be a building block for this.
- [ ] **Collapsible agent activity between user messages** — In long conversations, scrolling past many tool calls and agent messages to find previous user messages is tedious. Add a toggle to collapse all agent activity between two consecutive user messages into a single compact row. When collapsed, show a brief indicator (e.g. "12 agent actions"). Bonus: call Claude Haiku to generate a short summary of the collapsed agent activity so users can skim what happened without expanding.
- [ ] **Investigate Claude Code hooks compatibility** — User hooks (configured in `~/.claude/settings.json` or `.claude/settings.json`) may not fire correctly when sessions run inside Companion. Investigate whether Companion or the CLI launcher modifies/overrides hook configuration. If Companion does inject its own hooks, ensure they are composed with the user's existing hooks (e.g. chained or merged) rather than replacing them.
- [ ] **Persistent "always allow" permission rules** — When the user clicks "Allow always" on a permission prompt, Claude Code writes the rule to a local `.claude/settings.local.json` in the project. In a git worktree workflow, that file is lost when the worktree is deleted. Explore ways to make these permission rules more durable — e.g. Companion could intercept the "allow always" action and store rules server-side, or sync them to the user's global `~/.claude/settings.json`, or maintain its own permission allowlist that gets injected into new worktrees. Needs brainstorming on the right approach.
- [ ] **Claude-Mem integration** — Connect the Claude-Mem observation database to the Companion UI. Claude-Mem runs an async worker that extracts learnings/summaries from each tool call. Once those observations are available, attach them to the corresponding tool call chips in the message stream. Users could expand a tool call to see what learnings were extracted from it (e.g. discoveries, decisions, bug findings). Requires querying the Claude-Mem API/DB and matching observations back to tool calls by session/timestamp.
