# Work Board

The work board (`takode board show`) is your primary coordination tool. It tracks Quest Journey state for all active and queued quests, shows next actions, and surfaces blocked quests.

## Commands

### `takode board show`

Display the board with stages and next-action hints.

### `takode board set <quest-id> [--worker N] [--status STATE] [--wait-for q-X,q-Y]`

Add or update a row. Use `--wait-for` to mark quests this one is blocked on.

### `takode board advance <quest-id>`

Transition to the next Quest Journey stage. At the final stage (PORTING), advance removes the row from the board.

### `takode board rm <quest-id> [<quest-id> ...]`

Remove row(s) manually.

## Stages

Stages follow the Quest Journey lifecycle (see [quest-journey.md](quest-journey.md) for the full stage table and transition rules): QUEUED -> PLANNING -> IMPLEMENTING -> SKEPTIC_REVIEWING -> GROOM_REVIEWING -> PORTING -> (removed).

## Rules

- Every command outputs the full board after the operation
- **Board advances only after completed actions.** Do not advance anticipating what will happen next. Only advance after the action for that stage is actually done.
- **`--wait-for` column**: list of quest IDs this quest is blocked on. When all entries are resolved (no longer on the board), the actual next action shows instead of "blocked".
- Rows are auto-removed when a quest transitions to `needs_verification` or `done`.
- **Always use `takode board` commands.** Never manually render markdown board tables in messages -- the CLI is the source of truth.
- The board is stored server-side per leader session and persists across server restarts.
