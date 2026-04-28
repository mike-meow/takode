import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import * as Diff from "diff";
import { buildHighlightedLines, inferLanguageFromPath, splitSourceToLines } from "../utils/syntax-highlighting.js";

export interface DiffViewerProps {
  /** Original text (for computing diff from old/new) */
  oldText?: string;
  /** New text (for computing diff from old/new) */
  newText?: string;
  /** Pre-computed unified diff string (e.g. from git diff) */
  unifiedDiff?: string;
  /** File name/path for the header */
  fileName?: string;
  /** Optional stats text shown in the file header (e.g. +10 -2) */
  fileStatsLabel?: string;
  /** compact = inline in chat (capped height, no line numbers), full = panel (scrollable, line numbers) */
  mode?: "compact" | "full";
  /** Explicit control over line numbers. When omitted, defaults to true for "full" mode, false for "compact". */
  showLineNumbers?: boolean;
  /** Optional label for the compact-mode modal trigger. */
  expandButtonLabel?: string;
  /** Optional actions rendered in the file header. */
  headerActions?: ReactNode;
  /** Optional callback for rendering file-specific header actions. */
  renderHeaderActions?: (fileName: string) => ReactNode;
  /** Keep file headers pinned when a parent container handles scrolling. */
  stickyFileHeaders?: boolean;
  /** Allow each rendered file section to be collapsed locally. */
  collapsibleFiles?: boolean;
}

interface DiffLine {
  type: "add" | "del" | "context";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
  /** Word-level changes for highlighted rendering */
  wordChanges?: { value: string; added?: boolean; removed?: boolean }[];
}

interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface ParsedFileDiff {
  fileName: string;
  hunks: DiffHunk[];
}

type RenderBlock = { type: "hunk"; key: string; hunk: DiffHunk } | { type: "gap"; key: string; lines: DiffLine[] };

interface HighlightedLineMaps {
  oldLines: string[] | null;
  newLines: string[] | null;
}

const GAP_EXPAND_CHUNK = 50;
const MAX_VISIBLE_DIR_SEGMENTS = 2;

export function formatFileHeaderPath(fileName: string): { dirLabel: string; baseLabel: string } {
  const normalized = fileName.replace(/\\/g, "/");
  const hasLeadingSlash = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  const baseLabel = parts.pop() || normalized;

  if (parts.length === 0) {
    return { dirLabel: "", baseLabel };
  }

  const truncated = parts.length > MAX_VISIBLE_DIR_SEGMENTS;
  const visibleParts = truncated ? ["...", ...parts.slice(-MAX_VISIBLE_DIR_SEGMENTS)] : parts;
  let dirLabel = `${visibleParts.join("/")}/`;
  if (hasLeadingSlash && !truncated) {
    dirLabel = `/${dirLabel}`;
  }

  return { dirLabel, baseLabel };
}

function normalizeTextForLogicalLineDiff(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function parsePatchToHunks(oldText: string, newText: string): DiffHunk[] {
  const patch = Diff.structuredPatch(
    "",
    "",
    normalizeTextForLogicalLineDiff(oldText),
    normalizeTextForLogicalLineDiff(newText),
    "",
    "",
    { context: 3 },
  );
  return patch.hunks.map((hunk) => {
    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    const rawLines: DiffLine[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const raw of hunk.lines) {
      if (raw === "\\ No newline at end of file") {
        continue;
      }
      const prefix = raw[0];
      const content = raw.slice(1);
      if (prefix === "-") {
        rawLines.push({ type: "del", content, oldLineNo: oldLine++ });
      } else if (prefix === "+") {
        rawLines.push({ type: "add", content, newLineNo: newLine++ });
      } else {
        rawLines.push({ type: "context", content, oldLineNo: oldLine++, newLineNo: newLine++ });
      }
    }

    const lines = normalizeAdjacentChangeBlocks(rawLines);

    // Compute word-level diffs for adjacent del/add pairs.
    addWordHighlights(lines);

    return {
      header,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines,
    };
  });
}

function parseUnifiedDiffToFiles(diffStr: string, fallbackFileName = ""): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  const diffLines = diffStr.split("\n");
  let currentFile: ParsedFileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffLines) {
    if (line.startsWith("diff --git") || line.startsWith("diff --cc")) {
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      if (currentFile) files.push(currentFile);
      currentFile = { fileName: "", hunks: [] };
      currentHunk = null;
      continue;
    }
    if (line.startsWith("--- a/") || line.startsWith("--- /dev/null")) {
      if (!currentFile) currentFile = { fileName: fallbackFileName, hunks: [] };
      continue;
    }
    if (line.startsWith("+++ b/")) {
      if (!currentFile) currentFile = { fileName: fallbackFileName, hunks: [] };
      if (currentFile) currentFile.fileName = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      if (!currentFile) currentFile = { fileName: fallbackFileName, hunks: [] };
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("similarity index") ||
      line.startsWith("Binary files")
    ) {
      continue;
    }

    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
    if (hunkMatch) {
      if (!currentFile) currentFile = { fileName: fallbackFileName, hunks: [] };
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldLines = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newLines = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;
      oldLine = oldStart;
      newLine = newStart;
      currentHunk = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1), newLineNo: newLine++ });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", content: line.slice(1), oldLineNo: oldLine++ });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
    } else if (line === "\\ No newline at end of file") {
      // Skip metadata line.
    }
  }

  if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
  if (currentFile) {
    if (!currentFile.fileName && fallbackFileName) currentFile.fileName = fallbackFileName;
    files.push(currentFile);
  }

  if (files.length === 0) {
    const rawFallback = parseRawChangeLinesToFiles(diffStr, fallbackFileName);
    if (rawFallback.length > 0) return rawFallback;
  }

  // Add word highlights.
  for (const file of files) {
    for (const hunk of file.hunks) {
      hunk.lines = normalizeAdjacentChangeBlocks(hunk.lines);
      addWordHighlights(hunk.lines);
    }
  }

  return files;
}

function parseRawChangeLinesToFiles(diffStr: string, fallbackFileName = ""): ParsedFileDiff[] {
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const line of diffStr.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "\\ No newline at end of file") continue;

    if (line.startsWith("+")) {
      lines.push({ type: "add", content: line.slice(1), newLineNo: newLine++ });
      continue;
    }

    if (line.startsWith("-")) {
      lines.push({ type: "del", content: line.slice(1), oldLineNo: oldLine++ });
      continue;
    }

    if (line.startsWith(" ")) {
      lines.push({ type: "context", content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
    }
  }

  if (!lines.some((line) => line.type === "add" || line.type === "del")) {
    return [];
  }

  const normalized = normalizeAdjacentChangeBlocks(lines);
  addWordHighlights(normalized);

  return [
    {
      fileName: fallbackFileName,
      hunks: [
        {
          header: "",
          oldStart: 1,
          oldLines: Math.max(0, oldLine - 1),
          newStart: 1,
          newLines: Math.max(0, newLine - 1),
          lines: normalized,
        },
      ],
    },
  ];
}

function normalizeAdjacentChangeBlocks(lines: DiffLine[]): DiffLine[] {
  const normalized: DiffLine[] = [];
  let i = 0;

  while (i < lines.length) {
    const delStart = i;
    while (i < lines.length && lines[i].type === "del") i++;
    const delEnd = i;

    const addStart = i;
    while (i < lines.length && lines[i].type === "add") i++;
    const addEnd = i;

    const delBlock = lines.slice(delStart, delEnd);
    const addBlock = lines.slice(addStart, addEnd);

    if (delBlock.length > 0 && addBlock.length > 0) {
      const lineDiff = Diff.diffArrays(
        delBlock.map((line) => line.content),
        addBlock.map((line) => line.content),
      );
      let delIdx = 0;
      let addIdx = 0;

      for (const part of lineDiff) {
        if (part.removed) {
          for (let j = 0; j < part.value.length; j++) {
            normalized.push(delBlock[delIdx++]);
          }
          continue;
        }
        if (part.added) {
          for (let j = 0; j < part.value.length; j++) {
            normalized.push(addBlock[addIdx++]);
          }
          continue;
        }
        for (let j = 0; j < part.value.length; j++) {
          const oldLine = delBlock[delIdx++];
          const newLine = addBlock[addIdx++];
          normalized.push({
            type: "context",
            content: newLine.content,
            oldLineNo: oldLine.oldLineNo,
            newLineNo: newLine.newLineNo,
          });
        }
      }
      continue;
    }

    if (delBlock.length > 0) {
      normalized.push(...delBlock);
      continue;
    }
    if (addBlock.length > 0) {
      normalized.push(...addBlock);
      continue;
    }

    normalized.push(lines[i]);
    i++;
  }

  return normalized;
}

/** Add word-level diff highlights to adjacent del/add line pairs. */
function addWordHighlights(lines: DiffLine[]) {
  let i = 0;
  while (i < lines.length) {
    const delStart = i;
    while (i < lines.length && lines[i].type === "del") i++;
    const delEnd = i;

    const addStart = i;
    while (i < lines.length && lines[i].type === "add") i++;
    const addEnd = i;

    const delCount = delEnd - delStart;
    const addCount = addEnd - addStart;
    if (delCount > 0 && addCount > 0) {
      const pairCount = Math.min(delCount, addCount);
      for (let j = 0; j < pairCount; j++) {
        const delLine = lines[delStart + j];
        const addLine = lines[addStart + j];
        const wordDiff = Diff.diffWords(delLine.content, addLine.content);

        delLine.wordChanges = wordDiff
          .filter((part) => !part.added)
          .map((part) => ({ value: part.value, removed: part.removed }));
        addLine.wordChanges = wordDiff
          .filter((part) => !part.removed)
          .map((part) => ({ value: part.value, added: part.added }));
      }
    }

    if (i === delStart) i++;
  }
}

function getLineHtml(line: DiffLine, highlighted: HighlightedLineMaps): string | null {
  if (line.type === "del") {
    if (line.oldLineNo == null || !highlighted.oldLines) return null;
    return highlighted.oldLines[line.oldLineNo - 1] ?? "";
  }
  if (line.newLineNo == null || !highlighted.newLines) return null;
  return highlighted.newLines[line.newLineNo - 1] ?? "";
}

function LineContent({ line, highlightedHtml }: { line: DiffLine; highlightedHtml: string | null }) {
  if (highlightedHtml !== null) {
    if (!highlightedHtml) return <>&nbsp;</>;
    return <span dangerouslySetInnerHTML={{ __html: highlightedHtml }} />;
  }

  if (line.wordChanges) {
    return (
      <>
        {line.wordChanges.map((part, i) => {
          if (part.added) {
            return (
              <span key={i} className="diff-word-add">
                {part.value}
              </span>
            );
          }
          if (part.removed) {
            return (
              <span key={i} className="diff-word-del">
                {part.value}
              </span>
            );
          }
          return <span key={i}>{part.value}</span>;
        })}
      </>
    );
  }

  if (!line.content) {
    return <>&nbsp;</>;
  }

  return <>{line.content}</>;
}

function DiffLineRow({
  line,
  showLineNumbers,
  highlightedHtml,
}: {
  line: DiffLine;
  showLineNumbers: boolean;
  highlightedHtml: string | null;
}) {
  return (
    <div className={`diff-line diff-line-${line.type}`}>
      {showLineNumbers && (
        <>
          <span className="diff-gutter diff-gutter-old">{line.oldLineNo ?? ""}</span>
          <span className="diff-gutter diff-gutter-new">{line.newLineNo ?? ""}</span>
        </>
      )}
      <span className="diff-marker">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
      <span className="diff-content">
        <LineContent line={line} highlightedHtml={highlightedHtml} />
      </span>
    </div>
  );
}

function HunkBlock({
  hunk,
  showLineNumbers,
  highlighted,
}: {
  hunk: DiffHunk;
  showLineNumbers: boolean;
  highlighted: HighlightedLineMaps;
}) {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{hunk.header}</div>
      {hunk.lines.map((line, i) => (
        <DiffLineRow
          key={i}
          line={line}
          showLineNumbers={showLineNumbers}
          highlightedHtml={getLineHtml(line, highlighted)}
        />
      ))}
    </div>
  );
}

function buildRenderBlocks(
  hunks: DiffHunk[],
  oldSourceLines: string[] | null,
  newSourceLines: string[] | null,
): RenderBlock[] {
  const hasSource = !!oldSourceLines?.length && !!newSourceLines?.length;
  const blocks: RenderBlock[] = [];
  let prevOld = 1;
  let prevNew = 1;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    const gapOld = hunk.oldStart - prevOld;
    const gapNew = hunk.newStart - prevNew;

    if (gapOld > 0 && gapNew > 0 && gapOld === gapNew) {
      const lines: DiffLine[] = [];
      for (let j = 0; j < gapOld; j++) {
        const oldLineNo = prevOld + j;
        const newLineNo = prevNew + j;
        lines.push({
          type: "context",
          content: hasSource ? (newSourceLines![newLineNo - 1] ?? oldSourceLines![oldLineNo - 1] ?? "") : "",
          oldLineNo,
          newLineNo,
        });
      }
      blocks.push({ type: "gap", key: `gap-${i}`, lines });
    }

    blocks.push({ type: "hunk", key: `hunk-${i}`, hunk });
    prevOld = hunk.oldStart + hunk.oldLines;
    prevNew = hunk.newStart + hunk.newLines;
  }

  // Trailing gap: only when source is available (without source we don't know file length)
  if (hasSource) {
    const trailingOld = oldSourceLines!.length - (prevOld - 1);
    const trailingNew = newSourceLines!.length - (prevNew - 1);
    if (trailingOld > 0 && trailingNew > 0 && trailingOld === trailingNew) {
      const lines: DiffLine[] = [];
      for (let j = 0; j < trailingOld; j++) {
        const oldLineNo = prevOld + j;
        const newLineNo = prevNew + j;
        lines.push({
          type: "context",
          content: newSourceLines![newLineNo - 1] ?? oldSourceLines![oldLineNo - 1] ?? "",
          oldLineNo,
          newLineNo,
        });
      }
      blocks.push({ type: "gap", key: "gap-tail", lines });
    }
  }

  return blocks;
}

function FileHeader({
  fileName,
  fileStatsLabel,
  headerActions,
  collapsible,
  collapsed,
  onToggleCollapsed,
}: {
  fileName: string;
  fileStatsLabel?: string;
  headerActions?: ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { dirLabel, baseLabel } = formatFileHeaderPath(fileName);
  return (
    <div className="diff-file-header" title={fileName}>
      <div className="diff-file-header-content">
        {collapsible && (
          <button
            type="button"
            className="diff-file-collapse-btn"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand file" : "Collapse file"}
            title={collapsed ? "Expand file" : "Collapse file"}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className={`w-3 h-3 transition-transform ${collapsed ? "-rotate-90" : ""}`}
              aria-hidden="true"
            >
              <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="w-3.5 h-3.5 text-cc-primary shrink-0"
        >
          <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
          <polyline points="9 1 9 5 13 5" />
        </svg>
        <span className="diff-file-path">
          {dirLabel && <span className="text-cc-muted">{dirLabel}</span>}
          <span className="font-semibold text-cc-fg">{baseLabel}</span>
        </span>
        {fileStatsLabel && <span className="ml-2 text-cc-muted text-[11px] font-mono-code">{fileStatsLabel}</span>}
        {headerActions && <div className="diff-file-header-actions">{headerActions}</div>}
      </div>
    </div>
  );
}

export const DiffViewer = memo(function DiffViewer({
  oldText,
  newText,
  unifiedDiff,
  fileName,
  fileStatsLabel,
  mode = "compact",
  showLineNumbers: showLineNumbersProp,
  expandButtonLabel = "Expand",
  headerActions,
  renderHeaderActions,
  stickyFileHeaders = false,
  collapsibleFiles = false,
}: DiffViewerProps) {
  const isCompact = mode === "compact";
  const showLineNumbers = showLineNumbersProp ?? false;
  const [expanded, setExpanded] = useState(false);
  const [expandedGaps, setExpandedGaps] = useState<Record<string, number>>({});
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const toggleCollapsedFile = useCallback((key: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const hasSource = oldText !== undefined || newText !== undefined;
  const normalizedOldText = oldText ?? "";
  const normalizedNewText = newText ?? "";

  const oldSourceLines = useMemo(
    () => (hasSource ? splitSourceToLines(normalizedOldText) : null),
    [hasSource, normalizedOldText],
  );
  const newSourceLines = useMemo(
    () => (hasSource ? splitSourceToLines(normalizedNewText) : null),
    [hasSource, normalizedNewText],
  );

  const language = useMemo(() => inferLanguageFromPath(fileName), [fileName]);
  const highlighted = useMemo<HighlightedLineMaps>(() => {
    if (!language || !hasSource) {
      return { oldLines: null, newLines: null };
    }
    try {
      return {
        oldLines: buildHighlightedLines(normalizedOldText, language),
        newLines: buildHighlightedLines(normalizedNewText, language),
      };
    } catch (err) {
      console.error("[DiffViewer] Syntax highlighting failed:", err);
      return { oldLines: null, newLines: null };
    }
  }, [hasSource, language, normalizedNewText, normalizedOldText]);

  const data = useMemo<ParsedFileDiff[]>(() => {
    try {
      if (hasSource) {
        if (!normalizedOldText && !normalizedNewText) return [];
        const hunks = parsePatchToHunks(normalizedOldText, normalizedNewText);
        return [{ fileName: fileName || "", hunks }];
      }

      if (unifiedDiff) {
        return parseUnifiedDiffToFiles(unifiedDiff, fileName || "");
      }
    } catch (err) {
      console.error("[DiffViewer] Failed to compute diff:", err);
    }

    return [];
  }, [hasSource, normalizedOldText, normalizedNewText, unifiedDiff, fileName]);

  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [expanded]);

  useEffect(() => {
    // Reset gap expansion state when the diff content changes.
    // Uses the functional updater to avoid creating a new object reference
    // when the state is already empty (prevents unnecessary re-renders that
    // can cascade into React error #185 in deeply nested component trees).
    setExpandedGaps((prev) => (Object.keys(prev).length === 0 ? prev : {}));
  }, [oldText, newText, unifiedDiff, fileName]);

  if (data.length === 0 || data.every((f) => f.hunks.length === 0)) {
    return (
      <div className="diff-viewer diff-empty">
        <span className="text-cc-muted text-xs">No changes</span>
      </div>
    );
  }

  const renderedDiff = (
    <div
      className={`diff-viewer ${isCompact ? "diff-compact" : "diff-full"} ${
        stickyFileHeaders ? "diff-sticky-file-headers" : ""
      }`}
    >
      {isCompact && (
        <button type="button" onClick={() => setExpanded(true)} className="diff-inline-expand-btn" title="Expand diff">
          {expandButtonLabel}
        </button>
      )}
      {data.map((file, fi) => {
        const blocks = buildRenderBlocks(file.hunks, oldSourceLines, newSourceLines);
        const resolvedFileName = file.fileName || fileName || "";
        const resolvedHeaderActions = renderHeaderActions ? renderHeaderActions(resolvedFileName) : headerActions;
        const fileCollapseKey = `${fi}:${resolvedFileName}`;
        const isFileCollapsed = !!collapsedFiles[fileCollapseKey];
        return (
          <div key={fi} className={`diff-file ${isFileCollapsed ? "diff-file-collapsed" : ""}`}>
            {resolvedFileName && (
              <FileHeader
                fileName={resolvedFileName}
                fileStatsLabel={data.length === 1 ? fileStatsLabel : undefined}
                headerActions={resolvedHeaderActions}
                collapsible={collapsibleFiles}
                collapsed={isFileCollapsed}
                onToggleCollapsed={() => toggleCollapsedFile(fileCollapseKey)}
              />
            )}
            {!isFileCollapsed &&
              blocks.map((block) => {
                if (block.type === "hunk") {
                  return (
                    <HunkBlock
                      key={`${fi}-${block.key}`}
                      hunk={block.hunk}
                      showLineNumbers={showLineNumbers}
                      highlighted={highlighted}
                    />
                  );
                }

                const gapId = `${fi}-${block.key}`;
                const expandedCount = expandedGaps[gapId] ?? 0;
                const visibleCount = Math.min(expandedCount, block.lines.length);
                const remainingCount = block.lines.length - visibleCount;
                const nextChunkCount = Math.min(GAP_EXPAND_CHUNK, remainingCount);

                if (visibleCount === 0) {
                  return (
                    <div key={gapId} className="diff-gap-row">
                      <button
                        type="button"
                        className="diff-gap-btn"
                        onClick={() => {
                          setExpandedGaps((prev) => ({
                            ...prev,
                            [gapId]: Math.min(block.lines.length, (prev[gapId] ?? 0) + GAP_EXPAND_CHUNK),
                          }));
                        }}
                      >
                        Show {nextChunkCount} unchanged line{nextChunkCount === 1 ? "" : "s"}
                      </button>
                    </div>
                  );
                }

                return (
                  <div key={gapId} className="diff-gap-expanded">
                    {block.lines.slice(0, visibleCount).map((line) => (
                      <DiffLineRow
                        key={`${gapId}-${line.oldLineNo}-${line.newLineNo}`}
                        line={line}
                        showLineNumbers={showLineNumbers}
                        highlightedHtml={getLineHtml(line, highlighted)}
                      />
                    ))}
                    {remainingCount > 0 && (
                      <div className="diff-gap-row">
                        <button
                          type="button"
                          className="diff-gap-btn"
                          onClick={() => {
                            setExpandedGaps((prev) => ({
                              ...prev,
                              [gapId]: Math.min(block.lines.length, (prev[gapId] ?? 0) + GAP_EXPAND_CHUNK),
                            }));
                          }}
                        >
                          Show {nextChunkCount} more unchanged line{nextChunkCount === 1 ? "" : "s"} ({remainingCount}{" "}
                          remaining)
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {renderedDiff}
      {isCompact &&
        expanded &&
        createPortal(
          <div className="diff-modal-backdrop" onClick={() => setExpanded(false)}>
            <div className="diff-modal-panel" onClick={(e) => e.stopPropagation()}>
              <div className="diff-modal-header">
                <span className="diff-modal-title">{fileName || "Diff Viewer"}</span>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="diff-modal-close"
                  title="Close full-screen diff"
                >
                  Close
                </button>
              </div>
              <div className="diff-modal-body">
                <DiffViewer
                  oldText={oldText}
                  newText={newText}
                  unifiedDiff={unifiedDiff}
                  fileName={fileName}
                  mode="full"
                  showLineNumbers
                  headerActions={headerActions}
                  renderHeaderActions={renderHeaderActions}
                  stickyFileHeaders={stickyFileHeaders}
                  collapsibleFiles={collapsibleFiles}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
});
