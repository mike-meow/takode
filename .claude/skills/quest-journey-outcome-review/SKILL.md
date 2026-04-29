---
name: quest-journey-outcome-review
description: "Quest Journey phase: outcome-review. Use when a reviewer should make an acceptance judgment on external behavior, metrics, logs, runs, or UX evidence."
---

# Quest Journey Phase: Outcome Review

This phase is a reviewer-owned acceptance pass over external or non-code outcomes.

Leader actions:
- Define the evidence to inspect: metrics, logs, datasets, run artifacts, prompt behavior, UX notes, or operational state.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/outcome-review/assignee.md`.
- Tell fresh reviewers to load the essential skills/context for the target first: `quest` when reviewing quest state or feedback, and `takode-orchestration` when inspecting prior sessions or cross-session history.
- Keep the board row in `OUTCOME_REVIEWING`.
- Treat this as an acceptance phase after the worker has usually produced the evidence first.
- Decide whether the result is sufficient, needs more approved runs, needs behavior/code changes, or requires a Journey revision.

Reviewer-visible boundary:
- Load essential target context before judging: `quest` for quest context, and `takode-orchestration` for prior messages, sessions, or cross-session history.
- Judge whether the observed outcome satisfies the goal.
- Do not collapse this into code quality review when the real question is outcome quality.
- You may rerun only small bounded checks or repros needed for acceptance; do not become the primary experiment owner or repeated iteration loop.

Exit evidence:
- A conclusion grounded in external evidence, with concrete pass/fail rationale and any specific gap to route back.

Advance when:
- The leader accepts the outcome or routes findings back to `implement`, `execute`, or `alignment`.
