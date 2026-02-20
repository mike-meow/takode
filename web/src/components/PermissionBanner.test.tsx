// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PermissionRequest } from "../../server/session-types.js";
import type { PermissionUpdate } from "../../server/session-types.js";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

// Mock react-markdown to avoid ESM/jsdom issues
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({
  default: {},
}));

const mockRemovePermission = vi.fn();
const mockSendToSession = vi.fn();

vi.mock("../store.js", () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ removePermission: mockRemovePermission }),
}));

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

import { PermissionBanner } from "./PermissionBanner.js";

function makePermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    input: { command: "ls -la" },
    tool_use_id: "tu-1",
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Label rendering ────────────────────────────────────────────────────────

describe("PermissionBanner label rendering", () => {
  it("renders 'Permission Request' label for standard tools", () => {
    render(
      <PermissionBanner permission={makePermission()} sessionId="s1" />,
    );
    expect(screen.getByText("Permission Request")).toBeTruthy();
  });

  it("renders 'Question' label for AskUserQuestion tool", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "AskUserQuestion",
          input: { question: "What do you want?" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("Question")).toBeTruthy();
    // Should NOT show "Permission Request"
    expect(screen.queryByText("Permission Request")).toBeNull();
  });
});

// ─── BashDisplay ─────────────────────────────────────────────────────────────

describe("BashDisplay", () => {
  it("renders the command with $ prefix", () => {
    const { container } = render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Bash",
          input: { command: "echo hello", description: "Print hello" },
        })}
        sessionId="s1"
      />,
    );
    // The $ prefix is in a span inside a pre, so check the pre's text content
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toContain("$ echo hello");
    expect(screen.getByText("Print hello")).toBeTruthy();
  });
});

// ─── EditDisplay ─────────────────────────────────────────────────────────────

describe("EditDisplay", () => {
  it("renders diff view with old/new strings via DiffViewer", () => {
    const { container } = render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Edit",
          input: {
            file_path: "/src/main.ts",
            old_string: "const a = 1;",
            new_string: "const a = 2;",
          },
        })}
        sessionId="s1"
      />,
    );
    // DiffViewer renders file header (basename extracted)
    expect(screen.getByText("main.ts")).toBeTruthy();
    // DiffViewer renders del/add lines
    expect(container.querySelector(".diff-line-del")).toBeTruthy();
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
  });
});

// ─── WriteDisplay ────────────────────────────────────────────────────────────

describe("WriteDisplay", () => {
  it("renders file path and content as new-file diff via DiffViewer", () => {
    const { container } = render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Write",
          input: {
            file_path: "/src/output.ts",
            content: "export default 42;",
          },
        })}
        sessionId="s1"
      />,
    );
    // DiffViewer renders file header (basename extracted)
    expect(screen.getByText("output.ts")).toBeTruthy();
    // Write renders as all-add diff lines
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    expect(container.querySelector(".diff-line-del")).toBeNull();
  });

  it("renders long content as diff lines without manual truncation", () => {
    const longContent = "x".repeat(600);
    const { container } = render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Write",
          input: {
            file_path: "/src/big.ts",
            content: longContent,
          },
        })}
        sessionId="s1"
      />,
    );
    // DiffViewer renders the content as add lines
    expect(container.querySelector(".diff-line-add")).toBeTruthy();
    expect(screen.getByText("big.ts")).toBeTruthy();
  });
});

// ─── ReadDisplay ─────────────────────────────────────────────────────────────

describe("ReadDisplay", () => {
  it("renders file path", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Read",
          input: { file_path: "/etc/config.json" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("/etc/config.json")).toBeTruthy();
  });
});

// ─── GlobDisplay ─────────────────────────────────────────────────────────────

describe("GlobDisplay", () => {
  it("renders pattern and optional path", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Glob",
          input: { pattern: "**/*.ts", path: "/src" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("**/*.ts")).toBeTruthy();
    expect(screen.getByText("/src")).toBeTruthy();
  });

  it("renders pattern without path", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Glob",
          input: { pattern: "*.json" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("*.json")).toBeTruthy();
  });
});

// ─── GrepDisplay ─────────────────────────────────────────────────────────────

describe("GrepDisplay", () => {
  it("renders pattern, path, and glob", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Grep",
          input: { pattern: "TODO", path: "/src", glob: "*.ts" },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("TODO")).toBeTruthy();
    expect(screen.getByText("/src")).toBeTruthy();
    expect(screen.getByText("*.ts")).toBeTruthy();
  });
});

// ─── GenericDisplay ──────────────────────────────────────────────────────────

describe("GenericDisplay", () => {
  it("renders key-value pairs for unknown tools", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "SomeUnknownTool",
          input: { foo: "bar", count: 42 },
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("foo:")).toBeTruthy();
    expect(screen.getByText("bar")).toBeTruthy();
    expect(screen.getByText("count:")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("renders description when no entries", () => {
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "SomeUnknownTool",
          input: {},
          description: "A custom tool description",
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByText("A custom tool description")).toBeTruthy();
  });
});

// ─── Allow / Deny buttons ────────────────────────────────────────────────────

describe("Allow and Deny buttons", () => {
  it("Allow button calls sendToSession with correct permission_response", () => {
    vi.useFakeTimers();
    const perm = makePermission({ request_id: "req-42" });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    fireEvent.click(screen.getByText("Allow"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "permission_response",
      request_id: "req-42",
      behavior: "allow",
      updated_input: undefined,
    });
    // removePermission is delayed by 350ms for the paw stamp animation
    expect(mockRemovePermission).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(mockRemovePermission).toHaveBeenCalledWith("s1", "req-42");
    vi.useRealTimers();
  });

  it("Deny button calls sendToSession with deny behavior", () => {
    const perm = makePermission({ request_id: "req-43" });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    fireEvent.click(screen.getByText("Deny"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "permission_response",
      request_id: "req-43",
      behavior: "deny",
      message: "Denied by user",
    });
    expect(mockRemovePermission).toHaveBeenCalledWith("s1", "req-43");
  });
});

// ─── Permission suggestion buttons ──────────────────────────────────────────

describe("Permission suggestion buttons", () => {
  it("renders addRules suggestion with correct label", () => {
    const suggestion: PermissionUpdate = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "allow ls" }],
      behavior: "allow",
      destination: "session",
    };
    const perm = makePermission({ permission_suggestions: [suggestion] });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText('Allow "allow ls" for session')).toBeTruthy();
  });

  it("renders setMode suggestion with correct label", () => {
    const suggestion: PermissionUpdate = {
      type: "setMode",
      mode: "bypassPermissions",
      destination: "session",
    };
    const perm = makePermission({ permission_suggestions: [suggestion] });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText('Set mode to "bypassPermissions"')).toBeTruthy();
  });

  it("renders addDirectories suggestion with correct label", () => {
    const suggestion: PermissionUpdate = {
      type: "addDirectories",
      directories: ["/home/user/project"],
      destination: "userSettings",
    };
    const perm = makePermission({ permission_suggestions: [suggestion] });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("Trust /home/user/project always")).toBeTruthy();
  });

  it("clicking a suggestion calls sendToSession with updated_permissions", () => {
    const suggestion: PermissionUpdate = {
      type: "addRules",
      rules: [{ toolName: "Bash" }],
      behavior: "allow",
      destination: "session",
    };
    const perm = makePermission({
      request_id: "req-50",
      permission_suggestions: [suggestion],
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    fireEvent.click(screen.getByText("Allow Bash for session"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "permission_response",
      request_id: "req-50",
      behavior: "allow",
      updated_input: undefined,
      updated_permissions: [suggestion],
    });
  });
});

// ─── AskUserQuestionDisplay ──────────────────────────────────────────────────

describe("AskUserQuestionDisplay", () => {
  it("renders options and handles selection", () => {
    const perm = makePermission({
      request_id: "req-ask-1",
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Pick one",
            question: "Which color?",
            options: [
              { label: "Red", description: "A warm color" },
              { label: "Blue", description: "A cool color" },
            ],
          },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("Pick one")).toBeTruthy();
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByText("Red")).toBeTruthy();
    expect(screen.getByText("Blue")).toBeTruthy();
    expect(screen.getByText("A warm color")).toBeTruthy();
    expect(screen.getByText("A cool color")).toBeTruthy();

    // Clicking an option with a single question auto-submits
    fireEvent.click(screen.getByText("Red"));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "permission_response",
      request_id: "req-ask-1",
      behavior: "allow",
    }));
    // The updated_input spreads permission.input and adds { answers: { "0": "Red" } }
    const call = mockSendToSession.mock.calls[0][1];
    expect(call.updated_input.answers).toEqual({ "0": "Red" });
  });

  it("renders fallback for simple question string", () => {
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: { question: "Are you sure?" },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.getByText("Are you sure?")).toBeTruthy();
  });

  it("does not show Allow/Deny buttons for AskUserQuestion", () => {
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: { question: "Yes or no?" },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    expect(screen.queryByText("Allow")).toBeNull();
    expect(screen.queryByText("Deny")).toBeNull();
  });
});

// ─── Collapse / Expand behavior ─────────────────────────────────────────────

describe("Collapse and expand behavior", () => {
  it("clicking minimize on AskUser banner hides full panel and shows collapsed chip", () => {
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Pick one",
            question: "Which color?",
            options: [
              { label: "Red", description: "A warm color" },
              { label: "Blue", description: "A cool color" },
            ],
          },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    // Full panel is visible
    expect(screen.getByText("Question")).toBeTruthy();
    expect(screen.getByText("Which color?")).toBeTruthy();

    // Click the minimize button
    fireEvent.click(screen.getByTitle("Minimize question"));

    // Full panel should be gone — "Question" label disappears
    expect(screen.queryByText("Question")).toBeNull();
    // Collapsed chip shows the question preview
    expect(screen.getByTitle("Expand question")).toBeTruthy();
  });

  it("collapsed chip shows the first question's preview text", () => {
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Step 1",
            question: "What language do you prefer?",
            options: [{ label: "TypeScript" }, { label: "Python" }],
          },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    // Minimize
    fireEvent.click(screen.getByTitle("Minimize question"));

    // Preview text from the first question is visible in the chip
    expect(screen.getByText("What language do you prefer?")).toBeTruthy();
  });

  it("clicking the collapsed chip re-expands to the full panel", () => {
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Config",
            question: "Enable strict mode?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    // Minimize first
    fireEvent.click(screen.getByTitle("Minimize question"));
    expect(screen.queryByText("Question")).toBeNull();

    // Click the collapsed chip to expand
    fireEvent.click(screen.getByTitle("Expand question"));

    // Full panel re-appears
    expect(screen.getByText("Question")).toBeTruthy();
    expect(screen.getByText("Enable strict mode?")).toBeTruthy();
    expect(screen.getByText("Yes")).toBeTruthy();
    expect(screen.getByText("No")).toBeTruthy();
  });

  it("minimize button does NOT appear for non-AskUser permissions", () => {
    // Bash tool permission — should not have a minimize button
    render(
      <PermissionBanner
        permission={makePermission({
          tool_name: "Bash",
          input: { command: "npm test" },
        })}
        sessionId="s1"
      />,
    );

    expect(screen.queryByTitle("Minimize question")).toBeNull();
  });

  it("shows 'N questions' count badge in collapsed view for multi-question inputs", () => {
    const perm = makePermission({
      tool_name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Q1",
            question: "First question?",
            options: [{ label: "A" }],
          },
          {
            header: "Q2",
            question: "Second question?",
            options: [{ label: "B" }],
          },
          {
            header: "Q3",
            question: "Third question?",
            options: [{ label: "C" }],
          },
        ],
      },
    });
    render(<PermissionBanner permission={perm} sessionId="s1" />);

    // Minimize
    fireEvent.click(screen.getByTitle("Minimize question"));

    // Count badge should show "3 questions"
    expect(screen.getByText("3 questions")).toBeTruthy();
  });
});

// ─── PlanReviewOverlay ──────────────────────────────────────────────────────
// ExitPlanMode is now handled by PlanReviewOverlay (not PermissionBanner).

describe("PlanReviewOverlay", () => {
  it("renders plan markdown and allowed prompts", async () => {
    const { PlanReviewOverlay } = await import("./PermissionBanner.js");
    const perm = makePermission({
      tool_name: "ExitPlanMode",
      input: {
        plan: "## Step 1\nDo something",
        allowedPrompts: [
          { tool: "Bash", prompt: "Run tests" },
          { tool: "Edit", prompt: "Fix typo" },
        ],
      },
    });
    render(<PlanReviewOverlay permission={perm} sessionId="s1" onCollapse={() => {}} />);

    // Plan header label
    expect(screen.getAllByText("Plan").length).toBeGreaterThanOrEqual(1);
    // Markdown content rendered via mock
    expect(screen.getByTestId("markdown")).toBeTruthy();
    expect(screen.getByTestId("markdown").textContent).toBe("## Step 1\nDo something");

    // Allowed prompts
    expect(screen.getByText("Requested permissions")).toBeTruthy();
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("Run tests")).toBeTruthy();
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("Fix typo")).toBeTruthy();
  });

  it("renders fallback when no plan or prompts", async () => {
    const { PlanReviewOverlay } = await import("./PermissionBanner.js");
    const perm = makePermission({
      tool_name: "ExitPlanMode",
      input: {},
    });
    render(<PlanReviewOverlay permission={perm} sessionId="s1" onCollapse={() => {}} />);

    expect(screen.getByText("Plan approval requested")).toBeTruthy();
  });

  it("sends deny + interrupt when Deny is clicked", async () => {
    const { PlanReviewOverlay } = await import("./PermissionBanner.js");
    const perm = makePermission({
      tool_name: "ExitPlanMode",
      input: { plan: "Some plan" },
    });
    render(<PlanReviewOverlay permission={perm} sessionId="s1" onCollapse={() => {}} />);

    fireEvent.click(screen.getByText("Deny"));

    // Should send deny permission_response AND interrupt
    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "permission_response",
      behavior: "deny",
    }));
    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "interrupt" });
  });

  it("calls onCollapse when header bar is clicked", async () => {
    const { PlanReviewOverlay } = await import("./PermissionBanner.js");
    const perm = makePermission({
      tool_name: "ExitPlanMode",
      input: { plan: "Some plan" },
    });
    const onCollapse = vi.fn();
    render(<PlanReviewOverlay permission={perm} sessionId="s1" onCollapse={onCollapse} />);

    // The entire header bar has title="Minimize plan" and is clickable
    fireEvent.click(screen.getByTitle("Minimize plan"));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("calls onCollapse when Minimize button in action bar is clicked", async () => {
    const { PlanReviewOverlay } = await import("./PermissionBanner.js");
    const perm = makePermission({
      tool_name: "ExitPlanMode",
      input: { plan: "Some plan" },
    });
    const onCollapse = vi.fn();
    render(<PlanReviewOverlay permission={perm} sessionId="s1" onCollapse={onCollapse} />);

    // Minimize button in the sticky action bar next to Accept/Deny
    fireEvent.click(screen.getByText("Minimize"));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});
