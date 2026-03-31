import {
  useRef,
  useCallback,
  useMemo,
  useState,
  useEffect,
  Children,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api.js";
import { useStore, countUserPermissions } from "../store.js";
import { navigateToSession, sessionHash } from "../utils/routing.js";
import { SessionHoverCard } from "./SessionHoverCard.js";
import { QuestHoverCard } from "./QuestHoverCard.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { CodeCopyButton } from "./CodeCopyButton.js";
import { withQuestIdInHash } from "../utils/routing.js";
import { highlightCode } from "../utils/syntax-highlighting.js";
import { openFileWithEditorPreference, showEditorOpenError } from "../utils/vscode-bridge.js";
import { HighlightedText } from "./HighlightedText.js";

function parseQuestIdFromHref(href?: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();

  const directId = trimmed.match(/^(q-\d+)$/i);
  if (directId) return directId[1].toLowerCase();

  const questScheme = trimmed.match(/^quest:(q-\d+)$/i);
  if (questScheme) return questScheme[1].toLowerCase();

  const questUri = trimmed.match(/^quest:\/\/(q-\d+)$/i);
  if (questUri) return questUri[1].toLowerCase();

  return null;
}

function parseSessionNumFromHref(href?: string): number | null {
  if (!href) return null;
  const trimmed = href.trim();

  const sessionScheme = trimmed.match(/^session:(\d+)$/i);
  if (sessionScheme) return Number.parseInt(sessionScheme[1], 10);

  const sessionUri = trimmed.match(/^session:\/\/(\d+)$/i);
  if (sessionUri) return Number.parseInt(sessionUri[1], 10);

  return null;
}

interface FileLinkTarget {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  isRelative: boolean;
}

interface ResolvedFileLinkTarget {
  absolutePath: string;
  line: number;
  column: number;
  endLine?: number;
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^\/[A-Za-z]:\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizeRepoRelativePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return null;

  const parts = normalized.split("/");
  const safeParts: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    safeParts.push(part);
  }

  return safeParts.length > 0 ? safeParts.join("/") : null;
}

function resolveFileLinkTarget(target: FileLinkTarget, repoRoot: string | null): ResolvedFileLinkTarget | null {
  if (!target.isRelative) {
    return {
      absolutePath: target.path,
      line: target.line,
      column: target.column,
      ...(Number.isFinite(target.endLine) ? { endLine: Number(target.endLine) } : {}),
    };
  }

  const normalizedRelativePath = normalizeRepoRelativePath(target.path);
  if (!normalizedRelativePath || !repoRoot) return null;

  const separator = repoRoot.includes("\\") ? "\\" : "/";
  const normalizedRepoRoot = repoRoot.replace(/[\\/]+$/, "");
  const relativePath = separator === "\\" ? normalizedRelativePath.replace(/\//g, "\\") : normalizedRelativePath;

  return {
    absolutePath: `${normalizedRepoRoot}${separator}${relativePath}`,
    line: target.line,
    column: target.column,
    ...(Number.isFinite(target.endLine) ? { endLine: Number(target.endLine) } : {}),
  };
}

function formatFileLinkLocation(target: Pick<FileLinkTarget, "line" | "column" | "endLine">): string {
  if (Number.isFinite(target.endLine) && Number(target.endLine) >= target.line) {
    return `:${target.line}-${Number(target.endLine)}`;
  }
  if (target.column > 1) {
    return `:${target.line}:${target.column}`;
  }
  return `:${target.line}`;
}

function getFileLinkBasePath(
  sessionId: string | undefined,
  currentSessionId: string | null,
  sessions: Map<string, { cwd?: string; repo_root?: string; is_worktree?: boolean }>,
  sdkSessions: Array<{ sessionId: string; cwd?: string; repoRoot?: string; isWorktree?: boolean }>,
): string | null {
  const activeSessionId = sessionId ?? currentSessionId;
  if (!activeSessionId) return null;

  const bridgeState = sessions.get(activeSessionId);
  const sdkState = sdkSessions.find((session) => session.sessionId === activeSessionId);
  const sessionCwd = bridgeState?.cwd || sdkState?.cwd || null;
  const repoRoot = bridgeState?.repo_root || sdkState?.repoRoot || null;
  const isWorktree = bridgeState?.is_worktree || sdkState?.isWorktree || false;

  if (isWorktree && sessionCwd) {
    return sessionCwd;
  }

  return repoRoot || sessionCwd;
}

function parseFileLinkFromHref(href?: string): FileLinkTarget | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!/^file:/i.test(trimmed)) return null;

  let raw = trimmed.slice(5);
  if (!raw) return null;
  if (raw.startsWith("///")) {
    raw = raw.slice(2);
  } else if (raw.startsWith("//")) {
    const slashAt = raw.indexOf("/", 2);
    raw = slashAt >= 0 ? raw.slice(slashAt) : "/";
  }

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  let path = decoded;
  let line = 1;
  let column = 1;
  let endLine: number | undefined;

  const lineRangeMatch = decoded.match(/^(.*):(\d+)-(\d+)$/);
  if (lineRangeMatch) {
    path = lineRangeMatch[1];
    line = Number.parseInt(lineRangeMatch[2], 10);
    endLine = Number.parseInt(lineRangeMatch[3], 10);
  } else {
    const lineColMatch = decoded.match(/^(.*):(\d+):(\d+)$/);
    if (lineColMatch) {
      path = lineColMatch[1];
      line = Number.parseInt(lineColMatch[2], 10);
      column = Number.parseInt(lineColMatch[3], 10);
    } else {
      const lineOnlyMatch = decoded.match(/^(.*):(\d+)$/);
      if (lineOnlyMatch) {
        path = lineOnlyMatch[1];
        line = Number.parseInt(lineOnlyMatch[2], 10);
      }
    }
  }

  const isAbsolute = isAbsoluteFilePath(path);
  if (line < 1 || column < 1) return null;
  if (Number.isFinite(endLine) && Number(endLine) < line) return null;

  return {
    path,
    line,
    column,
    ...(Number.isFinite(endLine) ? { endLine: Number(endLine) } : {}),
    isRelative: !isAbsolute,
  };
}

function transformMarkdownUrl(url: string): string {
  if (parseQuestIdFromHref(url) || parseSessionNumFromHref(url) != null || parseFileLinkFromHref(url)) return url;
  if (/^file:/i.test(url.trim())) return "";
  // Block dangerous protocols while preserving normal links.
  const normalized = url.toLowerCase().replace(/[\u0000-\u001f\u007f\s]+/g, "");
  if (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:text/html")
  ) {
    return "";
  }
  return url;
}

export function MarkdownContent({
  text,
  size = "default",
  sessionId,
  searchHighlight,
}: {
  text: string;
  size?: "default" | "sm";
  sessionId?: string;
  searchHighlight?: { query: string; mode: "strict" | "fuzzy"; isCurrent: boolean } | null;
}) {
  const sizeClass = size === "sm" ? "text-xs" : "text-[14px] sm:text-[15px]";

  // Helper: replaces string children with HighlightedText when search is active
  const hl = searchHighlight;
  const highlightChildren = useCallback(
    (children: ReactNode): ReactNode => {
      if (!hl || !hl.query) return children;
      return Children.map(children, (child) => {
        if (typeof child === "string") {
          return <HighlightedText text={child} query={hl.query} mode={hl.mode} isCurrent={hl.isCurrent} />;
        }
        return child;
      });
    },
    [hl],
  );

  return (
    <div className={`markdown-body ${sizeClass} text-cc-fg leading-relaxed overflow-hidden break-words`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={transformMarkdownUrl}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{highlightChildren(children)}</p>,
          strong: ({ children }) => <strong className="font-semibold text-cc-fg">{highlightChildren(children)}</strong>,
          em: ({ children }) => <em className="italic">{highlightChildren(children)}</em>,
          h1: ({ children }) => (
            <h1 className="text-xl font-bold text-cc-fg mt-4 mb-2">{highlightChildren(children)}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-bold text-cc-fg mt-3 mb-2">{highlightChildren(children)}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold text-cc-fg mt-3 mb-1">{highlightChildren(children)}</h3>
          ),
          ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="text-cc-fg">{highlightChildren(children)}</li>,
          a: ({ href, children }) => {
            const questId = parseQuestIdFromHref(href);
            if (questId) {
              return <QuestMarkdownLink questId={questId}>{children}</QuestMarkdownLink>;
            }
            const sessionNum = parseSessionNumFromHref(href);
            if (sessionNum != null) {
              return <SessionMarkdownLink sessionNum={sessionNum}>{children}</SessionMarkdownLink>;
            }
            const fileTarget = parseFileLinkFromHref(href);
            if (fileTarget) {
              return (
                <FileMarkdownLink target={fileTarget} sessionId={sessionId}>
                  {children}
                </FileMarkdownLink>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:underline">
                {children}
              </a>
            );
          },
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-cc-primary/30 pl-3 my-2 text-cc-muted italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-cc-border my-4" />,
          code: (props: ComponentProps<"code">) => {
            const { children, className } = props;
            const match = /language-(\w+)/.exec(className || "");
            const isBlock = match || (typeof children === "string" && children.includes("\n"));

            if (isBlock) {
              return <CodeBlock lang={match?.[1] || ""}>{children}</CodeBlock>;
            }

            return (
              <code className="px-1 py-0.5 rounded bg-cc-code-bg/30 text-[13px] font-mono-code text-cc-primary">
                {highlightChildren(children)}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full text-sm border border-cc-border rounded-lg overflow-hidden">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-cc-code-bg/50">{children}</thead>,
          th: ({ children }) => (
            <th className="px-3 py-1.5 text-left text-xs font-semibold text-cc-fg border-b border-cc-border">
              {highlightChildren(children)}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-1.5 text-xs text-cc-fg border-b border-cc-border">{highlightChildren(children)}</td>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function QuestMarkdownLink({ questId, children }: { questId: string; children: ReactNode }) {
  const quests = useStore((s) => s.quests);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    },
    [],
  );

  const quest = useMemo(
    () => quests.find((item) => item.questId.toLowerCase() === questId.toLowerCase()) ?? null,
    [questId, quests],
  );

  const questHash = withQuestIdInHash(window.location.hash, questId);

  function handleLinkMouseEnter(e: MouseEvent<HTMLAnchorElement>) {
    if (!quest) return;
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    setHoverRect(e.currentTarget.getBoundingClientRect());
  }

  function handleLinkMouseLeave() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    hideHoverTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  function handleHoverCardEnter() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
  }

  function handleHoverCardLeave() {
    setHoverRect(null);
  }

  return (
    <>
      <a
        href={questHash}
        onClick={(e) => {
          e.preventDefault();
          useStore.getState().openQuestOverlay(questId);
        }}
        onMouseEnter={handleLinkMouseEnter}
        onMouseLeave={handleLinkMouseLeave}
        className="text-cc-primary hover:underline"
        title={`Open ${questId}`}
      >
        {children}
      </a>
      {quest && hoverRect && (
        <QuestHoverCard
          quest={quest}
          anchorRect={hoverRect}
          onMouseEnter={handleHoverCardEnter}
          onMouseLeave={handleHoverCardLeave}
        />
      )}
    </>
  );
}

function SessionMarkdownLink({ sessionNum, children }: { sessionNum: number; children: ReactNode }) {
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessionNames = useStore((s) => s.sessionNames);
  const sessionPreviews = useStore((s) => s.sessionPreviews);
  const sessionTaskHistory = useStore((s) => s.sessionTaskHistory);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const askPermission = useStore((s) => s.askPermission);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason);

  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    },
    [],
  );

  const sdkInfo = useMemo(
    () => sdkSessions.find((session) => session.sessionNum === sessionNum),
    [sdkSessions, sessionNum],
  );
  const sessionId = sdkInfo?.sessionId ?? null;

  const sessionItem = useMemo<SessionItemType | null>(() => {
    if (!sessionId) return null;

    const bridgeState = sessions.get(sessionId);
    const sdkGitAhead = sdkInfo?.gitAhead ?? 0;
    const sdkGitBehind = sdkInfo?.gitBehind ?? 0;
    const gitAhead =
      bridgeState?.git_ahead === 0 && sdkGitAhead > 0 ? sdkGitAhead : (bridgeState?.git_ahead ?? sdkGitAhead);
    const gitBehind =
      bridgeState?.git_behind === 0 && sdkGitBehind > 0 ? sdkGitBehind : (bridgeState?.git_behind ?? sdkGitBehind);

    return {
      id: sessionId,
      model: bridgeState?.model || sdkInfo?.model || "",
      cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
      gitBranch: bridgeState?.git_branch || sdkInfo?.gitBranch || "",
      isContainerized: bridgeState?.is_containerized || !!sdkInfo?.containerId || false,
      gitAhead,
      gitBehind,
      linesAdded: bridgeState?.total_lines_added ?? sdkInfo?.totalLinesAdded ?? 0,
      linesRemoved: bridgeState?.total_lines_removed ?? sdkInfo?.totalLinesRemoved ?? 0,
      isConnected: cliConnected.get(sessionId) ?? sdkInfo?.cliConnected ?? false,
      status: sessionStatus.get(sessionId) ?? null,
      sdkState: sdkInfo?.state ?? null,
      createdAt: sdkInfo?.createdAt ?? 0,
      archived: sdkInfo?.archived ?? false,
      archivedAt: sdkInfo?.archivedAt,
      backendType: bridgeState?.backend_type || sdkInfo?.backendType || "claude",
      repoRoot: bridgeState?.repo_root || sdkInfo?.repoRoot || "",
      permCount: countUserPermissions(pendingPermissions.get(sessionId)),
      cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
      cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
      isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
      worktreeExists: sdkInfo?.worktreeExists,
      worktreeDirty: sdkInfo?.worktreeDirty,
      askPermission: askPermission.get(sessionId),
      idleKilled: cliDisconnectReason.get(sessionId) === "idle_limit",
      lastActivityAt: sdkInfo?.lastActivityAt,
      isOrchestrator: sdkInfo?.isOrchestrator || false,
      herdedBy: sdkInfo?.herdedBy,
      sessionNum: sdkInfo?.sessionNum ?? null,
    };
  }, [
    askPermission,
    cliConnected,
    cliDisconnectReason,
    pendingPermissions,
    sdkInfo,
    sessionId,
    sessionStatus,
    sessions,
  ]);

  function handleLinkMouseEnter(e: MouseEvent<HTMLAnchorElement>) {
    if (!sessionItem) return;
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    setHoverRect(e.currentTarget.getBoundingClientRect());
  }

  function handleLinkMouseLeave() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    hideHoverTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  function handleHoverCardEnter() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
  }

  function handleHoverCardLeave() {
    setHoverRect(null);
  }

  const href = sessionId ? sessionHash(sessionId) : "#";

  return (
    <>
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (!sessionId) return;
          navigateToSession(sessionId);
        }}
        onMouseEnter={handleLinkMouseEnter}
        onMouseLeave={handleLinkMouseLeave}
        className={sessionId ? "text-cc-primary hover:underline" : "text-cc-muted"}
        title={sessionId ? `Open session #${sessionNum}` : `Session #${sessionNum} not found`}
      >
        {children}
      </a>
      {sessionId && sessionItem && hoverRect && (
        <SessionHoverCard
          session={sessionItem}
          sessionName={sessionNames.get(sessionId)}
          sessionPreview={sessionPreviews.get(sessionId)}
          taskHistory={sessionTaskHistory.get(sessionId)}
          sessionState={sessions.get(sessionId)}
          cliSessionId={sdkInfo?.cliSessionId}
          anchorRect={hoverRect}
          onMouseEnter={handleHoverCardEnter}
          onMouseLeave={handleHoverCardLeave}
        />
      )}
    </>
  );
}

function FileMarkdownLink({
  target,
  sessionId,
  children,
}: {
  target: FileLinkTarget;
  sessionId?: string;
  children: ReactNode;
}) {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const basePath = useMemo(
    () => getFileLinkBasePath(sessionId, currentSessionId, sessions, sdkSessions),
    [currentSessionId, sdkSessions, sessionId, sessions],
  );
  const resolvedTarget = useMemo(() => resolveFileLinkTarget(target, basePath), [basePath, target]);

  const onClick = useCallback(
    async (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      if (!resolvedTarget) return;
      let settings;
      try {
        settings = await api.getSettings();
      } catch {
        return;
      }
      try {
        await openFileWithEditorPreference(resolvedTarget, settings.editorConfig?.editor ?? "none");
      } catch (error) {
        showEditorOpenError(error instanceof Error ? error.message : String(error));
      }
    },
    [resolvedTarget],
  );

  const locationSuffix = formatFileLinkLocation(target);
  const href = `file:${target.path}${locationSuffix}`;
  const title = resolvedTarget
    ? `${target.path}${locationSuffix}`
    : `${target.path}${locationSuffix} (unable to resolve repo-relative path)`;

  return (
    <a
      href={href}
      onClick={(e) => {
        void onClick(e);
      }}
      className={resolvedTarget ? "text-cc-primary hover:underline" : "text-cc-muted"}
      title={title}
    >
      {children}
    </a>
  );
}

function CodeBlock({ lang, children }: { lang: string; children: ReactNode }) {
  const codeRef = useRef<HTMLElement>(null);
  const getText = useCallback(() => codeRef.current?.textContent ?? "", []);

  // Syntax highlight when a supported language is specified
  const highlighted = useMemo(() => {
    if (!lang) return null;
    const raw = typeof children === "string" ? children : String(children ?? "");
    // Strip trailing newline that react-markdown appends to fenced code
    const code = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    return highlightCode(code, lang);
  }, [lang, children]);

  return (
    <div className="group/code my-2 rounded-lg overflow-hidden border border-cc-border relative">
      {lang ? (
        <div className="flex items-center justify-between px-3 py-1.5 bg-cc-code-bg/80 border-b border-cc-border">
          <span className="text-[10px] text-cc-muted font-mono-code uppercase tracking-wider">{lang}</span>
          <CodeCopyButton getText={getText} />
        </div>
      ) : (
        <div className="absolute top-1.5 right-1.5 z-10">
          <CodeCopyButton getText={getText} />
        </div>
      )}
      <pre className="px-2 sm:px-3 py-2 sm:py-2.5 bg-cc-code-bg text-cc-code-fg text-[12px] sm:text-[13px] font-mono-code leading-relaxed overflow-x-auto">
        {highlighted ? (
          <code ref={codeRef} dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code ref={codeRef}>{children}</code>
        )}
      </pre>
    </div>
  );
}
