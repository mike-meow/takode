import { useRef, useCallback, useMemo, useState, useEffect, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import diff from "highlight.js/lib/languages/diff";
import markdown from "highlight.js/lib/languages/markdown";
import { api, type EditorKind } from "../api.js";
import { useStore, countUserPermissions } from "../store.js";
import { navigateToSession, sessionHash } from "../utils/routing.js";
import { SessionHoverCard } from "./SessionHoverCard.js";
import { QuestHoverCard } from "./QuestHoverCard.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { CodeCopyButton } from "./CodeCopyButton.js";
import { withQuestIdInHash } from "../utils/routing.js";

// Register languages with highlight.js (tree-shakeable core import)
hljs.registerLanguage("python", python);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", cpp);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
// Aliases for common fence tags
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("py", python);

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
  absolutePath: string;
  line: number;
  column: number;
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

  const isAbsolute =
    path.startsWith("/")
    || /^\/[A-Za-z]:\//.test(path)
    || /^[A-Za-z]:[\\/]/.test(path);
  if (!isAbsolute || line < 1 || column < 1) return null;

  return { absolutePath: path, line, column };
}

function buildEditorUri(target: FileLinkTarget, editor: EditorKind): string | null {
  if (editor === "none") return null;
  const scheme = editor === "cursor" ? "cursor" : "vscode";
  return `${scheme}://file/${encodeURI(target.absolutePath)}:${target.line}:${target.column}`;
}

function transformMarkdownUrl(url: string): string {
  if (parseQuestIdFromHref(url) || parseSessionNumFromHref(url) != null || parseFileLinkFromHref(url)) return url;
  if (/^file:/i.test(url.trim())) return "";
  // Block dangerous protocols while preserving normal links.
  const normalized = url.toLowerCase().replace(/[\u0000-\u001f\u007f\s]+/g, "");
  if (
    normalized.startsWith("javascript:")
    || normalized.startsWith("vbscript:")
    || normalized.startsWith("data:text/html")
  ) {
    return "";
  }
  return url;
}

export function MarkdownContent({ text, size = "default" }: { text: string; size?: "default" | "sm" }) {
  const sizeClass = size === "sm"
    ? "text-xs"
    : "text-[14px] sm:text-[15px]";

  return (
    <div className={`markdown-body ${sizeClass} text-cc-fg leading-relaxed overflow-hidden`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={transformMarkdownUrl}
        components={{
          p: ({ children }) => (
            <p className="mb-3 last:mb-0">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-cc-fg">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic">{children}</em>
          ),
          h1: ({ children }) => (
            <h1 className="text-xl font-bold text-cc-fg mt-4 mb-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-bold text-cc-fg mt-3 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold text-cc-fg mt-3 mb-1">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-cc-fg">{children}</li>
          ),
          a: ({ href, children }) => {
            const questId = parseQuestIdFromHref(href);
            if (questId) {
              return (
                <QuestMarkdownLink questId={questId}>
                  {children}
                </QuestMarkdownLink>
              );
            }
            const sessionNum = parseSessionNumFromHref(href);
            if (sessionNum != null) {
              return (
                <SessionMarkdownLink sessionNum={sessionNum}>
                  {children}
                </SessionMarkdownLink>
              );
            }
            const fileTarget = parseFileLinkFromHref(href);
            if (fileTarget) {
              return (
                <FileMarkdownLink target={fileTarget}>
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
          hr: () => (
            <hr className="border-cc-border my-4" />
          ),
          code: (props: ComponentProps<"code">) => {
            const { children, className } = props;
            const match = /language-(\w+)/.exec(className || "");
            const isBlock = match || (typeof children === "string" && children.includes("\n"));

            if (isBlock) {
              return <CodeBlock lang={match?.[1] || ""}>{children}</CodeBlock>;
            }

            return (
              <code className="px-1 py-0.5 rounded bg-cc-code-bg/30 text-[13px] font-mono-code text-cc-primary">
                {children}
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
          thead: ({ children }) => (
            <thead className="bg-cc-code-bg/50">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-3 py-1.5 text-left text-xs font-semibold text-cc-fg border-b border-cc-border">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-1.5 text-xs text-cc-fg border-b border-cc-border">
              {children}
            </td>
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

  useEffect(() => () => {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
  }, []);

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
          const nextHash = withQuestIdInHash(window.location.hash, questId);
          window.location.hash = nextHash.startsWith("#") ? nextHash.slice(1) : nextHash;
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

  useEffect(() => () => {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
  }, []);

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
    const gitAhead = bridgeState?.git_ahead === 0 && sdkGitAhead > 0
      ? sdkGitAhead
      : (bridgeState?.git_ahead ?? sdkGitAhead);
    const gitBehind = bridgeState?.git_behind === 0 && sdkGitBehind > 0
      ? sdkGitBehind
      : (bridgeState?.git_behind ?? sdkGitBehind);

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

function FileMarkdownLink({ target, children }: { target: FileLinkTarget; children: ReactNode }) {
  const onClick = useCallback(async (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    let settings;
    try {
      settings = await api.getSettings();
    } catch {
      return;
    }
    const uri = buildEditorUri(target, settings.editorConfig?.editor ?? "none");
    if (!uri) return;
    window.open(uri, "_blank", "noopener,noreferrer");
  }, [target]);

  return (
    <a
      href={`file:${target.absolutePath}:${target.line}:${target.column}`}
      onClick={(e) => { void onClick(e); }}
      className="text-cc-primary hover:underline"
      title={`${target.absolutePath}:${target.line}:${target.column}`}
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
    try {
      if (hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
    } catch { /* fall through to plain text */ }
    return null;
  }, [lang, children]);

  return (
    <div className="group/code my-2 rounded-lg overflow-hidden border border-cc-border relative">
      {lang ? (
        <div className="flex items-center justify-between px-3 py-1.5 bg-cc-code-bg/80 border-b border-cc-border">
          <span className="text-[10px] text-cc-muted font-mono-code uppercase tracking-wider">
            {lang}
          </span>
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
