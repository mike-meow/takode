---
name: quest-journey-execute
description: "Quest Journey phase: execute. Use when a leader is authorizing an expensive, risky, long-running, externally consequential, or approval-gated run."
---

# Quest Journey Phase: Execute

This phase runs the approved expensive, risky, long-running, externally consequential, or approval-gated action.

Leader actions:
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- State the owner, artifacts, monitor plan, stop conditions, and alert triggers.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/execute/assignee.md`.
- Keep the board row in `EXECUTING`.
- Use this phase when the worker needs more than cheap local evidence gathering from `implement`.
- Require explicit external-state and bookkeeping expectations when the action finishes.

Worker-visible boundary:
- The worker may run the approved operation and monitor it within the stated risk envelope.
- The worker must escalate when stop conditions or new risks appear.
- This is the phase for the approved run itself, not the main implementation or debugging loop.
- Before reporting back, the worker should document the Execute phase on the quest with approved action, monitors, stop conditions, outcome, deviations, artifacts or logs, follow-up needs, and TLDR metadata. Prefer `quest feedback add q-N --text-file ... --tldr-file ... --kind artifact`; use explicit `--phase execute` or occurrence flags if current-phase inference is unavailable.
- The TLDR should preserve conclusions, decisions, evidence, blockers, risks, handoff facts, and phase-specific outcomes. Keep raw SHAs, branch names, exhaustive command lists, routine paths, and detailed verification mechanics in the full body unless central to understanding.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.

Exit evidence:
- Execution report, artifact/run identifiers, monitor results, and any triggered alerts or stop conditions.

Advance when:
- The execution report is complete and the leader is ready for outcome review, more execute work, bookkeeping, or Journey revision.
