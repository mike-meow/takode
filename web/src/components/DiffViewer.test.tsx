// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiffViewer } from "./DiffViewer.js";

describe("DiffViewer", () => {
  it("renders a diff from old/new text", () => {
    const { container } = render(
      <DiffViewer
        oldText={"const x = 1;\nconst y = 2;"}
        newText={"const x = 42;\nconst y = 2;"}
        fileName="test.ts"
      />,
    );
    expect(container.querySelector(".diff-viewer")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    // File header should show file name
    expect(screen.getByText("test.ts")).toBeTruthy();
  });

  it("renders a diff from unified diff string", () => {
    const unifiedDiff = `diff --git a/src/utils.ts b/src/utils.ts
index 1234567..abcdefg 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 42;
 const c = 3;`;

    const { container } = render(<DiffViewer unifiedDiff={unifiedDiff} />);
    expect(container.querySelector(".diff-viewer")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    // FileHeader splits path into dir + basename spans
    expect(screen.getByText("utils.ts")).toBeTruthy();
  });

  it("renders a diff from headerless unified hunks (Codex format)", () => {
    const codexHunkOnlyDiff = `@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 42;
 const c = 3;`;

    const { container } = render(
      <DiffViewer unifiedDiff={codexHunkOnlyDiff} fileName="src/utils.ts" />,
    );
    expect(container.querySelector(".diff-viewer")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    expect(screen.getByText("utils.ts")).toBeTruthy();
  });

  it("renders compact mode without line numbers", () => {
    const { container } = render(
      <DiffViewer
        oldText="hello"
        newText="world"
        mode="compact"
      />,
    );
    expect(container.querySelector(".diff-compact")).toBeTruthy();
    expect(container.querySelector(".diff-gutter")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
  });

  it("renders custom header actions alongside the file header", () => {
    render(
      <DiffViewer
        oldText="hello"
        newText="world"
        fileName="src/file.ts"
        headerActions={<button type="button">Open File</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "Open File" })).toBeTruthy();
    expect(screen.getByText("file.ts")).toBeTruthy();
  });

  it("renders full mode with line numbers when explicitly enabled", () => {
    const { container } = render(
      <DiffViewer
        oldText="hello"
        newText="world"
        mode="full"
        showLineNumbers
      />,
    );
    expect(container.querySelector(".diff-full")).toBeTruthy();
    expect(container.querySelector(".diff-gutter")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("opens and closes full-screen modal from compact mode", () => {
    const { container } = render(
      <DiffViewer oldText="a" newText="b" mode="compact" fileName="src/file.ts" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(container.ownerDocument.querySelector(".diff-modal-backdrop")).toBeTruthy();
    expect(container.ownerDocument.querySelector(".diff-modal-panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(container.ownerDocument.querySelector(".diff-modal-backdrop")).toBeNull();
  });

  it("shows new file diff (old is empty)", () => {
    const { container } = render(
      <DiffViewer
        newText={"export const config = {\n  port: 3000,\n};"}
        fileName="config.ts"
      />,
    );
    const addLines = container.querySelectorAll(".diff-line-add");
    expect(addLines.length).toBeGreaterThan(0);
    // No del lines for new file
    expect(container.querySelector(".diff-line-del")).toBeNull();
  });

  it("shows 'No changes' when old and new are identical", () => {
    render(
      <DiffViewer oldText="same" newText="same" />,
    );
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("ignores line-ending-only changes for old/new text diffs", () => {
    render(
      <DiffViewer
        oldText={"line one\r\nline two\r\n"}
        newText={"line one\nline two"}
        fileName="draft.md"
      />,
    );

    expect(screen.getByText("No changes")).toBeTruthy();
    expect(screen.queryByText("No newline at end of file")).toBeNull();
  });

  it("still shows substantive text edits when line endings also differ", () => {
    const { container } = render(
      <DiffViewer
        oldText={"line one\r\nline two\r\n"}
        newText={"line one\nline changed\n"}
        fileName="draft.md"
      />,
    );

    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    expect(screen.queryByText("No changes")).toBeNull();
  });

  it("shows 'No changes' when both are empty", () => {
    render(<DiffViewer />);
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("renders word-level highlighting", () => {
    const { container } = render(
      <DiffViewer
        oldText={"const value = 1;\nconst other = true;"}
        newText={"const value = 42;\nconst other = true;"}
      />,
    );
    // Word-level diffs should create diff-word-add/diff-word-del spans
    const wordAdds = container.querySelectorAll(".diff-word-add");
    const wordDels = container.querySelectorAll(".diff-word-del");
    expect(wordAdds.length).toBeGreaterThan(0);
    expect(wordDels.length).toBeGreaterThan(0);
  });

  it("collapses redundant delete/add lines when the same prose lines appear on both sides of a changed block", () => {
    const proseDiff = `@@ -1,6 +1,7 @@
- Keep bullet-format instructions in voice edit mode
- The prompt-enhancer prompt dropped the existing bullet point format description
- Voice editing should preserve the same bullet point format instructions
- Output should still follow bullet point format instead of turning into plain sentences
- Wrap lines in the composer diff
- Long lines in the diff should wrap to the next line
- This should be consistent with normal composer behavior
+ Keep bullet-format instructions in voice edit mode
+ The prompt-enhancer prompt dropped the existing bullet point format description
+ Voice editing should preserve the same bullet point format instructions
+ Output should still follow bullet point format instead of turning into plain sentences
+ Wrap lines in the composer diff
+ Long lines in the diff should wrap to the next line
+ This should be consistent with normal composer behavior`;
    const { container } = render(<DiffViewer unifiedDiff={proseDiff} fileName="draft.md" />);

    expect(container.querySelectorAll(".diff-line-add")).toHaveLength(0);
    expect(container.querySelectorAll(".diff-line-del")).toHaveLength(0);
    expect(screen.getAllByText("Keep bullet-format instructions in voice edit mode").length).toBeGreaterThan(0);
  });

  it("renders file path with directory in muted style", () => {
    render(
      <DiffViewer
        oldText="a"
        newText="b"
        fileName="src/components/Button.tsx"
      />,
    );
    expect(screen.getByText("src/components/")).toBeTruthy();
    expect(screen.getByText("Button.tsx")).toBeTruthy();
  });

  it("truncates long file paths in headers and keeps the full path as a tooltip", () => {
    const longPath = "/home/jiayiwei/.companion/worktrees/companion/jiayi-wt-7712/vscode/takode-panel-prototype/package.json";
    render(
      <DiffViewer
        oldText="a"
        newText="b"
        fileName={longPath}
      />,
    );

    expect(screen.getByText(".../vscode/takode-panel-prototype/")).toBeTruthy();
    expect(screen.getByText("package.json")).toBeTruthy();
    expect(screen.getByTitle(longPath)).toBeTruthy();
  });

  it("handles multi-file unified diff", () => {
    const multiDiff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 const b = 1;
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;`;

    const { container } = render(<DiffViewer unifiedDiff={multiDiff} />);
    const files = container.querySelectorAll(".diff-file");
    expect(files.length).toBe(2);
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("b.ts")).toBeTruthy();
  });

  it("does not crash when re-rendering from empty to non-empty data (hooks order)", () => {
    // Regression: useEffect was placed after an early return for empty data,
    // violating React's Rules of Hooks. When the component re-rendered from
    // empty → non-empty data, React threw error #310 ("Rendered more hooks
    // than during the previous render").
    const { rerender, container } = render(<DiffViewer unifiedDiff="" />);
    expect(screen.getByText("No changes")).toBeTruthy();

    // Re-render with actual diff data — this would crash before the fix
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new`;
    rerender(<DiffViewer unifiedDiff={diff} />);
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
  });

  it("applies syntax highlighting when file language can be inferred", () => {
    const { container } = render(
      <DiffViewer
        oldText={"const value = 1;\nconst unchanged = true;"}
        newText={"const value = 2;\nconst unchanged = true;"}
        fileName="src/example.ts"
        mode="full"
      />,
    );

    expect(container.querySelector(".hljs-keyword")).toBeTruthy();
  });

  it("keeps syntax highlighting when file stats are shown separately", () => {
    const { container } = render(
      <DiffViewer
        oldText=""
        newText={"def format_label(name: str) -> str:\n    return f\"label:{name}\""}
        fileName="scripts/python-diff-test.py"
        fileStatsLabel="+11 -0"
        mode="full"
      />,
    );

    expect(screen.getByText("+11 -0")).toBeTruthy();
    expect(container.querySelector(".hljs-keyword")).toBeTruthy();
  });

  it("shows expandable hidden context between distant hunks", () => {
    const oldLines = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`);
    const newLines = [...oldLines];
    newLines[2] = "const line3 = 300;";
    newLines[35] = "const line36 = 3600;";

    render(
      <DiffViewer
        oldText={oldLines.join("\n")}
        newText={newLines.join("\n")}
        fileName="src/expandable.ts"
        mode="full"
      />,
    );

    expect(screen.queryByText("const line20 = 20;")).toBeNull();

    const [expandButton] = screen.getAllByRole("button", { name: /Show \d+ unchanged lines/ });
    fireEvent.click(expandButton);

    const expandedLineMatches = screen.getAllByText((_, element) => {
      if (!element?.classList.contains("diff-line")) return false;
      return element.textContent?.includes("const line20 = 20;") ?? false;
    });
    expect(expandedLineMatches.length).toBeGreaterThan(0);
  });

  it("expands hidden context in 50-line chunks", () => {
    const oldLines = Array.from({ length: 220 }, (_, i) => `const line${i + 1} = ${i + 1};`);
    const newLines = [...oldLines];
    newLines[2] = "const line3 = 300;";
    newLines[199] = "const line200 = 20000;";

    render(
      <DiffViewer
        oldText={oldLines.join("\n")}
        newText={newLines.join("\n")}
        fileName="src/chunked-expand.ts"
        mode="full"
      />,
    );

    const [expandButton] = screen.getAllByRole("button", { name: /Show 50 unchanged lines/ });
    fireEvent.click(expandButton);

    expect(screen.queryByText("const line120 = 120;")).toBeNull();
    expect(screen.getByRole("button", { name: /Show 50 more unchanged lines \(\d+ remaining\)/ })).toBeTruthy();
  });
});
