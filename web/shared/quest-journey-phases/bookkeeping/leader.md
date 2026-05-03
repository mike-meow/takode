# Bookkeeping -- Leader Brief

Use this phase when durable shared state must be updated as a first-class step.

Bookkeeping is for cross-phase or external durable state beyond normal phase notes: consolidated summaries, final debrief metadata after port when the port worker could not reliably create it, verification checklist reconciliation, external docs or links, superseded facts, notification cleanup, thread cleanup, or shared-state updates. Do not dispatch Bookkeeping just to repeat the documentation a phase actor should already write.

Leader actions:
- Keep the board row in `BOOKKEEPING`.
- Include the exact assignee brief path in the instruction: `~/.companion/quest-journey-phases/bookkeeping/assignee.md`.
- Define exactly which shared facts, locations, or handoff records must be updated.
- Use this phase as the fallback owner for final debrief metadata when Port is omitted, when a Port worker cannot reliably draft it, or when leader-owned completion after Outcome Review lacks enough consolidated context. Require both a final debrief and debrief TLDR before completing a non-cancelled quest.
- Treat superseded or stale facts as part of the bookkeeping scope.
- Require the assignee to add or refresh phase documentation before the phase handoff. It should use phase-scoped quest feedback with full agent-oriented detail plus TLDR metadata when working on a quest, falling back to explicit `--phase bookkeeping` if current-phase inference is unavailable.
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- Advance only when the shared state is current.
