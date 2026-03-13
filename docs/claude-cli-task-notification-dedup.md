# Claude Code CLI: Duplicate `task_notification` Bug & Local Patch

## Summary

Claude Code CLI v2.1.75 (and likely earlier versions since Feb 2026) has a race condition
where background task completions trigger **redundant model turns**. When the model calls
`TaskOutput(block=true)` to read a background task's result, a stale `task_notification`
later triggers a second, wasted model turn for the same task.

This document covers our investigation, root cause analysis, why server-side suppression
can't work, and how to apply a local CLI patch.

## Symptoms

1. **Duplicate assistant responses**: The model processes a background task result, responds
   to the user, then immediately starts a second response repeating similar information.
2. **Phantom agent turn boundaries**: In the Takode UI, the duplicate response creates a
   new "agent turn" that incorrectly collapses previous messages.
3. **Dangerous auto-execution**: Model asks "should I proceed?" in turn 1, then
   `task_notification` triggers turn 2 where it starts implementing without waiting for
   the user's answer.

## Root Cause

### The Race Condition (microtask vs macrotask)

When a background task completes, two things happen concurrently inside the CLI:

| Step | Event loop phase | What happens |
|------|-----------------|--------------|
| 1 | **Microtask** (`.then()` callback) | `tY6()` sets `notified=true` + pushes `task-notification` XML to the turn input queue via `J0()` |
| 2 | **Macrotask** (`setTimeout 100ms` poll) | `TSY()` poll in `TaskOutput(block=true)` sees task completed, returns result to model |
| 3 | Model turn completes | Model has the full result from `TaskOutput` |
| 4 | Main loop checks queue | Finds stale `task-notification` from step 1, triggers redundant model turn |

Because **microtasks always execute before macrotasks** in the JS event loop, the
`.then()` callback (step 1) always wins. It enqueues the notification before `TaskOutput`
can return the result and mark the task as fully consumed.

### Key Minified Variables (v2.1.75)

| Name | Purpose |
|------|---------|
| `tY6` | Task completion notifier (sets `notified=true`, enqueues XML via `J0()`) |
| `TSY` | `TaskOutput` blocking poll loop (`setTimeout 100ms`) |
| `Xk1` | The `TaskOutput` tool object |
| `J0()` | Enqueue to turn-input queue (priority `"later"`) |
| `V94()` | Remove items from queue matching a predicate |
| `hY` | The queue array |
| `d9()` | State updater helper for tasks |
| `Dk1()` | Task serializer (for the return value) |
| `Pu8()` | Guard: sets `notified=true`, returns false if already set |
| `nv1` | Bash task completion notifier (same pattern as `tY6`) |
| `NVY` | Remote agent completion notifier (same pattern) |

### Why This Became Visible Recently

A **February 13, 2026** changelog entry states background task notifications were fixed
for **streaming Agent SDK mode**. Before this fix, `task_notification` events may not
have been delivered on the WebSocket/NDJSON path -- so the duplicate turn was invisible.
After the fix, the notifications are properly delivered, making the race condition manifest.

## Why Server-Side (Takode) Suppression Cannot Work

We initially attempted to suppress duplicates on the Takode bridge side by tracking which
`task_id`s were consumed by `TaskOutput` and filtering out subsequent `task_notification`
events. After implementation and groom review, we discovered this approach is
**fundamentally broken**:

1. **The bridge only receives informational echoes.** By the time `task_notification`
   reaches the bridge (via WebSocket NDJSON or SDK adapter), the CLI has **already
   queued it as a turn trigger internally**. The bridge cannot prevent the CLI from
   starting a new model turn.

2. **No write-back channel exists.** The CLI protocol has no control message to cancel
   or suppress a queued turn. `task_notification` is a passive `system` message, not a
   `control_request`.

3. **The suppression code added complexity for zero functional benefit** -- it only
   logged a message while the redundant turn still fired. We removed it.

## The Fix: Local CLI Patch

The fix is a two-line insertion in `cli.js` that drains the stale `task-notification`
from the turn input queue after `TaskOutput` successfully returns a result.

### How It Works

After `TaskOutput.call()` sets `notified:true` on the task state, we call `V94()`
(the queue drain function) to remove any pending `task-notification` items whose XML
value contains the matching `<task-id>THE_TASK_ID</task-id>`. The comma operator chains
the drain before the return object.

### Patch Targets (v2.1.75)

The `TaskOutput` tool has two success return paths:

**1. Non-blocking path** (task already completed when polled):

```
// BEFORE:
d9(_,q.setAppState,(J)=>({...J,notified:!0})),{data:{retrieval_status:"success",task:await Dk1(H)}}

// AFTER:
d9(_,q.setAppState,(J)=>({...J,notified:!0})),V94((J)=>J.mode==="task-notification"&&typeof J.value==="string"&&J.value.includes("<task-id>"+_+"</task-id>")),{data:{retrieval_status:"success",task:await Dk1(H)}}
```

**2. Blocking path** (after `TSY` poll wait completes):

```
// BEFORE:
d9(_,q.setAppState,(J)=>({...J,notified:!0})),{data:{retrieval_status:"success",task:await Dk1(j)}}

// AFTER:
d9(_,q.setAppState,(J)=>({...J,notified:!0})),V94((J)=>J.mode==="task-notification"&&typeof J.value==="string"&&J.value.includes("<task-id>"+_+"</task-id>")),{data:{retrieval_status:"success",task:await Dk1(j)}}
```

Note: The variable `_` holds the `task_id` (destructured from the tool input).
Both old strings are unique in `cli.js`.

### Applying the Patch After a CLI Upgrade

When you run `claude update`, the compiled binary at
`~/.local/share/claude/versions/X.Y.Z` is replaced. The patch must be re-applied.

```bash
#!/usr/bin/env bash
# Usage: ./patch-claude-cli.sh [VERSION]
# Example: ./patch-claude-cli.sh 2.1.75
set -euo pipefail

VERSION="${1:-$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)}"
VERSIONS_DIR="$HOME/.local/share/claude/versions"
PATCHED_DIR="$HOME/.local/share/claude/patched/$VERSION"
BINARY="$VERSIONS_DIR/$VERSION"

echo "Patching Claude Code CLI v$VERSION..."

# 1. Back up original binary (skip if already backed up)
if [ ! -f "$BINARY.original" ]; then
  if [ -L "$BINARY" ]; then
    echo "ERROR: $BINARY is already a symlink. Remove it first or check existing patch."
    exit 1
  fi
  cp "$BINARY" "$BINARY.original"
  echo "  Backed up original to $BINARY.original"
fi

# 2. Download the npm package and extract cli.js
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"
npm pack "@anthropic-ai/claude-code@$VERSION" --quiet >/dev/null 2>&1
tar xzf anthropic-ai-claude-code-*.tgz

# 3. Apply patches
cd package
# Verify patch targets exist
if ! grep -q 'd9(_,q.setAppState,(J)=>({\.\.\.J,notified:!0})),{data:{retrieval_status:"success",task:await Dk1(H)}}' cli.js; then
  echo "ERROR: Non-blocking patch target not found. Variable names may have changed in v$VERSION."
  echo "  Re-analyze cli.js to find the new TaskOutput success return points."
  exit 1
fi
if ! grep -q 'd9(_,q.setAppState,(J)=>({\.\.\.J,notified:!0})),{data:{retrieval_status:"success",task:await Dk1(j)}}' cli.js; then
  echo "ERROR: Blocking patch target not found. Variable names may have changed in v$VERSION."
  exit 1
fi

# Patch 1: non-blocking success path
sed -i.bak 's|d9(_,q.setAppState,(J)=>({\.\.\.J,notified:!0})),{data:{retrieval_status:"success",task:await Dk1(H)}}|d9(_,q.setAppState,(J)=>({...J,notified:!0})),V94((J)=>J.mode==="task-notification"\&\&typeof J.value==="string"\&\&J.value.includes("<task-id>"+_+"</task-id>")),{data:{retrieval_status:"success",task:await Dk1(H)}}|' cli.js

# Patch 2: blocking success path
sed -i.bak 's|d9(_,q.setAppState,(J)=>({\.\.\.J,notified:!0})),{data:{retrieval_status:"success",task:await Dk1(j)}}|d9(_,q.setAppState,(J)=>({...J,notified:!0})),V94((J)=>J.mode==="task-notification"\&\&typeof J.value==="string"\&\&J.value.includes("<task-id>"+_+"</task-id>")),{data:{retrieval_status:"success",task:await Dk1(j)}}|' cli.js

# Verify patches applied
if [ "$(grep -c 'V94.*task-notification.*task-id' cli.js)" -ne 2 ]; then
  echo "ERROR: Patch verification failed. Expected 2 V94 insertions."
  exit 1
fi
echo "  Patches applied successfully."

# 4. Install patched files
mkdir -p "$PATCHED_DIR"
cp cli.js "$PATCHED_DIR/"
cp -r vendor "$PATCHED_DIR/" 2>/dev/null || true
cp package.json "$PATCHED_DIR/"
cp resvg.wasm "$PATCHED_DIR/" 2>/dev/null || true

# 5. Create wrapper script
cat > "$PATCHED_DIR/claude-wrapper.sh" <<WRAPPER_EOF
#!/usr/bin/env bash
# Patched Claude Code v$VERSION -- task_notification dedup fix
# Original binary: $BINARY.original
exec node "\$HOME/.local/share/claude/patched/$VERSION/cli.js" "\$@"
WRAPPER_EOF
chmod +x "$PATCHED_DIR/claude-wrapper.sh"

# 6. Replace binary with symlink
rm -f "$BINARY"
ln -s "$PATCHED_DIR/claude-wrapper.sh" "$BINARY"

echo "Done! Claude Code v$VERSION patched."
echo "  Binary: $BINARY -> $PATCHED_DIR/claude-wrapper.sh"
echo "  Backup: $BINARY.original"
echo ""
echo "To revert: rm $BINARY && cp $BINARY.original $BINARY"
```

### How to Revert

```bash
VERSION="2.1.75"
rm ~/.local/share/claude/versions/$VERSION
cp ~/.local/share/claude/versions/$VERSION.original ~/.local/share/claude/versions/$VERSION
```

### What Happens on `claude update`

`claude update` downloads a new Mach-O binary to `~/.local/share/claude/versions/X.Y.Z`.
This will **overwrite the symlink** with a real binary, effectively reverting the patch.
You need to re-run the patch script for the new version.

**Important**: Variable names in the minified `cli.js` may change between versions.
If the patch script's `grep` check fails, you need to re-analyze the new `cli.js` to
find the updated TaskOutput success return paths. The pattern to look for:

1. Find `retrieval_status:"success"` -- there are only a few occurrences
2. Look for the ones preceded by `notified:!0`
3. Insert the `V94(...)` drain between the state update and the return object
4. Identify the correct queue drain function by searching for `function.*splice.*remove`

### Verification

After patching, test by running a background command in a Claude session:

```
Run "sleep 2 && echo done" in the background, then read its output using TaskOutput
```

**Before patch**: You'll see the model respond, then immediately start a second
response triggered by the stale `task_notification`.

**After patch**: The model responds once with the task output. No duplicate turn.

## Test Results (v2.1.75, verified 2026-03-13)

| Scenario | How tested | Notification fires? | Expected? | Result |
|----------|-----------|---------------------|-----------|--------|
| `TaskOutput(block=true)` consumed full result | Launched bg task, called `TaskOutput(block=true)`, waited | ❌ No | ❌ No (suppressed) | ✅ **Pass** |
| `TaskOutput(block=false)` got partial/pending result | Launched bg task with 5s sleep, immediately called `TaskOutput(block=false)` (got `running` status), waited | ✅ Yes | ✅ Yes | ✅ **Pass** |
| Never called `TaskOutput` at all | Launched bg task with 6s sleep, never read, waited | ✅ Yes | ✅ Yes | ✅ **Pass** |

The patch correctly suppresses the notification **only** when the model has already consumed
the complete result via a blocking read. Partial reads and unread tasks still receive their
notifications as expected.

## File Locations

| File | Purpose |
|------|---------|
| `~/.local/share/claude/versions/2.1.75` | Symlink to patched wrapper |
| `~/.local/share/claude/versions/2.1.75.original` | Backup of original Mach-O binary |
| `~/.local/share/claude/patched/2.1.75/cli.js` | Patched JavaScript bundle |
| `~/.local/share/claude/patched/2.1.75/claude-wrapper.sh` | Wrapper script (`node cli.js`) |

## References

- Claude Code CLI v2.1.75 npm package: `@anthropic-ai/claude-code@2.1.75`
- Feb 13, 2026 changelog: Fixed background task notifications for streaming Agent SDK mode
- Queue drain function: `V94(predicate)` -- removes matching items from `hY` array
- Task notification format: XML with `<task-id>`, `<tool-use-id>`, `<status>`, `<summary>`
