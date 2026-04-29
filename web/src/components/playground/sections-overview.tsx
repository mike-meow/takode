import {
  PermissionBanner,
  PermissionsCollapsedChip,
  EvaluatingCollapsedChip,
  PlanReviewOverlay,
  PlanCollapsedChip,
} from "../PermissionBanner.js";
import { MessageBubble } from "../MessageBubble.js";
import { ChatView } from "../ChatView.js";
import { MessageFeed } from "../MessageFeed.js";
import { AttentionLedgerRow } from "../AttentionLedgerRow.js";
import { MarkdownContent } from "../MarkdownContent.js";
import { ToolBlock } from "../ToolBlock.js";
import { GitHubPRDisplay } from "../TaskPanel.js";
import { SessionStatusDot } from "../SessionStatusDot.js";
import { SessionItem } from "../SessionItem.js";
import { YarnBallDot } from "../CatIcons.js";
import { getShortcutTitle } from "../../shortcuts.js";
import {
  MOCK_MCP_SERVERS,
  MOCK_PR_DRAFT,
  MOCK_PR_FAILING,
  MOCK_PR_MERGED,
  MOCK_PR_PASSING,
  MOCK_SESSION_ID,
  MOCK_TASKS,
  MSG_APPROVED_ASK,
  MSG_APPROVED_ASK_LONG,
  MSG_APPROVED_AUTO_LONG,
  MSG_APPROVED_AUTO_SHORT,
  MSG_APPROVED_PLAN,
  MSG_ASSISTANT,
  MSG_ASSISTANT_LEADER_USER,
  MSG_ASSISTANT_THINKING,
  MSG_ASSISTANT_THINKING_CODEX,
  MSG_ASSISTANT_THINKING_CODEX_SHORT,
  MSG_ASSISTANT_TOOLS,
  MSG_COMPACT_COLLAPSED,
  MSG_COMPACT_WITH_SUMMARY,
  MSG_DENIED_BASH,
  MSG_DENIED_EDIT,
  MSG_ERROR_CODEX_PAYLOAD_TOO_LARGE,
  MSG_ERROR_CONTEXT_LIMIT,
  MSG_ERROR_GENERIC,
  MSG_QUEST_CLAIMED,
  MSG_QUEST_CLAIMED_MINIMAL,
  MSG_SYSTEM,
  MSG_TASK_COMPLETED,
  MSG_TOOL_ERROR,
  MSG_USER,
  MSG_USER_AGENT,
  MSG_USER_IMAGE,
  MSG_USER_MARKDOWN,
  MSG_USER_SELECTION,
  PERM_ASK_MULTI,
  PERM_ASK_SINGLE,
  PERM_BASH,
  PERM_BASH_NO_SUGGESTIONS,
  PERM_DYNAMIC,
  PERM_EDIT,
  PERM_EDIT_PATCH,
  PERM_EVALUATING_BASH,
  PERM_EVALUATING_BASH_LONG,
  PERM_EVALUATING_EDIT,
  PERM_EXIT_PLAN,
  PERM_GENERIC,
  PERM_GLOB,
  PERM_GREP,
  PERM_QUEUED_BASH,
  PERM_READ,
  PERM_WRITE,
  PLAYGROUND_BROKEN_SESSION_ID,
  PLAYGROUND_CODEX_PENDING_SESSION_ID,
  PLAYGROUND_CODEX_TERMINAL_SESSION_ID,
  PLAYGROUND_HERD_GROUP_THEMES,
  PLAYGROUND_LOADING_SESSION_ID,
  PLAYGROUND_RECOVERING_SESSION_ID,
  PLAYGROUND_RESUMING_SESSION_ID,
  PLAYGROUND_REVIEWER_MAP,
  PLAYGROUND_SECTIONED_SESSION_ID,
  PLAYGROUND_SESSION_ROWS,
  PLAYGROUND_STARTING_SESSION_ID,
  PLAYGROUND_THREAD_PANEL_SESSION_ID,
} from "./fixtures.js";
import {
  Card,
  CODEX_DEMO_SESSION,
  Section,
  CodexPlaygroundDemo,
  PlaygroundCompletedViewImageTool,
  PlaygroundHerdSummaryBar,
  PlaygroundLightboxDemo,
  PlaygroundMcpRow,
  PlaygroundAddressedNotifyToolBlock,
  PlaygroundNeedsInputReminderMessage,
  PlaygroundThreadRoutingReminderMessage,
  PlaygroundSectionGroup,
  TaskRow,
} from "./shared.js";
import type { SessionAttentionRecord } from "../../types.js";

const ATTENTION_LEDGER_RECORDS: SessionAttentionRecord[] = [
  {
    id: "playground-attention-unresolved",
    leaderSessionId: MOCK_SESSION_ID,
    type: "needs_input",
    source: { kind: "notification", id: "playground-attention-unresolved" },
    questId: "q-961",
    threadKey: "q-961",
    title: "Approve the implementation direction",
    summary: "Worker is waiting for a concrete user decision before continuing.",
    actionLabel: "Answer",
    priority: "needs_input",
    state: "unresolved",
    createdAt: 100,
    updatedAt: 100,
    route: { threadKey: "q-961", questId: "q-961", messageId: "playground-thread-q961-assistant" },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: "playground-attention-unresolved",
  },
  {
    id: "playground-attention-resolved",
    leaderSessionId: MOCK_SESSION_ID,
    type: "review_ready",
    source: { kind: "notification", id: "playground-attention-resolved" },
    questId: "q-962",
    threadKey: "q-962",
    title: "Review accepted",
    summary: "The review item remains visible in the ledger as handled history.",
    actionLabel: "Review",
    priority: "review",
    state: "resolved",
    createdAt: 200,
    updatedAt: 220,
    resolvedAt: 220,
    route: { threadKey: "q-962", questId: "q-962" },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: "playground-attention-resolved",
  },
  {
    id: "playground-attention-dismissed",
    leaderSessionId: MOCK_SESSION_ID,
    type: "blocked_user_resolvable",
    source: { kind: "manual", id: "playground-attention-dismissed" },
    questId: "q-963",
    threadKey: "q-963",
    title: "External unblock dismissed",
    summary: "Dismissal hides active attention without claiming the blocker is solved.",
    actionLabel: "Unblock",
    priority: "blocked",
    state: "dismissed",
    createdAt: 300,
    updatedAt: 330,
    dismissedAt: 330,
    route: { threadKey: "q-963", questId: "q-963" },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: "playground-attention-dismissed",
  },
  {
    id: "playground-attention-reopened",
    leaderSessionId: MOCK_SESSION_ID,
    type: "quest_reopened_or_rework",
    source: { kind: "quest", id: "q-964", questId: "q-964" },
    questId: "q-964",
    threadKey: "q-964",
    title: "Fresh feedback reopened q-964",
    summary: "A previously handled thread is attention-worthy again after new feedback.",
    actionLabel: "Open",
    priority: "milestone",
    state: "reopened",
    createdAt: 400,
    updatedAt: 430,
    reopenedAt: 430,
    route: { threadKey: "q-964", questId: "q-964" },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: "playground-attention-reopened",
  },
];

export function PlaygroundOverviewSections() {
  return (
    <PlaygroundSectionGroup groupId="overview">
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
          <EvaluatingCollapsedChip permission={PERM_EVALUATING_BASH} sessionId={MOCK_SESSION_ID} onExpand={() => {}} />
        </Card>
        <Card label="Bash — evaluating (long cmd)">
          <EvaluatingCollapsedChip
            permission={PERM_EVALUATING_BASH_LONG}
            sessionId={MOCK_SESSION_ID}
            onExpand={() => {}}
          />
        </Card>
        <Card label="Edit — evaluating">
          <EvaluatingCollapsedChip permission={PERM_EVALUATING_EDIT} sessionId={MOCK_SESSION_ID} onExpand={() => {}} />
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
        title="Leader Workboard Thread Navigation"
        description="Leader ChatView with top workboard-owned Main / All Threads / quest navigation, quest-thread banner context, and composer access below the feed."
      >
        <div className="grid max-w-5xl gap-4 lg:grid-cols-2">
          <div className="overflow-hidden rounded-xl border border-cc-border bg-cc-card h-[460px]">
            <ChatView sessionId={PLAYGROUND_THREAD_PANEL_SESSION_ID} />
          </div>
          <div className="overflow-hidden rounded-xl border border-cc-border bg-cc-card h-[460px]">
            <ChatView sessionId={PLAYGROUND_THREAD_PANEL_SESSION_ID} />
          </div>
        </div>
      </Section>

      <Section
        title="Search Preview Chat"
        description="Read-only right-pane preview shown while navigating global-search results before Enter commits selection."
      >
        <div className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[420px]">
          <ChatView sessionId={MOCK_SESSION_ID} preview />
        </div>
      </Section>

      <Section title="Shortcut Hints" description="Hover helper titles for the first shortcut-enabled chat controls.">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            title={getShortcutTitle(
              "Global search",
              { enabled: true, preset: "standard", overrides: {} },
              "global_search",
              "MacIntel",
            )}
            className="px-3 py-2 rounded-lg bg-cc-hover text-sm text-cc-fg"
          >
            Global Search
          </button>
          <button
            type="button"
            title={getShortcutTitle(
              "Search messages",
              { enabled: true, preset: "standard", overrides: {} },
              "search_session",
              "MacIntel",
            )}
            className="px-3 py-2 rounded-lg bg-cc-hover text-sm text-cc-fg"
          >
            Search
          </button>
          <button
            type="button"
            title={getShortcutTitle(
              "New session",
              { enabled: true, preset: "standard", overrides: {} },
              "new_session",
              "MacIntel",
            )}
            className="px-3 py-2 rounded-lg bg-cc-hover text-sm text-cc-fg"
          >
            New Session
          </button>
          <button
            type="button"
            title={getShortcutTitle(
              "Toggle sidebar",
              { enabled: true, preset: "standard", overrides: {} },
              "toggle_sidebar",
              "MacIntel",
            )}
            className="px-3 py-2 rounded-lg bg-cc-hover text-sm text-cc-fg"
          >
            Sidebar
          </button>
          <button
            type="button"
            title={getShortcutTitle(
              "Terminal",
              { enabled: true, preset: "standard", overrides: {} },
              "open_terminal",
              "MacIntel",
            )}
            className="px-3 py-2 rounded-lg bg-cc-hover text-sm text-cc-fg"
          >
            Terminal
          </button>
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
        title="Thread Projections"
        description="Main shows staging activity, grouped hidden activity markers, and attachment markers; All Threads preserves the global view; quest projections keep attached context with routed activity."
      >
        <div className="grid gap-4 xl:grid-cols-3">
          <Card label="Main">
            <div className="h-[280px] overflow-hidden rounded-xl border border-cc-border bg-cc-card">
              <MessageFeed sessionId={PLAYGROUND_THREAD_PANEL_SESSION_ID} threadKey="main" />
            </div>
          </Card>
          <Card label="All Threads">
            <div className="h-[280px] overflow-hidden rounded-xl border border-cc-border bg-cc-card">
              <MessageFeed sessionId={PLAYGROUND_THREAD_PANEL_SESSION_ID} threadKey="all" />
            </div>
          </Card>
          <Card label="Quest Thread">
            <div className="h-[280px] overflow-hidden rounded-xl border border-cc-border bg-cc-card">
              <MessageFeed sessionId={PLAYGROUND_THREAD_PANEL_SESSION_ID} threadKey="q-961" />
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="Attention Ledger Rows"
        description="Main attention rows keep active, resolved, dismissed, and reopened user-actionable events visible without turning routine hidden activity into a timeline."
      >
        <Card label="Main ledger states">
          <div className="space-y-2">
            {ATTENTION_LEDGER_RECORDS.map((record) => (
              <AttentionLedgerRow key={record.id} record={record} sessionId={PLAYGROUND_THREAD_PANEL_SESSION_ID} />
            ))}
          </div>
        </Card>
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
        description="Live Codex Bash commands sit in a reserved bottom band so they do not cover chat text. Click a chip to open the draggable, resizable transcript inspector; completed live shells keep a small badge plus the captured transcript in the inline Bash card when the final tool result is empty."
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
        title="Codex Image Send States"
        description="Image-backed Codex turns keep upload and backend-processing feedback in the floating purring chip, then fall back to the normal purring label as soon as response streaming starts."
      >
        <div className="space-y-4">
          <Card label="Pending local upload bubble">
            <div className="max-w-3xl border border-cc-border rounded-xl overflow-hidden bg-cc-card p-4">
              <div className="flex justify-end">
                <div className="max-w-[85%] sm:max-w-[80%] sm:min-w-[200px] px-3 sm:px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                  <div className="flex gap-2 flex-wrap mb-2">
                    <img
                      src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z1WQAAAAASUVORK5CYII="
                      alt="attachment-1.png"
                      className="max-w-[150px] sm:max-w-[200px] max-h-[120px] sm:max-h-[150px] rounded-lg object-cover"
                    />
                  </div>
                  <div className="mb-2 text-[11px] text-cc-muted/80 font-mono-code">Uploading image…</div>
                  <div className="text-sm">Compare this screenshot with the current mobile header state.</div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="ChatView Recovery States"
        description="Startup, recovery, resume, and broken-session banners shown by ChatView before the main message feed is usable."
      >
        <div className="space-y-4">
          <Card label="Fresh session starting">
            <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[260px]">
              <ChatView sessionId={PLAYGROUND_STARTING_SESSION_ID} />
            </div>
          </Card>
          <Card label="Codex session recovering">
            <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card h-[260px]">
              <ChatView sessionId={PLAYGROUND_RECOVERING_SESSION_ID} />
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
          <Card label="User message with Markdown (conservative subset)">
            <MessageBubble message={MSG_USER_MARKDOWN} />
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
          <Card label="Needs-input reminder (resolved, compact by default)">
            <PlaygroundNeedsInputReminderMessage variant="resolved" />
          </Card>
          <Card label="Needs-input reminder (active, details visible)">
            <PlaygroundNeedsInputReminderMessage variant="active" />
          </Card>
          <Card label="Needs-input reminder (partial, details visible)">
            <PlaygroundNeedsInputReminderMessage variant="partial" />
          </Card>
          <Card label="Thread-routing reminder">
            <PlaygroundThreadRoutingReminderMessage />
          </Card>
          <Card label="Assistant message (markdown)">
            <MessageBubble message={MSG_ASSISTANT} />
          </Card>
          <Card label="Assistant message (explicit leader user-message)">
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
          <Card label="Error — Codex payload too large (with /compact guidance)">
            <MessageBubble message={MSG_ERROR_CODEX_PAYLOAD_TOO_LARGE} sessionId={CODEX_DEMO_SESSION} />
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
        description="Copy-to-clipboard for code blocks in markdown and tool calls (hover to reveal), plus user/assistant message menus with copy-link support"
      >
        <div className="space-y-4 max-w-3xl">
          <Card label="Code block in markdown — hover to reveal copy button">
            <MarkdownContent
              text={
                'Here is some code:\n\n```typescript\nconst greeting = "Hello, world!";\nconsole.log(greeting);\n```\n\nAnd a block without a language tag:\n\n```\nnpm install\nnpm run build\n```\n\nPlain quest/session refs: q-42 and #5\nQuest link example: [q-42](quest:q-42)\nSession link example: [#5](session:5)\nSession message link example: [#5 msg 42](session:5:42)\nRelative file link example: [TopBar.tsx:162](file:web/src/components/TopBar.tsx:162)'
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
          <Card label="Assistant message — hover for copy and copy-link menu">
            <MessageBubble message={MSG_ASSISTANT} sessionId="playground-copy" />
          </Card>
          <Card label="User message — hover for message options including copy link">
            <MessageBubble message={MSG_USER} sessionId="playground-copy" />
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
          <Card label="Tool result image preview — click to open lightbox">
            <ToolBlock
              name="Read"
              input={{ file_path: "/Users/dev/project/docs/screenshot.png" }}
              toolUseId="tb-image-lightbox"
              sessionId={MOCK_SESSION_ID}
            />
          </Card>
        </div>
      </Section>

      <Section
        title="Markdown Tables"
        description="Markdown tables keep their inline scrollable layout, with a table-specific View table action that opens a wider overlay."
      >
        <div className="space-y-4 max-w-4xl">
          <Card label="Wide markdown table with expanded viewer">
            <MarkdownContent
              text={`### Example Asset Mapping

| Asset Pack | Source Directory | Public Label |
| --- | --- | --- |
| Marketing hero set | /srv/demo-assets/hero-set/ | hero_images_v2 |
| Product thumbnails | /srv/demo-assets/product-thumbs/ | product_thumbs |
| Support illustrations | /srv/demo-assets/support-art/ | support_art |
| Onboarding cards | /srv/demo-assets/onboarding-cards/ | onboarding_cards |
| Release screenshots | /srv/demo-assets/release-screens/ | release_screens |
| QA fixtures | /srv/demo-assets/qa-fixtures/ | qa_fixture_bundle |`}
            />
          </Card>
        </div>
      </Section>

      {/* ─── Tool Blocks (standalone) ──────────────────────── */}
      <Section
        title="Tool Blocks"
        description="Expandable tool call chips. Edit/Write/Read show smart-truncated path + Open File button in header; diffs start collapsed."
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
          <PlaygroundCompletedViewImageTool />
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
                  path: "src/remote-workflow.ts",
                  kind: "modify",
                  diff: [
                    "diff --git a/src/remote-workflow.ts b/src/remote-workflow.ts",
                    "--- a/src/remote-workflow.ts",
                    "+++ b/src/remote-workflow.ts",
                    "@@ -35,3 +35,3 @@",
                    '-runRemote("primary")',
                    '+runRemote("primary", { clearForwarding: true })',
                  ].join("\n"),
                },
                {
                  path: "src/remote-health.ts",
                  kind: "modify",
                  diff: [
                    "diff --git a/src/remote-health.ts b/src/remote-health.ts",
                    "--- a/src/remote-health.ts",
                    "+++ b/src/remote-health.ts",
                    "@@ -12,3 +12,3 @@",
                    "-const output = checkRemote(alias);",
                    "+const output = checkRemote(alias, { clearForwarding: true });",
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
            name="Write"
            input={{
              file_path: "src/generated-from-codex.ts",
              changes: [
                {
                  path: "src/generated-from-codex.ts",
                  kind: "add",
                  content: ["export const generated = true;", 'export const source = "codex";'].join("\n"),
                },
              ],
            }}
            toolUseId="tb-4b"
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
          <ToolBlock
            name="TodoWrite"
            input={{
              todos: [
                { content: "Inspect worktree", status: "pending", activeForm: "Inspecting worktree" },
                { content: "Run focused tests", status: "pending", activeForm: "Running focused tests" },
                { content: "Report findings", status: "pending", activeForm: "Reporting findings" },
              ],
            }}
            toolUseId="tb-10-pending"
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
          <PlaygroundAddressedNotifyToolBlock />
          <ToolBlock
            name="Bash"
            input={{ command: 'takode send 17 "If this looks good, later run takode notify review"' }}
            toolUseId="tb-notify-quoted"
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

      {/* ─── Tool Block Error Boundary States ──────────────── */}
      <Section
        title="Tool Block Error Boundary"
        description="Error boundary states for ToolBlock: transient retry and permanent failure."
      >
        <div className="space-y-2 max-w-3xl">
          <Card label="Outer boundary — retrying (transient)">
            <div className="text-[11px] text-cc-error/80 bg-cc-error/5 border border-cc-error/20 rounded-[10px] px-3 py-2.5">
              <span className="font-medium">Failed to render tool block</span>
              <span className="text-cc-muted ml-1">
                (Minified React error #185; visit https://react.dev/errors/185 for the full message.)
                {" -- retrying..."}
              </span>
            </div>
          </Card>
          <Card label="Outer boundary — permanent (after 3 retries)">
            <div className="text-[11px] text-cc-error/80 bg-cc-error/5 border border-cc-error/20 rounded-[10px] px-3 py-2.5">
              <span className="font-medium">Failed to render tool block</span>
              <span className="text-cc-muted ml-1">
                (Minified React error #185; visit https://react.dev/errors/185 for the full message.)
              </span>
            </div>
          </Card>
          <Card label="Inner boundary — retrying (content error)">
            <div className="text-[11px] text-cc-error/80 bg-cc-error/5 border border-cc-error/20 rounded-md px-3 py-2">
              <span className="font-medium">Failed to render tool content</span>
              <span className="text-cc-muted ml-1">
                (Cannot read properties of undefined)
                {" -- retrying..."}
              </span>
            </div>
          </Card>
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
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
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
                <SessionStatusDot archived={false} permCount={0} isConnected={false} sdkState="exited" status={null} />
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
        description="Leader and worker pills share a herd-group color, and the leading row shows the idle-with-timer status icon sourced from the real sidebar timer store."
      >
        <div className="max-w-md">
          <Card label="Session list pills">
            <div className="space-y-1 rounded-xl bg-cc-sidebar p-2">
              {PLAYGROUND_SESSION_ROWS.filter(({ session }) => session.reviewerOf === undefined).map(
                ({ session, sessionName, preview }, index) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={index === 0}
                    sessionName={sessionName}
                    sessionPreview={preview}
                    permCount={session.permCount}
                    isRecentlyRenamed={false}
                    reviewerSession={
                      session.sessionNum != null ? PLAYGROUND_REVIEWER_MAP.get(session.sessionNum) : undefined
                    }
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
                    useStatusBar
                  />
                ),
              )}
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="Herd Collapsible Container"
        description="In tree view, herded sessions are wrapped in a collapsible container. Leader renders at full width with no indentation. Workers appear inside the container when expanded."
      >
        <div className="max-w-md space-y-3">
          <Card label="Collapsed herd container (default)">
            <div className="space-y-0.5 rounded-xl bg-cc-sidebar p-2">
              <div className="border border-cc-border/40 rounded-lg overflow-hidden bg-cc-card/20">
                {/* Leader chip */}
                <SessionItem
                  session={PLAYGROUND_SESSION_ROWS[0].session}
                  isActive={false}
                  sessionName={PLAYGROUND_SESSION_ROWS[0].sessionName}
                  sessionPreview={PLAYGROUND_SESSION_ROWS[0].preview}
                  permCount={0}
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
                  herdGroupBadgeTheme={PLAYGROUND_HERD_GROUP_THEMES.get(PLAYGROUND_SESSION_ROWS[0].session.id)}
                />
                {/* Herd summary bar */}
                <PlaygroundHerdSummaryBar isExpanded={false} />
              </div>
            </div>
          </Card>

          <Card label="Expanded herd container">
            <div className="space-y-0.5 rounded-xl bg-cc-sidebar p-2">
              <div className="border border-cc-border/40 rounded-lg overflow-hidden bg-cc-card/20">
                {/* Leader chip */}
                <SessionItem
                  session={PLAYGROUND_SESSION_ROWS[0].session}
                  isActive={false}
                  sessionName={PLAYGROUND_SESSION_ROWS[0].sessionName}
                  sessionPreview={PLAYGROUND_SESSION_ROWS[0].preview}
                  permCount={0}
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
                  herdGroupBadgeTheme={PLAYGROUND_HERD_GROUP_THEMES.get(PLAYGROUND_SESSION_ROWS[0].session.id)}
                />
                {/* Herd summary bar (expanded) */}
                <PlaygroundHerdSummaryBar isExpanded={true} />
                {/* Workers container */}
                <div className="border-t border-cc-border/30">
                  {PLAYGROUND_SESSION_ROWS.filter(({ session }) => session.herdedBy && session.reviewerOf === undefined)
                    .slice(0, 3)
                    .map(({ session, sessionName, preview }) => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        isActive={false}
                        sessionName={sessionName}
                        sessionPreview={preview}
                        permCount={session.permCount}
                        isRecentlyRenamed={false}
                        compact
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
                  {/* Collapse footer */}
                  <div className="w-full flex items-center justify-center gap-1 px-2 py-0.5 text-[10px] text-cc-muted/40">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0">
                      <path d="M4 10l4-4 4 4" />
                    </svg>
                    <span>Collapse</span>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card label="Standalone session (no herd container)">
            <div className="space-y-0.5 rounded-xl bg-cc-sidebar p-2">
              <SessionItem
                session={{
                  ...PLAYGROUND_SESSION_ROWS[3].session,
                  id: "standalone-demo",
                  isOrchestrator: false,
                  herdedBy: undefined,
                  sessionNum: 42,
                }}
                isActive={false}
                sessionName="Standalone Session"
                sessionPreview="Not part of any herd -- no container wrapping."
                permCount={0}
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
              />
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="Quest Title Styling"
        description="Quest-named sessions show a checkbox prefix: ☐ for in-progress, ☑ for needs-verification."
      >
        <div className="max-w-md">
          <Card label="In-progress vs completed quest titles">
            <div className="space-y-1 rounded-xl bg-cc-sidebar p-2">
              {PLAYGROUND_SESSION_ROWS.filter(({ session }) => session.id.startsWith("quest-")).map(
                ({ session, sessionName, preview }) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={false}
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
                  />
                ),
              )}
            </div>
          </Card>
        </div>
      </Section>
    </PlaygroundSectionGroup>
  );
}
