# Quest Journey Lifecycle

Every dispatched task follows the Quest Journey lifecycle. The work board (`takode board show`) tracks each quest's stage and shows the next required leader action. **Do not skip stages -- no exceptions, regardless of change size.** If a change is too small to justify the full journey, it's too small to need a quest. Every quest gets the full lifecycle.

## Stage Overview

| Stage | What's happening | Next action |
|-------|-----------------|-------------|
| `QUEUED` | Quest is ready, waiting for dispatch | Dispatch to a worker |
| `PLANNING` | Worker is planning | Wait for the plan via `permission_request` or plain-text `turn_end`, then review it |
| `IMPLEMENTING` | Worker is implementing | Wait for `turn_end`, then spawn skeptic reviewer |
| `SKEPTIC_REVIEWING` | Skeptic reviewer is evaluating | Wait for reviewer ACCEPT; skeptic-review dispatches must explicitly say `Use the installed /skeptic-review workflow for this review.` |
| `GROOM_REVIEWING` | Reviewer owns the quality pass and follow-up judgment | Wait for reviewer ACCEPT on the worker's response, then send a separate explicit port instruction when ready |
| `PORTING` | Worker is porting to main repo | Wait for port confirmation, then remove from board |

**Board advances only after completed actions.** Do not advance the board anticipating what will happen next. Only advance after the action for that stage is actually done.

**Update the board immediately.** When a herd event arrives that changes quest state (turn_end, permission_request, etc.), update the board as your FIRST action -- before reviewing content, reading messages, or composing responses. The board must always reflect real-time state.

**Mandatory stages:** Skeptic review and groom review are mandatory for ALL quests with code changes -- no exceptions for "small" or "trivial" changes. The default groom path is reviewer-owned via `/reviewer-groom`. `/self-groom` is an escalation path, not the default. Investigation or other no-code quests may skip reviewer-groom only when they truly produce zero code changes, but they still need a clear explicit completion path and must not grow fake port noise.

## Stage-Explicit Worker Steering

- **Authorize one stage at a time.** Every leader-to-worker message should say what the worker is allowed to do now and what must wait.
- **Initial dispatch = planning only.** The worker returns a plan and stops. Do not imply implementation is approved.
- **Quest ownership stays with the worker.** The worker doing the job claims and completes the quest. The leader coordinates the journey but does not claim the quest on the worker's behalf.
- **Plan approval = implement, keep one substantive quest summary comment current, and stop.** Tell the worker to implement, add or refresh the final quest summary comment, report back, and wait. Do not let the worker infer review, porting, or quest transitions.
- **Review/rework = do the named work, refresh that same summary comment, and stop.** If you send reviewer findings, also tell the worker to refresh the quest summary comment before reporting back and waiting. Do not imply porting is authorized.
- **Porting requires an explicit instruction.** Only tell the worker to run `/port-changes` after the reviewer ACCEPTs and you are ready for porting.
- **Investigation/design/no-code quests still need explicit boundaries.** Tell the worker what artifact to produce, have them stop afterward, and choose the next step yourself. Do not assume the worker should self-complete, self-transition, or self-port.
- **Zero-code quests complete without porting.** If the accepted result is an investigation/report/design artifact with zero code changes, complete it directly with artifact-focused verification items. Do not invent synced SHA lines or port-summary comments. If you use `quest complete ... --no-code`, treat it only as a local CLI reminder switch, not durable quest metadata.

## Refine (before QUEUED)

- If no quest exists or it's in `idea` state, work with the user first to gather requirements
- Ask clarifying questions until the WHAT and WHY are unambiguous
- Create or update the quest with a clear description containing the full context a worker needs
- Do NOT dispatch until the quest is refined -- a vague quest produces vague work

## QUEUED -> PLANNING

- Choose a worker and send the standardized dispatch message by invoking `/leader-dispatch`
- The initial dispatch authorizes planning only. Tell the worker to return a plan and stop; do not imply implementation is approved.
- `takode board set <quest-id> --worker <N> --status PLANNING`

## PLANNING -> IMPLEMENTING

- Workers can present plans in two valid ways:
  - `permission_request` via `ExitPlanMode` (formal plan)
  - plain-text assistant output on `turn_end` (informal plan)
- If the worker uses `ExitPlanMode`, review with `takode pending <session>` / the pending payload, then approve or reject with `takode answer`.
- If the worker returns the plan as plain text on `turn_end`, read the plan in the assistant output, then approve or reject with a normal `takode send <session> "..."` message.
- Do **not** send a worker back just because it used plain-text output instead of `ExitPlanMode`. Send it back only if it started implementing without presenting a reviewable plan at all.
- **Read the full plan** -- don't just peek. Verify the worker fully understood the task and aligned with the goal
- Be skeptical and adversarial: does the plan actually address the root problem? Are there misunderstandings or shortcuts that would produce wrong results?
- It's better to reject and redirect now than to let the worker implement the wrong thing
- Approve or reject with the correct mechanism for the path used (`takode answer` for `ExitPlanMode`, normal `takode send` for plain-text plans)
- On approve, send an explicit stage instruction: implement now, then stop and report back. Do not let the worker assume review, `/reviewer-groom`, `/self-groom`, `/port-changes`, or quest transitions are authorized.
- On approve: `takode board advance <quest-id>`

## IMPLEMENTING -> SKEPTIC_REVIEWING

- React to herd events as they arrive -- don't poll
- Steer if needed: scope refinements, corrections, additional context for the current task
- Do NOT send unrelated new tasks to a busy worker -- queue them and wait
- **When the user is directly steering a herded worker**: stay out of it. Resume normal coordination once the user stops interacting
- **Workers must NOT self-advance.** After implementing, the worker reports completion and STOPS. It does not run `/reviewer-groom`, `/self-groom`, `/port-changes`, or `/skeptic-review` on its own. The leader controls stage transitions.
- When `turn_end (✓)` arrives with a quest transition:
  - Run `takode scan <session>` to understand the solution at a high level
  - **Always** spawn a skeptic reviewer (see Skeptic Review below). Skeptic review is mandatory for every quest -- no exceptions, regardless of perceived size or triviality.
  - `takode board advance <quest-id>`

## Skeptic Review

### Spawn Command

```bash
takode spawn --reviewer <session-number> --message 'Load skills first: /takode-orchestration, /quest, /skeptic-review. Use the installed /skeptic-review workflow for this review. Then skeptic review session #X / quest q-Y. Read changes: takode peek X --from N --show-tools'
```

The `--reviewer` flag automatically:
- Disables worktree creation
- Sets fixed name "Reviewer of #XX"
- Tracks the parent relationship

**Keep the spawn message minimal.** Provide context pointers only -- quest ID, session reference, message range for changes, and the explicit sentence `Use the installed /skeptic-review workflow for this review.` Do NOT add extra review criteria or paste diffs into the spawn message.

**Do not rely on implicit self-start.** The leader must explicitly tell the reviewer to use `/skeptic-review`. This rule exists because an earlier q-343 skeptic pass drifted into an ad hoc review when that instruction was omitted.

### Reviewer Lifecycle

- **One reviewer per parent.** To replace, archive the old reviewer with `takode archive`.
- **Reuse within a quest**: keep the same reviewer for follow-up reviews and reviewer-groom follow-up checks on the same worker
- **Archive after the quest is ported**: reviewers are one-off quality gates -- archive them once the quest journey is complete
- **Auto-cleanup**: reviewer is automatically archived when its parent worker is archived
- **Worker-slot exempt**: reviewer sessions do NOT count toward the 5-worker-slot limit, and archiving a reviewer does NOT free a worker slot

## SKEPTIC_REVIEWING -> GROOM_REVIEWING

- **This stage is iterative.** Do not advance until the reviewer issues ACCEPT.
- If the reviewer CHALLENGEs: send findings to the worker for rework, then send the reworked result back to the reviewer. Repeat until ACCEPT.
- If you send rework, tell the worker to address the findings, report back, and stop again. Do not imply porting is authorized.
- On ACCEPT: send the same reviewer a concise review request, then have the reviewer self-invoke `/reviewer-groom "<scope>"`.
- The best scope strings usually identify the quest, the worker, and the worker message range that contains the follow-up being reviewed.
- Example scope: `Review [q-324](quest:q-324) for reviewer-groom follow-up after worker #469's update in [#469 msg 723](session:469:723) through [#469 msg 746](session:469:746)`.
- `/reviewer-groom` generates the quality report inside the reviewer session and should follow an explicit checklist-driven review flow.
- If `/reviewer-groom` returns any Critical or Recommended findings, send them to the worker and tell the worker to address them, report back, and wait. Do not tell the worker to port yet.
- If `/reviewer-groom` returns no Critical or Recommended findings, treat that as groom acceptance and continue to the next stage.
- `takode board advance <quest-id>`

## GROOM_REVIEWING -> PORTING

- Wait for the worker to report back what they changed in response to the reviewer-groom findings (or why they skipped a suggestion).
- **ALWAYS** send the worker's response back to the same reviewer for compliance check. The reviewer verifies that no important Critical or Recommended suggestion was skipped without justification.
- **This stage is iterative.** Do not advance until the reviewer ACCEPTs.
- If CHALLENGE: send findings back to the worker, have them address the issues, then re-send to reviewer. Repeat until ACCEPT.
- Keep the worker waiting while the reviewer checks compliance. If more changes are needed, tell the worker exactly what to do and to stop again afterward.
- On reviewer ACCEPT: tell the worker to port changes using `/port-changes`. Porting must be a separate, explicit instruction, and the worker's report-back must include `Synced SHAs: sha1,sha2` with the ordered synced SHAs from the main repo.
- `takode board advance <quest-id>`
- **NEVER combine "reviewer-groom/rework" and "port" in the same instruction to the worker.** Each is a separate gate.

## PORTING -> (removed)

- Tell the worker to run `/port-changes` only when you are explicitly ready for porting. Do not assume they will self-port once review is done.
- Zero-code quests do not enter `PORTING`. After the accepted artifact is ready, complete them directly with verification items about the artifact/result and without `/port-changes`, synced SHAs, or port-summary noise. If you pass `--no-code`, use it only to suppress the local CLI's port reminder noise.
- Wait for the worker to confirm sync is complete (commits landed, tests passed, pushed to remote) **and include the ordered synced SHAs from the main repo as a dedicated `Synced SHAs: sha1,sha2` line**
- Only after port is confirmed: transition the quest to `needs_verification` and attach those SHAs explicitly with `quest complete q-N --items "..." --commits "sha1,sha2"`. Structured commit metadata should carry routine port information; add a second prose port comment only when something exceptional about the port is materially worth noting.
- `takode board advance <quest-id>` -- this removes the row from the board
- Do **not** run `takode notify review` for quest completion -- when the work board item is completed, Takode already fires the review notification automatically. Sending another one duplicates the quest-completion notification.

## Feedback Rework Loop

When new human feedback lands on a quest:

1. **Record the feedback**: `quest feedback <id> --text "..." --author human` (attach screenshots with `--image <path>`)
2. **Decide whether the quest status itself must move backward**:
   - If the quest is currently in `needs_verification` or `done`, run `quest transition <id> --status refined` first. Those statuses describe a completed review handoff, so the quest itself must re-open before the fresh cycle begins.
   - If the quest is already active (`refined` or `in_progress`), do **not** transition it backward just because new feedback arrived. The quest is already open; the coordination fix is to reset the board row, not to create another status transition.
3. **Reset the board row to match the fresh cycle**: if the quest is still on the board, immediately move it back to the earliest valid stage for the new scope. Usually that means `takode board set <quest-id> --worker <N> --status PLANNING` when the same worker should re-plan, or `takode board set <quest-id> --status QUEUED` when ownership needs to be reconsidered.
4. **Treat the new human feedback as the source of truth**: any stale in-flight review ACCEPT, stale port confirmation, or delayed worker completion from the older scope becomes non-advancing context. Inspect it if useful, but do not let it move the quest forward after the reset.
5. **Dispatch for full quest journey from that reset point**: treat the rework as a fresh cycle. The quest goes through PLANNING -> IMPLEMENTING -> SKEPTIC_REVIEWING -> GROOM_REVIEWING -> PORTING again from the reset stage, ensuring rework gets the same review rigor as the original implementation. Never skip review steps for "small" feedback fixes.
6. **Prefer the original worker** if still available -- it has the most context from the first implementation. Check `takode list` for idle/disconnected workers with matching quest history.
7. **Use the rework dispatch template** from `/leader-dispatch`, which explicitly tells the worker to check and address feedback and return a fresh plan before implementing.
8. **The worker must mark each feedback entry as addressed**: `quest address <id> <index>` after fixing each item. This is a hard requirement -- the leader should verify via `quest show <id>` that all feedback entries are marked addressed before accepting the rework.

This loop can repeat multiple times. Each round is a full quest journey.
