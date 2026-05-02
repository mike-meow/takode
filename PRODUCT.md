# Product

## Register

product

## Users

Takode is for people who use Claude Code and Codex for real local software work: developers, power users, and ML/LLM researchers or engineers who need one reliable place to run sessions, inspect tool calls, approve risky actions, and coordinate longer tasks.

The core user is often operating multiple active threads of work at once. They may be at a desktop workstation doing deep implementation or checking progress from mobile while away from the keyboard. They need the UI to preserve context, surface pending action clearly, and avoid hiding the composer, approvals, or review state when they are trying to respond quickly.

For now, Takode should speak to expert users who are comfortable with terminals, local repositories, model-provider CLIs, and agent workflows. It should not dilute the product toward a broad general commercial audience before the expert workflow is solid.

## Product Purpose

Takode is a local-first orchestration workspace for Claude Code and Codex. It gives both backends one consistent browser UI with persistent session history, readable tool-call visibility, permission control, responsive access, and optional quest/leader workflows when a single chat is not enough.

Takode should make agent work inspectable and steerable. A user should be able to see what happened, what needs attention, what changed, which quest or thread owns the work, and what phase a task is in without reconstructing state from terminal output.

Success means:
- A solo user can treat Takode as a cleaner, safer frontend for one coding agent.
- A leader user can coordinate multiple worker and reviewer sessions without losing the thread of each quest.
- Notifications, quest banners, tabs, thread feeds, and review surfaces agree about where attention belongs.
- The UI remains usable on desktop and mobile, especially when the user needs to answer a needs-input prompt or inspect review evidence.
- Major user-facing workflows have agent-operable CLI counterparts, so agents can coordinate Takode work without relying only on the graphical UI.
- Local project files, session state, quest state, and history stay under the user's control.

## Brand Personality

Takode should feel calm, precise, and operator-grade. The interface should behave like serious work infrastructure: dense enough for repeated expert use, quiet enough to stay out of the way, and explicit enough that users can trust what the system is doing.

At the same time, Takode can keep a light, pleasant product flavor through small cat-themed touches, as long as they stay useful and do not turn the app into a novelty UI. The playful layer should soften the experience without competing with operational clarity.

Suggested personality words: **calm**, **transparent**, **operator-grade**.

## Anti-references

Takode should not look or behave like:
- A marketing-first SaaS landing page inside the app shell.
- A decorative dashboard where cards, gradients, and large empty spacing reduce information density.
- An opaque terminal wrapper that hides tool calls, permissions, routing, or review state.
- A chat app where completed work disappears into history instead of becoming verifiable quest state.
- A mobile UI where overlays cover the composer, send controls, or approval affordances.
- A multi-thread interface where tab badges, notification rows, and feed content disagree.
- A brittle interface that depends on title guessing, stale local state, or hidden heuristics when reliable metadata is available.
- A layout that permits normal long content such as SHAs, inline code, URLs, or phase notes to create horizontal scrolling on mobile.
- A novelty interface where cat-themed decoration overwhelms the task surface.

## Design Principles

1. **Show the work, not the mystique.**
   Tool calls, permission requests, diffs, status, notifications, phase docs, and review evidence should be visible in plain operational language. The UI should build trust through inspection, not vague agent persona.

2. **Keep control within reach.**
   The composer, send/stop controls, approval paths, notification replies, and review actions must remain practical to reach on desktop and mobile. Layouts should prefer preserving the user's next action over preserving decorative balance.

3. **Dense, but never cramped.**
   Takode is an expert tool. It should support scanning many sessions, quests, tool calls, and phase states without bloating the layout, while still using clear spacing, wrapping, and hierarchy so long content remains readable.

4. **One source of truth per state.**
   Session names, message history, quest ownership, notification routing, and thread projections should come from authoritative state, not optimistic local guesses. When metadata is missing, degrade honestly rather than inventing certainty.

5. **Context travels with the task.**
   Quest threads, banners, notification chips, hover previews, phase documentation, and review summaries should keep the user oriented across sessions and phases. Moving from a notification to a thread should reveal the real source context when it is recoverable.

6. **Agents get a first-class path.**
   Most major Takode features should have CLI counterparts or documented command paths so agents can operate the product directly. CLI design should use progressive revelation: compact defaults for common work, richer detail available through explicit flags or follow-up commands.

7. **Local-first should feel dependable.**
   Because Takode runs on the user's machine and coordinates real code work, performance, persistence, and recovery are part of the design. Large leader sessions, reloads, mobile views, and restart recovery should feel sturdy rather than theatrical.

## Accessibility & Inclusion

Takode should prioritize practical usability for expert workflows:
- Preserve keyboard access and visible focus for controls that trigger navigation, approval, filtering, and message sending.
- Do not rely on color alone for status; pair color with labels, icons, counts, or placement.
- Respect reduced-motion preferences for attention and tab animations.
- Keep small text readable through contrast, line height, and meaningful truncation.
- Avoid page-level horizontal scrolling on mobile. Long technical content should wrap or be constrained inside the relevant panel.
- Ensure dark theme remains high quality because recent validation treats it as the primary app theme.
- Keep CLI and graphical workflows conceptually aligned so humans and agents can reason about the same session, quest, notification, and Journey state.
