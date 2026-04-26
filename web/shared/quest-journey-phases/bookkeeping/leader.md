# Bookkeeping -- Leader Brief

Use this phase when durable shared state must be updated as a first-class step.

Leader actions:
- Keep the board row in `BOOKKEEPING`.
- Define exactly which shared facts, locations, or handoff records must be updated.
- Treat superseded or stale facts as part of the bookkeeping scope.
- Advance only when the shared state is current.
