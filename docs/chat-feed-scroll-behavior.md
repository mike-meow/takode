# Chat Feed Scroll Behavior

This file is the source of truth for Takode chat-feed scrolling behavior.

## Goals

- Keep send-time scrolling simple and predictable.
- Avoid continuous auto-follow during assistant streaming.
- Preserve manual navigation controls for following the latest content.

## Canonical Behavior

### 1. Sending a user message

When a new user message is added to the feed, the feed should first render that
message in place in the conversation.

After the message is rendered, the feed should scroll downward once as far as
the current scroll rules allow.

In practice, that means:

- scroll to the real content bottom marker once
- if streaming runway already exists, that single scroll may use it
- do not separately pin the user turn to the top of the viewport

### 2. Scroll runway

The feed may include extra scrollable runway below the real content, but only
while the top-level assistant response is actively streaming.

The runway is measured relative to the last renderable top-level message.

The practical rule is:

- find the last renderable top-level message while streaming
- allow enough overscroll for that final message to reach the top of the
  viewport
- if that final message is taller than the viewport, still allow scrolling
  through it until its bottom has been seen
- never add blank runway beyond the point needed to finish reading the last
  message

This avoids long confusing blank space after the last message while still
allowing the user to read the full final message and align its top with the top
of the viewport when needed.

While the user is actively scrolled inside the temporary overscroll region, the
runway must not shrink in a way that clamps the current scroll position upward.
In practice, preserve enough runway to keep the current viewport stable, then
allow it to shrink later as the user scrolls or as real content catches up.

When top-level streaming is not active, the runway must be zero.

### 3. Assistant streaming

While assistant output is streaming:

- do not continuously auto-scroll the viewport
- do not keep forcing the viewport downward as new text arrives
- let the user read the generated text in a stable position after the one-time
  send scroll

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

During top-level streaming, restore should preserve the viewport-relative
placement of the saved visible turn anchor when that anchor is still available.
If the saved anchor cannot be restored reliably, prefer the end of the
conversation over dropping the user near the beginning. Restore should wait
until the session feed has actual content before applying.

## Non-goals

- No continuous streaming auto-follow
- No new separate "follow mode"
- No extra decorative top padding above the newest user message

## Expected UX outcome

After send:

1. the newest user message appears in the conversation
2. the feed scrolls downward once as far as currently allowed
3. assistant output grows afterward without pushing the viewport
4. the jump-to-latest control remains available for manual follow
