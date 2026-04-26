# Quest Journey Lifecycle

Every dispatched task follows a **Quest Journey** assembled from built-in phases. The work board (`takode board show`) tracks the current phase, remaining phases, and next required leader action.

The active planned Journey is board-owned state associated with the quest while that quest is on the board. Quest creation or refinement defines the quest text; it does not freeze the active Journey.

`QUEUED` is a board state, not a phase. Once active, leaders choose the phase sequence that matches the risk boundary and evidence needed next.

Before the first dispatch, leaders should use `/leader-dispatch` to propose the planned initial Journey and get approval. The worker planning phase then refines execution inside that approved Journey and may recommend revisions; it is not the first time phases are proposed. After the worker returns a plan, the leader normally approves it and advances without a routine second user-approval round. Escalate back to the user only for significant ambiguity, scope change, Journey revision, user-visible tradeoff, or another real blocking issue.

## Built-In Phase Library

Built-in phase directories are seeded into `~/.companion/quest-journey-phases/<phase-id>/` with:
- `phase.json`: semantic/runtime metadata such as board state, aliases, role, contract, and next leader action
- `leader.md`: the leader-facing brief for that phase
- `assignee.md`: the brief the leader should point the worker or reviewer to for that phase

Leaders should read `leader.md` themselves and point the target session to the matching `assignee.md`. Do not rely on globally installed phase skills as the primary mechanism.

| Phase | Board state | Leader brief | Assignee brief | Contract | Next leader action |
|-------|-------------|--------------|----------------|----------|--------------------|
| Planning | `PLANNING` | `planning/leader.md` | `planning/assignee.md` | Align goal, constraints, success criteria, escalation triggers, and next-phase plan | read the planning leader brief, send the planning-only instruction, then review the worker plan for leader approval or necessary user escalation |
| Explore | `EXPLORING` | `explore/leader.md` | `explore/assignee.md` | Gather unknown information without making the target-state change | read the explore leader brief, then wait for the evidence summary and decide whether to revise the Journey or advance |
| Implement | `IMPLEMENTING` | `implement/leader.md` | `implement/assignee.md` | Make approved code/docs/prompts/config/artifact changes and low-risk local actions | read the implement leader brief, then wait for the worker report and choose the next review or bookkeeping phase |
| Code Review | `CODE_REVIEWING` | `code-review/leader.md` | `code-review/assignee.md` | Review tracked code or tracked artifacts for correctness, maintainability, tests, security, and regression risk | read the code-review leader brief, then wait for the reviewer result and either send rework or advance |
| Mental Simulation | `MENTAL_SIMULATING` | `mental-simulation/leader.md` | `mental-simulation/assignee.md` | Replay a design, workflow, or implementation against concrete scenarios | read the mental-simulation leader brief, then wait for the scenario review and decide whether the Journey needs revision |
| Execute | `EXECUTING` | `execute/leader.md` | `execute/assignee.md` | Run high-stakes, long-running, costly, or externally consequential operations | read the execute leader brief, track monitor and stop conditions, then wait for the execution report before advancing |
| Outcome Review | `OUTCOME_REVIEWING` | `outcome-review/leader.md` | `outcome-review/assignee.md` | Judge external or non-code outcomes such as metrics, logs, artifacts, prompt behavior, or UX trial notes | read the outcome-review leader brief, then wait for external-result evidence and decide whether to continue, revise, or conclude |
| Bookkeeping | `BOOKKEEPING` | `bookkeeping/leader.md` | `bookkeeping/assignee.md` | Record durable shared external state such as quest updates, stream updates, artifact locations, handoff facts, and superseded facts | read the bookkeeping leader brief, record the durable shared state update, then advance when the facts and handoff state are current |
| Port | `PORTING` | `port/leader.md` | `port/assignee.md` | Sync accepted tracked changes back to the main repo | read the port leader brief, then wait for sync confirmation and post-port verification before removing the row |

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
- **Read `leader.md`; point assignees to `assignee.md`.** Do not treat globally installed phase skills as the primary phase mechanism.
- **Initial dispatch = planning only.**
- **Quest ownership stays with the worker.**
- **Worker planning refines a leader-approved Journey.** It may recommend revisions, but the board-owned Journey remains authoritative until the leader changes it.
- **Planning approval is leader-owned by default.** Once the user has approved the initial Journey plus scheduling plan, the leader normally approves the returned worker plan and dispatches the next phase.
- **Escalate planning back to the user only for real blockers.** Significant ambiguity, scope change, Journey revision, user-visible tradeoff, or another blocking issue can require fresh user approval.
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
