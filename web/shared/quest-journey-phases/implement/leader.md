# Implement -- Leader Brief

Use this phase after approving the plan or another prior phase result.

Leader actions:
- Keep the board row in `IMPLEMENTING`.
- Include the exact assignee brief path in the instruction: `~/.companion/quest-journey-phases/implement/assignee.md`.
- Authorize only the approved implementation scope for this phase.
- Let the worker do the normal investigation, root-cause analysis, code/design reading, and test planning needed to complete the approved fix, docs change, config change, prompt change, or artifact change.
- Let the worker gather cheap, local, reversible outcome evidence during this phase when that evidence can be produced inside the approved implementation scope.
- Route expensive, risky, long-running, externally consequential, or approval-gated runs to `EXECUTING` instead of stretching `IMPLEMENTING`.
- Require the assignee to add or refresh phase documentation before the phase handoff. It should use phase-scoped quest feedback with full agent-oriented detail plus TLDR metadata when working on a quest, falling back to explicit `--phase implement` if current-phase inference is unavailable.
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- Require the assignee to stop after reporting back.
- Route the result into the next review, execute, bookkeeping, or port phase explicitly.
- Do not insert a separate `EXPLORE` phase merely for routine pre-implementation reading; ask what that extra phase contributes over doing the work inside `IMPLEMENTING`.
