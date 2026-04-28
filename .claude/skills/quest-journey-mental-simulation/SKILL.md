---
name: quest-journey-mental-simulation
description: "Quest Journey phase: mental-simulation. Use when a reviewer should replay a design or workflow against concrete scenarios."
---

# Quest Journey Phase: Mental Simulation

This phase tests a design, workflow, or implementation against concrete real scenarios.

Leader actions:
- Point the reviewer to the exact scenarios, sessions, quests, or artifacts to simulate.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/mental-simulation/assignee.md`.
- Keep the board row in `MENTAL_SIMULATING`.
- Revise the remaining Journey if the simulation exposes missing phases or evidence gaps.

Reviewer-visible boundary:
- Replay the proposal against realistic examples and identify friction, missing primitives, or likely failure modes.
- Do not reduce this to a generic diff review.
- Use this when the question is whether the design or workflow makes sense under replayed scenarios, not whether externally executed evidence is already sufficient.

Exit evidence:
- A scenario-grounded review with concrete examples, risks, and recommendations.

Advance when:
- The leader has enough evidence to accept the design/workflow direction or send rework.
