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

function formatSelectionContext(input) {
  if (!input || !input.pathLabel) {
    return "No active editor";
  }

  const pathLabel = getDisplayPathLabel(input.pathLabel);
  if (input.isEmpty) {
    return `${pathLabel}:${input.startLine}`;
  }

  const lineCount = getSelectedLineCount(input.selectedText);
  const endLine = input.startLine + Math.max(0, lineCount - 1);
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
  const lineCount = getSelectedLineCount(input.selectedText);
  const endLine = input.startLine + Math.max(0, lineCount - 1);
  if (input.startLine === endLine) {
    return `${input.pathLabel}:${input.startLine}`;
  }
  return `${input.pathLabel}:${input.startLine}-${endLine}`;
}

function buildSelectionPayload(input) {
  if (!input || !input.pathLabel) {
    return null;
  }
  if (input.isEmpty) {
    return null;
  }
  const lineCount = getSelectedLineCount(input.selectedText);
  if (!lineCount) return null;
  const endLine = input.startLine + Math.max(0, lineCount - 1);
  return {
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
  getSelectedLineCount,
};
