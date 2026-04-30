---
name: quest-journey-user-checkpoint
description: "Quest Journey phase: user-checkpoint. Use when findings, options, tradeoffs, and a recommendation must be presented to the user before the Journey continues."
---

# Quest Journey Phase: User Checkpoint

This phase is an intermediate user-participation stop. It is not terminal, not a generic TBD bucket, and not a leader-only indecision placeholder.

Leader actions:
- Include the exact assignee brief path when an assignee should prepare the checkpoint packet: `~/.companion/quest-journey-phases/user-checkpoint/assignee.md`.
- Keep the board row in `USER_CHECKPOINTING`.
- Present the user-visible checkpoint with findings, options, tradeoffs, and a recommendation.
- After the user-visible text exists, call `takode notify needs-input` with a short summary and wait for the user answer.
- After the user responds, revise the remaining Journey and continue with the approved next phase.
- If the next action is obvious without user input, skip `user-checkpoint` and revise the Journey directly.

Worker-visible boundary:
- The worker may prepare the checkpoint packet and phase documentation.
- The worker must not implement, review, port, complete the quest, or change quest status.
- Before reporting back, the worker should document findings, options, tradeoffs, recommendation, required user answer, and Journey-revision implications with full agent-oriented detail plus TLDR metadata. Prefer `quest feedback add q-N --text-file ... --tldr-file ... --kind phase-summary`; use explicit `--phase user-checkpoint` or occurrence flags if current-phase inference is unavailable.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.

Exit evidence:
- A user-checkpoint packet with findings, options, tradeoffs, recommendation, and the user answer needed to continue.

Advance when:
- The user has answered and the leader has revised the remaining Journey.
