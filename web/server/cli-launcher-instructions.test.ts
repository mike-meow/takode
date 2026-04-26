import { describe, expect, it } from "vitest";
import {
  buildCompanionInstructions,
  buildInjectedSystemPromptForDebug,
  getOrchestratorGuardrails,
} from "./cli-launcher-instructions.js";

describe("buildCompanionInstructions", () => {
  it("includes the leader-reply rule for Claude sessions", () => {
    const result = buildCompanionInstructions({ sessionNum: 1, backend: "claude" });
    // Claude workers must see this rule so they don't try tool-based replies
    expect(result).toContain("## Responding to Leaders");
    expect(result).toContain("Do NOT use `SendMessage`");
    expect(result).toContain("SendMessageToLeader");
    expect(result).toContain("herd events");
  });

  it("includes the leader-reply rule when backend is unspecified (defaults to Claude-like)", () => {
    const result = buildCompanionInstructions({ sessionNum: 1 });
    expect(result).toContain("## Responding to Leaders");
  });

  it("excludes the leader-reply rule for Codex sessions", () => {
    // Codex doesn't have SendMessage tools, so the rule is unnecessary
    const result = buildCompanionInstructions({ sessionNum: 1, backend: "codex" });
    expect(result).not.toContain("## Responding to Leaders");
    expect(result).not.toContain("SendMessageToLeader");
  });

  it("includes session identity when sessionNum is provided", () => {
    const result = buildCompanionInstructions({ sessionNum: 42 });
    expect(result).toContain("Takode session #42");
  });

  it("includes worktree guardrails when worktree is provided", () => {
    const result = buildCompanionInstructions({
      worktree: { branch: "test-branch", repoRoot: "/repo" },
    });
    expect(result).toContain("Worktree Session");
    expect(result).toContain("test-branch");
  });

  it("appends extraInstructions at the end", () => {
    const result = buildCompanionInstructions({
      backend: "claude",
      extraInstructions: "EXTRA_MARKER",
    });
    expect(result).toContain("EXTRA_MARKER");
    // Extra instructions should come after the base sections
    const leaderIdx = result.indexOf("## Responding to Leaders");
    const extraIdx = result.indexOf("EXTRA_MARKER");
    expect(extraIdx).toBeGreaterThan(leaderIdx);
  });
});

describe("getOrchestratorGuardrails", () => {
  it("returns claude-flavored guardrails by default", () => {
    const result = getOrchestratorGuardrails();
    expect(result).toContain("orchestrator agent");
    expect(result).toContain("/quest-design");
    expect(result).toContain("initial Journey proposal-and-approval contract");
    expect(result).toContain("Planning approval is leader-owned by default");
    expect(result).toContain("Escalate planning back to the user only");
    expect(result).toContain("commit the current worktree state first");
    expect(result).toContain("separate follow-up commit");
  });

  it("returns codex-flavored guardrails for codex backend", () => {
    const result = getOrchestratorGuardrails("codex");
    expect(result).toContain("orchestrator leader session");
    expect(result).toContain("/quest-design");
    expect(result).toContain("initial Journey proposal-and-approval");
    expect(result).toContain("Planning approval is leader-owned by default");
    expect(result).toContain("Escalate planning back to the user only");
    expect(result).toContain("commit the current worktree state first");
  });
});

describe("buildInjectedSystemPromptForDebug", () => {
  it("builds a full offline leader prompt without a live server", () => {
    const result = buildInjectedSystemPromptForDebug({
      sessionNum: 7,
      backend: "claude",
      isOrchestrator: true,
      worktree: { branch: "jiayi-wt-1234", repoRoot: "/repo", parentBranch: "jiayi" },
    });

    expect(result).toContain("You are Takode session #7.");
    expect(result).toContain("Worktree Session");
    expect(result).toContain("Takode -- Cross-Session Orchestration");
    expect(result).toContain("Every dispatched task follows a **Quest Journey** assembled from phases");
    expect(result).toContain("Use `/quest-design` before creating or materially refining quest text");
    expect(result).toContain("Use `/leader-dispatch` before dispatching a fresh or newly refined quest");
    expect(result).toContain("board-owned active state for the quest");
    expect(result).toContain("Initial Journey approval comes before dispatch");
    expect(result).toContain("not a routine second user-approval gate");
    expect(result).toContain("Planning approval is leader-owned by default");
    expect(result).toContain("significant ambiguity, scope change, Journey revision, user-visible tradeoff");
    expect(result).toContain("| Built-in phase | Board state | Leader brief | Assignee brief | Next leader action |");
    expect(result).toContain("~/.companion/quest-journey-phases/<phase-id>/");
    expect(result).toContain("`planning/leader.md`");
    expect(result).toContain("`planning/assignee.md`");
    expect(result).not.toContain("Every dispatched task follows the **Quest Journey** lifecycle");
    expect(result).not.toContain("Every quest goes through the full journey");
  });

  it("builds a worker prompt without orchestrator guardrails unless requested", () => {
    const result = buildInjectedSystemPromptForDebug({ sessionNum: 8, backend: "codex" });

    expect(result).toContain("You are Takode session #8.");
    expect(result).not.toContain("Takode -- Cross-Session Orchestration");
    expect(result).not.toContain("leader-dispatch");
  });
});
