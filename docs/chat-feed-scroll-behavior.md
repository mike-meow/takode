# Chat Feed Scroll Behavior

This file is the source of truth for Takode chat-feed scrolling behavior.

## Goals

- Keep the newest user message stable at the top of the viewport after send.
- Avoid continuous auto-follow during assistant streaming.
- Preserve manual navigation controls for following the latest content.

## Canonical Behavior

### 1. Sending a user message

When a new user message is added to the feed, the feed should scroll so that the
turn containing that user message is aligned to the top of the chat viewport,
directly under the header.

This behavior applies even when the newest user turn is near the end of the
conversation.

### 2. Scroll runway

The feed may include extra scrollable runway below the real content, but only
while the top-level assistant response is actively streaming.

The runway is measured relative to the newest user turn.

The maximum runway target is one feed viewport below the newest user turn.
However, the runway must shrink as the assistant response grows.

The practical rule is:

- compute how much real content currently exists from the top of the newest
  user turn down to the current assistant/output bottom
- only add enough runway to cover the remaining gap up to one viewport
- once the assistant content already fills that viewport, the runway should be
  zero

This avoids long confusing blank space after the last message while still
providing temporary headroom for the pinned-send layout during streaming.

When top-level streaming is not active, the runway must be zero.

### 3. Assistant streaming

While assistant output is streaming:

- do not continuously auto-scroll the viewport
- do not keep forcing the viewport downward as new text arrives
- let the user read the generated text in a stable position below the pinned
  user message

If the user wants to follow the latest content live, they must do so manually.

### 4. Jump-to-latest behavior

The existing jump-to-bottom/latest control remains the manual way to follow new
content.

That control should scroll to the real content bottom marker, not the absolute
end of the runway, so it does not land the user in blank space.

### 5. Session restore

Saved scroll position restore should keep working as before:

- if the user left the session scrolled up, restore that position
- if the user left the session at the bottom, restore to the real content
  bottom, not the end of the runway

During top-level streaming, restore must preserve the viewport-relative
placement of the saved visible turn anchor, even if the real content bottom was
also on screen at the time. Switching away from a streaming session and back
must not drop the newest user turn from the top of the viewport down toward the
bottom.

## Non-goals

- No continuous streaming auto-follow
- No new separate "follow mode"
- No extra decorative top padding above the newest user message

## Expected UX outcome

After send:

1. the newest user message moves to the top of the chat viewport
2. assistant output grows beneath it without pushing the viewport
3. the jump-to-latest control remains available for manual follow
