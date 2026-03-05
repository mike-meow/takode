import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import * as Diff from "diff";
import {
  buildHighlightedLines,
  inferLanguageFromPath,
  splitSourceToLines,
} from "../utils/syntax-highlighting.js";

export interface DiffViewerProps {
  /** Original text (for computing diff from old/new) */
  oldText?: string;
  /** New text (for computing diff from old/new) */
  newText?: string;
  /** Pre-computed unified diff string (e.g. from git diff) */
  unifiedDiff?: string;
  /** File name/path for the header */
  fileName?: string;
  /** compact = inline in chat (capped height, no line numbers), full = panel (scrollable, line numbers) */
  mode?: "compact" | "full";
  /** Explicit control over line numbers. When omitted, defaults to true for "full" mode, false for "compact". */
  showLineNumbers?: boolean;
  /** Optional label for the compact-mode modal trigger. */
  expandButtonLabel?: string;
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

type RenderBlock =
  | { type: "hunk"; key: string; hunk: DiffHunk }
  | { type: "gap"; key: string; lines: DiffLine[] };

interface HighlightedLineMaps {
  oldLines: string[] | null;
  newLines: string[] | null;
}

function parsePatchToHunks(oldText: string, newText: string): DiffHunk[] {
  const patch = Diff.structuredPatch("", "", oldText, newText, "", "", { context: 3 });
  return patch.hunks.map((hunk) => {
    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    const lines: DiffLine[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const raw of hunk.lines) {
      const prefix = raw[0];
      const content = raw.slice(1);
      if (prefix === "-") {
        lines.push({ type: "del", content, oldLineNo: oldLine++ });
      } else if (prefix === "+") {
        lines.push({ type: "add", content, newLineNo: newLine++ });
      } else {
        lines.push({ type: "context", content, oldLineNo: oldLine++, newLineNo: newLine++ });
      }
    }

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
      line.startsWith("index ")
      || line.startsWith("new file")
      || line.startsWith("deleted file")
      || line.startsWith("old mode")
      || line.startsWith("new mode")
      || line.startsWith("rename from")
      || line.startsWith("rename to")
      || line.startsWith("similarity index")
      || line.startsWith("Binary files")
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

  // Add word highlights.
  for (const file of files) {
    for (const hunk of file.hunks) {
      addWordHighlights(hunk.lines);
    }
  }

  return files;
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
            return <span key={i} className="diff-word-add">{part.value}</span>;
          }
          if (part.removed) {
            return <span key={i} className="diff-word-del">{part.value}</span>;
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
          <span className="diff-gutter diff-gutter-old">
            {line.oldLineNo ?? ""}
          </span>
          <span className="diff-gutter diff-gutter-new">
            {line.newLineNo ?? ""}
          </span>
        </>
      )}
      <span className="diff-marker">
        {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
      </span>
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
  if (!oldSourceLines || !newSourceLines || oldSourceLines.length === 0 || newSourceLines.length === 0) {
    return hunks.map((hunk, index) => ({ type: "hunk", key: `hunk-${index}`, hunk }));
  }

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
          content: newSourceLines[newLineNo - 1] ?? oldSourceLines[oldLineNo - 1] ?? "",
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

  const trailingOld = oldSourceLines.length - (prevOld - 1);
  const trailingNew = newSourceLines.length - (prevNew - 1);
  if (trailingOld > 0 && trailingNew > 0 && trailingOld === trailingNew) {
    const lines: DiffLine[] = [];
    for (let j = 0; j < trailingOld; j++) {
      const oldLineNo = prevOld + j;
      const newLineNo = prevNew + j;
      lines.push({
        type: "context",
        content: newSourceLines[newLineNo - 1] ?? oldSourceLines[oldLineNo - 1] ?? "",
        oldLineNo,
        newLineNo,
      });
    }
    blocks.push({ type: "gap", key: "gap-tail", lines });
  }

  return blocks;
}

function FileHeader({ fileName }: { fileName: string }) {
  const parts = fileName.split("/");
  const base = parts.pop() || fileName;
  const dir = parts.join("/");
  return (
    <div className="diff-file-header">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-primary shrink-0">
        <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
        <polyline points="9 1 9 5 13 5" />
      </svg>
      {dir && <span className="text-cc-muted">{dir}/</span>}
      <span className="font-semibold text-cc-fg">{base}</span>
    </div>
  );
}

export function DiffViewer({
  oldText,
  newText,
  unifiedDiff,
  fileName,
  mode = "compact",
  showLineNumbers: showLineNumbersProp,
  expandButtonLabel = "Open",
}: DiffViewerProps) {
  const isCompact = mode === "compact";
  const showLineNumbers = showLineNumbersProp ?? !isCompact;
  const [expanded, setExpanded] = useState(false);
  const [expandedGaps, setExpandedGaps] = useState<Record<string, boolean>>({});

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
    return {
      oldLines: buildHighlightedLines(normalizedOldText, language),
      newLines: buildHighlightedLines(normalizedNewText, language),
    };
  }, [hasSource, language, normalizedNewText, normalizedOldText]);

  const data = useMemo<ParsedFileDiff[]>(() => {
    if (hasSource) {
      if (!normalizedOldText && !normalizedNewText) return [];
      const hunks = parsePatchToHunks(normalizedOldText, normalizedNewText);
      return [{ fileName: fileName || "", hunks }];
    }

    if (unifiedDiff) {
      return parseUnifiedDiffToFiles(unifiedDiff, fileName || "");
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
    setExpandedGaps({});
  }, [oldText, newText, unifiedDiff, fileName]);

  if (data.length === 0 || data.every((f) => f.hunks.length === 0)) {
    return (
      <div className="diff-viewer diff-empty">
        <span className="text-cc-muted text-xs">No changes</span>
      </div>
    );
  }

  const renderedDiff = (
    <div className={`diff-viewer ${isCompact ? "diff-compact" : "diff-full"}`}>
      {isCompact && (
        <div className="diff-toolbar">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="diff-expand-btn"
            title="Open full-screen diff"
          >
            {expandButtonLabel}
          </button>
        </div>
      )}
      {data.map((file, fi) => {
        const blocks = buildRenderBlocks(file.hunks, oldSourceLines, newSourceLines);
        return (
          <div key={fi} className="diff-file">
            {(file.fileName || fileName) && (
              <FileHeader fileName={file.fileName || fileName || ""} />
            )}
            {blocks.map((block) => {
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
              const isGapExpanded = !!expandedGaps[gapId];
              if (!isGapExpanded) {
                return (
                  <div key={gapId} className="diff-gap-row">
                    <button
                      type="button"
                      className="diff-gap-btn"
                      onClick={() => {
                        setExpandedGaps((prev) => ({ ...prev, [gapId]: true }));
                      }}
                    >
                      Show {block.lines.length} unchanged line{block.lines.length === 1 ? "" : "s"}
                    </button>
                  </div>
                );
              }

              return (
                <div key={gapId} className="diff-gap-expanded">
                  {block.lines.map((line) => (
                    <DiffLineRow
                      key={`${gapId}-${line.oldLineNo}-${line.newLineNo}`}
                      line={line}
                      showLineNumbers={showLineNumbers}
                      highlightedHtml={getLineHtml(line, highlighted)}
                    />
                  ))}
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
      {isCompact && expanded && createPortal(
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
              />
            </div>
          </div>
        </div>
        ,
        document.body,
      )}
    </>
  );
}
