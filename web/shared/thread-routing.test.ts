import { describe, expect, it } from "vitest";
import { parseCommandThreadComment, parseThreadTextPrefix, stripCommandThreadComment } from "./thread-routing.js";

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
});
