import { describe, expect, it } from "vitest";
import {
  inferThreadTargetFromTextContent,
  parseCommandThreadComment,
  parseThreadTextPrefix,
  stripCommandThreadComment,
} from "./thread-routing.js";

describe("thread-routing", () => {
  it("parses and strips mandatory leader text prefixes", () => {
    // Leader text routing is explicit per message so stale hidden current-thread
    // state cannot silently route a response to the wrong quest.
    expect(parseThreadTextPrefix("[thread:q-941]\nImplementation update")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      body: "Implementation update",
    });
    expect(parseThreadTextPrefix("[thread:main]\nGeneral note")).toEqual({
      ok: true,
      target: { threadKey: "main" },
      body: "General note",
    });
    expect(parseThreadTextPrefix("[thread:q-941] Same-line implementation update")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      body: "Same-line implementation update",
    });
    expect(parseThreadTextPrefix("[thread:q-941]Implementation update")).toEqual({
      ok: true,
      target: { threadKey: "q-941", questId: "q-941" },
      body: "Implementation update",
    });
    expect(parseThreadTextPrefix("[thread:main]\tSame-line main note")).toEqual({
      ok: true,
      target: { threadKey: "main" },
      body: "Same-line main note",
    });
    expect(parseThreadTextPrefix("[thread:main]Using quest workflow")).toEqual({
      ok: true,
      target: { threadKey: "main" },
      body: "Using quest workflow",
    });
  });

  it("reports missing or invalid text prefixes without guessing", () => {
    expect(parseThreadTextPrefix("No marker")).toMatchObject({ ok: false, reason: "missing" });
    expect(parseThreadTextPrefix("[thread:foo]\nNo route")).toMatchObject({
      ok: false,
      reason: "invalid",
      marker: "[thread:foo]",
    });
  });

  it("parses and strips command routing comments", () => {
    const command = "# thread:q-941\nrg -n thread web/src";

    expect(parseCommandThreadComment(command)).toEqual({ threadKey: "q-941", questId: "q-941" });
    expect(stripCommandThreadComment(command)).toBe("rg -n thread web/src");
    expect(parseCommandThreadComment("rg -n thread web/src")).toBeNull();
  });

  it("infers durable quest routes only from unambiguous text content", () => {
    // History replay can recover route metadata from durable leader prompts,
    // but only for clear single-target quest dispatches.
    expect(inferThreadTargetFromTextContent("Review [q-1009](quest:q-1009) in Code Review.")).toEqual({
      threadKey: "q-1009",
      questId: "q-1009",
    });
    expect(
      inferThreadTargetFromTextContent("Advance [q-1009](quest:q-1009) to Port.\n\nDo not include q-1010."),
    ).toEqual({
      threadKey: "q-1009",
      questId: "q-1009",
    });
    expect(
      inferThreadTargetFromTextContent(
        [
          "1 event from 1 session",
          "",
          "#1323 | turn_end | ✓ 1m 52s | tools: 29 | [350]-[414] | 1 user msg [350]",
          '[350] leader: "Review [q-1005](quest:q-1005) in the Outcome Review phase.',
          '[414] "ACCEPT: evidence shows `q-99` inserted after Main for [q-1005](quest:q-1005)."',
        ].join("\n"),
      ),
    ).toEqual({
      threadKey: "q-1005",
      questId: "q-1005",
    });
    expect(inferThreadTargetFromTextContent("Compare q-1009 with q-1010 before deciding.")).toBeNull();
    expect(
      inferThreadTargetFromTextContent(
        'Compare q-1008 with q-1009 first.\n[10] leader: "Review [q-1010](quest:q-1010)."',
      ),
    ).toBeNull();
  });
});
