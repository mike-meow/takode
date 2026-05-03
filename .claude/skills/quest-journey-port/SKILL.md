---
name: quest-journey-port
description: "Quest Journey phase: port. Use when accepted tracked changes are ready to sync back to the main repo."
---

# Quest Journey Phase: Port

This phase syncs accepted git-tracked work back to the main repository.

Leader actions:
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- Send a separate explicit `/port-changes` instruction only after the required review or outcome phases are accepted.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/port/assignee.md`.
- Require the worker report to include `Synced SHAs: sha1,sha2` when sync completes.
- Require the appropriate post-port verification gate.
- Ensure final debrief ownership is explicit without adding generic leader bookkeeping: every completed non-cancelled quest needs final debrief metadata and debrief TLDR metadata. If the port worker completes the quest, completion must use `--debrief-file` and `--debrief-tldr-file`; otherwise the worker should return a concise final debrief draft plus TLDR draft, or the leader should route a focused Bookkeeping phase when the debrief cannot be produced reliably from Port context.
- Keep the board row in `PORTING`.

Worker-visible boundary:
- The worker ports or syncs the accepted work and reports synced SHAs plus verification.
- The worker should not invent port summaries for zero-tracked-change quests whose explicit Journey omitted `port`.
- A Port handoff without either submitted final debrief metadata or a final debrief/TLDR draft is incomplete.
- Before reporting back, the worker should document the Port phase on the quest with ordered synced SHAs, post-port verification, port anomalies, remaining sync risks, final debrief metadata status or draft, and TLDR metadata. Prefer `quest feedback add q-N --text-file ... --tldr-file ... --kind phase-summary`; use explicit `--phase port` or occurrence flags if current-phase inference is unavailable.
- The TLDR should preserve conclusions, decisions, evidence, blockers, risks, handoff facts, and phase-specific outcomes. Keep raw SHAs, branch names, exhaustive command lists, routine paths, and detailed verification mechanics in the full body unless central to understanding.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.

Exit evidence:
- Ordered synced SHAs from the main repo, required post-port verification results, and final debrief metadata status or draft.

Advance when:
- Porting is confirmed. Advancing from this phase removes the board row for final handoff through quest completion mechanics.
