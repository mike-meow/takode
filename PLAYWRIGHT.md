# Playwright MCP Guide

This project uses `mcp-cmd` to interact with Playwright MCP for E2E testing. This approach keeps the Playwright MCP out of the main agent's context window while still providing full browser automation capabilities.

## Port Configuration

The Companion dev server runs on two ports:
- **Vite HMR frontend**: `http://localhost:5174`
- **Hono API backend**: `http://localhost:3456` (or 3457 in some worktrees)

Always use the **frontend port (5174)** for browser testing.

## Quick Start

1. **Start the dev server** (if not already running):
   ```bash
   cd web && bun install && bun run dev
   ```

2. **Start the Playwright MCP server** (keeps browser session alive across commands):
   ```bash
   npx -y mcp-cmd start playwright npx -y @playwright/mcp@latest
   ```

3. **Navigate to the app**:
   ```bash
   npx -y mcp-cmd call playwright browser_navigate --url="http://localhost:5174"
   ```

4. **Take a snapshot** (preferred over screenshots for interactions):
   ```bash
   npx -y mcp-cmd call playwright browser_snapshot
   ```

5. **Interact with elements** using refs from the snapshot:
   ```bash
   npx -y mcp-cmd call playwright browser_click --element="Submit button" --ref="A1"
   ```

6. **Take a screenshot**:
   ```bash
   npx -y mcp-cmd call playwright browser_take_screenshot --filename="step1.png"
   ```

7. **Stop the server when done**:
   ```bash
   npx -y mcp-cmd stop playwright
   ```

**Tool Discovery:** Run `npx -y mcp-cmd tools playwright` to see all available browser tools with their full parameter schemas.

## Key Pages for Testing

| Page | URL | Purpose |
|------|-----|---------|
| Home | `http://localhost:5174` | Session list, create new sessions |
| Playground | `http://localhost:5174/#/playground` | Visual component catalog with mock data for all UI components |
| Chat View | `http://localhost:5174/#/session/<id>` | Active session chat |

The **Playground page** (`#/playground`) is particularly useful for testing UI components in isolation. It contains mock data for:
- Message bubbles (user, assistant, streaming)
- Tool blocks (Bash, Edit, Write, Read, etc.)
- Permission banners (ExitPlanMode, AskUserQuestion, etc.)
- Task panels
- Various component states

## Best Practices

1. **Use snapshots for interactions** - `browser_snapshot` returns element refs needed for clicks/typing
2. **Screenshot paths** - Screenshots are saved to `/tmp/playwright-mcp-output/`. Copy them to the project:
   ```bash
   mkdir -p e2e_tests/screenshots
   cp /tmp/playwright-mcp-output/*/*.png e2e_tests/screenshots/
   ```
3. **Wait for elements** - Use `browser_wait_for` instead of fixed delays
4. **Organize screenshots** - Save to `e2e_tests/screenshots/<test-name>/step1.png`
5. **Always stop the server** - Run `mcp-cmd stop playwright` when done testing

## Screenshot Storage

Screenshots go to `e2e_tests/screenshots/` (gitignored). Create subdirectories per test:

```
e2e_tests/screenshots/
├── plan-expand/
│   ├── step1-collapsed.png
│   └── step2-expanded.png
└── permission-banner/
    └── ...
```

Remember: Please always screenshot key steps as proof of your work at the end to help the reviewer verify the work and potentially identify issues for you!
