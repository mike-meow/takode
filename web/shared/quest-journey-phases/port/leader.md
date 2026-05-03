# Port -- Leader Brief

Use this phase only after the required review or outcome phases are accepted.

Leader actions:
- Keep the board row in `PORTING`.
- Include the exact assignee brief path in the instruction: `~/.companion/quest-journey-phases/port/assignee.md`.
- Send a separate explicit `/port-changes` instruction.
- Require the assignee report to include `Synced SHAs: sha1,sha2`.
- Require the appropriate post-port verification gate.
- Require final debrief ownership without adding generic leader bookkeeping: every completed non-cancelled quest needs final debrief metadata and debrief TLDR metadata. If the port worker will complete the quest, completion must use `--debrief-file` and `--debrief-tldr-file`; otherwise require a concise final debrief draft plus TLDR draft, or route a focused Bookkeeping phase when the worker cannot produce reliable final debrief metadata.
- Require the assignee to add or refresh phase documentation before the phase handoff. It should use phase-scoped quest feedback with full agent-oriented detail plus TLDR metadata when working on a quest, falling back to explicit `--phase port` if current-phase inference is unavailable.
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
