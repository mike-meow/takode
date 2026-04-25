---
name: quest-journey-planning
description: "Quest Journey phase: planning. Use when a leader is dispatching or advancing a quest into the planning phase."
---

# Quest Journey Phase: Planning

This phase authorizes planning only.

Leader actions:
- Send the standard dispatch message for the quest.
- Tell the worker to load the quest skill, read and claim the quest, return a plan, then stop.
- Put or keep the board row in `PLANNING`.

Worker-visible boundary:
- The worker may inspect context and propose a plan.
- The worker must not implement, review, port, or change quest status.

Exit evidence:
- A reviewable worker plan is available through `ExitPlanMode` or plain text.

Advance when:
- The leader approves the plan and sends an implementation-only instruction.
