# Dispatch Workflow

Before dispatching any quest, walk through these steps.

## 1. Check the Board

```bash
takode board show
```

See current quest state and capacity. Identify quests already in progress and available worker slots.

## 2. List Your Herd

```bash
takode list
```

See your herded sessions with status, quest claims, last activity. Identify idle workers that might be reusable.

## 3. Evaluate Available Workers

For each idle or disconnected worker, check what quest it last worked on:

```bash
takode info <N>
```

Ask: is the new quest related to this worker's recent context (same feature area, same files, direct follow-up)?

## 4. Decision Rules

| Situation | Action |
|-----------|--------|
| Idle worker with relevant context | Reuse -- send dispatch directly |
| Disconnected worker (✗) with relevant context | Reuse -- send a message to reconnect it |
| Best worker busy but strongly relevant | Queue with `--wait-for` on the board |
| No worker has relevant context | Spawn fresh |

**Disconnected ≠ dead.** Workers showing `✗` (disconnected) in `takode list` are NOT dead -- they auto-reconnect when you send them a message via `takode send`. Always prefer reusing a disconnected worker with relevant context over spawning a fresh session. Only archive a disconnected worker if you're sure its context is no longer useful.

**Reuse** when the next task continues the worker's recent work (same feature, same files, direct follow-up). The worker already has the codebase context loaded.

**Queue** when the best worker is busy but has strong context overlap. Add the quest to the board as QUEUED with `--wait-for <blocking-quest>` and wait for the worker to free up rather than spawning a fresh session that lacks context.

**Spawn fresh** when no existing worker has relevant context. Point the new worker to relevant quests or past sessions for context:

```bash
takode spawn --message "<dispatch>"
```

**Never use `--no-worktree` unless the user explicitly asks for it** or the project's repo instructions require it. All workers get worktrees by default -- including investigation and debugging tasks, since they almost always lead to code changes. Don't use `--fixed-name` for regular workers -- they auto-name from their quest.

Default to your own backend type unless the user specifies otherwise.

## 5. Check Herd Limit

Maintain at most **5 sessions** in your herd (reviewer sessions don't count). Before spawning, check `takode list`. If at the limit, archive the session least likely to be reused -- typically the one whose work is most complete, least related to upcoming tasks, or oldest.

## 6. Send Standardized Dispatch Message

**Use this exact template. Do not add extra context, file paths, or investigation instructions.**

```
Work on [q-XX](quest:q-XX). Read the quest and claim it: `quest show q-XX && quest claim q-XX`.
Return a plan for approval before implementing.
```

If the worker needs additional context (related sessions, rejected approaches, user decisions), add it to the quest description before dispatching. Workers have the same tools and skills you do -- they run `quest show q-XX` themselves.

**For feedback rework dispatches**, use this extended template instead:

```
Work on [q-XX](quest:q-XX). Read the quest and check unaddressed feedback: `quest show q-XX && quest claim q-XX`.
Address all unaddressed feedback items. After fixing each item, mark it as addressed: `quest address q-XX <index>`.
Return a plan for approval before implementing.
```

This ensures workers know about pending feedback and explicitly mark each item as addressed after fixing it.

**Forward user screenshots.** When the user provides screenshots alongside a task request, attach them to the quest via `quest feedback q-XX --image <path>` before dispatching. If no quest exists (e.g. ad-hoc investigation), send the image file path to the worker via `takode send` so they can Read it. `takode spawn` does not support images -- always use a follow-up message or quest attachment.

## 7. Update the Board

```bash
takode board set <quest-id> --worker <N> --status PLANNING
```
