# Chat Feed Scroll Behavior

This file is the source of truth for Takode chat-feed scrolling behavior.

## Goals

- Keep scroll behavior simple and predictable.
- Preserve the user’s reading position when they scroll away from the bottom.
- Follow new content only when the user is already near the bottom.

## Canonical Behavior

### 1. Sending a user message

Sending a new user message does not trigger any special user-turn pinning,
runway creation, or top-alignment behavior.

The new user message is appended to the conversation like any other message.

After send, the feed behaves according to the normal bottom-follow rule:

- if the user was already near the bottom, keep following the bottom
- if the user was scrolled up, preserve their current reading position

There is no dedicated "scroll the new user message to the top" path.

### 2. Bottom-follow rule

The feed maintains a simple sticky-bottom model:

- when the user is near the bottom, new content should keep the feed near the
  bottom
- when the user is not near the bottom, new content should not force the
  viewport to move

Near-bottom detection uses the feed container’s real scroll geometry. There is
no synthetic runway or extra spacer below the real content.

### 3. Streaming behavior

During streaming:

- if the user is near the bottom, the feed may keep up with streaming output
  using immediate bottom alignment
- if the user has scrolled up, do not auto-follow continuously

This preserves the previous behavior where streaming does not interrupt manual
reading once the user has moved away from the bottom.

### 4. Jump-to-bottom and latest-indicator behavior

The existing jump-to-bottom button remains the manual way to return to the end
of the conversation.

Clicking it should scroll to the real bottom of the feed so the last rendered
message aligns naturally at the bottom of the viewport.

The feed may also show a passive "New content below" indicator when:

- the user is no longer sticky to the bottom, and
- newer content has appeared below the last real content bottom they had
  already seen, or
- the feed has restored into an older section window that still has newer
  sections below

The latest indicator is only an affordance to jump back to the real bottom. It
must not change the user’s current scroll position by itself.

Switching away from a session and then back again must not resurrect the latest
indicator purely because the browser restored an older saved baseline. On
session restore, the browser should treat the currently restored content bottom
as the new baseline for that viewing pass.

After a restore, the latest indicator should only appear again when:

- genuinely new content arrives after the restore while the user remains away
  from the bottom, or
- the restored section window still has newer hidden sections below

### 5. Session restore

Saved scroll position restore follows the older proportional model:

- if the user left the session scrolled up, restore that saved position
- if the saved content height has changed, restore proportionally based on the
  old and new scroll heights
- if the user left the session at the bottom, restore to the real bottom

If the user left the session scrolled up, restoring that position must not by
itself imply "new content below". The latest-indicator baseline resets to the
restored content bottom for the new viewing pass.

There is no special anchor-restore path tied to the latest user turn.

### 6. Cold session hydration

When switching to a session whose full history is not yet loaded in the browser:

- the feed should show an explicit `Loading conversation...` state instead of
  the normal empty-conversation UI
- the feed should not look empty and then suddenly populate
- the first authoritative history render should not trigger a visible
  top-to-bottom smooth scroll animation

In practice, this means restore/follow logic should wait until the first
history payload has landed for that session.

## Non-goals

- No send-time auto-scroll to place the newest user turn at the top
- No extra scroll runway below the real content
- No special session-restore anchor model for running turns

## Expected UX outcome

- When you are reading at the bottom, the chat keeps up with new content.
- When you scroll up, your position stays stable.
- Switching sessions restores the old scroll position or bottom state without
  extra send/runway behavior interfering.
- Cold session switches show a loading conversation state instead of a blank
  feed, and history should appear without a disorienting scroll-on-appear.
