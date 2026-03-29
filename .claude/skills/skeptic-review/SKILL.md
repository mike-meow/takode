---
name: skeptic-review
description: >-
  Adversarial review of a worker's completed task. Spawns a temporary reviewer
  session that independently evaluates whether the worker actually did thorough
  work or took shortcuts. Returns ACCEPT or CHALLENGE with specific questions.
  Use when a worker's claim seems too easy, too fast, or contentious
  ("nothing to fix", "can't reproduce", "already works").
argument-hint: "<session_id>"
---

# /skeptic-review -- Adversarial Worker Output Review

You are running a skeptical review of a worker session's completed task.
This is NOT a code quality review (that's `/groom`). This is a work integrity
review: did the worker actually do the work properly, or did they take shortcuts?

## When to Use

- Worker claims "nothing to fix" or "no changes needed"
- Worker claims "can't reproduce" a reported issue
- Worker completed suspiciously fast for the complexity of the task
- Worker's diff seems too small or too large for the stated task
- Any time you want independent verification of a worker's claim

## Input

The skill takes a session ID as an argument: `/skeptic-review 93`

## Workflow

### Step 1: Gather Context

Collect three pieces of information:

1. **The task**: What was the worker asked to do? Read the dispatch message
   and/or quest description.
   ```bash
   takode peek <session_id> --from 0 --count 5   # see the initial task
   quest show <quest_id>                          # if quest-linked
   ```

2. **The worker's report**: What did the worker claim they did?
   ```bash
   takode peek <session_id>                       # see recent activity
   takode read <session_id> <last_msg_index>      # read completion report
   ```

3. **The actual diff**: What code actually changed?
   ```bash
   takode info <session_id> --json                # get worktree path
   git -C <worktree_path> diff --stat <base_branch>
   git -C <worktree_path> diff <base_branch>      # full diff
   ```

### Step 2: Spawn Temporary Reviewer Session

Spawn a temporary session using `takode spawn` with `--fixed-name` and
`--no-worktree`. The reviewer runs in its own session with its own context
window, so it doesn't burn leader tokens or block the leader's turn.

Compose the review prompt with all context from Step 1, then spawn:

```bash
takode spawn --fixed-name 'Skeptic review of #<worker_session_num>' --no-worktree --message 'You are a skeptic reviewer.

You are reviewing a worker session'\''s completed task for work integrity.
This is NOT a code quality review. Your job is to independently evaluate
whether the worker did thorough, honest work -- or took shortcuts.

Assume the worker may have:
- Run a test once, seen it pass, and declared victory without investigating
- Made the minimal change to make a symptom disappear without fixing root cause
- Claimed "can'\''t reproduce" after a superficial attempt
- Copied existing code instead of understanding and improving it
- Addressed the letter of the task but missed the spirit

## Task Given to Worker
<paste the original dispatch message / quest description>

## Worker'\''s Completion Report
<paste the worker'\''s final summary message>

## Actual Code Changes
<paste git diff --stat and relevant portions of the full diff>

## Worker'\''s Investigation Process
<paste key messages showing what the worker tried, from takode peek>

## Your Review

Evaluate:
1. **Completeness**: Does the diff fully address the task? Are there gaps
   or aspects the worker ignored?
2. **Root cause**: Did the worker identify and fix the actual root cause,
   or just patch a symptom?
3. **Investigation depth**: Did the worker explore sufficiently, or jump
   to the first conclusion? Look at their tool usage -- did they read
   enough code, run enough tests, consider edge cases?
4. **Correctness**: Could the change introduce new bugs or regressions?
5. **Honesty**: Does the worker'\''s report accurately describe what they did?
   Any exaggerations or omissions?

## Verdict

Respond with exactly one of:

**ACCEPT**: The work is thorough and the claims are honest.
[1-2 sentence justification]

**CHALLENGE**: The work has gaps or the claims are questionable.
[List specific questions the leader should send back to the worker, e.g.:
- "You said the test passes, but did you run it under load / in the full suite?"
- "Your diff doesn'\''t touch X, but the task asked for X -- why?"
- "You investigated for 2 minutes on a complex task -- what did you check?"]'
```

The reviewer session:
- Is named "Skeptic review of #XX" (set via `--fixed-name`, auto-namer disabled)
- Does NOT count toward the 5-worker herd limit
- Runs independently -- do NOT block waiting for it

### Step 3: React to Reviewer Verdict

When the reviewer session finishes, you'll receive a `turn_end` herd event.
React to it:

1. **Peek at the verdict**:
   ```bash
   takode peek <reviewer_session_id>
   ```

2. **Act on the verdict**:
   - **ACCEPT**: Report to the user that the work passed adversarial review.
   - **CHALLENGE**: Send the specific questions to the original worker via
     `takode send <worker_session_id> "<questions>"`. Wait for their response,
     then re-evaluate if needed.

3. **Archive the reviewer session**:
   ```bash
   takode archive <reviewer_session_id>
   ```

## Important Notes

- This skill spawns a **temporary session**, not a subagent. The reviewer
  runs in its own context window and doesn't consume leader tokens.
- Reviewer sessions don't need worktrees -- they only read and evaluate.
- The `--fixed-name` flag sets the "Skeptic review of #XX" name and disables auto-naming.
- Keep the review focused on work integrity, not code style. `/groom`
  handles code quality.
- Don't use this for every worker completion -- only when something
  feels off or the stakes are high. Overuse wastes time and erodes
  trust with workers who consistently do good work.
