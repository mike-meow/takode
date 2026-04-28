---
name: quest-journey-port
description: "Quest Journey phase: port. Use when accepted tracked changes are ready to sync back to the main repo."
---

# Quest Journey Phase: Port

This phase syncs accepted git-tracked work back to the main repository.

Leader actions:
- Send a separate explicit `/port-changes` instruction only after the required review or outcome phases are accepted.
- Include the exact assignee brief path: `~/.companion/quest-journey-phases/port/assignee.md`.
- Require the worker report to include `Synced SHAs: sha1,sha2` when sync completes.
- Require the appropriate post-port verification gate.
- Keep the board row in `PORTING`.

Worker-visible boundary:
- The worker ports or syncs the accepted work and reports synced SHAs plus verification.
- The worker should not invent port summaries for zero-tracked-change quests whose explicit Journey omitted `port`.

Exit evidence:
- Ordered synced SHAs from the main repo and required post-port verification results.

Advance when:
- Porting is confirmed. Advancing from this phase removes the board row for final handoff through quest completion mechanics.
