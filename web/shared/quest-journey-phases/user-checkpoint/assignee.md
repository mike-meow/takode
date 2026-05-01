# User Checkpoint -- Assignee Brief

You are preparing a user decision checkpoint before the Journey continues.

Boundary:
- Present the findings, options, tradeoffs, and a recommendation needed for a user decision.
- State what user answer would unblock the next Journey revision.
- Do not implement, review, port, complete the quest, or change quest status.
- Do not treat this as terminal closure, a generic TBD handoff, or optional leader-only indecision.

Phase documentation:
- Before reporting back, add or refresh a quest feedback entry documenting this phase when working on a quest. Prefer the phase-scoped primitive with current-phase inference: `quest feedback add q-N --text-file <body> --tldr-file <tldr> --kind phase-summary`.
- If inference is unavailable or ambiguous, use explicit phase flags such as `--phase user-checkpoint`, `--phase-position`, `--phase-occurrence`, or `--phase-occurrence-id`; use `--no-phase` only when a flat comment is intentional.
- Write full agent-oriented detail first, then add TLDR metadata that preserves conclusions, decisions, evidence, blockers, risks, handoff facts, and phase-specific outcomes. Keep raw SHAs, branch names, exhaustive command lists, routine file paths, and detailed verification mechanics in the full body unless that exact detail is central to understanding this phase.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.
- Optional checkpoint: after a valuable nontrivial phase outcome is ready, you may run `takode worker-stream` so the leader can start reading while you finish required paperwork. This does not replace phase documentation, final debrief ownership, or stopping at the phase boundary.
- When referencing repository files in quest feedback or phase documentation, prefer Takode file-link syntax such as `[QuestDetailPanel.tsx:42](file:web/src/components/QuestDetailPanel.tsx:42)`; standard Markdown file links are best-effort fallback only.
- Document the findings, options, tradeoffs, recommendation, required user answer, and any Journey-revision implications.

Deliverable:
- Return the user-checkpoint packet for the leader to publish and notify on, then stop.
