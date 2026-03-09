# Chat Feed Frozen History Sections

This file is the source of truth for the next-stage chat-feed performance work
on long Takode sessions.

It addresses two separate but related problems:

- browser egress is still dominated by frozen history hydration
- Safari performance still degrades when the feed contains too many collapsed
  turns in the DOM

The design below replaces "one giant frozen history blob" with sectioned frozen
history that is fetched, cached, and rendered in bounded units.

## Problem Summary

Current live traffic data shows:

- browser outbound is still dominated by `history_sync`
- almost all `history_sync` cost is `frozen_delta`, not `hot_messages`
- in the sampled large sessions, a large fraction of frozen bytes are hidden
  agent activity:
  - tool-only assistant messages
  - `tool_result_preview` entries used only to hydrate tool-result cache

Current live sample:

- `history_sync.frozenDeltaBytes`: about `12.75 MB`
- `history_sync.hotMessagesBytes`: about `28 KB`

Byte analysis of the largest frozen sessions suggests that about `70%` of the
current frozen-delta transfer is data that the default collapsed feed does not
need to render directly.

At the same time, Safari still performs poorly even after older turns are
collapsed, because the browser still mounts too many turn containers and too
many derived feed entries.

So the remaining problem is both:

- transport size
- DOM size / layout cost

## Goals

- Avoid re-sending unchanged old frozen history on every browser hydrate.
- Avoid rendering arbitrarily many old collapsed turns in the DOM.
- Keep the latest activity view fast by default.
- Preserve the ability to inspect old history on demand.
- Keep server history authoritative.

## Non-goals

- Do not change the authoritative persisted history format first.
- Do not make the browser the source of truth for session history.
- Do not require full virtualization as the first step.
- Do not fetch full old agent activity by default.

## Core Design

### 1. Frozen history is divided into sections

The browser should no longer receive old frozen history as one flat
`frozen_delta` array.

Instead, the server should expose a frozen-history manifest:

- a list of frozen sections
- stable section IDs
- per-section hashes
- counts / timestamps / summary metadata

Each section is immutable once frozen.

Canonical boundary rule:

- divide frozen history into fixed-size sections of `50` turns each

Turn boundaries already match the feed's natural render unit:

- turns are divided by trigger messages such as user messages or herd events
- each turn is the unit that creates the collapsed DOM cost we want to bound

The sectioning rule should therefore optimize for consistent turn-count bounds,
not for compaction events.

### 2. The browser fetches frozen history section-by-section

The browser should request frozen sections lazily.

On session open, the server sends only:

- frozen section manifest
- current hot tail
- current session state

The browser then loads only the sections needed for the current viewport.

Suggested transport shape:

- `history_manifest`
  - `sections: [{ id, hash, kind, startFrozenIndex, endFrozenIndex, turnCount, messageCount, summary }]`
  - `latestSectionId`
  - `frozenCount`
- `history_section`
  - `sectionId`
  - `hash`
  - `detail: "collapsed" | "full"`
  - payload

The hot path should stay separate from frozen sections:

- frozen sections are fetched by section ID
- hot tail continues to flow live over WebSocket

### 3. The browser caches section data locally

Frozen sections are immutable, so browser caching is high leverage here.

Cache key:

- `sessionId + sectionId + hash + detailLevel`

Recommended storage:

- IndexedDB, not `localStorage`

Why:

- section payloads can be large
- cached history should survive reloads
- `localStorage` is the wrong size and sync model for this

Cache behavior:

- if the manifest says the same `sectionId + hash` is still current, reuse the
  cached section without re-fetching
- if the hash changes, discard and re-fetch that section
- old cache entries can be purged by simple LRU or per-session caps

This means the browser should not retrieve the same old frozen section twice
unless the section hash changed.

### 4. Render at most three sections at a time

This is the DOM-performance rule.

When viewing a session:

- render at most three sections at once
- older sections above that window should be unmounted, not merely hidden
- if the user scrolls upward, show a `Load older section` control
- if the user returns to bottom, shrink back to the latest three
  sections

Important distinction:

- cached does not mean rendered
- the browser may cache more than three sections locally
- but it must intentionally mount only a bounded number of sections

This is the main Safari performance win.

Canonical mounted-window behavior:

1. Open session.
2. Render the latest three sections.
3. If the user loads older history, slide the window upward by one
   section.
4. Keep the window bounded to three sections the whole time.
5. If the user loads newer history, slide the window downward by one
   section.
6. If the user jumps to latest or scrolls back to the bottom, restore the
   latest three sections.

Example:

- latest window: `[S8, S9, S10]`
- load older: `[S7, S8, S9]`
- load older again: `[S6, S7, S8]`
- load newer: `[S7, S8, S9]`
- jump to latest: `[S8, S9, S10]`

Later sections that leave the mounted window should be:

- unmounted from the DOM
- retained in browser cache if already fetched

They should not stay mounted just because the user previously viewed them.

### 5. Older sections should default to collapsed turn payloads

Sectioning alone fixes repeated transfer and DOM bounds, but it should also
work with collapsed turn payloads.

For older frozen sections, the default payload should be a collapsed section
representation, not the full raw `BrowserIncomingMessage[]`.

Each collapsed turn should contain only what the default feed needs:

- user message
- system entries
- visible response entry
- promoted entries
- turn stats
- timestamps / duration metadata needed for ordering and labels

It should omit hidden agent activity by default:

- tool-only assistant messages
- hidden tool groups
- hidden subagent activity
- old `tool_result_preview` cache entries

If the user expands a turn or requests more detail, the browser can fetch the
full turn or full section payload on demand.

## Why This Is Better Than Flat Collapsed History Alone

A pure collapsed-history transport would reduce bytes, but it would not
necessarily bound Safari DOM cost if the browser still mounts hundreds of
collapsed turns at once.

Sectioning solves the second problem directly:

- only a bounded number of sections are mounted
- older sections can stay cached but unmounted

So the right design is:

- sectioned frozen history
- collapsed-by-default payloads inside older sections
- on-demand expansion for full detail

## Server Responsibilities

### Frozen section manifest

The server should maintain authoritative section metadata for each session.

A section record should include:

- `id`
- `hash`
- `startFrozenIndex`
- `endFrozenIndex`
- `messageCount`
- `turnCount`
- `boundaryKind`
  - `turn_count`
  - `tail`
- lightweight summary metadata for UI headers

### Section hashing

Section hashes should be semantic and stable:

- based on the frozen messages included in the section
- immutable after the section closes

This lets the browser trust its cached section data.

### Detail levels

The server should support at least two detail levels:

- `collapsed`
- `full`

`collapsed` should be the default for old frozen sections.

`full` is only needed when:

- the user expands old activity
- the browser needs richer detail for a visible section

### Persistence

First implementation does not need to rewrite session persistence.

It is acceptable to:

- keep storing frozen history as today
- derive sections from frozen history in memory
- later add a persisted section index if needed

If derivation cost becomes significant, add a sidecar section index file.

## Browser Responsibilities

### Section manifest state

For each session, the browser tracks:

- section manifest
- cached section detail availability
- currently rendered section window
- current expanded turn / section detail state

### Section cache

The browser should:

- read cached sections before network fetch
- populate cache after fetch
- invalidate by hash mismatch

### Render window behavior

Canonical behavior:

1. Open session.
2. Render hot tail plus the latest frozen sections needed for the default view.
3. Keep at most three frozen sections mounted.
4. When the user asks for older history, fetch or reuse the next older section
   and slide the mounted window upward.
5. When the user asks for newer history, slide the mounted window downward.
6. When the user returns to the bottom, drop old mounted sections back down to
   the latest three.

### Navigation into unloaded history

History navigation features must be section-aware.

Examples:

- task history timeline
- version-history message jumps
- any deep link to a turn ID or message ID

If the target turn or message is inside an older section that is not mounted:

1. resolve the target section from section metadata
2. shift the mounted section window so the target section is included
3. then perform the existing turn/message scroll and expansion behavior

Important rule:

- do not mount every section between the current window and the target
- jump the window directly to the target neighborhood while still respecting
  the at-most-three-sections rule

## Estimated Traffic Savings

Based on the current live sample:

- frozen delta transferred: about `12.75 MB`
- estimated hidden/default-collapsed candidate bytes: about `8.90 MB`
- hidden share of frozen delta: about `69.8%`

That hidden candidate is mainly:

- tool-only assistant messages
- `tool_result_preview` entries

Estimated cold-load savings from sending collapsed older sections by default:

- best-case upper bound: about `70%` of frozen-delta bytes
- with summary overhead of `10%` of removed bytes: about `63%`
- with summary overhead of `20%`: about `56%`
- with summary overhead of `30%`: about `49%`

So the realistic expected range is:

- `49%` to `63%` reduction in frozen-history transfer on cold loads

Warm-cache savings can be larger.

Because frozen sections are immutable, a returning browser with cached sections
should only need:

- updated manifest
- newly created sections
- maybe the latest mutable display window

That means repeated session opens or reloads could avoid nearly all old frozen
transfer, not just half of it.

## Estimated Performance Impact

Section caching reduces network transfer.

The at-most-three-section rule reduces:

- number of mounted turn containers
- number of derived feed entries
- DOM size
- layout and paint cost on Safari

This is the part that collapsed-turn transport alone does not solve.

## Recommended Implementation Order

1. Add frozen section manifest generation on the server.
2. Add browser-side section manifest state and IndexedDB cache.
3. Add collapsed section payloads for old frozen sections.
4. Add the at-most-three-section mounted-window rule.
5. Add on-demand `full` section or turn fetch for expansion.
6. Add metrics:
   - section manifest bytes
   - section fetch bytes by detail level
   - cache hit rate
   - average mounted section count

## Open Questions

- Should expansion fetch operate at section granularity or turn granularity?
- Should the newest frozen section default to `full` while older sections
  default to `collapsed`?
- How should session search interact with unloaded sections?
- Do we want opportunistic prefetch for the next older section when the user
  nears the top of the oldest mounted section?

## Recommendation

This plan is directionally correct and likely the right next step.

The recommended architecture is:

- sectioned frozen history
- fixed-size sections of `50` turns each
- collapsed-by-default payloads for older sections
- browser caching by immutable section hash
- at-most-three mounted sections at a time

That combination addresses both remaining problems:

- too much frozen-history transfer
- too much rendered history in Safari
