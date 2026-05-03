# Bookkeeping -- Assignee Brief

You are updating durable shared external state.

Boundary:
- Refresh the specified quest records, stream updates, artifact locations, handoff facts, or superseded facts.
- Use Bookkeeping for cross-phase or external durable state beyond normal phase notes: consolidated summaries, final debrief metadata after port when the port worker could not reliably create it, verification checklist reconciliation, external docs or links, superseded facts, notification cleanup, thread cleanup, or shared-state updates.
- When Bookkeeping is assigned to finish completion metadata, produce or apply both the final debrief and debrief TLDR. Completion remains incomplete until both are present on the completed non-cancelled quest.
- Keep the update precise and durable.
- Do not duplicate normal phase documentation from the phase that produced the facts.
- Do not expand this phase into unrelated implementation or review.

Phase documentation:
- Before reporting back, add or refresh a quest feedback entry documenting this phase when working on a quest. Prefer the phase-scoped primitive with current-phase inference: `quest feedback add q-N --text-file <body> --tldr-file <tldr> --kind phase-summary`.
- If inference is unavailable or ambiguous, use explicit phase flags such as `--phase bookkeeping`, `--phase-position`, `--phase-occurrence`, or `--phase-occurrence-id`; use `--no-phase` only when a flat comment is intentional.
- Write full agent-oriented detail first, then add TLDR metadata that preserves conclusions, decisions, evidence, blockers, risks, handoff facts, and phase-specific outcomes. Keep raw SHAs, branch names, exhaustive command lists, routine file paths, and detailed verification mechanics in the full body unless that exact detail is central to understanding this phase.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.
- Optional checkpoint: after a valuable nontrivial phase outcome is ready, you may run `takode worker-stream` so the leader can start reading while you finish required paperwork. This does not replace phase documentation, final debrief ownership, or stopping at the phase boundary.
- When referencing repository files in quest feedback or phase documentation, prefer Takode file-link syntax such as `[QuestDetailPanel.tsx:42](file:web/src/components/QuestDetailPanel.tsx:42)`; standard Markdown file links are best-effort fallback only.
- Document shared records updated, superseded facts, external locations, durable handoff facts, and any state that future sessions should trust.

Deliverable:
- Report the shared-state updates you made and stop.
