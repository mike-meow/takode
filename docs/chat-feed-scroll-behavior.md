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

### 4. Jump-to-bottom behavior

The existing jump-to-bottom button remains the manual way to return to the end
of the conversation.

Clicking it should scroll to the real bottom of the feed so the last rendered
message aligns naturally at the bottom of the viewport.

There is no separate "latest" pill or special new-content indicator in the feed
scroll model.

### 5. Session restore

Saved scroll position restore follows the older proportional model:

- if the user left the session scrolled up, restore that saved position
- if the saved content height has changed, restore proportionally based on the
  old and new scroll heights
- if the user left the session at the bottom, restore to the real bottom

There is no special anchor-restore path tied to the latest user turn.

## Non-goals

- No send-time auto-scroll to place the newest user turn at the top
- No extra scroll runway below the real content
- No dedicated "new content below" pill
- No special session-restore anchor model for running turns

## Expected UX outcome

- When you are reading at the bottom, the chat keeps up with new content.
- When you scroll up, your position stays stable.
- Switching sessions restores the old scroll position or bottom state without
  extra send/runway behavior interfering.
