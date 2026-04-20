# Work Board

The work board (`takode board show`) is your primary coordination tool. It tracks Quest Journey state for all active and queued quests, shows next actions, and surfaces blocked quests.

## Commands

### `takode board show`

Display the board with stages and next-action hints.

### `takode board set <quest-id> [--worker N] [--status STATE] [--wait-for q-X,#Y,free-worker]`

Add or update a row. Use `--wait-for` to mark what this row is blocked on:
- `q-N` for another quest to clear
- `#N` for a specific session to become reusable
- `free-worker` when the only blocker is herd worker-slot capacity

### `takode board advance <quest-id>`

Transition to the next Quest Journey stage. At the final stage (PORTING), advance removes the row from the board.

### `takode board rm <quest-id> [<quest-id> ...]`

Remove row(s) manually.

## Stages

Stages follow the Quest Journey lifecycle (see [quest-journey.md](quest-journey.md) for the full stage table and transition rules): QUEUED -> PLANNING -> IMPLEMENTING -> SKEPTIC_REVIEWING -> GROOM_REVIEWING -> PORTING -> (removed).

## Rules

- Every command outputs the full board after the operation
- **Always set `--worker N` when adding a quest to the board.** The board must show which session is working on each quest.
- **Use `takode board advance` for stage transitions**, not `takode board set --status`. `advance` enforces the correct lifecycle order; `set --status` bypasses it.
- **Reset backwards with `takode board set --status` only for fresh rework cycles.** If new human feedback lands while an older review/port cycle is still in flight, reset the row to the earliest valid stage for the new scope right away: usually `PLANNING` when the same worker should re-plan, or `QUEUED` when ownership needs to be reconsidered.
- **Board advances only after completed actions.** Do not advance anticipating what will happen next. Only advance after the action for that stage is actually done.
- **A stale completion does not outrank fresh feedback.** After a rework reset, old-scope review ACCEPTs, port confirmations, or delayed worker turn completions are historical context only. Do not use them to advance the board.
- **Every `QUEUED` row must keep an explicit `--wait-for` reason.** Do not leave a quest in `QUEUED` with an empty wait-for column.
- **`--wait-for` column**: list of quest IDs (`q-N`), session numbers (`#N`), or `free-worker`. Quest deps resolve when the quest leaves the active board, session deps resolve when the session becomes idle, and `free-worker` resolves when herd worker-slot usage drops below capacity.
- **Resolved wait-for refs stay visible until you dispatch the row.** A queued row can show `clear q-N`, `clear #N`, or `clear free worker` to tell you it is now dispatchable. When you assign a worker with `takode board set ... --worker N` and no new `--wait-for`, the stale queue dependency is cleared automatically.
- Rows are auto-removed when a quest transitions to `needs_verification` or `done`.
- **Always use `takode board` commands.** Never manually render markdown board tables in messages -- the CLI is the source of truth.
- The board is stored server-side per leader session and persists across server restarts.
- **Idle/disconnected active rows need judgment.** An active quest whose worker or reviewer is `idle` or `disconnected` is not automatically “fine.” After checking `takode list`, decide whether the row is genuinely waiting or whether the next legal instruction should be sent now. Active timers are part of that judgment: an idle/disconnected session with live timers may still be waiting on expected future work rather than stalled.
