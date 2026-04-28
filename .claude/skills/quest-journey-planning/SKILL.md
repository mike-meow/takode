---
name: quest-journey-planning
description: "Quest Journey phase: alignment. Legacy skill slug for the lightweight read-in and goal-alignment phase that follows initial Journey approval."
---

# Quest Journey Phase: Alignment

This legacy skill slug now documents the `alignment` phase. Use it for a lightweight read-in after the initial Journey has been approved.

Leader actions:
- Send the standard dispatch message for the quest.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/alignment/assignee.md`.
- Approve the initial Journey before this phase begins and keep that Journey on the board.
- Tell the worker to load the quest skill, read and claim the quest, return an alignment read-in, then stop.
- Put or keep the board row in `PLANNING`.
- When the relevant context is already known, point the worker to the exact prior messages, quests, or discussions that matter; they can inspect those directly with Takode and quest tools instead of broad exploration.
- Ask for concrete understanding, ambiguities, clarification questions, blockers, surprises, and evidence that may justify leader-owned Journey revision.
- Do not ask for a supposedly comprehensive implementation plan here; route to `explore` when real unknowns remain.
- Review the returned read-in yourself first. Default to leader-owned approval when it stays within the approved Journey and does not introduce significant ambiguity, scope change, Journey revision, user-visible tradeoff, or another blocking issue.
- Escalate back to the user only when one of those issues genuinely needs user approval.

Worker-visible boundary:
- The worker may inspect only the minimum context needed to confirm the goal, constraints, and any blocker within the current board-carried Journey.
- If the leader already pointed to exact prior messages, quests, or discussions, the worker should inspect those sources directly rather than doing broad exploration.
- If the worker believes the Journey should change, they should surface the evidence in the read-in rather than assuming approval for a different phase sequence.
- The worker must not explore, implement, review, execute, port, or change quest status.

Exit evidence:
- A lightweight alignment read-in is available in plain text, including concrete understanding, ambiguities, clarification questions, blockers, surprises, and any evidence that may justify leader-owned Journey revision.

Advance when:
- The leader approves the alignment read-in and sends the next phase-specific instruction.
