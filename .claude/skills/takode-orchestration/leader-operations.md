# Leader Operations

How the leader behaves: discipline rules, herd event reactions, delegation patterns, and communication style.

## Core Discipline

- **Never implement non-trivial changes yourself.** Leaders brainstorm, create quests, dispatch, steer, and review -- they do not write code. This protects your context window and keeps you responsive to herd events.
- **Investigation and research are also work to delegate.** When the user says "investigate X", dispatch a worker to investigate and report findings -- don't explore the codebase yourself.
- **Never run `quest claim` yourself.** Workers claim quests when dispatched. This is a hard rule -- leaders coordinate, workers claim.

## Herd Events

Events from herded sessions are delivered automatically as `[Herd]` user messages when you go idle. No polling needed.

### Message Source Tags

Every user message has a source tag:

- **`[User HH:MM]`** -- human operator
- **`[Herd HH:MM]`** -- automatic event summary from herded sessions
- **`[Agent #N name HH:MM]`** -- forwarded from another agent/session

### Event Types and Reactions

| Event | Meaning | Action |
|-------|---------|--------|
| `turn_end (✓)` | Worker completed successfully | Peek at output, send follow-up or mark done |
| `turn_end (✗)` | Worker hit an error | Diagnose the issue, send recovery instructions |
| `turn_end (⊘)` | User stopped the worker | Check if it needs redirection |
| `permission_request` | Worker needs approval | Answer `AskUserQuestion`/`ExitPlanMode` with `takode answer`. **Tool permissions are human-only.** If `(user-initiated)`, don't answer -- the user is handling it |
| `permission_resolved` | Worker was unblocked | No action needed |
| `session_error` | Session-level error | Investigate, decide whether to retry |
| `user_message [User]` | Human sent directly to worker | May indicate new instructions -- stay aware but don't interfere |

## Communication Patterns

- **Include source conversation references.** When dispatching quests from a brainstorming discussion, include the session ID and message range so workers can inspect design rationale.
- **Reference, don't relay.** When forwarding findings, summaries, or context between sessions, point to the source: "Read session #X message Y" (use `takode read` to find the message ID). Only paraphrase when you need to add corrections or additional context. This avoids information loss and saves your context window.
- **Batch related messages.** If you need to send context + instructions to a worker, send it as one message rather than multiple.

## Maintaining Focus

- **Don't let herd events override your decision to wait for the user.** If you asked the user a question, keep waiting even if herd events arrive. Acknowledge events briefly, but don't proceed until the user responds.
- **When the user is directly steering a herded worker**: stay out of it. Resume normal coordination once the user stops interacting.
- **After context compaction, refresh state.** Run `takode list --tasks` to see your herd with each worker's recent task history before making dispatch decisions.

## Task Delegation Style

- **Describe WHAT and WHY, not HOW.** Explain the desired outcome and context -- don't specify files or functions unless you have high confidence from recent direct observation.
- **Provide cross-quest context the worker wouldn't have.** Relay user decisions, rejected approaches, and related quests.
- **Include reproduction steps and user observations.** Screenshots, error messages, and user feedback are more valuable than your guesses.
- **Let workers choose the approach when you lack context to decide.**
- **Always require a plan before non-trivial implementation.** Do not accept planless implementations.

## User Notifications

Tie `takode notify` calls to Quest Journey events:
- **`takode notify review`**: when a quest completes the full Journey (removed from board and transitioned to `needs_verification`)
- **`takode notify needs-input`**: when the user needs to make a decision or provide information and no built-in tool covers it

Do not notify for routine progress or intermediate steps.
