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
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { QuestInlineLink } from "./QuestInlineLink.js";
import { CodeCopyButton } from "./CodeCopyButton.js";
import { highlightCode } from "../utils/syntax-highlighting.js";
import { openFileWithEditorPreference, showEditorOpenError } from "../utils/vscode-bridge.js";
import { HighlightedText } from "./HighlightedText.js";
import { SessionInlineLink } from "./SessionInlineLink.js";
import { splitPlainTakodeReferences } from "./composer-reference-utils.js";

interface MarkdownAstNode {
  type: string;
  children?: MarkdownAstNode[];
  ordered?: boolean;
  start?: number | null;
  spread?: boolean;
  value?: string;
  url?: string;
  title?: string | null;
}

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

interface SessionLinkTarget {
  sessionNum: number;
  messageIndex?: number;
}

function parseSessionLinkFromHref(href?: string): SessionLinkTarget | null {
  if (!href) return null;
  const trimmed = href.trim();

  // session:304:1195 or session:304 (with optional // prefix)
  const match = trimmed.match(/^session:(?:\/\/)?(\d+)(?::(\d+))?$/i);
  if (!match) return null;

  const sessionNum = parseInt(match[1], 10);
  const messageIndex = match[2] != null ? parseInt(match[2], 10) : undefined;
  return { sessionNum, messageIndex };
}

function isMarkdownList(
  node: MarkdownAstNode | undefined,
  ordered: boolean,
): node is MarkdownAstNode & { type: "list"; children: MarkdownAstNode[]; ordered: boolean } {
  return Boolean(node && node.type === "list" && node.ordered === ordered && Array.isArray(node.children));
}

function isMarkdownListItem(
  node: MarkdownAstNode | undefined,
): node is MarkdownAstNode & { type: "listItem"; children: MarkdownAstNode[] } {
  return Boolean(node && node.type === "listItem" && Array.isArray(node.children));
}

function appendListToLastItem(targetList: MarkdownAstNode, nestedList: MarkdownAstNode): boolean {
  const lastItem = targetList.children?.[targetList.children.length - 1];
  if (!isMarkdownListItem(lastItem)) return false;
  lastItem.children = [...lastItem.children, nestedList];
  targetList.spread = Boolean(targetList.spread || nestedList.spread);
  return true;
}

function mergeOrderedListContinuations(children: MarkdownAstNode[]): void {
  let index = 0;
  while (index < children.length) {
    const current = children[index];
    if (!isMarkdownList(current, true)) {
      index += 1;
      continue;
    }

    let cursor = index + 1;
    let didMerge = false;

    while (true) {
      const bulletList = children[cursor];
      const nextOrderedList = children[cursor + 1];
      if (
        !isMarkdownList(bulletList, false) ||
        !isMarkdownList(nextOrderedList, true) ||
        (nextOrderedList.start != null && nextOrderedList.start !== 1)
      ) {
        break;
      }

      if (!appendListToLastItem(current, bulletList)) break;

      current.children = [...current.children, ...nextOrderedList.children];
      current.spread = Boolean(current.spread || nextOrderedList.spread);
      cursor += 2;
      didMerge = true;
    }

    if (!didMerge) {
      index += 1;
      continue;
    }

    while (isMarkdownList(children[cursor], false)) {
      if (!appendListToLastItem(current, children[cursor])) break;
      cursor += 1;
    }

    children.splice(index + 1, cursor - (index + 1));
  }
}

function normalizeOrderedListContinuations(node: MarkdownAstNode): void {
  if (!Array.isArray(node.children) || node.children.length === 0) return;

  for (const child of node.children) {
    normalizeOrderedListContinuations(child);
  }

  mergeOrderedListContinuations(node.children);
}

function remarkNormalizeOrderedListContinuations() {
  return (tree: MarkdownAstNode) => {
    normalizeOrderedListContinuations(tree);
  };
}

function transformPlainTakodeReferences(node: MarkdownAstNode): void {
  if (!Array.isArray(node.children) || shouldSkipPlainTakodeReferenceChildren(node)) return;

  const nextChildren: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (child.type !== "text" || typeof child.value !== "string") {
      transformPlainTakodeReferences(child);
      nextChildren.push(child);
      continue;
    }

    const segments = splitPlainTakodeReferences(child.value);
    if (segments.length === 1 && segments[0]?.kind === "text") {
      nextChildren.push(child);
      continue;
    }

    for (const segment of segments) {
      if (segment.kind === "text") {
        if (segment.text) nextChildren.push({ type: "text", value: segment.text });
        continue;
      }

      nextChildren.push({
        type: "link",
        url: segment.kind === "quest" ? `quest:${segment.questId}` : `session:${segment.sessionNum}`,
        title: null,
        children: [{ type: "text", value: segment.text }],
      });
    }
  }

  node.children = nextChildren;
}

function shouldSkipPlainTakodeReferenceChildren(node: MarkdownAstNode): boolean {
  return (
    node.type === "link" ||
    node.type === "linkReference" ||
    node.type === "definition" ||
    node.type === "code" ||
    node.type === "inlineCode"
  );
}

function remarkPlainTakodeReferences() {
  return (tree: MarkdownAstNode) => {
    transformPlainTakodeReferences(tree);
  };
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
  fallbackAbsolutePath?: string;
  line: number;
  column: number;
  endLine?: number;
}

interface FileLinkBaseContext {
  cwd: string | null;
  repoRoot: string | null;
  isWorktree: boolean;
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

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function getPathBasename(path: string | null): string | null {
  if (!path) return null;
  const normalized = normalizePathSeparators(path).replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) || null : normalized || null;
}

function getCurrentFileLinkRoot(base: FileLinkBaseContext): string | null {
  if (base.isWorktree && base.cwd) return base.cwd;
  return base.repoRoot || base.cwd;
}

function parseStaleWorktreePath(targetPath: string): { staleRepoName: string; relativeWithinRepo: string } | null {
  const normalizedTarget = normalizePathSeparators(targetPath);
  const match = normalizedTarget.match(/^(.+\/\.companion\/worktrees\/([^/]+)\/[^/]+)(\/.+)$/);
  if (!match) return null;

  return { staleRepoName: match[2], relativeWithinRepo: match[3] };
}

function remapStaleWorktreePath(
  targetPath: string,
  root: string | null,
  expectedRepoName: string | null,
): string | null {
  if (!root || !expectedRepoName) return null;

  const parsed = parseStaleWorktreePath(targetPath);
  if (!parsed) return null;
  const { staleRepoName, relativeWithinRepo } = parsed;
  if (staleRepoName !== expectedRepoName) return null;

  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return `${normalizedRoot}${relativeWithinRepo}`;
}

function resolveFileLinkTarget(target: FileLinkTarget, base: FileLinkBaseContext): ResolvedFileLinkTarget | null {
  if (!target.isRelative) {
    const currentRoot = getCurrentFileLinkRoot(base);
    const repoName = getPathBasename(base.repoRoot) || getPathBasename(base.cwd);
    const remappedAbsolutePath = remapStaleWorktreePath(target.path, currentRoot, repoName);
    const repoRootFallback = remapStaleWorktreePath(target.path, base.repoRoot, getPathBasename(base.repoRoot));
    return {
      absolutePath: remappedAbsolutePath || target.path,
      ...(repoRootFallback && repoRootFallback !== remappedAbsolutePath && repoRootFallback !== target.path
        ? { fallbackAbsolutePath: repoRootFallback }
        : {}),
      line: target.line,
      column: target.column,
      ...(Number.isFinite(target.endLine) ? { endLine: Number(target.endLine) } : {}),
    };
  }

  const normalizedRelativePath = normalizeRepoRelativePath(target.path);
  const repoRoot = getCurrentFileLinkRoot(base);
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
): FileLinkBaseContext {
  const activeSessionId = sessionId ?? currentSessionId;
  if (!activeSessionId) {
    return { cwd: null, repoRoot: null, isWorktree: false };
  }

  const bridgeState = sessions.get(activeSessionId);
  const sdkState = sdkSessions.find((session) => session.sessionId === activeSessionId);
  const sessionCwd = bridgeState?.cwd || sdkState?.cwd || null;
  const repoRoot = bridgeState?.repo_root || sdkState?.repoRoot || null;
  const isWorktree = bridgeState?.is_worktree || sdkState?.isWorktree || false;

  return { cwd: sessionCwd, repoRoot, isWorktree };
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

function parseStandardFileLinkFromHref(href?: string): FileLinkTarget | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || /^file:/i.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) return null;

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }

  const hashIndex = decoded.indexOf("#");
  const queryIndex = decoded.indexOf("?");
  const endIndex = Math.min(...[hashIndex, queryIndex].filter((index) => index >= 0), decoded.length);
  const rawPath = decoded.slice(0, endIndex);
  const fragment = hashIndex >= 0 ? decoded.slice(hashIndex + 1).split("?")[0] : "";
  const target = parseFilePathLocation(rawPath, parseLineFragment(fragment));
  if (!target || !looksLikeLocalFilePath(target.path) || hasUnsafePathTraversal(target.path)) return null;
  return target;
}

function parseFilePathLocation(rawPath: string, fragmentLocation?: Partial<FileLinkTarget>): FileLinkTarget | null {
  let path = rawPath.replace(/^\.\//, "");
  if (!path) return null;
  let line = fragmentLocation?.line ?? 1;
  let column = fragmentLocation?.column ?? 1;
  let endLine = fragmentLocation?.endLine;

  if (!fragmentLocation?.line) {
    const lineRangeMatch = path.match(/^(.*):(\d+)-(\d+)$/);
    const lineColMatch = path.match(/^(.*):(\d+):(\d+)$/);
    const lineOnlyMatch = path.match(/^(.*):(\d+)$/);
    const match = lineRangeMatch || lineColMatch || lineOnlyMatch;
    if (match) {
      path = match[1];
      line = Number.parseInt(match[2], 10);
      if (lineRangeMatch) endLine = Number.parseInt(lineRangeMatch[3], 10);
      if (lineColMatch) column = Number.parseInt(lineColMatch[3], 10);
    }
  }

  if (line < 1 || column < 1) return null;
  if (Number.isFinite(endLine) && Number(endLine) < line) return null;
  return {
    path,
    line,
    column,
    ...(Number.isFinite(endLine) ? { endLine: Number(endLine) } : {}),
    isRelative: !isAbsoluteFilePath(path),
  };
}

function parseLineFragment(fragment: string): Partial<FileLinkTarget> | undefined {
  const match = fragment.match(/^L(\d+)(?:-L?(\d+))?$/i);
  if (!match) return undefined;
  const line = Number.parseInt(match[1], 10);
  const endLine = match[2] ? Number.parseInt(match[2], 10) : undefined;
  return { line, column: 1, ...(Number.isFinite(endLine) ? { endLine } : {}) };
}

function looksLikeLocalFilePath(path: string): boolean {
  const basename = getPathBasename(path);
  const extensionlessFiles = new Set(["readme", "makefile", "dockerfile", "claude", "agents"]);
  return Boolean(basename && (basename.includes(".") || extensionlessFiles.has(basename.toLowerCase())));
}

function hasUnsafePathTraversal(path: string): boolean {
  return normalizePathSeparators(path)
    .split("/")
    .some((part) => part === "..");
}

function transformMarkdownUrl(url: string): string {
  if (parseQuestIdFromHref(url) || parseSessionLinkFromHref(url) != null || parseFileLinkFromHref(url)) return url;
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

function MarkdownTable({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <table
      className={
        compact
          ? "min-w-full text-sm border border-cc-border rounded-lg overflow-hidden"
          : "min-w-full text-sm border border-cc-border rounded-xl overflow-hidden bg-cc-card shadow-[0_0_0_1px_rgba(255,255,255,0.03)]"
      }
    >
      {children}
    </table>
  );
}

function MarkdownTableDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prev;
    };
  }, [handleKeyDown]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-3 py-4 sm:px-6"
      onClick={onClose}
      data-testid="markdown-table-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Expanded table view"
        className="h-[calc(100vh-2rem)] w-[calc(100vw-1.5rem)] max-w-none rounded-2xl border border-cc-border bg-cc-bg shadow-2xl overflow-hidden flex flex-col sm:h-[calc(100vh-3rem)] sm:w-[calc(100vw-3rem)]"
        onClick={(e) => e.stopPropagation()}
        data-testid="markdown-table-dialog"
      >
        <div className="flex items-center justify-between gap-3 border-b border-cc-border bg-cc-card px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-cc-fg">Table View</div>
            <div className="text-xs text-cc-muted">Expanded to use the full page width.</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-cc-muted hover:bg-cc-hover hover:text-cc-fg transition-colors cursor-pointer"
            aria-label="Close table view"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3 sm:px-4">
          <MarkdownTable>{children}</MarkdownTable>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MarkdownTableWithViewer({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div className="my-2">
        <div className="mb-1.5 flex items-center justify-end">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cc-border bg-cc-card px-2.5 py-1 text-[11px] font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            data-testid="markdown-table-expand"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
              <path d="M6 2H3.5A1.5 1.5 0 002 3.5V6M10 2h2.5A1.5 1.5 0 0114 3.5V6M14 10v2.5A1.5 1.5 0 0112.5 14H10M6 14H3.5A1.5 1.5 0 012 12.5V10" />
            </svg>
            <span>View table</span>
          </button>
        </div>
        <div className="overflow-x-auto">
          <MarkdownTable compact>{children}</MarkdownTable>
        </div>
      </div>
      {expanded && <MarkdownTableDialog onClose={() => setExpanded(false)}>{children}</MarkdownTableDialog>}
    </>
  );
}

export function MarkdownContent({
  text,
  size = "default",
  variant = "full",
  sessionId,
  searchHighlight,
  enableChatSelectionMenu = false,
  wrapLongContent = false,
}: {
  text: string;
  size?: "default" | "sm";
  variant?: "full" | "conservative";
  sessionId?: string;
  searchHighlight?: { query: string; mode: "strict" | "fuzzy"; isCurrent: boolean } | null;
  enableChatSelectionMenu?: boolean;
  wrapLongContent?: boolean;
}) {
  const sizeClass =
    size === "sm"
      ? "text-xs"
      : variant === "conservative"
        ? "text-[13px] sm:text-[14px]"
        : "text-[14px] sm:text-[15px]";

  const isConservative = variant === "conservative";

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
    <div
      className={`markdown-body ${sizeClass} text-cc-fg leading-relaxed overflow-hidden break-words ${
        wrapLongContent ? "min-w-0 max-w-full [overflow-wrap:anywhere]" : ""
      }`}
      data-chat-selection-scope={enableChatSelectionMenu ? "true" : undefined}
    >
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkNormalizeOrderedListContinuations, remarkPlainTakodeReferences]}
        urlTransform={transformMarkdownUrl}
        disallowedElements={
          isConservative
            ? ["h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "hr", "img"]
            : undefined
        }
        unwrapDisallowed={isConservative}
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
          ol: ({ children, start }) => (
            <ol start={start} className="list-decimal pl-5 mb-3 space-y-1">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="text-cc-fg">{highlightChildren(children)}</li>,
          a: ({ href, children }) => {
            const questId = parseQuestIdFromHref(href);
            if (questId) {
              return (
                <QuestMarkdownLink questId={questId} wrapLongContent={wrapLongContent}>
                  {children}
                </QuestMarkdownLink>
              );
            }
            const sessionLink = parseSessionLinkFromHref(href);
            if (sessionLink != null) {
              return (
                <SessionMarkdownLink
                  sessionNum={sessionLink.sessionNum}
                  messageIndex={sessionLink.messageIndex}
                  wrapLongContent={wrapLongContent}
                >
                  {children}
                </SessionMarkdownLink>
              );
            }
            const fileTarget = parseFileLinkFromHref(href);
            if (fileTarget) {
              return (
                <FileMarkdownLink target={fileTarget} sessionId={sessionId} wrapLongContent={wrapLongContent}>
                  {children}
                </FileMarkdownLink>
              );
            }
            const standardFileTarget = parseStandardFileLinkFromHref(href);
            if (standardFileTarget) {
              return (
                <FileMarkdownLink target={standardFileTarget} sessionId={sessionId} wrapLongContent={wrapLongContent}>
                  {children}
                </FileMarkdownLink>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={`text-cc-primary hover:underline ${
                  wrapLongContent ? "break-words [overflow-wrap:anywhere]" : ""
                }`}
              >
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
              return (
                <CodeBlock lang={match?.[1] || ""} wrapLongContent={wrapLongContent}>
                  {children}
                </CodeBlock>
              );
            }

            return (
              <code
                className={`px-1 py-0.5 rounded bg-cc-code-bg/30 text-[13px] font-mono-code text-cc-primary ${
                  wrapLongContent ? "whitespace-normal break-all" : ""
                }`}
              >
                {highlightChildren(children)}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => <MarkdownTableWithViewer>{children}</MarkdownTableWithViewer>,
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

function QuestMarkdownLink({
  questId,
  children,
  wrapLongContent,
}: {
  questId: string;
  children: ReactNode;
  wrapLongContent: boolean;
}) {
  const className = `text-cc-primary hover:underline ${wrapLongContent ? "break-words [overflow-wrap:anywhere]" : ""}`;
  return (
    <QuestInlineLink questId={questId} className={className}>
      {children}
    </QuestInlineLink>
  );
}

function SessionMarkdownLink({
  sessionNum,
  messageIndex,
  children,
  wrapLongContent,
}: {
  sessionNum: number;
  messageIndex?: number;
  children: ReactNode;
  wrapLongContent: boolean;
}) {
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessionId = useMemo(
    () => sdkSessions.find((session) => session.sessionNum === sessionNum)?.sessionId ?? null,
    [sdkSessions, sessionNum],
  );

  return (
    <SessionInlineLink
      sessionId={sessionId}
      sessionNum={sessionNum}
      messageIndex={messageIndex}
      className={`text-cc-primary hover:underline ${wrapLongContent ? "break-words [overflow-wrap:anywhere]" : ""}`}
    >
      {children}
    </SessionInlineLink>
  );
}

function FileMarkdownLink({
  target,
  sessionId,
  children,
  wrapLongContent,
}: {
  target: FileLinkTarget;
  sessionId?: string;
  children: ReactNode;
  wrapLongContent: boolean;
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
      let openTarget = resolvedTarget;
      let settings;
      try {
        settings = await api.getSettings();
      } catch {
        return;
      }
      if (resolvedTarget.fallbackAbsolutePath) {
        try {
          await api.readFile(resolvedTarget.absolutePath);
        } catch {
          openTarget = {
            ...resolvedTarget,
            absolutePath: resolvedTarget.fallbackAbsolutePath,
          };
        }
      }
      try {
        const { absolutePath, line, column, endLine } = openTarget;
        await openFileWithEditorPreference(
          {
            absolutePath,
            line,
            column,
            ...(Number.isFinite(endLine) ? { endLine } : {}),
          },
          settings.editorConfig?.editor ?? "none",
        );
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
      className={`${resolvedTarget ? "text-cc-primary hover:underline" : "text-cc-muted"} ${
        wrapLongContent ? "break-words [overflow-wrap:anywhere]" : ""
      }`}
      title={title}
    >
      {children}
    </a>
  );
}

function CodeBlock({
  lang,
  children,
  wrapLongContent,
}: {
  lang: string;
  children: ReactNode;
  wrapLongContent: boolean;
}) {
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
      <pre
        className={`px-2 sm:px-3 py-2 sm:py-2.5 bg-cc-code-bg text-cc-code-fg text-[12px] sm:text-[13px] font-mono-code leading-relaxed ${
          wrapLongContent
            ? "overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            : "overflow-x-auto"
        }`}
      >
        {highlighted ? (
          <code ref={codeRef} dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code ref={codeRef}>{children}</code>
        )}
      </pre>
    </div>
  );
}
