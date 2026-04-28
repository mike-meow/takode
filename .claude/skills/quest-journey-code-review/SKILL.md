---
name: quest-journey-code-review
description: "Quest Journey phase: code-review. Use when tracked code or tracked artifacts need quality, correctness, and regression review."
---

# Quest Journey Phase: Code Review

This phase reviews tracked code or tracked artifacts for landing risk.

Leader actions:
- Assign a reviewer and define the concrete review scope.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/code-review/assignee.md`.
- Send findings back to the worker when rework is needed.
- Keep the board row in `CODE_REVIEWING`.

Reviewer-visible boundary:
- Review correctness, maintainability, tests, security, regression risk, and obvious quest-hygiene gaps tied to real evidence.
- Do not drift into porting or unrelated redesign work.

Exit evidence:
- Reviewer acceptance or concrete findings that the worker must address.

Advance when:
- The reviewer accepts, or the leader has routed the findings back through the rework loop and re-run the review.
