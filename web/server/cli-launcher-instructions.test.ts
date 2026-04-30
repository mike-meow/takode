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

  it("includes Takode file-link guidance for quest comments and phase documentation", () => {
    const result = buildCompanionInstructions({ sessionNum: 42, backend: "codex" });
    expect(result).toContain("[app.ts:42](file:src/app.ts:42)");
    expect(result).toContain("including in quest comments and phase documentation");
    expect(result).toContain("Do not use `file://` URI schemes");
  });

  it("includes worktree guardrails when worktree is provided", () => {
    const result = buildCompanionInstructions({
      worktree: { branch: "test-branch", repoRoot: "/repo" },
    });
    expect(result).toContain("Worktree Session");
    expect(result).toContain("test-branch");
  });

  it("orders leader needs-input notifications after explicit user-visible text", () => {
    const result = buildCompanionInstructions({ sessionNum: 1, backend: "codex" });
    // Agents must make the actual question or decision visible before firing
    // the notification chip; otherwise the user sees an alert without context.
    expect(result).toContain("first send the detailed question, decision options, or confirmation text");
    expect(result).toContain("`[thread:main]` or `[thread:q-N]`");
    expect(result).toContain("normal worker and reviewer sessions use ordinary assistant text");
    expect(result).toContain("After that text is visible, call `takode notify needs-input`");
    expect(result).toContain("Do not fire the notification before the detailed text is visible");
    expect(result).toContain("one to three `--suggest <answer>` options");
    expect(result).toContain("never use suggestions instead of writing the full context in chat");
  });

  it("includes global resource lease guidance for shared dev-server and browser work", () => {
    const result = buildCompanionInstructions({ sessionNum: 1, backend: "codex" });
    // Shared browser and dev-server workflows can conflict across active agents,
    // so every backend gets the same CLI-first coordination instructions.
    expect(result).toContain("## Global Resource Leases");
    expect(result).toContain("You must acquire the relevant `takode lease`");
    expect(result).toContain("status is not a substitute for holding the lease");
    expect(result).toContain("takode lease status dev-server:companion");
    expect(result).toContain("takode lease acquire agent-browser");
    expect(result).toContain("Heartbeat while actively using the resource");
    expect(result).toContain("they do not enforce process startup ownership");
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
    expect(result).toContain("durable board recording");
    expect(result).toContain("Standard phases are recommended defaults, not mandates");
    expect(result).toContain("ask what it contributes over merging that work into a later phase");
    expect(result).toContain("`implement` includes normal investigation, root-cause analysis");
    expect(result).toContain("Explore is for investigation deliverables or unknown routing");
    expect(result).toContain("routine `explore -> implement`");
    expect(result).toContain("User Checkpoint is an intermediate user-participation stop");
    expect(result).toContain("notify the user and wait");
    expect(result).toContain("Omit notes for standard phases by default");
    expect(result).toContain("Phase documentation should be useful, not ritual");
    expect(result).toContain("Provide only deltas the actor is unlikely to infer");
    expect(result).toContain("Alignment approval is leader-owned by default");
    expect(result).toContain("Escalate alignment back to the user only");
    expect(result).toContain("send the changed worktree back to Code Review only after that checkpoint exists");
    expect(result).toContain("separate follow-up commit");
    expect(result).toContain("does not apply to purely read-only follow-up review discussion");
    expect(result).toContain(
      "Use `mental-simulation` when the question is whether a design, workflow, or responsibility split makes sense",
    );
    expect(result).toContain("reviewers may do only small bounded reruns or repros");
    expect(result).toContain("approval-gated runs");
    expect(result).toContain("route back deliberately: `implement`");
    expect(result).toContain("point the worker at the exact prior messages, quests, or discussions");
    expect(result).toContain("After that user-visible text exists, call `takode notify needs-input`");
  });

  it("returns codex-flavored guardrails for codex backend", () => {
    const result = getOrchestratorGuardrails("codex");
    expect(result).toContain("orchestrator leader session");
    expect(result).toContain("/quest-design");
    expect(result).toContain("initial Journey proposal-and-approval");
    expect(result).toContain("write the approved Journey to the board before or with dispatch");
    expect(result).toContain("Alignment approval is leader-owned by default");
    expect(result).toContain("Escalate alignment back to the user only");
    expect(result).toContain("send the changed worktree back to Code Review only after that checkpoint exists");
    expect(result).toContain("does not apply to purely read-only follow-up review discussion");
    expect(result).toContain("Use `outcome-review` when a reviewer should make an acceptance judgment");
    expect(result).toContain("small bounded reruns or repros");
    expect(result).toContain("approval-gated runs");
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
    expect(result).toContain("board-owned draft-or-active state for the quest");
    expect(result).toContain("Standard phases are recommended defaults, not mandates");
    expect(result).toContain("ask what it contributes over merging that work into a later phase");
    expect(result).toContain("USER_CHECKPOINTING");
    expect(result).toContain("User Checkpoint");
    expect(result).toContain("Do not use it as terminal closure, generic TBD, or optional leader-only indecision");
    expect(result).toContain("Omit notes for standard phases by default");
    expect(result).toContain("write the approved Journey to the board before or with dispatch");
    expect(result).toContain("Initial Journey approval comes before dispatch");
    expect(result).toContain("not a routine second user-approval gate");
    expect(result).toContain("Alignment approval is leader-owned by default");
    expect(result).toContain("Every active phase needs durable quest documentation");
    expect(result).toContain("Phase documentation should be useful, not ritual");
    expect(result).toContain("Worker-stream checkpoints are optional early visibility");
    expect(result).toContain("takode worker-stream");
    expect(result).toContain("do not let it replace phase documentation");
    expect(result).toContain("If the actor's context was compacted during the phase");
    expect(result).toContain("Provide only deltas the actor is unlikely to infer");
    expect(result).toContain("Bookkeeping is for extra durable state");
    expect(result).toContain("final debrief metadata after port when the port worker could not reliably create it");
    expect(result).toContain("Port handoff must also settle final debrief ownership");
    expect(result).toContain("`Final debrief draft:`");
    expect(result).toContain("`Debrief TLDR draft:`");
    expect(result).toContain("quest feedback add q-N --text-file /tmp/phase.md --tldr-file /tmp/phase-tldr.md");
    expect(result).toContain("use explicit `--phase`, `--phase-position`, `--phase-occurrence`");
    expect(result).toContain("Reviewers should judge phase documentation quality, not just presence");
    expect(result).toContain("significant ambiguity, scope change, Journey revision, user-visible tradeoff");
    expect(result).toContain("point the worker at the exact prior messages, quests, or discussions");
    expect(result).toContain(
      "Use `mental-simulation` when the question is whether a design, workflow, or responsibility split makes sense under replayed scenarios.",
    );
    expect(result).toContain(
      "a reviewer should make an acceptance judgment on external evidence the worker has usually already produced",
    );
    expect(result).toContain("reviewers may do only small bounded reruns or repros");
    expect(result).toContain("approval-gated runs rather than a reviewer acceptance pass");
    expect(result).toContain("route back deliberately: `implement` for behavior/code changes");
    expect(result).toContain("| Built-in phase | Board state | Leader brief | Assignee brief | Next leader action |");
    expect(result).toContain("~/.companion/quest-journey-phases/<phase-id>/");
    expect(result).toContain("`~/.companion/quest-journey-phases/alignment/leader.md`");
    expect(result).toContain("`~/.companion/quest-journey-phases/alignment/assignee.md`");
    expect(result).toContain("one confirmation can approve quest text, Journey, and dispatch plan");
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
