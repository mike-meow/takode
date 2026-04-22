import { describe, expect, it } from "vitest";
import { applyDefaultClaudeBackend, buildCodexTurnSegments, computeCodexRevertPlan, resolveBackend } from "./sessions-helpers.js";

describe("sessions route helpers", () => {
  it("recognizes supported backends", () => {
    // Route parsing should only accept the explicit session backend values the
    // launcher understands, leaving unknown strings rejected at the boundary.
    expect(resolveBackend("codex")).toBe("codex");
    expect(resolveBackend("bad-backend")).toBeNull();
  });

  it("segments Codex history by completed turns", () => {
    // Revert planning depends on stable user/result turn grouping rather than
    // brittle raw message indexes alone.
    expect(
      buildCodexTurnSegments([
        { type: "user_message", id: "u1" },
        { type: "assistant" },
        { type: "result" },
        { type: "user_message", id: "u2" },
      ]),
    ).toEqual([
      { startIdx: 0, userMessageIds: ["u1"] },
      { startIdx: 3, userMessageIds: ["u2"] },
    ]);
  });

  it("computes a revert plan for the requested user message", () => {
    // The sessions revert endpoint needs both the history truncation point and
    // the number of turns Codex should roll back from that boundary.
    expect(
      computeCodexRevertPlan(
        {
          messageHistory: [
            { type: "user_message", id: "u1" },
            { type: "result" },
            { type: "user_message", id: "u2" },
            { type: "assistant" },
            { type: "result" },
          ],
        },
        "u2",
      ),
    ).toEqual({
      truncateIdx: 2,
      numTurns: 1,
      exactTurnBoundary: true,
    });
  });

  it("maps default Claude backend from settings", () => {
    // The helper preserves explicit codex sessions but resolves the generic
    // "claude" choice to the user's configured WebSocket vs SDK default.
    const result = applyDefaultClaudeBackend("claude");
    expect(result === "claude" || result === "claude-sdk").toBe(true);
  });
});
