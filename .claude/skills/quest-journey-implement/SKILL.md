---
name: quest-journey-implement
description: "Quest Journey phase: implement. Use when a leader is advancing an approved plan into code, docs, prompts, config, or artifact changes."
---

# Quest Journey Phase: Implement

This phase authorizes the worker to make the approved low-risk changes and gather cheap, local, reversible evidence when that evidence stays inside the approved scope.

Leader actions:
- Send an explicit implementation instruction.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/implement/assignee.md`.
- Require the worker to add or refresh the consolidated human-readable quest summary comment.
- Tell the worker to stop and report back after implementation.
- Keep the board row in `IMPLEMENTING`.

Worker-visible boundary:
- The worker may edit, test, run low-risk local actions, gather cheap local evidence, and update the quest summary.
- Expensive, risky, long-running, externally consequential, or approval-gated runs belong in `execute`, not `implement`.
- The worker must not run review workflows, port, or change quest status.

Exit evidence:
- Worker report, changed files or artifact summary, verification results, and refreshed quest summary.

Advance when:
- The implementation turn ends and the leader is ready to choose the next review, execute, bookkeeping, or port phase.
