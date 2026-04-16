---
name: reviewer-groom
description: "Quality review for another agent's change. Invoke it with a concise description of the change to review, then inspect that worker's status and diff and later verify whether required findings were addressed."
argument-hint: "\"<concise change description>\""
---

# /reviewer-groom - Review Another Agent's Change

Use this skill when you are reviewing code written by another agent.

Do not use this skill to review your own change.

## What To Pass In

Pass a short description of the change you are reviewing.

Good inputs identify:

- which quest or worker follow-up you are reviewing
- where the worker's follow-up can be found
- optionally, the narrow behavior or files that matter most

Example:

```text
/reviewer-groom "Review [q-324](quest:q-324) for reviewer-groom follow-up after worker #469's update in [#469 msg 723](session:469:723) through [#469 msg 746](session:469:746)"
```

Keep the input concise.
Do not paste the full diff, long quest history, or a full review prompt into the argument.
Treat the argument like the first sentence of a review request, not like a full report.

## How This Fits Into The Quest Journey

The usual flow is:

1. A worker implements a quest.
2. You review that work as a skeptic reviewer.
3. After skeptic ACCEPT, the leader tells you what change to quality-review.
4. You self-invoke `/reviewer-groom` with a concise scope string.
5. You return a quality report.
6. If the worker makes follow-up changes, you review those follow-ups and return `ACCEPT` or `CHALLENGE`.

This skill is designed for that exact workflow.

## What You Are Trying To Do

Your job is to perform a focused code-quality review of another agent's change.

You are not checking whether the worker was honest or thorough in its process.
That is the job of skeptic review.

You are checking the quality of the resulting code:

1. Does it follow repo instructions?
2. Is the design simpler and deeper rather than more fragmented?
3. Are the tests good enough for the changed behavior?
4. Are there obvious correctness, performance, or security problems?

Later, you may be asked to review the worker's follow-up changes and decide whether they addressed your required findings.

## Minimum Takode Context You Need

Takode tracks work in sessions.

- A **worker session** is the agent session that made the change.
- A **quest** is the persistent task record for that work.
- `takode info <session>` shows metadata about a session, including its worktree path.
- `takode peek <session>` shows recent conversation context from that session.
- `quest show <id>` shows the quest details.

You do not need the full Takode workflow to use this skill.
You only need enough context to identify the worker, inspect the diff, and review the code.

## Resolve The Scope First

Before reviewing, resolve the concise scope string against the current conversation.

You should be able to identify:

- the worker session number
- the rough area or behavior to focus on

Usually the leader's message immediately before this skill invocation gives you that information.
In practice, the best scope strings often name the quest, the worker, and the message range containing the worker's follow-up.

If you cannot tell which worker or which change is being referenced, stop and ask for clarification instead of guessing.

## What To Review

Review these categories in order.

### 1. Instruction Compliance

Read the applicable repo instructions first.

- If you are Codex, prefer `AGENTS.md` when both `AGENTS.md` and `CLAUDE.md` exist.
- Check for clear violations of repo rules, workflow rules, testing expectations, and process requirements that matter to the change.

### 2. Complexity And Design Quality

Look for unnecessary complexity, including:

- shallow wrappers
- pass-through layers that add little value
- complexity pushed onto callers when it should live inside a module
- excessive decomposition into many small helpers with weak boundaries
- overly specific solutions where a cleaner general solution exists
- leaked implementation details
- weak names, duplication, dead code, or comments that explain noise instead of intent

### 3. Test Coverage

Check whether the changed behavior is actually tested.

Prefer tests of behavior over tests that are tightly coupled to implementation details.
Call out missing edge cases when they are obvious and relevant.

### 4. Performance, Correctness, And Security

Go deeper here only when the change warrants it, for example:

- non-trivial logic
- I/O
- parsing
- auth or permissions
- user input
- data processing
- concurrency

Look for issues such as:

- incorrect behavior
- unhandled edge cases
- race conditions
- avoidable expensive work
- unsafe input handling

## Scope Discipline

Stay focused on the actual change named in the scope string.

- Start with the diff.
- Read changed files before reading unrelated code.
- Expand outward only when the diff raises a question you cannot answer locally.
- Avoid broad codebase exploration unless it is clearly necessary.

## Step-By-Step Workflow

### Step 1: Identify The Worker And Worktree

Use the current conversation plus Takode metadata to identify the target worker.

Start with:

```bash
takode info <worker_session> --json
takode peek <worker_session>
```

From `takode info`, find:

- the worker's worktree path
- the repo root
- the base or default branch if available
- the claimed quest ID if available

If the quest ID is available, read it:

```bash
quest show <quest_id>
```

### Step 2: Check Status Before Diffing

Use the worktree path from `takode info`.

```bash
git --no-optional-locks -C <worktree_path> status --short
```

Read the status output before diffing.

This matters because `git diff <base_branch>` does **not** show untracked files.

Pay special attention to:

- `?? <path>` for untracked files
- untracked directories that may contain new files relevant to the review

If the change includes untracked files or directories, read those files explicitly in addition to the tracked diff.

### Step 3: Read The Diff For That Worker

Then read the tracked diff:

```bash
git --no-optional-locks -C <worktree_path> diff --stat <base_branch>
git --no-optional-locks -C <worktree_path> diff <base_branch>
```

If the base branch is unclear, inspect `takode info` output first and use the branch metadata it provides.

### Step 4: Focus The Review Using The Scope String

Use the scope string to decide which parts of the diff matter most.

Example:

- if the scope says `Review [q-324] for reviewer-groom follow-up after worker #469's update ...`, focus on the follow-up range first, then confirm the worker actually addressed the quality-review findings
- if the scope says `worker #42: permission routing fix and related tests`, spend most of your attention on permission logic and any related tests

The scope string narrows your attention.
It does not replace reading the diff.

### Step 5: Produce The Initial Review

Return a single deduplicated report with these sections:

- `Critical`
- `Recommended`
- `Suggestions`
- `Looks Good`

Severity rules:

- `Critical`: must be fixed before acceptance
- `Recommended`: should be fixed before acceptance unless there is a strong reason not to
- `Suggestions`: optional improvements

When referencing files, use Takode clickable file links such as [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162).

## Follow-Up Review

You may be asked to review the same worker's follow-up after they respond to your findings.

In that case:

1. Re-read your prior `Critical` and `Recommended` findings.
2. Read the worker's latest report and latest diff.
3. Check whether each required finding was:
   - fixed, or
   - intentionally not fixed with a solid justification
4. Ignore unresolved `Suggestions` unless they expose a deeper required issue.

As part of that follow-up check, re-run:

```bash
git --no-optional-locks -C <worktree_path> status --short
git --no-optional-locks -C <worktree_path> diff --stat <base_branch>
git --no-optional-locks -C <worktree_path> diff <base_branch>
```

Again, do not miss `??` untracked files or new directories.

For a follow-up review, return exactly one of:

**ACCEPT**: The worker addressed all Critical and Recommended findings, or justified any intentional skips.
[1-2 sentence justification]

**CHALLENGE**: The worker did not address the required follow-up.
- [file.ts:10](file:path/to/file.ts:10) Remaining issue
- Missing explanation for skipped recommendation: ...

## Output Format For The Initial Review

```text
## Reviewer Groom Report

### Critical
- [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162) Issue

### Recommended
- [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162) Issue

### Suggestions
- [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162) Issue

### Looks Good
- Aspects that passed with no issues
```

## Important Constraints

- Review another agent's change, not your own.
- Invoke the skill with a concise change description.
- Use that description to focus the review, not to replace evidence gathering.
- Stay diff-scoped unless deeper reading is clearly necessary.
- Check `git status --short` before relying on diff output.
- Handle `??` untracked files and new directories explicitly.
- Be concrete and specific.
