---
name: quest-journey-implementation
description: "Quest Journey phase: implementation. Use when a leader is advancing an approved quest plan into implementation."
---

# Quest Journey Phase: Implementation

This phase authorizes the worker to implement the approved plan.

Leader actions:
- Send an explicit implementation instruction.
- Require the worker to add or refresh the consolidated human-readable quest summary comment.
- Tell the worker to stop and report back after implementation.
- Keep the board row in `IMPLEMENTING`.

Worker-visible boundary:
- The worker may edit, test, and update the quest summary.
- The worker must not run `/reviewer-groom`, `/self-groom`, `/port-changes`, or change quest status.

Exit evidence:
- Worker report, changed files or artifact summary, verification results, and refreshed quest summary.

Advance when:
- The implementation turn ends and the leader is ready to spawn skeptic review.
