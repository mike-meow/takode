# Codex Terminal Chips Design

## Problem

Takode currently renders Codex backend terminal work as ordinary `Bash` tool cards in the chat feed. That is technically accurate at the protocol level, but it does not match the user's mental model of a PTY-backed terminal:

- a terminal feels live and persistent while it is running
- a terminal should be inspectable without flooding the feed with live output
- once it finishes, the chat feed should keep the durable history

The current UI treats live Codex commands as ordinary tool transcripts from the start, so long-running terminal output competes with the main conversation.

## Goals

- Represent a live Codex terminal as a temporary floating object while it is running.
- Keep the chat feed as the durable history once the command finishes.
- Support read-only inspection only. The user does not type into agent-owned terminals.
- Avoid backend protocol changes for the first iteration.

## Non-goals

- No user stdin or terminal takeover.
- No attempt to merge multiple Codex commands into one true PTY session model yet.
- No changes to the standalone `/terminal` feature.

## Intended Behavior

### Live state

When a Codex `Bash` tool is active:

- show a floating chip for the live command
- keep the inline feed entry compact instead of rendering full live output inline
- allow the chip to open a read-only inspector panel

The chip should show:

- terminal icon
- truncated command preview
- live duration
- subtle running state treatment

The inline feed entry should remain in place as a compact stub so the turn still reads coherently in history.

### Inspector

The inspector is read-only and can be opened from the live chip.

It should show:

- command
- live output while the command is running
- final output if the command completes while the inspector is open

Closing the inspector should simply minimize it. No state mutation is sent to the backend.

### Completion

When the Codex command finishes successfully or with error:

- remove the floating chip immediately
- keep the durable entry in the chat feed
- let the existing inline tool/result rendering become the source of truth

If the inspector is already open when completion happens, it may remain open until the user closes it. After that, only the inline feed entry remains.

## UI Rules

- Only Codex `Bash` tools use this live-chip treatment.
- Claude sessions keep their current feed behavior.
- Finished commands do not remain as floating chips.
- The feed entry should become richer again once a final result exists.

## Data Model

The first iteration reuses existing frontend state:

- `messages` for `Bash` tool_use blocks
- `toolProgress` for live output and elapsed time
- `toolResults` for completion state and preview content
- `toolStartTimestamps` for live duration fallback

No new server event type is required.

## Rendering Model

1. Detect active Codex `Bash` tool uses from message history plus absence of a final `toolResults` entry.
2. Render those active tools as floating chips.
3. Render the inline feed entry as a compact live stub while active.
4. When `toolResults` arrives, stop rendering the chip and fall back to the normal inline tool card.

## Edge Cases

- If a command has started but has no output yet, the chip still appears.
- If a command is completed without meaningful output, the chip still disappears and the existing silent-result behavior remains unchanged.
- If a stale command is finalized by the bridge's synthetic Codex preview path, it should still disappear from the live chip list because the presence of a `toolResults` entry ends the live state.

## Testing

Frontend tests should cover:

- live Codex `Bash` command shows a floating chip
- active inline Codex `Bash` entry uses the compact stub instead of the live output transcript
- clicking a chip opens the read-only inspector
- chip disappears after the tool result exists and the inline feed entry remains

Playground should include:

- a running Codex terminal chip state
- an open read-only inspector state if practical
- a completed Codex terminal entry state in the normal feed/tool rendering
