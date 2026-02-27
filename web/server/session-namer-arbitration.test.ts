import { describe, expect, it } from "vitest";
import {
  shouldAllowUserMessageOverrideOnNameMismatch,
  USER_OVERRIDE_WINDOW_MS,
  type NamerMutationRecord,
} from "./session-namer-arbitration.js";

describe("shouldAllowUserMessageOverrideOnNameMismatch", () => {
  const now = 1_700_000_000_000;

  it("allows override for a recent agent-triggered REVISE with matching fresh name", () => {
    // Validates the core race policy: user-message result can win after a
    // recently applied turn-completed/agent-paused revise.
    const last: NamerMutationRecord = {
      source: "turn_completed",
      action: "revise",
      nextName: "Fix append-only bugs",
      timestamp: now - 5_000,
    };
    expect(
      shouldAllowUserMessageOverrideOnNameMismatch("Fix append-only bugs", last, now),
    ).toBe(true);
  });

  it("rejects when there is no last mutation", () => {
    expect(
      shouldAllowUserMessageOverrideOnNameMismatch("Fix append-only bugs", undefined, now),
    ).toBe(false);
  });

  it("rejects when last mutation came from user_message", () => {
    const last: NamerMutationRecord = {
      source: "user_message",
      action: "revise",
      nextName: "Fix append-only bugs",
      timestamp: now - 5_000,
    };
    expect(
      shouldAllowUserMessageOverrideOnNameMismatch("Fix append-only bugs", last, now),
    ).toBe(false);
  });

  it("rejects when last mutation action is not revise", () => {
    const last: NamerMutationRecord = {
      source: "turn_completed",
      action: "new",
      nextName: "Fix append-only bugs",
      timestamp: now - 5_000,
    };
    expect(
      shouldAllowUserMessageOverrideOnNameMismatch("Fix append-only bugs", last, now),
    ).toBe(false);
  });

  it("rejects when the mutation is too old", () => {
    const last: NamerMutationRecord = {
      source: "turn_completed",
      action: "revise",
      nextName: "Fix append-only bugs",
      timestamp: now - USER_OVERRIDE_WINDOW_MS - 1,
    };
    expect(
      shouldAllowUserMessageOverrideOnNameMismatch("Fix append-only bugs", last, now),
    ).toBe(false);
  });

  it("rejects when fresh name does not match last mutation name", () => {
    const last: NamerMutationRecord = {
      source: "agent_paused",
      action: "revise",
      nextName: "Fix append-only bugs",
      timestamp: now - 5_000,
    };
    expect(
      shouldAllowUserMessageOverrideOnNameMismatch("Design append-only refactor", last, now),
    ).toBe(false);
  });
});
