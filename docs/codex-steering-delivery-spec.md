# Codex Steering And Delivery Spec

This document is the source of truth for how Takode sends user messages to
Codex sessions.

It defines:

- when a message is considered pending
- when a message is considered delivered
- when a message becomes committed chat history
- how steering works during an active turn
- how explicit Stop behaves

## Scope

This spec applies to Codex-backed sessions only.

Claude and Claude SDK sessions keep their own delivery semantics.

## Core model

Takode must distinguish three separate states for Codex user input:

1. `accepted`
2. `delivered`
3. `committed`

Definitions:

- `accepted`
  Takode has accepted the user's input from the UI.
- `delivered`
  Codex has actually received that input through `turn/start` or `turn/steer`.
- `committed`
  The input is written into Takode's authoritative chat history as a normal
  user message.

These states must not be conflated.

## Authoritative rule

A Codex follow-up user message must not become a normal chat-history entry until
Takode knows Codex has actually received it.

Before delivery, it exists only as pending input plus lightweight UI state.

## Pending input

Takode must persist undelivered Codex user input separately from committed chat
history.

Suggested shape:

```ts
interface PendingCodexInput {
  id: string;
  createdAt: number;
  content: string;
  images?: LocalImageRef[];
  vscodeSelection?: VsCodeSelectionMetadata;
  source: "user" | "leader" | "system";
}
```

Per-session state should include:

```ts
pendingCodexInputs: PendingCodexInput[];
```

Ordering requirements:

- preserve input order exactly
- never silently drop a pending message
- if multiple pending messages are still unseen by Codex, later delivery must
  preserve their original order

## Delivery modes

Takode supports two conceptual behaviors for active Codex sessions:

- `steer`
- `queue`

Default behavior should be `steer`.

`queue` remains available as an explicit behavior when desired, but it must not
be the default semantics for normal follow-up input.

## Connected idle session

If Codex is connected and no turn is active:

- collect all pending undelivered inputs in order
- send them together in one `turn/start`
- once the transport accepts that send:
  - mark them delivered
  - commit them to Takode chat history in the same order

## Connected active turn

If Codex is connected and an active turn exists:

- collect all pending undelivered inputs in order
- send them together using `turn/steer`
  with:
  - `threadId`
  - `input`
  - `expectedTurnId`
- once the transport accepts that send:
  - mark them delivered
  - commit them to Takode chat history in the same order

Important:

- if a new steer message arrives before the current undelivered pending batch
  has been sent, both old and new pending messages must be sent together in the
  next steer payload
- no unseen pending message may be discarded or replaced

## Active turn before turn id is known

There is a narrow window where Takode knows a turn is being started but does
not yet know the active `turnId`.

During that window:

- newly accepted follow-up messages remain pending only
- they do not become committed history
- once `turn/started` arrives and `turnId` is known, flush the full pending
  batch through `turn/steer`

## Disconnected or reconnecting session

If Codex is not currently able to receive input:

- keep all accepted input in `pendingCodexInputs`
- do not commit it to chat history
- after reconnect:
  - if the resumed thread still has an active steerable turn, deliver the full
    pending batch through `turn/steer`
  - otherwise deliver the full pending batch through `turn/start`

This preserves delivery robustness across disconnects and relaunches.

## Explicit Stop semantics

When the user presses Stop:

- send `turn/interrupt` immediately
- do not automatically send any pending inputs
- do not automatically start a new turn
- leave all undelivered pending inputs visible as pending in the UI

Stop means stop.

It must never implicitly replay stale queued input into a new Codex turn.

## After Stop

If the user does nothing else:

- the interrupted turn ends
- the session becomes idle
- pending undelivered inputs remain pending only

If the user later sends a new message while pending inputs already exist:

- append the new message to the pending input list
- when Codex is next able to receive input, deliver the entire pending batch in
  order

If the session is idle at that point:

- use `turn/start`

If a new active turn exists at that point:

- use `turn/steer`

## Chat history rules

### Committed messages

Committed user messages are those Takode knows Codex has actually received.

Committed messages:

- appear as normal user entries in the chat feed
- are written into authoritative session history
- survive reconnect and restart as normal history

### Pending messages

Pending messages:

- must not appear as normal committed chat entries
- must not be written into authoritative committed chat history yet
- must survive reconnect and restart as pending state

## Pending-message UI

Pending undelivered Codex messages should render in the chat feed as compact
pending chips.

Requirements:

- one-line display
- truncate overflow
- small visual footprint
- maintain chronological order
- each chip includes a cancel control

Cancel behavior:

- remove that message from the pending input list
- place the full message content back into the composer
- leave remaining pending messages in order

Pending chips are UI for accepted-but-undelivered input. They are not committed
history.

## Steering visibility

A steering message becomes visible to the model only when delivered through
`turn/steer`.

Takode must not represent a pending steer message as committed user history
before delivery, because doing so makes the Takode transcript disagree with what
Codex has actually seen.

## Failure handling

### `turn/steer` expected-turn mismatch

If `turn/steer` fails because `expectedTurnId` no longer matches:

- keep all involved inputs pending
- refresh active-turn state
- if no active turn remains, send pending inputs via `turn/start`
- if a different active turn exists and the earlier steer definitely was not
  delivered, retry `turn/steer` against the new active turn

### `turn/steer` unsupported or unavailable

If steering cannot be used:

- keep inputs pending
- fall back to the next valid delivery opportunity
- do not silently convert accepted pending input into committed history

### Transport disconnect during send

If transport fails during delivery:

- keep the affected inputs pending
- do not commit them
- retry after reconnect

## Protocol requirements

Takode must support a Codex steering path that can call native `turn/steer`.

At minimum, the implementation needs:

- access to `threadId`
- access to current active `turnId`
- a durable pending-input buffer
- a way to distinguish pending UI state from committed chat history

## Testing requirements

### Steering

1. Active turn, one follow-up message.
2. Active turn, multiple follow-up messages before steer flush.
3. Follow-up arrives before `turn/started`.
4. `turn/steer` mismatch fallback.

### Stop

1. Active turn, pending follow-up exists, user presses Stop.
2. Stop leaves pending input visible but undelivered.
3. User sends a new message after Stop and the full pending batch is delivered
   in order.

### Reconnect robustness

1. Disconnect before pending batch is delivered.
2. Disconnect during steer delivery.
3. Reconnect with active steerable turn.
4. Reconnect without active turn.
5. Server restart with pending inputs still present.

### History correctness

1. Pending inputs are not committed early.
2. Delivered inputs become committed in order.
3. Cancelling a pending chip restores composer text.
4. Takode committed history matches the order of actual Codex delivery.

## Final intended behavior

Takode Codex message sending should behave like this:

- connected + idle: deliver pending batch via `turn/start`
- connected + active turn: deliver pending batch via `turn/steer`
- disconnected: preserve pending batch for later delivery
- explicit Stop: interrupt only, do not auto-deliver pending input
- chat history contains only messages Codex has actually received
- undelivered user input remains visible as pending chips until delivery or
  cancellation
