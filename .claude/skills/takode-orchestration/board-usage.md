# Work Board

The work board (`takode board show`) is your primary coordination tool. It tracks proposed Quest Journeys before dispatch, active Quest Journey phases during execution, and what action is required next.

While a quest is on the board, the current planned Journey shown there is board-owned draft-or-active state for that quest. Quest creation or refinement defines the quest text, but the board carries the live Journey the leader is currently drafting or running.

## Commands

### `takode board show`

Display the board with phase boundaries, the full Journey path, indexed phase notes, and next-action hints.

### `takode board propose <quest-id> (--phases phase-a,phase-b | --spec-file proposal.json) [--preset preset-id] [--revise-reason "why"] [--wait-for-input 3,4 | --clear-wait-for-input]`

Draft or revise a proposed pre-dispatch Journey row. Proposed rows:

- keep the Journey on the board before dispatch
- can explicitly wait on same-session approval/input
- do not pretend to be generic `QUEUED` worker-capacity rows
- do not assign a worker yet
- are draft state until you explicitly run `takode board present <quest-id>`

Use `--spec-file` when composing the full proposal with phase notes and presentation/scheduling metadata. The JSON shape should use ordered phases so repeated phases and notes stay attached to the intended occurrence:

```json
{
  "presetId": "proposal-flow",
  "phases": [
    { "id": "alignment", "note": "Confirm scope and approval criteria." },
    { "id": "implement", "note": "Build the approved draft/present path." }
  ],
  "presentation": {
    "summary": "Proposed Journey for approval",
    "scheduling": { "intent": "dispatch-after-approval", "worker": "fresh" }
  }
}
```

### `takode board present <quest-id> [--summary "proposal summary"] [--wait-for-input 3,4 | --clear-wait-for-input]`

Present the current proposed Journey draft as the deliberate user-facing approval artifact. Run this after the draft is complete. If you revise phases, notes, or presentation metadata after presenting, present again before normal promotion.

### `takode board promote <quest-id> [--worker N] [--status STATE] [--active-phase-position N] [--wait-for q-X,#Y,free-worker] [--wait-for-input 3,4 | --clear-wait-for-input] [--force-promote-unpresented]`

Promote an existing proposed Journey into active execution without redefining its phase sequence. Use this after approval.

Normal promotion requires the current draft to have been presented. `--force-promote-unpresented` is only for rare recovery/admin scenarios where the leader intentionally bypasses the approval-surface guard.

### `takode board note <quest-id> <phase-position> [--text "note" | --clear]`

Add or clear one lightweight free-form note for a specific phase occurrence. Phase positions are 1-based in the CLI, so repeated phases can carry different notes.

### `takode board set <quest-id> [--worker N] [--status STATE] [--active-phase-position N] [--wait-for q-X,#Y,free-worker] [--wait-for-input 3,4 | --clear-wait-for-input] [--phases phase-a,phase-b] [--preset preset-id] [--revise-reason "why"]`

Add or update a row.

- `--wait-for` marks what the row is blocked on:
  - `q-N` for another quest to clear
  - `#N` for a specific session to become reusable
  - `free-worker` when the only blocker is herd worker-slot capacity
- `--wait-for-input` links an active row to same-session `needs-input` notification IDs when the quest is intentionally paused on a human answer
- `--clear-wait-for-input` removes that intentional human-input hold and resolves the linked notification(s)
- `--phases` assembles the row's Journey from built-in phase IDs; repeated phases are allowed
- `--preset` labels the planned phase sequence
- `--revise-reason` records why an existing Journey's remaining phases changed
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
- Present the completed draft for approval:
  `takode board present q-12 --wait-for-input 3`
- Promote that same proposal after approval:
  `takode board promote q-12 --worker 5`
- Expensive or approval-gated run:
  `takode board set q-12 --worker 5 --phases alignment,explore,execute,outcome-review --preset ops-investigation`
- Zero-tracked-change evidence review:
  `takode board set q-12 --worker 5 --phases alignment,explore,outcome-review --preset investigation`
- Scenario/design replay:
  `takode board set q-12 --worker 5 --phases alignment,mental-simulation --preset design-validation`
- Revise the remaining Journey:
  `takode board set q-12 --phases implement,outcome-review,code-review,port --preset cli-rollout --revise-reason "Need real outcome evidence before final review"`
- Add a note to the second `code-review` occurrence in a rework loop:
  `takode board note q-12 5 --text "inspect only the follow-up diff"`

When `--phases` is supplied for a new active row and `--status` is omitted, the board starts that row at the first planned phase. When revising an existing active row, omitting `--status` preserves the current phase occurrence by index as long as the revised phase list still includes that active boundary.
If a repeated phase is active and the occurrence itself matters, use `--active-phase-position` so the board state and UI do not have to guess which occurrence is current.

### `takode board advance <quest-id>`

Advance a quest to the next phase in that row's planned Journey. At the final planned phase, `advance` removes the row from the board, even when the Journey never included `port`.

### `takode board rm <quest-id> [<quest-id> ...]`

Remove row(s) manually.

## Rules

- Every command outputs the full board after the operation.
- The CLI board output shows the full Journey path with numbered positions and brackets around the active occurrence when known.
- Use `takode board propose` for the initial pre-dispatch draft row.
- Use `takode board present` after the draft is complete; unpresented and stale-presented drafts are not the normal user-facing approval surface.
- Use `takode board promote` to reuse that same Journey object after approval.
- Set `--worker N` when dispatching active work, but proposed rows intentionally have no worker.
- Use `takode board advance` for normal phase transitions.
- Do not use `takode board advance` on `PROPOSED` rows; promote first.
- Use `takode board set --status ...` for intentional resets or active-boundary changes.
- Every `QUEUED` row must keep an explicit `--wait-for` reason.
- `--wait-for` and `--wait-for-input` are mutually exclusive on a single row.
- `--wait-for-input` is valid on active rows and proposed approval-hold rows. Do not use it on `QUEUED` rows.
- Update the board immediately when herd events change quest state.
- Do not restate current board rows in chat after updating the board; the UI already shows them live.
- Treat the right-side quest/status panel as authoritative for the selected session or leader board attention row: quest id/title/status, owner/session pointer, verification progress, inbox unread state, human feedback counts, compact wait/attention state, and compact existing Journey state are visible there. Chat should carry the next decision, reasoning, and any facts not yet modeled structurally.
- For leader sessions, publish user-visible left-panel Markdown with `takode user-message --text-file -`; normal worker/reviewer sessions should ignore that command. Use `takode notify needs-input` afterward only when notification state or suggested answers are needed.
