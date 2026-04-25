---
name: quest-journey-skeptic-review
description: "Quest Journey phase: skeptic review. Use when a leader is advancing implemented work into work-integrity review."
---

# Quest Journey Phase: Skeptic Review

This phase checks work integrity before code-quality review or no-code completion.

Leader actions:
- Spawn or reuse the quest reviewer.
- The reviewer prompt must explicitly say: `Use the installed /skeptic-review workflow for this review.`
- Keep the board row in `SKEPTIC_REVIEWING`.

Reviewer-visible boundary:
- The reviewer evaluates whether the worker actually satisfied the quest and did not take shortcuts.
- The reviewer should not drift into the reviewer-groom code-quality pass.

Exit evidence:
- Reviewer returns `ACCEPT`, or `CHALLENGE` with specific issues.

Advance when:
- On `ACCEPT`, continue to reviewer-groom for git-tracked changes.
- For true zero-code work explicitly marked `--no-code`, use `takode board advance-no-groom` instead.
