---
name: Takode
description: Local-first orchestration workspace for Claude Code and Codex
colors:
  dark-bg: "#1e1e1e"
  dark-fg: "#eeeeee"
  dark-surface: "#181818"
  dark-sidebar: "#191919"
  dark-user-bubble: "#2d2d2d"
  dark-code-bg: "#111111"
  dark-code-fg: "#d4d4d4"
  primary: "#ae5630"
  primary-hover: "#c4643a"
  muted: "#858585"
  success: "#48bb78"
  error: "#fc8181"
  warning: "#f6e05e"
  light-bg: "#f5f5f0"
  light-fg: "#1a1a18"
  light-surface: "#fafaf7"
  light-sidebar: "#edeae2"
  light-user-bubble: "#ddd9ce"
typography:
  body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.25
  label:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.25
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  xs: "3px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.dark-fg}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  input-surface:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-fg}"
    rounded: "{rounded.xl}"
    padding: "12px"
  notification-popover:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-fg}"
    rounded: "{rounded.xl}"
    padding: "12px"
---

# Design System: Takode

## 1. Overview

**Creative North Star: "The Local Control Room"**

Takode's app UI should feel like a compact control room for local agent work. It is not a blank chat canvas and not a marketing dashboard. It is a high-density operational surface where sessions, quests, threads, permissions, tool calls, review evidence, and pending user actions stay visible and navigable.

The current system already points in the right direction: dark operational surfaces, compact controls, small technical metadata, warm primary accents, responsive overlays, and a few light cat-themed details. This document captures that system while distilling the intended style: calm, transparent, operator-grade, and quietly pleasant without becoming decorative or novelty-driven.

Key characteristics:
- Dense app shell with sidebar, top bar, chat feed, composer, panels, overlays, and management pages.
- Neutral dark surfaces with one warm primary accent and semantic status colors.
- Small, precise type with mono labels for technical metadata.
- Responsive behavior that keeps the composer, approvals, and notification replies usable on mobile.
- Rich hover/preview affordances on desktop, with mobile-safe fallbacks.
- Subtle cat-themed product flavor only when it aids warmth, recognition, or state communication.

## 2. Colors

Takode uses restrained warm-neutral theming: near-black operational surfaces, low-contrast dividers, muted labels, and a burnt-orange primary accent. A VS Code-dark variant also exists for users who prefer editor-native blues. Future work should preserve the core relationship even when exact tokens evolve.

### Primary
- **Burnt Copper** (`#ae5630`): Primary action color, selected states, quest/link emphasis, and important interactive accents.
- **Bright Copper Hover** (`#c4643a`): Hover/active reinforcement for primary controls.

### Neutral
- **Dark Workspace** (`#1e1e1e`): Main dark app background.
- **Ink Surface** (`#181818`): Cards, composer input surfaces, modal/panel surfaces.
- **Sidebar Black** (`#191919`): Dark sidebar/navigation surface.
- **Soft Foreground** (`#eeeeee`): Primary text on dark surfaces.
- **Muted Gray** (`#858585`): Secondary text, timestamps, inactive controls.
- **Code Black** (`#111111`): Code and diff backgrounds.
- **Warm Light Workspace** (`#f5f5f0`): Light-mode page background.
- **Warm Light Surface** (`#fafaf7`): Ideal light-mode card/input surface. Existing code may still use pure white in places, but new work should prefer a slightly warm neutral.
- **Light Sidebar** (`#edeae2`): Light-mode sidebar.

### Semantic
- **Success Green** (`#48bb78`): Success and connected states.
- **Soft Error Red** (`#fc8181`): Errors, destructive warnings, failed states.
- **Signal Yellow** (`#f6e05e`): Warnings, in-progress attention, preparation states.

### Named Rules
**The One Warm Accent Rule.** Use the copper primary as the main product accent. Do not introduce unrelated decorative accent families unless a feature has a real semantic need.

**The Low-Contrast Structure Rule.** Borders, dividers, hover fills, and inactive states should stay quiet. The UI should distinguish structure without looking like a grid of heavy boxes.

**The Flavor Is Rare Rule.** Cat-themed visuals should be small, purposeful accents. They can make the product feel friendlier, but they must not compete with status, routing, review, or approval information.

## 3. Typography

**Display Font:** system-ui, -apple-system, sans-serif
**Body Font:** system-ui, -apple-system, sans-serif
**Label/Mono Font:** ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace

**Character:** Takode uses utilitarian system type with small, deliberate hierarchy. Mono text carries technical metadata such as paths, timings, session numbers, tool names, and compact status rows.

### Hierarchy
- **Headline** (600, 20px, tight line height): Page titles such as Questmaster.
- **Title** (500-600, 13-16px): Panel titles, banner headings, tool group labels.
- **Body** (400, 13-14px, 1.5 line height): Chat content, quest descriptions, form text.
- **Small Body** (400-500, 11-12px): Row metadata, status text, notification rows, dense controls.
- **Mono Label** (400-500, 10-12px): Tool output, compact message metadata, timing badges, session/quest references.

### Named Rules
**The Metadata Is Still UI Rule.** Small labels must remain readable and useful. If metadata is important enough to show, give it adequate contrast, truncation, wrapping, or hover detail.

**The Dense Copy Rule.** Prefer short labels and specific action language. Avoid explanatory prose inside compact app surfaces unless it prevents a real mistake.

## 4. Elevation

Takode is mostly flat, using tonal layering, borders, and sticky positioning for structure. Shadows appear on overlays, popovers, menus, hover cards, and notification panels where depth clarifies stacking. Default page sections and repeated rows should not become floating decorative cards.

### Shadow Vocabulary
- **Menu / dropdown shadow** (`shadow-xl`): Used for dropdowns and search/autocomplete surfaces.
- **Notification popover shadow** (`0 25px 60px rgba(0,0,0,0.5)`): Used for the notification inbox because it floats above the chat/composer context.
- **Floating chip shadow** (`0 10px 30px rgba(0,0,0,0.28)`): Used for compact floating attention controls.
- **Focus/drag glow** (`0 0 0 3px rgba(255,122,26,0.12)`): Used sparingly to indicate an active drop or focus state.

### Named Rules
**The Overlay Earns Elevation Rule.** Shadows belong to temporary layers, not ordinary content rows. Use borders and tonal contrast for normal surfaces.

**The Action Stays Reachable Rule.** Elevated overlays must not block the composer, send/stop controls, or approval paths needed to respond to the overlay's content.

## 5. Components

### Buttons
- **Shape:** Usually 6px to 10px radius for compact controls; 14px for composer/input surfaces; pill only for badges/chips.
- **Primary:** Copper background with light text, compact padding, medium weight.
- **Hover / Focus:** Slightly brighter copper or quiet hover fill. Preserve keyboard focus visibility.
- **Icon buttons:** Square 28px to 40px controls with muted default color and quiet hover background.

### Chips
- **Style:** Compact, usually 10-12px type, rounded-md to rounded-pill depending on density.
- **State:** Selected chips use primary tint or hover fill; session/quest chips should behave as whole controls when clickable.
- **Behavior:** Desktop chips may expose hover previews; mobile should not depend on hover for core navigation.

### Cards / Containers
- **Corner Style:** 8px to 14px depending on surface size.
- **Background:** Dark card/input surfaces on dark workspace background, light equivalent in light theme.
- **Shadow Strategy:** No default shadow for ordinary rows. Use border and tonal layering.
- **Border:** Low-alpha border tokens such as `border-cc-border`.
- **Internal Padding:** Dense rows use 6-12px. Larger panels use 12-24px depending on viewport.

### Inputs / Fields
- **Style:** Dark surface, low-alpha border, 14px radius for composer surface, smaller radius for filters/search.
- **Focus:** Primary-tinted border or subtle ring, not a large glow.
- **Error / Disabled:** Semantic color plus reduced opacity or explanatory text; never color alone.

### Navigation
- **Style:** Persistent left sidebar on desktop; overlay sidebar on mobile. Top bar remains compact with session identity, status, and action icons.
- **Thread/quest navigation:** Tab, chip, notification, and panel routes must agree on ownership and destination.
- **Mobile treatment:** Use overlays with backdrops, constrained widths, and no page-level horizontal scroll.

### Chat Feed and Tool Blocks
- **Messages:** User messages use a compact rounded bubble; assistant messages are more integrated into the feed with metadata and action affordances.
- **Tool blocks:** Grouped, collapsible, and readable. Edit/write groups stay flatter when that improves scanning.
- **Notifications:** Floating notification chip and popover are compact but must never cover the composer controls needed to respond.
- **Playful accents:** Cat-themed indicators may appear in activity, attention, or empty-state details when they are small, recognizable, and do not hide system state.

### CLI Counterparts
- **Principle:** Major graphical workflows should have CLI or documented command counterparts so agents can operate Takode directly.
- **Style:** CLI output should start compact and offer progressive detail through flags, subcommands, or follow-up inspection commands.
- **Consistency:** CLI terms should match UI terms for sessions, quests, threads, notifications, Journey phases, workers, and reviewers.

## 6. Do's and Don'ts

### Do:
- **Do** keep app surfaces dense, scannable, and task-focused.
- **Do** preserve the composer, send/stop controls, and approval paths on narrow screens.
- **Do** use reliable metadata for session, quest, notification, and thread ownership.
- **Do** wrap or constrain long technical content inside panels and mobile modals.
- **Do** use Playground coverage for changed chat/message component states.
- **Do** keep dark theme validation as a first-class design check for UI changes.
- **Do** provide agent-operable CLI paths for major workflows where practical.
- **Do** let small cat-themed details add warmth only when they remain useful.

### Don't:
- **Don't** use marketing-page composition inside the app shell.
- **Don't** introduce decorative gradient text, generic card grids, or accent-heavy dashboards.
- **Don't** let overlays hide the user's next required action.
- **Don't** make notification rows, thread tabs, feed content, or quest banners disagree about ownership.
- **Don't** infer quest/session identity from fragile title text when metadata can carry it.
- **Don't** allow normal long SHAs, inline code, URLs, or phase notes to create mobile horizontal scrolling.
- **Don't** add new visual language that only works for Claude Code or only works for Codex without clear gating.
- **Don't** turn the cat-themed flavor into a mascot layer, theme park, or replacement for clear status design.
