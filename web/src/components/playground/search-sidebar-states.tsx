import { useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { UniversalSearchOverlay } from "../UniversalSearchOverlay.js";
import { TreeViewGroup } from "../TreeViewGroup.js";
import type { MessageSearchResponse } from "../../api.js";
import type { ChatMessage, SdkSessionInfo } from "../../types.js";
import type { SidebarSessionItem } from "../../utils/sidebar-session-item.js";
import type { TreeViewGroupData } from "../../utils/tree-grouping.js";
import { Card, Section } from "./shared.js";

const PLAYGROUND_UNIVERSAL_SESSIONS: SdkSessionInfo[] = [
  {
    sessionId: "playground-universal",
    state: "connected",
    cwd: "/repo/takode",
    createdAt: Date.now() - 15 * 60_000,
    lastActivityAt: Date.now() - 2 * 60_000,
    name: "Universal search implementation",
    backendType: "codex",
    gitBranch: "feature/universal-search",
    sessionNum: 1277,
    isOrchestrator: true,
  },
  {
    sessionId: "playground-review",
    state: "connected",
    cwd: "/repo/takode",
    createdAt: Date.now() - 2 * 60 * 60_000,
    lastActivityAt: Date.now() - 35 * 60_000,
    name: "Review search overlay states",
    backendType: "claude",
    gitBranch: "review/sidebar-overflow",
    sessionNum: 1278,
  },
];

const PLAYGROUND_UNIVERSAL_MESSAGE_RESPONSE: MessageSearchResponse = {
  sessionId: "playground-universal",
  sessionNum: 1277,
  query: "search",
  scope: { kind: "current_thread", threadKey: "main", label: "Searching in #1277 Main" },
  filters: { user: true, assistant: false, event: false },
  totalMatches: 2,
  nextOffset: null,
  hasMore: false,
  tookMs: 2,
  results: [
    {
      id: "playground-universal:0:universal-user-new",
      sessionId: "playground-universal",
      sessionNum: 1277,
      messageId: "universal-user-new",
      historyIndex: 0,
      role: "user",
      category: "user",
      timestamp: Date.now() - 2 * 60_000,
      snippet: "Can you make the universal search overlay keyboard efficient and mode scoped?",
      routeThreadKey: "main",
      sourceThreadKey: "main",
      sourceLabel: "Main",
    },
    {
      id: "playground-universal:3:universal-user-old",
      sessionId: "playground-universal",
      sessionNum: 1277,
      messageId: "universal-user-old",
      historyIndex: 3,
      role: "user",
      category: "user",
      timestamp: Date.now() - 30 * 60_000,
      snippet: "Default message mode should show recent user messages when the query is empty.",
      routeThreadKey: "main",
      sourceThreadKey: "main",
      sourceLabel: "Main",
    },
  ],
};

const PLAYGROUND_UNIVERSAL_MESSAGES: ChatMessage[] = [
  {
    id: "universal-user-new",
    role: "user",
    content: "Can you make the universal search overlay keyboard efficient and mode scoped?",
    timestamp: Date.now() - 2 * 60_000,
  },
  {
    id: "universal-assistant",
    role: "assistant",
    content: "Implemented the overlay with quest, session, and message modes.",
    timestamp: Date.now() - 90_000,
  },
  {
    id: "universal-user-old",
    role: "user",
    content: "Default message mode should show recent user messages when the query is empty.",
    timestamp: Date.now() - 30 * 60_000,
  },
];

function makeSidebarSession(
  id: string,
  index: number,
  overrides: Partial<SidebarSessionItem> = {},
): SidebarSessionItem {
  return {
    id,
    model: "gpt-5.5",
    cwd: "/repo/takode",
    gitBranch: index % 2 === 0 ? "feature/sidebar-overflow" : "main-wt-3498",
    isContainerized: false,
    gitAhead: index % 2,
    gitBehind: 0,
    linesAdded: index * 3,
    linesRemoved: index,
    isConnected: index < 4,
    status: index === 1 ? "running" : "idle",
    sdkState: index === 1 ? "running" : "connected",
    createdAt: Date.now() - index * 20 * 60_000,
    archived: false,
    backendType: index % 2 === 0 ? "codex" : "claude",
    repoRoot: "/repo/takode",
    permCount: index === 2 ? 1 : 0,
    lastActivityAt: Date.now() - index * 5 * 60_000,
    lastUserMessageAt: Date.now() - index * 6 * 60_000,
    sessionNum: 1280 + index,
    ...overrides,
  };
}

const PLAYGROUND_OVERFLOW_SESSIONS = [
  makeSidebarSession("overflow-plan", 0),
  makeSidebarSession("overflow-implement", 1),
  makeSidebarSession("overflow-review", 2),
  makeSidebarSession("overflow-e2e", 3),
  makeSidebarSession("overflow-docs", 4),
  makeSidebarSession("overflow-followup", 5),
];

const PLAYGROUND_OVERFLOW_NAMES = new Map([
  ["overflow-plan", "Plan sidebar overflow"],
  ["overflow-implement", "Implement group folding"],
  ["overflow-review", "Review group drag order"],
  ["overflow-e2e", "Validate search jump"],
  ["overflow-docs", "Refresh phase notes"],
  ["overflow-followup", "Track follow-up polish"],
]);

const PLAYGROUND_OVERFLOW_GROUP: TreeViewGroupData = {
  id: "playground-overflow",
  name: "Quest Workers",
  nodes: PLAYGROUND_OVERFLOW_SESSIONS.map((session) => ({ leader: session, workers: [], reviewers: [] })),
  runningCount: 1,
  permCount: 1,
  unreadCount: 0,
};

const EMPTY_STRING_MAP = new Map<string, string>();
const EMPTY_PERMISSION_MAP = new Map<string, Map<string, unknown>>();
const EMPTY_STRING_SET = new Set<string>();

function PlaygroundSidebarOverflowGroup({ expanded }: { expanded: boolean }) {
  const editInputRef = useRef<HTMLInputElement>(null);
  const collapsedTreeNodes = useMemo(() => new Set<string>(), []);
  const noop = () => {};
  const noopMouse = (_event: ReactMouseEvent, _id: string) => {};

  return (
    <DndContext collisionDetection={closestCenter}>
      <div className="max-w-sm rounded-lg border border-cc-border/70 bg-cc-sidebar/70 p-2">
        <TreeViewGroup
          group={PLAYGROUND_OVERFLOW_GROUP}
          isGroupCollapsed={false}
          collapsedTreeNodes={collapsedTreeNodes}
          onToggleGroupCollapse={noop}
          onToggleNodeCollapse={noop}
          onCreateSession={noop}
          currentSessionId="overflow-implement"
          sessionNames={PLAYGROUND_OVERFLOW_NAMES}
          sessionPreviews={EMPTY_STRING_MAP}
          pendingPermissions={EMPTY_PERMISSION_MAP}
          recentlyRenamed={EMPTY_STRING_SET}
          onSelect={noop}
          onStartRename={noop}
          onArchive={noopMouse}
          onUnarchive={noopMouse}
          onDelete={noopMouse}
          onClearRecentlyRenamed={noop}
          editingSessionId={null}
          editingName=""
          setEditingName={noop}
          onConfirmRename={noop}
          onCancelRename={noop}
          editInputRef={editInputRef}
          isFirst
          visibleSessionLimit={3}
          overflowExpanded={expanded}
          onToggleOverflow={noop}
          onSetVisibleSessionLimit={noop}
        />
      </div>
    </DndContext>
  );
}

export function PlaygroundUniversalSearchStates() {
  return (
    <Section
      title="Universal Search"
      description="App-level command palette for mode-scoped quest, session, and current-session message search."
    >
      <div className="space-y-4">
        <Card label="Overlay with current-session message mode">
          <UniversalSearchOverlay
            open
            presentation="inline"
            currentSessionId="playground-universal"
            currentThreadKey="main"
            sessions={PLAYGROUND_UNIVERSAL_SESSIONS}
            messages={PLAYGROUND_UNIVERSAL_MESSAGES}
            leaderSessionId="playground-universal"
            messageSearchPreviewResponse={PLAYGROUND_UNIVERSAL_MESSAGE_RESPONSE}
            onClose={() => {}}
            onOpenQuest={() => {}}
            onOpenMessage={() => {}}
          />
        </Card>
        <Card label="Overlay with Session mode results">
          <UniversalSearchOverlay
            open
            presentation="inline"
            initialMode="sessions"
            initialQuery="review"
            currentSessionId="playground-universal"
            currentThreadKey="main"
            sessions={PLAYGROUND_UNIVERSAL_SESSIONS}
            messages={PLAYGROUND_UNIVERSAL_MESSAGES}
            leaderSessionId="playground-universal"
            onClose={() => {}}
            onOpenQuest={() => {}}
            onOpenMessage={() => {}}
          />
        </Card>
        <Card label="Overlay outside a session">
          <UniversalSearchOverlay
            open
            presentation="inline"
            currentSessionId={null}
            currentThreadKey={null}
            sessions={PLAYGROUND_UNIVERSAL_SESSIONS}
            messages={[]}
            onClose={() => {}}
            onOpenQuest={() => {}}
            onOpenMessage={() => {}}
          />
        </Card>
      </div>
    </Section>
  );
}

export function PlaygroundSidebarOverflowStates() {
  return (
    <Section
      title="Sidebar Group Overflow"
      description="Folded and expanded Session Space states for groups that exceed their visible session limit."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card label="Folded group with overflow control">
          <PlaygroundSidebarOverflowGroup expanded={false} />
        </Card>
        <Card label="Expanded group with collapse control">
          <PlaygroundSidebarOverflowGroup expanded />
        </Card>
      </div>
    </Section>
  );
}
