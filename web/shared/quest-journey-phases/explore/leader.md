# Explore -- Leader Brief

Use this phase when investigation is the deliverable, or when alignment surfaced real unknowns and the next route is genuinely unclear.

Leader actions:
- Keep the board row in `EXPLORING`.
- Include the exact assignee brief path in the instruction: `~/.companion/quest-journey-phases/explore/assignee.md`.
- Point the assignee to the specific unknowns, artifacts, sessions, or evidence sources to inspect.
- Ask for major findings, newly discovered ambiguities or blockers, implementation considerations, and evidence that may justify leader-owned Journey revision.
- Require the assignee to add or refresh phase documentation before the phase handoff. It should use phase-scoped quest feedback with full agent-oriented detail plus TLDR metadata when working on a quest, falling back to explicit `--phase explore` if current-phase inference is unavailable.
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- Use this phase for distinct investigation work. Do not insert `EXPLORE -> IMPLEMENT` just so a worker can look around before a normal bug fix, docs change, config change, or prompt change; `IMPLEMENTING` includes the normal reading, root-cause analysis, and test planning needed to complete those changes.
- If the likely output is a user decision after findings, plan or revise to `USER_CHECKPOINTING` instead of silently assuming `EXPLORE -> IMPLEMENT`.
- Do not stretch `ALIGNMENT` into a fake comprehensive planning phase.
- Revise the remaining Journey if the findings change the right leader-owned action.
