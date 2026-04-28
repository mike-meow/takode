---
name: quest-journey-bookkeeping
description: "Quest Journey phase: bookkeeping. Use when durable shared external state must be recorded and refreshed."
---

# Quest Journey Phase: Bookkeeping

This phase records durable shared state such as quest updates, stream updates, artifact/run locations, handoff facts, and superseded facts.

Leader actions:
- Specify what durable state must be updated and where it must live.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/bookkeeping/assignee.md`.
- Keep the board row in `BOOKKEEPING`.
- Use this phase when the main remaining work is state capture rather than more implementation or review.

Worker-visible boundary:
- The worker may update durable coordination state and consolidate the current facts for the next reader.
- The worker should not invent new implementation scope inside this phase.

Exit evidence:
- Durable state is current, discoverable, and consistent with the latest accepted result.

Advance when:
- The required shared state is recorded and the leader is ready for the next phase or completion path.
