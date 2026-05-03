---
name: quest-journey-bookkeeping
description: "Quest Journey phase: bookkeeping. Use when durable shared external state must be recorded and refreshed."
---

# Quest Journey Phase: Bookkeeping

This phase records cross-phase or external durable state beyond normal phase notes: consolidated summaries, final debrief metadata after port when the port worker could not reliably create it, final debrief metadata when Port is omitted or leader-owned completion after Outcome Review needs consolidation, verification checklist reconciliation, external docs or links, superseded facts, notification cleanup, thread cleanup, and shared-state updates.

Leader actions:
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- Specify what durable state must be updated and where it must live.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/bookkeeping/assignee.md`.
- When Bookkeeping is assigned for completion metadata, require both a final debrief and debrief TLDR before the non-cancelled quest is completed.
- Keep the board row in `BOOKKEEPING`.
- Use this phase when the main remaining work is state capture rather than more implementation or review.

Worker-visible boundary:
- The worker may update durable coordination state and consolidate the current facts for the next reader.
- If the assigned durable state is final completion metadata, the worker should produce or apply both the final debrief and debrief TLDR. Completion remains incomplete until both are present.
- Do not duplicate normal phase documentation from the phase that produced the facts.
- The worker should not invent new implementation scope inside this phase.
- Before reporting back, the worker should document the Bookkeeping phase on the quest with records updated, superseded facts, external locations, durable handoff facts, and TLDR metadata. Prefer `quest feedback add q-N --text-file ... --tldr-file ... --kind phase-summary`; use explicit `--phase bookkeeping` or occurrence flags if current-phase inference is unavailable.
- The TLDR should preserve conclusions, decisions, evidence, blockers, risks, handoff facts, and phase-specific outcomes. Keep raw SHAs, branch names, exhaustive command lists, routine paths, and detailed verification mechanics in the full body unless central to understanding.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.

Exit evidence:
- Durable state is current, discoverable, and consistent with the latest accepted result.

Advance when:
- The required shared state is recorded and the leader is ready for the next phase or completion path.
