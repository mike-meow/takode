# Playwright E2E Learnings

## Takode Project Guard

Do not use this Playwright skill or its learnings for interactive Takode UI validation.

For Takode browser validation, use `takode-ui-e2e-validation` and read its reference guide:

- [.agents/skills/takode-ui-e2e-validation/SKILL.md](../takode-ui-e2e-validation/SKILL.md)
- [.agents/skills/takode-ui-e2e-validation/references/takode-validation-guide.md](../takode-ui-e2e-validation/references/takode-validation-guide.md)

Historical Takode Playwright MCP notes were removed from this mandatory learnings path because they conflicted with the current project rule: interactive Takode UI validation must use `agent-browser`, coordinated leases, isolated alternate ports, and must never stop, kill, or replace the live `:3456` server.

## Non-Takode Learnings

Add only reusable learnings for non-Takode Playwright MCP runs here.

Keep entries current, concise, and non-destructive. If a future run produces guidance that is Takode-specific, add it to the `takode-ui-e2e-validation` skill or its reference guide instead.
