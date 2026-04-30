---
name: quest-journey-explore
description: "Quest Journey phase: explore. Use when a leader needs evidence or unknowns resolved before deciding how to proceed."
---

# Quest Journey Phase: Explore

This phase gathers unknown information without making the target-state change. Use it when investigation is the deliverable, or when the next route is genuinely unknown.

Leader actions:
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- Tell the worker what unknowns to resolve and what evidence will let you choose the next step.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/explore/assignee.md`.
- Keep the board row in `EXPLORING`.
- Do not insert `explore -> implement` just so a worker can look around before a normal bug fix, docs change, config change, or prompt change; `implement` includes normal investigation, root-cause analysis, code/design reading, and test planning.
- If findings are likely to require a user decision, plan or revise to `user-checkpoint` instead of silently assuming `explore -> implement`.
- Revise the remaining Journey if new risk, evidence, or external-state needs appear.

Worker-visible boundary:
- The worker may inspect code, logs, configs, artifacts, and run small reversible probes.
- The worker should treat Explore as the deliverable or routing decision point, not routine pre-implementation reading.
- The worker must not make major target-state changes, port, or change quest status.
- Before reporting back, the worker should document the Explore phase on the quest with full agent-oriented detail plus TLDR metadata. Prefer `quest feedback add q-N --text-file ... --tldr-file ... --kind phase-finding`; use explicit `--phase explore` or occurrence flags if current-phase inference is unavailable.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.

Exit evidence:
- A concise evidence summary, concrete findings, blockers, surprises, implementation considerations, likely next route, and evidence that may justify leader-owned Journey revision.

Advance when:
- The leader has enough evidence to choose the next phase or revise the Journey.
