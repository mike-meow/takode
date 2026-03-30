import { useState, useEffect } from "react";
import {
  PermissionBanner,
  PlanReviewOverlay,
  PlanCollapsedChip,
  PermissionsCollapsedChip,
  EvaluatingCollapsedChip,
} from "./PermissionBanner.js";
import { CodexThinkingInline, MessageBubble, UserReplyChip, NotificationMarker } from "./MessageBubble.js";
import { Lightbox } from "./Lightbox.js";
import { ToolBlock, getToolIcon, getToolLabel, getPreview, ToolIcon, formatDuration } from "./ToolBlock.js";
import { BoardBlock } from "./BoardBlock.js";
import { DiffViewer } from "./DiffViewer.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { useStore, COLOR_THEMES, isDarkTheme, type ColorTheme } from "../store.js";
import { navigateToSession, navigateToMostRecentSession } from "../utils/routing.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import { ChatView } from "./ChatView.js";
import { MessageFeed } from "./MessageFeed.js";
import { api } from "../api.js";
import type { PermissionRequest, ChatMessage, ContentBlock, SessionState, McpServerDetail } from "../types.js";
import type { TaskItem } from "../types.js";
import type { GitHubPRInfo } from "../api.js";
import { GitHubPRDisplay, CodexRateLimitsSection, CodexTokenDetailsSection } from "./TaskPanel.js";
import { SessionCreationProgress } from "./SessionCreationProgress.js";
import { StepList } from "./SessionCreationView.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { SessionItem } from "./SessionItem.js";
import type { CreationProgressEvent } from "../types.js";
import { CatPawAvatar, CatPawLeft, CatPawRight, YarnBallDot, YarnBallSpinner, SleepingCat } from "./CatIcons.js";
import { HighlightedText } from "./HighlightedText.js";
import { ReplyChip } from "./Composer.js";
import { PawTrailAvatar, HidePawContext } from "./PawTrail.js";
import type { SessionItem as SidebarSessionItem } from "../utils/project-grouping.js";
import { buildHerdGroupBadgeThemes, getHerdGroupLeaderId } from "../utils/herd-group-theme.js";

// ─── Mock Data ──────────────────────────────────────────────────────────────

const MOCK_SESSION_ID = "playground-session";
const PLAYGROUND_SECTIONED_SESSION_ID = "playground-sectioned-feed";
const PLAYGROUND_LOADING_SESSION_ID = "playground-loading-feed";
const PLAYGROUND_CODEX_TERMINAL_SESSION_ID = "playground-codex-terminal-feed";
const PLAYGROUND_CODEX_PENDING_SESSION_ID = "playground-codex-pending-feed";
const PLAYGROUND_STARTING_SESSION_ID = "playground-chat-starting";
const PLAYGROUND_RESUMING_SESSION_ID = "playground-chat-resuming";
const PLAYGROUND_BROKEN_SESSION_ID = "playground-chat-broken";
const PLAYGROUND_SESSION_ROWS: Array<{ session: SidebarSessionItem; sessionName: string; preview: string }> = [
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
      status: "idle",
      sdkState: "connected",
      createdAt: 2.5,
      archived: false,
      backendType: "codex",
      repoRoot: "/Users/stan/Dev/takode",
      permCount: 0,
      herdedBy: "leader-alpha",
      reviewerOf: 8,
      sessionNum: 9,
    },
    sessionName: "Reviewer of #8",
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
];
const PLAYGROUND_HERD_GROUP_THEMES = (() => {
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

function mockPermission(
  overrides: Partial<PermissionRequest> & { tool_name: string; input: Record<string, unknown> },
): PermissionRequest {
  return {
    request_id: `perm-${Math.random().toString(36).slice(2, 8)}`,
    tool_use_id: `tu-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makePlaygroundSectionedMessages(sectionCount: number, turnsPerSection = 50): ChatMessage[] {
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

function makePlaygroundMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `playground-msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

const PERM_BASH = mockPermission({
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

const PERM_EDIT = mockPermission({
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

const PERM_EDIT_PATCH = mockPermission({
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

const PERM_WRITE = mockPermission({
  tool_name: "Write",
  input: {
    file_path: "/Users/stan/Dev/project/src/config.ts",
    content:
      'export const config = {\n  apiUrl: "https://api.example.com",\n  timeout: 5000,\n  retries: 3,\n  debug: process.env.NODE_ENV !== "production",\n};\n',
  },
});

const PERM_READ = mockPermission({
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

const PERM_GLOB = mockPermission({
  tool_name: "Glob",
  input: { pattern: "**/*.test.ts", path: "/Users/stan/Dev/project/src" },
});

const PERM_GREP = mockPermission({
  tool_name: "Grep",
  input: { pattern: "TODO|FIXME|HACK", path: "/Users/stan/Dev/project/src", glob: "*.ts" },
});

const PERM_EXIT_PLAN = mockPermission({
  tool_name: "ExitPlanMode",
  input: {
    plan: `## Summary\nRefactor the authentication module to use JWT tokens instead of session cookies.\n\n## Changes\n1. **Add JWT utility** — new \`src/auth/jwt.ts\` with sign/verify helpers\n2. **Update middleware** — modify \`src/middleware/auth.ts\` to validate Bearer tokens\n3. **Migrate login endpoint** — return JWT in response body instead of Set-Cookie\n4. **Update tests** — adapt all auth tests to use token-based flow\n\n## Test plan\n- Run \`npm test -- --grep auth\`\n- Manual test with curl`,
    allowedPrompts: [
      { tool: "Bash", prompt: "run tests" },
      { tool: "Bash", prompt: "install dependencies" },
    ],
  },
});

const PERM_GENERIC = mockPermission({
  tool_name: "WebSearch",
  input: { query: "TypeScript 5.5 new features", allowed_domains: ["typescriptlang.org", "github.com"] },
  description: "Search the web for TypeScript 5.5 features",
});

const PERM_DYNAMIC = mockPermission({
  tool_name: "dynamic:code_interpreter",
  input: { code: "print('hello from dynamic tool')" },
  description: "Custom tool call: code_interpreter",
});

// Bash permission with NO suggestions — shows "Customize" button is always available
const PERM_BASH_NO_SUGGESTIONS = mockPermission({
  tool_name: "Bash",
  input: {
    command: "rm -rf node_modules && npm install",
    description: "Clean reinstall dependencies",
  },
});

// Auto-approval evaluating state — collapsed with spinner while LLM evaluates
const PERM_EVALUATING_BASH = mockPermission({
  tool_name: "Bash",
  input: { command: "git push origin main", description: "Push changes" },
  evaluating: "evaluating",
});

const PERM_EVALUATING_BASH_LONG = mockPermission({
  tool_name: "Bash",
  input: {
    command:
      "cd /home/user/projects/my-app && npm run build --production && docker build -t my-app:latest . && docker push registry.example.com/my-app:latest",
    description: "Build and push Docker image",
  },
  evaluating: "evaluating",
});

const PERM_EVALUATING_EDIT = mockPermission({
  tool_name: "Edit",
  input: { file_path: "/src/components/App.tsx", old_string: "const x = 1;", new_string: "const x = 2;" },
  evaluating: "evaluating",
});

// Auto-approval queued state — waiting in semaphore queue
const PERM_QUEUED_BASH = mockPermission({
  tool_name: "Bash",
  input: { command: "npm test -- --coverage", description: "Run tests with coverage" },
  evaluating: "queued",
});

const PERM_ASK_SINGLE = mockPermission({
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

const PERM_ASK_MULTI = mockPermission({
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
const MSG_USER: ChatMessage = {
  id: "msg-1",
  role: "user",
  content: "Can you help me refactor the authentication module to use JWT tokens?",
  timestamp: Date.now() - 60000,
};

const MSG_USER_SELECTION: ChatMessage = {
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

const MSG_USER_IMAGE: ChatMessage = {
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
const MSG_USER_AGENT: ChatMessage = {
  id: "msg-agent-1",
  role: "user",
  content: "Run the full test suite and report any failures.",
  timestamp: Date.now() - 53000,
  agentSource: {
    sessionId: "abc123def456",
    sessionLabel: "#3 leader",
  },
};

const MSG_ASSISTANT: ChatMessage = {
  id: "msg-3",
  role: "assistant",
  content: "",
  contentBlocks: [
    {
      type: "text",
      text: "I'll help you refactor the authentication module. Let me first look at the current implementation.\n\nHere's what I found:\n- The current auth uses **session cookies** via `express-session`\n- Sessions are stored in a `MemoryStore` (not production-ready)\n- The middleware checks `req.session.userId`\n\n```typescript\n// Current implementation\napp.use(session({\n  secret: process.env.SESSION_SECRET,\n  resave: false,\n  saveUninitialized: false,\n}));\n```\n\n| Feature | Cookies | JWT |\n|---------|---------|-----|\n| Stateless | No | Yes |\n| Scalable | Limited | Excellent |\n| Revocation | Easy | Needs blocklist |\n",
    },
  ],
  timestamp: Date.now() - 50000,
};

const MSG_ASSISTANT_LEADER_USER: ChatMessage = {
  id: "msg-leader-user",
  role: "assistant",
  content: "Worker #7 finished q-126 and opened a PR. Please review the leader chat behavior. @to(user)",
  leaderUserAddressed: true,
  timestamp: Date.now() - 48000,
};

const MSG_ASSISTANT_TOOLS: ChatMessage = {
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

const MSG_ASSISTANT_THINKING: ChatMessage = {
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

const MSG_ASSISTANT_THINKING_CODEX: ChatMessage = {
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

const MSG_ASSISTANT_THINKING_CODEX_SHORT: ChatMessage = {
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

const MSG_SYSTEM: ChatMessage = {
  id: "msg-6",
  role: "system",
  content: "Context compacted successfully",
  timestamp: Date.now() - 30000,
};

const MSG_COMPACT_COLLAPSED: ChatMessage = {
  id: "compact-boundary-collapsed",
  role: "system",
  content: "Conversation compacted",
  timestamp: Date.now() - 28000,
  variant: "info",
};

const MSG_COMPACT_WITH_SUMMARY: ChatMessage = {
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

const MSG_ERROR_CONTEXT_LIMIT: ChatMessage = {
  id: "msg-err-1",
  role: "system",
  content: "Error: Prompt is too long",
  timestamp: Date.now() - 25000,
  variant: "error",
};

const MSG_ERROR_GENERIC: ChatMessage = {
  id: "msg-err-2",
  role: "system",
  content: "Error: Connection to API failed after 3 retries",
  timestamp: Date.now() - 20000,
  variant: "error",
};

const MSG_TASK_COMPLETED: ChatMessage = {
  id: "task-notif-mock",
  role: "system",
  content: 'Background command "Search all shards for github_agent tool examples" completed (exit code 0)',
  timestamp: Date.now() - 19000,
  variant: "task_completed",
};

const MSG_DENIED_BASH: ChatMessage = {
  id: "denial-bash-1",
  role: "system",
  content: "Denied: Bash \u2014 rm -rf /tmp/important-data",
  timestamp: Date.now() - 18000,
  variant: "denied",
};

const MSG_DENIED_EDIT: ChatMessage = {
  id: "denial-edit-1",
  role: "system",
  content: "Denied: Edit \u2014 /Users/stan/Dev/project/src/config.ts",
  timestamp: Date.now() - 17000,
  variant: "denied",
};

const MSG_APPROVED_PLAN: ChatMessage = {
  id: "approval-plan-1",
  role: "system",
  content: "Plan approved",
  timestamp: Date.now() - 16000,
  variant: "approved",
};

const MSG_APPROVED_AUTO_SHORT: ChatMessage = {
  id: "approval-auto-short",
  role: "system",
  content: "Auto-approved Bash: This is a git push to a non-destructive branch.",
  timestamp: Date.now() - 15800,
  variant: "approved",
};

const MSG_APPROVED_AUTO_LONG: ChatMessage = {
  id: "approval-auto-long",
  role: "system",
  content:
    'Auto-approved Bash: Step 1: The criteria explicitly mention "any local or remote git operations applied to ~/companion or its git work tree copies" except for destructive remote operations. Step 2: This request is a git push operation to origin/jiayi branch in the companion work tree with GIT_TRACE debugging enabled. A push to a feature branch is a non-destructive remote git operation. Step 3: This is a standard push operation on a feature branch in the companion repo work tree, which falls within the auto-approval criteria for non-destructive git operations.',
  timestamp: Date.now() - 15700,
  variant: "approved",
};

const MSG_APPROVED_ASK: ChatMessage = {
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

const MSG_APPROVED_ASK_LONG: ChatMessage = {
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
const MSG_QUEST_CLAIMED: ChatMessage = {
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
      verificationItems: [
        { text: "Toggle is visible in Settings page", checked: false },
        { text: "Mode persists across page reloads", checked: false },
        { text: "No flash of wrong theme on load", checked: false },
      ],
    },
  },
};

const MSG_QUEST_CLAIMED_MINIMAL: ChatMessage = {
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
const MSG_TOOL_ERROR: ChatMessage = {
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
const MOCK_TASKS: TaskItem[] = [
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
const MOCK_TOOL_GROUP_ITEMS = [
  { id: "tg-1", name: "Read", input: { file_path: "src/auth/middleware.ts" } },
  { id: "tg-2", name: "Read", input: { file_path: "src/auth/login.ts" } },
  { id: "tg-3", name: "Read", input: { file_path: "src/auth/session.ts" } },
  { id: "tg-4", name: "Read", input: { file_path: "src/auth/types.ts" } },
];

const MOCK_SUBAGENT_TOOL_ITEMS = [
  { id: "sa-1", name: "Grep", input: { pattern: "useAuth", path: "src/" } },
  { id: "sa-2", name: "Grep", input: { pattern: "session.userId", path: "src/" } },
];

// GitHub PR mock data
const MOCK_PR_FAILING: GitHubPRInfo = {
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

const MOCK_PR_PASSING: GitHubPRInfo = {
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

const MOCK_PR_DRAFT: GitHubPRInfo = {
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

const MOCK_PR_MERGED: GitHubPRInfo = {
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
const MOCK_MCP_SERVERS: McpServerDetail[] = [
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

export function Playground() {
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() => useStore.getState().colorTheme);
  const darkMode = isDarkTheme(colorTheme);

  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", darkMode);
    el.className = el.className.replace(/\btheme-\S+/g, "").trim();
    if (colorTheme !== "light" && colorTheme !== "dark") {
      el.classList.add(`theme-${colorTheme}`);
    }
    // Keep the store in sync so other components see the playground override
    useStore.getState().setColorTheme(colorTheme);
  }, [colorTheme, darkMode]);

  useEffect(() => {
    const store = useStore.getState();
    const snapshot = useStore.getState();
    const sessionId = MOCK_SESSION_ID;
    const demoSessionIds = [
      sessionId,
      PLAYGROUND_SECTIONED_SESSION_ID,
      PLAYGROUND_LOADING_SESSION_ID,
      PLAYGROUND_CODEX_TERMINAL_SESSION_ID,
      PLAYGROUND_CODEX_PENDING_SESSION_ID,
      PLAYGROUND_STARTING_SESSION_ID,
      PLAYGROUND_RESUMING_SESSION_ID,
      PLAYGROUND_BROKEN_SESSION_ID,
    ];
    const prevSessions = new Map(demoSessionIds.map((id) => [id, snapshot.sessions.get(id)]));
    const prevMessages = new Map(demoSessionIds.map((id) => [id, snapshot.messages.get(id)]));
    const prevPerms = new Map(demoSessionIds.map((id) => [id, snapshot.pendingPermissions.get(id)]));
    const prevConn = new Map(demoSessionIds.map((id) => [id, snapshot.connectionStatus.get(id)]));
    const prevCli = new Map(demoSessionIds.map((id) => [id, snapshot.cliConnected.get(id)]));
    const prevCliEver = new Map(demoSessionIds.map((id) => [id, snapshot.cliEverConnected.get(id)]));
    const prevCliDisconnectReason = new Map(demoSessionIds.map((id) => [id, snapshot.cliDisconnectReason.get(id)]));
    const prevStatus = new Map(demoSessionIds.map((id) => [id, snapshot.sessionStatus.get(id)]));
    const prevStreaming = new Map(demoSessionIds.map((id) => [id, snapshot.streaming.get(id)]));
    const prevStreamingStartedAt = new Map(demoSessionIds.map((id) => [id, snapshot.streamingStartedAt.get(id)]));
    const prevStreamingOutputTokens = new Map(demoSessionIds.map((id) => [id, snapshot.streamingOutputTokens.get(id)]));
    const prevFeedScrollPositions = new Map(demoSessionIds.map((id) => [id, snapshot.feedScrollPosition.get(id)]));
    const prevHistoryLoading = new Map(demoSessionIds.map((id) => [id, snapshot.historyLoading.get(id)]));
    const prevPendingCodexInputs = new Map(demoSessionIds.map((id) => [id, snapshot.pendingCodexInputs.get(id)]));

    const session: SessionState = {
      session_id: sessionId,
      backend_type: "claude",
      model: "claude-sonnet-4-5",
      cwd: "/Users/stan/Dev/project",
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebSearch"],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: ["explain", "review", "fix"],
      skills: ["doc-coauthoring", "frontend-design"],
      total_cost_usd: 0.1847,
      num_turns: 14,
      context_used_percent: 62,
      is_compacting: false,
      git_branch: "feat/jwt-auth",
      is_worktree: false,
      is_containerized: true,
      repo_root: "/Users/stan/Dev/project",
      git_ahead: 3,
      git_behind: 0,
      total_lines_added: 142,
      total_lines_removed: 38,
    };

    store.addSession(session);
    store.setConnectionStatus(sessionId, "connected");
    store.setCliConnected(sessionId, true);
    store.setSessionStatus(sessionId, "running");
    store.setMessages(sessionId, [MSG_USER, MSG_ASSISTANT, MSG_ASSISTANT_TOOLS, MSG_TOOL_ERROR]);
    store.setStreaming(sessionId, "I'm updating tests and then I'll run the full suite.");
    store.setStreamingStats(sessionId, { startedAt: Date.now() - 12000, outputTokens: 1200 });
    store.addPermission(sessionId, PERM_BASH);
    store.addPermission(sessionId, PERM_DYNAMIC);

    const sectionedSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_SECTIONED_SESSION_ID,
      cwd: "/Users/stan/Dev/project/long-session",
      num_turns: 200,
      is_containerized: false,
    };
    store.addSession(sectionedSession);
    store.setConnectionStatus(PLAYGROUND_SECTIONED_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_SECTIONED_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_SECTIONED_SESSION_ID, "idle");
    store.setMessages(PLAYGROUND_SECTIONED_SESSION_ID, makePlaygroundSectionedMessages(4));
    store.setFeedScrollPosition(PLAYGROUND_SECTIONED_SESSION_ID, {
      scrollTop: 240,
      scrollHeight: 1600,
      isAtBottom: false,
      anchorTurnId: "playground-section-u1",
      anchorOffsetTop: 0,
    });

    const loadingSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_LOADING_SESSION_ID,
      cwd: "/Users/stan/Dev/project/cold-session",
      num_turns: 86,
      is_containerized: false,
    };
    store.addSession(loadingSession);
    store.setConnectionStatus(PLAYGROUND_LOADING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_LOADING_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_LOADING_SESSION_ID, "idle");
    store.setHistoryLoading(PLAYGROUND_LOADING_SESSION_ID, true);

    const codexTerminalSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_CODEX_TERMINAL_SESSION_ID,
      backend_type: "codex",
      model: "gpt-5.3-codex",
      cwd: "/Users/stan/Dev/project/codex-live-terminal",
      is_containerized: false,
    };
    store.addSession(codexTerminalSession);
    store.setConnectionStatus(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "running");
    store.setMessages(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, [
      {
        id: "playground-codex-terminal-user",
        role: "user",
        content: "Run the flaky test shard and tell me why it stalls.",
        timestamp: Date.now() - 60_000,
      },
      {
        id: "playground-codex-terminal-bash",
        role: "assistant",
        content: "",
        timestamp: Date.now() - 55_000,
        model: "gpt-5.3-codex",
        contentBlocks: [
          {
            type: "tool_use",
            id: "playground-codex-live-bash",
            name: "Bash",
            input: {
              command: "bun test src/session/ws-bridge.test.ts --runInBand --reporter=verbose",
            },
          },
        ],
      },
      {
        id: "playground-codex-terminal-bash-complete",
        role: "assistant",
        content: "",
        timestamp: Date.now() - 25_000,
        model: "gpt-5.3-codex",
        contentBlocks: [
          {
            type: "tool_use",
            id: "playground-codex-complete-bash",
            name: "Bash",
            input: {
              command: "find src -name '*.test.ts' -maxdepth 3",
            },
          },
        ],
      },
    ]);
    store.setToolStartTimestamps(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, {
      "playground-codex-live-bash": Date.now() - 49_000,
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-live-bash", {
      toolName: "Bash",
      elapsedSeconds: 49,
      outputDelta: "RUN  src/session/ws-bridge.test.ts\n",
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-live-bash", {
      toolName: "Bash",
      elapsedSeconds: 50,
      outputDelta: "  ✓ keeps tool_result_preview tails idempotent\n",
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-live-bash", {
      toolName: "Bash",
      elapsedSeconds: 51,
      outputDelta: "  ... waiting on ws reconnect watchdog case ...\n",
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-complete-bash", {
      toolName: "Bash",
      elapsedSeconds: 14,
      outputDelta: "src/components/MessageFeed.test.tsx\nsrc/components/ToolBlock.test.tsx\n",
    });
    store.setToolResult(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-complete-bash", {
      tool_use_id: "playground-codex-complete-bash",
      content: "Terminal command completed, but no output was captured.",
      is_error: false,
      total_size: 53,
      is_truncated: false,
      duration_seconds: 14.1,
    });

    store.addSession({
      ...session,
      session_id: PLAYGROUND_CODEX_PENDING_SESSION_ID,
      backend_type: "codex",
      backend_state: "connected",
      backend_error: null,
      model: "gpt-5.4",
      num_turns: 3,
      context_used_percent: 38,
    });
    store.setConnectionStatus(PLAYGROUND_CODEX_PENDING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_CODEX_PENDING_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_CODEX_PENDING_SESSION_ID, "running");
    store.setMessages(PLAYGROUND_CODEX_PENDING_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-codex-pending-user",
        role: "user",
        content: "Inspect the auth flow and summarize what is broken.",
      }),
      makePlaygroundMessage({
        id: "playground-codex-pending-assistant",
        role: "assistant",
        content: "Searching the auth pipeline now.",
      }),
    ]);
    store.setPendingCodexInputs(PLAYGROUND_CODEX_PENDING_SESSION_ID, [
      {
        id: "playground-pending-codex-1",
        content: "Also check whether refresh-token rotation races with logout.",
        timestamp: Date.now(),
        cancelable: true,
        draftImages: [],
      },
      {
        id: "playground-pending-codex-2",
        content: "If you find a race, propose the smallest safe fix first.",
        timestamp: Date.now() + 1,
        cancelable: false,
        draftImages: [],
      },
    ]);

    // Mock tool results for ToolResultSection demo
    store.setToolResult(sessionId, "tu-1", {
      tool_use_id: "tu-1",
      content: "src/auth/middleware.ts\nsrc/auth/login.ts\nsrc/auth/session.ts",
      is_error: false,
      total_size: 58,
      is_truncated: false,
      duration_seconds: 0.3,
    });
    store.setToolResult(sessionId, "tu-2", {
      tool_use_id: "tu-2",
      content:
        'export function authMiddleware(req, res, next) {\n  if (!req.session.userId) {\n    return res.status(401).json({ error: "Unauthorized" });\n  }\n  next();\n}',
      is_error: false,
      total_size: 156,
      is_truncated: false,
      duration_seconds: 0.1,
    });
    store.setToolResult(sessionId, "tu-3", {
      tool_use_id: "tu-3",
      content: "FAIL src/auth/__tests__/middleware.test.ts\n  \u25CF Auth Middleware \u203A should reject expired toke",
      is_error: true,
      total_size: 185,
      is_truncated: false,
      duration_seconds: 12.4,
    });

    // Mock tool results with durations for standalone ToolBlock demos
    const toolDurations: Record<string, number> = {
      "tb-1": 3.2,
      "tb-2": 0.1,
      "tb-3": 0.4,
      "tb-4": 0.2,
      "tb-5": 0.8,
      "tb-6": 1.5,
      "tb-7": 2.1,
      "tb-8": 4.7,
      "tb-10": 0.0,
      "tb-11": 0.3,
      "tb-12": 0.1,
      "tb-14": 0.0,
      "tb-15": 0.0,
    };
    for (const [id, dur] of Object.entries(toolDurations)) {
      store.setToolResult(sessionId, id, {
        tool_use_id: id,
        content: "",
        is_error: false,
        total_size: 0,
        is_truncated: false,
        duration_seconds: dur,
      });
    }

    // Mock a running Codex Bash command with streamed output deltas.
    store.setToolStartTimestamps(sessionId, { "tb-live": Date.now() - 47_000 });
    store.setToolProgress(sessionId, "tb-live", {
      toolName: "Bash",
      elapsedSeconds: 47,
      outputDelta: "Collecting source shards...\n",
    });
    store.setToolProgress(sessionId, "tb-live", {
      toolName: "Bash",
      elapsedSeconds: 48,
      outputDelta: "Merged 128/512 files\n",
    });
    store.setToolProgress(sessionId, "tb-live", {
      toolName: "Bash",
      elapsedSeconds: 49,
      outputDelta: "Merged 256/512 files\n",
    });

    // Additional ChatView states used by the chat-flow Playground coverage.
    store.addSession({
      ...session,
      session_id: PLAYGROUND_STARTING_SESSION_ID,
      backend_type: "claude-sdk",
      backend_state: "initializing",
      backend_error: null,
    });
    store.setConnectionStatus(PLAYGROUND_STARTING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_STARTING_SESSION_ID, false);
    store.setSessionStatus(PLAYGROUND_STARTING_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_RESUMING_SESSION_ID,
      backend_type: "codex",
      backend_state: "resuming",
      backend_error: null,
      model: "gpt-5.3-codex",
    });
    store.setConnectionStatus(PLAYGROUND_RESUMING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_RESUMING_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_RESUMING_SESSION_ID);
    store.setSessionStatus(PLAYGROUND_RESUMING_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_BROKEN_SESSION_ID,
      backend_type: "codex",
      backend_state: "broken",
      backend_error: "Codex initialization failed: Transport closed",
      model: "gpt-5.3-codex",
    });
    store.setConnectionStatus(PLAYGROUND_BROKEN_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_BROKEN_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_BROKEN_SESSION_ID);
    store.setCliDisconnectReason(PLAYGROUND_BROKEN_SESSION_ID, "broken");
    store.setSessionStatus(PLAYGROUND_BROKEN_SESSION_ID, null);

    return () => {
      useStore.setState((s) => {
        const sessions = new Map(s.sessions);
        const messages = new Map(s.messages);
        const pendingPermissions = new Map(s.pendingPermissions);
        const connectionStatus = new Map(s.connectionStatus);
        const cliConnected = new Map(s.cliConnected);
        const cliEverConnected = new Map(s.cliEverConnected);
        const sessionStatus = new Map(s.sessionStatus);
        const streaming = new Map(s.streaming);
        const streamingStartedAt = new Map(s.streamingStartedAt);
        const streamingOutputTokens = new Map(s.streamingOutputTokens);
        const cliDisconnectReason = new Map(s.cliDisconnectReason);
        const feedScrollPosition = new Map(s.feedScrollPosition);
        const historyLoading = new Map(s.historyLoading);
        const pendingCodexInputs = new Map(s.pendingCodexInputs);

        for (const demoId of demoSessionIds) {
          const prevSession = prevSessions.get(demoId);
          const prevMessageList = prevMessages.get(demoId);
          const prevPermissionMap = prevPerms.get(demoId);
          const prevConnection = prevConn.get(demoId);
          const prevCliConnected = prevCli.get(demoId);
          const prevCliSeen = prevCliEver.get(demoId);
          const prevDisconnectReason = prevCliDisconnectReason.get(demoId);
          const prevSessionState = prevStatus.get(demoId);
          const prevStream = prevStreaming.get(demoId);
          const prevStreamStarted = prevStreamingStartedAt.get(demoId);
          const prevStreamTokens = prevStreamingOutputTokens.get(demoId);
          const prevFeedScrollPosition = prevFeedScrollPositions.get(demoId);
          const prevLoading = prevHistoryLoading.get(demoId);
          const prevPendingCodex = prevPendingCodexInputs.get(demoId);

          if (prevSession) sessions.set(demoId, prevSession);
          else sessions.delete(demoId);
          if (prevMessageList) messages.set(demoId, prevMessageList);
          else messages.delete(demoId);
          if (prevPermissionMap) pendingPermissions.set(demoId, prevPermissionMap);
          else pendingPermissions.delete(demoId);
          if (prevConnection) connectionStatus.set(demoId, prevConnection);
          else connectionStatus.delete(demoId);
          if (typeof prevCliConnected === "boolean") cliConnected.set(demoId, prevCliConnected);
          else cliConnected.delete(demoId);
          if (typeof prevCliSeen === "boolean") cliEverConnected.set(demoId, prevCliSeen);
          else cliEverConnected.delete(demoId);
          if (prevDisconnectReason !== undefined) cliDisconnectReason.set(demoId, prevDisconnectReason);
          else cliDisconnectReason.delete(demoId);
          if (prevSessionState) sessionStatus.set(demoId, prevSessionState);
          else sessionStatus.delete(demoId);
          if (typeof prevStream === "string") streaming.set(demoId, prevStream);
          else streaming.delete(demoId);
          if (typeof prevStreamStarted === "number") streamingStartedAt.set(demoId, prevStreamStarted);
          else streamingStartedAt.delete(demoId);
          if (typeof prevStreamTokens === "number") streamingOutputTokens.set(demoId, prevStreamTokens);
          else streamingOutputTokens.delete(demoId);
          if (prevFeedScrollPosition) feedScrollPosition.set(demoId, prevFeedScrollPosition);
          else feedScrollPosition.delete(demoId);
          if (prevLoading) historyLoading.set(demoId, true);
          else historyLoading.delete(demoId);
          if (prevPendingCodex) pendingCodexInputs.set(demoId, prevPendingCodex);
          else pendingCodexInputs.delete(demoId);
        }

        return {
          sessions,
          messages,
          pendingPermissions,
          connectionStatus,
          cliConnected,
          cliEverConnected,
          cliDisconnectReason,
          sessionStatus,
          streaming,
          streamingStartedAt,
          streamingOutputTokens,
          feedScrollPosition,
          historyLoading,
          pendingCodexInputs,
        };
      });
    };
  }, []);

  return (
    <div className="h-screen overflow-y-auto bg-cc-bg text-cc-fg font-sans-ui">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-cc-sidebar border-b border-cc-border">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-cc-fg tracking-tight">Component Playground</h1>
            <p className="text-xs text-cc-muted mt-0.5">Visual catalog of all UI components</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border transition-colors cursor-pointer"
            >
              Back to App
            </button>
            <div className="flex items-center gap-1.5">
              {COLOR_THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setColorTheme(t.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                    colorTheme === t.id
                      ? "bg-cc-primary/20 text-cc-primary border-cc-primary/30"
                      : "bg-cc-hover text-cc-muted border-cc-border hover:bg-cc-active hover:text-cc-fg"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-12">
        {/* ─── Permission Banners ──────────────────────────────── */}
        <Section
          title="Permission Banners"
          description="Tool approval requests. Click 'Customize' to open the custom permission rule editor."
        >
          <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card divide-y divide-cc-border">
            <PermissionBanner permission={PERM_BASH} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_BASH_NO_SUGGESTIONS} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_EDIT} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_EDIT_PATCH} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_WRITE} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_READ} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_GLOB} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_GREP} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_GENERIC} sessionId={MOCK_SESSION_ID} />
            <PermissionBanner permission={PERM_DYNAMIC} sessionId={MOCK_SESSION_ID} />
          </div>
        </Section>

        {/* ─── Collapsed Permissions Chip ──────────────────────── */}
        <Section
          title="Collapsed Permissions Chip"
          description="Compact chip shown when pending approvals are minimized. Click to expand."
        >
          <Card label="Multiple tools pending">
            <PermissionsCollapsedChip permissions={[PERM_BASH, PERM_EDIT, PERM_WRITE]} onExpand={() => {}} />
          </Card>
          <Card label="Single tool pending">
            <PermissionsCollapsedChip permissions={[PERM_BASH]} onExpand={() => {}} />
          </Card>
        </Section>

        {/* ─── Auto-Approval Evaluating State ─────────────────── */}
        <Section
          title="Auto-Approval Evaluating"
          description="Collapsed permission banners shown while the LLM auto-approver is evaluating. Click to expand for manual override."
        >
          <Card label="Bash — evaluating (short cmd)">
            <EvaluatingCollapsedChip
              permission={PERM_EVALUATING_BASH}
              sessionId={MOCK_SESSION_ID}
              onExpand={() => {}}
            />
          </Card>
          <Card label="Bash — evaluating (long cmd)">
            <EvaluatingCollapsedChip
              permission={PERM_EVALUATING_BASH_LONG}
              sessionId={MOCK_SESSION_ID}
              onExpand={() => {}}
            />
          </Card>
          <Card label="Edit — evaluating">
            <EvaluatingCollapsedChip
              permission={PERM_EVALUATING_EDIT}
              sessionId={MOCK_SESSION_ID}
              onExpand={() => {}}
            />
          </Card>
          <Card label="PermissionBanner with evaluating (starts collapsed, click expand)">
            <PermissionBanner permission={PERM_EVALUATING_BASH} sessionId={MOCK_SESSION_ID} />
          </Card>
          <Card label="Bash — queued (waiting for semaphore slot)">
            <EvaluatingCollapsedChip permission={PERM_QUEUED_BASH} sessionId={MOCK_SESSION_ID} onExpand={() => {}} />
          </Card>
        </Section>

        {/* ─── Real Chat Stack ──────────────────────────────── */}
        <Section
          title="Real Chat Stack"
          description="Integrated ChatView using real MessageFeed + PermissionBanner + Composer components"
        >
          <div
            data-testid="playground-real-chat-stack"
            className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[620px]"
          >
            <ChatView sessionId={MOCK_SESSION_ID} />
          </div>
        </Section>

        <Section
          title="Floating Feed Status"
          description="Running sessions show a compact lower-left status pill inside the feed so generation state does not steal layout height from the chat."
        >
          <div className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[360px]">
            <MessageFeed sessionId={MOCK_SESSION_ID} />
          </div>
        </Section>

        <Section
          title="MessageFeed Section Windowing"
          description="Fixed 50-turn sections with older-history browsing mounted in a bounded window. This mock opens on an older section so the newer-section control is visible."
        >
          <div className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[620px]">
            <MessageFeed sessionId={PLAYGROUND_SECTIONED_SESSION_ID} />
          </div>
        </Section>

        <Section
          title="Conversation Loading State"
          description="When a cold session is selected before its authoritative history arrives, the feed shows an explicit loading conversation state instead of an empty chat."
        >
          <div className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[260px]">
            <MessageFeed sessionId={PLAYGROUND_LOADING_SESSION_ID} />
          </div>
        </Section>

        <Section
          title="Codex Terminal Chips"
          description="Live Codex Bash commands sit in a reserved bottom band so they do not cover chat text. Completed live shells keep a small badge plus the captured transcript in the inline Bash card when the final tool result is empty."
        >
          <div className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[420px]">
            <MessageFeed sessionId={PLAYGROUND_CODEX_TERMINAL_SESSION_ID} />
          </div>
        </Section>

        <Section
          title="Codex Pending Inputs"
          description="Accepted but not yet delivered Codex follow-up messages render as lightweight pending chips instead of committed chat history."
        >
          <div className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[320px]">
            <MessageFeed sessionId={PLAYGROUND_CODEX_PENDING_SESSION_ID} />
          </div>
        </Section>

        <Section
          title="ChatView Recovery States"
          description="Startup, resume, and broken-session banners shown by ChatView before the main message feed is usable."
        >
          <div className="space-y-4">
            <Card label="Fresh session starting">
              <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[260px]">
                <ChatView sessionId={PLAYGROUND_STARTING_SESSION_ID} />
              </div>
            </Card>
            <Card label="Codex session resuming">
              <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[260px]">
                <ChatView sessionId={PLAYGROUND_RESUMING_SESSION_ID} />
              </div>
            </Card>
            <Card label="Broken session relaunch banner">
              <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[260px]">
                <ChatView sessionId={PLAYGROUND_BROKEN_SESSION_ID} />
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── ExitPlanMode — Full-window overlay ──────────────── */}
        <Section
          title="PlanReviewOverlay"
          description="Full-window plan display with sticky Accept/Deny buttons at the bottom. When expanded, this replaces the message feed."
        >
          <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[480px] flex flex-col">
            <PlanReviewOverlay permission={PERM_EXIT_PLAN} sessionId={MOCK_SESSION_ID} onCollapse={() => {}} />
          </div>
        </Section>

        {/* ─── ExitPlanMode — Collapsed chip ──────────────────── */}
        <Section
          title="PlanCollapsedChip"
          description="Collapsed plan bar with inline Accept/Deny buttons. Shown when the plan overlay is minimized."
        >
          <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card px-2 sm:px-4 py-2">
            <PlanCollapsedChip permission={PERM_EXIT_PLAN} sessionId={MOCK_SESSION_ID} onExpand={() => {}} />
          </div>
        </Section>

        {/* ─── AskUserQuestion ──────────────────────────────── */}
        <Section
          title="AskUserQuestion"
          description="Interactive questions with selectable options. Click the minimize (—) button to collapse into a compact chip, then click the chip to expand again."
        >
          <div className="space-y-4">
            <Card label="Single question">
              <PermissionBanner permission={PERM_ASK_SINGLE} sessionId={MOCK_SESSION_ID} />
            </Card>
            <Card label="Multi-question">
              <PermissionBanner permission={PERM_ASK_MULTI} sessionId={MOCK_SESSION_ID} />
            </Card>
          </div>
        </Section>

        {/* ─── Messages ──────────────────────────────── */}
        <Section title="Messages" description="Chat message bubbles for all roles">
          <div className="space-y-4 max-w-3xl">
            <Card label="User message">
              <MessageBubble message={MSG_USER} />
            </Card>
            <Card label="User message with VS Code selection">
              <MessageBubble message={MSG_USER_SELECTION} />
            </Card>
            <Card label="User message with image">
              <MessageBubble message={MSG_USER_IMAGE} sessionId="playground" />
            </Card>
            <Card label="User message (from agent)">
              <MessageBubble message={MSG_USER_AGENT} />
            </Card>
            <Card label="Assistant message (markdown)">
              <MessageBubble message={MSG_ASSISTANT} />
            </Card>
            <Card label="Assistant message (@to(user))">
              <MessageBubble message={MSG_ASSISTANT_LEADER_USER} />
            </Card>
            <Card label="Assistant message (with tool calls)">
              <MessageBubble message={MSG_ASSISTANT_TOOLS} />
            </Card>
            <Card label="Assistant message (thinking block)">
              <MessageBubble message={MSG_ASSISTANT_THINKING} />
            </Card>
            <Card label="Assistant message (Codex thinking preview)">
              <MessageBubble message={MSG_ASSISTANT_THINKING_CODEX} sessionId={CODEX_DEMO_SESSION} />
            </Card>
            <Card label="Assistant message (Codex thinking preview, short)">
              <MessageBubble message={MSG_ASSISTANT_THINKING_CODEX_SHORT} sessionId={CODEX_DEMO_SESSION} />
            </Card>
            <Card label="Tool result with error">
              <MessageBubble message={MSG_TOOL_ERROR} />
            </Card>
            <Card label="System message">
              <MessageBubble message={MSG_SYSTEM} />
            </Card>
            <Card label="Compact marker (collapsed, no summary)">
              <MessageBubble message={MSG_COMPACT_COLLAPSED} />
            </Card>
            <Card label="Compact marker (expandable, with summary)">
              <MessageBubble message={MSG_COMPACT_WITH_SUMMARY} />
            </Card>
            <Card label="Error — context limit (with guidance)">
              <MessageBubble message={MSG_ERROR_CONTEXT_LIMIT} />
            </Card>
            <Card label="Error — generic">
              <MessageBubble message={MSG_ERROR_GENERIC} />
            </Card>
            <Card label="Background task completed">
              <MessageBubble message={MSG_TASK_COMPLETED} />
            </Card>
            <Card label="Denied — Bash command">
              <MessageBubble message={MSG_DENIED_BASH} />
            </Card>
            <Card label="Denied — Edit file">
              <MessageBubble message={MSG_DENIED_EDIT} />
            </Card>
            <Card label="Approved — Plan">
              <MessageBubble message={MSG_APPROVED_PLAN} />
            </Card>
            <Card label="Approved — Auto-approval (short, fits 1 line)">
              <MessageBubble message={MSG_APPROVED_AUTO_SHORT} />
            </Card>
            <Card label="Approved — Auto-approval (long, collapsed by default)">
              <MessageBubble message={MSG_APPROVED_AUTO_LONG} />
            </Card>
            <Card label="Approved — AskUserQuestion with answers">
              <MessageBubble message={MSG_APPROVED_ASK} />
            </Card>
            <Card label="Approved — AskUserQuestion with long text">
              <MessageBubble message={MSG_APPROVED_ASK_LONG} />
            </Card>
            <Card label="Quest Claimed — with details, tags, and verification">
              <MessageBubble message={MSG_QUEST_CLAIMED} />
            </Card>
            <Card label="Quest Claimed — minimal (no description)">
              <MessageBubble message={MSG_QUEST_CLAIMED_MINIMAL} />
            </Card>
          </div>
        </Section>

        {/* ─── Copy Features ──────────────────────────────── */}
        <Section
          title="Copy Features"
          description="Copy-to-clipboard for code blocks in markdown and tool calls (hover to reveal), plus assistant message copy menu (Markdown/Rich Text/Plain Text)"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Code block in markdown — hover to reveal copy button">
              <MarkdownContent
                text={
                  'Here is some code:\n\n```typescript\nconst greeting = "Hello, world!";\nconsole.log(greeting);\n```\n\nAnd a block without a language tag:\n\n```\nnpm install\nnpm run build\n```\n\nQuest link example: [q-42](quest:q-42)\nSession link example: [#5](session:5)\nRelative file link example: [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162)'
                }
              />
            </Card>
            <Card label="Terminal tool — hover command block to copy (without $ prefix)">
              <ToolBlock
                name="Bash"
                input={{ command: "git status && npm run lint", description: "Check git status and lint" }}
                toolUseId="copy-tb-1"
              />
            </Card>
            <Card label="Grep tool — hover pattern to copy">
              <ToolBlock
                name="Grep"
                input={{ pattern: "useEffect\\(.*\\[\\]", path: "src/", glob: "*.tsx" }}
                toolUseId="copy-tb-2"
              />
            </Card>
            <Card label="Assistant message — hover for copy menu">
              <MessageBubble message={MSG_ASSISTANT} />
            </Card>
          </div>
        </Section>

        {/* ─── Image Lightbox ──────────────────────────────── */}
        <Section
          title="Image Lightbox"
          description="Click any image thumbnail to open a full-size lightbox overlay (Escape or click backdrop to close)"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="User message with clickable image">
              <MessageBubble message={MSG_USER_IMAGE} sessionId="playground" />
            </Card>
            <Card label="Standalone lightbox trigger">
              <PlaygroundLightboxDemo />
            </Card>
          </div>
        </Section>

        {/* ─── Tool Blocks (standalone) ──────────────────────── */}
        <Section
          title="Tool Blocks"
          description="Expandable tool call visualization with duration badges. Edit and Write diffs start collapsed and only render after expansion."
        >
          <div className="space-y-2 max-w-3xl">
            <ToolBlock
              name="Bash"
              input={{ command: "git status && npm run lint", description: "Check git status and lint" }}
              toolUseId="tb-1"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Bash"
              input={{
                command: "python scripts/mix_dataset.py --chunks 512",
                description: "Run long data mixing command (live output demo)",
              }}
              toolUseId="tb-live"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Read"
              input={{ file_path: "/Users/stan/Dev/project/src/index.ts", offset: 10, limit: 50 }}
              toolUseId="tb-2"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Edit"
              input={{
                file_path: "src/utils.ts",
                old_string: "const x = 1;",
                new_string: "const x = 2;",
                replace_all: true,
              }}
              toolUseId="tb-3"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Edit"
              input={{
                file_path: "src/utils.ts",
                changes: [
                  { path: "src/utils.ts", kind: "modify", unified_diff: "@@ -1 +1 @@\n-const x = 1;\n+const x = 2;" },
                ],
              }}
              toolUseId="tb-3b"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Edit"
              input={{
                changes: [
                  {
                    path: "src/cluster-workflow.ts",
                    kind: "modify",
                    diff: [
                      "diff --git a/src/cluster-workflow.ts b/src/cluster-workflow.ts",
                      "--- a/src/cluster-workflow.ts",
                      "+++ b/src/cluster-workflow.ts",
                      "@@ -35,3 +35,3 @@",
                      "-ssh alias-one",
                      "+ssh -o ClearAllForwardings=yes alias-one",
                    ].join("\n"),
                  },
                  {
                    path: "src/ssh-health.ts",
                    kind: "modify",
                    diff: [
                      "diff --git a/src/ssh-health.ts b/src/ssh-health.ts",
                      "--- a/src/ssh-health.ts",
                      "+++ b/src/ssh-health.ts",
                      "@@ -12,3 +12,3 @@",
                      '-output=$(ssh "$alias")',
                      '+output=$(ssh -o ClearAllForwardings=yes "$alias")',
                    ].join("\n"),
                  },
                ],
              }}
              toolUseId="tb-3c"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Write"
              input={{ file_path: "src/new-file.ts", content: 'export const hello = "world";\n' }}
              toolUseId="tb-4"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Glob"
              input={{ pattern: "**/*.tsx", path: "/Users/stan/Dev/project/src" }}
              toolUseId="tb-5"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Grep"
              input={{
                pattern: "useEffect",
                path: "src/",
                glob: "*.tsx",
                output_mode: "content",
                context: 3,
                head_limit: 20,
              }}
              toolUseId="tb-6"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="WebSearch"
              input={{ query: "React 19 new features", allowed_domains: ["react.dev", "github.com"] }}
              toolUseId="tb-7"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="web_search"
              input={{ search_query: [{ q: "Codex CLI skills documentation", domains: ["openai.com", "github.com"] }] }}
              toolUseId="tb-7b"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="WebFetch"
              input={{
                url: "https://react.dev/blog/2024/12/05/react-19",
                prompt: "Summarize the key changes in React 19",
              }}
              toolUseId="tb-8"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Task"
              input={{
                description: "Search for auth patterns",
                subagent_type: "Explore",
                prompt:
                  "Find all files related to authentication and authorization in the codebase. Look for middleware, guards, and token handling.",
              }}
              toolUseId="tb-9"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="TodoWrite"
              input={{
                todos: [
                  { content: "Create JWT utility module", status: "completed", activeForm: "Creating JWT module" },
                  { content: "Update auth middleware", status: "in_progress", activeForm: "Updating middleware" },
                  { content: "Migrate login endpoint", status: "pending", activeForm: "Migrating login" },
                  { content: "Run full test suite", status: "pending", activeForm: "Running tests" },
                ],
              }}
              toolUseId="tb-10"
              sessionId={MOCK_SESSION_ID}
            />
            {/* Takode Notify pills */}
            <ToolBlock
              name="Bash"
              input={{ command: "takode notify needs-input" }}
              toolUseId="tb-notify-1"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="Bash"
              input={{ command: "takode notify review" }}
              toolUseId="tb-notify-2"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="NotebookEdit"
              input={{
                notebook_path: "/Users/stan/Dev/project/analysis.ipynb",
                cell_type: "code",
                edit_mode: "replace",
                cell_number: 3,
                new_source: "import pandas as pd\ndf = pd.read_csv('data.csv')\ndf.describe()",
              }}
              toolUseId="tb-11"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="SendMessage"
              input={{
                type: "message",
                recipient: "researcher",
                content: "Please investigate the auth module structure and report back.",
                summary: "Requesting auth module investigation",
              }}
              toolUseId="tb-12"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock
              name="ExitPlanMode"
              input={{
                plan: "## Implementation Plan\n\n1. Add authentication middleware to Express routes\n2. Create JWT token generation and validation utilities\n3. Update database schema with user credentials table\n4. Write integration tests for the auth flow\n\n### Key Decisions\n- Use **bcrypt** for password hashing\n- JWT tokens expire after 24 hours",
                allowedPrompts: [
                  { tool: "Bash", prompt: "run tests" },
                  { tool: "Bash", prompt: "install dependencies" },
                ],
              }}
              toolUseId="tb-13"
              sessionId={MOCK_SESSION_ID}
            />
            <ToolBlock name="EnterPlanMode" input={{}} toolUseId="tb-14" sessionId={MOCK_SESSION_ID} />
            <ToolBlock
              name="AskUserQuestion"
              input={{
                questions: [
                  {
                    header: "Auth method",
                    question: "Which authentication method should we use for the API?",
                    options: [
                      { label: "JWT (Recommended)", description: "Stateless tokens, good for distributed systems" },
                      { label: "Session cookies", description: "Traditional server-side sessions" },
                    ],
                    multiSelect: false,
                  },
                ],
              }}
              toolUseId="tb-15"
              sessionId={MOCK_SESSION_ID}
            />
          </div>
        </Section>

        {/* ─── Tool Progress Indicator ──────────────────────── */}
        <Section title="Tool Progress" description="Real-time progress indicator shown while tools are running">
          <div className="space-y-4 max-w-3xl">
            <Card label="Single tool running">
              <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
                <YarnBallDot className="text-cc-primary animate-pulse" />
                <span>Terminal</span>
                <span className="text-cc-muted/60">8s</span>
              </div>
            </Card>
            <Card label="Multiple tools running">
              <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
                <YarnBallDot className="text-cc-primary animate-pulse" />
                <span>Search Content</span>
                <span className="text-cc-muted/60">3s</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>Find Files</span>
                <span className="text-cc-muted/60">2s</span>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Tool Use Summary ──────────────────────────────── */}
        <Section title="Tool Use Summary" description="System message summarizing batch tool execution">
          <div className="space-y-4 max-w-3xl">
            <Card label="Summary as system message">
              <MessageBubble
                message={{
                  id: "summary-1",
                  role: "system",
                  content: "Read 4 files, searched 12 matches across 3 directories",
                  timestamp: Date.now(),
                }}
              />
            </Card>
          </div>
        </Section>

        {/* ─── Task Panel ──────────────────────────────── */}
        <Section title="Tasks" description="Task list states: pending, in progress, completed, blocked">
          <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
            {/* Session stats mock */}
            <div className="px-4 py-3 border-b border-cc-border space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-cc-muted uppercase tracking-wider">Cost</span>
                <span className="text-[13px] font-medium text-cc-fg tabular-nums">$0.1847</span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-cc-muted uppercase tracking-wider">Context</span>
                  <span className="text-[11px] text-cc-muted tabular-nums">62%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
                  <div
                    className="h-full rounded-full bg-cc-warning transition-all duration-500"
                    style={{ width: "62%" }}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-cc-muted uppercase tracking-wider">Turns</span>
                <span className="text-[13px] font-medium text-cc-fg tabular-nums">14</span>
              </div>
            </div>
            {/* Task header */}
            <div className="px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
              <span className="text-[12px] font-semibold text-cc-fg">Tasks</span>
              <span className="text-[11px] text-cc-muted tabular-nums">2/{MOCK_TASKS.length}</span>
            </div>
            {/* Task list */}
            <div className="px-3 py-2 space-y-0.5">
              {MOCK_TASKS.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          </div>
        </Section>

        {/* ─── GitHub PR Status ──────────────────────────────── */}
        <Section
          title="GitHub PR Status"
          description="PR health shown in the TaskPanel — checks, reviews, unresolved comments"
        >
          <div className="space-y-4">
            <Card label="Open PR — failing checks + changes requested">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_FAILING} />
              </div>
            </Card>
            <Card label="Open PR — all checks passed + approved">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_PASSING} />
              </div>
            </Card>
            <Card label="Draft PR — pending checks">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_DRAFT} />
              </div>
            </Card>
            <Card label="Merged PR">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                <GitHubPRDisplay pr={MOCK_PR_MERGED} />
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── MCP Servers ──────────────────────────────── */}
        <Section title="MCP Servers" description="MCP server status display with toggle, reconnect, and tool listing">
          <div className="space-y-4">
            <Card label="All server states (connected, failed, disabled, connecting)">
              <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
                {/* MCP section header */}
                <div className="shrink-0 px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-cc-fg flex items-center gap-1.5">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted">
                      <path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v1A1.5 1.5 0 0113 5.5H3A1.5 1.5 0 011.5 4V3zm0 5A1.5 1.5 0 013 6.5h10A1.5 1.5 0 0114.5 8v1A1.5 1.5 0 0113 10.5H3A1.5 1.5 0 011.5 9V8zm0 5A1.5 1.5 0 013 11.5h10a1.5 1.5 0 011.5 1.5v1a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 14v-1z" />
                    </svg>
                    MCP Servers
                  </span>
                  <span className="text-[11px] text-cc-muted">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="w-3.5 h-3.5"
                    >
                      <path d="M2.5 8a5.5 5.5 0 019.78-3.5M13.5 8a5.5 5.5 0 01-9.78 3.5" strokeLinecap="round" />
                      <path d="M12.5 2v3h-3M3.5 14v-3h3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </div>
                {/* Server rows */}
                <div className="px-3 py-2 space-y-1.5">
                  {MOCK_MCP_SERVERS.map((server) => (
                    <PlaygroundMcpRow key={server.name} server={server} />
                  ))}
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Codex Session Details ──────────────────────── */}
        <Section
          title="Codex Session Details"
          description="Rate limits and token details for Codex (OpenAI) sessions — streamed via session_update"
        >
          <div className="space-y-4">
            <Card label="Rate limits with token breakdown">
              <CodexPlaygroundDemo />
            </Card>
          </div>
        </Section>

        {/* ─── Status Indicators ──────────────────────────────── */}
        <Section title="Status Indicators" description="Connection and session status banners">
          <div className="space-y-3 max-w-3xl">
            <Card label="Disconnected warning">
              <div className="px-4 py-2 bg-cc-warning/10 border border-cc-warning/20 rounded-lg text-center">
                <span className="text-xs text-cc-warning font-medium">Reconnecting to session...</span>
              </div>
            </Card>
            <Card label="Connected">
              <div className="flex items-center gap-2 px-3 py-2 bg-cc-card border border-cc-border rounded-lg">
                <span className="w-2 h-2 rounded-full bg-cc-success" />
                <span className="text-xs text-cc-fg font-medium">Connected</span>
                <span className="text-[11px] text-cc-muted ml-auto">claude-opus-4-6</span>
              </div>
            </Card>
            <Card label="Running / Thinking">
              <div className="flex items-center gap-2 px-3 py-2 bg-cc-card border border-cc-border rounded-lg">
                <YarnBallDot className="text-cc-primary animate-[pulse-dot_1.5s_ease-in-out_infinite]" />
                <span className="text-xs text-cc-fg font-medium">Thinking</span>
              </div>
            </Card>
            <Card label="Compacting">
              <div className="flex items-center gap-2 px-3 py-2 bg-cc-card border border-cc-border rounded-lg">
                <svg className="w-3.5 h-3.5 text-cc-muted animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="28"
                    strokeDashoffset="8"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="text-xs text-cc-muted font-medium">Compacting context...</span>
              </div>
            </Card>
            <Card label="Session Status Dots (sidebar attention states)">
              <div className="flex items-center gap-6 px-4 py-3">
                <div className="flex items-center gap-2">
                  <SessionStatusDot
                    archived={false}
                    permCount={0}
                    isConnected={true}
                    sdkState="connected"
                    status="idle"
                  />
                  <span className="text-xs text-cc-muted">Idle</span>
                </div>
                <div className="flex items-center gap-2">
                  <SessionStatusDot
                    archived={false}
                    permCount={0}
                    isConnected={true}
                    sdkState="connected"
                    status="running"
                  />
                  <span className="text-xs text-cc-muted">Running</span>
                </div>
                <div className="flex items-center gap-2">
                  <SessionStatusDot
                    archived={false}
                    permCount={2}
                    isConnected={true}
                    sdkState="connected"
                    status="running"
                  />
                  <span className="text-xs text-cc-muted">Permission</span>
                </div>
                <div className="flex items-center gap-2">
                  <SessionStatusDot
                    archived={false}
                    permCount={0}
                    isConnected={true}
                    sdkState="connected"
                    status="idle"
                    hasUnread
                  />
                  <span className="text-xs text-blue-500 font-semibold">Needs Review</span>
                </div>
                <div className="flex items-center gap-2">
                  <SessionStatusDot
                    archived={false}
                    permCount={0}
                    isConnected={false}
                    sdkState="exited"
                    status={null}
                  />
                  <span className="text-xs text-cc-muted">Disconnected</span>
                </div>
                <div className="flex items-center gap-2">
                  <SessionStatusDot
                    archived={false}
                    permCount={0}
                    isConnected={false}
                    sdkState="exited"
                    status={null}
                    idleKilled
                  />
                  <span className="text-xs text-cc-muted">Idle Killed</span>
                </div>
                <div className="flex items-center gap-2">
                  <SessionStatusDot
                    archived={false}
                    permCount={0}
                    isConnected={true}
                    sdkState="connected"
                    status="compacting"
                  />
                  <span className="text-xs text-cc-muted">Compacting</span>
                </div>
                <div className="flex items-center gap-2">
                  <SessionStatusDot archived permCount={0} isConnected={false} sdkState={null} status={null} />
                  <span className="text-xs text-cc-muted">Archived</span>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        <Section
          title="Session List Herd Groups"
          description="Leader and worker pills share a herd-group color so different leader groups are easier to scan in the sidebar."
        >
          <div className="max-w-md">
            <Card label="Session list pills">
              <div className="space-y-1 rounded-xl bg-cc-sidebar p-2">
                {PLAYGROUND_SESSION_ROWS.map(({ session, sessionName, preview }, index) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={index === 0}
                    sessionName={sessionName}
                    sessionPreview={preview}
                    permCount={session.permCount}
                    isRecentlyRenamed={false}
                    onSelect={() => {}}
                    onStartRename={() => {}}
                    onArchive={() => {}}
                    onUnarchive={() => {}}
                    onDelete={() => {}}
                    onClearRecentlyRenamed={() => {}}
                    editingSessionId={null}
                    editingName=""
                    setEditingName={() => {}}
                    onConfirmRename={() => {}}
                    onCancelRename={() => {}}
                    editInputRef={{ current: null }}
                    herdGroupBadgeTheme={PLAYGROUND_HERD_GROUP_THEMES.get(session.id)}
                  />
                ))}
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Composer ──────────────────────────────── */}
        <Section title="Composer" description="Message input bar with mode toggle, image upload, and send/stop buttons">
          <div className="max-w-3xl">
            <Card label="Connected — code mode">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value="Can you refactor the auth module to use JWT?"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between gap-2 px-4 pb-1 text-[11px]">
                    <div className="min-w-0 flex items-center gap-2 text-cc-muted">
                      <span className="shrink-0 inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-amber-300/90">
                        VS Code
                      </span>
                      <span className="truncate">Selection: web/src/Composer.tsx:438:7-444:31 click send</span>
                    </div>
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium bg-cc-primary/15 text-cc-primary">
                      Attach on
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Connected — VS Code preview only">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value="Does this selection matter?"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between gap-2 px-4 pb-1 text-[11px]">
                    <div className="min-w-0 flex items-center gap-2 text-cc-muted">
                      <span className="shrink-0 inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-amber-300/90">
                        VS Code
                      </span>
                      <span className="truncate">Cursor: web/src/App.tsx:58:11 navigateToMostRecentSession()</span>
                    </div>
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium bg-cc-hover text-cc-muted">
                      Attach off
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Desktop drag-over image attach">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="relative bg-cc-input-bg border border-cc-primary rounded-[14px] overflow-hidden shadow-[0_0_0_3px_rgba(255,122,26,0.12)]">
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border border-dashed border-cc-primary/50 bg-cc-primary/10">
                    <div className="rounded-full border border-cc-primary/25 bg-cc-card/95 px-3 py-1 text-[11px] font-medium text-cc-primary shadow-sm">
                      Drop images to attach
                    </div>
                  </div>
                  <textarea
                    readOnly
                    value="Investigate this screenshot and attached error."
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-primary bg-cc-primary/10">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Send pressed — paw morph">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div
                        className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white animate-[send-morph_500ms_ease-out]"
                        style={{ animationPlayState: "paused", animationDelay: "-150ms" }}
                      >
                        <CatPawAvatar className="w-4 h-4" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Plan mode active">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-primary/40 rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-primary">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <rect x="3" y="3" width="3.5" height="10" rx="0.75" />
                        <rect x="9.5" y="3" width="3.5" height="10" rx="0.75" />
                      </svg>
                      <span>plan</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Running — stop button visible">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                    style={{ minHeight: "36px" }}
                  />
                  {/* Git branch info */}
                  <div className="flex items-center gap-2 px-4 pb-1 text-[11px] text-cc-muted overflow-hidden">
                    <span className="flex items-center gap-1 truncate min-w-0">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                        <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                      </svg>
                      <span className="truncate">feat/jwt-auth</span>
                      <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1 rounded">container</span>
                    </span>
                    <span className="flex items-center gap-0.5 text-[10px]">
                      <span className="text-green-500">3&#8593;</span>
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="text-green-500">+142</span>
                      <span className="text-red-400">-38</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-3 sm:gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-cc-error/10 text-cc-error">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <rect x="3" y="3" width="10" height="10" rx="1" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Reply Chip ──────────────────────────────── */}
        <Section
          title="Reply Chip"
          description="Shows which assistant message the user is replying to. Appears above the composer textarea."
        >
          <div className="max-w-3xl">
            <Card label="Short preview text">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <ReplyChip
                  previewText="Here's the implementation plan for the reply feature..."
                  onDismiss={() => {}}
                />
                <div className="px-4 py-3 text-cc-muted text-sm italic">(Composer textarea would be here)</div>
              </div>
            </Card>
            <Card label="Long preview text (truncated)">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <ReplyChip
                  previewText="This is a much longer preview text that exceeds the typical display width and should be truncated with CSS so it doesn't wrap to multiple lines and break the layout"
                  onDismiss={() => {}}
                />
                <div className="px-4 py-3 text-cc-muted text-sm italic">(Composer textarea would be here)</div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── User Message Reply Chip ──────────────────────────────── */}
        <Section
          title="User Message Reply Chip"
          description="Read-only reply chip rendered above user message bubble text when the user replied to a specific assistant message."
        >
          <div className="max-w-3xl">
            <Card label="Short reply context">
              <div className="flex justify-end">
                <div className="max-w-[80%] px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                  <UserReplyChip previewText="Here's the implementation plan for the reply feature..." />
                  <pre className="text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
                    Can you also add keyboard shortcuts for this?
                  </pre>
                </div>
              </div>
            </Card>
            <Card label="Long reply context (truncated)">
              <div className="flex justify-end">
                <div className="max-w-[80%] px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                  <UserReplyChip previewText="This is a much longer preview text that exceeds the typical display width and should be truncated with CSS to keep the chip compact" />
                  <pre className="text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
                    I disagree with this approach. Let me explain why.
                  </pre>
                </div>
              </div>
            </Card>
            <Card label="Reply with code in preview">
              <div className="flex justify-end">
                <div className="max-w-[80%] px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                  <UserReplyChip previewText={'Here\'s the fix: `const result = await fetchData("api/v2")`'} />
                  <pre className="text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
                    This doesn't handle the error case. Can you add a try/catch?
                  </pre>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Notification Marker ──────────────────────────────── */}
        <Section
          title="Notification Marker"
          description="Rendered after assistant message content when a notification was anchored to it via takode notify."
        >
          <div className="max-w-3xl">
            <Card label="needs-input (amber)">
              <div className="text-cc-fg text-sm">
                <p className="mb-1">I've finished analyzing the logs. There are two approaches we could take:</p>
                <p className="text-cc-muted">1. Increase the timeout globally, or 2. Add retry logic per-request.</p>
                <NotificationMarker category="needs-input" />
              </div>
            </Card>
            <Card label="review (blue)">
              <div className="text-cc-fg text-sm">
                <p>All changes have been committed and tests pass. The PR is ready for your review.</p>
                <NotificationMarker category="review" />
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Work Board ──────────────────────────────────────────── */}
        <Section
          title="Work Board"
          description="Collapsible card rendered when a takode board command outputs board data. Shows quest/worker assignments and freeform status."
        >
          <div className="max-w-3xl space-y-4">
            <Card label="Board with items">
              <BoardBlock board={[
                { questId: "q-42", title: "Fix mobile sidebar overflow", worker: "abc123", workerNum: 5, status: "IMPLEMENTING", updatedAt: Date.now() - 60000 },
                { questId: "q-55", title: "Add dark mode toggle", worker: "def456", workerNum: 8, status: "QUEUED", waitFor: ["q-42"], updatedAt: Date.now() - 30000 },
                { questId: "q-61", title: "Optimize DB queries", status: "QUEUED", waitFor: ["q-50", "q-51"], updatedAt: Date.now() },
              ]} />
            </Card>
            <Card label="Empty board">
              <BoardBlock board={[]} />
            </Card>
          </div>
        </Section>

        {/* ─── Composer — Voice Recording ──────────────────────────────── */}
        <Section
          title="Composer — Voice Recording"
          description="Microphone button records audio, server transcribes via Gemini or OpenAI Whisper"
        >
          <div className="max-w-3xl">
            <Card label="Mobile — voice unavailable (idle)">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value="I still need the mic button to stay visible on mobile."
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-3 sm:gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                          <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted/30">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <rect x="3" y="3" width="10" height="10" rx="1" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Mobile — voice unavailable (after tap)">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <div className="px-4 pt-2">
                    <div className="flex items-start gap-2 rounded-lg border border-cc-warning/25 bg-cc-warning/10 px-3 py-2 text-[11px] text-cc-warning">
                      <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-current opacity-80" />
                      <span className="flex-1">Voice input requires HTTPS or localhost in this browser.</span>
                    </div>
                  </div>
                  <textarea
                    readOnly
                    value="Tap the disabled mic only when you want the full explanation."
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-3 sm:gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                          <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted/30">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <rect x="3" y="3" width="10" height="10" rx="1" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Recording active">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  {/* Recording indicator */}
                  <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-red-500">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span>Recording...</span>
                  </div>
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      {/* Mic button — recording state (red) */}
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-red-500 bg-red-500/10">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 animate-pulse">
                          <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                          <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Recording with mode toggle (edit/append)">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  {/* Recording indicator with mode toggle */}
                  <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-red-500">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                    <span className="shrink-0">Recording</span>
                    {/* Volume bars mock */}
                    <div className="flex items-center gap-[2px] h-3">
                      {[0, 0.15, 0.3, 0.45, 0.6].map((_, i) => (
                        <div
                          key={i}
                          className="w-[3px] rounded-full"
                          style={{
                            height: `${4 + i * 2}px`,
                            backgroundColor: i < 3 ? "rgb(239 68 68)" : "rgb(239 68 68 / 0.3)",
                          }}
                        />
                      ))}
                    </div>
                    {/* Mode toggle */}
                    <div className="ml-auto flex items-center gap-0.5 rounded-full bg-cc-bg-secondary p-0.5">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-cc-primary text-white">
                        Edit
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium text-cc-muted">Append</span>
                    </div>
                  </div>
                  <textarea
                    readOnly
                    value="Some existing text in the composer..."
                    rows={1}
                    className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-red-500 bg-red-500/10">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 animate-pulse">
                          <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                          <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Recording with mode toggle (append selected)">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  {/* Recording indicator with append mode active */}
                  <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-red-500">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                    <span className="shrink-0">Recording</span>
                    <div className="flex items-center gap-[2px] h-3">
                      {[0, 0.15, 0.3, 0.45, 0.6].map((_, i) => (
                        <div
                          key={i}
                          className="w-[3px] rounded-full"
                          style={{
                            height: `${4 + i * 2}px`,
                            backgroundColor: i < 4 ? "rgb(239 68 68)" : "rgb(239 68 68 / 0.3)",
                          }}
                        />
                      ))}
                    </div>
                    {/* Mode toggle — append selected */}
                    <div className="ml-auto flex items-center gap-0.5 rounded-full bg-cc-bg-secondary p-0.5">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium text-cc-muted">Edit</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-cc-primary text-white">
                        Append
                      </span>
                    </div>
                  </div>
                  <textarea
                    readOnly
                    value="Some existing text in the composer..."
                    rows={1}
                    className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-red-500 bg-red-500/10">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 animate-pulse">
                          <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                          <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Transcribing — STT in progress">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  {/* Transcribing indicator */}
                  <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary">
                    <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse" />
                    <span>Transcribing...</span>
                  </div>
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      {/* Mic button — disabled during transcription */}
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                          <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Enhancing — LLM enhancement in progress">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  {/* Enhancing indicator — shown after STT completes, during LLM enhancement */}
                  <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary">
                    <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse" />
                    <span>Enhancing...</span>
                  </div>
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                          <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Voice edit preview — explicit accept or undo">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value={"Ship the reconnect fix tonight and add a short rollback note for on-call."}
                    rows={2}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                    style={{ minHeight: "54px" }}
                  />
                  <div className="px-4 pb-3 pt-1">
                    <div className="rounded-xl border border-cc-primary/20 bg-cc-primary/5 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-cc-primary">
                            Voice edit preview
                          </div>
                          <div className="mt-1 text-xs leading-relaxed text-cc-muted">
                            Apply instruction:{" "}
                            <span className="text-cc-fg">
                              Make this calmer, split it into two sentences, and mention the rollback note at the end.
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button className="rounded-lg border border-cc-border px-3 py-1.5 text-xs font-medium text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg">
                            Undo
                          </button>
                          <button className="rounded-lg bg-cc-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90">
                            Accept
                          </button>
                        </div>
                      </div>
                      <div className="mt-3 overflow-hidden rounded-lg border border-cc-border bg-cc-bg/80">
                        <DiffViewer
                          oldText="Ship the reconnect fix tonight and add a short rollback note for on-call."
                          newText={
                            "Ship the reconnect fix tonight.\nAdd a short rollback note for on-call so the handoff stays calm and explicit."
                          }
                          mode="compact"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                          <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <div className="mt-4" />
            <Card label="Idle — mic button ready">
              <div className="border-t border-cc-border bg-cc-card px-4 py-3">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                    style={{ minHeight: "36px" }}
                  />
                  <div className="flex items-center justify-between px-2.5 pb-2.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path
                          d="M2.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                        <path
                          d="M8.5 4l4 4-4 4"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                      <span>code</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-4 h-4"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      {/* Mic button — idle state (muted) */}
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                          <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Streaming Indicator ──────────────────────────────── */}
        <Section
          title="Streaming Indicator"
          description="Live typing animation shown while the assistant is generating"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Codex streaming (complete lines only)">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5 -ml-0.5">
                  <CatPawLeft className="w-3 h-3 text-cc-primary animate-[paw-walk_0.8s_ease-in-out_infinite]" />
                </div>
                <div className="flex-1 min-w-0">
                  <MarkdownContent
                    text={"I'll start by creating the JWT utility module with sign and verify helpers.\n"}
                  />
                  <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle -translate-y-[2px] animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                </div>
              </div>
            </Card>
            <Card label="Claude streaming (serif)">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5 -ml-0.5">
                  <CatPawLeft className="w-3 h-3 text-cc-primary animate-[paw-walk_0.8s_ease-in-out_infinite]" />
                </div>
                <div className="flex-1 min-w-0">
                  <pre className="font-serif-assistant text-[15px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                    I'll start by creating the JWT utility module with sign and verify helpers. Let me first check what
                    dependencies are already installed...
                    <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                  </pre>
                </div>
              </div>
            </Card>
            <Card label="Codex live thinking">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5 -ml-0.5">
                  <CatPawLeft className="w-3 h-3 text-cc-primary animate-[paw-walk_0.8s_ease-in-out_infinite]" />
                </div>
                <div className="flex-1 min-w-0">
                  <CodexThinkingInline text="Checking how collapsed subagent turns handle parented reasoning." />
                </div>
              </div>
            </Card>
            <Card label="Generation stats bar">
              <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
                <YarnBallDot className="text-cc-primary animate-pulse" />
                <span>Generating...</span>
                <span className="text-cc-muted/60">(</span>
                <span>12s</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>&darr; 1.2k</span>
                <span className="text-cc-muted/60">)</span>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Tool Message Groups ──────────────────────────────── */}
        <Section
          title="Tool Message Groups"
          description="Consecutive same-tool calls collapsed into a single expandable row"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Multi-item group (2 Terminal commands)">
              <PlaygroundToolGroup
                toolName="Bash"
                items={[
                  { id: "bash-group-1", name: "Bash", input: { command: "test -f /home/jiayiwei/.config/app.json" } },
                  {
                    id: "bash-group-2",
                    name: "Bash",
                    input: { command: "sed -n '1,80p' /home/jiayiwei/.config/app.json" },
                  },
                ]}
              />
            </Card>
            <Card label="Multi-item group (4 Reads)">
              <PlaygroundToolGroup toolName="Read" items={MOCK_TOOL_GROUP_ITEMS} />
            </Card>
            <Card label="Single-item group">
              <PlaygroundToolGroup
                toolName="Glob"
                items={[{ id: "sg-1", name: "Glob", input: { pattern: "src/auth/**/*.ts" } }]}
              />
            </Card>
          </div>
        </Section>

        {/* ─── Subagent Groups ──────────────────────────────── */}
        <Section
          title="Subagent Groups"
          description="Unified card for Task tool subagents — prompt, activities, and result in one collapsible container"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Subagent with prompt, tool calls, and result">
              <PlaygroundSubagentGroup
                description="Search codebase for auth patterns"
                agentType="Explore"
                prompt="Find all files related to authentication and authorization in the codebase. Look for middleware, guards, and token handling."
                items={MOCK_SUBAGENT_TOOL_ITEMS}
                durationSeconds={8.6}
                resultText={
                  "Found **3 authentication-related files**:\n\n- `src/auth/middleware.ts` — JWT validation middleware\n- `src/auth/session.ts` — Session management with Redis\n- `src/routes/login.ts` — Login endpoint with rate limiting\n\nThe codebase uses a standard JWT + refresh token pattern."
                }
              />
            </Card>
            <Card label="Subagent still running (has children, no result)">
              <PlaygroundSubagentGroup
                description="Run database migration tests"
                agentType="general-purpose"
                prompt="Execute all database migration tests and report any failures."
                items={MOCK_SUBAGENT_TOOL_ITEMS.slice(0, 2)}
                liveStartedAt={Date.now() - 13_000}
              />
            </Card>
            <Card label="Subagent just spawned (no children yet)">
              <PlaygroundSubagentGroup
                description="Analyze performance bottlenecks"
                agentType="Plan"
                prompt="Profile the application startup and identify the top 3 performance bottlenecks."
                items={[]}
              />
            </Card>
            <Card label="Subagent interrupted (session ended without result)">
              <PlaygroundSubagentGroup
                description="Review authentication module"
                agentType="general-purpose"
                prompt="Audit the auth module for security vulnerabilities and suggest improvements."
                items={[]}
                durationSeconds={4.2}
                interrupted
              />
            </Card>
          </div>
        </Section>

        {/* ─── Collapsed Activity Bars ──────────────────────────────── */}
        <Section
          title="Collapsed Activity Bars"
          description="Turn summary bars for collapsed agent activity — shows message, tool, agent, and herd event counts"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Collapsed bar with herd events">
              <div className="rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
                <button className="w-full flex items-center gap-1.5 py-1.5 px-3 border-l-2 border-cc-border/40 bg-cc-hover/10 hover:bg-cc-hover/30 transition-colors cursor-pointer text-[11px] text-cc-muted font-mono-code">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/60">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  <span>3 messages</span>
                  <span className="text-cc-muted/40">&middot;</span>
                  <span>5 tools</span>
                  <span className="text-cc-muted/40">&middot;</span>
                  <span>1 agent</span>
                  <span className="text-cc-muted/40">&middot;</span>
                  <span>2 herd events</span>
                  <span className="text-cc-muted/40">&middot;</span>
                  <span>2m 15s</span>
                </button>
              </div>
            </Card>
            <Card label="Collapsed bar without herd events">
              <div className="rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
                <button className="w-full flex items-center gap-1.5 py-1.5 px-3 border-l-2 border-cc-border/40 bg-cc-hover/10 hover:bg-cc-hover/30 transition-colors cursor-pointer text-[11px] text-cc-muted font-mono-code">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/60">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  <span>1 message</span>
                  <span className="text-cc-muted/40">&middot;</span>
                  <span>3 tools</span>
                  <span className="text-cc-muted/40">&middot;</span>
                  <span>12s</span>
                </button>
              </div>
            </Card>
            <Card label="Collapsed leader turn — @to(user) rendered outside collapsed card">
              <div className="space-y-3">
                {/* Collapsed activity card */}
                <div className="flex items-start gap-3">
                  <PawTrailAvatar />
                  <div className="flex-1 min-w-0 rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
                    <button className="w-full flex items-center gap-1.5 py-1.5 px-3 border-l-2 border-cc-border/40 bg-cc-hover/10 hover:bg-cc-hover/30 transition-colors cursor-pointer text-[11px] text-cc-muted font-mono-code">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/60">
                        <path d="M6 4l4 4-4 4" />
                      </svg>
                      <span>3 messages</span>
                      <span className="text-cc-muted/40">&middot;</span>
                      <span>6 tools</span>
                      <span className="text-cc-muted/40">&middot;</span>
                      <span>3 herd events</span>
                      <span className="text-cc-muted/40">&middot;</span>
                      <span>17m 33s</span>
                    </button>
                  </div>
                </div>
                {/* @to(user) message rendered outside the collapsed card as a standalone bubble */}
                <MessageBubble
                  message={{
                    id: "playground-collapsed-touser",
                    role: "assistant",
                    content:
                      "Approved #70's plan for q-43. It's a clean unification: resize once at store time (1920px max). @to(user)",
                    leaderUserAddressed: true,
                    timestamp: Date.now() - 60000,
                  }}
                />
              </div>
            </Card>
          </div>
        </Section>
        <Section
          title="Herd Event Batch Groups"
          description="Consecutive herd event messages are collapsed into a single expandable group with a time range, reducing vertical noise in leader sessions."
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Collapsed batch (default state)">
              <div className="py-2">
                <button className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 cursor-pointer hover:text-cc-fg/70 transition-colors">
                  <span className="text-amber-500/60 shrink-0">◇</span>
                  <span>4 herd updates · 11:44 AM – 11:55 AM</span>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted/40 shrink-0">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                </button>
              </div>
            </Card>
            <Card label="Expanded batch (click to see events)">
              <div className="py-2">
                <button className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 cursor-pointer hover:text-cc-fg/70 transition-colors">
                  <span className="text-amber-500/60 shrink-0">◇</span>
                  <span>4 herd updates · 11:44 AM – 11:55 AM</span>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted/40 shrink-0 rotate-90">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                </button>
                <div className="space-y-0">
                  <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 leading-snug">
                    <span className="text-amber-500/60 shrink-0">◇</span>
                    <span className="truncate">#34 | turn_end | ✓ 56.3s | tools: Read(3), Grep(2) | &quot;Refactored auth middleware&quot;</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 leading-snug">
                    <span className="text-amber-500/60 shrink-0">◇</span>
                    <span className="truncate">#35 | session_archived</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 leading-snug">
                    <span className="text-amber-500/60 shrink-0">◇</span>
                    <span className="truncate">#34 | turn_end | ✓ 12.1s | tools: Edit(1) | &quot;Added tests&quot;</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 leading-snug">
                    <span className="text-amber-500/60 shrink-0">◇</span>
                    <span className="truncate">#36 | session_archived</span>
                  </div>
                </div>
              </div>
            </Card>
            <Card label="Single herd event (no batching)">
              <div className="py-2">
                <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 leading-snug">
                  <span className="text-amber-500/60 shrink-0">◇</span>
                  <span className="truncate">#34 | turn_end | ✓ 56.3s | tools: Read(3), Grep(2) | &quot;Refactored auth middleware&quot;</span>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ─── Diff Viewer ──────────────────────────────── */}
        <Section
          title="Diff Viewer"
          description="Unified diff rendering with word-level highlighting — used in ToolBlock, PermissionBanner, and DiffPanel"
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="Edit diff (compact mode)">
              <DiffViewer
                oldText={"export function formatDate(d: Date) {\n  return d.toISOString();\n}"}
                newText={
                  'export function formatDate(d: Date, locale = "en-US") {\n  return d.toLocaleDateString(locale, {\n    year: "numeric",\n    month: "short",\n    day: "numeric",\n  });\n}'
                }
                fileName="src/utils/format.ts"
                mode="compact"
              />
            </Card>
            <Card label="New file diff (compact mode)">
              <DiffViewer
                newText={
                  'export const config = {\n  apiUrl: "https://api.example.com",\n  timeout: 5000,\n  retries: 3,\n  debug: process.env.NODE_ENV !== "production",\n};\n'
                }
                fileName="src/config.ts"
                mode="compact"
              />
            </Card>
            <Card label="Git diff (full mode with line numbers)">
              <DiffViewer
                unifiedDiff={`diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts
--- a/src/auth/middleware.ts
+++ b/src/auth/middleware.ts
@@ -1,8 +1,12 @@
-import { getSession } from "./session";
+import { verifyToken } from "./jwt";
+import type { Request, Response, NextFunction } from "express";

-export function authMiddleware(req, res, next) {
-  const session = getSession(req);
-  if (!session?.userId) {
+export function authMiddleware(req: Request, res: Response, next: NextFunction) {
+  const header = req.headers.authorization;
+  if (!header?.startsWith("Bearer ")) {
     return res.status(401).json({ error: "Unauthorized" });
   }
-  req.userId = session.userId;
+  const token = header.slice(7);
+  const payload = verifyToken(token);
+  if (!payload) return res.status(401).json({ error: "Invalid token" });
+  req.userId = payload.userId;
   next();
 }`}
                mode="full"
              />
            </Card>
            <Card label="No changes">
              <DiffViewer oldText="same content" newText="same content" />
            </Card>
          </div>
        </Section>
        {/* ─── Session Creation Progress ─────────────────────── */}
        <Section
          title="Session Creation Progress"
          description="Step-by-step progress indicator shown during session creation (SSE streaming)"
        >
          <div className="space-y-4 max-w-md">
            <Card label="In progress (container session)">
              <SessionCreationProgress
                steps={
                  [
                    { step: "resolving_env", label: "Resolving environment...", status: "done" },
                    { step: "pulling_image", label: "Pulling Docker image...", status: "done" },
                    { step: "creating_container", label: "Starting container...", status: "in_progress" },
                    { step: "launching_cli", label: "Launching Claude Code...", status: "in_progress" },
                  ] satisfies CreationProgressEvent[]
                }
              />
            </Card>
            <Card label="Completed (worktree session)">
              <SessionCreationProgress
                steps={
                  [
                    { step: "resolving_env", label: "Resolving environment...", status: "done" },
                    { step: "fetching_git", label: "Fetching from remote...", status: "done" },
                    { step: "checkout_branch", label: "Checking out feat/auth...", status: "done" },
                    { step: "creating_worktree", label: "Creating worktree...", status: "done" },
                    { step: "launching_cli", label: "Launching Claude Code...", status: "done" },
                  ] satisfies CreationProgressEvent[]
                }
              />
            </Card>
            <Card label="Error during image pull">
              <SessionCreationProgress
                steps={
                  [
                    { step: "resolving_env", label: "Resolving environment...", status: "done" },
                    { step: "pulling_image", label: "Pulling Docker image...", status: "error" },
                  ] satisfies CreationProgressEvent[]
                }
                error="Failed to pull docker.io/stangirard/the-companion:latest — connection timed out after 30s"
              />
            </Card>
            <Card label="Error during init script">
              <SessionCreationProgress
                steps={
                  [
                    { step: "resolving_env", label: "Resolving environment...", status: "done" },
                    { step: "pulling_image", label: "Pulling Docker image...", status: "done" },
                    { step: "creating_container", label: "Starting container...", status: "done" },
                    { step: "running_init_script", label: "Running init script...", status: "error" },
                  ] satisfies CreationProgressEvent[]
                }
                error={"npm ERR! code ENOENT\nnpm ERR! syscall open\nnpm ERR! path /app/package.json"}
              />
            </Card>
          </div>
        </Section>
        {/* ─── Session Creation View (StepList) ──────────────────────────── */}
        <Section
          title="Session Creation View"
          description="Inline creation progress shown when a pending session is selected (replaces old full-screen overlay)"
        >
          <div className="space-y-4">
            <Card label="In progress (container session)">
              <div className="py-4">
                <StepList
                  steps={
                    [
                      { step: "resolving_env", label: "Environment resolved", status: "done" },
                      { step: "pulling_image", label: "Pulling Docker image...", status: "done" },
                      { step: "creating_container", label: "Starting container...", status: "in_progress" },
                      { step: "launching_cli", label: "Launching Claude Code...", status: "in_progress" },
                    ] satisfies CreationProgressEvent[]
                  }
                />
              </div>
            </Card>
            <Card label="All steps done">
              <div className="py-4">
                <StepList
                  steps={
                    [
                      { step: "resolving_env", label: "Environment resolved", status: "done" },
                      { step: "fetching_git", label: "Fetch complete", status: "done" },
                      { step: "creating_worktree", label: "Worktree created", status: "done" },
                      { step: "launching_cli", label: "CLI launched", status: "done" },
                    ] satisfies CreationProgressEvent[]
                  }
                />
              </div>
            </Card>
            <Card label="Error state">
              <div className="py-4">
                <StepList
                  steps={
                    [
                      { step: "resolving_env", label: "Environment resolved", status: "done" },
                      { step: "pulling_image", label: "Pulling Docker image...", status: "error" },
                    ] satisfies CreationProgressEvent[]
                  }
                />
                <div className="mt-3 w-full max-w-xs px-4">
                  <div className="px-3 py-2.5 rounded-lg bg-cc-error/5 border border-cc-error/20">
                    <p className="text-[11px] text-cc-error whitespace-pre-wrap font-mono-code leading-relaxed">
                      Failed to pull docker.io/stangirard/the-companion:latest — connection timed out after 30s
                    </p>
                  </div>
                </div>
              </div>
            </Card>
            <Card label="Codex backend">
              <div className="py-4">
                <StepList
                  steps={
                    [
                      { step: "resolving_env", label: "Environment resolved", status: "done" },
                      { step: "launching_cli", label: "Launching Codex...", status: "in_progress" },
                    ] satisfies CreationProgressEvent[]
                  }
                />
              </div>
            </Card>
          </div>
        </Section>
        {/* ─── CLAUDE.md Editor ──────────────────────────────── */}
        <Section title="CLAUDE.md Editor" description="Modal for viewing and editing project CLAUDE.md instructions">
          <div className="space-y-4 max-w-3xl">
            <Card label="Open editor button (from TopBar)">
              <PlaygroundClaudeMdButton />
            </Card>
          </div>
        </Section>

        {/* ─── Cat Theme Elements ──────────────────────────────── */}
        <Section title="Cat Theme Elements" description="Cat-themed UI icons and animations used throughout Takode">
          <div className="space-y-4 max-w-3xl">
            <Card label="Paw Trail (down-facing, land-from-above stamp)">
              <div className="flex flex-col items-start gap-1 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center -translate-x-1 rotate-[160deg]">
                    <CatPawLeft className="w-3 h-3 text-cc-primary" />
                  </div>
                  <span className="text-xs text-cc-muted">Left paw — toes down-left (160deg)</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center translate-x-1 rotate-[200deg]">
                    <CatPawRight className="w-3 h-3 text-cc-primary" />
                  </div>
                  <span className="text-xs text-cc-muted">Right paw — toes down-right (200deg)</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center -translate-x-1 rotate-[160deg]">
                    <CatPawLeft className="w-3 h-3 text-cc-primary animate-[paw-walk_0.8s_ease-in-out_infinite]" />
                  </div>
                  <span className="text-xs text-cc-muted">Walking (streaming)</span>
                </div>
              </div>
            </Card>
            <Card label="Yarn Ball Status Dot (sidebar sessions)">
              <div className="flex items-center gap-6 px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <YarnBallDot
                    className="text-cc-success"
                    style={{ filter: "drop-shadow(0 0 4px rgba(34, 197, 94, 0.6))" }}
                  />
                  <span className="text-xs text-cc-muted">Running</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <YarnBallDot
                    className="text-cc-warning"
                    style={{ filter: "drop-shadow(0 0 4px rgba(245, 158, 11, 0.6))" }}
                  />
                  <span className="text-xs text-cc-muted">Permission</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <YarnBallDot className="text-cc-error" />
                  <span className="text-xs text-cc-muted">Disconnected</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <YarnBallDot className="text-cc-muted/40" />
                  <span className="text-xs text-cc-muted">Idle</span>
                </div>
              </div>
            </Card>
            <Card label="Yarn Ball Status Dots">
              <div className="flex items-center gap-6 px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <YarnBallDot className="text-cc-primary animate-pulse" />
                  <span className="text-xs text-cc-muted">Running</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <YarnBallDot className="text-cc-warning animate-pulse" />
                  <span className="text-xs text-cc-muted">Compacting</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <YarnBallDot className="text-cc-success" />
                  <span className="text-xs text-cc-muted">Active</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <YarnBallDot className="text-blue-500" />
                  <span className="text-xs text-cc-muted">Unread</span>
                </div>
              </div>
            </Card>
            <Card label="Yarn Ball Rolling (back-and-forth)">
              <div className="flex items-center gap-6 px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <YarnBallDot
                    className="text-cc-success yarn-ball-roll"
                    style={{ filter: "drop-shadow(0 0 4px rgba(34, 197, 94, 0.6))" }}
                  />
                  <span className="text-xs text-cc-muted">Running</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <YarnBallDot
                    className="text-cc-warning yarn-ball-roll"
                    style={{ filter: "drop-shadow(0 0 4px rgba(245, 158, 11, 0.6))" }}
                  />
                  <span className="text-xs text-cc-muted">Compacting</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <YarnBallDot className="text-cc-muted/40" />
                  <span className="text-xs text-cc-muted">Static (idle)</span>
                </div>
              </div>
            </Card>
            <Card label="Yarn Ball Spinner">
              <div className="flex items-center gap-6 px-4 py-3">
                <YarnBallSpinner className="w-3 h-3 text-cc-primary" />
                <YarnBallSpinner className="w-4 h-4 text-cc-muted" />
                <YarnBallSpinner className="w-5 h-5 text-cc-primary" />
                <span className="text-xs text-cc-muted">Various sizes</span>
              </div>
            </Card>
            <Card label="Sleeping Cat (empty state)">
              <div className="flex items-center gap-6 px-4 py-3">
                <SleepingCat className="w-28 h-20" />
                <SleepingCat className="w-20 h-14" />
              </div>
            </Card>
            <Card label="Paw Approval (button morph)">
              <div className="flex items-center gap-6 px-4 py-3">
                <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-success/90 text-white cursor-pointer">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                    <path d="M3 8.5l3.5 3.5 6.5-7" />
                  </svg>
                  Allow
                </button>
                <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-success/90 text-white animate-[paw-approve_400ms_ease-out_forwards]">
                  <CatPawAvatar className="w-3.5 h-3.5" />
                  Approved
                </button>
                <span className="text-xs text-cc-muted">Button morphs on approval</span>
              </div>
            </Card>
          </div>
        </Section>

        <Section
          title="Session Search"
          description="In-session search highlights matching text in messages. SearchBar drives the interaction; HighlightedText renders per-message match highlights."
        >
          <div className="space-y-4 max-w-3xl">
            <Card label="HighlightedText — Current match (strict)">
              <div className="p-2 rounded-lg bg-cc-bg text-sm text-cc-fg">
                <HighlightedText
                  text="Hello world, this is a test message with hello again"
                  query="hello"
                  mode="strict"
                  isCurrent={true}
                />
              </div>
              <p className="text-[10px] text-cc-muted mt-2">
                Strict mode, isCurrent=true — bright amber highlights on exact substring matches
              </p>
            </Card>
            <Card label="HighlightedText — Other match (strict)">
              <div className="p-2 rounded-lg bg-cc-bg text-sm text-cc-fg">
                <HighlightedText
                  text="Hello world, this is a test message with hello again"
                  query="hello"
                  mode="strict"
                  isCurrent={false}
                />
              </div>
              <p className="text-[10px] text-cc-muted mt-2">
                Strict mode, isCurrent=false — subtle amber highlights for non-active matches
              </p>
            </Card>
            <Card label="HighlightedText — Fuzzy mode">
              <div className="p-2 rounded-lg bg-cc-bg text-sm text-cc-fg">
                <HighlightedText text="The quick brown fox jumps" query="quick fox" mode="fuzzy" isCurrent={true} />
              </div>
              <p className="text-[10px] text-cc-muted mt-2">
                Fuzzy mode — each query word highlighted independently ("quick" and "fox")
              </p>
            </Card>
            <Card label="SearchBar states (description)">
              <div className="space-y-2 text-xs text-cc-muted px-1">
                <p>
                  <span className="font-medium text-cc-fg">Idle:</span> Hidden — activated via ⌘F / Ctrl+F keyboard
                  shortcut
                </p>
                <p>
                  <span className="font-medium text-cc-fg">Open (no matches):</span> Input field with "0 of 0" counter,
                  up/down navigation arrows disabled
                </p>
                <p>
                  <span className="font-medium text-cc-fg">Open (with matches):</span> "3 of 12" counter with active
                  navigation arrows, close button (Escape)
                </p>
                <p>
                  <span className="font-medium text-cc-fg">Mode toggle:</span> Strict (exact substring) ↔ Fuzzy
                  (per-word) via button in the search bar
                </p>
              </div>
            </Card>
          </div>
        </Section>
      </div>
    </div>
  );
}

// ─── Shared Layout Helpers ──────────────────────────────────────────────────

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-cc-fg">{title}</h2>
        <p className="text-xs text-cc-muted mt-0.5">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card">
      <div className="px-3 py-1.5 bg-cc-hover/50 border-b border-cc-border">
        <span className="text-[10px] text-cc-muted font-mono-code uppercase tracking-wider">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─── Inline Tool Group (mirrors MessageFeed's ToolMessageGroup) ─────────────

interface ToolItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function PlaygroundToolGroup({ toolName, items }: { toolName: string; items: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(toolName);
  const label = getToolLabel(toolName);
  const count = items.length;

  if (count === 1) {
    const item = items[0];
    return (
      <div className="flex items-start gap-3">
        <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <CatPawAvatar className="w-3 h-3 text-cc-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
              >
                <path d="M6 4l4 4-4 4" />
              </svg>
              <ToolIcon type={iconType} />
              <span className="text-xs font-medium text-cc-fg">{label}</span>
              <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
                {getPreview(item.name, item.input)}
              </span>
            </button>
            {open && (
              <div className="px-3 pb-3 pt-0 border-t border-cc-border mt-0">
                <pre className="mt-2 text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                  {JSON.stringify(item.input, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <CatPawAvatar className="w-3 h-3 text-cc-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          <button
            onClick={() => setOpen(!open)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            <ToolIcon type={iconType} />
            <span className="text-xs font-medium text-cc-fg">{label}</span>
            <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums font-medium">
              {count}
            </span>
          </button>
          {open && (
            <div className="border-t border-cc-border px-3 py-1.5">
              {items.map((item, i) => {
                const preview = getPreview(item.name, item.input);
                return (
                  <div
                    key={item.id || i}
                    className="flex items-center gap-2 py-1 text-xs text-cc-muted font-mono-code truncate"
                  >
                    <span className="w-1 h-1 rounded-full bg-cc-muted/40 shrink-0" />
                    <span className="truncate">{preview || JSON.stringify(item.input).slice(0, 80)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Inline Subagent Group (mirrors MessageFeed's SubagentContainer) ────────

function PlaygroundSubagentGroup({
  description,
  agentType,
  items,
  resultText,
  prompt,
  durationSeconds,
  liveStartedAt,
  interrupted,
}: {
  description: string;
  agentType: string;
  items: ToolItem[];
  resultText?: string;
  prompt?: string;
  durationSeconds?: number;
  liveStartedAt?: number;
  interrupted?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [promptOpen, setPromptOpen] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!liveStartedAt || durationSeconds != null) {
      setLiveSeconds(null);
      return;
    }
    const tick = () => {
      setLiveSeconds(Math.max(0, Math.round((Date.now() - liveStartedAt) / 1000)));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [liveStartedAt, durationSeconds]);

  const displayDurationSeconds = durationSeconds ?? liveSeconds;

  return (
    <div className="flex items-start gap-3">
      <PawTrailAvatar />
      <div className="flex-1 min-w-0">
        <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          {/* Header */}
          <button
            onClick={() => setOpen(!open)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            <ToolIcon type="agent" />
            <span className="text-xs font-medium text-cc-fg truncate">{description}</span>
            {agentType && (
              <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">
                {agentType}
              </span>
            )}
            {!open && resultText && (
              <span className="text-[11px] text-cc-muted truncate ml-1 font-mono-code">
                {resultText.length > 120 ? resultText.slice(0, 120) + "..." : resultText}
              </span>
            )}
            {displayDurationSeconds != null && (
              <span
                className={`text-[10px] tabular-nums shrink-0 ${durationSeconds != null ? "text-cc-muted" : "text-cc-primary"}`}
              >
                {formatDuration(displayDurationSeconds)}
              </span>
            )}
            <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
              {items.length > 0 ? items.length : interrupted ? "—" : "0"}
            </span>
          </button>

          {/* Expanded content */}
          {open && (
            <div className="border-t border-cc-border">
              {/* Collapsible prompt section */}
              {prompt && (
                <div className="border-b border-cc-border/50">
                  <button
                    onClick={() => setPromptOpen(!promptOpen)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${promptOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-medium text-cc-muted">Prompt</span>
                  </button>
                  {promptOpen && (
                    <div className="px-3 pb-2">
                      <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                        {prompt}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {/* Child activities */}
              {items.length > 0 && (
                <div className="border-b border-cc-border/50">
                  <button
                    onClick={() => setActivitiesOpen(!activitiesOpen)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${activitiesOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-medium text-cc-muted">Activities</span>
                  </button>
                  {activitiesOpen && (
                    <div className="px-3 pb-2 space-y-3">
                      <PlaygroundToolGroup toolName={items[0]?.name || "Grep"} items={items} />
                    </div>
                  )}
                </div>
              )}

              {/* No children yet indicator */}
              {items.length === 0 && !resultText && !interrupted && (
                <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-cc-muted">
                  <YarnBallSpinner className="w-3.5 h-3.5" />
                  <span>Agent starting...</span>
                </div>
              )}

              {/* Interrupted subagent — session ended without completion */}
              {items.length === 0 && interrupted && (
                <div className="px-3 py-2 text-[11px] text-cc-muted">Agent interrupted</div>
              )}

              {/* Result */}
              {resultText && (
                <div className="border-t border-cc-border/50">
                  <button
                    onClick={() => setResultOpen(!resultOpen)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${resultOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-medium text-cc-muted">Result</span>
                  </button>
                  {resultOpen && (
                    <div className="px-3 pb-2">
                      <div className="text-sm max-h-96 overflow-y-auto">
                        <MarkdownContent text={resultText} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Codex Session Demo (injects mock Codex data into a temp session) ────────

const CODEX_DEMO_SESSION = "codex-playground-demo";

function CodexPlaygroundDemo() {
  useEffect(() => {
    const store = useStore.getState();
    const prev = store.sessions.get(CODEX_DEMO_SESSION);

    // Create a fake Codex session with rate limits and token details
    store.addSession({
      session_id: CODEX_DEMO_SESSION,
      backend_type: "codex",
      model: "o3",
      cwd: "/Users/demo/project",
      tools: [],
      permissionMode: "bypassPermissions",
      claude_code_version: "0.1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 8,
      context_used_percent: 45,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/Users/demo/project",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      codex_rate_limits: {
        primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: Date.now() + 2 * 3_600_000 },
        secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: Date.now() + 5 * 86_400_000 },
      },
      codex_token_details: {
        inputTokens: 84_230,
        outputTokens: 12_450,
        cachedInputTokens: 41_200,
        reasoningOutputTokens: 8_900,
        modelContextWindow: 200_000,
      },
    });

    return () => {
      useStore.setState((s) => {
        const sessions = new Map(s.sessions);
        if (prev) sessions.set(CODEX_DEMO_SESSION, prev);
        else sessions.delete(CODEX_DEMO_SESSION);
        return { sessions };
      });
    };
  }, []);

  return (
    <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
      <CodexRateLimitsSection sessionId={CODEX_DEMO_SESSION} />
      <CodexTokenDetailsSection sessionId={CODEX_DEMO_SESSION} />
    </div>
  );
}

// ─── Inline ClaudeMd Button (opens the real editor modal) ───────────────────

function PlaygroundClaudeMdButton() {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("/tmp");

  useEffect(() => {
    api
      .getHome()
      .then((res) => setCwd(res.cwd))
      .catch(() => {});
  }, []);

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-hover border border-cc-border hover:bg-cc-active transition-colors cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-primary">
          <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
        </svg>
        <span className="text-xs font-medium text-cc-fg">Edit CLAUDE.md</span>
      </button>
      <span className="text-[11px] text-cc-muted">Click to open the editor modal (uses server working directory)</span>
      <ClaudeMdEditor cwd={cwd} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

// ─── Inline MCP Server Row (static preview, no WebSocket) ──────────────────

function PlaygroundMcpRow({ server }: { server: McpServerDetail }) {
  const [expanded, setExpanded] = useState(false);
  const statusMap: Record<string, { label: string; cls: string; dot: string }> = {
    connected: { label: "Connected", cls: "text-cc-success bg-cc-success/10", dot: "bg-cc-success" },
    connecting: { label: "Connecting", cls: "text-cc-warning bg-cc-warning/10", dot: "bg-cc-warning animate-pulse" },
    failed: { label: "Failed", cls: "text-cc-error bg-cc-error/10", dot: "bg-cc-error" },
    disabled: { label: "Disabled", cls: "text-cc-muted bg-cc-hover", dot: "bg-cc-muted opacity-40" },
  };
  const badge = statusMap[server.status] || statusMap.disabled;

  return (
    <div className="rounded-lg border border-cc-border bg-cc-bg">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${badge.dot}`} />
        <button onClick={() => setExpanded(!expanded)} className="flex-1 min-w-0 text-left cursor-pointer">
          <span className="text-[12px] font-medium text-cc-fg truncate block">{server.name}</span>
        </button>
        <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5 border-t border-cc-border pt-2">
          <div className="text-[11px] text-cc-muted space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Type:</span>
              <span>{server.config.type}</span>
            </div>
            {server.config.command && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">Cmd:</span>
                <span className="font-mono text-[10px] break-all">
                  {server.config.command}
                  {server.config.args?.length ? ` ${server.config.args.join(" ")}` : ""}
                </span>
              </div>
            )}
            {server.config.url && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">URL:</span>
                <span className="font-mono text-[10px] break-all">{server.config.url}</span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Scope:</span>
              <span>{server.scope}</span>
            </div>
          </div>
          {server.error && (
            <div className="text-[11px] text-cc-error bg-cc-error/5 rounded px-2 py-1">{server.error}</div>
          )}
          {server.tools && server.tools.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-cc-muted uppercase tracking-wider">Tools ({server.tools.length})</span>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((tool) => (
                  <span key={tool.name} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cc-hover text-cc-fg">
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Inline Lightbox Demo ───────────────────────────────────────────────────

function PlaygroundLightboxDemo() {
  const [open, setOpen] = useState(false);
  // A small gradient placeholder image — enough to demonstrate the lightbox
  const demoSrc =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#ec4899"/>' +
        "</linearGradient></defs>" +
        '<rect width="800" height="600" fill="url(#g)"/>' +
        '<text x="400" y="300" text-anchor="middle" fill="white" font-size="32" font-family="sans-serif">Full-size preview</text>' +
        "</svg>",
    );

  return (
    <div>
      <p className="text-xs text-cc-muted mb-2">Click the image below to open the lightbox:</p>
      <img
        src={demoSrc}
        alt="Lightbox demo"
        className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-zoom-in hover:opacity-80 transition-opacity border border-cc-border"
        onClick={() => setOpen(true)}
        data-testid="playground-lightbox-trigger"
      />
      {open && <Lightbox src={demoSrc} alt="Lightbox demo" onClose={() => setOpen(false)} />}
    </div>
  );
}

// ─── Inline TaskRow (avoids store dependency from TaskPanel) ────────────────

function TaskRow({ task }: { task: TaskItem }) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div className={`px-2.5 py-2 rounded-lg ${isCompleted ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 flex items-center justify-center w-4 h-4 mt-px">
          {isInProgress ? (
            <svg className="w-4 h-4 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none">
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="28"
                strokeDashoffset="8"
                strokeLinecap="round"
              />
            </svg>
          ) : isCompleted ? (
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-success">
              <path
                fillRule="evenodd"
                d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4 text-cc-muted">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </span>
        <span
          className={`text-[13px] leading-snug flex-1 ${isCompleted ? "text-cc-muted line-through" : "text-cc-fg"}`}
        >
          {task.subject}
        </span>
      </div>
      {isInProgress && task.activeForm && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted italic truncate">{task.activeForm}</p>
      )}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 shrink-0">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}</span>
        </p>
      )}
    </div>
  );
}
