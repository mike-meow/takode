# Work Board

The work board (`takode board show`) is your primary coordination tool. It tracks the current Quest Journey phase for all active and queued quests, shows next actions, and surfaces blocked quests.

## Commands

### `takode board show`

Display the board with phase boundaries and next-action hints.

### `takode board set <quest-id> [--worker N] [--status STATE] [--wait-for q-X,#Y,free-worker] [--phases phase-a,phase-b] [--preset preset-id] [--no-code|--code-change]`

Add or update a row. Use `--wait-for` to mark what this row is blocked on:
- `q-N` for another quest to clear
- `#N` for a specific session to become reusable
- `free-worker` when the only blocker is herd worker-slot capacity
- `--phases` to assemble a non-default Quest Journey from built-in phase IDs
- `--preset` to label the planned phase sequence; use it only with `--phases`
- `--no-code` to explicitly mark the row as a true zero-code quest that may later use `advance-no-groom`
- `--code-change` to clear that marker and keep the row on the full code-review journey

Built-in phase IDs are `planning`, `implementation`, `skeptic-review`, `reviewer-groom`, and `porting`.

Examples:
- Full built-in journey, explicitly assembled: `takode board set q-12 --worker 5 --phases planning,implementation,skeptic-review,reviewer-groom,porting --preset full-code`
- Lightweight code journey without porting: `takode board set q-12 --worker 5 --phases planning,implementation,skeptic-review,reviewer-groom --preset lightweight-code`
- Investigation-only journey: `takode board set q-12 --worker 5 --phases planning --preset investigation`

### `takode board advance <quest-id>`

Transition to the next Quest Journey phase. At the final built-in phase (porting / `PORTING`), advance removes the row from the board.

### `takode board advance-no-groom <quest-id>`

Explicitly complete a true zero-code quest from `SKEPTIC_REVIEWING`, skipping reviewer-groom and porting.
Use this only after skeptic review accepts a quest that produced zero git-tracked changes and the row has already been marked with `takode board set <quest-id> --no-code`. Git-tracked docs, skills, prompts, templates, and other text-only edits do not qualify for this path.

### `takode board rm <quest-id> [<quest-id> ...]`

Remove row(s) manually.

## Phases

The default built-in full-code Quest Journey follows these phases (see [quest-journey.md](quest-journey.md) for the full phase table and transition rules): planning -> implementation -> skeptic review -> reviewer-groom -> porting. The board keeps the compatible state values: QUEUED -> PLANNING -> IMPLEMENTING -> SKEPTIC_REVIEWING -> GROOM_REVIEWING -> PORTING -> (removed).
Leaders can assemble a shorter or different built-in sequence with `takode board set <quest-id> --phases ... --preset ...`. `takode board advance` then follows the row's planned phase sequence instead of blindly walking every built-in phase.
True zero-code quests have one explicit exception: after marking the row with `takode board set <quest-id> --no-code`, use `takode board advance-no-groom <quest-id>` from `SKEPTIC_REVIEWING` to complete the row without entering `GROOM_REVIEWING` or `PORTING`.

## Rules

- Every command outputs the full board after the operation
- **Always set `--worker N` when adding a quest to the board.** The board must show which session is working on each quest.
- **Use `takode board advance` for phase transitions**, not `takode board set --status`. `advance` enforces the correct Quest Journey order; `set --status` bypasses it.
- **Use `takode board advance-no-groom` only for rows explicitly marked `--no-code` and currently in `SKEPTIC_REVIEWING`.** It is a narrow explicit exception, not a shortcut for git-tracked changes, including text-only tracked-file edits.
- **Reset backwards with `takode board set --status` only for fresh rework cycles.** If new human feedback lands while an older review/port cycle is still in flight, reset the row to the earliest valid phase for the new scope right away: usually `PLANNING` when the same worker should re-plan, or `QUEUED` when ownership needs to be reconsidered.
- **Board advances only after completed actions.** Do not advance anticipating what will happen next. Only advance after the action for that phase is actually done.
- **A stale completion does not outrank fresh feedback.** After a rework reset, old-scope review ACCEPTs, port confirmations, or delayed worker turn completions are historical context only. Do not use them to advance the board.
- **Every `QUEUED` row must keep an explicit `--wait-for` reason.** Do not leave a quest in `QUEUED` with an empty wait-for column.
- **`--wait-for` column**: list of quest IDs (`q-N`), session numbers (`#N`), or `free-worker`. Quest deps resolve when the quest leaves the active board, session deps resolve when the session becomes idle, and `free-worker` resolves when herd worker-slot usage drops below capacity.
- **Resolved quest waits are normalized instead of lingering as stale blockers.** When a queued row's `q-N` dependency resolves, that quest ref is removed from the effective `--wait-for` state. If nothing else remains, the row automatically normalizes to `free-worker` so every queued row still has an explicit wait reason.
- **Dispatchable queued rows show up as ready, not `clear ...`.** `takode board show` distinguishes rows that are still blocked (`wait q-N`, `wait #N`, `wait free worker`) from rows that are now dispatchable (`ready`). Free-worker rows also generate reminders once capacity opens up.
- Rows are auto-removed when a quest transitions to `needs_verification` or `done`.
- **Always use `takode board` commands.** Never manually render markdown board tables in messages -- the CLI is the source of truth.
- The board is stored server-side per leader session and persists across server restarts.
- **Idle/disconnected active rows need judgment.** An active quest whose worker or reviewer is `idle` or `disconnected` is not automatically “fine.” After checking `takode list`, decide whether the row is genuinely waiting or whether the next legal instruction should be sent now. Active timers are part of that judgment: an idle/disconnected session with live timers may still be waiting on expected future work rather than stalled.
