import { describe, it, expect } from "vitest";
import { isValidQuestId, isValidWaitForRef } from "./quest-journey.js";

describe("isValidQuestId", () => {
  it.each(["q-1", "q-42", "q-999", "Q-1"])("accepts valid quest ID: %j", (id) => {
    expect(isValidQuestId(id)).toBe(true);
  });

  it.each(["42", "#5", "q-", "foo", "q-abc", ""])("rejects invalid quest ID: %j", (id) => {
    expect(isValidQuestId(id)).toBe(false);
  });
});

describe("isValidWaitForRef", () => {
  // Quest refs (q-N)
  it.each(["q-1", "q-42", "q-999", "Q-1"])("accepts valid quest ref: %j", (ref) => {
    expect(isValidWaitForRef(ref)).toBe(true);
  });

  // Session refs (#N)
  it.each(["#1", "#42", "#332"])("accepts valid session ref: %j", (ref) => {
    expect(isValidWaitForRef(ref)).toBe(true);
  });

  // Invalid refs
  it.each(["42", "foo", "q-", "#", "#abc", "session-5", "", "q-1,#5"])(
    "rejects invalid wait-for ref: %j",
    (ref) => {
      expect(isValidWaitForRef(ref)).toBe(false);
    },
  );
});
