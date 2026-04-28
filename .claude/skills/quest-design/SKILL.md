---
name: quest-design
description: "Confirm quest intent before creating a new quest or refining an idea into a worker-ready quest. Invoke when a user asks to create, file, refine, scope, or prepare a quest, or before materially rewriting quest title/description/tags as part of refinement. Do not use for routine quest feedback, claiming, completion, verification checks, or other bookkeeping."
---

# Quest Design

Use this skill before creating a quest or refining an `idea` quest into a worker-ready quest.

The goal is to give the user one concise chance to correct the agent's understanding before quest text is written.
When the user clearly wants a quest created and dispatched, combine this with `/leader-dispatch`: present the proposed quest draft and the proposed Quest Journey/scheduling plan together so one confirmation can approve quest text, Journey, and dispatch plan.

## Scope

Use `/quest-design` before:
- `quest create`
- refining an `idea` quest with `quest edit` or `quest transition --status refined`
- materially rewriting title, description, or tags as part of quest refinement

Do not use `/quest-design` for routine quest operations:
- `quest show`, `quest list`, `quest grep`, `quest history`, or `quest tags`
- `quest claim`
- adding feedback to an existing quest
- addressing feedback
- completing a quest or checking verification items
- verification inbox moves
- board updates
- lifecycle/status bookkeeping after an already-approved workflow

## Required Response

Do not write the quest yet. First respond with the narrowest confirmation surface that can safely move the request forward.

Best case: if the user clearly wants quest creation plus immediate dispatch and the request is already understood, include both:
- the proposed quest draft: title, description/scope, tags when useful, assumptions, and non-goals
- the proposed Quest Journey/scheduling draft from `/leader-dispatch`: phase sequence, concise per-phase purpose notes when useful, worker choice or fresh-spawn intent, and dispatch/queueing plan

One user confirmation can approve both the quest draft and the Journey/scheduling plan. Do not add a separate confirmation round just to restate understanding.

Clarification-needed case: ask the material questions using the quest framing below. After the user clarifies and no major ambiguity remains, the next response should include both the proposed quest draft and proposed Journey/scheduling draft together. More than two confirmation rounds should happen only when new, genuine ambiguity remains.

When you only need quest text approval and dispatch is not in scope, use:

### Understanding

- Intended goal and scope for the quest.
- Major assumptions that could affect the quest text.
- Relevant non-goals, when excluding them prevents misunderstanding.

### Clarification Questions

- Ask only the highest-leverage questions that could materially change the quest.
- If nothing remains unclear and dispatch is not in scope, say `- None. Please confirm the understanding above.`

End with:

---
Please confirm or correct.

## Waiting

After sending the confirmation, stop and wait for the user.

If you are acting as a leader/orchestrator and the confirmation asks a blocking question, send the confirmation as a normal leader response with the correct first-line thread marker (`[thread:main]` or `[thread:q-N]`), then run `takode notify needs-input "<brief summary>"` so the user notices. For obvious short choices, add one to three `--suggest <answer>` flags, but never use suggestions instead of the written confirmation context. Normal worker and reviewer sessions should use ordinary chat.

If the user corrects the understanding and ambiguity remains, repeat the same structure with the updated understanding. If the user clarifies enough to remove the ambiguity, draft the quest and Journey/scheduling plan together instead of sending a separate restated-understanding-only round.

Only after the user confirms should you create or refine the quest.
