---
name: quest-journey-execute
description: "Quest Journey phase: execute. Use when a leader is authorizing an expensive, risky, long-running, externally consequential, or approval-gated run."
---

# Quest Journey Phase: Execute

This phase runs the approved expensive, risky, long-running, externally consequential, or approval-gated action.

Leader actions:
- State the owner, artifacts, monitor plan, stop conditions, and alert triggers.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/execute/assignee.md`.
- Keep the board row in `EXECUTING`.
- Use this phase when the worker needs more than cheap local evidence gathering from `implement`.
- Require explicit external-state and bookkeeping expectations when the action finishes.

Worker-visible boundary:
- The worker may run the approved operation and monitor it within the stated risk envelope.
- The worker must escalate when stop conditions or new risks appear.
- This is the phase for the approved run itself, not the main implementation or debugging loop.

Exit evidence:
- Execution report, artifact/run identifiers, monitor results, and any triggered alerts or stop conditions.

Advance when:
- The execution report is complete and the leader is ready for outcome review, more execute work, bookkeeping, or Journey revision.
