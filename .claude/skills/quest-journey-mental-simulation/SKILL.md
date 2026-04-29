---
name: quest-journey-mental-simulation
description: "Quest Journey phase: mental-simulation. Use when a reviewer should replay a design or workflow against concrete scenarios."
---

# Quest Journey Phase: Mental Simulation

This phase tests a concrete design, workflow, or implementation against concrete real scenarios as an abstract end-to-end correctness validation.

Mental Simulation usually works best after implementation exists, or after a design is concrete enough to execute mentally against historical or realistic examples. Actual `EXECUTING` plus `OUTCOME_REVIEWING` is preferred when end-to-end execution is feasible and appropriate; use Mental Simulation when real execution is hard, incomplete, high-stakes, or should be reviewed before running.

Leader actions:
- Point the reviewer to the exact scenarios, sessions, quests, or artifacts to simulate.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/mental-simulation/assignee.md`.
- Tell fresh reviewers to load the essential skills/context for the target first: `quest` when reviewing quest state or feedback, and `takode-orchestration` when inspecting prior sessions or cross-session history.
- Keep the board row in `MENTAL_SIMULATING`.
- Revise the remaining Journey if the simulation exposes missing phases or evidence gaps.

Reviewer-visible boundary:
- Load essential target context before judging: `quest` for quest context, and `takode-orchestration` for prior messages, sessions, or cross-session history.
- Replay the proposal against realistic examples and identify friction, missing primitives, or likely failure modes.
- Do not reduce this to a generic diff review.
- Use this when the question is whether the design, workflow, or implementation makes sense under replayed scenarios, not when externally executed evidence is feasible and already sufficient.
- Pre-implementation simulation is still valid when the design is concrete enough to execute mentally.

Exit evidence:
- A scenario-grounded review with concrete examples, risks, and recommendations.

Advance when:
- The leader has enough evidence to accept the design/workflow direction or send rework.
