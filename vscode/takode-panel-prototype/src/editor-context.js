"use strict";

function getDisplayPathLabel(pathLabel) {
  const value = String(pathLabel || "").trim();
  if (!value) {
    return "";
  }
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

function getSelectedLineCount(selectedText) {
  const normalized = String(selectedText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) {
    return 0;
  }
  const withoutTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return Math.max(1, withoutTrailingNewline.split("\n").length);
}

function getInclusiveEndLine(input) {
  if (!input || input.isEmpty) {
    return input?.startLine || 0;
  }
  if (typeof input.endLine !== "number" || input.endLine < input.startLine) {
    return input.startLine;
  }
  // VS Code reports full-line selections as ending at character 0 on the next line.
  if (input.endLine > input.startLine && input.endCharacter === 1) {
    return input.endLine - 1;
  }
  return input.endLine;
}

function getSelectedLineCountFromRange(input) {
  if (!input || input.isEmpty) {
    return 0;
  }
  return Math.max(1, getInclusiveEndLine(input) - input.startLine + 1);
}

function formatSelectionContext(input) {
  if (!input || !input.pathLabel) {
    return "No active editor";
  }

  const pathLabel = getDisplayPathLabel(input.pathLabel);
  if (input.isEmpty) {
    return `${pathLabel}:${input.startLine}`;
  }

  const endLine = getInclusiveEndLine(input);
  if (input.startLine === endLine) {
    return `${pathLabel}:${input.startLine}`;
  }

  return `${pathLabel}:${input.startLine}-${endLine}`;
}

function formatSelectionLocation(input) {
  if (!input || !input.pathLabel) {
    return "";
  }
  if (input.isEmpty) {
    return "";
  }
  const endLine = getInclusiveEndLine(input);
  if (input.startLine === endLine) {
    return `${input.pathLabel}:${input.startLine}`;
  }
  return `${input.pathLabel}:${input.startLine}-${endLine}`;
}

function buildSelectionPayload(input) {
  if (!input || !input.pathLabel || !input.absolutePath) {
    return null;
  }
  if (input.isEmpty) {
    return null;
  }
  const lineCount = getSelectedLineCountFromRange(input);
  if (!lineCount) return null;
  const endLine = getInclusiveEndLine(input);
  return {
    absolutePath: input.absolutePath,
    relativePath: input.pathLabel,
    displayPath: getDisplayPathLabel(input.pathLabel),
    startLine: input.startLine,
    endLine,
    lineCount,
  };
}

module.exports = {
  buildSelectionPayload,
  formatSelectionContext,
  formatSelectionLocation,
  getInclusiveEndLine,
  getSelectedLineCountFromRange,
  getSelectedLineCount,
};
