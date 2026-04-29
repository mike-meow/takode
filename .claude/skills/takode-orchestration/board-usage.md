# Work Board

The work board (`takode board show`) is your primary coordination tool. It tracks proposed Quest Journeys before dispatch, active Quest Journey phases during execution, and what action is required next.

While a quest is on the board, the current planned Journey shown there is board-owned draft-or-active state for that quest. Quest creation or refinement defines the quest text, but the board carries the live Journey the leader is currently drafting or running.

## Commands

### `takode board show`

Display the board with phase boundaries, the full Journey path, authored phase notes, and next-action hints.

### `takode board propose <quest-id> (--phases phase-a,phase-b | --spec-file proposal.json) [--preset preset-id] [--wait-for-input 3,4 | --clear-wait-for-input]`

Draft or revise a proposed pre-dispatch Journey row. Proposed rows:

- keep the Journey on the board before dispatch
- can explicitly wait on same-session approval/input
- do not pretend to be generic `QUEUED` worker-capacity rows
- do not assign a worker yet
- are draft state until you promote them into execution

Use `--spec-file` when composing a full proposal with phase notes and presentation/scheduling metadata. The JSON shape should use ordered phases so repeated phases and notes stay attached to the intended occurrence. Omit standard-phase notes by default; add notes only for non-standard phases or unusual phase-specific handling:

```json
{
  "presetId": "proposal-flow",
  "phases": [
    { "id": "alignment" },
    { "id": "explore", "note": "Classify the noisy log source before changing severity handling." },
    { "id": "implement" }
  ],
  "presentation": {
    "summary": "Proposed Journey for approval",
    "scheduling": { "intent": "dispatch-after-approval", "worker": "fresh" }
  }
}
```

### `takode board present <quest-id> [--summary "proposal summary"] [--wait-for-input 3,4 | --clear-wait-for-input]`

Present the current proposed Journey draft as an optional user-facing approval artifact. Use this only when the rendered board proposal is helpful; natural prose approval plus a durable board update is the normal lightweight path. If you revise phases, notes, or presentation metadata after presenting, the presentation becomes stale, but promotion can still use the latest approved board-owned Journey.

### `takode board promote <quest-id> [--worker N] [--status STATE] [--active-phase-position N] [--wait-for q-X,#Y,free-worker] [--wait-for-input 3,4 | --clear-wait-for-input]`

Promote an existing proposed Journey into active execution without redefining its phase sequence. Use this after approval.

Promotion does not require a separate `takode board present` step; the leader may approve the Journey in prose, then promote the board-owned row before dispatch.

### `takode board note <quest-id> <phase-position> [--text "note" | --clear]`

Add or clear one lightweight free-form note for a specific phase occurrence. Phase positions are 1-based in the CLI, so repeated phases can carry different notes.

### `takode board set <quest-id> [--worker N] [--status STATE] [--active-phase-position N] [--wait-for q-X,#Y,free-worker] [--wait-for-input 3,4 | --clear-wait-for-input] [--phases phase-a,phase-b] [--preset preset-id]`

Add or update a row.

- `--wait-for` marks what the row is blocked on:
  - `q-N` for another quest to clear
  - `#N` for a specific session to become reusable
  - `free-worker` when the only blocker is herd worker-slot capacity
- `--wait-for-input` links an active row to same-session `needs-input` notification IDs when the quest is intentionally paused on a human answer
- `--clear-wait-for-input` removes that intentional human-input hold and resolves the linked notification(s)
- `--phases` assembles the row's Journey from built-in phase IDs; repeated phases are allowed
- `--preset` labels the planned phase sequence
- `--active-phase-position` pins the active occurrence for repeated phases using a 1-based position when `--status` alone would be ambiguous
- phase notes rebase by phase occurrence during revisions; when a revision removes the target occurrence, the CLI warns so the leader can reattach the dropped reminder explicitly

Built-in phase IDs are:

`alignment`, `explore`, `implement`, `code-review`, `mental-simulation`, `execute`, `outcome-review`, `bookkeeping`, `port`

Use `takode phases` for the read-only phase catalog, including descriptions, source metadata, and exact leader/assignee brief paths.

Compatibility aliases remain accepted for older rows and habits:

`planning -> alignment`, `implementation -> implement`, `skeptic-review -> code-review`, `reviewer-groom -> code-review`, `porting -> port`, `stream-update -> bookkeeping`, `state-update -> bookkeeping`

Examples:

- Default tracked-code Journey:
  `takode board set q-12 --worker 5 --phases alignment,implement,code-review,port --preset full-code`
- Draft the initial board-owned proposal before dispatch:
  `takode board propose q-12 --spec-file /tmp/q-12-proposal.json`
- Promote that same proposal after approval:
  `takode board promote q-12 --worker 5`
- Expensive or approval-gated run:
  `takode board set q-12 --worker 5 --phases alignment,explore,execute,outcome-review --preset ops-investigation`
- Zero-tracked-change evidence review:
  `takode board set q-12 --worker 5 --phases alignment,explore,outcome-review --preset investigation`
- Scenario/design replay:
  `takode board set q-12 --worker 5 --phases alignment,mental-simulation --preset design-validation`
- Revise the remaining Journey:
  `takode board set q-12 --phases alignment,implement,outcome-review,code-review,port --preset cli-rollout`
- Add a note to the second `code-review` occurrence in a rework loop:
  `takode board note q-12 5 --text "inspect only the follow-up diff"`

When revising an active row, already completed phase occurrences are historical. Keep the completed prefix unchanged and append a later repeated phase occurrence when requirements change after a phase has run.

When `--phases` is supplied for a new active row and `--status` is omitted, the board starts that row at the first planned phase. When revising an existing active row, omitting `--status` preserves the current phase occurrence by index as long as the revised phase list still includes that active boundary.
If a repeated phase is active and the occurrence itself matters, use `--active-phase-position` so the board state and UI do not have to guess which occurrence is current.

### `takode board advance <quest-id>`

Advance a quest to the next phase in that row's planned Journey. At the final planned phase, `advance` removes the row from the board, even when the Journey never included `port`.

### `takode board rm <quest-id> [<quest-id> ...]`

Remove row(s) manually.

## Rules

- Every command outputs the full board after the operation.
- The CLI board output shows the full Journey path with numbered positions and brackets around the active occurrence when known.
- Use natural prose as the normal initial approval surface, then write the approved Journey to the board before or with dispatch.
- Use `takode board set --worker ... --phases ...` after approval when you want to create the active durable row in one step.
- Use `takode board propose` when an existing quest benefits from a pre-dispatch draft row.
- Use `takode board present` only when a rendered approval artifact is helpful.
- Use `takode board promote` to reuse a proposed Journey object after approval.
- Set `--worker N` when dispatching active work, but proposed rows intentionally have no worker.
- Use `takode board advance` for normal phase transitions.
- Do not use `takode board advance` on `PROPOSED` rows; promote first.
- Use `takode board set --status ...` for intentional resets or active-boundary changes.
- Every `QUEUED` row must keep an explicit `--wait-for` reason.
- `--wait-for` and `--wait-for-input` are mutually exclusive on a single row.
- `--wait-for-input` is valid on active rows and proposed approval-hold rows. Do not use it on `QUEUED` rows.
- When an active phase is paused because a human or safety decision is needed before continuing, keep the row active, create a `needs-input` notification, and attach it with `--wait-for-input <id>`. Do not convert the row to `QUEUED --wait-for #N`; use `QUEUED --wait-for` only for pre-active scheduling/dependency waits.
- Update the board immediately when herd events change quest state.
- Do not restate current board rows in chat after updating the board; the UI already shows them live.
- Treat quest threads as the shared quest-scoped context surface: Main remains the complete leader transcript, while quest-backed threads show filtered activity and status for a specific quest. Chat should carry the next decision, reasoning, and facts that are not yet modeled structurally.
- For leader sessions, user-visible Markdown is a normal leader response with a mandatory first-line thread marker: `[thread:main]` or `[thread:q-N]`. Use `takode notify needs-input` afterward only when notification state or suggested answers are needed. `takode user-message` is deprecated compatibility, not the new publishing path.
