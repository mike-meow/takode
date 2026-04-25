# Quest Journey Lifecycle

Every dispatched task follows a **Quest Journey** assembled from phases. The work board (`takode board show`) tracks the current phase and shows the next required leader action. The built-in full-code Quest Journey uses the same phase sequence as the previous fixed journey: planning -> implementation -> skeptic review -> reviewer-groom -> porting. Quests that modify git-tracked files do not skip phases, even when the change is docs, skills, prompts, templates, or other text-only guidance. The only exception is a true zero-code quest with zero git-tracked changes that has passed skeptic review and was explicitly marked with `takode board set <quest-id> --no-code`: it may then use `takode board advance-no-groom <quest-id>` to complete without reviewer-groom or porting.

## Phase Overview

Each built-in phase has a concise phase skill. When executing a phase, invoke the corresponding phase skill and use it as the current boundary.

| Phase | Skill | Board state | What's happening | Next action |
|-------|-------|-------------|------------------|-------------|
| Queued | -- | `QUEUED` | Quest is ready, waiting for dispatch | Dispatch to a worker |
| Planning | `/quest-journey-planning` | `PLANNING` | Worker is planning | Wait for the plan via `permission_request` or plain-text `turn_end`, then review it |
| Implementation | `/quest-journey-implementation` | `IMPLEMENTING` | Worker is implementing | Wait for `turn_end`, then spawn skeptic reviewer |
| Skeptic review | `/quest-journey-skeptic-review` | `SKEPTIC_REVIEWING` | Skeptic reviewer is evaluating work integrity and clear quest hygiene | Wait for reviewer ACCEPT; skeptic-review dispatches must explicitly say `Use the installed /skeptic-review workflow for this review.` True zero-code quests with zero git-tracked changes that were explicitly marked `--no-code` may then use `takode board advance-no-groom <quest-id>` instead of entering groom review. |
| Reviewer-groom | `/quest-journey-reviewer-groom` | `GROOM_REVIEWING` | Reviewer owns the quality pass, follow-up judgment, and clear quest hygiene fixes | Wait for reviewer ACCEPT on the worker's response, then send a separate explicit port instruction when ready |
| Porting | `/quest-journey-porting` | `PORTING` | Worker is porting to main repo | Wait for port confirmation, then remove from board |

**Board advances only after completed actions.** Do not advance the board anticipating what will happen next. Only advance after the action for that phase is actually done.

**Update the board immediately.** When a herd event arrives that changes quest state (turn_end, permission_request, etc.), update the board as your FIRST action -- before reviewing content, reading messages, or composing responses. The board must always reflect real-time state.

**Mandatory phases:** Skeptic review and reviewer-groom are mandatory for ALL quests with git-tracked changes -- no exceptions for "small", "trivial", docs-only, skill-only, prompt-only, or template-only changes. The default groom path is reviewer-owned via `/reviewer-groom`. `/self-groom` is an escalation path, not the default. Investigation or other no-code quests may skip reviewer-groom only when they truly produce zero git-tracked changes; first mark the board row with `takode board set <quest-id> --no-code`, then use the explicit board command `takode board advance-no-groom <quest-id>` from `SKEPTIC_REVIEWING`, and complete without porting or fake port noise.

## Phase-Explicit Worker Steering

- **Authorize one phase at a time.** Every leader-to-worker message should say what the worker is allowed to do now and what must wait.
- **Initial dispatch = planning only.** The worker returns a plan and stops. Do not imply implementation is approved.
- **Quest ownership stays with the worker.** The worker doing the job claims and completes the quest. The leader coordinates the journey but does not claim the quest on the worker's behalf.
- **Plan approval = implement, keep one substantive user-oriented quest summary comment current, and stop.** Tell the worker to implement, add or refresh the final quest summary comment for the human reader, report back, and wait. The summary should state what changed, why it matters, and what verification passed; it should not become a review/rework timeline. If the same update also addresses human feedback, tell the worker to consolidate that explanation into the summary instead of adding a near-duplicate second comment. Do not let the worker infer review, porting, or quest transitions.
- **Review/rework = do the named work, refresh that same summary comment, and stop.** If you send reviewer findings, also tell the worker to refresh the user-oriented quest summary comment before reporting back and waiting. When the rework addresses human feedback, one consolidated summary/addressing comment is preferred when it remains clear; separate comments are only for materially different updates or readability. When the rework needs more code changes, tell the worker to commit the current worktree state first and make the follow-up fixes in a separate commit so the reviewer can inspect only the new diff. Do not imply porting is authorized.
- **Porting requires an explicit instruction.** Only tell the worker to run `/port-changes` after the reviewer ACCEPTs and you are ready for porting.
- **Investigation/design/no-code quests still need explicit boundaries.** Tell the worker what artifact to produce, have them stop afterward, and choose the next step yourself. Do not assume the worker should self-complete, self-transition, or self-port.
- **Zero-code quests complete without porting.** If the accepted result is an investigation/report/design artifact with zero git-tracked changes, complete it directly with artifact-focused human-checkable verification items. Do not invent synced SHA lines, automated-check results, or port-summary comments in the checklist. If the accepted result changed docs, skills, prompts, templates, or any other git-tracked file, it is not zero-code for handoff purposes and still needs normal porting plus structured commit metadata. If you use `quest complete ... --no-code`, treat it only as a local CLI reminder switch, not durable quest metadata.

## Refine (before QUEUED)

- If no quest exists or it's in `idea` state, work with the user first to gather requirements
- Ask clarifying questions until the WHAT and WHY are unambiguous
- Before creating a quest or refining an `idea` quest into worker-ready scope, invoke `/quest-design` and wait for user confirmation or correction
- A user-approved plan that explicitly covers the quest text can count as this confirmation; routine feedback, claims, board updates, verification inbox moves, and already-approved lifecycle transitions do not need a separate round
- Create or refine the quest with a clear description containing the full context a worker needs only after that `/quest-design` confirmation round is complete
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
- On approve, send an explicit phase instruction: implement now, then stop and report back. Do not let the worker assume review, `/reviewer-groom`, `/self-groom`, `/port-changes`, or quest transitions are authorized.
- On approve: `takode board advance <quest-id>`

## IMPLEMENTING -> SKEPTIC_REVIEWING

- React to herd events as they arrive -- don't poll
- Steer if needed: scope refinements, corrections, additional context for the current task
- Do NOT send unrelated new tasks to a busy worker -- queue them and wait
- **When the user is directly steering a herded worker**: stay out of it. Resume normal coordination once the user stops interacting
- **Workers must NOT self-advance.** After implementing, the worker reports completion and STOPS. It does not run `/reviewer-groom`, `/self-groom`, `/port-changes`, or `/skeptic-review` on its own. The leader controls phase transitions.
- When `turn_end (✓)` arrives with a quest transition:
  - Run `takode scan <session>` to understand the solution at a high level
  - **Always** spawn a skeptic reviewer (see Skeptic Review below). Skeptic review is mandatory for every quest -- no exceptions, regardless of perceived size or triviality.
  - `takode board advance <quest-id>`

## Skeptic Review

### Spawn Command

```bash
takode spawn --reviewer <session-number> --message-file - <<'EOF'
Load skills first: /takode-orchestration, /quest, /skeptic-review. Use the installed /skeptic-review workflow for this review. Then skeptic review session #X / quest q-Y. Read changes: takode peek X --from N --show-tools
EOF
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

- **This phase is iterative.** Do not advance until the reviewer issues ACCEPT.
- If the reviewer CHALLENGEs: send findings to the worker for rework, then send the reworked result back to the reviewer. Repeat until ACCEPT.
- If you send rework that needs more code changes, tell the worker to commit the current worktree state first, then make the fixes in a separate follow-up commit, refresh the user-oriented quest summary comment, report back, and stop again. If that same update addresses human feedback, the refreshed summary should also explain how it was addressed instead of adding a duplicate comment. Do not imply porting is authorized.
- The skeptic reviewer may directly fix clear quest hygiene issues they know how to fix, such as stale addressed flags, missing/refreshable summaries, or verification checklist checks they personally verified. They must report those hygiene fixes in the ACCEPT/CHALLENGE output.
- Do not send a worker back only for reviewer-fixed hygiene. Do send substantive failures, critical intention mismatches, missing or dishonest work, and ambiguous user-intent questions back through the normal rework loop.
- **True zero-code exception:** if the skeptic reviewer ACCEPTs a quest that produced zero git-tracked changes, mark the board row with `takode board set <quest-id> --no-code` if it is not already marked, then use `takode board advance-no-groom <quest-id>` to complete the board row directly. Unmarked rows and tracked-file-changing quests must continue into `GROOM_REVIEWING`.
- On ACCEPT: send the same reviewer a concise review request, then have the reviewer self-invoke `/reviewer-groom "<scope>"`.
- The best scope strings usually identify the quest, the worker, and the worker message range that contains the follow-up being reviewed.
- Example scope: `Review [q-324](quest:q-324) for reviewer-groom follow-up after worker #469's update in [#469 msg 723](session:469:723) through [#469 msg 746](session:469:746)`.
- `/reviewer-groom` generates the quality report inside the reviewer session and should follow an explicit checklist-driven review flow.
- If `/reviewer-groom` returns any Critical or Recommended findings, send them to the worker and tell the worker to address them, report back, and wait. Do not tell the worker to port yet.
- If `/reviewer-groom` returns no Critical or Recommended findings, treat that as groom acceptance and continue to the next phase.
- `takode board advance <quest-id>`

## GROOM_REVIEWING -> PORTING

- Wait for the worker to report back what they changed in response to the reviewer-groom findings (or why they skipped a suggestion).
- **ALWAYS** send the worker's response back to the same reviewer for compliance check. The reviewer verifies that no important Critical or Recommended suggestion was skipped without justification.
- **This phase is iterative.** Do not advance until the reviewer ACCEPTs.
- If CHALLENGE: send findings back to the worker, have them address the issues, then re-send to reviewer. Repeat until ACCEPT.
- The reviewer may directly fix clear quest hygiene they can verify and safely perform with Quest CLI commands. Treat reported hygiene fixes as part of the review result; do not bounce those bookkeeping-only items back to the worker.
- Keep escalating ambiguity and substantive problems. A reviewer-owned hygiene fix is not a substitute for worker rework when the code, intent, or evidence is wrong or unclear.
- Keep the worker waiting while the reviewer checks compliance. If more changes are needed and they require code edits, tell the worker to checkpoint the current worktree state in a commit before starting the fixes, then make the follow-up changes separately and stop again afterward.
- On reviewer ACCEPT: tell the worker to port changes using `/port-changes`. Porting must be a separate, explicit instruction, and the worker's report-back must include `Synced SHAs: sha1,sha2` with the ordered synced SHAs from the main repo.
- `takode board advance <quest-id>`
- **NEVER combine "reviewer-groom/rework" and "port" in the same instruction to the worker.** Each is a separate gate.

## PORTING -> (removed)

- Tell the worker to run `/port-changes` only when you are explicitly ready for porting. Do not assume they will self-port once review is done.
- Zero-code quests do not enter `PORTING`. After the accepted artifact is ready, complete them directly with human-checkable verification items about the artifact/result and without `/port-changes`, synced SHAs, automated-check results, or port-summary noise in the checklist. This applies only when the quest produced zero git-tracked changes; docs, skills, prompts, templates, and other text-only tracked-file edits must still be ported and attached with `quest complete ... --commit/--commits`. On the board, that means explicitly marking the row with `takode board set <quest-id> --no-code` and then using `takode board advance-no-groom <quest-id>` from `SKEPTIC_REVIEWING` rather than advancing into `GROOM_REVIEWING` or `PORTING`. If you pass `--no-code`, use it only to suppress the local CLI's port reminder noise.
- Wait for the worker to confirm sync is complete (commits landed, required post-port verification passed, pushed to remote) **and include the ordered synced SHAs from the main repo as a dedicated `Synced SHAs: sha1,sha2` line**
- For refactor quests, the required post-port verification gate is `cd web && bun run typecheck`, `cd web && bun run test`, and `cd web && bun run format:check`. `format:check` is the current lint/format-equivalent gate in this repo; there is no separate `lint` script right now. If a full run is infeasible, the exception must be documented explicitly in the worker's report-back.
- If the required post-port verification run fails, dispatch a suitable worker to fix `main` immediately rather than waiting for the human to notice or ask.
- Only after port is confirmed: transition the quest to `needs_verification` and attach those SHAs explicitly with `quest complete q-N --items "..." --commits "sha1,sha2"`. Structured commit metadata should carry routine port information; add a second prose port comment only when something exceptional about the port is materially worth noting.
- `takode board advance <quest-id>` -- this removes the row from the board
- Do **not** run `takode notify review` for quest completion -- when the work board item is completed, Takode already fires the review notification automatically. Sending another one duplicates the quest-completion notification.

## Feedback Rework Loop

When new human feedback lands on a quest:

1. **Record the feedback**: `quest feedback <id> --text "..." --author human` for short notes, or `quest feedback <id> --text-file - --author human` when recording copied logs or shell-like text (attach screenshots with `--image <path>`)
2. **Decide whether the quest status itself must move backward**:
   - If the quest is currently in `needs_verification` or `done`, run `quest transition <id> --status refined` first. Those statuses describe a completed review handoff, so the quest itself must re-open before the fresh cycle begins.
   - If the quest is already active (`refined` or `in_progress`), do **not** transition it backward just because new feedback arrived. The quest is already open; the coordination fix is to reset the board row, not to create another status transition.
3. **Reset the board row to match the fresh cycle**: if the quest is still on the board, immediately move it back to the earliest valid phase for the new scope. Usually that means `takode board set <quest-id> --worker <N> --status PLANNING` when the same worker should re-plan, or `takode board set <quest-id> --status QUEUED` when ownership needs to be reconsidered.
4. **Treat the new human feedback as the source of truth**: any stale in-flight review ACCEPT, stale port confirmation, or delayed worker completion from the older scope becomes non-advancing context. Inspect it if useful, but do not let it move the quest forward after the reset.
5. **Dispatch for full quest journey from that reset point**: treat the rework as a fresh cycle. The quest goes through PLANNING -> IMPLEMENTING -> SKEPTIC_REVIEWING -> GROOM_REVIEWING -> PORTING again from the reset phase, ensuring rework gets the same review rigor as the original implementation. Never skip review steps for "small" feedback fixes.
6. **Prefer the original worker** if still available -- it has the most context from the first implementation. Check `takode list` for idle/disconnected workers with matching quest history.
7. **Use the rework dispatch template** from `/leader-dispatch`, which explicitly tells the worker to check and address feedback and return a fresh plan before implementing.
8. **The worker must mark each feedback entry as addressed**: `quest address <id> <index>` after fixing each item. This is a hard requirement -- the leader should verify via `quest feedback list <id> --author human --unaddressed` that no unaddressed entries remain before accepting the rework. Also verify with `quest feedback latest <id> --author agent --full` that the worker did not leave a trail of duplicated or overly similar comments; one consolidated summary/addressing comment is preferred when it clearly covers the fix and the human feedback.
9. **If the old-scope worker is still actively generating, interrupt before re-steering.** After resetting the board for fresh human feedback, use `takode interrupt <N>` before sending the new planning/rework instruction. A normal queued correction can arrive too late and let stale old-scope work keep running.

This loop can repeat multiple times. Each round is a full quest journey.
