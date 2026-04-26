# Quest Journey Lifecycle

Every dispatched task follows a **Quest Journey** assembled from built-in phases. The work board (`takode board show`) tracks the current phase, remaining phases, and next required leader action.

The active planned Journey is board-owned state associated with the quest while that quest is on the board. Quest creation or refinement defines the quest text; it does not freeze the active Journey.

`QUEUED` is a board state, not a phase. Once active, leaders choose the phase sequence that matches the risk boundary and evidence needed next.

Before the first dispatch, leaders should use `/leader-dispatch` to propose the planned initial Journey and get approval. The worker planning phase then refines execution inside that approved Journey and may recommend revisions; it is not the first time phases are proposed.

## Built-In Phase Library

| Phase | Skill | Board state | Contract | Next action |
|-------|-------|-------------|----------|-------------|
| Planning | `/quest-journey-planning` | `PLANNING` | Align goal, constraints, success criteria, escalation triggers, and next-phase plan | Review the plan, then approve, reject, or revise |
| Explore | `/quest-journey-explore` | `EXPLORING` | Gather unknown information without making the target-state change | Read the evidence summary, then choose the next phase |
| Implement | `/quest-journey-implement` | `IMPLEMENTING` | Make approved code/docs/prompts/config/artifact changes and low-risk local actions | Wait for the worker report, then choose the next review or bookkeeping phase |
| Code Review | `/quest-journey-code-review` | `CODE_REVIEWING` | Review tracked code/artifact correctness, maintainability, tests, security, and regression risk | Wait for reviewer acceptance or findings |
| Mental Simulation | `/quest-journey-mental-simulation` | `MENTAL_SIMULATING` | Replay a design/workflow/implementation against concrete scenarios | Read the scenario review, then accept or revise |
| Execute | `/quest-journey-execute` | `EXECUTING` | Run high-stakes, long-running, costly, or externally consequential operations | Monitor until the execution report is ready |
| Outcome Review | `/quest-journey-outcome-review` | `OUTCOME_REVIEWING` | Judge external/non-code outcomes such as metrics, logs, artifacts, prompt behavior, or UX trial notes | Read the outcome review, then accept, revise, or rework |
| Bookkeeping | `/quest-journey-bookkeeping` | `BOOKKEEPING` | Record durable shared external state such as quest updates, stream updates, artifact locations, handoff facts, and superseded facts | Advance once the shared state is current |
| Port | `/quest-journey-port` | `PORTING` | Sync accepted tracked changes back to the main repo | Wait for sync confirmation and post-port verification |

## Default Preset

The default built-in tracked-code Journey is:

`planning -> implement -> code-review -> port`

This preserves a small normal path for common repo work while allowing leaders to choose richer review or operations paths when the quest needs them.

Examples:

- Straight tracked-code work: `planning -> implement -> code-review -> port`
- Investigation before action: `planning -> explore -> execute -> outcome-review`
- Design validation: `planning -> implement -> mental-simulation -> outcome-review`
- Hybrid code plus external validation: `planning -> implement -> outcome-review -> code-review -> port`

## Journey Revision

Leaders may revise the remaining Journey when risk, evidence needs, external-state impact, user steering, or the next action changes.

Use:

```bash
takode board set q-12 --phases implement,outcome-review,code-review,port \
  --preset cli-rollout \
  --revise-reason "Need real CLI behavior evidence before final code review"
```

Rules:

- Revising an active Journey requires `--revise-reason`.
- When revising an active row without changing `--status`, include the current phase in `--phases`.
- If the active boundary itself changes, set an explicit `--status` that matches the revised phase plan.
- `takode board advance` always follows the row's planned phases, not a hard-coded global order.

## Phase-Explicit Worker Steering

- **Authorize one phase at a time.**
- **Initial Journey approval happens before dispatch.** Use `/leader-dispatch` to propose the starting phases and wait for approval.
- **Initial dispatch = planning only.**
- **Quest ownership stays with the worker.**
- **Worker planning refines a leader-approved Journey.** It may recommend revisions, but the board-owned Journey remains authoritative until the leader changes it.
- **Plan approval authorizes exactly one next phase.** For example: implement now, then stop and report back.
- **Workers must stop at phase boundaries.** They do not self-review, self-port, or self-transition.
- **Porting requires an explicit instruction.**

## Review Phases

Use the review phase that matches the evidence you need:

- **`code-review`** for tracked code/artifact quality and landing risk.
- **`mental-simulation`** for scenario-driven workflow or design replay.
- **`outcome-review`** for external behavior, metrics, artifacts, or operational outcomes.

Do not default to a generic skeptic-review framing for new work. Legacy board rows or saved phrases may still mention `skeptic-review`, `reviewer-groom`, or `stream-update`; treat those as compatibility aliases rather than the preferred vocabulary.

## Zero-Tracked-Change Journeys

Zero-tracked-change quests use the same phase-based Journey model as any other quest. Do not use a separate board flag or shortcut command.

Choose explicit phases that match the evidence you need and simply omit `port` when nothing will be synced. Examples:

- `planning -> explore -> outcome-review`
- `planning -> explore -> bookkeeping`
- `planning -> mental-simulation -> outcome-review`

Advancing from the final planned phase removes the row from the board. Git-tracked docs, skills, prompts, templates, and other text-only edits still count as tracked-change work and should include `port`.

## Feedback Rework Loop

When new human feedback lands:

1. Record the feedback on the quest.
2. Re-open the quest if it was already in `needs_verification` or `done`.
3. Reset the board row to the earliest valid phase for the new scope.
4. Treat the new feedback as the source of truth.
5. Run a fresh Journey from that reset point.

Fresh human feedback outranks stale old-scope review or port completions.
