---
name: leader-dispatch
description: "Dispatch workflow for leader/orchestrator sessions. Use when dispatching a quest to a worker, choosing which worker to assign, spawning new worker sessions, or deciding whether to reuse vs spawn. Triggers: 'dispatch', 'send quest', 'assign worker', 'spawn worker', 'which worker', 'reuse or spawn'."
---

# Leader Dispatch Workflow

This skill covers leader discipline and the step-by-step dispatch process. Invoke it every time you dispatch a quest, choose a worker, or spawn a new session.

## Leader Discipline

### Core Rules

- **Never implement non-trivial changes yourself.** Leaders brainstorm, create quests, dispatch, steer, and review -- they do not write code. This protects your context window and keeps you responsive to herd events.
- **Investigation and research are also work to delegate.** When the user says "investigate X", dispatch a worker to investigate and report findings -- don't explore the codebase yourself.
- **Never run `quest claim` yourself.** Workers claim quests when dispatched. This is a hard rule -- leaders coordinate, workers claim.
- **User feedback on completed quests triggers a full rework cycle.** When a user reports issues with a completed quest, record the feedback, set the quest back to `refined`, and dispatch with a full quest journey. Never treat feedback fixes as "quick patches" that skip review. See quest-journey.md in /takode-orchestration.
- **Dispatch immediately when capacity exists.** When a quest is refined and ready, check your herd count before saying "I'll dispatch later." If you have open slots, dispatch now. Don't defer without a concrete reason (e.g., waiting for user input, worker with better context is about to free up).

### Faithful Communication

- **Be faithful to the user's words.** When creating quests or dispatching work, preserve the user's original meaning. Do not embellish, reinterpret, or add details the user didn't say.
- **Ask, don't assume.** If the user's instruction is ambiguous or underspecified, ask a quick follow-up question before dispatching. Every interaction with the user is an opportunity to clarify. Workers can figure out implementation details themselves -- you don't need to fill in gaps with guesses.
- **Never hallucinate user intent.** If the user says "fix the sidebar bug", don't turn it into "fix the sidebar bug by adjusting the CSS grid layout and adding a media query for mobile breakpoints". Pass through what the user said and let the worker investigate.
- **Added details need confirmation.** If you want to add specifics to make instructions more actionable (e.g. suggesting an approach, naming specific files, or scoping the fix), confirm with the user first. An over-specified instruction based on wrong assumptions wastes more time than a brief clarifying question.

## Dispatch Steps

Walk through these steps before dispatching any quest.

### 1. Check the Board

```bash
takode board show
```

See current quest state and capacity. Identify quests already in progress and available worker slots.

### 2. List Your Herd

```bash
takode list
```

See your herded sessions with status, quest claims, last activity. Identify idle workers that might be reusable.

### 3. Evaluate Available Workers

For each idle or disconnected worker, check what quest it last worked on:

```bash
takode info <N>
```

Ask: is the new quest related to this worker's recent context (same feature area, same files, direct follow-up)?

### 4. Decision Rules

| Situation | Action |
|-----------|--------|
| Idle worker with relevant context | Reuse -- send dispatch directly |
| Disconnected worker (✗) with relevant context | Reuse -- send a message to reconnect it |
| Best worker busy but strongly relevant | Queue with `--wait-for #N` (session) or `--wait-for q-N` (quest) on the board |
| No worker has relevant context | Spawn fresh |

**Disconnected ≠ dead.** Workers showing `✗` (disconnected) in `takode list` are NOT dead -- they auto-reconnect when you send them a message via `takode send`. Always prefer reusing a disconnected worker with relevant context over spawning a fresh session. Only archive a disconnected worker if you're sure its context is no longer useful.

**Reuse** when the next task continues the worker's recent work (same feature, same files, direct follow-up). The worker already has the codebase context loaded.

**Queue** when the best worker is busy but has strong context overlap. Add the quest to the board as QUEUED with `--wait-for #N` (where N is the worker's session number) and wait for the worker to free up rather than spawning a fresh session that lacks context. You can also use `--wait-for q-N` to wait for a specific quest to leave the board.

**Spawn fresh** when no existing worker has relevant context. Point the new worker to relevant quests or past sessions for context:

```bash
takode spawn --message "<dispatch>"
```

**Shell quoting safety.** Do not paste complex dispatch text inline inside double quotes if it contains backticks, `$(...)`, or other shell syntax. Your shell can execute that content locally before `takode` receives it. For multi-line or shell-like dispatches, compose the message with a single-quoted heredoc and pass the variable instead:

```bash
msg=$(cat <<'EOF'
Work on [q-XX](quest:q-XX). Read the quest and claim it: `quest show q-XX && quest claim q-XX`.
If logs include `$(...)` or backticks, treat them as literal text.
Return a plan for approval before implementing.
EOF
)
takode spawn --message "$msg"
takode send 2 "$msg"
```

**Never use `--no-worktree` unless the user explicitly asks for it** or the project's repo instructions require it. All workers get worktrees by default -- including investigation and debugging tasks, since they almost always lead to code changes. Don't use `--fixed-name` for regular workers -- they auto-name from their quest.

Default to your own backend type unless the user specifies otherwise.

### 5. Check Herd Limit

Maintain at most **5 sessions** in your herd (reviewer sessions don't count). Before spawning, check `takode list`. When counting, only count non-reviewer sessions. The summary line at the bottom shows total sessions -- subtract reviewers to get the worker count. **Never archive proactively.** Only archive when you are at the 5-session limit AND need to spawn a new worker. Idle and disconnected sessions retain valuable context -- keep them until you actually need the slot. When you must archive, choose the session least likely to be reused -- typically the one whose work is most complete, least related to upcoming tasks, or oldest.

### 6. Send Standardized Dispatch Message

**Use this exact template. Do not add extra context, file paths, or investigation instructions.**

```
Work on [q-XX](quest:q-XX). Read the quest and claim it: `quest show q-XX && quest claim q-XX`.
Return a plan for approval before implementing.
```

When sending this template through the shell, prefer the heredoc pattern above over inline double quotes if you might include shell-like text or multi-line additions.

If the worker needs additional context (related sessions, rejected approaches, user decisions), add it to the quest description before dispatching. Workers have the same tools and skills you do -- they run `quest show q-XX` themselves.

**Workers must stop after each stage boundary.** The dispatch message only authorizes planning. After plan approval, the worker implements. After implementation, the worker STOPS and waits -- it does NOT self-review, self-groom, or self-port. The leader advances the quest through review stages.

**For feedback rework dispatches**, use this extended template instead:

```
Work on [q-XX](quest:q-XX). Read the quest and check unaddressed feedback: `quest show q-XX && quest claim q-XX`.
Address all unaddressed feedback items. After fixing each item, mark it as addressed: `quest address q-XX <index>`.
Return a plan for approval before implementing.
```

This ensures workers know about pending feedback and explicitly mark each item as addressed after fixing it.

**Forward user screenshots.** When the user provides screenshots alongside a task request, attach them to the quest via `quest feedback q-XX --image <path>` before dispatching. If no quest exists (e.g. ad-hoc investigation), send the image file path to the worker via `takode send` so they can Read it. `takode spawn` does not support images -- always use a follow-up message or quest attachment.

### 7. Update the Board

```bash
takode board set <quest-id> --worker <N> --status PLANNING
```

## Task Delegation Style

- **Describe WHAT and WHY, not HOW.** Explain the desired outcome and context -- don't specify files or functions unless you have high confidence from recent direct observation.
- **Provide cross-quest context the worker wouldn't have.** Relay user decisions, rejected approaches, and related quests.
- **Include source conversation references.** When dispatching quests from a brainstorming discussion, include the session ID and message range so workers can inspect design rationale.
- **Include reproduction steps and user observations.** Screenshots, error messages, and user feedback are more valuable than your guesses.
- **Let workers choose the approach when you lack context to decide.**
- **Always require a plan before non-trivial implementation.** Do not accept planless implementations.
