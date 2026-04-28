---
name: quest-design
description: "Confirm quest intent before creating a new quest or refining an idea into a worker-ready quest. Invoke when a user asks to create, file, refine, scope, or prepare a quest, or before materially rewriting quest title/description/tags as part of refinement. Do not use for routine quest feedback, claiming, completion, verification checks, or other bookkeeping."
---

# Quest Design

Use this skill before creating a quest or refining an `idea` quest into a worker-ready quest.

The goal is to give the user one concise chance to correct the agent's understanding before quest text is written.
Initial Quest Journey proposal and approval belong to `/leader-dispatch`, not `/quest-design`.

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

Do not write the quest yet. First respond with:

### Understanding

- Intended goal and scope for the quest.
- Major assumptions that could affect the quest text.
- Relevant non-goals, when excluding them prevents misunderstanding.

### Clarification Questions

- Ask only the highest-leverage questions that could materially change the quest.
- If nothing remains unclear, say `- None. Please confirm the understanding above.`

End with:

---
Please confirm or correct.

## Waiting

After sending the confirmation, stop and wait for the user.

If you are acting as a leader/orchestrator and the confirmation asks a blocking question, run `takode notify needs-input "<brief summary>"` after the text response so the user notices. For obvious short choices, add one to three `--suggest <answer>` flags, but never use suggestions instead of the written confirmation context.

If the user corrects the understanding and ambiguity remains, repeat the same structure with the updated understanding.

Only after the user confirms should you create or refine the quest.
