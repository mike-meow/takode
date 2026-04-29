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

Deliverable:
- Return a scenario-grounded review with concrete examples, risks, and recommendations, then stop.
