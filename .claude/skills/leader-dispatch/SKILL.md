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
- **User feedback on completed quests triggers a full rework cycle.** When a user reports issues with a completed quest, record the feedback, set the quest back to `refined`, and dispatch with a full quest journey. Never treat feedback fixes as "quick patches" that skip review. See quest-journey.md in /takode-orchestration.
- **Fresh human feedback overrides stale in-flight work.** If new human feedback lands while the quest is still on the board or while an older review/port turn is still completing, treat that feedback as the new source of truth. Reset the board row to the earliest valid stage for the fresh rework cycle, then stop or ignore stale completion from the older scope instead of letting it advance the quest.
- **Dispatch immediately when capacity exists.** When a quest is refined and ready, check your herd count before saying "I'll dispatch later." If you have open slots, dispatch now. Don't defer without a concrete reason (e.g., waiting for user input, worker with better context is about to free up).
- **Do not treat reclaimable completed workers as real capacity blockers.** When a quest is `QUEUED`, compare the active board to the herd. If it has no unresolved `--wait-for` blocker and the only thing keeping worker slots at `5/5` is completed or off-board work sitting in `needs_verification`, archive one of those completed workers and dispatch immediately. Alternatively, if the work would significantly benefit from the context of an existing busy worker, keep it queued only with an explicit `--wait-for #N` or `--wait-for q-N` dependency.
- **Fresh worker by default.** Reuse is the exception, not the default. Do not reuse a worker just because it is idle, disconnected, or already available.

### Faithful Communication

- **Be faithful to the user's words.** When creating quests or dispatching work, preserve the user's original meaning. Do not embellish, reinterpret, or add details the user didn't say.
- **Ask, don't assume.** If the user's instruction is ambiguous or underspecified, ask a quick follow-up question before dispatching. Every interaction with the user is an opportunity to clarify. Workers can figure out implementation details themselves -- you don't need to fill in gaps with guesses.
- **Never hallucinate user intent.** If the user says "fix the sidebar bug", don't turn it into "fix the sidebar bug by adjusting the CSS grid layout and adding a media query for mobile breakpoints". Pass through what the user said and let the worker investigate.
- **Added details need confirmation.** If you want to add specifics to make instructions more actionable (e.g. suggesting an approach, naming specific files, or scoping the fix), confirm with the user first. An over-specified instruction based on wrong assumptions wastes more time than a brief clarifying question.
- **Treat worker/reviewer confusion as a blocking signal.** When a herded worker or reviewer raises a clarification question, answer it from existing context if you can. If not, ask the user via plain text plus `takode notify needs-input` and keep that quest blocked until the ambiguity is resolved.

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

Prefer the plain-text forms of `takode info`, `takode scan`, `takode peek`, and `quest show` when making human judgment calls about reuse, context, or relevance. Use `--json` only when you need exact machine fields such as IDs, `commitShas`, version-local quest metadata, or feedback `addressed` flags.

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
- `--wait-for free-worker` when the only blocker is herd worker-slot capacity

Do not ask workers to "queue" work, and do not leave a `QUEUED` row without `--wait-for`.

Do not leave a quest in `QUEUED` just because `takode list` says `Worker slots used: 5/5`. First distinguish active worker slots (quests still on the active board) from reclaimable completed workers. If the quest is otherwise ready and only reclaimable completed workers are consuming capacity, archive one and dispatch now. Otherwise, if you truly need to wait on capacity, make that explicit with `--wait-for free-worker`. If the work would significantly benefit from the context of an existing busy worker, keep it queued only with an explicit `--wait-for #N` or `--wait-for q-N` dependency.

**Spawn fresh** when there is no strong context advantage for reuse, or when the context can be recovered safely from artifacts and history. Point the new worker to relevant quests or past sessions for context:

```bash
takode spawn --message "<dispatch>"
```

**Shell quoting safety.** Do not paste complex text payloads inline inside double quotes if they may contain backticks, `$(...)`, quotes, braces, copied CLI output, or other shell-sensitive content. Your shell can execute or corrupt that text locally before the target command receives it. This applies to `takode send`, `takode spawn --message`, `quest feedback`, and any other shell command carrying arbitrary text. For multi-line or shell-like payloads, compose the text with a single-quoted heredoc and pass the variable instead:

```bash
msg=$(cat <<'EOF'
Work on [q-XX](quest:q-XX). Read the quest and claim it: `quest show q-XX && quest claim q-XX`.
If logs include `$(...)` or backticks, treat them as literal text.
Return a plan for approval before implementing. After you send the plan, stop and wait for approval.
EOF
)
takode spawn --message "$msg"
takode send 2 "$msg"
```

Use the same pattern for quest comments and port summaries:

```bash
msg=$(cat <<'EOF'
Port summary: commit abc123 ...
Treat `foo $(bar)` as literal text, not shell.
EOF
)
quest feedback q-123 --text "$msg"
```

**Never use `--no-worktree` unless the user explicitly asks for it** or the project's repo instructions require it. All workers get worktrees by default -- including investigation and debugging tasks, since they almost always lead to code changes. Don't use `--fixed-name` for regular workers -- they auto-name from their quest.

Default to your own backend type unless the user specifies otherwise.

### 5. Check Herd Limit

Maintain at most **5 worker slots** in your herd. Reviewer sessions do **not** use worker slots. Before spawning, check `takode list` and read the worker-slot summary directly -- do **not** rely on the raw total session count or subtract reviewers yourself. Archiving reviewers does **not** free worker-slot capacity. **Never archive proactively.** Only archive when you are at the 5-worker-slot limit AND need to spawn a new worker. Idle and disconnected worker sessions retain valuable context -- keep them until you actually need the slot. **Archiving a worktree worker deletes its worktree and any uncommitted changes**, so do not archive until anything worth keeping has been ported, committed, or otherwise synced. When you must archive, choose the worker least likely to be reused -- typically the one whose work is most complete, least related to upcoming tasks, or oldest.

### 6. Send Standardized Dispatch Message

**Use this exact template. Do not add extra context, file paths, or investigation instructions.**

```
Work on [q-XX](quest:q-XX). Read the quest and claim it: `quest show q-XX && quest claim q-XX`.
Return a plan for approval before implementing. After you send the plan, stop and wait for approval.
```

When sending this template through the shell, prefer the heredoc pattern above over inline double quotes if you might include shell-like text or multi-line additions.

If the worker needs additional context (related sessions, rejected approaches, user decisions), add it to the quest description before dispatching. Workers have the same tools and skills you do -- they run `quest show q-XX` themselves.

**Workers must stop after each stage boundary.** The dispatch message only authorizes planning. After plan approval, the worker implements. After implementation, the worker STOPS and waits -- it does NOT self-review, run `/reviewer-groom`, run `/self-groom`, or self-port. The leader advances the quest through review stages.

**Make every follow-up message stage-explicit.**
- **Initial dispatch**: planning only. The worker returns a plan and stops.
- **Plan approval**: say "implement now, then stop and report back." Do not imply review, porting, or quest transitions are authorized.
- **Review or rework follow-up**: say exactly what the worker should do now, then tell them to report back and wait. Do not imply porting is authorized.
- **Porting**: send a separate, explicit `/port-changes` instruction only after reviewer ACCEPT. Require the worker's report-back to include a dedicated `Synced SHAs: sha1,sha2` line with the ordered synced SHAs from the main repo.
- **Investigation/design/no-code quests**: say what artifact to produce, then tell the worker to stop and report back. Do not assume the worker should self-complete or self-transition the quest.

**Use explicit phrasing when steering between stages.** Good defaults:

```
Implement the approved plan, then stop and report back. Do not run /reviewer-groom, /self-groom, /port-changes, or change the quest status yourself.
```

```
Address the reviewer findings, then stop and report back. Do not port yet.
```

```
Address the reviewer-groom findings, then stop and report back. Do not port yet.
```

```
Port now using /port-changes, then report back when sync is complete. Include a dedicated `Synced SHAs: sha1,sha2` line with the ordered synced SHAs from the main repo so the later `quest complete ... --commits ...` handoff can attach structured commit metadata instead of relying on feedback comments alone.
```

**For feedback rework dispatches**, use this extended template instead:

```
Work on [q-XX](quest:q-XX). Read the quest and check unaddressed feedback: `quest show q-XX && quest claim q-XX`.
Address all unaddressed feedback items. After fixing each item, mark it as addressed: `quest address q-XX <index>`.
Return a plan for approval before implementing. After you send the plan, stop and wait for approval.
```

This ensures workers know about pending feedback and explicitly mark each item as addressed after fixing it.

**Feedback rework resets the board cycle.** When new human feedback arrives for a quest that is already on the board, immediately reset that row to the earliest valid stage for the new cycle before doing anything else with stale worker/reviewer completions:

- `PLANNING` if the same worker is still the intended owner and should produce a fresh plan
- `QUEUED` if you need to choose a worker again or the prior ownership is no longer valid

Do not let a stale review acceptance, stale port confirmation, or any other old-scope completion advance the board after that reset. Those completions are now historical context, not the active quest state.

**Forward user screenshots.** When the user provides screenshots alongside a task request, attach them to the quest via `quest feedback q-XX --image <path>` before dispatching. If no quest exists (e.g. ad-hoc investigation), send the image file path to the worker via `takode send` so they can Read it. `takode spawn` does not support images -- always use a follow-up message or quest attachment.

### 7. Update the Board

```bash
takode board set <quest-id> --worker <N> --status PLANNING
```

## Task Delegation Style

- **Describe WHAT and WHY, not HOW.** Explain the desired outcome and context -- don't specify files or functions unless you have high confidence from recent direct observation.
- **Provide cross-quest context the worker wouldn't have.** Relay user decisions, rejected approaches, and related quests.
- **Include source conversation references.** When dispatching quests from a brainstorming discussion, include the session ID and message range so workers can inspect design rationale.
- **Include reproduction steps and user observations.** Screenshots, error messages, and user feedback are more valuable than your guesses.
- **Let workers choose the approach when you lack context to decide.**
- **Always require a plan before non-trivial implementation.** Do not accept planless implementations.
