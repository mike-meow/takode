# Quest Journey Lifecycle

Every dispatched task follows the Quest Journey lifecycle. The work board (`takode board show`) tracks each quest's stage and shows the next required leader action. **Do not skip stages.**

## Stage Overview

| Stage | What's happening | Next action |
|-------|-----------------|-------------|
| `QUEUED` | Quest is ready, waiting for dispatch | Dispatch to a worker |
| `PLANNING` | Worker is planning | Wait for `permission_request` (ExitPlanMode), then review plan |
| `IMPLEMENTING` | Worker is implementing | Wait for `turn_end`, then spawn skeptic reviewer |
| `SKEPTIC_REVIEWING` | Skeptic reviewer is evaluating | Wait for reviewer ACCEPT, then tell worker to run /groom |
| `GROOM_REVIEWING` | Reviewer is checking groom compliance | Wait for reviewer ACCEPT, then tell worker to port |
| `PORTING` | Worker is porting to main repo | Wait for port confirmation, then remove from board |

**Board advances only after completed actions.** Do not advance the board anticipating what will happen next. Only advance after the action for that stage is actually done.

**Mandatory stages:** Skeptic review is always mandatory. Groom review is mandatory for all code changes. Groom may only be skipped when the task produced zero code changes (e.g., analysis-only work).

## Refine (before QUEUED)

- If no quest exists or it's in `idea` state, work with the user first to gather requirements
- Ask clarifying questions until the WHAT and WHY are unambiguous
- Create or update the quest with a clear description containing the full context a worker needs
- Do NOT dispatch until the quest is refined -- a vague quest produces vague work

## QUEUED -> PLANNING

- Choose a worker and send the standardized dispatch message by following [dispatch-workflow.md](dispatch-workflow.md)
- `takode board set <quest-id> --worker <N> --status PLANNING`

## PLANNING -> IMPLEMENTING

- Wait for the `permission_request` herd event (ExitPlanMode)
- **If the worker completes without submitting a plan first**, send it back: "Please submit a plan via ExitPlanMode before implementing. I need to review your approach."
- **Read the full plan** -- don't just peek. Verify the worker fully understood the task and aligned with the goal
- Be skeptical and adversarial: does the plan actually address the root problem? Are there misunderstandings or shortcuts that would produce wrong results?
- It's better to reject and redirect now than to let the worker implement the wrong thing
- Approve or reject with specific feedback via `takode answer`
- On approve: `takode board advance <quest-id>`

## IMPLEMENTING -> SKEPTIC_REVIEWING

- React to herd events as they arrive -- don't poll
- Steer if needed: scope refinements, corrections, additional context for the current task
- Do NOT send unrelated new tasks to a busy worker -- queue them and wait
- **When the user is directly steering a herded worker**: stay out of it. Resume normal coordination once the user stops interacting
- When `turn_end (✓)` arrives with a quest transition:
  - Run `takode scan <session>` to understand the solution at a high level
  - **Always** spawn a skeptic reviewer (see Skeptic Review below). Skeptic review is mandatory for every quest -- no exceptions, regardless of perceived size or triviality.
  - `takode board advance <quest-id>`

## Skeptic Review

### Spawn Command

```bash
takode spawn --reviewer <session-number> --message 'Load skills first: /takode-orchestration, /quest, /skeptic-review. Then skeptic review session #X / quest q-Y. Read changes: takode peek X --from N --show-tools'
```

The `--reviewer` flag automatically:
- Disables worktree creation
- Sets fixed name "Reviewer of #XX"
- Tracks the parent relationship

**Keep the spawn message minimal.** Provide context pointers only -- quest ID, session reference, message range for changes. The reviewer invokes `/skeptic-review` itself and decides what to evaluate. Do NOT tell the reviewer what to check or paste diffs into the spawn message.

### Reviewer Lifecycle

- **One reviewer per parent.** To replace, stop the old reviewer first with `takode interrupt`.
- **Persistent**: reuse the same reviewer for follow-up reviews and groom compliance checks on the same worker
- **Auto-cleanup**: reviewer is archived when its parent worker is archived
- **Herd limit exempt**: reviewer sessions do NOT count toward the 5-session herd limit

## SKEPTIC_REVIEWING -> GROOM_REVIEWING

- **This stage is iterative.** Do not advance until the reviewer issues ACCEPT.
- If the reviewer CHALLENGEs: send findings to the worker for rework, then send the reworked result back to the reviewer. Repeat until ACCEPT.
- On ACCEPT: tell the worker to run `/groom` for self-review and incorporate suggestions, then `takode board advance <quest-id>`.

## GROOM_REVIEWING -> PORTING

- Wait for the worker to report back from groom
- Send the same reviewer a minimal message to check groom compliance. The reviewer decides what to verify.
- **This stage is iterative.** Do not advance until the reviewer ACCEPTs.
- If CHALLENGE: send findings back to the worker, iterate
- On ACCEPT: tell the worker to port changes using `/port-changes`
- `takode board advance <quest-id>`

## PORTING -> (removed)

- Wait for the worker to confirm sync is complete (commits landed, tests passed, pushed to remote)
- Only after port is confirmed: transition the quest to `needs_verification`
- `takode board advance <quest-id>` -- this removes the row from the board
- Run `takode notify review "<quest-id> ready for verification"` to alert the user that the quest is ready for verification

## Feedback Rework Loop

When the user provides feedback on a completed quest (in `needs_verification` or `done` state):

1. **Record the feedback**: `quest feedback <id> --text "..." --author human` (attach screenshots with `--image <path>`)
2. **Reset the quest state**: `quest transition <id> --status refined`
3. **Dispatch for full quest journey**: Treat the rework as a fresh dispatch. The quest goes through PLANNING -> IMPLEMENTING -> SKEPTIC_REVIEWING -> GROOM_REVIEWING -> PORTING again, ensuring rework gets the same review rigor as the original implementation. Never skip review steps for "small" feedback fixes.
4. **Prefer the original worker** if still available -- it has the most context from the first implementation. Check `takode list` for idle/disconnected workers with matching quest history.
5. **Use the rework dispatch template** from dispatch-workflow.md, which explicitly tells the worker to check and address feedback.
6. **The worker must mark each feedback entry as addressed**: `quest address <id> <index>` after fixing each item. This is a hard requirement -- the leader should verify via `quest show <id>` that all feedback entries are marked addressed before accepting the rework.

This loop can repeat multiple times. Each round is a full quest journey.
