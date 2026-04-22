# `web/server/bridge/`

Extracted subsystems used by `ws-bridge.ts`.

This directory isolates high-churn logic from the main bridge file to keep
protocol routing readable and testable. Each controller operates on narrow
interfaces rather than full bridge state.

## Files

### Transport

- [browser-transport-controller.ts](./browser-transport-controller.ts)
  - Browser WebSocket transport layer, history sync hashing, session tagging.

- [claude-cli-transport-controller.ts](./claude-cli-transport-controller.ts)
  - Claude CLI WebSocket transport layer.

- [adapter-browser-routing-controller.ts](./adapter-browser-routing-controller.ts)
  - Routes incoming browser messages (with auto-approval evaluation and
    attachment path handling) to the active backend adapter.

- [adapter-interface.ts](./adapter-interface.ts)
  - Shared backend adapter contract consumed by `ws-bridge`.
  - Defines optional capability interfaces (`TurnStartFailedAwareAdapter`,
    `CurrentTurnIdAwareAdapter`, `RateLimitsAwareAdapter`).

### Permissions

- [permission-pipeline.ts](./permission-pipeline.ts)
  - Permission request normalization and policy flow:
    - mode-based auto-approve rules
    - sensitive path/command guards
    - LLM auto-approval eligibility and queuing
    - human-review fallback path

- [permission-response-controller.ts](./permission-response-controller.ts)
  - Handles permission responses from browser back to the backend.

- [permission-summaries.ts](./permission-summaries.ts)
  - Formats permission request summaries (including Codex image drafts).

- [settings-rule-matcher.ts](./settings-rule-matcher.ts)
  - Matches SDK permission requests against settings.json rules.

### Lifecycle & state

- [generation-lifecycle.ts](./generation-lifecycle.ts)
  - Turn lifecycle state machine:
    - `running`/`idle` transitions
    - optimistic running timeout behavior
    - interruption metadata
    - turn start/end Takode event emission

- [session-registry-controller.ts](./session-registry-controller.ts)
  - In-memory registry of active sessions.

- [session-git-state.ts](./session-git-state.ts)
  - Reads git state (branch, status) for a session's worktree.

- [context-usage.ts](./context-usage.ts)
  - Context window token usage tracking.

- [branch-session-index.ts](./branch-session-index.ts)
  - Indexes sessions by git branch for fast lookup.

- [board-watchdog-controller.ts](./board-watchdog-controller.ts)
  - Watches for stuck/stalled sessions and triggers recovery.

### Message processing

- [claude-message-controller.ts](./claude-message-controller.ts)
  - Processes messages from the Claude CLI and translates them into session events.

- [result-message-controller.ts](./result-message-controller.ts)
  - Processes and emits final result messages for a turn.

- [system-message-controller.ts](./system-message-controller.ts)
  - Handles system-level messages (init, reconnect signals).

- [quest-detector.ts](./quest-detector.ts)
  - Detects quest lifecycle signals from command text and tool result output.
  - Produces structured quest events used by bridge reconciliation code.

### Codex-specific

- [codex-adapter-browser-message-controller.ts](./codex-adapter-browser-message-controller.ts)
  - Routes browser messages specifically to the Codex adapter.

- [codex-recovery-orchestrator.ts](./codex-recovery-orchestrator.ts)
  - Handles resume/recovery snapshots for Codex turns after failures.

- [codex-turn-queue.ts](./codex-turn-queue.ts)
  - Queues and drains Codex turns, coordinating ordering across reconnects.

- [claude-sdk-adapter-lifecycle-controller.ts](./claude-sdk-adapter-lifecycle-controller.ts)
  - Lifecycle management (connect, reconnect, teardown) for the Claude SDK adapter.

### Recovery

- [compaction-recovery.ts](./compaction-recovery.ts)
  - Handles recovery after context compaction events.

- [tool-result-recovery-controller.ts](./tool-result-recovery-controller.ts)
  - Recovers stuck tool-result state across backend reconnects.

## How it fits with `ws-bridge.ts`

- `ws-bridge.ts` remains the orchestrator.
- Modules here provide deterministic, reusable logic blocks that operate on
  narrow interfaces rather than full bridge state.
- This lets bridge tests validate behavior at two levels:
  - subsystem-level tests for focused logic
  - end-to-end bridge tests for integration behavior

## Design intent

- Keep backend protocol adapters interchangeable via a stable interface.
- Keep lifecycle and permission policies centralized, not duplicated across adapters.
- Make future bridge refactors safer by reducing monolithic branching in `ws-bridge.ts`.

## Typical call paths

- Incoming backend message:
  - adapter parses backend payload
  - adapter emits `BrowserIncomingMessage` callback
  - `ws-bridge.ts` applies state changes and may call lifecycle/policy helpers here
  - bridge broadcasts authoritative event(s) to browser sessions

- Incoming permission request:
  - bridge normalizes backend payload
  - `permission-pipeline.ts` decides mode-auto-approve vs queue-human vs queue-LLM
  - bridge continues with approval or pending-permission updates

- Generation state update:
  - bridge calls `setGenerating`/`markRunningFromUserDispatch`
  - helper updates turn metadata and emits turn_start/turn_end side effects
  - bridge persists and broadcasts status changes

## Maintenance notes

- Keep these modules pure-ish where possible (small interfaces, explicit deps).
- Add focused tests near behavior changes before editing bridge integration code.
- If a helper needs wide bridge context, prefer adding a narrow interface instead.
