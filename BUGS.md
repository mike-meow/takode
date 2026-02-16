# Known Bugs

## Bug 1: Message feed "scroll up then back down" jitter
**Status:** Fixed (this branch)

When a new assistant message arrives, the feed visibly scrolls upward by ~1 page, then scrolls back down. Caused by CSS `scroll-smooth` on the scroll container double-animating with `scrollIntoView({ behavior: "smooth" })`, amplified by `translateY(4px)` in the `fadeSlideIn` animation.

**Fix:** Removed `scroll-smooth` from the scroll container and removed `translateY` from `fadeSlideIn` animation (opacity-only fade).

---

## Bug 2: "Prompt is too long" error — poor UX
**Status:** Fixed (this branch)

When the context limit is hit, the UI displays a confusing "Prompt is too long" message. The UI appears to stop working with no clear indication of what happened or what the user should do. After a page refresh, the response may actually be there.

**Root cause:** Error system messages rendered as 11px gray italic text — nearly invisible. No variant distinction between errors and info messages.

**Fix:** Added `variant: "error"` to ChatMessage type. Error system messages now render as prominent red banners with warning icon. "Prompt is too long" errors include actionable guidance ("Try /compact or start a new session").

---

## Bug 3: Compact command — no progress indication, missing from history
**Status:** Fixed (this branch)

When running the `/compact` slash command:
1. There is no loading/progress indicator while compaction is running
2. The command does not appear in the chat history
3. The UI appears frozen until manual page refresh

**Root cause:** MessageFeed only showed "Generating..." for `sessionStatus === "running"`, not `"compacting"`. Additionally, `compact_boundary` from CLI was silently dropped — server never cleared stale message history, causing mismatch with CLI's compacted state.

**Fix:** Added compacting indicator to MessageFeed. Implemented `compact_boundary` handler in ws-bridge that clears server-side messageHistory and broadcasts to browsers. Browser clears local messages on compact so the view rebuilds cleanly.

---

## Bug 4: Feed stops updating after answering a question
**Status:** Fixed (this branch)

After the assistant asks a question (e.g., via `AskUserQuestion`) and the user responds, the message feed stops updating. New messages from the assistant do not appear in the feed. After waiting and refreshing the page, multiple new messages appear at once. Sidebar shows incorrect "running" count during the freeze.

**Root cause (multiple):**
1. Bun's WebSocket idle timeout silently closes server-side socket during quiet periods
2. Double `message_history` delivery — `handleBrowserOpen` and `handleSessionSubscribe` both send it, causing React duplicate key warnings
3. Stale `lastSeq` in localStorage causes `if (data.seq <= previous) return` to silently drop ALL new messages after server restart

**Fix (cumulative):**
- Heartbeat (ws.ping every 30s) + disabled Bun idle timeout
- Moved message_history to `handleSessionSubscribe` only (eliminates double delivery)
- Server sends `nextEventSeq` in `session_init`; browser resets stale seq when ahead of server
- Added `persistSession` to `handlePermissionResponse`

---

## Bug 5: Plan mode exit prompts for edit permission
**Status:** Open

After approving a plan in plan mode, the first edit still triggers a permission prompt. The mode switches to "default" after plan approval, but the user expected "default" to auto-accept edits. This may be a Claude Code SDK behavior rather than a Companion bug — needs investigation into how `ExitPlanMode` transitions the permission mode.

**Expected:** After plan approval, edits should proceed without requiring additional permission prompts.

---

## Bug 6: New sessions show "CLI disconnected" banner briefly on startup
**Status:** Open

When starting a new session in Companion, the UI briefly shows a "CLI disconnected" banner with a "Reconnect" button, even though the CLI is actually starting up and generating. The first message appears after a few seconds, at which point the banner disappears.

**Root cause:** The browser WebSocket connects to the server before the CLI process has connected back via its WebSocket. `ChatView.tsx` shows the disconnected banner when `connStatus === "connected" && !cliConnected`.

**Expected:** During initial session startup, show a "Starting session..." or loading state instead of the alarming "CLI disconnected" banner.
