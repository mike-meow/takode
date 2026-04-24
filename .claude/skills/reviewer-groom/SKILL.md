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

When the scope includes quest rework or human feedback, also check quest comment hygiene. The worker should keep one substantive quest summary/comment current by default, and should consolidate feedback-addressing details into that comment when clear. Do not require separate summary and addressed-feedback comments unless the updates are materially different or separate comments make the quest easier to read.

## Required Review Workflow

This workflow is mandatory.

Do not do an informal "read a few files and give an impression" review.
Do not jump straight to findings.

You must:

1. gather context first
2. decide which review aspects are relevant for this specific change
3. turn the relevant aspects into a written checklist or todo artifact before judging the code
4. mark non-relevant aspects explicitly as not relevant instead of silently skipping them
5. review each chosen aspect one at a time in sequence
6. make your final report reflect that checklist coverage directly

The point is to force consistent coverage of all relevant review dimensions.
Context and checklist creation happen before judgment.
You must not write findings until the checklist exists and you have started working through it.

## Minimum Takode Context You Need

Takode tracks work in sessions.

- A **worker session** is the agent session that made the change.
- A **quest** is the persistent task record for that work.
- `takode info <session>` shows metadata about a session, including its worktree path.
- `takode peek <session>` shows recent conversation context from that session.
- `quest show <id>` shows the quest details.

You do not need the full Takode workflow to use this skill.
You only need enough context to identify the worker, inspect the diff, and review the code.

## Prefer The Most Token-Efficient Takode View

Reviewer work is primarily human judgment, not machine parsing.
Default to the most compact Takode view that answers the current question.

- Prefer plain-text `takode info <worker_session>` for reviewer work.
- Use `takode info <worker_session> --json` only when you truly need exact structured fields, plan to pipe the result into another command, or need to confirm a field whose plain-text rendering is ambiguous.
- Prefer a targeted `takode peek` window when the leader already gave you a message range or turn to inspect.
- Use `takode read <worker_session> <msg_id>` when one specific leader instruction, worker report, or prior reviewer finding matters in full.
- Use `--show-tools` only when the exact commands the worker ran are relevant to the review. Otherwise keep the peek output narrower.

In practice, plain-text `takode info` usually gives you the only fields you need for reviewer-groom:

- worktree path
- repo root
- actual branch and diff base
- claimed quest

The JSON form is often much larger because it includes fields such as the injected system prompt and task history, which are usually irrelevant to a code-quality review.

## Resolve The Scope First

Before reviewing, resolve the concise scope string against the current conversation.

You should be able to identify:

- the worker session number
- the rough area or behavior to focus on

Usually the leader's message immediately before this skill invocation gives you that information.
In practice, the best scope strings often name the quest, the worker, and the message range containing the worker's follow-up.

If you cannot tell which worker or which change is being referenced, stop and ask for clarification instead of guessing.
If the scope is nominally clear but you still see real misunderstanding risk, ask the leader immediately in plain text, call `takode notify needs-input` with a short summary, and stop until you get an answer.

Scope resolution is still part of context gathering, not evaluation.
Do not start writing findings during this step.

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

## Build An Explicit Review Checklist

After you gather context and inspect the scope, decide which review aspects are relevant for this change.

Then build an explicit checklist before you start judging the code.
The checklist must exist as a written artifact, not just in your head.

The checklist should include every relevant review aspect and omit only aspects that are genuinely not relevant.

At minimum, you must explicitly decide whether each of these is relevant:

- repo instruction compliance
- complexity/design quality
- test coverage
- correctness
- performance
- security

Not every change needs all six, but every review must include an explicit relevance decision for each.

If your environment supports TodoWrite or a comparable checklist mechanism, use it.
If not, write the checklist explicitly in your own notes or response before proceeding.

For each checklist item, capture enough structure that you can review it sequentially:

- aspect name
- relevance decision
- evidence you expect to inspect
- eventual outcome: pass, fail, or not relevant

Examples:

- code change with logic and tests:
  - repo instruction compliance
  - complexity/design quality
  - test coverage
  - correctness
  - performance
- docs/workflow change:
  - repo instruction compliance
  - workflow clarity and consistency
  - command/example accuracy

Do not skip this step.
Do not begin writing `Critical`, `Recommended`, or `Suggestions` findings until this checklist is written.

## Scope Discipline

Stay focused on the actual change named in the scope string.

- Start with the diff.
- Read changed files before reading unrelated code.
- Treat the diff as the default review boundary.
- Expand outward only when the diff raises a question you cannot answer locally.
- Avoid broad codebase exploration unless it is clearly necessary.
- Work through the checklist one item at a time instead of blending all review aspects together.

If you leave the diff scope, do it for a concrete reason and keep the expansion narrow.

## Step-By-Step Workflow

### Step 1: Identify The Worker And Worktree

Use the current conversation plus Takode metadata to identify the target worker.

Start with:

```bash
takode info <worker_session>
takode peek <worker_session>
```

If the scope already points to a specific window, prefer a bounded peek immediately instead of the broad default view:

```bash
takode peek <worker_session> --from <msg_id> --count <N>
# or
takode peek <worker_session> --turn <N>
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

Only fall back to `takode info <worker_session> --json` if you need exact structured fields that the plain-text view does not answer cleanly.

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

At the end of this step, you should know what changed before you start judging whether it is good.

### Step 4: Focus The Review Using The Scope String

Use the scope string to decide which parts of the diff matter most.

Example:

- if the scope says `Review [q-324] for reviewer-groom follow-up after worker #469's update ...`, focus on the follow-up range first, then confirm the worker actually addressed the quality-review findings
- if the scope says `worker #42: permission routing fix and related tests`, spend most of your attention on permission logic and any related tests

The scope string narrows your attention.
It does not replace reading the diff.
This is still context gathering, not the point where you start writing findings.

If the leader already gave you message links or a narrow range, prefer targeted Takode reads over a larger generic peek:

```bash
takode peek <worker_session> --from <msg_id> --count <N>
takode read <worker_session> <msg_id>
```

Add `--show-tools` only when the worker's exact commands or test invocations matter to the checklist item you are reviewing.

### Step 5: Decide Relevance And Create The Checklist

Based on the scope, status output, diff, and surrounding context:

1. decide which review aspects are relevant
2. create the explicit checklist
3. mark any non-relevant aspects as intentionally not relevant

Do not silently skip review aspects.
Do not continue until the checklist exists in writing.

### Step 6: Review Each Aspect Sequentially

Work through the checklist one aspect at a time.
Finish one checklist item before moving to the next.

For each checklist item:

1. inspect the relevant evidence
2. decide whether it passes, fails, or is not relevant
3. record any finding before moving to the next item

Do not collapse all review dimensions into one blended impression.
Do not write the final report until every checklist item has an outcome.

### Step 7: Produce The Initial Review

Return a single deduplicated report with these sections:

- `Coverage`
- `Critical`
- `Recommended`
- `Suggestions`
- `Looks Good`

Severity rules:

- `Critical`: must be fixed before acceptance
- `Recommended`: should be fixed before acceptance unless there is a strong reason not to
- `Suggestions`: optional improvements

The `Coverage` section should explicitly summarize:

- which aspects you reviewed
- which aspects you marked not relevant
- the order you reviewed them in
- where the actual findings came from

When referencing files, use Takode clickable file links such as [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162).
The `Coverage` section should read like a summary of the checklist you actually used, not a generic boilerplate sentence.

## Follow-Up Review

You may be asked to review the same worker's follow-up after they respond to your findings.

In that case:

1. Re-read your prior `Critical` and `Recommended` findings.
2. Read the worker's latest report and latest diff.
3. Check whether the worker created a checkpoint commit before the follow-up fixes. When they did, use that split to review only the new work first.
4. Re-establish the checklist for the follow-up review, reusing prior relevant aspects and adding any new ones the follow-up diff introduces.
5. Check whether each required finding was:
   - fixed, or
   - intentionally not fixed with a solid justification
6. Ignore unresolved `Suggestions` unless they expose a deeper required issue.

As part of that follow-up check, re-run:

```bash
git --no-optional-locks -C <worktree_path> status --short
git --no-optional-locks -C <worktree_path> log --oneline --decorate -n 8
git --no-optional-locks -C <worktree_path> diff --stat <base_branch>
git --no-optional-locks -C <worktree_path> diff <base_branch>
```

Again, do not miss `??` untracked files or new directories.

If the worker made a checkpoint commit before the reviewer follow-up, identify that commit from `git log` and review `git diff <checkpoint_commit>..HEAD` first. That narrower diff is the primary evidence for whether the worker addressed the follow-up findings cleanly.

Re-check the worker's response against the same checklist mindset:

- each prior `Critical` must now pass or be explicitly justified
- each prior `Recommended` must now pass or be explicitly justified
- unresolved `Suggestions` are only blocking if they expose a deeper required issue
- any newly introduced relevant review aspect must also be checked instead of being silently ignored
- for quest feedback follow-up, the quest should not accumulate multiple duplicated or overly similar worker comments; require consolidation if readability regressed

For a follow-up review, return exactly one of:

**ACCEPT**: The worker addressed all Critical and Recommended findings, or justified any intentional skips.
[1-2 sentence justification]

**CHALLENGE**: The worker did not address the required follow-up.
- [file.ts:10](file:path/to/file.ts:10) Remaining issue
- Missing explanation for skipped recommendation: ...

## Output Format For The Initial Review

```text
## Reviewer Groom Report

### Coverage
- Covered: repo instruction compliance, complexity/design quality, test coverage, correctness
- Not relevant: performance, security
- Review order: repo instruction compliance -> complexity/design quality -> test coverage -> correctness
- Findings came from: test coverage, correctness

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
- Build an explicit review checklist before judging the code.
- Make that checklist a written artifact, not an informal mental list.
- Make an explicit relevance decision for each major review aspect.
- Review each selected aspect one at a time in sequence.
- Gather context before judgment and do not jump straight to findings.
- Make the final report reflect checklist coverage.
- Stay diff-scoped unless deeper reading is clearly necessary.
- Check `git status --short` before relying on diff output.
- Handle `??` untracked files and new directories explicitly.
- Be concrete and specific.
