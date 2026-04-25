---
name: quest-journey-porting
description: "Quest Journey phase: porting. Use when a leader is advancing accepted reviewed changes into main-repo sync."
---

# Quest Journey Phase: Porting

This phase syncs accepted git-tracked work back to the main repository.

Leader actions:
- Send a separate explicit `/port-changes` instruction only after reviewer acceptance.
- Require the worker report to include `Synced SHAs: sha1,sha2` when sync completes.
- Require the appropriate post-port verification gate.
- Keep the board row in `PORTING`.

Worker-visible boundary:
- The worker ports/syncs the accepted work and reports synced SHAs plus verification.
- The worker should not invent no-code port summaries for true zero-code work.

Exit evidence:
- Ordered synced SHAs from the main repo and required post-port verification results.

Advance when:
- Porting is confirmed. Advancing from this phase removes the board row for final handoff through quest completion mechanics.
