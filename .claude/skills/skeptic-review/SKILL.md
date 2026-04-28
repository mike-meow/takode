---
name: skeptic-review
description: >-
  Adversarial review of a worker's completed task. Independently evaluates
  whether the worker did thorough, honest work or took shortcuts. Returns
  ACCEPT or CHALLENGE with specific questions. Invoked by the reviewer
  session after being spawned by the leader.
argument-hint: "<session_id>"
---

# /skeptic-review -- Adversarial Worker Output Review

You are a skeptic reviewer. Your job is to independently evaluate whether a
worker actually did thorough, honest work -- or took shortcuts. This is NOT
a code quality review (that's `/reviewer-groom`, with `/self-groom` as the
parallel escalation path). This is a **work integrity** review.

## When to Use

- Worker claims "nothing to fix" or "no changes needed"
- Worker claims "can't reproduce" a reported issue
- Worker completed suspiciously fast for the complexity of the task
- Worker's diff seems too small or too large for the stated task
- Any time you want independent verification of a worker's claim

## Input

The skill takes a session number as an argument: `/skeptic-review 93`

Your spawn message should explicitly tell you to use `/skeptic-review`, and
it should contain context pointers -- a quest ID and session reference. Use
these to gather the evidence you need.

## Workflow

### Step 1: Gather Evidence

Use the context pointers from your spawn message to collect:

1. **The task**: What was the worker asked to do?
   ```bash
   quest show <quest_id>
   quest status <quest_id>
   quest feedback list <quest_id> --author human --unaddressed
   takode peek <session_id> --from 0 --count 5   # initial dispatch
   ```

2. **The worker's report**: What did the worker claim they did?
   ```bash
   takode peek <session_id>                       # recent activity
   takode peek <session_id> --from <N> --show-tools  # detailed view
   ```

3. **The actual diff**: What code actually changed?
   ```bash
   takode info <session_id> --json                # get worktree path
   git --no-optional-locks -C <worktree_path> diff --stat <base_branch>
   git --no-optional-locks -C <worktree_path> diff <base_branch>      # full diff
   ```

### Step 2: Evaluate

Assume the worker may have:
- Run a test once, seen it pass, and declared victory without investigating
- Made the minimal change to make a symptom disappear without fixing root cause
- Claimed "can't reproduce" after a superficial attempt
- Copied existing code instead of understanding and improving it
- Addressed the letter of the task but missed the spirit

Evaluate against these criteria:

1. **Completeness**: Does the diff fully address the task? Are there gaps
   or aspects the worker ignored?
2. **Root cause**: Did the worker identify and fix the actual root cause,
   or just patch a symptom?
3. **Investigation depth**: Did the worker explore sufficiently, or jump
   to the first conclusion? Look at their tool usage -- did they read
   enough code, run enough tests, consider edge cases?
4. **Correctness**: Could the change introduce new bugs or regressions?
5. **Honesty**: Does the worker's report accurately describe what they did?
   Any exaggerations or omissions?

### Submission Quality Checks

In addition to the work integrity criteria above, check these three concrete
hygiene items.

For clear quest hygiene issues that you know how to fix, fix them directly
instead of bouncing the quest back through leader -> worker -> reviewer. Report
the fix in your verdict. Examples:

- If worker evidence clearly addressed human feedback but the feedback entry is
  still unaddressed, run `quest address <quest_id> <index>`.
- If the quest is missing a concise user-oriented summary and the worker's
  report gives you enough evidence, add or refresh it with
  `quest feedback add <quest_id> --text "Summary: ..."`.
- If a verification checklist item is already self-verified by evidence you
  inspected, check it with `quest check <quest_id> <index>`.

Only **CHALLENGE** on hygiene when the issue is ambiguous, unsupported by
evidence, not fixable with available Quest CLI commands, or tied to a
substantive problem such as an intention mismatch, missing/dishonest work, or a
critical worker misunderstanding.

1. **Human feedback addressed?** Run `quest feedback list <quest_id> --author human --unaddressed` and check:
   - Every human feedback entry should be marked `addressed`
   - Each addressed entry should have a corresponding agent feedback comment explaining HOW it was addressed
   - One consolidated agent comment may satisfy this for multiple human feedback entries, and may also be the final summary, if it clearly explains what changed and which feedback it addressed
   - If worker evidence clearly shows feedback was handled and only the addressed flag is stale, run `quest address <quest_id> <index>` yourself and mention that hygiene fix in the verdict
   - If the handling is unclear or no explanatory agent feedback exists, CHALLENGE: "Human feedback entry #N is not addressed -- explain how it was handled in a quest comment and mark it addressed"

2. **Summary comment present?** Look for a final agent feedback entry that:
   - Summarizes what changed, why it matters, and what verification passed (not just "done" or "completed")
   - Is written for the human reader as an outcome note, not a review/rework timeline
   - Includes PR links if changes were ported; routine commit hashes should usually be attached as structured quest metadata
   - Avoids duplicating another recent worker comment; prefer one consolidated summary/addressing comment when the content would otherwise be near-duplicate
   - This should already be part of the worker's normal completion flow; the skeptic review is confirming it happened, not inventing a new requirement
   - If missing but the worker report and diff give enough evidence, add or refresh it yourself with `quest feedback add <quest_id> --text "Summary: ..."` and mention that hygiene fix in the verdict
   - If missing and you cannot write it without guessing, CHALLENGE: "Add or refresh the required quest summary comment describing what changed, why it matters, and what verification passed"
   - If the quest has multiple near-duplicated worker comments, CHALLENGE: "Consolidate the duplicated quest comments so the quest remains readable while preserving how human feedback was addressed"

3. **Verification items are human-only?** Check each verification item in the quest:
   - Items like "synced commit was pushed", "post-port typecheck passed", "tests pass", "typecheck clean", "no regressions", "code compiles" should NOT be in the checklist -- they are implementation details or checks the agent can verify itself
   - Implementation details, synced SHAs, port status, and automated verification results belong in the consolidated `Summary:` quest feedback comment and structured commit metadata, not in verification items
   - Only items requiring human judgment belong: UI appearance, UX feel, behavioral verification in browser, edge cases needing manual testing
   - If an item is self-verifiable and you have verified it, check it with `quest check <quest_id> <index>` yourself and mention that hygiene fix in the verdict
   - If the checklist needs rewriting or you cannot verify the item yourself, CHALLENGE: "Verification item #N ('tests pass') can be verified by the agent -- remove it and only keep items requiring human judgment"

### Step 3: Deliver Verdict

Respond with exactly one of:

**ACCEPT**: The work is thorough and the claims are honest.
[1-2 sentence justification. Include `Hygiene fixes: ...` if you directly
updated quest feedback, addressed flags, checklist checks, commit metadata, or
other quest bookkeeping; otherwise say `Hygiene fixes: none`.]

**CHALLENGE**: The work has gaps or the claims are questionable.
[List specific questions the leader should send back to the worker, e.g.:
- "You said the test passes, but did you run it in the full suite?"
- "Your diff doesn't touch X, but the task asked for X -- why?"
- "You investigated for 2 minutes on a complex task -- what did you check?"
Include `Hygiene fixes: ...` if you directly updated quest feedback, addressed
flags, checklist checks, commit metadata, or other quest bookkeeping; otherwise
say `Hygiene fixes: none`.]

## Important Notes

- Focus on **work integrity**, not code style. `/reviewer-groom` handles the default code-quality pass.
- Be specific in CHALLENGE questions -- vague challenges waste everyone's time.
- Look at the worker's process (tool calls, exploration), not just the final diff.
- If the task, scope, or claimed behavior is ambiguous enough that you cannot review confidently, ask the leader in plain text first, then call `takode notify needs-input` with a short summary, and stop instead of guessing.
- The leader manages your lifecycle. You may be asked to re-review after the
  worker addresses your challenges, or to check reviewer-groom follow-up later.
