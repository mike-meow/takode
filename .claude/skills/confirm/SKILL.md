---
name: confirm
description: Confirm the user's intent before doing any work. Invoke this skill whenever the user includes /confirm anywhere in their message -- even mid-sentence, even if it looks like conversational agreement (e.g. "/confirm Yes, do it"). The /confirm token is always a skill invocation, never conversational. Do not take action on the specific instruction or change request under /confirm until the confirm workflow completes.
---

# Confirm

Use this skill when the user explicitly invokes `/confirm`.

The purpose is to eliminate ambiguity before execution begins.
The pause is instruction-scoped: it applies to the request being confirmed, not to unrelated work that is already underway.

## Core Rules

- Do not start the specific task or change request under `/confirm` yet.
- Do not make edits, launch jobs, or take any irreversible action for that gated instruction before explicit user confirmation.
- Do not treat `/confirm` as an implicit pause on unrelated active work.
- Be concise, but thorough enough to remove ambiguity.
- Prefer easy-to-read bullet points over long paragraphs.
- Put major assumptions and important non-goals directly in `Understanding` when misunderstanding them could materially change the outcome.
- Ask the most important clarification questions first. A second round is fine when the first answers expose deeper ambiguity.
- Output the detailed confirmation text before firing any `needs-input` notification.

## Required Response Structure

Always respond with these 2 sections in this order:

### Understanding

- Restate the user's intended goal, deliverable, scope, constraints, and expected next step.
- Include major assumptions inline instead of creating a separate assumptions section.
- Include what you believe you should and should not do if that distinction matters.
- Keep this section compact. Do not repeat the same idea in multiple bullets.

### Clarification Questions

- Ask only the highest-leverage questions needed to eliminate ambiguity.
- Prefer a short first batch over every conceivable question.
- If nothing remains unclear, say `- None.`
- Fold any ambiguity into the questions instead of creating a separate ambiguities section.

After the textual response is fully output:

- Run `takode notify needs-input "<brief summary>"` to fire a notification.
- Keep the notification summary short and specific to the decision or confirmation needed.
- When the answer choices are obvious and short, include one to three `--suggest <answer>` options, such as `--suggest yes --suggest no`.
- Do not use suggested answers instead of writing the full confirmation context and questions in the textual response.
- Do not add a final one-sentence confirmation prompt such as `Please confirm or correct.`
- Do not add a horizontal divider for a final confirmation sentence.
- Do not fire the notification before finishing the textual confirmation output.
- If you are acting as a leader/orchestrator, send the textual confirmation as a normal leader response with the correct first-line thread marker (`[thread:main]` or `[thread:q-N]`) before calling `takode notify needs-input`. Normal worker and reviewer sessions should use ordinary chat.

## Question Prioritization

Prioritize questions in this order:

1. Goal-changing ambiguity
2. Scope boundaries
3. Deliverable format
4. Execution-affecting constraints
5. Non-goals that could cause expensive misunderstandings
6. Secondary preferences

## After the User Responds

- If the user corrects or clarifies the request and ambiguity remains, produce the same response structure again with the updated understanding, then fire a fresh `takode notify needs-input` notification after the text is complete.
- If the user confirms the understanding, proceed with execution following that confirmed understanding.

## Quality Bar

A good `/confirm` response:

- makes the intended work legible
- exposes risky assumptions early
- asks only the questions that matter
- is concise enough that the user can scan it quickly
- leaves no important ambiguity before execution starts
