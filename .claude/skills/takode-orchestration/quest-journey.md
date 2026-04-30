# Quest Journey Lifecycle

Every dispatched task follows a **Quest Journey** assembled from built-in phases. The work board (`takode board show`) tracks proposed pre-dispatch Journeys, active current phases, remaining phases, numbered Journey paths, indexed phase notes, and next required leader action.

The planned Journey is board-owned state associated with the quest while that quest is on the board. Quest creation or refinement defines the quest text; it does not freeze either the proposed draft or the active Journey.

When assembling a Journey, ask what each extra phase contributes over merging that work into a later phase. The normal tracked-code path intentionally keeps common work small: `implement` includes the normal investigation, root-cause analysis, code/design reading, and test planning needed to complete approved fixes, docs changes, config changes, prompt changes, and artifact changes. Do not add `explore` before `implement` merely so a worker can look around.

Board-side Journey modes:

- `proposed`: pre-dispatch draft, no worker required yet, no active/current phase semantics yet
- `active`: approved execution Journey, with progress tracked by phase position/index

`PROPOSED` and `QUEUED` are board states, not phases. Once active, leaders choose the phase sequence that matches the risk boundary and evidence needed next. Repeated phases are allowed, so progress is tracked by active phase occurrence rather than assuming each phase name appears only once.

Before the first dispatch, leaders should use `/leader-dispatch` to propose the planned initial Journey and scheduling approach, then get approval. When the user clearly wants quest creation plus dispatch and the scope is understood, combine this with `/quest-design`: describe the proposed quest draft and proposed Journey/scheduling plan naturally in prose so one confirmation can approve both. After approval, write the approved Journey to the board before or with dispatch using `takode board set --worker ... --phases ...` or by promoting an existing proposed row. If clarification is needed, ask it with quest framing; after the user clarifies and no major ambiguity remains, the next response should include both drafts together. Avoid a separate restated-understanding-only round. The worker alignment phase then returns a lightweight read-in inside that approved Journey and may surface facts that justify a leader-owned Journey revision; it is not the first time phases are proposed. After the worker returns that read-in, the leader normally approves the next phase and advances without a routine second user-approval round. Escalate back to the user only for significant ambiguity, scope change, Journey revision, user-visible tradeoff, or another real blocking issue.

## Built-In Phase Library

Built-in phase directories are seeded into `~/.companion/quest-journey-phases/<phase-id>/` with:
- `phase.json`: semantic/runtime metadata such as board state, aliases, role, contract, and next leader action
- `leader.md`: the leader-facing brief for that phase
- `assignee.md`: the brief the leader should point the worker or reviewer to for that phase

Use `takode phases` to list available phase metadata and exact brief paths. Leaders should read the exact `leader.md` path themselves and point the target session to the matching exact `assignee.md` path. Do not rely on globally installed phase skills as the primary mechanism.

| Phase | Board state | Leader brief | Assignee brief | Contract | Next leader action |
|-------|-------------|--------------|----------------|----------|--------------------|
| Alignment | `PLANNING` | `~/.companion/quest-journey-phases/alignment/leader.md` | `~/.companion/quest-journey-phases/alignment/assignee.md` | Do a lightweight read-in to confirm concrete understanding, ambiguities, clarification questions, and whether deeper exploration is needed before implementation or execution | read the alignment leader brief, send the alignment-only instruction, then review the worker read-in for leader approval, routing, or necessary user escalation |
| Explore | `EXPLORING` | `~/.companion/quest-journey-phases/explore/leader.md` | `~/.companion/quest-journey-phases/explore/assignee.md` | Investigate when the investigation is the deliverable or when routing is genuinely unknown; do not use Explore as routine pre-implementation looking around for normal bug-fix, docs, or config work | read the explore leader brief, then wait for the findings summary and decide whether to revise the Journey, advance, add a user-checkpoint, or stop |
| Implement | `IMPLEMENTING` | `~/.companion/quest-journey-phases/implement/leader.md` | `~/.companion/quest-journey-phases/implement/assignee.md` | Make approved code, docs, prompts, config, or artifact changes; this includes normal investigation, root-cause analysis, code/design reading, test planning, and cheap local evidence within the approved scope | read the implement leader brief, then wait for the worker report and choose the next review, execute, or bookkeeping phase |
| Code Review | `CODE_REVIEWING` | `~/.companion/quest-journey-phases/code-review/leader.md` | `~/.companion/quest-journey-phases/code-review/assignee.md` | Review tracked code or tracked artifacts for comprehensive landing risk: correctness, regressions, tests, maintainability, quest hygiene, implementation completeness, meaningful evidence, and security when relevant | read the code-review leader brief, then wait for the reviewer result and either send rework or advance |
| Mental Simulation | `MENTAL_SIMULATING` | `~/.companion/quest-journey-phases/mental-simulation/leader.md` | `~/.companion/quest-journey-phases/mental-simulation/assignee.md` | Replay a design, workflow, or implementation against concrete scenarios | read the mental-simulation leader brief, then wait for the scenario review and decide whether the Journey needs revision |
| Execute | `EXECUTING` | `~/.companion/quest-journey-phases/execute/leader.md` | `~/.companion/quest-journey-phases/execute/assignee.md` | Run approved expensive, risky, long-running, externally consequential, or approval-gated operations | read the execute leader brief, track monitor and stop conditions, then wait for the execution report and decide whether outcome review, more execute work, or a Journey revision is needed |
| Outcome Review | `OUTCOME_REVIEWING` | `~/.companion/quest-journey-phases/outcome-review/leader.md` | `~/.companion/quest-journey-phases/outcome-review/assignee.md` | Reviewer-owned acceptance judgment over external or non-code outcomes such as metrics, logs, artifacts, prompt behavior, or UX trial notes | read the outcome-review leader brief, then wait for the reviewer judgment and route to implement, execute, alignment, or conclusion |
| User Checkpoint | `USER_CHECKPOINTING` | `~/.companion/quest-journey-phases/user-checkpoint/leader.md` | `~/.companion/quest-journey-phases/user-checkpoint/assignee.md` | Present findings, options, tradeoffs, and a recommendation for a required user decision before the Journey continues; do not treat this as a terminal phase or a generic TBD bucket | read the user-checkpoint leader brief, publish the decision prompt, notify the user, wait for the answer, then revise the remaining Journey |
| Bookkeeping | `BOOKKEEPING` | `~/.companion/quest-journey-phases/bookkeeping/leader.md` | `~/.companion/quest-journey-phases/bookkeeping/assignee.md` | Record durable shared external state such as quest updates, stream updates, artifact locations, handoff facts, and superseded facts | read the bookkeeping leader brief, record the durable shared state update, then advance when the facts and handoff state are current |
| Port | `PORTING` | `~/.companion/quest-journey-phases/port/leader.md` | `~/.companion/quest-journey-phases/port/assignee.md` | Sync accepted tracked changes back to the main repo | read the port leader brief, then wait for sync confirmation and post-port verification before removing the row |

## Phase Documentation Contract

Each active phase should leave durable quest documentation before the leader treats the phase as complete. The actor for the phase writes the full entry for future agents first, then derives TLDR metadata for human scanning.

When documenting repository files, use Takode custom file links such as `[QuestDetailPanel.tsx:42](file:web/src/components/QuestDetailPanel.tsx:42)` instead of plain paths. Standard Markdown file links to repo files are a best-effort clickable fallback in Questmaster, but custom `file:` links remain preferred because they carry richer location metadata.

Prefer the q-991 phase-scoped feedback primitive with current-phase inference:

```bash
quest feedback add q-N --text-file /tmp/phase.md --tldr-file /tmp/phase-tldr.md --kind phase-summary
```

Use `--kind phase-finding` for exploration findings, `--kind review` for review phases, or `--kind artifact` for execution artifacts when that better describes the entry. If inference is unavailable or ambiguous, use explicit flags such as `--phase`, `--phase-position`, `--phase-occurrence`, `--phase-occurrence-id`, or `--journey-run`. Use `--no-phase` only when a flat unscoped quest comment is intentional, such as non-Journey bookkeeping or legacy quest compatibility.

Apply a value filter to phase documentation: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases. If the actor's context was compacted during the phase, or if memory confidence is low, they should reconstruct relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, they should use working memory and current artifacts instead of unnecessary session archaeology.

For valuable nontrivial phase outcomes, the assignee may run `takode worker-stream` once the substantive result is ready so the leader can start reading while required paperwork finishes. Treat worker-stream output as an early internal checkpoint only: it is optional, not mandatory ceremony, and it does not replace phase documentation, final debrief metadata, or leader-owned phase transitions.

Phase documentation should stay specific to the phase:
- Alignment: concrete understanding, ambiguities, clarification questions, blockers, surprises, and Journey-revision evidence.
- Explore: findings, evidence sources, ambiguities or blockers, implementation considerations, and Journey-revision evidence.
- Implement: changed files or artifacts, rationale, verification, remaining risks, and addressed feedback.
- Code Review: review scope, aspects covered, evidence checked, findings or ACCEPT rationale, and documentation hygiene judgment.
- Mental Simulation: scenarios replayed, concrete examples, risks, recommendations, and confidence limits.
- Execute: approved action, monitors, stop conditions, outcome, deviations, artifacts or logs, and follow-up needs.
- Outcome Review: evidence judged, acceptance or insufficiency rationale, bounded reruns, and follow-up routing.
- User Checkpoint: findings, options, tradeoffs, recommendation, required user answer, and Journey-revision implications.
- Bookkeeping: cross-phase or external durable state beyond normal phase notes, such as records updated, consolidated summaries, final debrief metadata after port when the port worker could not reliably create it, verification checklist reconciliation, superseded facts, external locations, notification/thread cleanup, and durable handoff facts.
- Port: ordered synced SHAs, post-port verification, port anomalies, remaining sync risks, and final debrief metadata status or draft.

Review phases must judge documentation quality, not just presence. Check phase relevance, useful full detail, TLDR completeness where appropriate, and correct phase association when the phase-scoped primitive is available.

## Recommended Default

The recommended built-in tracked-code Journey is:

`alignment -> implement -> code-review -> port`

This preserves a small normal path for common repo work while allowing leaders to choose richer review or operations paths when the quest needs them. It is a default, not a mandate: user overrides win. If the user asks to skip `code-review`, `port`, or another standard phase, follow that instruction or briefly confirm the tradeoff instead of refusing because the phase is standard.

Omit notes for standard phases by default: `alignment`, `implement`, `code-review`, and `port` are self-explanatory unless the user or quest adds unusual phase-specific work. Add concise notes for non-standard phases such as `explore`, `user-checkpoint`, `execute`, `outcome-review`, `mental-simulation`, or `bookkeeping`; state why the phase is needed and what evidence, user decision, scenario, outcome, or durable state it covers. For every extra phase, ask what it contributes over merging the same work into a later phase.

## Approval and Board Workflow

Use natural prose as the normal approval surface. Once the user approves, make the Journey durable on the board before or with dispatch:

```bash
takode board set q-12 --worker 5 --phases alignment,implement,code-review,port --preset full-code
```

- `takode board set --worker ... --phases ...` creates the active board row in one step after prose approval
- `takode board propose` remains available to create or revise a board-owned draft when the quest already exists and a draft row helps coordination
- prefer `takode board propose --spec-file` for complete proposal drafts with phases, concise non-standard notes, and scheduling metadata
- `takode board note` remains available for targeted note edits, but each draft mutation makes any previous presentation stale
- `takode board present` creates an optional user-facing approval artifact from the current draft
- `takode board promote` reuses a proposed Journey object for execution after approval; a separate presentation step is no longer required
- approval-hold rows should use `PROPOSED` plus `--wait-for-input`, not a fake generic queue dependency

Examples:

- Straight tracked-code work: `alignment -> implement -> code-review -> port`
- Expensive or approval-gated run: `alignment -> explore -> execute -> outcome-review`
- Findings that require user steering: `alignment -> explore -> user-checkpoint -> implement -> code-review -> port`
- Design or workflow validation: `alignment -> implement -> mental-simulation -> code-review -> port`
- Cheap local evidence followed by acceptance review: `alignment -> implement -> outcome-review -> code-review -> port`

## Journey Revision

Leaders may revise the remaining Journey when risk, evidence needs, external-state impact, user steering, or the next action changes.

Use:

```bash
takode board set q-12 --phases implement,outcome-review,code-review,port \
  --preset cli-rollout
```

Rules:

- Already completed phase occurrences are historical and cannot be revised in place.
- Keep completed prefix positions unchanged; append a later repeated phase when requirements change after a phase has run.
- Proposed rows with no executed phases can be revised freely.
- When revising an active row without changing `--status`, include the current phase in `--phases`.
- Repeated phases are first-class. Insert or append them directly instead of pretending the Journey reset to an earlier abstract state.
- Indexed phase notes rebase by phase occurrence, not raw index. If the same occurrence still exists after a phase-list revision, the note follows it even when its position shifts.
- If a revision removes the intended occurrence, `takode board set` / `takode board propose` warns about the dropped note so the leader can reattach or rewrite it deliberately.
- Repeated active phases are tracked by occurrence index, not just by `currentPhaseId`. When a repeated phase is active and `--status` alone would be ambiguous, set `--active-phase-position` so the board row and UI point at the correct occurrence.
- If the active boundary itself changes, set an explicit `--status` that matches the revised phase plan.
- `takode board advance` always follows the row's planned phases, not a hard-coded global order.

## Phase-Explicit Worker Steering

- **Authorize one phase at a time.**
- **Initial Journey approval happens before dispatch.** Use `/leader-dispatch` to get approval for the proposed Journey and scheduling plan, then put the approved Journey on the board before or with dispatch.
- **Read the exact leader brief; point assignees to the exact assignee brief.** Use `takode phases` when you need the paths. Do not treat globally installed phase skills as the primary phase mechanism.
- **Initial dispatch = alignment only.**
- **Promote the same board-drafted Journey after approval when a proposed row exists.** Otherwise, create the active row directly with the approved phase list. Do not let recovery depend only on transcript prose.
- **Quest ownership stays with the worker.**
- **Worker alignment returns a lightweight read-in inside a leader-approved Journey.** It may surface blockers, surprises, and evidence that justify leader-owned Journey revision, but the board-owned Journey remains authoritative until the leader changes it.
- **Point alignment at exact sources when you already know them.** When the relevant prior messages, quests, or discussions are known, point the worker to those specific sources so alignment can use targeted Takode or quest inspection instead of broad exploration.
- **Alignment approval is leader-owned by default.** Once the user has approved the initial Journey plus scheduling plan, the leader normally approves the returned worker read-in and dispatches the next phase.
- **Escalate alignment back to the user only for real blockers.** Significant ambiguity, scope change, Journey revision, user-visible tradeoff, or another blocking issue can require fresh user approval.
- **Alignment approval authorizes exactly one next phase.** For example: explore now, then stop and report back.
- **Use `user-checkpoint` for explicit user participation.** Present findings, options, tradeoffs, and a recommendation; notify the user and wait; then revise the remaining Journey after the user answers. Do not use it as terminal closure, generic TBD, or optional leader-only indecision.
- **Workers and reviewers document, report, then stop at phase boundaries.** They do not self-review, self-port, self-transition, or self-complete unless explicitly instructed.
- **Porting requires an explicit instruction.** Port must also settle final debrief ownership: completion by the port worker for a nontrivial quest should use `--debrief-file` and `--debrief-tldr-file`; leader-controlled completion needs a `Final debrief draft:` plus `Debrief TLDR draft:` or a focused Bookkeeping phase if Port cannot reliably produce them.

## Review Phases

Use the review phase that matches the evidence you need:

- **`code-review`** for tracked code/artifact quality and landing risk.
- **`mental-simulation`** for scenario-driven workflow, design, or responsibility-split replay.
- **`outcome-review`** for reviewer-owned acceptance over external behavior, metrics, artifacts, prompt behavior, or operational outcomes that already exist.
- **`execute`** when more evidence requires expensive, risky, long-running, externally consequential, or approval-gated runs rather than a reviewer acceptance pass.

Guidance:

- Use **`mental-simulation`** when the question is whether a design or workflow makes sense under replayed scenarios. This is about plausibility and failure modes, not externally executed sufficiency.
- Use **`outcome-review`** when the worker has usually already produced the evidence and a reviewer should decide whether that evidence is sufficient. The reviewer may do only small bounded reruns or repros needed for acceptance.
- Use **`execute`** when the worker needs more than cheap local evidence gathering and the next step is an approved run with monitors, stop conditions, risk controls, or external consequences.
- If outcome evidence is insufficient, route back deliberately: **`implement`** when behavior or code must change, **`execute`** when more approved runs are needed, and **`alignment`** when success criteria, scope, or experiment design changed.

Do not default to a generic skeptic-review framing for new work. Legacy board rows or saved phrases may still mention `skeptic-review`, `reviewer-groom`, or `stream-update`; treat those as compatibility aliases rather than the preferred vocabulary.

## Zero-Tracked-Change Journeys

Zero-tracked-change quests use the same phase-based Journey model as any other quest. Do not use a separate board flag or shortcut command.

Choose explicit phases that match the evidence you need and simply omit `port` when nothing will be synced. Examples:

- `alignment -> explore -> outcome-review`
- `alignment -> explore -> bookkeeping`
- `alignment -> mental-simulation`

Advancing from the final planned phase removes the row from the board. Git-tracked docs, skills, prompts, templates, and other text-only edits still count as tracked-change work and should include `port`.

## Feedback Rework Loop

When new human feedback lands:

0. First check whether the feedback likely belongs to the current quest. Same-thread feedback usually does, but users may occasionally post new-quest or unrelated feature feedback in the wrong thread. If the message appears separate or cross-cutting, ask or propose the split before changing the current quest; after the new quest exists, attach the relevant messages/images there.
1. Record the feedback on the quest.
2. Re-open the quest if it was already in `needs_verification` or `done`.
3. Reset the board row to the earliest valid phase for the new scope.
4. Treat the new feedback as the source of truth.
5. Run a fresh Journey from that reset point.

Fresh human feedback outranks stale old-scope review or port completions.
