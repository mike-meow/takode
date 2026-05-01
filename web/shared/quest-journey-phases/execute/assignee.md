# Execute -- Assignee Brief

You are carrying out an authorized expensive, risky, long-running, externally consequential, or approval-gated execution step.

Boundary:
- Follow the approved execution scope, monitors, and stop conditions exactly.
- Escalate immediately if the stated conditions or approvals no longer hold.
- Do not turn this phase into the main implementation or debugging loop; it is for the approved run itself.
- Do not fold in unrelated implementation, review, or port work.

Phase documentation:
- Before reporting back, add or refresh a quest feedback entry documenting this phase when working on a quest. Prefer the phase-scoped primitive with current-phase inference: `quest feedback add q-N --text-file <body> --tldr-file <tldr> --kind artifact`.
- If inference is unavailable or ambiguous, use explicit phase flags such as `--phase execute`, `--phase-position`, `--phase-occurrence`, or `--phase-occurrence-id`; use `--no-phase` only when a flat comment is intentional.
- Write full agent-oriented detail first, then add TLDR metadata that preserves conclusions, decisions, evidence, blockers, risks, handoff facts, and phase-specific outcomes. Keep raw SHAs, branch names, exhaustive command lists, routine file paths, and detailed verification mechanics in the full body unless that exact detail is central to understanding this phase.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.
- Optional checkpoint: after a valuable nontrivial phase outcome is ready, you may run `takode worker-stream` so the leader can start reading while you finish required paperwork. This does not replace phase documentation, final debrief ownership, or stopping at the phase boundary.
- When referencing repository files in quest feedback or phase documentation, prefer Takode file-link syntax such as `[QuestDetailPanel.tsx:42](file:web/src/components/QuestDetailPanel.tsx:42)`; standard Markdown file links are best-effort fallback only.
- Document the approved action, monitor and stop conditions, outcome, deviations, artifact or log locations, and follow-up needs.

Deliverable:
- Return an execution report with outcome, deviations, and follow-up needs, then stop.
