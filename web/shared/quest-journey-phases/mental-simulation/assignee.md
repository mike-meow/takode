# Mental Simulation -- Assignee Brief

You are replaying a concrete design, workflow, or implementation against concrete scenarios as an abstract end-to-end correctness validation.

Setup:
- Load the essential skills and context for the review target before judging it.
- If reviewing a quest, load the `quest` skill and inspect the quest record or referenced feedback/status directly.
- If the scenario requires prior session history or cross-session coordination facts, load `takode-orchestration` and inspect the referenced messages or sessions directly.
- Prefer the leader-provided scenarios, quests, sessions, and artifacts over broad board inspection. Query board state only when the simulation question depends on current Journey state.

Boundary:
- Trace realistic examples through the relevant sessions, quests, artifacts, or workflow steps.
- Do not reduce this phase to a diff-only review.
- Focus on friction, missing primitives, confusing dispatch boundaries, or likely failure modes.
- This phase usually works best after implementation exists, or after the design is concrete enough to execute mentally against historical or realistic examples.
- Do not reject pre-implementation use when the leader has supplied a concrete enough design and scenarios.
- Prefer actual `EXECUTING` plus `OUTCOME_REVIEWING` when end-to-end execution is feasible and appropriate; use Mental Simulation when real execution is hard, incomplete, high-stakes, or should be reviewed before running.

Phase documentation:
- Before reporting back, add or refresh a quest feedback entry documenting this phase when working on a quest. Prefer the phase-scoped primitive with current-phase inference: `quest feedback add q-N --text-file <body> --tldr-file <tldr> --kind review`.
- If inference is unavailable or ambiguous, use explicit phase flags such as `--phase mental-simulation`, `--phase-position`, `--phase-occurrence`, or `--phase-occurrence-id`; use `--no-phase` only when a flat comment is intentional.
- Write full agent-oriented detail first, then add TLDR metadata that preserves conclusions, decisions, evidence, blockers, risks, handoff facts, and phase-specific outcomes. Keep raw SHAs, branch names, exhaustive command lists, routine file paths, and detailed verification mechanics in the full body unless that exact detail is central to understanding this phase.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.
- Optional checkpoint: after a valuable nontrivial phase outcome is ready, you may run `takode worker-stream` so the leader can start reading while you finish required paperwork. This does not replace phase documentation, final debrief ownership, or stopping at the phase boundary.
- When referencing repository files in quest feedback or phase documentation, prefer Takode file-link syntax such as `[QuestDetailPanel.tsx:42](file:web/src/components/QuestDetailPanel.tsx:42)`; standard Markdown file links are best-effort fallback only.
- Document scenarios replayed, concrete examples, risks, recommendations, confidence limits, and the quest documentation hygiene judgment when reviewing a quest.

Deliverable:
- Return a scenario-grounded review with concrete examples, risks, and recommendations, then stop.
