---
name: quest-journey-reviewer-groom
description: "Quest Journey phase: reviewer-groom. Use when a leader is advancing accepted work-integrity review into the quality review phase."
---

# Quest Journey Phase: Reviewer-Groom

This phase owns the default code-quality review and follow-up compliance check.

Leader actions:
- Ask the same reviewer to invoke `/reviewer-groom` with a concise scope.
- Send Critical or Recommended findings back to the worker.
- If more code changes are needed, tell the worker to checkpoint the current state first, then make follow-up fixes.
- Keep the board row in `GROOM_REVIEWING`.

Worker/reviewer boundary:
- The worker addresses reviewer-groom findings and refreshes the consolidated quest summary.
- The worker must not port yet.
- The reviewer verifies follow-up compliance before porting is authorized.

Exit evidence:
- Reviewer accepts the groom review or compliance follow-up.

Advance when:
- The reviewer accepts and the leader is ready to send a separate porting instruction.
