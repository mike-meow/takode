# Mental Simulation -- Leader Brief

Use this phase when you need scenario-driven abstract end-to-end correctness validation rather than a generic diff review.

Mental Simulation usually works best after implementation exists, or after a design is concrete enough to execute mentally against historical or realistic examples. Actual `EXECUTING` plus `OUTCOME_REVIEWING` is preferred when end-to-end execution is feasible and appropriate; Mental Simulation is useful when real execution is hard, incomplete, high-stakes, or should be reviewed before running.

Leader actions:
- Keep the board row in `MENTAL_SIMULATING`.
- Include the exact assignee brief path in the instruction: `~/.companion/quest-journey-phases/mental-simulation/assignee.md`.
- Tell fresh reviewers to load the essential skills/context for the target first: `quest` when reviewing quest state or feedback, and `takode-orchestration` when inspecting prior sessions or cross-session history.
- Point the reviewer to the exact scenarios, sessions, quests, workflows, or artifacts to simulate.
- Ask for a scenario-grounded review, not a generic correctness pass.
- Revise the remaining Journey if the simulation reveals missing evidence or missing phases.
