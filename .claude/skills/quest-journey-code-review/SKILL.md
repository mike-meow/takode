---
name: quest-journey-code-review
description: "Quest Journey phase: code-review. Use when tracked code or tracked artifacts need quality, correctness, and regression review."
---

# Quest Journey Phase: Code Review

This phase reviews tracked code or tracked artifacts for landing risk.

Leader actions:
- Provide only deltas the assignee is unlikely to infer from the phase brief, quest record, current artifacts, or their own context: exact accepted refs, unusual scope boundaries, nonstandard verification, safety warnings, or facts unavailable to that actor. Avoid restating generic closure checklists covered by the brief.
- Assign a reviewer and define the concrete review scope.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/code-review/assignee.md`.
- Tell fresh reviewers to load the essential skills/context for the target first: `quest` when reviewing quest state or feedback, and `takode-orchestration` when inspecting prior sessions or cross-session history.
- Expect a comprehensive landing-risk review of correctness, regressions, tests, maintainability, quest hygiene, implementation completeness, and meaningful evidence, while keeping reviewers out of implementation and porting.
- Require reviewers to judge phase documentation quality, not just presence: phase relevance, useful full detail, TLDR completeness where appropriate, and correct phase association when the primitive is available.
- Send findings back to the worker when rework is needed. If the worker must change code after review, require the worker to commit the current worktree state, make the fixes in a separate follow-up commit, and send the changed worktree back to Code Review only after that checkpoint exists. This lets the reviewer inspect a clean incremental diff and does not apply to purely read-only follow-up review discussion.
- Keep the board row in `CODE_REVIEWING`.

Reviewer-visible boundary:
- Load essential target context before judging: `quest` for quest context, and `takode-orchestration` for prior messages, sessions, or cross-session history.
- Start from the tracked diff, quest record, worker report, and verification evidence. Inspect untracked files when status shows they are part of the worker's change.
- Before judging the result, write down the review aspects that are relevant for this change. Cover correctness, regression risk, tests, maintainability, quest hygiene, implementation completeness, and meaningful evidence review unless a category is genuinely irrelevant; say why skipped categories are irrelevant.
- Report substantive bugs, missing coverage, unsupported verification, design/maintainability risks, incomplete implementation, and quest-hygiene gaps that matter for landing.
- Do not become the implementer, porter, or redesign owner. You may directly fix only small quest-hygiene issues already supported by the workflow, such as stale addressed flags, refreshable summaries, or verification checks backed by evidence.
- Before reporting back, the reviewer should document the Code Review phase on the quest with full agent-oriented detail plus TLDR metadata. Prefer `quest feedback add q-N --text-file ... --tldr-file ... --kind review`; use explicit `--phase code-review` or occurrence flags if current-phase inference is unavailable.
- The TLDR should preserve conclusions, decisions, evidence, blockers, risks, handoff facts, and phase-specific outcomes. Keep raw SHAs, branch names, exhaustive command lists, routine paths, and detailed verification mechanics in the full body unless central to understanding.
- Apply a value filter: include facts future readers or sessions would actually need; avoid boilerplate, facts obvious from the final artifact, and substantial duplication across phases.
- If context was compacted during this phase, or if memory confidence is low, reconstruct the relevant facts with `takode scan`, `takode peek`, `takode read`, quest feedback, and local artifacts before documenting. If context is intact, use working memory and current artifacts instead of unnecessary session archaeology.

Exit evidence:
- Reviewer acceptance or concrete findings that the worker must address.

Advance when:
- The reviewer accepts, or the leader has routed the findings back through the rework loop and re-run the review.
