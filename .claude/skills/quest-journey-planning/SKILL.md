---
name: quest-journey-planning
description: "Quest Journey phase: planning. Use when a leader is dispatching or advancing a quest into the planning phase after the initial Journey has been approved."
---

# Quest Journey Phase: Planning

This phase authorizes planning only. It refines a leader-approved initial Journey into an executable worker plan.

Leader actions:
- Send the standard dispatch message for the quest.
- Approve the initial Journey before this phase begins and keep that Journey on the board.
- Tell the worker to load the quest skill, read and claim the quest, return a plan, then stop.
- Put or keep the board row in `PLANNING`.

Worker-visible boundary:
- The worker may inspect context and propose a plan within the current board-carried Journey.
- If the worker believes the Journey should change, they should recommend a revision in the plan rather than assuming approval for a different phase sequence.
- The worker must not explore, implement, review, execute, port, or change quest status.

Exit evidence:
- A reviewable worker plan is available through `ExitPlanMode` or plain text, including any recommended Journey revision.

Advance when:
- The leader approves the plan and sends the next phase-specific instruction.
