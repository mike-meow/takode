import type { GitHubPRInfo } from "../../api.js";
import type { McpServerDetail, PermissionRequest, ChatMessage, TaskItem } from "../../types.js";
import type { SidebarSessionItem } from "../../utils/sidebar-session-item.js";
import { buildHerdGroupBadgeThemes, getHerdGroupLeaderId } from "../../utils/herd-group-theme.js";

export const MOCK_SESSION_ID = "playground-session";
export const PLAYGROUND_SECTIONED_SESSION_ID = "playground-sectioned-feed";
export const PLAYGROUND_LOADING_SESSION_ID = "playground-loading-feed";
export const PLAYGROUND_CODEX_TERMINAL_SESSION_ID = "playground-codex-terminal-feed";
export const PLAYGROUND_CODEX_PENDING_SESSION_ID = "playground-codex-pending-feed";
export const PLAYGROUND_STARTING_SESSION_ID = "playground-chat-starting";
export const PLAYGROUND_RESUMING_SESSION_ID = "playground-chat-resuming";
export const PLAYGROUND_RECOVERING_SESSION_ID = "playground-chat-recovering";
export const PLAYGROUND_BROKEN_SESSION_ID = "playground-chat-broken";
export const PLAYGROUND_THREAD_PANEL_SESSION_ID = "playground-thread-panel-wait-for";
export const PLAYGROUND_SESSION_ROWS: Array<{ session: SidebarSessionItem; sessionName: string; preview: string }> = [
  {
    session: {
      id: "leader-alpha",
      model: "gpt-5.4",
      cwd: "/Users/stan/Dev/takode",
      gitBranch: "feat/herd-colors",
      isContainerized: false,
      gitAhead: 2,
      gitBehind: 0,
      linesAdded: 18,
      linesRemoved: 3,
      isConnected: true,
      status: "idle",
      sdkState: "connected",
      createdAt: 1,
      archived: false,
      backendType: "codex",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 0,
      pendingTimerCount: 1,
      isOrchestrator: true,
      sessionNum: 7,
    },
    sessionName: "Leader Alpha",
    preview: "Routing work across frontend, backend, and review sessions.",
  },
  {
    session: {
      id: "worker-alpha",
      model: "gpt-5.4-mini",
      cwd: "/Users/stan/Dev/takode",
      gitBranch: "feat/herd-colors",
      isContainerized: false,
      gitAhead: 1,
      gitBehind: 0,
      linesAdded: 9,
      linesRemoved: 1,
      isConnected: true,
      status: "running",
      sdkState: "running",
      createdAt: 2,
      archived: false,
      backendType: "codex",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 0,
      herdedBy: "leader-alpha",
      sessionNum: 8,
    },
    sessionName: "Worker Alpha",
    preview: "Tightening the badge palette and sidebar contrast.",
  },
  {
    session: {
      id: "reviewer-alpha",
      model: "gpt-5.4-mini",
      cwd: "/Users/stan/Dev/takode",
      gitBranch: "feat/herd-colors",
      isContainerized: false,
      gitAhead: 0,
      gitBehind: 0,
      linesAdded: 0,
      linesRemoved: 0,
      isConnected: true,
      status: "running",
      sdkState: "running",
      createdAt: 2.5,
      archived: false,
      backendType: "codex",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 0,
      herdedBy: "leader-alpha",
      reviewerOf: 8,
      sessionNum: 9,
    },
    sessionName: "Reviewer of #8 (running — green glow on parent badge)",
    preview: "Checking badge contrast ratios meet accessibility standards.",
  },
  {
    session: {
      id: "leader-beta",
      model: "claude-sonnet-4-5",
      cwd: "/Users/stan/Dev/takode",
      gitBranch: "feat/herd-colors",
      isContainerized: false,
      gitAhead: 0,
      gitBehind: 0,
      linesAdded: 4,
      linesRemoved: 0,
      isConnected: true,
      status: "idle",
      sdkState: "connected",
      createdAt: 3,
      archived: false,
      backendType: "claude",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 0,
      isOrchestrator: true,
      sessionNum: 12,
    },
    sessionName: "Leader Beta",
    preview: "Keeping infra workers organized during long-running tasks.",
  },
  {
    session: {
      id: "worker-beta",
      model: "claude-haiku-4-5",
      cwd: "/Users/stan/Dev/takode",
      gitBranch: "feat/herd-colors",
      isContainerized: false,
      gitAhead: 0,
      gitBehind: 0,
      linesAdded: 2,
      linesRemoved: 0,
      isConnected: true,
      status: "idle",
      sdkState: "connected",
      createdAt: 4,
      archived: false,
      backendType: "claude",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 0,
      herdedBy: "leader-beta",
      sessionNum: 13,
    },
    sessionName: "Worker Beta",
    preview: "Reviewing session naming and hover states.",
  },
  {
    session: {
      id: "reviewer-beta",
      model: "claude-haiku-4-5",
      cwd: "/Users/stan/Dev/takode",
      gitBranch: "feat/herd-colors",
      isContainerized: false,
      gitAhead: 0,
      gitBehind: 0,
      linesAdded: 0,
      linesRemoved: 0,
      isConnected: true,
      status: "idle",
      sdkState: "connected",
      createdAt: 4.5,
      archived: false,
      backendType: "claude",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 1,
      herdedBy: "leader-beta",
      reviewerOf: 13,
      sessionNum: 14,
    },
    sessionName: "Reviewer of #13 (permission — amber glow on parent badge)",
    preview: "Waiting for tool approval during code review.",
  },
  {
    session: {
      id: "worker-gamma",
      model: "claude-haiku-4-5",
      cwd: "/Users/stan/Dev/takode",
      gitBranch: "feat/herd-colors",
      isContainerized: false,
      gitAhead: 0,
      gitBehind: 0,
      linesAdded: 5,
      linesRemoved: 1,
      isConnected: true,
      status: "running",
      sdkState: "running",
      createdAt: 5,
      archived: false,
      backendType: "claude",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 0,
      herdedBy: "leader-beta",
      sessionNum: 15,
    },
    sessionName: "Worker Gamma (no reviewer — no badge)",
    preview: "Implementing dark mode toggle in settings panel.",
  },
  // Quest-named sessions: demonstrate ☐/☑ prefix styling
  {
    session: {
      id: "quest-in-progress",
      model: "claude-sonnet-4-5",
      cwd: "/Users/stan/Dev/takode",
      gitBranch: "fix/quest-styling",
      isContainerized: false,
      gitAhead: 1,
      gitBehind: 0,
      linesAdded: 12,
      linesRemoved: 4,
      isConnected: true,
      status: "running",
      sdkState: "running",
      createdAt: 6,
      archived: false,
      backendType: "claude",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 0,
      sessionNum: 20,
    },
    sessionName: "Fix quest title styling",
    preview: "Working on q-166: unchecked box for in-progress quests.",
  },
  {
    session: {
      id: "quest-needs-verification",
      model: "claude-sonnet-4-5",
      cwd: "/Users/stan/Dev/takode",
      gitBranch: "feat/dark-mode",
      isContainerized: false,
      gitAhead: 3,
      gitBehind: 0,
      linesAdded: 45,
      linesRemoved: 8,
      isConnected: true,
      status: "idle",
      sdkState: "connected",
      createdAt: 7,
      archived: false,
      backendType: "claude",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 0,
      sessionNum: 21,
    },
    sessionName: "Add dark mode toggle",
    preview: "Quest complete, awaiting verification.",
  },
];
export const PLAYGROUND_HERD_GROUP_THEMES = (() => {
  const leaderThemes = buildHerdGroupBadgeThemes(PLAYGROUND_SESSION_ROWS.map(({ session }) => session));
  const sessionThemes = new Map<string, ReturnType<typeof leaderThemes.get>>();
  for (const { session } of PLAYGROUND_SESSION_ROWS) {
    const leaderId = getHerdGroupLeaderId(session);
    if (!leaderId) continue;
    const theme = leaderThemes.get(leaderId);
    if (theme) sessionThemes.set(session.id, theme);
  }
  return sessionThemes;
})();

// Build a reviewer map for the playground: parentSessionNum → reviewer session
export const PLAYGROUND_REVIEWER_MAP = (() => {
  const map = new Map<number, (typeof PLAYGROUND_SESSION_ROWS)[number]["session"]>();
  for (const { session } of PLAYGROUND_SESSION_ROWS) {
    if (session.reviewerOf !== undefined) {
      map.set(session.reviewerOf, session);
    }
  }
  return map;
})();

/** Mock herd summary bar used in both collapsed and expanded playground cards. */

export function mockPermission(
  overrides: Partial<PermissionRequest> & { tool_name: string; input: Record<string, unknown> },
): PermissionRequest {
  return {
    request_id: `perm-${Math.random().toString(36).slice(2, 8)}`,
    tool_use_id: `tu-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makePlaygroundSectionedMessages(sectionCount: number, turnsPerSection = 50): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let timestamp = Date.now() - 300_000;

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
    for (let turnIndex = 0; turnIndex < turnsPerSection; turnIndex++) {
      const turnNumber = sectionIndex * turnsPerSection + turnIndex + 1;
      const label =
        turnIndex === 0 ? `Section ${sectionIndex + 1} marker` : `Section ${sectionIndex + 1} turn ${turnIndex + 1}`;
      messages.push({
        id: `playground-section-u${turnNumber}`,
        role: "user",
        content: label,
        timestamp: timestamp++,
      });
    }
  }

  return messages;
}

export function makePlaygroundMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `playground-msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

export const PERM_BASH = mockPermission({
  tool_name: "Bash",
  input: {
    command: "git log --oneline -20 && npm run build",
    description: "View recent commits and build the project",
  },
  permission_suggestions: [
    {
      type: "addRules" as const,
      rules: [{ toolName: "Bash", ruleContent: "git log*" }],
      behavior: "allow" as const,
      destination: "session" as const,
    },
    {
      type: "addRules" as const,
      rules: [{ toolName: "Bash", ruleContent: "npm run build" }],
      behavior: "allow" as const,
      destination: "projectSettings" as const,
    },
  ],
});

export const PERM_EDIT = mockPermission({
  tool_name: "Edit",
  input: {
    file_path: "/Users/stan/Dev/project/src/utils/format.ts",
    old_string: "export function formatDate(d: Date) {\n  return d.toISOString();\n}",
    new_string:
      'export function formatDate(d: Date, locale = "en-US") {\n  return d.toLocaleDateString(locale, {\n    year: "numeric",\n    month: "short",\n    day: "numeric",\n  });\n}',
  },
  permission_suggestions: [
    {
      type: "addRules" as const,
      rules: [{ toolName: "Edit" }],
      behavior: "allow" as const,
      destination: "session" as const,
    },
  ],
});

export const PERM_EDIT_PATCH = mockPermission({
  tool_name: "Edit",
  input: {
    file_path: "/Users/stan/Dev/project/src/utils/format.ts",
    changes: [
      {
        path: "/Users/stan/Dev/project/src/utils/format.ts",
        kind: "modify",
        unified_diff: [
          "diff --git a/src/utils/format.ts b/src/utils/format.ts",
          "--- a/src/utils/format.ts",
          "+++ b/src/utils/format.ts",
          "@@ -1 +1 @@",
          "-return d.toISOString();",
          "+return d.toLocaleDateString();",
        ].join("\n"),
      },
    ],
  },
});

export const PERM_WRITE = mockPermission({
  tool_name: "Write",
  input: {
    file_path: "/Users/stan/Dev/project/src/config.ts",
    content:
      'export const config = {\n  apiUrl: "https://api.example.com",\n  timeout: 5000,\n  retries: 3,\n  debug: process.env.NODE_ENV !== "production",\n};\n',
  },
});

export const PERM_READ = mockPermission({
  tool_name: "Read",
  input: { file_path: "/Users/stan/Dev/project/package.json" },
  permission_suggestions: [
    {
      type: "addRules" as const,
      rules: [{ toolName: "Read" }],
      behavior: "allow" as const,
      destination: "session" as const,
    },
    {
      type: "addRules" as const,
      rules: [{ toolName: "Read" }],
      behavior: "allow" as const,
      destination: "userSettings" as const,
    },
  ],
});

export const PERM_GLOB = mockPermission({
  tool_name: "Glob",
  input: { pattern: "**/*.test.ts", path: "/Users/stan/Dev/project/src" },
});

export const PERM_GREP = mockPermission({
  tool_name: "Grep",
  input: { pattern: "TODO|FIXME|HACK", path: "/Users/stan/Dev/project/src", glob: "*.ts" },
});

export const PERM_EXIT_PLAN = mockPermission({
  tool_name: "ExitPlanMode",
  input: {
    plan: `## Summary\nRefactor the authentication module to use JWT tokens instead of session cookies.\n\n## Changes\n1. **Add JWT utility** — new \`src/auth/jwt.ts\` with sign/verify helpers\n2. **Update middleware** — modify \`src/middleware/auth.ts\` to validate Bearer tokens\n3. **Migrate login endpoint** — return JWT in response body instead of Set-Cookie\n4. **Update tests** — adapt all auth tests to use token-based flow\n\n## Test plan\n- Run \`npm test -- --grep auth\`\n- Manual test with curl`,
    allowedPrompts: [
      { tool: "Bash", prompt: "run tests" },
      { tool: "Bash", prompt: "install dependencies" },
    ],
  },
});

export const PERM_GENERIC = mockPermission({
  tool_name: "WebSearch",
  input: { query: "TypeScript 5.5 new features", allowed_domains: ["typescriptlang.org", "github.com"] },
  description: "Search the web for TypeScript 5.5 features",
});

export const PERM_DYNAMIC = mockPermission({
  tool_name: "dynamic:code_interpreter",
  input: { code: "print('hello from dynamic tool')" },
  description: "Custom tool call: code_interpreter",
});

// Bash permission with NO suggestions — shows "Customize" button is always available
export const PERM_BASH_NO_SUGGESTIONS = mockPermission({
  tool_name: "Bash",
  input: {
    command: "rm -rf node_modules && npm install",
    description: "Clean reinstall dependencies",
  },
});

// Auto-approval evaluating state — collapsed with spinner while LLM evaluates
export const PERM_EVALUATING_BASH = mockPermission({
  tool_name: "Bash",
  input: { command: "git push origin main", description: "Push changes" },
  evaluating: "evaluating",
});

export const PERM_EVALUATING_BASH_LONG = mockPermission({
  tool_name: "Bash",
  input: {
    command:
      "cd /home/user/projects/my-app && npm run build --production && docker build -t my-app:latest . && docker push registry.example.com/my-app:latest",
    description: "Build and push Docker image",
  },
  evaluating: "evaluating",
});

export const PERM_EVALUATING_EDIT = mockPermission({
  tool_name: "Edit",
  input: { file_path: "/src/components/App.tsx", old_string: "const x = 1;", new_string: "const x = 2;" },
  evaluating: "evaluating",
});

// Auto-approval queued state — waiting in semaphore queue
export const PERM_QUEUED_BASH = mockPermission({
  tool_name: "Bash",
  input: { command: "npm test -- --coverage", description: "Run tests with coverage" },
  evaluating: "queued",
});

export const PERM_ASK_SINGLE = mockPermission({
  tool_name: "AskUserQuestion",
  input: {
    questions: [
      {
        header: "Auth method",
        question: "Which authentication method should we use for the API?",
        options: [
          { label: "JWT tokens (Recommended)", description: "Stateless, scalable, works well with microservices" },
          { label: "Session cookies", description: "Traditional approach, simpler but requires session storage" },
          { label: "OAuth 2.0", description: "Delegated auth, best for third-party integrations" },
        ],
        multiSelect: false,
      },
    ],
  },
});

export const PERM_ASK_MULTI = mockPermission({
  tool_name: "AskUserQuestion",
  input: {
    questions: [
      {
        header: "Database",
        question: "Which database should we use?",
        options: [
          { label: "PostgreSQL", description: "Relational, strong consistency" },
          { label: "MongoDB", description: "Document store, flexible schema" },
        ],
        multiSelect: false,
      },
      {
        header: "Cache",
        question: "Do you want to add a caching layer?",
        options: [
          { label: "Redis", description: "In-memory, fast, supports pub/sub" },
          { label: "No cache", description: "Keep it simple for now" },
        ],
        multiSelect: false,
      },
    ],
  },
});

// Messages
export const MSG_USER: ChatMessage = {
  id: "msg-1",
  role: "user",
  content: "Can you help me refactor the authentication module to use JWT tokens?",
  timestamp: Date.now() - 60000,
};

export const MSG_USER_MARKDOWN: ChatMessage = {
  id: "msg-1-md",
  role: "user",
  content: `I found a few issues in the auth flow:
Please keep the current logging in place while we refactor.

\`\`\`typescript
export const token = await getToken();
if (!token) throw new Error("missing token");
\`\`\`

The \`getToken()\` function is **not retrying** on network failure. Here's what I think we should do:

1. Add retry logic with *exponential backoff*
2. Cache the token in memory
3. Handle the edge case where the refresh token is expired

> The current behavior silently drops the error and returns null

# This line starts with a hash
Also --- this triple dash should not become a rule.

Check [this guide](https://example.com/auth) for reference.`,
  timestamp: Date.now() - 59000,
};

export const MSG_USER_SELECTION: ChatMessage = {
  id: "msg-1b",
  role: "user",
  content: "Can you review the selected lines?",
  timestamp: Date.now() - 57500,
  metadata: {
    vscodeSelection: {
      absolutePath: "/Users/demo/project/web/src/components/Composer.tsx",
      relativePath: "web/src/components/Composer.tsx",
      displayPath: "Composer.tsx",
      startLine: 35,
      endLine: 38,
      lineCount: 4,
    },
  },
};

export const MSG_USER_IMAGE: ChatMessage = {
  id: "msg-2",
  role: "user",
  content: "Here's a screenshot of the error I'm seeing",
  images: [
    {
      imageId: "playground-img-1",
      media_type: "image/png",
    },
  ],
  timestamp: Date.now() - 55000,
};

/* User message — injected by an agent (via takode CLI) */
export const MSG_USER_AGENT: ChatMessage = {
  id: "msg-agent-1",
  role: "user",
  content: "Run the full test suite and report any failures.",
  timestamp: Date.now() - 53000,
  agentSource: {
    sessionId: "abc123def456",
    sessionLabel: "#3 leader",
  },
};

export const MSG_ASSISTANT: ChatMessage = {
  id: "msg-3",
  role: "assistant",
  content: "",
  contentBlocks: [
    {
      type: "text",
      text: "I'll help you refactor the authentication module.\nWe can stage the migration instead of replacing auth in one pass.\n\nHere's what I found:\n- The current auth uses **session cookies** via `express-session`\n- Sessions are stored in a `MemoryStore` (not production-ready)\n- The middleware checks `req.session.userId`\n\n1. Keep the current session cookie path stable\n- avoid invalidating active browser sessions during rollout\n- preserve logout semantics while the JWT path is behind a flag\n\n1. Move persistence into a real store before the JWT cutover\n- Redis gives us shared state across replicas\n- it also removes the current MemoryStore production risk\n\n```typescript\n// Current implementation\napp.use(session({\n  secret: process.env.SESSION_SECRET,\n  resave: false,\n  saveUninitialized: false,\n}));\n```\n\n| Feature | Cookies | JWT |\n|---------|---------|-----|\n| Stateless | No | Yes |\n| Scalable | Limited | Excellent |\n| Revocation | Easy | Needs blocklist |\n",
    },
  ],
  timestamp: Date.now() - 50000,
};

export const MSG_ASSISTANT_LEADER_USER: ChatMessage = {
  id: "msg-leader-user",
  role: "assistant",
  content: "Worker #7 finished q-126 and opened a PR. Please review the leader chat behavior.",
  timestamp: Date.now() - 48000,
  metadata: { leaderUserMessage: true },
};

export const MSG_ASSISTANT_TOOLS: ChatMessage = {
  id: "msg-4",
  role: "assistant",
  content: "",
  contentBlocks: [
    { type: "text", text: "Let me check the current auth files." },
    {
      type: "tool_use",
      id: "tu-1",
      name: "Glob",
      input: { pattern: "src/auth/**/*.ts" },
    },
    {
      type: "tool_result",
      tool_use_id: "tu-1",
      content: "src/auth/middleware.ts\nsrc/auth/login.ts\nsrc/auth/session.ts",
    },
    {
      type: "tool_use",
      id: "tu-2",
      name: "Read",
      input: { file_path: "src/auth/middleware.ts" },
    },
    {
      type: "tool_result",
      tool_use_id: "tu-2",
      content:
        'export function authMiddleware(req, res, next) {\n  if (!req.session.userId) {\n    return res.status(401).json({ error: "Unauthorized" });\n  }\n  next();\n}',
    },
    { type: "text", text: "Now I understand the current structure. Let me create the JWT utility." },
  ],
  timestamp: Date.now() - 45000,
};

export const MSG_ASSISTANT_THINKING: ChatMessage = {
  id: "msg-5",
  role: "assistant",
  content: "",
  contentBlocks: [
    {
      type: "thinking",
      thinking:
        "Let me think about the best approach here. The user wants to migrate from session cookies to JWT. I need to:\n1. Create a JWT sign/verify utility\n2. Update the middleware to read Authorization header\n3. Change the login endpoint to return a token\n4. Update all tests\n\nI should use jsonwebtoken package for signing and jose for verification in edge environments. But since this is a Node.js server, jsonwebtoken is fine.\n\nThe token should contain: userId, role, iat, exp. Expiry should be configurable. I'll also add a refresh token mechanism.",
    },
    { type: "text", text: "I've analyzed the codebase and have a clear plan. Let me start implementing." },
  ],
  timestamp: Date.now() - 40000,
};

export const MSG_ASSISTANT_THINKING_CODEX: ChatMessage = {
  id: "msg-5b",
  role: "assistant",
  content: "",
  contentBlocks: [
    {
      type: "thinking",
      thinking:
        "Need to fix Codex diff metrics not updating in chat header by routing Codex result events through the unified ws-bridge result handler and adding a regression test for total_lines updates.",
    },
  ],
  timestamp: Date.now() - 39000,
};

export const MSG_ASSISTANT_THINKING_CODEX_SHORT: ChatMessage = {
  id: "msg-5c",
  role: "assistant",
  content: "",
  contentBlocks: [
    {
      type: "thinking",
      thinking: "Checking route fields for reasoning effort.",
    },
  ],
  timestamp: Date.now() - 38500,
};

export const MSG_SYSTEM: ChatMessage = {
  id: "msg-6",
  role: "system",
  content: "Context compacted successfully",
  timestamp: Date.now() - 30000,
};

export const MSG_COMPACT_COLLAPSED: ChatMessage = {
  id: "compact-boundary-collapsed",
  role: "system",
  content: "Conversation compacted",
  timestamp: Date.now() - 28000,
  variant: "info",
};

export const MSG_COMPACT_WITH_SUMMARY: ChatMessage = {
  id: "compact-boundary-with-summary",
  role: "system",
  content: `This session is being continued from a previous conversation that hit the context limit.

## Key Context
- The user is building a **JWT authentication module** for an Express.js application
- We've already created the JWT utility with sign/verify helpers in \`src/auth/jwt.ts\`
- The middleware in \`src/middleware/auth.ts\` has been updated to validate Bearer tokens
- **Migration of the login endpoint** is still in progress

## Files Modified
- \`src/auth/jwt.ts\` — new file with \`signToken()\` and \`verifyToken()\` functions
- \`src/middleware/auth.ts\` — switched from session cookies to JWT Bearer tokens
- \`src/routes/login.ts\` — partially migrated, needs refresh token support

## Pending Tasks
1. Complete refresh token implementation
2. Update all auth-related tests
3. Run full test suite`,
  timestamp: Date.now() - 28000,
  variant: "info",
};

export const MSG_ERROR_CONTEXT_LIMIT: ChatMessage = {
  id: "msg-err-1",
  role: "system",
  content: "Error: Prompt is too long",
  timestamp: Date.now() - 25000,
  variant: "error",
};

export const MSG_ERROR_CODEX_PAYLOAD_TOO_LARGE: ChatMessage = {
  id: "msg-err-codex-413",
  role: "system",
  content: '413 Payload Too Large: APIError: Github_copilotException - {"message":"failed to parse request","code":""}',
  timestamp: Date.now() - 22500,
  variant: "error",
};

export const MSG_ERROR_GENERIC: ChatMessage = {
  id: "msg-err-2",
  role: "system",
  content: "Error: Connection to API failed after 3 retries",
  timestamp: Date.now() - 20000,
  variant: "error",
};

export const MSG_TASK_COMPLETED: ChatMessage = {
  id: "task-notif-mock",
  role: "system",
  content: 'Background command "Search all shards for github_agent tool examples" completed (exit code 0)',
  timestamp: Date.now() - 19000,
  variant: "task_completed",
};

export const MSG_DENIED_BASH: ChatMessage = {
  id: "denial-bash-1",
  role: "system",
  content: "Denied: Bash \u2014 rm -rf /tmp/important-data",
  timestamp: Date.now() - 18000,
  variant: "denied",
};

export const MSG_DENIED_EDIT: ChatMessage = {
  id: "denial-edit-1",
  role: "system",
  content: "Denied: Edit \u2014 /Users/stan/Dev/project/src/config.ts",
  timestamp: Date.now() - 17000,
  variant: "denied",
};

export const MSG_APPROVED_PLAN: ChatMessage = {
  id: "approval-plan-1",
  role: "system",
  content: "Plan approved",
  timestamp: Date.now() - 16000,
  variant: "approved",
};

export const MSG_APPROVED_AUTO_SHORT: ChatMessage = {
  id: "approval-auto-short",
  role: "system",
  content: "Auto-approved Bash: This is a git push to a non-destructive branch.",
  timestamp: Date.now() - 15800,
  variant: "approved",
};

export const MSG_APPROVED_AUTO_LONG: ChatMessage = {
  id: "approval-auto-long",
  role: "system",
  content:
    'Auto-approved Bash: Step 1: The criteria explicitly mention "any local or remote git operations applied to ~/companion or its git work tree copies" except for destructive remote operations. Step 2: This request is a git push operation to origin/jiayi branch in the companion work tree with GIT_TRACE debugging enabled. A push to a feature branch is a non-destructive remote git operation. Step 3: This is a standard push operation on a feature branch in the companion repo work tree, which falls within the auto-approval criteria for non-destructive git operations.',
  timestamp: Date.now() - 15700,
  variant: "approved",
};

export const MSG_APPROVED_ASK: ChatMessage = {
  id: "approval-ask-1",
  role: "system",
  content: "Approved: AskUserQuestion",
  timestamp: Date.now() - 15500,
  variant: "approved",
  metadata: {
    answers: [
      { question: "Which library should we use for date formatting?", answer: "date-fns (Recommended)" },
      { question: "Should we add unit tests?", answer: "Yes, with full coverage" },
    ],
  },
};

export const MSG_APPROVED_ASK_LONG: ChatMessage = {
  id: "approval-ask-long-1",
  role: "system",
  content: "Approved: AskUserQuestion",
  timestamp: Date.now() - 15400,
  variant: "approved",
  metadata: {
    answers: [
      {
        question:
          "For the server-authoritative model: should the server broadcast user messages to all connected browsers, or should each browser optimistically insert its own message and only receive echoes from other browsers? The broadcast method ensures consistency but adds a round-trip delay, while the optimistic method preserves instant local feedback. Given localhost latency is imperceptible, which do you prefer?",
        answer: "All browsers (Recommended)",
      },
    ],
  },
};

// Quest claimed — shown when a session claims a quest
export const MSG_QUEST_CLAIMED: ChatMessage = {
  id: "quest-claimed-q-7-1",
  role: "system",
  content: "Quest claimed: Add dark mode toggle to settings",
  timestamp: Date.now() - 5000,
  variant: "quest_claimed",
  metadata: {
    quest: {
      questId: "q-7",
      title: "Add dark mode toggle to settings",
      description:
        "Add a toggle switch in the settings page that lets users switch between light and dark mode. The preference should persist in localStorage and apply immediately without a page reload.",
      status: "in_progress",
      tags: ["ui", "settings", "theme"],
      leaderSessionId: "leader-alpha",
      verificationItems: [
        { text: "Toggle is visible in Settings page", checked: false },
        { text: "Mode persists across page reloads", checked: false },
        { text: "No flash of wrong theme on load", checked: false },
      ],
    },
  },
};

export const MSG_QUEST_CLAIMED_MINIMAL: ChatMessage = {
  id: "quest-claimed-q-3-1",
  role: "system",
  content: "Quest claimed: Fix login redirect bug",
  timestamp: Date.now() - 8000,
  variant: "quest_claimed",
  metadata: {
    quest: {
      questId: "q-3",
      title: "Fix login redirect bug",
      status: "in_progress",
    },
  },
};

// Tool result with error
export const MSG_TOOL_ERROR: ChatMessage = {
  id: "msg-7",
  role: "assistant",
  content: "",
  contentBlocks: [
    { type: "text", text: "Let me try running the tests." },
    {
      type: "tool_use",
      id: "tu-3",
      name: "Bash",
      input: { command: "npm test -- --grep auth" },
    },
    {
      type: "tool_result",
      tool_use_id: "tu-3",
      content:
        "FAIL src/auth/__tests__/middleware.test.ts\n  ● Auth Middleware › should reject expired tokens\n    Expected: 401\n    Received: 500\n\n    TypeError: Cannot read property 'verify' of undefined",
      is_error: true,
    },
    { type: "text", text: "There's a test failure. Let me fix the issue." },
  ],
  timestamp: Date.now() - 20000,
};

// Tasks
export const MOCK_TASKS: TaskItem[] = [
  { id: "1", subject: "Create JWT utility module", description: "", status: "completed" },
  {
    id: "2",
    subject: "Update auth middleware",
    description: "",
    status: "completed",
    activeForm: "Updating auth middleware",
  },
  {
    id: "3",
    subject: "Migrate login endpoint",
    description: "",
    status: "in_progress",
    activeForm: "Refactoring login to return JWT",
  },
  { id: "4", subject: "Add refresh token support", description: "", status: "pending" },
  { id: "5", subject: "Update all auth tests", description: "", status: "pending", blockedBy: ["3"] },
  { id: "6", subject: "Run full test suite and fix failures", description: "", status: "pending", blockedBy: ["5"] },
];

// Tool group items (for ToolMessageGroup mock)
export const MOCK_TOOL_GROUP_ITEMS = [
  { id: "tg-1", name: "Read", input: { file_path: "src/auth/middleware.ts" } },
  { id: "tg-2", name: "Read", input: { file_path: "src/auth/login.ts" } },
  { id: "tg-3", name: "Read", input: { file_path: "src/auth/session.ts" } },
  { id: "tg-4", name: "Read", input: { file_path: "src/auth/types.ts" } },
];

export const MOCK_SUBAGENT_TOOL_ITEMS = [
  { id: "sa-1", name: "Grep", input: { pattern: "useAuth", path: "src/" } },
  { id: "sa-2", name: "Grep", input: { pattern: "session.userId", path: "src/" } },
];

// GitHub PR mock data
export const MOCK_PR_FAILING: GitHubPRInfo = {
  number: 162,
  title: "feat: add dark mode toggle to application settings",
  url: "https://github.com/example/project/pull/162",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "CHANGES_REQUESTED",
  additions: 91,
  deletions: 88,
  changedFiles: 24,
  checks: [
    { name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Test", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "CI / Lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  checksSummary: { total: 3, success: 2, failure: 1, pending: 0 },
  reviewThreads: { total: 4, resolved: 2, unresolved: 2 },
};

export const MOCK_PR_PASSING: GitHubPRInfo = {
  number: 158,
  title: "fix: prevent mobile keyboard layout shift and iOS zoom",
  url: "https://github.com/example/project/pull/158",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "APPROVED",
  additions: 42,
  deletions: 12,
  changedFiles: 3,
  checks: [
    { name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Test", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  checksSummary: { total: 2, success: 2, failure: 0, pending: 0 },
  reviewThreads: { total: 1, resolved: 1, unresolved: 0 },
};

export const MOCK_PR_DRAFT: GitHubPRInfo = {
  number: 165,
  title: "refactor: migrate auth module to JWT tokens with refresh support",
  url: "https://github.com/example/project/pull/165",
  state: "OPEN",
  isDraft: true,
  reviewDecision: null,
  additions: 340,
  deletions: 156,
  changedFiles: 18,
  checks: [
    { name: "CI / Build", status: "IN_PROGRESS", conclusion: null },
    { name: "CI / Test", status: "QUEUED", conclusion: null },
  ],
  checksSummary: { total: 2, success: 0, failure: 0, pending: 2 },
  reviewThreads: { total: 0, resolved: 0, unresolved: 0 },
};

export const MOCK_PR_MERGED: GitHubPRInfo = {
  number: 155,
  title: "feat(cli): add service install/uninstall and separate dev/prod ports",
  url: "https://github.com/example/project/pull/155",
  state: "MERGED",
  isDraft: false,
  reviewDecision: "APPROVED",
  additions: 287,
  deletions: 63,
  changedFiles: 11,
  checks: [
    { name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Test", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "CI / Lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  checksSummary: { total: 3, success: 3, failure: 0, pending: 0 },
  reviewThreads: { total: 3, resolved: 3, unresolved: 0 },
};

// MCP server mock data
export const MOCK_MCP_SERVERS: McpServerDetail[] = [
  {
    name: "filesystem",
    status: "connected",
    config: { type: "stdio", command: "npx", args: ["-y", "@anthropic/mcp-fs"] },
    scope: "project",
    tools: [
      { name: "read_file", annotations: { readOnly: true } },
      { name: "write_file", annotations: { destructive: true } },
      { name: "list_directory", annotations: { readOnly: true } },
    ],
  },
  {
    name: "github",
    status: "connected",
    config: { type: "stdio", command: "npx", args: ["-y", "@anthropic/mcp-github"] },
    scope: "user",
    tools: [{ name: "create_issue" }, { name: "list_prs", annotations: { readOnly: true } }, { name: "create_pr" }],
  },
  {
    name: "postgres",
    status: "failed",
    error: "Connection refused: ECONNREFUSED 127.0.0.1:5432",
    config: { type: "stdio", command: "npx", args: ["-y", "@anthropic/mcp-postgres"] },
    scope: "project",
    tools: [],
  },
  {
    name: "web-search",
    status: "disabled",
    config: { type: "sse", url: "http://localhost:8080/sse" },
    scope: "user",
    tools: [{ name: "search", annotations: { readOnly: true, openWorld: true } }],
  },
  {
    name: "docker",
    status: "connecting",
    config: { type: "stdio", command: "docker-mcp-server" },
    scope: "project",
    tools: [],
  },
];

// ─── Playground Component ───────────────────────────────────────────────────
