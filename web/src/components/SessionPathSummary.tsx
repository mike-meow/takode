interface SessionPathSummaryProps {
  cwd?: string | null;
  repoRoot?: string | null;
  isWorktree?: boolean;
  testIdPrefix?: string;
  interactivePaths?: boolean;
}

interface PathRow {
  key: string;
  label: string | null;
  path: string;
}

function getPathTail(path: string): string {
  const normalized = path.length > 1 ? path.replace(/[/\\]+$/, "") : path;
  const slashIndex = normalized.lastIndexOf("/");
  const backslashIndex = normalized.lastIndexOf("\\");
  const separatorIndex = Math.max(slashIndex, backslashIndex);
  if (separatorIndex < 0) return normalized;
  return normalized.slice(separatorIndex + 1) || normalized;
}

function splitDisplayPath(path: string): { full: string; prefix: string; tail: string } {
  const full = shortenHome(path);
  const normalized = full.length > 1 ? full.replace(/[/\\]+$/, "") : full;
  const slashIndex = normalized.lastIndexOf("/");
  const backslashIndex = normalized.lastIndexOf("\\");
  const separatorIndex = Math.max(slashIndex, backslashIndex);
  if (separatorIndex <= 0) return { full, prefix: "", tail: normalized };
  return {
    full,
    prefix: normalized.slice(0, separatorIndex + 1),
    tail: normalized.slice(separatorIndex + 1),
  };
}

function selectElementText(element: HTMLElement) {
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function SessionPathSummary({
  cwd,
  repoRoot,
  isWorktree,
  testIdPrefix,
  interactivePaths,
}: SessionPathSummaryProps) {
  const rows: PathRow[] = [];
  if (!cwd) return null;

  const showBaseRepo = isWorktree === true && !!repoRoot && repoRoot !== cwd;
  if (showBaseRepo) {
    rows.push({ key: "worktree", label: "Worktree", path: cwd });
    rows.push({ key: "repo", label: "Base repo", path: repoRoot! });
  } else {
    rows.push({ key: "path", label: null, path: cwd });
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row) => {
        const tail = getPathTail(row.path);
        const compactPath = splitDisplayPath(row.path);
        return (
          <div
            key={row.key}
            data-testid={testIdPrefix ? `${testIdPrefix}-${row.key}` : undefined}
            className="min-w-0"
            title={row.path}
          >
            {row.label && (
              <div className="mb-0.5 text-[9px] uppercase tracking-[0.16em] text-cc-muted/55">{row.label}</div>
            )}
            <div className="flex items-center gap-1.5 min-w-0">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/45">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              {interactivePaths ? (
                <div
                  data-testid={testIdPrefix ? `${testIdPrefix}-${row.key}-scroller` : undefined}
                  className="min-w-0 flex-1 select-text overflow-x-auto overflow-y-hidden whitespace-nowrap rounded bg-cc-hover/40 px-1.5 py-1 font-mono-code text-[11px] text-cc-fg/95"
                  style={{ scrollbarGutter: "stable" }}
                  onDoubleClick={(event) => {
                    selectElementText(event.currentTarget);
                  }}
                >
                  <span data-testid={testIdPrefix ? `${testIdPrefix}-${row.key}-tail` : undefined}>{row.path}</span>
                </div>
              ) : (
                <div className="flex min-w-0 items-baseline overflow-hidden whitespace-nowrap font-mono-code text-[11px]">
                  {compactPath.prefix && (
                    <span className="min-w-0 truncate text-cc-muted/55">{compactPath.prefix}</span>
                  )}
                  <span
                    data-testid={testIdPrefix ? `${testIdPrefix}-${row.key}-tail` : undefined}
                    className="max-w-[75%] shrink-0 truncate font-semibold text-cc-fg/95"
                  >
                    {compactPath.tail || compactPath.full}
                  </span>
                </div>
              )}
              {interactivePaths && (
                <button
                  type="button"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-cc-muted hover:bg-cc-hover hover:text-cc-fg disabled:cursor-not-allowed disabled:opacity-40"
                  title={`Copy ${row.label?.toLowerCase() ?? "path"}`}
                  aria-label={`Copy ${row.label ?? "path"}`}
                  onClick={() => {
                    void navigator.clipboard?.writeText(row.path);
                  }}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                    <path d="M5.5 5.5h6v8h-6z" />
                    <path d="M3.5 10.5h-1v-8h6v1" />
                  </svg>
                </button>
              )}
            </div>
            <span className="sr-only">{tail}</span>
          </div>
        );
      })}
    </div>
  );
}
import { shortenHome } from "../utils/path-display.js";
