# Codex false or unexpected `turn_end`: archaeology and fix history

This document is the durable handoff for the recurring Codex issue where
`turn_end` appears at the wrong time, carries the wrong meaning, or is missing
after a follow-up/correction flow.

As of `2026-03-07`, this bug family is still considered open. Several concrete
sub-cases were fixed, but the broad symptom keeps resurfacing through adjacent
state-machine edges.

Related reading:

- `docs/codex-dropped-user-messages.md`
- `q-61`, `q-75`, `q-135`, `q-137`, `q-146`, `q-155`, `q-164`, `q-168`,
  `q-183`, `q-190`, `q-200`

## Single emission point

Today, `turn_end` is emitted in one place only:
`web/server/bridge/generation-lifecycle.ts`, when `setGenerating(..., false, reason)`
transitions `isGenerating` from `true` to `false`.

That means most archaeology in this area reduces to one question:

- why did some path decide the turn had ended and call `setGenerating(false)`?

## What is expected vs what is actually a bug

Do not treat every interrupted-looking `turn_end` as false.

Expected:

- If a new user message arrives while a Codex turn is active, Codex may
  interrupt the old turn first. That old turn should end with
  `interrupted: true`.
- If a leader sends a correction to a busy worker, there may be two valid
  `turn_end` events:
  - the interrupted old turn
  - the later resumed/completed follow-up turn

Buggy:

- `turn_end` fires even though the agent is still working and no real turn
  boundary happened.
- `turn_end` is synthesized during `system.init`, reconnect, or compaction.
- the interrupted `turn_end` arrives, but the later resumed/completed
  `turn_end` never arrives.
- a stale resume snapshot makes the session look completed or idle even though
  the pending follow-up turn was never really replayed.

## Known symptom buckets

1. False `turn_end` during `system.init` after a fresh user dispatch.
2. False `turn_end` during seamless Codex reconnects that were only token
   refresh, not real relaunches.
3. Wrong interrupt semantics for follow-up turns:
   the event was emitted as success instead of interrupted, or the resumed
   follow-up `turn_end` disappeared.
4. Reconnect and compaction state making stale turns look real, which can
   suppress the needed replay and leave the session seemingly finished.
5. Replay and dedup bugs that make the UI look like a turn restarted or ended
   incorrectly when the deeper bug is stale resume state.

## Evidence trail

Quest and recording references that repeatedly came up:

- `q-135`
  - recording: `/tmp/companion-recordings/2c2bb1a7*_21-43-30*`
  - follow-up user message during an active turn sent `turn/interrupt`,
    disconnected, resumed idle, then never replayed the queued message
- `q-146`
  - recording family: `/tmp/companion-recordings/8dba21f6-b4c9-43d5-b79a-02a7cbb8eb43_*`
  - plan-mode resume snapshot had reasoning-only items; retry logic treated
    that as unsafe and skipped the user turn
- `q-183`
  - recording: `/tmp/companion-recordings/04360832-82f4-4d0f-87ca-d0de97b2fe62_codex_2026-03-06T19-01-27.802Z_243818.jsonl`
  - stale `lastTurn.status = inProgress` with `thread.status = idle`, plus
    replayed assistant messages
- `q-61`
  - recordings later showed that image follow-ups could still reproduce
    disconnect behavior after the first active-turn fix, which mattered because
    the same interrupt/reconnect path fed later false-completion symptoms

## Timeline

| Date | Quest | Commit | What changed | What it did not settle |
| --- | --- | --- | --- | --- |
| 2026-02-24 | `q-61` | `791da9e` | Adapter now interrupts and waits before `turn/start` on top of an active turn; first major active-turn follow-up guard | Prevented one disconnect class, but not stale reconnect, false `turn_end`, or replay problems |
| 2026-02-28 | `q-75` | `3ca8902` | Always emit a result for interrupted Codex turns so the UI can return to idle | Fixed stuck-running after explicit stop; did not address false `turn_end` causes |
| 2026-03-01 | `q-135` | `ac6e042` | Replay queued Codex message after reconnect | Fixed one stuck-after-interrupt path, but reconnect replay duplicates remained |
| 2026-03-02 | `q-155` | `aae8b61` | Stopped `system.init` from force-clearing `isGenerating` when a user turn had just been dispatched | This was the clearest root-cause fix for a fake `turn_end` with no real interrupt |
| 2026-03-02 | adjacent | `5afe1c0` | Preserved `isGenerating` across seamless token-refresh reconnects and skipped `system.init` force-clear for that case | Real relaunches still needed a synthetic interruption after grace expiry |
| 2026-03-02 | `q-146` | `e05cd5c` | Treated reasoning-only/context-compaction resume items as retry-safe; stabilized reconnect loops | Showed the retry heuristic was too coarse, but did not remove all stale-turn cases |
| 2026-03-03 | `q-164` | `48ee35c` | Added interrupt-source attribution (`user`, `leader`, `system`) to `turn_end` | Improved diagnosis; not itself a lifecycle fix |
| 2026-03-03 | adjacent | `d154053` | Debounced `cliResuming` clear so replayed `system.init`/status messages do not leak false compaction events | Primarily compaction-event cleanup, but same replay hazard applies to turn-lifecycle reasoning |
| 2026-03-04 | `q-168` | `a6efbdb` | Added queued-turn lifecycle so a correction interrupt can emit both the interrupted `turn_end` and the later resumed/completed `turn_end` | Important distinction: missing second `turn_end` was a real bug, not noise |
| 2026-03-06 | `q-183` | `00544d2` | Stale-turn guard on `thread/resume`, `thread/status/changed` clears stale `currentTurnId`, replay dedup window fixed | Reconnect snapshots could still be stale enough to need earlier retry ordering |
| 2026-03-07 | `q-190` | `469d583` | Extended replay dedup for compaction-triggered assistant replays | Compaction still had stale-turn ordering risk |
| 2026-03-07 | adjacent | `6f99742` | Retry stale user turn before recovery/synthesis after compaction disconnect; also reasserted compaction is not a turn boundary | Latest major stabilization, but `q-200` exists because false/unexpected `turn_end` reports still persist |

## Prior attempts, superseded fixes, and dead ends

### `q-155` started with the wrong idea

The original framing was "filter out spurious `turn_end` herd events." That was
corrected in quest feedback before the real fix landed: the bad event should not
be emitted at all. `aae8b61` fixed the root cause by preserving
`isGenerating` through `system.init` when a user dispatch was already in flight.

### `q-137` and `q-164` were necessary but not sufficient

They made interrupted turns render honestly and added interrupt-source
attribution. That helped separate real user/leader/system interrupts from fake
completion. They improved observability more than they fixed lifecycle bugs.

### Reconnect fixes were iterative, not one-and-done

- `ac6e042` replayed stale queued messages after reconnect.
- `e05cd5c` taught the retry path that reasoning-only resume items can be safe.
- `00544d2` fixed a stale-turn restore bug and a dedup bug that had partly dead
  code.
- `469d583` extended replay protection to compaction.
- `6f99742` changed the ordering so stale-turn retry runs before partial
  recovery/synthesis.

This area did not have a clean revert cycle. The pattern was partial fixes being
superseded by narrower, more accurate ones.

### Compaction kept impersonating turn-boundary logic

The compaction-related bugs were not always about `turn_end` directly, but they
kept corrupting the same generation state:

- compaction must not call `setGenerating(false, "compaction")`
- replayed compaction statuses during `--resume` must not be treated as new live
  state
- compaction replay can reuse different IDs than reconnect replay

Those are adjacent enough that any future `turn_end` fix has to account for
them.

## Current known status

What the repo now defends against:

- `system.init` after an in-flight user dispatch should not emit a fake
  `turn_end`
- seamless reconnects should not emit `turn_end`
- explicit/user/leader/system interrupts can now be distinguished
- correction flows can legitimately emit two `turn_end` events
- stale `currentTurnId` restoration on reconnect is guarded
- compaction replay has dedicated dedup coverage
- stale-turn retry after compaction runs earlier than it used to

What is still true:

- the broad class is not closed
- reports still conflate several different failure modes
- follow-up messaging, reconnect, compaction, and replay still touch the same
  small state cluster

## Likely hot files

- `web/server/bridge/generation-lifecycle.ts`
  - `setGenerating()`
  - `markRunningFromUserDispatch()`
  - `markTurnInterrupted()`
  - queued-turn state (`queuedTurnStarts`, `queuedTurnReasons`,
    `queuedTurnUserMessageIds`)
- `web/server/ws-bridge.ts`
  - `system.init` handling
  - disconnect grace / `seamlessReconnect`
  - `cliResuming` debounce
  - user-message dispatch and queued-turn tracking
  - Codex resume reconciliation and recovery ordering
- `web/server/codex-adapter.ts`
  - `handleOutgoingUserMessage()`
  - `interruptAndWaitForTurnEnd()`
  - `thread/resume` current-turn restoration
  - `handleThreadStatusChanged()`
  - `handleTurnCompleted()`
- `web/server/herd-event-dispatcher.ts`
  - only for formatting/delivery, but easy to blame incorrectly when the real
    bug is upstream lifecycle state
- `web/server/ws-bridge.test.ts`
- `web/server/codex-adapter.test.ts`

## Pitfalls for the later fix

- Do not "fix" this by filtering events in herd formatting first.
  - `q-155` already showed that the right fix is usually in lifecycle state,
    not display logic.
- Do not assume a follow-up message with `interrupted: true` is wrong.
  - On Codex, that can be expected behavior.
- Do not forget that one correction flow may need two real `turn_end` events.
- Do not clear `isGenerating` during:
  - `system.init` for an in-flight dispatch
  - seamless reconnect
  - compaction
- Do not restore `currentTurnId` from `lastTurn.status = inProgress` without
  checking thread-level status.
- Do not run recovery/synthesis before deciding whether the resumed turn is
  definitively stale.
- Do not clear `cliResuming` on the first replayed `system.init`.
- Do not diagnose only from the chat feed.
  - replay duplication, stuck tool previews, and stale idle/running state can
    make the UI look like a false `turn_end` when the underlying bug is
    elsewhere.

## Existing regression coverage worth reading first

- `web/server/ws-bridge.test.ts`
  - `handleCLIMessage: system.init does not emit turn_end for an in-flight user dispatch`
  - `Seamless CLI reconnect preserves isGenerating`
  - `marks turn_end as interrupted when a new user_message arrives during a running codex turn`
  - `emits both interrupted and resumed turn_end events after correction, with herd delivery for each`
  - `cliResuming debounce prevents false compaction events on --resume replay`
  - `watchdog synthesizes interruption when codex stays disconnected`
- `web/server/codex-adapter.test.ts`
  - `does NOT set currentTurnId when thread/resume returns inProgress turn but thread is idle`
  - `thread/status/changed idle clears stale currentTurnId`
  - interrupt-before-new-`turn/start` tests

## Checklist for the later fix

1. Reproduce and classify the exact failure.
   - Was the bad event a fake `turn_end`, a missing second `turn_end`, or a
     legitimate interrupted event that was merely mislabeled?
2. Start from raw evidence, not UI impressions.
   - Check `/tmp/companion-recordings/`
   - Check the relevant `~/.companion/sessions/*.history.jsonl` file if the
     recording is ambiguous
3. Inspect current state variables at the moment the bad event was emitted.
   - `isGenerating`
   - `interruptedDuringTurn`
   - `interruptSourceDuringTurn`
   - `queuedTurnStarts`
   - `seamlessReconnect`
   - `cliResuming`
   - Codex `currentTurnId`
   - resumed `threadStatus`
4. Confirm whether a real interrupt actually happened.
   - user stop
   - leader correction
   - system disconnect timeout
   - none of the above
5. For follow-up/correction flows, verify whether the resumed turn ever started.
   - missing second `turn_end` usually means queued-turn lifecycle or replay
     state, not herd formatting
6. Add the regression test before patching.
   - prefer `ws-bridge.test.ts` for lifecycle/event bugs
   - prefer `codex-adapter.test.ts` for `currentTurnId` and interrupt sequencing
7. Keep the fix narrow.
   - this area regresses easily because reconnect, replay, compaction, and
     follow-up dispatch all share the same state transitions

## Bottom line

The important distinction is not "did a `turn_end` happen?" but "was there a
real turn boundary that justified it?"

The recurring failures in this area have mostly come from state transitions that
masqueraded as turn boundaries:

- `system.init`
- seamless reconnect
- stale resume snapshots
- compaction replay

Start from that distinction before changing any code.
