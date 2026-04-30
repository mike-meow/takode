export interface ParsedEditToolInput {
  filePath: string;
  oldText: string;
  newText: string;
  changes: Array<Record<string, unknown>>;
  unifiedDiff: string;
}

export interface ParsedWriteToolInput {
  filePath: string;
  content: string;
  changes: Array<Record<string, unknown>>;
  unifiedDiff: string;
}

export interface ParseEditToolInputOptions {
  fallbackToFirstChangePath?: boolean;
}

export function getDistinctChangeFilePaths(input: Record<string, unknown>): string[] {
  const changes = Array.isArray(input.changes) ? (input.changes as Array<Record<string, unknown>>) : [];
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const change of changes) {
    const path = getChangeFilePath(change);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }

  return paths;
}

export function getChangePatch(change: Record<string, unknown>): string {
  const candidates = [change.diff, change.unified_diff, change.unifiedDiff, change.patch];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

export function getChangeFilePath(change: Record<string, unknown>): string {
  return firstNonEmptyString(change, ["path", "file_path", "filePath", "filename"]);
}

function firstNonEmptyString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function isWriteLikeChangeKind(change: Record<string, unknown>): boolean {
  const kind = typeof change.kind === "string" ? change.kind : typeof change.type === "string" ? change.type : "";
  const normalizedKind = kind.trim().toLowerCase();
  return (
    normalizedKind === "create" || normalizedKind === "created" || normalizedKind === "add" || normalizedKind === "new"
  );
}

function extractChangeContent(change: Record<string, unknown>): string {
  return firstNonEmptyString(change, ["content", "text", "new_string", "newText", "new_content", "newContent"]);
}

function extractNewTextFromPatch(patch: string): string {
  if (!patch.trim()) return "";

  const metadataPrefixes = [
    "diff --git",
    "diff --cc",
    "index ",
    "new file",
    "deleted file",
    "old mode",
    "new mode",
    "rename from",
    "rename to",
    "similarity index",
    "Binary files",
    "--- ",
    "+++ ",
    "@@",
  ];

  const newLines: string[] = [];
  for (const line of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "\\ No newline at end of file") continue;
    if (metadataPrefixes.some((prefix) => line.startsWith(prefix))) continue;

    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith(" ")) {
      newLines.push(line.slice(1));
      continue;
    }
  }

  return newLines.join("\n");
}

export function parseEditToolInput(
  input: Record<string, unknown>,
  options: ParseEditToolInputOptions = {},
): ParsedEditToolInput {
  const changes = Array.isArray(input.changes) ? (input.changes as Array<Record<string, unknown>>) : [];
  const firstChangePath = changes.map((change) => getChangeFilePath(change)).find(Boolean);
  const filePath = options.fallbackToFirstChangePath
    ? String(input.file_path || firstChangePath || "")
    : String(input.file_path || "");
  const oldText = String(input.old_string || "");
  const unifiedDiff = changes
    .map((change) => getChangePatch(change))
    .filter(Boolean)
    .join("\n");
  const topLevelContent = firstNonEmptyString(input, [
    "content",
    "text",
    "new_string",
    "newText",
    "new_content",
    "newContent",
  ]);
  const createChangeContent = changes
    .map((change) => {
      if (!isWriteLikeChangeKind(change)) return "";
      if (getChangePatch(change)) return "";
      return extractChangeContent(change);
    })
    .find(Boolean);
  const newText = String(input.new_string || "") || topLevelContent || createChangeContent || "";

  return {
    filePath,
    oldText,
    newText,
    changes,
    unifiedDiff,
  };
}

export function parseWriteToolInput(input: Record<string, unknown>): ParsedWriteToolInput {
  const changes = Array.isArray(input.changes) ? (input.changes as Array<Record<string, unknown>>) : [];
  const firstChangePath = changes.map((change) => getChangeFilePath(change)).find(Boolean);
  const filePath = String(input.file_path || firstChangePath || "");
  const unifiedDiff = changes
    .map((change) => getChangePatch(change))
    .filter(Boolean)
    .join("\n");
  const rawContent =
    firstNonEmptyString(input, ["content", "text", "new_string", "newText", "new_content", "newContent"]) ||
    changes
      .map((change) => {
        if (!isWriteLikeChangeKind(change)) return "";
        if (getChangePatch(change)) return "";
        return extractChangeContent(change);
      })
      .find(Boolean) ||
    "";

  return {
    filePath,
    content: rawContent || extractNewTextFromPatch(unifiedDiff),
    changes,
    unifiedDiff,
  };
}
