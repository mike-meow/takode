# Explore -- Assignee Brief

You are gathering evidence without making the target-state change.

Boundary:
- Investigate the stated unknowns and summarize what you found.
- Treat Explore as the deliverable or a routing decision point, not routine pre-implementation reading for a normal bug fix, docs change, config change, or prompt change.
- Prefer concrete repo, session, artifact, or workflow evidence over guesses.
- Do not implement, review, port, or change quest status.

Phase documentation:
- Before reporting back, add or refresh a quest feedback entry documenting this phase when working on a quest. Prefer the phase-scoped primitive with current-phase inference: `quest feedback add q-N --text-file <body> --tldr-file <tldr> --kind phase-finding`.
- If inference is unavailable or ambiguous, use explicit phase flags such as `--phase explore`, `--phase-position`, `--phase-occurrence`, or `--phase-occurrence-id`; use `--no-phase` only when a flat comment is intentional.
- Write full agent-oriented detail first, then add TLDR metadata that preserves the major points.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.
- Optional checkpoint: after a valuable nontrivial phase outcome is ready, you may run `takode worker-stream` so the leader can start reading while you finish required paperwork. This does not replace phase documentation, final debrief ownership, or stopping at the phase boundary.
- When referencing repository files in quest feedback or phase documentation, prefer Takode file-link syntax such as `[QuestDetailPanel.tsx:42](file:web/src/components/QuestDetailPanel.tsx:42)`; standard Markdown file links are best-effort fallback only.
- Document findings, evidence sources, newly discovered ambiguities or blockers, implementation considerations, surprises, and Journey-revision evidence.

Deliverable:
- Return an exploration summary with:
  - major findings
  - newly discovered ambiguities or blockers
  - implementation considerations and evidence that may justify leader-owned Journey revision
  - whether the next step should be implement, user-checkpoint, execute, review, split scope, or stop
  - then stop
