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

- scroll to the maximum currently allowed scroll position once
- the newest user message itself defines that allowed position
- do not separately pin the user turn to the top of the viewport

### 2. Scroll runway

The feed includes a persistent scroll runway below the real content whenever
there is a user turn in the visible feed.

The runway is measured relative to the newest user message only.

The practical rule is:

- find the newest user message in the visible feed
- allow enough overscroll for that user message to reach the top of the
  viewport
- do not use the newest assistant message to size the runway
- keep that runway present after generation finishes
- replace the runway target only when a newer user message arrives

This preserves a stable "question near the top, answer below it" layout and
avoids jarring post-generation jumps when the final assistant/system message is
short.

The runway may still shrink as real assistant content grows below the newest
user message, but it must not shrink in a way that clamps the current scroll
position upward while the user is already inside that extra scroll region.

### 3. Running Turn

While the session is running:

- do not continuously auto-scroll the viewport
- do not keep forcing the viewport downward as new text arrives
- let the user read the generated text in a stable position after the one-time
  send scroll

When assistant text is streaming, the same rule still applies: no continuous
auto-follow after the one-time send scroll.

If the user wants to follow the latest content live, they must do so manually.

### 4. Jump-to-latest behavior

The existing jump-to-bottom/latest control remains the manual way to follow new
content.

That control should scroll to the maximum currently allowed bottom position for
the newest user turn.

### 5. Session restore

Saved scroll position restore should keep working as before:

- if the user left the session scrolled up, restore that position
- if the user left the session at the bottom, restore to the current allowed
  bottom position for the newest user turn

Restore should preserve the viewport-relative placement of the saved visible
turn anchor when that anchor is still available. If the saved anchor cannot be
restored reliably, prefer the end of the conversation over dropping the user
near the beginning. Restore should wait until the session feed has actual
content before applying.

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
