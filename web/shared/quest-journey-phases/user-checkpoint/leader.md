# User Checkpoint -- Leader Brief

Use this phase when the next step genuinely requires user participation before the Journey continues.

Leader actions:
- Keep the board row in `USER_CHECKPOINTING`.
- Include the exact assignee brief path in the instruction when asking an assignee to prepare the checkpoint packet: `~/.companion/quest-journey-phases/user-checkpoint/assignee.md`.
- Present the user-facing checkpoint in the quest thread or main thread as appropriate: findings, options, tradeoffs, and a recommendation.
- After the user-visible checkpoint exists, call `takode notify needs-input` with a short summary and wait for the user answer.
- After the user responds, revise the remaining Journey on the board and continue with the approved next phase.
- Require the assignee to add or refresh phase documentation before handoff when an assignee prepared the checkpoint. It should use phase-scoped quest feedback with full agent-oriented detail plus TLDR metadata when working on a quest, falling back to explicit `--phase user-checkpoint` if current-phase inference is unavailable.
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- Do not use this phase as a terminal phase, a generic TBD bucket, or a leader-only indecision placeholder.
- If the next action is obvious without user input, skip `USER_CHECKPOINTING` and revise the remaining Journey directly.
