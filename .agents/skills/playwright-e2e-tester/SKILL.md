---
name: playwright-e2e-tester
description: "Use this skill when you need end-to-end UI testing in a real browser (Playwright MCP runs), including visual verification, workflow checks, and regression testing with screenshot evidence."
---

# Playwright E2E Tester

Use this skill to run browser-based E2E verification for UI changes, bug fixes, and user workflows.

## When To Use

- Visual verification of new or updated UI components
- Regression checks after frontend/backend refactors
- End-to-end workflow validation from a user perspective
- Bug reproduction and post-fix verification in-browser

## Prerequisites

- Ensure the target application is running and reachable in a browser.
- Read repository-level agent instructions (`AGENTS.md` or equivalent) for project-specific URLs, ports, and setup commands.
- Ensure `node`/`npx` are available.

## Quick Start (Mandatory)

Before any browser action:

1. Start Playwright MCP:
   - npx -y mcp-cmd start playwright npx -y @playwright/mcp@latest
2. Navigate to the target URL:
   - npx -y mcp-cmd call playwright browser_navigate --url="<target-url>"
3. Snapshot (preferred for interactions):
   - npx -y mcp-cmd call playwright browser_snapshot
4. Interact using refs from snapshot:
   - npx -y mcp-cmd call playwright browser_click --element="Submit button" --ref="A1"
5. Screenshot:
   - npx -y mcp-cmd call playwright browser_take_screenshot --filename="step1.png"
6. Stop MCP server when done:
   - npx -y mcp-cmd stop playwright

## Browser Automation (via `mcp-cmd`)

This workflow uses Playwright MCP through shell commands, not direct Playwright scripts.
- Start MCP server once at the beginning and keep it running through the test flow.
- Use: npx -y mcp-cmd tools playwright
  to discover all available operations and parameter schemas.

## Testing Workflow

1. Plan test cases and expected outcomes.
2. Execute each flow step-by-step.
3. Capture screenshots at each significant state change.
4. If behavior is wrong: diagnose, fix, and re-run until passing.
5. Continue until all requested checks are complete.

## Best Practices

- Prefer browser_snapshot for interaction planning.
- Use browser_wait_for instead of fixed sleeps.
- Organize screenshots by test case and step name.
- Capture key steps as proof for reviewers.

## Evidence Requirements

- Every important claim should be backed by screenshots.
- Include both successful and failure/fix verification states.
- Use descriptive screenshot names that map to test steps.

## Screenshot Storage

- Raw MCP screenshots are typically written under /tmp/playwright-mcp-output/
- Copy relevant screenshots to a repo-local evidence directory with descriptive filenames.

## Required Output

When done, report:

1. Pass/fail/fixed summary
2. What was tested and outcomes
3. Issues found and fixes applied
4. Screenshot inventory
5. Exact absolute screenshot directory path (required)

## Cleanup (Mandatory)

Run these in order after tests complete:

- npx -y mcp-cmd stop playwright
- rm -f .mcp-cmd.json

If `mcp-cmd stop` fails, explicitly warn that manual cleanup may be needed.
