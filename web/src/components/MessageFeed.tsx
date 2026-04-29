import {
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useState,
  useCallback,
  memo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useStore } from "../store.js";
import { CodexThinkingInline, HerdEventMessage, MessageBubble, isEmptyAssistantMessage } from "./MessageBubble.js";
import { EVENT_HEADER_RE, HERD_CHIP_BASE, HERD_CHIP_INTERACTIVE } from "../utils/herd-event-parser.js";
import { ToolBlock, getPreview, getToolIcon, getToolLabel, ToolIcon, formatDuration } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CollapseFooter, TurnCollapseFooter } from "./CollapseFooter.js";
import { api } from "../api.js";
import { ElapsedTimer, FeedStatusPill, PendingCodexInputList, PendingUserUploadList } from "./MessageFeedStatus.js";
import { FeedFooter, TurnEntries, findPreviousSectionStartIndex } from "./MessageFeedEntries.js";
import { SAVE_THREAD_VIEWPORT_EVENT } from "../utils/thread-viewport.js";
import {
  CodexTerminalInspector,
  LiveCodexTerminalStub,
  LiveDurationBadge,
  LiveActivityRail,
  collectCodexTerminalEntries,
  collectLiveSubagentEntries,
  getCodexTerminalRevealAt,
  getLiveSubagentRevealAt,
  type CodexTerminalEntry,
  type LiveSubagentEntry,
} from "./MessageFeedLiveActivity.js";
import {
  DEFAULT_VISIBLE_SECTION_COUNT,
  FEED_SECTION_TURN_COUNT,
  buildFeedSections,
  findActiveTaskTurnIdForScroll,
  findSectionWindowStartIndexForTarget,
  findVisibleSectionEndIndex,
  findVisibleSectionStartIndex,
  type FeedSection,
  type TurnOffsetIndex,
} from "./message-feed-sections.js";
import {
  EMPTY_MESSAGES,
  EMPTY_PENDING_CODEX_INPUTS,
  EMPTY_PENDING_USER_UPLOADS,
  collectFeedBlockIdsFromNode,
  escapeSelectorValue,
  formatElapsed,
  buildMinuteBoundaryLabelMap,
  getApprovalBatchFeedBlockId,
  getFooterFeedBlockId,
  getMessageFeedBlockId,
  getSubagentFeedBlockId,
  getToolGroupFeedBlockId,
  getTurnFeedBlockId,
  appendTimedMessagesFromEntries,
  isTimedChatMessage,
} from "./message-feed-utils.js";
import { isSubagentToolName } from "../types.js";
import {
  collectMessageToolUseIds,
  filterMessagesForThread,
  isAllThreadsKey,
  isMainThreadKey,
} from "../utils/thread-projection.js";
import { YarnBallDot, YarnBallSpinner, SleepingCat } from "./CatIcons.js";
import { PawTrailAvatar, PawCounterContext, PawScrollProvider, HidePawContext } from "./PawTrail.js";
import { isTouchDevice } from "../utils/mobile.js";
import { sendToSession } from "../ws.js";
import { useCollapsePolicy } from "../hooks/use-collapse-policy.js";
import { useTextSelection } from "../hooks/useTextSelection.js";
import { SelectionContextMenu } from "./SelectionContextMenu.js";
import { getHistoryWindowTurnCount } from "../../shared/history-window.js";
import { collectAnchoredNotificationMessageIds } from "../utils/anchored-notifications.js";
import {
  isUserBoundaryEntry,
  useFeedModel,
  type FeedEntry,
  type SubagentBatch,
  type SubagentGroup,
  type ToolMsgGroup,
  type Turn,
  type TurnStats,
} from "../hooks/use-feed-model.js";

export { ElapsedTimer };
export {
  buildFeedSections,
  findActiveTaskTurnIdForScroll,
  findSectionWindowStartIndexForTarget,
  findVisibleSectionEndIndex,
  findVisibleSectionStartIndex,
};

const LIVE_ACTIVITY_RAIL_DWELL_MS = 5_000;
const FEED_EXTRA_SCROLL_SLACK_PX = 12;
const FLOATING_STATUS_SPACER_MARGIN_PX = 4;
const FLOATING_STATUS_MOBILE_BOTTOM_PX = 8;
const MOBILE_NAV_BASE_BOTTOM_PX = 12;
const MOBILE_NAV_STATUS_CLEARANCE_GAP_PX = 8;
const CODEX_TERMINAL_INSPECTOR_MARGIN_PX = 16;
const CODEX_TERMINAL_INSPECTOR_MIN_WIDTH_PX = 320;
const CODEX_TERMINAL_INSPECTOR_MIN_HEIGHT_PX = 240;
const CODEX_TERMINAL_INSPECTOR_DEFAULT_WIDTH_PX = 512;
const CODEX_TERMINAL_INSPECTOR_DEFAULT_HEIGHT_PX = 360;

type CodexTerminalInspectorViewport = {
  width: number;
  height: number;
};

type CodexTerminalInspectorLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CodexTerminalInspectorInteraction = {
  mode: "drag" | "resize";
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLayout: CodexTerminalInspectorLayout;
};

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function getCodexTerminalInspectorViewport(element: HTMLElement | null): CodexTerminalInspectorViewport | null {
  if (!element) return null;
  const width = Math.round(element.clientWidth || element.getBoundingClientRect().width);
  const height = Math.round(element.clientHeight || element.getBoundingClientRect().height);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function clampCodexTerminalInspectorLayout(
  layout: CodexTerminalInspectorLayout,
  viewport: CodexTerminalInspectorViewport,
): CodexTerminalInspectorLayout {
  const maxWidth = Math.max(180, viewport.width - CODEX_TERMINAL_INSPECTOR_MARGIN_PX * 2);
  const maxHeight = Math.max(180, viewport.height - CODEX_TERMINAL_INSPECTOR_MARGIN_PX * 2);
  const minWidth = Math.min(CODEX_TERMINAL_INSPECTOR_MIN_WIDTH_PX, maxWidth);
  const minHeight = Math.min(CODEX_TERMINAL_INSPECTOR_MIN_HEIGHT_PX, maxHeight);
  const width = clampNumber(layout.width, minWidth, maxWidth);
  const height = clampNumber(layout.height, minHeight, maxHeight);
  const x = clampNumber(
    layout.x,
    CODEX_TERMINAL_INSPECTOR_MARGIN_PX,
    viewport.width - CODEX_TERMINAL_INSPECTOR_MARGIN_PX - width,
  );
  const y = clampNumber(
    layout.y,
    CODEX_TERMINAL_INSPECTOR_MARGIN_PX,
    viewport.height - CODEX_TERMINAL_INSPECTOR_MARGIN_PX - height,
  );
  return { x, y, width, height };
}

function createDefaultCodexTerminalInspectorLayout(
  viewport: CodexTerminalInspectorViewport,
): CodexTerminalInspectorLayout {
  return clampCodexTerminalInspectorLayout(
    {
      x: CODEX_TERMINAL_INSPECTOR_MARGIN_PX,
      y: viewport.height - CODEX_TERMINAL_INSPECTOR_MARGIN_PX - CODEX_TERMINAL_INSPECTOR_DEFAULT_HEIGHT_PX,
      width: CODEX_TERMINAL_INSPECTOR_DEFAULT_WIDTH_PX,
      height: CODEX_TERMINAL_INSPECTOR_DEFAULT_HEIGHT_PX,
    },
    viewport,
  );
}

// ─── Expand-on-scroll-target hook ───────────────────────────────────────────
// Used by collapsible containers (SubagentContainer, ApprovalBatchGroup,
// HerdEventBatchGroup) to auto-expand when a scroll-to-message target
// is inside them. The expandAllInTurn store signal holds the target message
// ID; if any of the container's message IDs match, it forces open.

interface FeedViewportAnchor {
  messageId: string | null;
  turnId: string | null;
  offsetTop: number;
}

// ─── Main Feed ───────────────────────────────────────────────────────────────

export function MessageFeed({
  sessionId,
  threadKey = "main",
  sectionTurnCount = FEED_SECTION_TURN_COUNT,
  latestIndicatorMode = "overlay",
  onLatestIndicatorVisibleChange,
  onJumpToLatestReady,
  onSelectThread,
}: {
  sessionId: string;
  threadKey?: string;
  sectionTurnCount?: number;
  latestIndicatorMode?: "overlay" | "external";
  onLatestIndicatorVisibleChange?: (visible: boolean) => void;
  onJumpToLatestReady?: ((scrollToLatest: (() => void) | null) => void) | undefined;
  onSelectThread?: (threadKey: string) => void;
}) {
  const allMessages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const messages = useMemo(() => filterMessagesForThread(allMessages, threadKey), [allMessages, threadKey]);
  const visibleToolUseIds = useMemo(
    () => (isMainThreadKey(threadKey) || isAllThreadsKey(threadKey) ? undefined : collectMessageToolUseIds(messages)),
    [messages, threadKey],
  );
  const pendingUserUploads = useStore((s) => s.pendingUserUploads.get(sessionId) ?? EMPTY_PENDING_USER_UPLOADS);
  const pendingCodexInputs = useStore((s) => s.pendingCodexInputs.get(sessionId) ?? EMPTY_PENDING_CODEX_INPUTS);
  const frozenCount = useStore((s) => s.messageFrozenCounts.get(sessionId) ?? 0);
  const frozenRevision = useStore((s) => s.messageFrozenRevisions.get(sessionId) ?? 0);
  const historyLoading = useStore((s) => s.historyLoading.get(sessionId) ?? false);
  const historyWindow = useStore((s) => s.historyWindows.get(sessionId) ?? null);
  const streamingText = useStore((s) => s.streaming.get(sessionId));
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const toolResults = useStore((s) => s.toolResults.get(sessionId));
  const toolStartTimestamps = useStore((s) => s.toolStartTimestamps.get(sessionId));
  const backgroundAgentNotifs = useStore((s) => s.backgroundAgentNotifs.get(sessionId));
  const sessionNotifications = useStore((s) => s.sessionNotifications.get(sessionId));
  const currentSessionStatus = useStore((s) => s.sessionStatus.get(sessionId) ?? null);
  const parentStreamingByToolUseId = useStore((s) => s.streamingByParentToolUseId.get(sessionId));
  const shouldBottomAlignNextUserMessage = useStore((s) => s.bottomAlignNextUserMessage.has(sessionId));
  const pawCounter = useRef<import("./PawTrail.js").PawCounterState>({ next: 0, cache: new Map() });
  const containerRef = useRef<HTMLDivElement>(null);
  const textSelection = useTextSelection(containerRef);
  const contentRootRef = useRef<HTMLDivElement>(null);
  // Initialize isNearBottom from saved scroll position — if the user was scrolled
  // up when they left this session, don't auto-scroll to bottom on re-mount.
  const savedScrollPos = useStore.getState().feedScrollPosition.get(sessionId);
  const autoFollowEnabledRef = useRef(savedScrollPos ? savedScrollPos.isAtBottom : true);
  const isNearBottom = useRef(savedScrollPos ? savedScrollPos.isAtBottom : true);
  const lastScrollTopRef = useRef(savedScrollPos?.scrollTop ?? 0);
  const programmaticScrollTargetRef = useRef<number | null>(null);
  const bottomAlignMessageIdRef = useRef<string | null>(null);
  const pendingChangedFeedBlockIdsRef = useRef<Set<string>>(new Set());
  const pendingAutoFollowFallbackRef = useRef(false);
  const autoFollowRafRef = useRef<number | null>(null);
  const didTrackContentRef = useRef(false);
  const lastSeenContentBottomRef = useRef<number | null>(null);
  const lastObservedContentBottomRef = useRef<number | null>(null);
  const suppressLatestPillOnRestoreRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [showLatestPill, setShowLatestPill] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [floatingStatusHeight, setFloatingStatusHeight] = useState(0);
  const [sectionWindowStart, setSectionWindowStart] = useState<number | null>(null);
  const [selectedCodexTerminalId, setSelectedCodexTerminalId] = useState<string | null>(null);
  const [dismissedSubagentChips, setDismissedSubagentChips] = useState<Map<string, string>>(new Map());
  const [liveActivityRailVersion, setLiveActivityRailVersion] = useState(0);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isTouch = useMemo(() => isTouchDevice(), []);
  const taskTurnOffsetsRef = useRef<TurnOffsetIndex[]>([]);
  const restoredSessionIdRef = useRef<string | null>(null);
  const overlayViewportRef = useRef<HTMLDivElement>(null);
  const lastViewportAnchorRef = useRef<{
    signature: string;
    wasAutoFollowing: boolean;
    anchor: FeedViewportAnchor | null;
  } | null>(null);

  const codexTerminalEntries = useMemo(
    () => (isCodexSession ? collectCodexTerminalEntries(messages, toolResults, toolProgress, toolStartTimestamps) : []),
    [isCodexSession, messages, toolProgress, toolResults, toolStartTimestamps],
  );
  const anchoredNotificationMessageIds = useMemo(
    () => collectAnchoredNotificationMessageIds(sessionNotifications),
    [sessionNotifications],
  );
  const { turns } = useFeedModel(messages, {
    leaderMode: false,
    frozenCount,
    frozenRevision,
    anchoredNotificationMessageIds,
  });
  const activeLiveSubagentEntries = useMemo(
    () =>
      collectLiveSubagentEntries(
        turns,
        currentSessionStatus,
        toolResults,
        toolProgress,
        toolStartTimestamps,
        backgroundAgentNotifs,
        parentStreamingByToolUseId,
      ),
    [
      backgroundAgentNotifs,
      currentSessionStatus,
      parentStreamingByToolUseId,
      toolProgress,
      toolResults,
      toolStartTimestamps,
      turns,
    ],
  );
  const activeCodexTerminalEntries = useMemo(
    () => codexTerminalEntries.filter((entry) => entry.result == null),
    [codexTerminalEntries],
  );
  const visibleLiveSubagentEntries = useMemo(() => {
    const now = Date.now();
    return activeLiveSubagentEntries.filter(
      (entry) =>
        getLiveSubagentRevealAt(entry, now) <= now &&
        dismissedSubagentChips.get(entry.taskToolUseId) !== entry.freshnessToken,
    );
  }, [activeLiveSubagentEntries, dismissedSubagentChips, liveActivityRailVersion]);
  const visibleCodexTerminalRailEntries = useMemo(() => {
    const now = Date.now();
    return activeCodexTerminalEntries.filter((entry) => getCodexTerminalRevealAt(entry, now) <= now);
  }, [activeCodexTerminalEntries, liveActivityRailVersion]);
  const activeCodexTerminalIds = useMemo(
    () => new Set(activeCodexTerminalEntries.map((entry) => entry.toolUseId)),
    [activeCodexTerminalEntries],
  );
  const selectedCodexTerminal = useMemo(
    () => codexTerminalEntries.find((entry) => entry.toolUseId === selectedCodexTerminalId) ?? null,
    [codexTerminalEntries, selectedCodexTerminalId],
  );
  const latestMessage = messages[messages.length - 1] ?? null;
  const mobileNavBottomOffsetPx = useMemo(
    () =>
      Math.max(
        MOBILE_NAV_BASE_BOTTOM_PX,
        floatingStatusHeight > 0
          ? FLOATING_STATUS_MOBILE_BOTTOM_PX + floatingStatusHeight + MOBILE_NAV_STATUS_CLEARANCE_GAP_PX
          : 0,
      ),
    [floatingStatusHeight],
  );
  const feedEndScrollSlack = Math.max(
    FEED_EXTRA_SCROLL_SLACK_PX,
    floatingStatusHeight > 0 ? floatingStatusHeight + FLOATING_STATUS_SPACER_MARGIN_PX : 0,
  );

  useEffect(() => {
    if (!selectedCodexTerminalId) return;
    if (codexTerminalEntries.some((entry) => entry.toolUseId === selectedCodexTerminalId)) return;
    setSelectedCodexTerminalId(null);
  }, [codexTerminalEntries, selectedCodexTerminalId]);

  useEffect(() => {
    if (activeCodexTerminalEntries.length === 0 && activeLiveSubagentEntries.length === 0) return;
    const now = Date.now();
    const pendingRevealTimes = [
      ...activeCodexTerminalEntries.map((entry) => getCodexTerminalRevealAt(entry, now)),
      ...activeLiveSubagentEntries.map((entry) => getLiveSubagentRevealAt(entry, now)),
    ].filter((revealAt) => revealAt > now);
    if (pendingRevealTimes.length === 0) return;
    const nextRevealAt = Math.min(...pendingRevealTimes);
    const timeout = setTimeout(() => {
      setLiveActivityRailVersion((version) => version + 1);
    }, nextRevealAt - now);
    return () => clearTimeout(timeout);
  }, [activeCodexTerminalEntries, activeLiveSubagentEntries]);

  const findVisibleTurnAnchor = useCallback((container: HTMLDivElement) => {
    const containerRect = container.getBoundingClientRect();
    const turns = container.querySelectorAll<HTMLElement>("[data-turn-id]");
    for (const turn of turns) {
      const rect = turn.getBoundingClientRect();
      if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
        return {
          turnId: turn.dataset.turnId ?? null,
          offsetTop: rect.top - containerRect.top,
        };
      }
    }
    return null;
  }, []);

  const findVisibleFeedAnchor = useCallback((container: HTMLDivElement): FeedViewportAnchor | null => {
    const containerRect = container.getBoundingClientRect();
    const findFirstVisible = (selector: string) => {
      const elements = container.querySelectorAll<HTMLElement>(selector);
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
          return { element, rect };
        }
      }
      return null;
    };

    const visibleMessage = findFirstVisible("[data-message-id]");
    if (visibleMessage) {
      const turn = visibleMessage.element.closest<HTMLElement>("[data-turn-id]");
      return {
        messageId: visibleMessage.element.dataset.messageId ?? null,
        turnId: turn?.dataset.turnId ?? null,
        offsetTop: visibleMessage.rect.top - containerRect.top,
      };
    }

    const visibleTurn = findFirstVisible("[data-turn-id]");
    if (!visibleTurn) return null;

    return {
      messageId: null,
      turnId: visibleTurn.element.dataset.turnId ?? null,
      offsetTop: visibleTurn.rect.top - containerRect.top,
    };
  }, []);

  const markProgrammaticScroll = useCallback((top: number) => {
    programmaticScrollTargetRef.current = top;
  }, []);

  const setContainerScrollTop = useCallback(
    (top: number) => {
      const container = containerRef.current;
      if (!container) return;
      markProgrammaticScroll(top);
      container.scrollTop = top;
      lastScrollTopRef.current = top;
    },
    [markProgrammaticScroll],
  );

  const scrollContainerTo = useCallback(
    (top: number, behavior: ScrollBehavior) => {
      const container = containerRef.current;
      if (!container) return;
      markProgrammaticScroll(top);
      container.scrollTo({ top, behavior });
      if (behavior !== "smooth") {
        lastScrollTopRef.current = top;
      }
    },
    [markProgrammaticScroll],
  );

  const getFeedBlockBottom = useCallback((container: HTMLDivElement, element: HTMLElement) => {
    const offsetBottom = element.offsetTop + element.offsetHeight;
    if (offsetBottom > 0) {
      return offsetBottom;
    }
    const containerRect = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 || rect.bottom !== containerRect.top) {
      return container.scrollTop + (rect.bottom - containerRect.top);
    }
    return container.scrollHeight;
  }, []);

  const getRealContentBottom = useCallback(() => {
    const container = containerRef.current;
    const contentRoot = contentRootRef.current;
    if (!container) return null;
    const fallbackBottom = Math.max(0, Math.round(container.scrollHeight - feedEndScrollSlack));
    if (!contentRoot) return fallbackBottom;
    const blocks = contentRoot.querySelectorAll<HTMLElement>("[data-feed-block-id]");
    if (blocks.length === 0) {
      return fallbackBottom;
    }
    let maxBottom = 0;
    for (const block of blocks) {
      maxBottom = Math.max(maxBottom, getFeedBlockBottom(container, block));
    }
    if (maxBottom >= container.scrollHeight - 1) {
      return fallbackBottom;
    }
    return Math.max(0, Math.min(fallbackBottom, Math.round(maxBottom)));
  }, [feedEndScrollSlack, getFeedBlockBottom]);

  const getLowestFeedBlockBottom = useCallback(
    (blockIds: Iterable<string>, fallbackToLatestBlock = false) => {
      const container = containerRef.current;
      const contentRoot = contentRootRef.current;
      if (!container || !contentRoot) return null;

      let maxBottom: number | null = null;
      for (const blockId of blockIds) {
        const element = contentRoot.querySelector<HTMLElement>(
          `[data-feed-block-id="${escapeSelectorValue(blockId)}"]`,
        );
        if (!element) continue;
        const bottom = getFeedBlockBottom(container, element);
        maxBottom = maxBottom == null ? bottom : Math.max(maxBottom, bottom);
      }

      if (maxBottom != null || !fallbackToLatestBlock) {
        return maxBottom;
      }

      const blocks = contentRoot.querySelectorAll<HTMLElement>("[data-feed-block-id]");
      const lastBlock = blocks[blocks.length - 1];
      return lastBlock ? getFeedBlockBottom(container, lastBlock) : null;
    },
    [getFeedBlockBottom],
  );

  const persistFeedViewport = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const anchor = findVisibleTurnAnchor(container);
    useStore.getState().setFeedScrollPosition(sessionId, {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      isAtBottom: autoFollowEnabledRef.current && isNearBottom.current,
      anchorTurnId: anchor?.turnId ?? null,
      anchorOffsetTop: anchor?.offsetTop,
      lastSeenContentBottom: lastSeenContentBottomRef.current ?? getRealContentBottom(),
    });
  }, [findVisibleTurnAnchor, getRealContentBottom, sessionId]);

  // Save scroll position on unmount. Uses useLayoutEffect so the cleanup runs
  // in the layout phase — BEFORE the new component's effects try to restore,
  // avoiding the race where useEffect cleanup runs too late.
  useLayoutEffect(() => {
    return () => {
      persistFeedViewport();
    };
  }, [persistFeedViewport]);

  useEffect(() => {
    const handleSnapshotRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string | null }>).detail;
      if (!detail?.sessionId || detail.sessionId !== sessionId) return;
      persistFeedViewport();
    };
    window.addEventListener(SAVE_THREAD_VIEWPORT_EVENT, handleSnapshotRequest as EventListener);
    return () => window.removeEventListener(SAVE_THREAD_VIEWPORT_EVENT, handleSnapshotRequest as EventListener);
  }, [persistFeedViewport, sessionId]);

  const sections = useMemo(() => buildFeedSections(turns, sectionTurnCount), [sectionTurnCount, turns]);
  const isWindowedHistory = historyWindow !== null;
  const totalSections = sections.length;
  const latestVisibleSectionStartIndex = useMemo(
    () => findVisibleSectionStartIndex(sections, DEFAULT_VISIBLE_SECTION_COUNT),
    [sections],
  );
  const visibleSectionStartIndex = isWindowedHistory ? 0 : (sectionWindowStart ?? latestVisibleSectionStartIndex);
  const visibleSectionEndIndex = useMemo(
    () =>
      isWindowedHistory
        ? sections.length
        : findVisibleSectionEndIndex(sections, visibleSectionStartIndex, DEFAULT_VISIBLE_SECTION_COUNT),
    [isWindowedHistory, sections, visibleSectionStartIndex],
  );
  const visibleSections = useMemo(
    () => (isWindowedHistory ? sections : sections.slice(visibleSectionStartIndex, visibleSectionEndIndex)),
    [isWindowedHistory, sections, visibleSectionEndIndex, visibleSectionStartIndex],
  );
  const visibleTurns = useMemo(() => visibleSections.flatMap((section) => section.turns), [visibleSections]);
  const { turnStates, toggleTurn } = useCollapsePolicy({
    sessionId,
    turns: visibleTurns,
    leaderMode: false,
  });
  const collapseLayoutSignature = useMemo(
    () => turnStates.map((state) => `${state.turnId}:${state.isActivityExpanded ? "1" : "0"}`).join("|"),
    [turnStates],
  );
  const showConversationLoading = historyLoading && messages.length === 0 && !streamingText;
  const previousSectionStartIndex = useMemo(
    () => (isWindowedHistory ? null : findPreviousSectionStartIndex(sections, visibleSectionStartIndex)),
    [isWindowedHistory, sections, visibleSectionStartIndex],
  );
  const nextSectionStartIndex = useMemo(() => {
    if (isWindowedHistory) return null;
    return visibleSectionStartIndex + 1 < sections.length ? visibleSectionStartIndex + 1 : null;
  }, [isWindowedHistory, sections, visibleSectionStartIndex]);
  const hasOlderSections = historyWindow ? historyWindow.from_turn > 0 : previousSectionStartIndex !== null;
  const hasNewerSections = historyWindow
    ? historyWindow.from_turn + historyWindow.turn_count < historyWindow.total_turns
    : sectionWindowStart !== null && nextSectionStartIndex !== null;
  // Collapsible turn IDs: all turns with agent content are collapsible (including the last).
  // Stats and text preview recompute as new messages stream in.
  const collapsibleTurnIds = useMemo(
    () => visibleTurns.filter((t) => t.agentEntries.length > 0).map((t) => t.id),
    [visibleTurns],
  );

  // Sync collapsible turn IDs to the store so the Composer can render the global toggle
  useEffect(() => {
    useStore.getState().setCollapsibleTurnIds(sessionId, collapsibleTurnIds);
  }, [sessionId, collapsibleTurnIds]);

  useEffect(() => {
    if (isWindowedHistory) {
      setSectionWindowStart(null);
      return;
    }
    setSectionWindowStart((current) => {
      if (current == null) return null;
      if (sections.length === 0) return null;
      const normalizedCurrent = Math.min(current, sections.length - 1);
      const next = findSectionWindowStartIndexForTarget(sections, normalizedCurrent, DEFAULT_VISIBLE_SECTION_COUNT);
      return next === latestVisibleSectionStartIndex ? null : next;
    });
  }, [isWindowedHistory, latestVisibleSectionStartIndex, sections]);

  const getSectionWindowStartForTurnId = useCallback(
    (turnId: string): number | null => {
      const targetSectionIndex = sections.findIndex((section) => section.turns.some((turn) => turn.id === turnId));
      if (targetSectionIndex < 0) return null;
      const nextStartIndex = findSectionWindowStartIndexForTarget(
        sections,
        targetSectionIndex,
        DEFAULT_VISIBLE_SECTION_COUNT,
      );
      return nextStartIndex === latestVisibleSectionStartIndex ? null : nextStartIndex;
    },
    [latestVisibleSectionStartIndex, sections],
  );

  // ─── Scroll management ─────────────────────────────────────────────────

  const restoreTurnAnchor = useCallback(
    (anchorTurnId: string, anchorOffsetTop = 0) => {
      const container = containerRef.current;
      if (!container) return false;
      const target = container.querySelector<HTMLElement>(`[data-turn-id="${escapeSelectorValue(anchorTurnId)}"]`);
      if (!target) return false;
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const nextTop = container.scrollTop + targetRect.top - containerRect.top - anchorOffsetTop;
      markProgrammaticScroll(nextTop);
      container.scrollTop = nextTop;
      lastScrollTopRef.current = container.scrollTop;
      return true;
    },
    [markProgrammaticScroll],
  );

  const restoreFeedAnchor = useCallback(
    (anchor: FeedViewportAnchor) => {
      const container = containerRef.current;
      if (!container) return false;

      const restoreSelector = (selector: string) => {
        const target = container.querySelector<HTMLElement>(selector);
        if (!target) return false;
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const nextTop = container.scrollTop + targetRect.top - containerRect.top - anchor.offsetTop;
        markProgrammaticScroll(nextTop);
        container.scrollTop = nextTop;
        lastScrollTopRef.current = container.scrollTop;
        return true;
      };

      if (anchor.messageId && restoreSelector(`[data-message-id="${escapeSelectorValue(anchor.messageId)}"]`)) {
        return true;
      }

      if (anchor.turnId && restoreSelector(`[data-turn-id="${escapeSelectorValue(anchor.turnId)}"]`)) {
        return true;
      }

      return false;
    },
    [markProgrammaticScroll],
  );

  const snapshotViewportAnchor = useCallback(
    (container: HTMLDivElement) => {
      lastViewportAnchorRef.current = {
        signature: collapseLayoutSignature,
        wasAutoFollowing: autoFollowEnabledRef.current,
        anchor: findVisibleFeedAnchor(container),
      };
    },
    [collapseLayoutSignature, findVisibleFeedAnchor],
  );

  const moveSectionWindow = useCallback(
    (nextStartIndex: number | null) => {
      const el = containerRef.current;
      const anchor = el ? findVisibleTurnAnchor(el) : null;
      setSectionWindowStart(nextStartIndex);
      requestAnimationFrame(() => {
        if (anchor?.turnId) {
          restoreTurnAnchor(anchor.turnId, anchor.offsetTop ?? 0);
        }
      });
    },
    [findVisibleTurnAnchor, restoreTurnAnchor],
  );

  const ensureSectionForTurnVisible = useCallback(
    (turnId: string): boolean => {
      const nextStartIndex = getSectionWindowStartForTurnId(turnId);
      if (nextStartIndex === sectionWindowStart) return false;
      if (nextStartIndex == null && visibleSectionStartIndex === latestVisibleSectionStartIndex) return false;
      moveSectionWindow(nextStartIndex);
      return true;
    },
    [
      getSectionWindowStartForTurnId,
      moveSectionWindow,
      sectionWindowStart,
      latestVisibleSectionStartIndex,
      visibleSectionStartIndex,
    ],
  );

  const scrollToFeedBlock = useCallback(
    (blockId: string, turnId: string) => {
      const sectionChanged = ensureSectionForTurnVisible(turnId);
      const scheduleScroll = () => {
        requestAnimationFrame(() => {
          const contentRoot = contentRootRef.current;
          const target = contentRoot?.querySelector<HTMLElement>(
            `[data-feed-block-id="${escapeSelectorValue(blockId)}"]`,
          );
          target?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      };
      if (sectionChanged) {
        requestAnimationFrame(scheduleScroll);
        return;
      }
      scheduleScroll();
    },
    [ensureSectionForTurnVisible],
  );

  const handleLoadOlderSection = useCallback(() => {
    if (historyWindow) {
      const turnCount =
        historyWindow.turn_count ||
        getHistoryWindowTurnCount(historyWindow.visible_section_count, historyWindow.section_turn_count);
      const nextFromTurn = Math.max(0, historyWindow.from_turn - historyWindow.section_turn_count);
      autoFollowEnabledRef.current = false;
      setShowScrollButton(true);
      sendToSession(sessionId, {
        type: "history_window_request",
        from_turn: nextFromTurn,
        turn_count: turnCount,
        section_turn_count: historyWindow.section_turn_count,
        visible_section_count: historyWindow.visible_section_count,
      });
      return;
    }
    if (previousSectionStartIndex == null) return;
    autoFollowEnabledRef.current = false;
    setShowScrollButton(true);
    moveSectionWindow(previousSectionStartIndex);
  }, [historyWindow, moveSectionWindow, previousSectionStartIndex, sessionId]);

  const handleLoadNewerSection = useCallback(() => {
    if (historyWindow) {
      const turnCount =
        historyWindow.turn_count ||
        getHistoryWindowTurnCount(historyWindow.visible_section_count, historyWindow.section_turn_count);
      const maxFromTurn = Math.max(0, historyWindow.total_turns - turnCount);
      const nextFromTurn = Math.min(maxFromTurn, historyWindow.from_turn + historyWindow.section_turn_count);
      if (nextFromTurn === historyWindow.from_turn) return;
      autoFollowEnabledRef.current = false;
      sendToSession(sessionId, {
        type: "history_window_request",
        from_turn: nextFromTurn,
        turn_count: turnCount,
        section_turn_count: historyWindow.section_turn_count,
        visible_section_count: historyWindow.visible_section_count,
      });
      return;
    }
    if (nextSectionStartIndex == null) return;
    autoFollowEnabledRef.current = false;
    moveSectionWindow(nextSectionStartIndex === latestVisibleSectionStartIndex ? null : nextSectionStartIndex);
  }, [historyWindow, latestVisibleSectionStartIndex, moveSectionWindow, nextSectionStartIndex, sessionId]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (historyWindow && hasNewerSections) {
        const turnCount =
          historyWindow.turn_count ||
          getHistoryWindowTurnCount(historyWindow.visible_section_count, historyWindow.section_turn_count);
        const latestFromTurn = Math.max(0, historyWindow.total_turns - turnCount);
        autoFollowEnabledRef.current = true;
        sendToSession(sessionId, {
          type: "history_window_request",
          from_turn: latestFromTurn,
          turn_count: turnCount,
          section_turn_count: historyWindow.section_turn_count,
          visible_section_count: historyWindow.visible_section_count,
        });
        return;
      }
      const performScroll = () => {
        const container = containerRef.current;
        if (!container) return;
        autoFollowEnabledRef.current = true;
        const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(realContentBottom - container.clientHeight)));
        scrollContainerTo(targetTop, behavior);
        isNearBottom.current = true;
        lastSeenContentBottomRef.current = realContentBottom;
        lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
        setShowScrollButton(false);
        setShowLatestPill(false);
      };
      if (sectionWindowStart == null || totalSections <= DEFAULT_VISIBLE_SECTION_COUNT) {
        performScroll();
        return;
      }
      setSectionWindowStart(null);
      requestAnimationFrame(performScroll);
    },
    [
      getRealContentBottom,
      hasNewerSections,
      historyWindow,
      scrollContainerTo,
      sectionWindowStart,
      sessionId,
      totalSections,
    ],
  );

  const handleScrollToBottomClick = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  const handleScrollToTopClick = useCallback(() => {
    containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleScrollToPreviousUserMessageClick = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const containerRect = el.getBoundingClientRect();
    const turns = el.querySelectorAll("[data-user-turn]");
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i] as HTMLElement;
      const turnTop = turn.getBoundingClientRect().top - containerRect.top;
      if (turnTop < -5) {
        turn.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
    }
  }, []);

  const handleScrollToNextUserMessageClick = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const containerRect = el.getBoundingClientRect();
    const turns = el.querySelectorAll("[data-user-turn]");
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i] as HTMLElement;
      const turnTop = turn.getBoundingClientRect().top - containerRect.top;
      if (turnTop > el.clientHeight * 0.3) {
        turn.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
    }
    scrollToBottom();
  }, [scrollToBottom]);

  const navFabButtonClassName = isTouch
    ? "h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer"
    : "h-8 w-8 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer";
  const navFabStackClassName = isTouch
    ? `gap-2 ${isScrolling ? "opacity-60" : "opacity-0 pointer-events-none"}`
    : "gap-4";
  const userTurnNavGroupClassName = isTouch ? "flex flex-col gap-2" : "flex flex-col gap-1.5";

  const resetVisibleSectionsToLatest = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (historyWindow && hasNewerSections) {
        const turnCount =
          historyWindow.turn_count ||
          getHistoryWindowTurnCount(historyWindow.visible_section_count, historyWindow.section_turn_count);
        const latestFromTurn = Math.max(0, historyWindow.total_turns - turnCount);
        autoFollowEnabledRef.current = true;
        sendToSession(sessionId, {
          type: "history_window_request",
          from_turn: latestFromTurn,
          turn_count: turnCount,
          section_turn_count: historyWindow.section_turn_count,
          visible_section_count: historyWindow.visible_section_count,
        });
        return;
      }
      if (sectionWindowStart == null || totalSections <= DEFAULT_VISIBLE_SECTION_COUNT) return;
      autoFollowEnabledRef.current = true;
      setSectionWindowStart(null);
      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container) return;
        const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(realContentBottom - container.clientHeight)));
        scrollContainerTo(targetTop, behavior);
      });
    },
    [
      getRealContentBottom,
      hasNewerSections,
      historyWindow,
      scrollContainerTo,
      sectionWindowStart,
      sessionId,
      totalSections,
    ],
  );

  const flushAutoFollow = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const changedBlockIds = new Set(pendingChangedFeedBlockIdsRef.current);
    pendingChangedFeedBlockIdsRef.current.clear();
    const useFallback = pendingAutoFollowFallbackRef.current;
    pendingAutoFollowFallbackRef.current = false;

    if (!autoFollowEnabledRef.current) return;

    if (sectionWindowStart != null && totalSections > DEFAULT_VISIBLE_SECTION_COUNT) {
      changedBlockIds.forEach((blockId) => pendingChangedFeedBlockIdsRef.current.add(blockId));
      pendingAutoFollowFallbackRef.current = true;
      setSectionWindowStart(null);
      requestAnimationFrame(() => {
        if (autoFollowEnabledRef.current) {
          if (autoFollowRafRef.current != null) return;
          autoFollowRafRef.current = requestAnimationFrame(() => {
            autoFollowRafRef.current = null;
            flushAutoFollow();
          });
        }
      });
      return;
    }

    const lowestBottom = getLowestFeedBlockBottom(changedBlockIds, useFallback);
    if (lowestBottom == null) return;
    const bottomAlignMessageId = bottomAlignMessageIdRef.current;
    const bottomAlignTarget = bottomAlignMessageId
      ? contentRootRef.current?.querySelector<HTMLElement>(
          `[data-message-id="${escapeSelectorValue(bottomAlignMessageId)}"]`,
        )
      : null;
    const targetBottom = bottomAlignTarget ? getFeedBlockBottom(container, bottomAlignTarget) : lowestBottom;

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(targetBottom - container.clientHeight)));
    // A long-lived subagent can keep mutating above newer bottom content. While
    // auto-follow is enabled, never let those older updates yank the viewport
    // upward; only move farther down toward the latest active content.
    const currentTop = Math.max(0, Math.min(maxScrollTop, container.scrollTop));
    const nextTargetTop = Math.max(currentTop, targetTop);
    if (Math.abs(container.scrollTop - nextTargetTop) > 1) {
      setContainerScrollTop(nextTargetTop);
    }
    const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
    isNearBottom.current = realContentBottom - nextTargetTop - container.clientHeight < 120;
    lastSeenContentBottomRef.current = realContentBottom;
    lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
    setShowScrollButton(false);
    setShowLatestPill(false);
    if (bottomAlignMessageId) {
      bottomAlignMessageIdRef.current = null;
    }
  }, [
    getFeedBlockBottom,
    getLowestFeedBlockBottom,
    getRealContentBottom,
    sectionWindowStart,
    setContainerScrollTop,
    totalSections,
  ]);

  const scheduleAutoFollowFlush = useCallback(
    (useFallback = false) => {
      if (useFallback) {
        pendingAutoFollowFallbackRef.current = true;
      }
      if (autoFollowRafRef.current != null) return;
      autoFollowRafRef.current = requestAnimationFrame(() => {
        autoFollowRafRef.current = null;
        flushAutoFollow();
      });
    },
    [flushAutoFollow],
  );

  const updateLatestPillForContentBottom = useCallback(
    (realContentBottom: number | null) => {
      if (!didTrackContentRef.current) {
        didTrackContentRef.current = true;
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      if (autoFollowEnabledRef.current) {
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      if (hasNewerSections) {
        setShowLatestPill(true);
        return;
      }
      if (suppressLatestPillOnRestoreRef.current) {
        suppressLatestPillOnRestoreRef.current = false;
        lastSeenContentBottomRef.current = realContentBottom;
        lastObservedContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      if (realContentBottom == null) {
        setShowLatestPill(false);
        return;
      }
      const container = containerRef.current;
      const hasContentBelowViewport = container
        ? realContentBottom > container.scrollTop + container.clientHeight + 8
        : false;
      if (!hasContentBelowViewport) {
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      const baseline = lastSeenContentBottomRef.current;
      if (baseline == null) {
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      setShowLatestPill(realContentBottom > baseline + 8);
    },
    [hasNewerSections],
  );

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const currentScrollTop = el.scrollTop;
    const realContentBottom = getRealContentBottom() ?? el.scrollHeight;
    const nearBottom = realContentBottom - currentScrollTop - el.clientHeight < 120;
    const isProgrammaticScroll =
      programmaticScrollTargetRef.current != null &&
      Math.abs(currentScrollTop - programmaticScrollTargetRef.current) <= 2;
    if (isProgrammaticScroll) {
      programmaticScrollTargetRef.current = null;
    }
    const scrollingUp = currentScrollTop < lastScrollTopRef.current - 4;
    if (!isProgrammaticScroll) {
      if (scrollingUp) {
        autoFollowEnabledRef.current = false;
      } else if (!nearBottom) {
        autoFollowEnabledRef.current = false;
      } else if (nearBottom) {
        autoFollowEnabledRef.current = true;
      }
    }
    isNearBottom.current = nearBottom;
    if (autoFollowEnabledRef.current && nearBottom) {
      lastSeenContentBottomRef.current = realContentBottom;
      lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
      setShowLatestPill(false);
      resetVisibleSectionsToLatest("auto");
    }
    // Only trigger a re-render when the button state actually changes
    const shouldShow = !nearBottom || !autoFollowEnabledRef.current;
    setShowScrollButton((prev) => (prev === shouldShow ? prev : shouldShow));
    // Track active scrolling for mobile FAB auto-hide
    setIsScrolling(true);
    clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => setIsScrolling(false), 1500);
    lastScrollTopRef.current = currentScrollTop;
    snapshotViewportAnchor(el);
  }

  // Restore scroll position synchronously before the first paint.
  // useLayoutEffect runs before the browser paints, preventing the flash
  // where the feed appears at scrollTop=0 for one frame before jumping.
  useLayoutEffect(() => {
    if (restoredSessionIdRef.current === sessionId) return;
    if (showConversationLoading) return;
    const pos = useStore.getState().feedScrollPosition.get(sessionId);
    if (messages.length === 0 && pos?.anchorTurnId) return;
    const desiredSectionWindowStart = pos?.anchorTurnId ? getSectionWindowStartForTurnId(pos.anchorTurnId) : null;
    if (desiredSectionWindowStart !== sectionWindowStart) {
      setSectionWindowStart(desiredSectionWindowStart);
      return;
    }
    if (pos && !pos.isAtBottom && pos.anchorTurnId) {
      if (restoreTurnAnchor(pos.anchorTurnId!, pos.anchorOffsetTop ?? 0)) {
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
      } else {
        scrollToBottom("auto");
      }
    } else if (pos && !pos.isAtBottom) {
      const el = containerRef.current;
      if (el) {
        if (el.scrollHeight === pos.scrollHeight) {
          el.scrollTop = pos.scrollTop;
        } else if (pos.scrollHeight > 0) {
          el.scrollTop = pos.scrollTop * (el.scrollHeight / pos.scrollHeight);
        }
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
        lastScrollTopRef.current = el.scrollTop;
      }
    } else {
      scrollToBottom("auto");
    }
    restoredSessionIdRef.current = sessionId;
  }, [
    getSectionWindowStartForTurnId,
    messages.length,
    restoreTurnAnchor,
    scrollToBottom,
    sectionWindowStart,
    sessionId,
    showConversationLoading,
  ]);

  useEffect(() => {
    if (showConversationLoading) return;
    didTrackContentRef.current = savedScrollPos?.lastSeenContentBottom != null;
    lastSeenContentBottomRef.current = savedScrollPos?.lastSeenContentBottom ?? null;
    lastObservedContentBottomRef.current = savedScrollPos?.lastSeenContentBottom ?? null;
    suppressLatestPillOnRestoreRef.current = savedScrollPos?.lastSeenContentBottom != null;
    setShowLatestPill(false);
  }, [savedScrollPos?.lastSeenContentBottom, sessionId, showConversationLoading]);

  useEffect(() => {
    if (showConversationLoading) return;
    updateLatestPillForContentBottom(getRealContentBottom());
  }, [
    getRealContentBottom,
    messages.length,
    showConversationLoading,
    streamingText,
    toolProgress,
    updateLatestPillForContentBottom,
  ]);

  useEffect(() => {
    onLatestIndicatorVisibleChange?.(showLatestPill);
  }, [onLatestIndicatorVisibleChange, showLatestPill]);

  useEffect(() => {
    onJumpToLatestReady?.(() => scrollToBottom());
    return () => onJumpToLatestReady?.(null);
  }, [onJumpToLatestReady, scrollToBottom]);

  useLayoutEffect(() => {
    if (!shouldBottomAlignNextUserMessage) return;
    if (!latestMessage || latestMessage.role !== "user") return;

    const alignLatestUserMessage = () => {
      const container = containerRef.current;
      if (!container) return;
      const target = container.querySelector<HTMLElement>(
        `[data-message-id="${escapeSelectorValue(latestMessage.id)}"]`,
      );
      if (!target) return;
      const messageBottom = getFeedBlockBottom(container, target);
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(messageBottom - container.clientHeight)));
      autoFollowEnabledRef.current = true;
      isNearBottom.current = true;
      setContainerScrollTop(targetTop);
      lastSeenContentBottomRef.current = getRealContentBottom();
      lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
      setShowScrollButton(false);
      setShowLatestPill(false);
      bottomAlignMessageIdRef.current = latestMessage.id;
      useStore.getState().clearBottomAlignOnNextUserMessage(sessionId);
    };

    if (sectionWindowStart != null && totalSections > DEFAULT_VISIBLE_SECTION_COUNT) {
      setSectionWindowStart(null);
      requestAnimationFrame(alignLatestUserMessage);
      return;
    }
    alignLatestUserMessage();
  }, [
    getFeedBlockBottom,
    getRealContentBottom,
    latestMessage,
    sectionWindowStart,
    sessionId,
    setContainerScrollTop,
    shouldBottomAlignNextUserMessage,
    totalSections,
  ]);

  useEffect(() => {
    if (showConversationLoading) return;
    if (!toolProgress || toolProgress.size === 0) return;
    scheduleAutoFollowFlush(true);
  }, [scheduleAutoFollowFlush, showConversationLoading, toolProgress]);

  useEffect(() => {
    if (showConversationLoading) return;
    const container = containerRef.current;
    const contentRoot = contentRootRef.current;
    if (!container || !contentRoot) return;

    lastObservedContentBottomRef.current = getRealContentBottom();

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((mutations) => {
            let sawMutation = false;
            for (const mutation of mutations) {
              sawMutation = true;
              collectFeedBlockIdsFromNode(mutation.target, pendingChangedFeedBlockIdsRef.current);
              mutation.addedNodes.forEach((node) =>
                collectFeedBlockIdsFromNode(node, pendingChangedFeedBlockIdsRef.current),
              );
            }
            if (sawMutation) {
              scheduleAutoFollowFlush();
            }
          });

    mutationObserver?.observe(contentRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const realContentBottom = getRealContentBottom();
            if (realContentBottom == null || realContentBottom === lastObservedContentBottomRef.current) return;
            lastObservedContentBottomRef.current = realContentBottom;
            if (!autoFollowEnabledRef.current) {
              updateLatestPillForContentBottom(realContentBottom);
            }
            scheduleAutoFollowFlush(true);
          });

    resizeObserver?.observe(contentRoot);

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      if (autoFollowRafRef.current != null) {
        cancelAnimationFrame(autoFollowRafRef.current);
        autoFollowRafRef.current = null;
      }
      pendingChangedFeedBlockIdsRef.current.clear();
      pendingAutoFollowFallbackRef.current = false;
    };
  }, [getRealContentBottom, scheduleAutoFollowFlush, showConversationLoading, updateLatestPillForContentBottom]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previous = lastViewportAnchorRef.current;
    if (previous && previous.signature !== collapseLayoutSignature) {
      if (previous.wasAutoFollowing) {
        const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(realContentBottom - container.clientHeight)));
        setContainerScrollTop(targetTop);
        isNearBottom.current = true;
        lastSeenContentBottomRef.current = realContentBottom;
        lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
        setShowScrollButton(false);
        setShowLatestPill(false);
      } else if (previous.anchor && restoreFeedAnchor(previous.anchor)) {
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
      }
    }
    snapshotViewportAnchor(container);
  }, [collapseLayoutSignature, getRealContentBottom, restoreFeedAnchor, setContainerScrollTop, snapshotViewportAnchor]);

  // Scroll-to-turn: triggered from the Session Tasks panel
  const scrollToTurnId = useStore((s) => s.scrollToTurnId.get(sessionId));
  const clearScrollToTurn = useStore((s) => s.clearScrollToTurn);
  useEffect(() => {
    if (!scrollToTurnId) return;
    clearScrollToTurn(sessionId);
    autoFollowEnabledRef.current = false;
    // Expand the target turn's activity if needed.
    const overrides = useStore.getState().turnActivityOverrides.get(sessionId);
    const isExpanded = overrides?.get(scrollToTurnId);
    if (isExpanded !== true) {
      useStore.getState().keepTurnExpanded(sessionId, scrollToTurnId);
    }
    const sectionChanged = ensureSectionForTurnVisible(scrollToTurnId);
    const scheduleScroll = () => {
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el) return;
        const target = el.querySelector(`[data-turn-id="${escapeSelectorValue(scrollToTurnId)}"]`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    };
    if (sectionChanged) {
      requestAnimationFrame(scheduleScroll);
      return;
    }
    scheduleScroll();
  }, [clearScrollToTurn, ensureSectionForTurnVisible, scrollToTurnId, sessionId]);

  // Scroll-to-message: triggered from deep links, search navigation, and QuestmasterPage.
  // Finds the turn containing the target message, focuses it (expand target,
  // collapse all others except last), expands collapsed groups, and scrolls to the element.
  const scrollToMessageId = useStore((s) => s.scrollToMessageId.get(sessionId));
  const expandAllInTurnTarget = useStore((s) => s.expandAllInTurn.get(sessionId));
  const clearScrollToMessage = useStore((s) => s.clearScrollToMessage);
  const clearExpandAllInTurn = useStore((s) => s.clearExpandAllInTurn);
  useEffect(() => {
    if (!scrollToMessageId) return;
    clearScrollToMessage(sessionId);
    autoFollowEnabledRef.current = false;

    // Find which turn contains this message. Check both regular messages and
    // tool_msg_group entries (tool-use-only assistant messages get grouped into
    // tool_msg_group by the feed model, so their IDs only appear in firstId).
    const targetTurn = turns.find(
      (t) =>
        t.allEntries.some(
          (e) =>
            (e.kind === "message" && e.msg.id === scrollToMessageId) ||
            (e.kind === "tool_msg_group" && e.firstId === scrollToMessageId),
        ) ||
        (t.userEntry?.kind === "message" && t.userEntry.msg.id === scrollToMessageId),
    );
    if (!targetTurn) {
      // Target message genuinely not in turns (e.g. compacted out of history).
      // Fall back to scrolling to the most recent content rather than doing nothing.
      const lastTurn = turns[turns.length - 1];
      if (lastTurn) {
        useStore.getState().focusTurn(sessionId, lastTurn.id);
        ensureSectionForTurnVisible(lastTurn.id);
        requestAnimationFrame(() => {
          containerRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
          clearExpandAllInTurn(sessionId);
        });
      }
      return;
    }

    // Focus: expand target turn, all others revert to defaults (last expanded, rest collapsed)
    useStore.getState().focusTurn(sessionId, targetTurn.id);
    const sectionChanged = ensureSectionForTurnVisible(targetTurn.id);

    // Wait for DOM to settle, then scroll to the specific message
    const scheduleScroll = () => {
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el) return;
        // Try data-message-id first (regular messages), then data-feed-block-id
        // with tool-group: prefix (tool-use-only messages grouped into tool_msg_group).
        const target =
          el.querySelector(`[data-message-id="${escapeSelectorValue(scrollToMessageId)}"]`) ||
          el.querySelector(`[data-feed-block-id="tool-group:${escapeSelectorValue(scrollToMessageId)}"]`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          // Brief amber highlight flash on the target
          (target as HTMLElement).classList.add("message-scroll-highlight");
          setTimeout(() => (target as HTMLElement).classList.remove("message-scroll-highlight"), 2000);
        }
        // Clear expand-all signal after DOM has settled
        clearExpandAllInTurn(sessionId);
      });
    };
    if (sectionChanged) {
      requestAnimationFrame(scheduleScroll);
      return;
    }
    scheduleScroll();
  }, [clearExpandAllInTurn, clearScrollToMessage, ensureSectionForTurnVisible, scrollToMessageId, sessionId, turns]);

  // Track which task outline chip should be highlighted based on scroll position.
  // The reference line is near the container top (with a small offset to avoid
  // edge-triggering). The last task-trigger turn whose top has scrolled past
  // this line is the active task — matching the chip-click behavior which
  // scrolls the trigger to the top of the viewport.
  // Uses a scroll listener instead of IntersectionObserver so the callback
  // fires on every scroll frame, not just on intersection threshold crossings.
  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const setActiveTaskTurnId = useStore((s) => s.setActiveTaskTurnId);
  const taskTriggerIds = useMemo(
    () => new Set((taskHistory || []).map((task) => task.triggerMessageId)),
    [taskHistory],
  );
  const firstTaskTurnId = taskHistory?.[0]?.triggerMessageId ?? null;

  const rebuildTaskTurnOffsets = useCallback(() => {
    const el = containerRef.current;
    if (!el || taskTriggerIds.size === 0) {
      taskTurnOffsetsRef.current = [];
      return;
    }
    const nextOffsets: TurnOffsetIndex[] = [];
    const targets = el.querySelectorAll<HTMLElement>("[data-turn-id]");
    for (const target of targets) {
      const turnId = target.dataset.turnId;
      if (!turnId || !taskTriggerIds.has(turnId)) continue;
      nextOffsets.push({ turnId, offsetTop: target.offsetTop });
    }
    taskTurnOffsetsRef.current = nextOffsets;
  }, [taskTriggerIds]);

  useLayoutEffect(() => {
    rebuildTaskTurnOffsets();
    if (containerRef.current) {
      setActiveTaskTurnId(
        sessionId,
        findActiveTaskTurnIdForScroll(taskTurnOffsetsRef.current, containerRef.current.scrollTop, firstTaskTurnId),
      );
    }

    const el = containerRef.current;
    if (!el || taskTriggerIds.size === 0 || typeof ResizeObserver === "undefined") {
      return;
    }

    let rafId = 0;
    const scheduleRebuild = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rebuildTaskTurnOffsets();
        setActiveTaskTurnId(
          sessionId,
          findActiveTaskTurnIdForScroll(taskTurnOffsetsRef.current, el.scrollTop, firstTaskTurnId),
        );
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleRebuild();
    });
    const targets = el.querySelectorAll<HTMLElement>("[data-turn-id]");
    targets.forEach((target) => observer.observe(target));

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [firstTaskTurnId, rebuildTaskTurnOffsets, sessionId, setActiveTaskTurnId, taskTriggerIds, visibleTurns]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !taskHistory || taskHistory.length === 0) return;

    let rafId = 0;
    const recalc = () => {
      const activeTurnId = findActiveTaskTurnIdForScroll(taskTurnOffsetsRef.current, el.scrollTop, firstTaskTurnId);
      setActiveTaskTurnId(sessionId, activeTurnId);
    };

    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(recalc);
    };

    recalc();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafId);
    };
  }, [firstTaskTurnId, sessionId, setActiveTaskTurnId, taskHistory, visibleTurns]);

  // ─── Render ──────────────────────────────────────────────────────────────

  if (showConversationLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 select-none px-6">
        <YarnBallSpinner className="w-5 h-5 text-cc-primary" />
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">Loading conversation...</p>
          <p className="text-xs text-cc-muted leading-relaxed">Restoring recent history for this session.</p>
        </div>
      </div>
    );
  }

  if (messages.length === 0 && pendingUserUploads.length === 0 && pendingCodexInputs.length === 0 && !streamingText) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 select-none px-6">
        <SleepingCat className="w-20 h-14" />
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">Start a conversation</p>
          <p className="text-xs text-cc-muted leading-relaxed">Send a message to begin working with The Companion.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div
        ref={overlayViewportRef}
        data-testid="message-feed-overlay"
        className="relative flex-1 min-h-0 overflow-hidden"
      >
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-4 sm:py-6"
          style={{ overscrollBehavior: "contain" }}
        >
          <PawScrollProvider scrollRef={containerRef}>
            <PawCounterContext.Provider value={pawCounter}>
              <div ref={contentRootRef} className="max-w-3xl mx-auto space-y-3 sm:space-y-5">
                {hasOlderSections && (
                  <div className="flex justify-center pb-2">
                    <button
                      type="button"
                      onClick={handleLoadOlderSection}
                      className="inline-flex items-center gap-1.5 rounded-full border border-cc-border bg-cc-card px-3 py-1.5 text-xs text-cc-muted transition-colors hover:bg-cc-hover cursor-pointer"
                    >
                      <YarnBallSpinner className="h-3 w-3 text-cc-muted" />
                      Load older section
                    </button>
                  </div>
                )}
                <TurnEntries
                  sections={visibleSections}
                  sessionId={sessionId}
                  leaderMode={false}
                  isCodexSession={isCodexSession}
                  activeCodexTerminalIds={activeCodexTerminalIds}
                  onOpenCodexTerminal={setSelectedCodexTerminalId}
                  onSelectThread={onSelectThread}
                  turnStates={turnStates}
                  toggleTurn={toggleTurn}
                />
                {hasNewerSections && (
                  <div className="flex justify-center pt-1">
                    <button
                      type="button"
                      onClick={handleLoadNewerSection}
                      className="inline-flex items-center gap-1.5 rounded-full border border-cc-border bg-cc-card px-3 py-1.5 text-xs text-cc-muted transition-colors hover:bg-cc-hover cursor-pointer"
                    >
                      <YarnBallSpinner className="h-3 w-3 text-cc-muted" />
                      Load newer section
                    </button>
                  </div>
                )}
                {pendingUserUploads.length > 0 && (
                  <PendingUserUploadList sessionId={sessionId} uploads={pendingUserUploads} />
                )}
                {isCodexSession && pendingCodexInputs.length > 0 && (
                  <PendingCodexInputList sessionId={sessionId} inputs={pendingCodexInputs} />
                )}
                <FeedFooter sessionId={sessionId} visibleToolUseIds={visibleToolUseIds} />
                <div
                  aria-hidden="true"
                  className="pointer-events-none"
                  data-feed-end-slack="true"
                  style={{ height: `${feedEndScrollSlack}px` }}
                />
              </div>
            </PawCounterContext.Provider>
          </PawScrollProvider>
        </div>

        <FeedStatusPill sessionId={sessionId} onVisibleHeightChange={setFloatingStatusHeight} />

        {(visibleCodexTerminalRailEntries.length > 0 || visibleLiveSubagentEntries.length > 0) && (
          <LiveActivityRail
            terminals={visibleCodexTerminalRailEntries}
            subagents={visibleLiveSubagentEntries}
            selectedToolUseId={selectedCodexTerminalId}
            onSelect={setSelectedCodexTerminalId}
            onSelectSubagent={(taskToolUseId, turnId) => {
              scrollToFeedBlock(getSubagentFeedBlockId(taskToolUseId), turnId);
            }}
            onDismissSubagent={(taskToolUseId, freshnessToken) => {
              setDismissedSubagentChips((prev) => {
                const next = new Map(prev);
                next.set(taskToolUseId, freshnessToken);
                return next;
              });
            }}
          />
        )}

        {isCodexSession && selectedCodexTerminal && (
          <CodexTerminalInspector
            sessionId={sessionId}
            terminal={selectedCodexTerminal}
            onClose={() => setSelectedCodexTerminalId(null)}
            viewportRef={overlayViewportRef}
          />
        )}

        {showLatestPill && latestIndicatorMode !== "external" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3 sm:px-4">
            <button
              type="button"
              onClick={handleScrollToBottomClick}
              className="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full border border-cc-primary/25 bg-cc-card/95 px-4 py-2 text-sm font-medium text-cc-fg shadow-lg backdrop-blur-sm transition-colors hover:bg-cc-hover cursor-pointer"
              title="Jump to latest"
              aria-label="Jump to latest"
            >
              <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-cc-primary animate-pulse" />
              <span className="truncate">New content below</span>
            </button>
          </div>
        )}

        {/* Navigation FABs — desktop: top, prev/next, bottom; mobile: same stack, auto-hide */}
        {showScrollButton && (
          <div
            data-testid="message-feed-nav-fabs"
            className={`absolute bottom-3 right-3 z-10 flex flex-col transition-opacity duration-300 ${navFabStackClassName}`}
            style={isTouch ? { bottom: `${mobileNavBottomOffsetPx}px` } : undefined}
          >
            {/* Go to top */}
            <button
              onClick={handleScrollToTopClick}
              className={navFabButtonClassName}
              title="Go to top"
              aria-label="Go to top"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                <path d="M4 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 12h8" strokeLinecap="round" />
              </svg>
            </button>
            <div className={userTurnNavGroupClassName}>
              <button
                onClick={handleScrollToPreviousUserMessageClick}
                className={navFabButtonClassName}
                title="Previous user message"
                aria-label="Previous user message"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <path d="M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M8 3v10" strokeLinecap="round" />
                </svg>
              </button>
              <button
                onClick={handleScrollToNextUserMessageClick}
                className={navFabButtonClassName}
                title="Next user message"
                aria-label="Next user message"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <path d="M4 9l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M8 3v10" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {/* Go to bottom */}
            <button
              onClick={handleScrollToBottomClick}
              className={navFabButtonClassName}
              title="Go to bottom"
              aria-label="Go to bottom"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                <path d="M4 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 4h8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        {/* Floating context menu for text selection within assistant messages */}
        <SelectionContextMenu selection={textSelection} sessionId={sessionId} onClose={textSelection.dismiss} />
      </div>
    </div>
  );
}
