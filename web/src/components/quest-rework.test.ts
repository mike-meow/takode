import { buildQuestReworkDraft } from "./quest-rework.js";

describe("buildQuestReworkDraft", () => {
  it("returns the planning-first feedback rework dispatch template", () => {
    expect(buildQuestReworkDraft("q-73")).toBe(
      "Work on [q-73](quest:q-73). Read the quest and check unaddressed feedback: `quest show q-73 && quest claim q-73`.\n" +
        "Address all unaddressed feedback items. After fixing each item, mark it as addressed: `quest address q-73 <index>`.\n" +
        "Return a plan for approval before implementing. After you send the plan, stop and wait for approval.",
    );
  });
});
