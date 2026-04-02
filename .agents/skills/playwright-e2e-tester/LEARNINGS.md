# E2E Quest Verification Learnings (2026-02-26)

## Run context
- Dev UI: `http://127.0.0.1:5174`
- API: `http://127.0.0.1:3456`
- Method: Playwright MCP (`mcp-cmd`) through browser snapshots and targeted interactions.
- Scope: Verify as many `needs_verification` quests as feasible; skip blockers and continue.

## Reusable learnings

- Use `browser_snapshot --filename=...` and then `rg` the saved markdown file for refs. This keeps runs fast and avoids giant inline snapshot outputs.
- `browser_take_screenshot --fullPage` works as a boolean flag (`--fullPage`), not `--fullPage=true` as a string.
- Some quest cards are hard to click due sticky/fixed layers intercepting pointer events. `browser_run_code` with `.click({ force: true })` is a reliable fallback.
- For Questmaster verification-inbox behavior, UI feedback composer currently posts as `human`; use `COMPANION_PORT=3456 quest feedback <id> --author agent ...` when the checklist requires **agent** feedback specifically.
- `q-70` reinbox behavior is observable by inbox count change and card badge transition to `Inbox` in snapshot text.
- For sidebar archive-icon layout checks (`q-38`), objective verification is easiest via `browser_run_code` bounding-box assertions (`leftSide: true`, `overlap: false`) on desktop and mobile viewports.
- `q-20` search highlighting is explicitly represented as `mark` nodes in snapshots for both title and description contexts.
- `q-53` hint-copy verification can be done from both edit modal and New Quest form (`Tip: use #tag in description to attach tags.`).
- `q-53` hashtag-flow verification from description/title can mutate tags/title text; after validating, restore quest metadata with `quest edit` to avoid leaving test artifacts.
- Session-scoped verification quests can be blocked when the target session is not visible/active in current sidebar context; prefer skipping quickly and moving to the next quest.
- Keep operations safe/non-destructive: no shell/file destructive commands, no risky agent actions, and only reversible quest/UI mutations for verification evidence.
- For `q-59` turn-duration checks, verify a fresh assistant turn and then inspect both UI and DOM:
  - visible `time` nodes may appear only for user rows in grouped feed views
  - `[data-testid="message-timestamp"]` can be empty in those contexts even when assistant text rendered
  - if duration is absent beside assistant timestamp after a fresh turn, record as unresolved with screenshot + DOM probe result
- In this Codex sandbox, `npx mcp-cmd call playwright browser_* ...` can hang because direct access to the MCP Unix socket is blocked (`EPERM`) and Playwright browser tool RPCs may never return. If that happens, a reliable fallback is a one-off Node script importing the downloaded `playwright` package from `~/.npm/_npx/.../node_modules/playwright/index.mjs` and launching the known-installed Chromium binary under `~/Library/Caches/ms-playwright/chromium-1212/.../Google Chrome for Testing`.
- On narrow desktop-size verification runs (`430x932`), the DOM may contain two Composer textareas; select the visible one by placeholder (for example `textarea[placeholder*='Type a message']`) instead of `locator("textarea").first()`.
- `npx -y mcp-cmd stop playwright` can fail in this sandbox if npm tries to resolve `registry.npmjs.org`; manual fallback cleanup is `kill` the daemon/browser PIDs and remove `.mcp-cmd.json`.

## Quest outcomes in this run
- Verified + checked: `q-70` (3/3), `q-38` (2/2), `q-20` (2/2), `q-53` (2/2).
- Partially tested, not checked: `q-80` (Esc image-lightbox close precedence verified; session-switch/Rework-path not conclusively verified in this context).
- Skipped due context constraints: `q-51` (linked session-chip behavior not directly verifiable from current visible session set).
