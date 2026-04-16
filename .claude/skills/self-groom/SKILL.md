---
name: self-groom
description: "Expensive multi-perspective self-review using parallel subagents. Use when asked for a deep self-review, when the reviewer explicitly escalates to the parallel path, or when you need broader code-quality coverage than the default reviewer-owned pass."
argument-hint: "[file or directory to focus on]"
---

# /self-groom - Parallel Deep Self-Review

Get the git diff of recent changes, classify the change, then launch parallel review subagents. Synthesize their feedback into a prioritized report.

This is the expensive path. Use `/self-groom` when the user explicitly wants a deeper self-review or when the reviewer asks for the parallel pass.

## Reviewers

Launch all applicable reviewers **simultaneously** as subagents.

### 1. CLAUDE.md Compliance (always run)

The subagent should read all CLAUDE.md files (user-level, project-level, repo root) and check every change against documented guidelines. Flag violations with specific file:line references.
If you are Codex, then check for AGENTS.md compliance instead. (Often AGENTS.md is aliased to CLAUDE.md, but if both exist, check AGENTS.md for Codex and CLAUDE.md for Claude.)

### 2. Complexity Reducer (always run)

Apply Software Design Principles to identify unnecessary complexity:
- **Deep modules over shallow** — Flag shallow wrappers, interfaces as complex as implementations
- **Pull complexity downward** — Callers shouldn't handle complexity that belongs inside a module
- **Define errors out of existence** — Error handling eliminable through better API design
- **Different layer, different abstraction** — Flag pass-through methods adding no value
- **Information hiding** — Implementation details leaking through interfaces
- **General-purpose modules are deeper** — Overly specific solutions with simpler general alternatives
- **Avoid excessive decomposition** — Many small functions/classes that could be fewer, deeper abstractions

Also fix other basic code quality issues: naming, formatting, comments, dead code, duplication.

For each issue: state the problem, which principle it violates, and a concrete fix.

### 3. Test Coverage (conditional: if touching testable code or tests)

Check if new code paths are tested. Are tests testing behavior (not implementation)? Obvious edge cases missing? Brittle coupling to implementation details?

### 4. Performance, Correctness & Security (conditional: if involving data processing, complex logic, I/O, auth, or user input)

Performance (O(n²) where O(n) possible, unnecessary copies). Correctness (off-by-one, race conditions, unhandled edge cases). Security (injection, hardcoded secrets, unsafe deserialization).

## Output Format

Combine all findings into a deduplicated, prioritized report:

- When referencing files, use Takode's clickable `file:` link format, not plain `file:line` text.
- Prefer short labels and repo-root-relative targets when possible, for example: `[TopBar.tsx:162](file:web/src/components/TopBar.tsx:162)`.
- Use absolute `file:` links only when a relative path would be ambiguous or unavailable.

```
## Groom Report

### Critical (must fix)
- [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162) Issue — Reviewer: X

### Recommended (should fix)
- [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162) Issue — Reviewer: X

### Suggestions (nice to have)
- [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162) Issue — Reviewer: X

### Looks Good
- Aspects that passed with no issues
```
