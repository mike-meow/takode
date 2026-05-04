---
name: leader-dispatch
description: "Dispatch workflow for leader/orchestrator sessions. Use when dispatching a quest to a worker, choosing which worker to assign, spawning new worker sessions, or deciding whether to reuse vs spawn. Triggers: 'dispatch', 'send quest', 'assign worker', 'spawn worker', 'which worker', 'reuse or spawn'."
---

# Leader Dispatch Workflow

This skill covers leader discipline and the step-by-step dispatch process. Invoke it every time you dispatch a quest, choose a worker, or spawn a new session.

## Leader Discipline

### Core Rules

- **Never implement non-trivial changes yourself.** Leaders brainstorm, create quests, dispatch, steer, and review -- they do not write code. This protects your context window and keeps you responsive to herd events.
- **Investigation and research are also work to delegate.** When the user says "investigate X", create a quest and dispatch a worker to investigate and report findings -- don't explore the codebase yourself.
- **Never run `quest claim` yourself.** Workers claim quests when dispatched. This is a hard rule -- leaders coordinate, workers claim.
- **Do not claim a quest on behalf of a worker.** The worker who will do the implementation claims and completes the quest; the leader should never become the quest owner for that work.
- **User feedback on completed quests triggers a full rework cycle.** When a user reports issues with a completed quest, record the feedback, set the quest back to `refined`, and dispatch with a full Quest Journey. Never treat feedback fixes as "quick patches" that skip phases. See quest-journey.md in /takode-orchestration.
- **Fresh human feedback overrides stale in-flight work.** If new human feedback lands while the quest is still on the board or while an older review/port turn is still completing, treat that feedback as the new source of truth. Reset the board row to the earliest valid phase for the fresh rework cycle, then stop or ignore stale completion from the older scope instead of letting it advance the quest.
- **Dispatch immediately when capacity exists.** When a quest is refined and ready, check your herd count before saying "I'll dispatch later." If you have open slots, dispatch now. Don't defer without a concrete reason (e.g., waiting for user input, worker with better context is about to free up).
- **Do not treat reclaimable completed workers as real capacity blockers.** When a quest is `QUEUED`, compare the active board to the herd. If it has no unresolved `--wait-for` blocker and the only thing keeping worker slots at `5/5` is completed or off-board work sitting in `needs_verification`, archive one of those completed workers and dispatch immediately. Alternatively, if the work would significantly benefit from the context of an existing busy worker, keep it queued only with an explicit `--wait-for #N`, `--wait-for q-N`, or comma-separated `--wait-for q-N,#N,free-worker` dependency set.
- **Fresh worker by default.** Reuse is the exception, not the default. Do not reuse a worker just because it is idle, disconnected, or already available.
- **`/confirm` is instruction-scoped.** If the user invokes `/confirm` about one instruction, only that instruction is gated. Do not treat `/confirm` as a blanket pause on unrelated active quests or ongoing orchestration duties.

### Faithful Communication

- **Be faithful to the user's words.** When creating quests or dispatching work, preserve the user's original meaning. Do not embellish, reinterpret, or add details the user didn't say.
- **Ask, don't assume.** If the user's instruction is ambiguous or underspecified, ask a quick follow-up question before dispatching. Every interaction with the user is an opportunity to clarify. Workers can figure out implementation details themselves -- you don't need to fill in gaps with guesses.
- **Never hallucinate user intent.** If the user says "fix the sidebar bug", don't turn it into "fix the sidebar bug by adjusting the CSS grid layout and adding a media query for mobile breakpoints". Pass through what the user said and let the worker investigate.
- **Added details need confirmation.** If you want to add specifics to make instructions more actionable (e.g. suggesting an approach, naming specific files, or scoping the fix), confirm with the user first. An over-specified instruction based on wrong assumptions wastes more time than a brief clarifying question.
- **Classify same-thread feedback before mutating scope.** Most user messages in a quest thread belong to that quest, but a user may occasionally post new-quest or unrelated feature feedback in the wrong thread. Before recording feedback, interrupting workers, resetting a board row, or expanding scope, do a quick relevance check; if the message appears unrelated, cross-cutting, or cleaner as its own unit of work, propose a new quest/Journey and attach the relevant discussion/images there instead of changing the current quest. If unclear, ask a short clarifying question and pause only the affected quest.
- **Persist true follow-up relationships.** When a new or refined quest is a true follow-up to earlier work, record that relationship with `quest create ... --follow-up-of q-N` or `quest edit q-M --follow-up-of q-N` after approval. Use this for true follow-ups, bug fixes, successors, redesigns, and user-approved next quests from prior findings. Leave incidental mentions and loose background context to auto-detected backlinks.
- **Use `/quest-design` before quest creation/refinement.** Before creating a quest or refining an `idea` quest into worker-ready scope, invoke `/quest-design` and wait for user confirmation or correction. When the user clearly wants a quest created and dispatched, combine quest-design with this dispatch approval: describe the proposed quest draft plus Journey/scheduling plan naturally in prose so one confirmation can approve quest text, Journey, and dispatch plan. Routine feedback, claims, completion, verification checks, board updates, and already-approved phase transitions do not need a separate confirmation round.
- **`/leader-dispatch` owns the initial Journey proposal.** Before dispatching a fresh or newly refined quest, get approval for the quest and Journey/scheduling plan, then write that approved Journey to the board before or with dispatch. A separate `takode board present` ceremony is optional, not required.
- **Standard tracked-code phases are defaults, not mandates.** `alignment -> implement -> code-review -> port` is the recommended normal path for tracked-code work, but user overrides win. If the user asks to skip `code-review`, `port`, or another standard phase, follow that instruction or briefly confirm the tradeoff; do not refuse because the phase is "mandatory."
- **Make extra phases earn their keep.** When adding a non-standard phase, ask what that phase contributes over merging the work into a later phase. `implement` already includes normal investigation, root-cause analysis, code/design reading, and test planning for approved fixes, docs changes, config changes, prompt changes, and artifact changes.
- **Use quest threads for quest-scoped context.** Main is the staging area for unthreaded/global work. Quest threads carry quest-specific activity, and All Threads/global inspection preserves the append-only audit stream.
- **Thread hygiene at setup points.** After successful quest creation, refinement, or dispatch, include a lightweight reminder to attach clearly quest-specific prior Main discussion to the quest thread with `takode thread attach`. Keep future quest-specific leader responses in `[thread:q-N]`.
- **Route leader messages explicitly.** Every leader response starts with `[thread:main]` or `[thread:q-N]`. Shell/terminal commands that belong to a thread should start with `# thread:main` or `# thread:q-N`. `takode user-message` is deprecated compatibility only and should not be used as the new publishing path.
- **Treat worker/reviewer confusion as a quest-scoped blocking signal.** When a herded worker or reviewer raises a clarification question, answer it from existing context if you can. If not, ask the user in a normal leader response with the relevant `[thread:...]` marker, then call `takode notify needs-input` with a short summary, optionally using one to three short `--suggest <answer>` choices for obvious answers, keep that specific quest blocked until the ambiguity is resolved, and continue unrelated orchestration. Treat the wait as global only when the visible prompt explicitly concerns global orchestration, worker-slot scheduling, shared resource safety, or another cross-quest dependency. If you intentionally pause the quest on human input, make that an explicit board decision rather than inferring the pause from `/confirm` alone.

## Pre-Dispatch Approval Contract

If the user clearly asked for a quest to be created and dispatched, optimize for a single combined confirmation round. The first leader response should include:
- the proposed quest draft: title, scope/description, assumptions, non-goals, and tags when useful
- the proposed Journey/scheduling draft: planned phases, any concise non-standard phase reasons, worker choice or fresh-spawn intent, and dispatch/queueing plan

If meaningful clarification is needed, ask those questions with the quest framing. After the user clarifies and no major ambiguity remains, the next response should include both the drafted quest and the drafted Journey/scheduling plan. Avoid a separate round that only restates understanding after clarification when there are no new questions and no quest/Journey draft yet. More than two confirmation rounds should happen only when genuine additional clarification is needed.

Before you dispatch a quest, or intentionally leave it `QUEUED` for a later dispatch, get user approval for the quest and Journey/scheduling plan in prose. After approval and before sending the first worker, write that exact approved Journey to the board with `takode board set ... --phases ...` or by promoting an existing proposed row. Do not rely on the chat transcript as the only durable record of the Journey.

That pre-dispatch approval surface must include both:
- the planned initial Quest Journey phases
- the planned scheduling/orchestration approach

When the quest is a true follow-up to earlier work, the approval surface must also include a relationship line, for example `Relationship: follow-up of [q-1023](quest:q-1023)`. After approval, persist that relationship with the quest create/edit command. Do not use explicit follow-up for incidental references; those should remain detected backlinks.

The approval surface can be a natural leader response. It should still be concrete enough that the approved phases and scheduling plan can be written to the board immediately afterward. If a proposed board row already exists, revise that same row with `takode board propose ...` or `takode board propose --spec-file ...` so it remains the draft carrier; `takode board present` is available when you want an explicit rendered proposal artifact.

Omit notes for standard phases by default: `alignment`, `implement`, `code-review`, and `port` are self-explanatory unless the user or quest adds unusual work for that phase. Add concise notes for non-standard phases such as `explore`, `user-checkpoint`, `execute`, `outcome-review`, `mental-simulation`, or `bookkeeping`; state why the phase is needed and what evidence, user decision, scenario, outcome, or durable state it covers. For every extra phase, ask what it contributes over merging the same work into a later phase.

When a proposal includes multiple non-standard phase notes, format them as bullets keyed by phase, for example `- Execute: ...` and `- Outcome Review: ...`. Keep the phase list, phase notes, and scheduling plan visually separate so the approval surface is easy to scan before the user confirms.

The scheduling/orchestration plan must state at least:
- which worker you expect to use, or that you will spawn fresh
- whether you will dispatch immediately after approval or keep the quest `QUEUED`
- if `QUEUED`, the exact `--wait-for` reason: `q-N`, `#N`, `free-worker`, or one comma-separated value such as `q-N,#N,free-worker` when multiple blockers apply
- if worker-slot capacity is tight, whether you will archive a reclaimable completed worker before dispatching

Do not present only the phase list and silently decide the worker or queueing mechanics later. The user is approving both the phase plan and the intended dispatch/queueing approach.

Examples:
- **Simple immediate dispatch:** "Initial Journey: alignment -> implement -> code-review -> port. Scheduling: spawn a fresh worker and dispatch immediately if approved."
- **Queued for context:** "Initial Journey: alignment -> explore -> implement -> code-review -> port. Scheduling: keep it queued with `--wait-for #12` because that worker's active context is materially useful; if that context stops mattering, revise to a fresh spawn."
- **Capacity-tight immediate dispatch:** "Initial Journey: alignment -> implement -> code-review -> port. Scheduling: dispatch immediately if approved; if worker slots are still `5/5` only because completed workers are reclaimable, archive one of those completed workers first and then spawn fresh."

## Dispatch Steps

Walk through these steps before dispatching any quest.

### 1. Check the Board

```bash
takode board show
```

See current quest state and capacity. Identify quests already in progress and available worker slots.

### 2. List Your Herd

```bash
takode list
```

See your herded sessions with status, quest claims, last activity. Identify idle workers that might be reusable.

### 3. Evaluate Available Workers

For each idle or disconnected worker, check what quest it last worked on:

```bash
takode info <N>
```

Ask: is the new quest related to this worker's recent context (same feature area, same files, direct follow-up)?

Prefer the plain-text forms of `takode info`, `takode scan`, `takode peek`, and `quest show` when making human judgment calls about reuse, context, or relevance. Use `quest status <id>` for compact quest state and `quest feedback list/latest/show` for indexed feedback inspection. Use `--json` only when you need exact machine fields such as IDs, `commitShas`, version-local quest metadata, or feedback `addressed` flags from `quest feedback list --json`.

### 4. Decision Rules

| Situation | Action |
|-----------|--------|
| True follow-up work, or critical context mainly lives in one worker session | Reuse that worker |
| Needed context is recoverable from the repo, quest, or Takode history with reasonable effort | Spawn fresh |
| Fresh worker is better but older context still matters | Spawn fresh, then choose an explicit handoff pattern |
| You intentionally want one busy worker's context later | Queue on the board with `--wait-for` |
| No clear context advantage exists | Spawn fresh |

**Disconnected ≠ dead.** Workers showing `✗` (disconnected) in `takode list` are NOT dead -- they auto-reconnect when you send them a message via `takode send`. But disconnected availability alone is not a reason to reuse them. Reuse still requires a clear context advantage.

**Prefer fresh when context is discoverable.** If the needed context can be recovered from the repo, the quest, or Takode session history with reasonable effort, spawn a fresh worker.

**Reuse only when there is a real context advantage.** Good reuse cases:
- the new task is a true follow-up to the worker's immediately previous work
- the critical context lives mainly in that worker's session and a fresh worker would be at high risk of misunderstanding or making mistakes

**Do not reuse just because the worker is available.** Availability is not the decision rule.

**If fresh is better but old context still matters, choose deliberately between two handoff patterns:**
- ask the old worker to write down the hard-to-discover context in a response, then pass that exact session message link to the fresh worker so it can read the note directly via Takode CLI
- ask the new worker to inspect the older session directly with Takode CLI (`takode info`, `takode scan`, `takode peek`, `takode read`) when a source note is unnecessary

When doing that inspection yourself, prefer the plain-text CLI output first. Reach for `--json` only if the dispatch decision depends on exact structured fields.

**Prefer link-based handoffs over paraphrase.** If the old worker writes a context note, pass the specific session message link rather than rewriting the note yourself. This preserves source fidelity and lets the fresh worker inspect the original wording directly.

**Queue** only with an explicit reason. Add the quest to the board yourself as `QUEUED` with:
- `--wait-for #N` when you intentionally want a specific busy worker's context later
- `--wait-for q-N` when another queued/active quest must clear first
- `--wait-for free-worker` when herd worker-slot capacity must clear
- one comma-separated `--wait-for` value when multiple blockers apply, such as `--wait-for q-1143,q-1139` or `--wait-for q-1143,#12,free-worker`

When a queued row has multiple dependency, capacity, or session blockers, record them all in that single comma-separated value. Do not model multi-blocker waits by serially changing the row from one `--wait-for` blocker to another after each blocker clears.

Do not ask workers to "queue" work, and do not leave a `QUEUED` row without `--wait-for`.

Do not leave a quest in `QUEUED` just because `takode list` says `Worker slots used: 5/5`. First distinguish active worker slots (quests still on the active board) from reclaimable completed workers. If the quest is otherwise ready and only reclaimable completed workers are consuming capacity, archive one and dispatch now. Otherwise, if you truly need to wait on capacity, make that explicit with `--wait-for free-worker`. If capacity is only one of several blockers, include it with the others, for example `--wait-for q-1143,#12,free-worker`. If the work would significantly benefit from the context of an existing busy worker, keep it queued only with an explicit `--wait-for #N`, `--wait-for q-N`, or comma-separated dependency set.

**Spawn fresh** when there is no strong context advantage for reuse, or when the context can be recovered safely from artifacts and history. Point the new worker to relevant quests or past sessions for context:

```bash
takode spawn --message-file - <<'EOF'
<dispatch>
EOF
```

**Shell quoting safety.** Do not paste complex text payloads inline inside double quotes if they may contain backticks, `$(...)`, quotes, braces, copied CLI output, or other shell-sensitive content. Your shell can execute or corrupt that text locally before the target command receives it. Use Takode's non-inline input paths instead: `takode send --stdin` for sent messages, and `takode spawn --message-file <path>` or `--message-file -` for spawn dispatches.

```bash
takode spawn --message-file - <<'EOF'
Work on [q-XX](quest:q-XX). Read the quest and claim it: `quest show q-XX && quest claim q-XX`.
If logs include `$(...)` or backticks, treat them as literal text.
Return a plan for approval before implementing. After you send the plan, stop and wait for approval.
EOF
takode send 2 --stdin <<'EOF'
Work on [q-XX](quest:q-XX). Read the quest and claim it: `quest show q-XX && quest claim q-XX`.
If logs include `$(...)` or backticks, treat them as literal text.
Return a plan for approval before implementing. After you send the plan, stop and wait for approval.
EOF
```

For quest comments or port summaries, prefer the quest CLI's safer rich-text path instead of inline shell quoting:

```bash
cat >/tmp/quest-feedback.txt <<'EOF'
Port summary: commit abc123 ...
Treat `foo $(bar)` as literal text, not shell.
EOF
quest feedback q-123 --text-file /tmp/quest-feedback.txt
quest feedback latest q-123 --author human --unaddressed --full

printf '%s\n' 'Port summary: commit abc123 ...' 'Treat `foo $(bar)` as literal text, not shell.' | \
  quest feedback q-123 --text-file -
```

**Never use `--no-worktree` unless the user explicitly asks for it** or the project's repo instructions require it. All workers get worktrees by default -- including investigation and debugging tasks, since they almost always lead to code changes. Don't use `--fixed-name` for regular workers -- they auto-name from their quest.

Default to your own backend type unless the user specifies otherwise.

### 5. Approve and Record the Initial Journey

Before dispatching a fresh or newly refined quest, get user approval for the planned initial Journey and scheduling approach. Use natural prose; do not make the user approve a separate board draft/present artifact unless that extra UI is genuinely useful.

This is the `/leader-dispatch` contract:
- `/quest-design` confirms quest understanding and finalizes the quest text.
- `/quest-design` also confirms any explicit follow-up relationship, so the leader can persist it with `--follow-up-of` instead of leaving true follow-ups as prose only.
- `/leader-dispatch` proposes the initial Journey and scheduling plan for execution.
- When the user asked for quest creation plus dispatch and the scope is clear, combine those into one approval surface instead of running a quest-text confirmation and a separate Journey confirmation.

The proposal should:
- name the built-in phases you intend to put on the board first
- explain non-standard phases concisely: why each is needed and what evidence, scenario, outcome, or durable state it covers
- avoid routine `explore -> implement` for normal bug-fix, docs-change, config-change, prompt-change, or artifact-change work; `implement` includes the investigation, root-cause analysis, code/design reading, and test planning needed to complete those changes
- use `user-checkpoint` when findings/options/tradeoffs/recommendation must be presented to the user before the Journey continues
- make it explicit that the first worker dispatch will enter the `alignment` phase (`PLANNING` on the board) only after approval
- omit notes for standard phases unless unusual phase-specific handling is required
- treat the default tracked-code path as recommended, not mandatory; if the user changes the phase list, follow or confirm the tradeoff

If the quest already exists and a proposed board row helps, you may put the draft on the board with `takode board propose ...` or `takode board propose --spec-file ...` before approval. If the quest does not exist yet, keep the approval in prose and create the board row immediately after `quest create`. Do not spawn a worker or send the standard dispatch message until the approved Journey is durable on the board.

Once approved, either promote the same proposed board row into active execution with `takode board promote ...` or create the active row directly with `takode board set <quest-id> --worker <N> --phases ...`. The approved Journey must be on the board before or with dispatch so recovery does not depend on reconstructing transcript prose.
After the quest is created/refined or the dispatch row is active, remind the leader: Thread reminder: attach any prior messages that clearly belong to this quest to [q-N](quest:q-N) with `takode thread attach`.

### 6. Check Herd Limit

Maintain at most **5 worker slots** in your herd. Reviewer sessions do **not** use worker slots. Before spawning, check `takode list` and read the worker-slot summary directly -- do **not** rely on the raw total session count or subtract reviewers yourself. Archiving reviewers does **not** free worker-slot capacity. **Never archive proactively.** Only archive when you are at the 5-worker-slot limit AND need to spawn a new worker. Idle and disconnected worker sessions retain valuable context -- keep them until you actually need the slot. **Archiving a worktree worker deletes its worktree and any uncommitted changes**, so do not archive until anything worth keeping has been ported, committed, or otherwise synced. When you must archive, choose the worker least likely to be reused -- typically the one whose work is most complete, least related to upcoming tasks, or oldest.

### 7. Send Standardized Dispatch Message

**Use this exact template. Do not add extra context, file paths, or investigation instructions.**

Only send this after the user approved the combined pre-dispatch proposal and the approved Journey is durable on the board: initial Journey phases plus the scheduling/orchestration plan.

```
Work on [q-XX](quest:q-XX). Load the quest skill first, then read the quest and claim it: `quest show q-XX && quest claim q-XX`.

Read this phase brief first:
- `~/.companion/quest-journey-phases/alignment/assignee.md`

Return an alignment read-in for approval covering your concrete understanding, ambiguities, clarification questions, blockers, surprises, and any evidence that may justify leader-owned Journey revision. After you send it, stop and wait for approval.
```

When sending this template through the shell, prefer `takode spawn --message-file -` or `takode spawn --message-file <path>` over inline `--message` if you might include shell-like text or multi-line additions.

If the worker needs additional context (related sessions, rejected approaches, user decisions), add it to the quest description before dispatching. When exact prior messages, quests, or discussions are already known, point to those specific sources so the worker can inspect them directly with Takode and quest tools during alignment instead of broad exploration. Workers have the same tools and skills you do -- they run `quest show q-XX` themselves.

This dispatch happens only after the user has approved the initial Journey from Step 5. The worker's alignment phase returns a lightweight read-in inside that approved Journey; it is not the first time phases are being proposed, and it is not a routine second user-approval gate.

**Workers must stop after each phase boundary.** The dispatch message only authorizes alignment. After alignment approval, the worker performs the approved next phase. After implementation, the worker STOPS and waits -- it does NOT self-review, run review skills on its own, run `/self-groom`, or self-port. The leader advances the quest through Quest Journey phases.

**Every completed non-cancelled quest needs final debrief metadata.** Completion without both a final debrief and debrief TLDR is incomplete. Port workers should submit or draft them during Port; when Port is omitted or leader-owned completion follows Outcome Review, the leader must draft them from accepted evidence, require `Final debrief draft:` plus `Debrief TLDR draft:` from the final phase actor, or route focused Bookkeeping.

**Every phase needs durable quest documentation.** Before a phase is considered complete, the actor for that phase should add or refresh a quest feedback entry scoped to the current phase when working on a quest. Prefer current-phase inference with the q-991 primitive:

```bash
quest feedback add q-N --text-file /tmp/phase.md --tldr-file /tmp/phase-tldr.md --kind phase-summary
```

Use `--kind phase-finding` for exploration findings, `--kind review` for review phases, or `--kind artifact` for execution artifacts when that is more accurate. If current-phase inference is unavailable or ambiguous, require explicit phase/run/occurrence flags such as `--phase implement`, `--phase-position`, `--phase-occurrence`, `--phase-occurrence-id`, or `--journey-run`. Use `--no-phase` only when a flat quest comment is intentional. The full body is for future agents; the TLDR is for human scanning and should preserve the phase's conclusions, decisions, evidence, blockers, risks, handoff facts, and phase-specific outcomes. Low-level details such as full SHAs, branch names, command lists, routine paths, and verification mechanics belong in the full body or port metadata unless that exact detail is central to understanding the phase. When documenting repository files, prefer Takode custom file links such as `[QuestDetailPanel.tsx:42](file:web/src/components/QuestDetailPanel.tsx:42)`; standard Markdown file links are only a best-effort Questmaster fallback.

Apply a value filter to phase documentation: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases. If the actor's context was compacted during the phase, or if memory confidence is low, they should reconstruct relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, they should use working memory and current artifacts instead of unnecessary session archaeology.

Workers and reviewers may use `takode worker-stream` after a valuable nontrivial phase outcome is ready so you can start reading while they finish required paperwork. Treat it as optional early visibility only: do not require it as boilerplate, and do not let it replace phase documentation, final debrief metadata, or leader-owned phase transitions.

**Make every follow-up message phase-explicit.**
- **Initial dispatch**: invoke the alignment phase and include the exact assignee brief path: `~/.companion/quest-journey-phases/alignment/assignee.md`. The worker returns a lightweight read-in, documents the alignment phase on the quest when possible, then stops. The user-approved proposal that led to this dispatch must already have stated the scheduling/orchestration plan, even in the simple case: "spawn fresh and dispatch immediately if approved."
- **Every phase dispatch**: include `Read this phase brief first:` plus the exact assignee brief path from `takode phases`, for example `~/.companion/quest-journey-phases/implement/assignee.md`. Do this for workers and reviewers, and remind them to document the current phase before reporting back. Provide only deltas the actor is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- **Alignment approval**: after the worker returns the read-in, the leader normally approves the next phase directly. Escalate back to the user only when the read-in introduces significant ambiguity, scope change, Journey revision, user-visible tradeoff, or another real blocking issue. If real unknowns remain, route to `explore`; if the next move is already clear, invoke that phase and say so explicitly. Do not imply review, porting, or quest transitions are authorized.
- **Review or rework follow-up**: say exactly what the worker should do now, then tell them to report back and wait. Tell the worker to add or refresh the current phase documentation with what changed, why it matters, verification evidence, remaining risks, and addressed feedback when applicable. Do not imply porting is authorized.
- **Reviewer-owned quest hygiene**: reviewers may directly fix clear quest hygiene issues they know how to fix, including stale addressed flags, missing/refreshable summaries, and verification checklist checks backed by evidence. Reviewers should judge phase documentation quality, not just presence: phase relevance, useful full detail, TLDR completeness where appropriate, and correct phase association when the primitive is available. Expect reviewers to report those fixes or documentation findings in ACCEPT/CHALLENGE output. Do not send the worker rework for hygiene the reviewer already fixed; do send substantive failures, critical intention mismatches, missing or dishonest work, and ambiguity back through the normal review loop.
- **If review follow-up needs more code changes**: tell the worker to commit the current worktree state, make the fixes in a separate follow-up commit, and send the changed worktree back to Code Review only after that checkpoint exists. This lets the reviewer inspect a clean incremental diff of only the new work. This does not require reviewers to commit and does not apply to purely read-only follow-up review discussion.
- **Porting**: send a separate, explicit `/port-changes` instruction only after reviewer ACCEPT. Require the worker's report-back to include a dedicated `Synced SHAs: sha1,sha2` line with the ordered synced SHAs from the main repo and the status of required post-port verification. These details belong in the report and phase documentation, not in `quest complete --items`; verification items are only for human-checkable acceptance checks. If the port worker will complete the quest, completion should use `--debrief-file` and `--debrief-tldr-file`; if the leader controls completion, require `Final debrief draft:` and `Debrief TLDR draft:` in the worker report, or route a focused Bookkeeping phase when the worker cannot reliably produce final debrief metadata. For refactor quests, the full automated gate before merge or final acceptance is `cd web && bun run typecheck`, `cd web && bun run test`, and `cd web && bun run format:check`. `format:check` is the current lint/format-equivalent gate in this repo; there is no separate `lint` script right now. If a full run is infeasible, the worker must document the exception explicitly. If the required post-port verification run fails, dispatch a suitable worker to fix `main` immediately rather than waiting.
- **Docs/skills/prompts/templates still count when tracked**: if a worker changes git-tracked docs, skill files, prompts, templates, or other text-only files, treat it as commit-producing work. It must go through normal review, porting, and `quest complete ... --commit/--commits` structured metadata after sync.
- **Investigation/design quests**: say what artifact or evidence to produce, then tell the worker to stop and report back. Use an explicit Journey that omits `port` only when the quest will produce zero git-tracked changes. Do not use that for text-only tracked-file edits, and do not assume the worker should self-complete or self-transition the quest. If this path is completed without Port, the leader owns final debrief metadata before completion or must route focused Bookkeeping.
- **Bookkeeping**: use this phase for cross-phase or external durable state beyond normal phase notes, such as consolidated summaries, final debrief metadata after port when the port worker could not reliably create it, verification checklist reconciliation, external docs or links, superseded facts, notification cleanup, thread cleanup, or shared-state updates. Do not dispatch Bookkeeping just to repeat normal phase documentation.

**Use explicit phrasing when steering between phase boundaries.** Good defaults:

```
Read this phase brief first:
- `~/.companion/quest-journey-phases/implement/assignee.md`

Implement the approved plan, add or refresh the current Implement phase documentation with full agent-oriented detail plus TLDR metadata, then stop and report back. Document what changed, why it matters, what verification passed, remaining risks, and any addressed feedback. Do not run review workflows on your own, run /self-groom, run /port-changes, or change the quest status yourself.
```

```
Read this phase brief first:
- `~/.companion/quest-journey-phases/implement/assignee.md`

Address the reviewer findings, add or refresh the current Implement phase documentation with full detail plus TLDR metadata, then stop and report back. Do not port yet.
```

```
Read this phase brief first:
- `~/.companion/quest-journey-phases/implement/assignee.md`

Address the review findings. If you need more code changes, commit the current worktree state, make the fixes in a separate follow-up commit, and send the changed worktree back to Code Review only after that checkpoint exists so the reviewer can inspect a clean incremental diff. This does not apply to purely read-only follow-up review discussion. Add or refresh the current Implement phase documentation with full detail plus TLDR metadata, then stop and report back. Do not port yet.
```

```
Read this phase brief first:
- `~/.companion/quest-journey-phases/port/assignee.md`

Port now using /port-changes, add or refresh the current Port phase documentation, then report back when sync is complete. Include a dedicated `Synced SHAs: sha1,sha2` line with the ordered synced SHAs from the main repo so the later `quest complete ... --commits ...` handoff can attach structured commit metadata instead of relying on feedback comments alone.

If you complete the quest as part of the handoff, use `quest complete ... --debrief-file ... --debrief-tldr-file ...`. If the leader will complete it later, include `Final debrief draft:` and `Debrief TLDR draft:` in your report; if you cannot reliably draft those from Port context, say so and ask for a focused Bookkeeping phase.
```

**For feedback rework dispatches**, use this extended template instead:

```
Work on [q-XX](quest:q-XX). Load the quest skill first, then read the quest and claim it: `quest show q-XX && quest claim q-XX`.
The quest has unaddressed human feedback -- read it carefully and factor it into your alignment read-in.

Read this phase brief first:
- `~/.companion/quest-journey-phases/alignment/assignee.md`

Return an alignment read-in for approval covering your concrete understanding, ambiguities, clarification questions, blockers, surprises, and any evidence that may justify leader-owned Journey revision. After you send it, stop and wait for approval.
```

This ensures workers load the quest skill (so CLI commands work), read pending feedback before alignment, and stop at the alignment boundary. Feedback addressing happens during implementation, not alignment.

**Feedback rework resets the board cycle.** When new human feedback arrives for a quest that is already on the board, immediately reset that row to the earliest valid phase for the new cycle before doing anything else with stale worker/reviewer completions:

- `PLANNING` if the same worker is still the intended owner and should produce a fresh alignment read-in
- `QUEUED` if you need to choose a worker again or the prior ownership is no longer valid

**Interrupt before redirecting active stale work.** If the old-scope worker is still actively generating when fresh human feedback or an urgent correction changes the source of truth, interrupt it first with `takode interrupt <N>`. Then send the corrected instruction as a fresh message. Do not rely on a queued correction to outrun the old turn.

Do not let a stale review acceptance, stale port confirmation, or any other old-scope completion advance the board after that reset. Those completions are now historical context, not the active quest state.

**Forward user screenshots.** When the user provides screenshots alongside a task request, attach them to the quest via `quest feedback q-XX --image <path>` before dispatching. If no quest exists (e.g. ad-hoc investigation), send the image file path to the worker via `takode send` so they can Read it. `takode spawn` does not support images -- always use a follow-up message or quest attachment. User-uploaded chat and Questmaster images already pass through Takode's image pipeline; do not ask workers to recompress them unless the path is an older unmarked image with concrete size/dimension evidence.

**Local/generated screenshot paths.** When forwarding evidence produced by `agent-browser screenshot`, prefer the returned `.takode-agent.` path. The Takode wrapper preserves the original sibling for precision/debugging; use `--takode-original` only when the worker truly needs the original pixels. For other local/generated image files, run `quest optimize-image <path>` before sending and forward the returned sibling.

**413 recovery.** Do not blindly retry a worker or reviewer turn that failed with `413 Payload Too Large` or equivalent request-size wording, especially after image-heavy browser evidence. First try a manual `/compact` or remove redundant local image references where possible. If the session is stuck or retained context cannot be reduced, replace/restart the actor with bounded instructions: point at the durable quest notes, optimized `.takode-agent.` evidence paths, and exact remaining question instead of replaying the full image-heavy transcript.

### 8. Board Commands for Proposal and Promotion

```bash
takode board propose <quest-id> --spec-file <proposal.json>
takode board promote <quest-id> --worker <N>
```

Use `takode board propose` when an existing quest needs a board-owned draft row before approval. Use `takode board present` only when a rendered proposal artifact is helpful. Use `takode board promote` after approval to turn the same Journey object into active execution, or use `takode board set --worker ... --phases ...` after approval to create the active durable row in one step.

## Task Delegation Style

- **Describe WHAT and WHY, not HOW.** Explain the desired outcome and context -- don't specify files or functions unless you have high confidence from recent direct observation.
- **Provide cross-quest context the worker wouldn't have.** Relay user decisions, rejected approaches, and related quests.
- **Include source conversation references.** When dispatching quests from a brainstorming discussion, include the session ID and message range so workers can inspect design rationale.
- **Include reproduction steps and user observations.** Screenshots, error messages, and user feedback are more valuable than your guesses.
- **Let workers choose the approach when you lack context to decide.**
- **Always require a plan before non-trivial implementation.** Do not accept planless implementations.
