import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let questStore: typeof import("./quest-store.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "quest-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  questStore = await import("./quest-store.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function questDir(): string {
  return join(tempDir, ".companion", "questmaster");
}

// ===========================================================================
// createQuest
// ===========================================================================
describe("createQuest", () => {
  it("creates an idea quest with sequential IDs", () => {
    const q1 = questStore.createQuest({ title: "First quest" });
    const q2 = questStore.createQuest({ title: "Second quest" });

    expect(q1.questId).toBe("q-1");
    expect(q1.id).toBe("q-1-v1");
    expect(q1.version).toBe(1);
    expect(q1.status).toBe("idea");
    expect(q1.title).toBe("First quest");
    expect(q1.prevId).toBeUndefined();

    expect(q2.questId).toBe("q-2");
    expect(q2.id).toBe("q-2-v1");
  });

  it("creates a refined quest when status and description are provided", () => {
    const q = questStore.createQuest({
      title: "Refined quest",
      description: "Full details here",
      status: "refined",
    });

    expect(q.status).toBe("refined");
    if (q.status === "refined") {
      expect(q.description).toBe("Full details here");
    }
  });

  it("persists to disk as pretty-printed JSON", () => {
    questStore.createQuest({ title: "Disk test" });

    const raw = readFileSync(join(questDir(), "q-1-v1.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.title).toBe("Disk test");
    expect(parsed.questId).toBe("q-1");
    // Verify pretty-printed (has newlines)
    expect(raw).toContain("\n");
  });

  it("throws on empty title", () => {
    expect(() => questStore.createQuest({ title: "" })).toThrow(
      "Quest title is required",
    );
    expect(() => questStore.createQuest({ title: "   " })).toThrow(
      "Quest title is required",
    );
  });

  it("throws when creating with in_progress status directly", () => {
    expect(() =>
      questStore.createQuest({ title: "Bad", status: "in_progress" }),
    ).toThrow('Cannot create a quest directly in "in_progress" status');
  });

  it("throws when refined status is missing description", () => {
    expect(() =>
      questStore.createQuest({ title: "No desc", status: "refined" }),
    ).toThrow("Description is required for refined status");
  });

  it("saves tags and parentId", () => {
    const q = questStore.createQuest({
      title: "Tagged",
      tags: ["ui", "feature"],
      parentId: "q-0",
    });

    expect(q.tags).toEqual(["ui", "feature"]);
    expect(q.parentId).toBe("q-0");
  });
});

// ===========================================================================
// listQuests
// ===========================================================================
describe("listQuests", () => {
  it("returns empty array when no quests exist", () => {
    expect(questStore.listQuests()).toEqual([]);
  });

  it("returns only the latest version of each quest", () => {
    // Create two quests
    questStore.createQuest({ title: "Quest A" });
    questStore.createQuest({ title: "Quest B" });

    // Transition quest A to refined (creates v2)
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Detailed",
    });

    const quests = questStore.listQuests();
    expect(quests).toHaveLength(2);

    // Quest A should be at version 2 (refined)
    const qA = quests.find((q) => q.questId === "q-1");
    expect(qA?.version).toBe(2);
    expect(qA?.status).toBe("refined");

    // Quest B should be at version 1 (idea)
    const qB = quests.find((q) => q.questId === "q-2");
    expect(qB?.version).toBe(1);
    expect(qB?.status).toBe("idea");
  });

  it("sorts by createdAt descending (newest first)", async () => {
    questStore.createQuest({ title: "Older" });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    questStore.createQuest({ title: "Newer" });

    const quests = questStore.listQuests();
    expect(quests[0].title).toBe("Newer");
    expect(quests[1].title).toBe("Older");
  });
});

// ===========================================================================
// getQuest / getQuestVersion / getQuestHistory
// ===========================================================================
describe("getQuest", () => {
  it("returns latest version by questId", () => {
    questStore.createQuest({ title: "Test" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });

    const q = questStore.getQuest("q-1");
    expect(q?.version).toBe(2);
    expect(q?.status).toBe("refined");
  });

  it("returns null for non-existent questId", () => {
    expect(questStore.getQuest("q-999")).toBeNull();
  });
});

describe("getQuestVersion", () => {
  it("returns a specific version", () => {
    questStore.createQuest({ title: "Test" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });

    const v1 = questStore.getQuestVersion("q-1-v1");
    expect(v1?.version).toBe(1);
    expect(v1?.status).toBe("idea");

    const v2 = questStore.getQuestVersion("q-1-v2");
    expect(v2?.version).toBe(2);
    expect(v2?.status).toBe("refined");
  });

  it("returns null for non-existent version", () => {
    expect(questStore.getQuestVersion("q-1-v99")).toBeNull();
  });
});

describe("getQuestHistory", () => {
  it("returns all versions ordered oldest → newest", () => {
    questStore.createQuest({ title: "Evolving" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Step 1",
    });
    questStore.claimQuest("q-1", "session-abc");

    const history = questStore.getQuestHistory("q-1");
    expect(history).toHaveLength(3);
    expect(history[0].version).toBe(1);
    expect(history[1].version).toBe(2);
    expect(history[2].version).toBe(3);

    // Verify linked list
    expect(history[0].prevId).toBeUndefined();
    expect(history[1].prevId).toBe("q-1-v1");
    expect(history[2].prevId).toBe("q-1-v2");
  });

  it("returns empty array for non-existent questId", () => {
    expect(questStore.getQuestHistory("q-999")).toEqual([]);
  });
});

// ===========================================================================
// Forward transitions
// ===========================================================================
describe("forward transitions", () => {
  it("idea → refined → in_progress → needs_verification → done", () => {
    // Create idea
    const idea = questStore.createQuest({ title: "Full lifecycle" });
    expect(idea.status).toBe("idea");

    // → refined
    const refined = questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Full description",
    });
    expect(refined?.status).toBe("refined");
    expect(refined?.version).toBe(2);
    expect(refined?.prevId).toBe("q-1-v1");
    if (refined?.status === "refined") {
      expect(refined.description).toBe("Full description");
    }

    // → in_progress
    const inProgress = questStore.transitionQuest("q-1", {
      status: "in_progress",
      sessionId: "sess-1",
    });
    expect(inProgress?.status).toBe("in_progress");
    expect(inProgress?.version).toBe(3);
    if (inProgress?.status === "in_progress") {
      expect(inProgress.sessionId).toBe("sess-1");
      expect(inProgress.claimedAt).toBeGreaterThan(0);
      expect(inProgress.description).toBe("Full description"); // carried forward
    }

    // → needs_verification
    const needsVerification = questStore.transitionQuest("q-1", {
      status: "needs_verification",
      verificationItems: [
        { text: "Check mobile", checked: false },
        { text: "Run e2e", checked: false },
      ],
    });
    expect(needsVerification?.status).toBe("needs_verification");
    expect(needsVerification?.version).toBe(4);
    if (needsVerification?.status === "needs_verification") {
      expect(needsVerification.verificationItems).toHaveLength(2);
      expect(needsVerification.sessionId).toBe("sess-1"); // carried forward
    }

    // → done
    const done = questStore.transitionQuest("q-1", { status: "done" });
    expect(done?.status).toBe("done");
    expect(done?.version).toBe(5);
    if (done?.status === "done") {
      expect(done.completedAt).toBeGreaterThan(0);
      expect(done.verificationItems).toHaveLength(2); // carried forward
    }
  });

  it("carries forward tags and parentId through transitions", () => {
    questStore.createQuest({
      title: "Tagged",
      tags: ["ui"],
      parentId: "q-0",
    });
    const refined = questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });

    expect(refined?.tags).toEqual(["ui"]);
    expect(refined?.parentId).toBe("q-0");
  });
});

// ===========================================================================
// Backward transitions (the linked-list feature)
// ===========================================================================
describe("backward transitions", () => {
  it("needs_verification → in_progress creates a new version preserving history", () => {
    // Build up to needs_verification
    questStore.createQuest({ title: "Rework test" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Original plan",
    });
    questStore.claimQuest("q-1", "sess-1");
    questStore.completeQuest("q-1", [
      { text: "Check UI", checked: false },
    ]);

    // Now go backwards to in_progress (rework)
    const rework = questStore.transitionQuest("q-1", {
      status: "in_progress",
      sessionId: "sess-2", // different agent picks it up
    });

    expect(rework?.status).toBe("in_progress");
    expect(rework?.version).toBe(5); // v1=idea, v2=refined, v3=in_progress, v4=needs_verification, v5=rework
    expect(rework?.prevId).toBe("q-1-v4");
    if (rework?.status === "in_progress") {
      expect(rework.sessionId).toBe("sess-2");
      expect(rework.description).toBe("Original plan"); // carried forward
    }

    // Full history is preserved
    const history = questStore.getQuestHistory("q-1");
    expect(history).toHaveLength(5);
    expect(history.map((h) => h.status)).toEqual([
      "idea",
      "refined",
      "in_progress",
      "needs_verification",
      "in_progress", // rework
    ]);
  });
});

// ===========================================================================
// Convenience methods
// ===========================================================================
describe("claimQuest", () => {
  it("transitions to in_progress with sessionId", () => {
    questStore.createQuest({ title: "Claim me" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });

    const claimed = questStore.claimQuest("q-1", "sess-abc");
    expect(claimed?.status).toBe("in_progress");
    if (claimed?.status === "in_progress") {
      expect(claimed.sessionId).toBe("sess-abc");
    }
  });

  it("fails when already claimed by a different session", () => {
    questStore.createQuest({ title: "Contested" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    questStore.claimQuest("q-1", "sess-1");

    expect(() => questStore.claimQuest("q-1", "sess-2")).toThrow(
      "already claimed by session sess-1",
    );
  });

  it("allows re-claiming by the same session", () => {
    questStore.createQuest({ title: "Re-claim" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    questStore.claimQuest("q-1", "sess-1");

    // Same session can re-claim (creates new version)
    const reClaimed = questStore.claimQuest("q-1", "sess-1");
    expect(reClaimed?.status).toBe("in_progress");
  });

  it("returns null for non-existent quest", () => {
    expect(questStore.claimQuest("q-999", "sess-1")).toBeNull();
  });
});

describe("completeQuest", () => {
  it("transitions to needs_verification with items", () => {
    questStore.createQuest({ title: "Complete me" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    questStore.claimQuest("q-1", "sess-1");

    const completed = questStore.completeQuest("q-1", [
      { text: "Test on mobile", checked: false },
      { text: "Check dark mode", checked: false },
    ]);

    expect(completed?.status).toBe("needs_verification");
    if (completed?.status === "needs_verification") {
      expect(completed.verificationItems).toHaveLength(2);
    }
  });
});

describe("markDone", () => {
  it("transitions to done with completedAt", () => {
    questStore.createQuest({ title: "Finish me" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    questStore.claimQuest("q-1", "sess-1");
    questStore.completeQuest("q-1", [
      { text: "Verify", checked: true },
    ]);

    const done = questStore.markDone("q-1");
    expect(done?.status).toBe("done");
    if (done?.status === "done") {
      expect(done.completedAt).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// cancelQuest
// ===========================================================================
describe("cancelQuest", () => {
  it("cancels an idea quest directly to done+cancelled", () => {
    // cancelQuest should work from any status, including idea (no sessionId, no verificationItems)
    questStore.createQuest({ title: "Cancel from idea" });

    const cancelled = questStore.cancelQuest("q-1");
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("done");
    expect(cancelled!.version).toBe(2);
    expect(cancelled!.prevId).toBe("q-1-v1");
    if (cancelled!.status === "done") {
      expect(cancelled!.cancelled).toBe(true);
      expect(cancelled!.completedAt).toBeGreaterThan(0);
    }
  });

  it("cancels a refined quest with notes", () => {
    questStore.createQuest({ title: "Cancel refined" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Some details",
    });

    const cancelled = questStore.cancelQuest("q-1", "No longer needed");
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("done");
    if (cancelled!.status === "done") {
      expect(cancelled!.cancelled).toBe(true);
      expect(cancelled!.notes).toBe("No longer needed");
    }
    // Description should be carried forward
    if ("description" in cancelled!) {
      expect((cancelled as { description: string }).description).toBe("Some details");
    }
  });

  it("cancels an in_progress quest, carrying forward sessionId", () => {
    // Build up to in_progress
    questStore.createQuest({ title: "Cancel in progress" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Working on it",
    });
    questStore.claimQuest("q-1", "sess-1");

    const cancelled = questStore.cancelQuest("q-1");
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("done");
    if (cancelled!.status === "done") {
      expect(cancelled!.cancelled).toBe(true);
      expect(cancelled!.sessionId).toBe("sess-1");
    }
  });

  it("cancels a needs_verification quest, carrying forward verificationItems", () => {
    // Build up to needs_verification
    questStore.createQuest({ title: "Cancel needs verification" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Verify this",
    });
    questStore.claimQuest("q-1", "sess-1");
    questStore.completeQuest("q-1", [
      { text: "Check UI", checked: false },
    ]);

    const cancelled = questStore.cancelQuest("q-1");
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("done");
    if (cancelled!.status === "done") {
      expect(cancelled!.cancelled).toBe(true);
      expect(cancelled!.verificationItems).toHaveLength(1);
    }
  });

  it("carries forward tags and parentId", () => {
    questStore.createQuest({
      title: "Tagged cancel",
      tags: ["ui", "feature"],
      parentId: "q-0",
    });

    const cancelled = questStore.cancelQuest("q-1");
    expect(cancelled!.tags).toEqual(["ui", "feature"]);
    expect(cancelled!.parentId).toBe("q-0");
  });

  it("returns null for non-existent quest", () => {
    expect(questStore.cancelQuest("q-999")).toBeNull();
  });
});

// ===========================================================================
// patchQuest (same-stage edit)
// ===========================================================================
describe("patchQuest", () => {
  it("edits title without creating a new version", () => {
    questStore.createQuest({ title: "Typo" });

    const patched = questStore.patchQuest("q-1", { title: "Fixed" });
    expect(patched?.title).toBe("Fixed");
    expect(patched?.version).toBe(1); // no new version

    // Only one file on disk
    const files = readdirSync(questDir()).filter(
      (f) => f.startsWith("q-1") && f.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
  });

  it("returns null for non-existent quest", () => {
    expect(questStore.patchQuest("q-999", { title: "Nope" })).toBeNull();
  });
});

// ===========================================================================
// checkVerificationItem
// ===========================================================================
describe("checkVerificationItem", () => {
  it("toggles a verification checkbox", () => {
    questStore.createQuest({ title: "Verify me" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    questStore.claimQuest("q-1", "sess-1");
    questStore.completeQuest("q-1", [
      { text: "Item A", checked: false },
      { text: "Item B", checked: false },
    ]);

    const toggled = questStore.checkVerificationItem("q-1", 0, true);
    if (toggled?.status === "needs_verification") {
      expect(toggled.verificationItems[0].checked).toBe(true);
      expect(toggled.verificationItems[1].checked).toBe(false);
    }
  });

  it("throws on out-of-range index", () => {
    questStore.createQuest({ title: "OOB test" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    questStore.claimQuest("q-1", "sess-1");
    questStore.completeQuest("q-1", [{ text: "Only one", checked: false }]);

    expect(() => questStore.checkVerificationItem("q-1", 5, true)).toThrow(
      "out of range",
    );
  });

  it("throws when quest has no verification items", () => {
    questStore.createQuest({ title: "No items" });

    expect(() => questStore.checkVerificationItem("q-1", 0, true)).toThrow(
      "does not have verification items",
    );
  });
});

// ===========================================================================
// deleteQuest
// ===========================================================================
describe("deleteQuest", () => {
  it("deletes all versions of a quest", () => {
    questStore.createQuest({ title: "Delete me" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });

    // Should have 2 version files
    const filesBefore = readdirSync(questDir()).filter(
      (f) => f.startsWith("q-1"),
    );
    expect(filesBefore).toHaveLength(2);

    const result = questStore.deleteQuest("q-1");
    expect(result).toBe(true);

    // All version files gone
    const filesAfter = readdirSync(questDir()).filter(
      (f) => f.startsWith("q-1"),
    );
    expect(filesAfter).toHaveLength(0);

    // Quest no longer findable
    expect(questStore.getQuest("q-1")).toBeNull();
  });

  it("returns false for non-existent quest", () => {
    expect(questStore.deleteQuest("q-999")).toBe(false);
  });
});

// ===========================================================================
// Transition validation
// ===========================================================================
describe("transition validation", () => {
  it("requires description for refined status", () => {
    questStore.createQuest({ title: "No desc" });
    expect(() =>
      questStore.transitionQuest("q-1", { status: "refined" }),
    ).toThrow("Description is required");
  });

  it("requires sessionId for in_progress status", () => {
    questStore.createQuest({ title: "No session" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    expect(() =>
      questStore.transitionQuest("q-1", { status: "in_progress" }),
    ).toThrow("sessionId is required");
  });

  it("requires verificationItems for needs_verification status", () => {
    questStore.createQuest({ title: "No items" });
    questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    questStore.claimQuest("q-1", "sess-1");
    expect(() =>
      questStore.transitionQuest("q-1", { status: "needs_verification" }),
    ).toThrow("verificationItems are required");
  });

  it("returns null when transitioning non-existent quest", () => {
    expect(
      questStore.transitionQuest("q-999", { status: "refined", description: "x" }),
    ).toBeNull();
  });
});

// ===========================================================================
// Feedback thread
// ===========================================================================
describe("feedback", () => {
  /** Helper: create a quest in needs_verification state */
  function setupVerificationQuest() {
    questStore.createQuest({ title: "Feedback test" });
    questStore.transitionQuest("q-1", { status: "refined", description: "Ready" });
    questStore.claimQuest("q-1", "sess-1");
    questStore.completeQuest("q-1", [
      { text: "Check A", checked: false },
      { text: "Check B", checked: false },
    ]);
  }

  it("sets feedback via patchQuest", () => {
    setupVerificationQuest();
    const entry = { author: "human" as const, text: "Layout off on mobile", ts: Date.now() };
    const result = questStore.patchQuest("q-1", { feedback: [entry] });
    expect(result).not.toBeNull();
    const fb = (result as { feedback?: { author: string; text: string }[] }).feedback;
    expect(fb).toHaveLength(1);
    expect(fb![0].text).toBe("Layout off on mobile");
    expect(fb![0].author).toBe("human");
  });

  it("clears feedback when set to empty array", () => {
    setupVerificationQuest();
    const entry = { author: "human" as const, text: "Some feedback", ts: Date.now() };
    questStore.patchQuest("q-1", { feedback: [entry] });
    const result = questStore.patchQuest("q-1", { feedback: [] });
    // Empty array clears the field entirely
    expect((result as { feedback?: unknown[] }).feedback).toBeUndefined();
  });

  it("carries forward feedback on needs_verification → in_progress transition", () => {
    setupVerificationQuest();
    const entry = { author: "human" as const, text: "Fix this", ts: Date.now() };
    questStore.patchQuest("q-1", { feedback: [entry] });

    // Transition back to in_progress (rework)
    const result = questStore.transitionQuest("q-1", { status: "in_progress", sessionId: "sess-1" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("in_progress");
    const fb = (result as { feedback?: { text: string }[] }).feedback;
    expect(fb).toHaveLength(1);
    expect(fb![0].text).toBe("Fix this");
  });

  it("carries forward feedback on in_progress → needs_verification transition", () => {
    setupVerificationQuest();
    const entry = { author: "human" as const, text: "Fix this", ts: Date.now() };
    questStore.patchQuest("q-1", { feedback: [entry] });

    // Rework cycle: back to in_progress
    questStore.transitionQuest("q-1", { status: "in_progress", sessionId: "sess-1" });
    // Agent submits again with new verification items — feedback thread persists
    const result = questStore.transitionQuest("q-1", {
      status: "needs_verification",
      verificationItems: [{ text: "New check", checked: false }],
    });
    expect(result).not.toBeNull();
    const fb = (result as { feedback?: { text: string }[] }).feedback;
    expect(fb).toHaveLength(1);
    expect(fb![0].text).toBe("Fix this");
  });

  it("carries forward feedback to done", () => {
    setupVerificationQuest();
    const entries = [
      { author: "human" as const, text: "Fix this", ts: Date.now() },
      { author: "agent" as const, text: "Fixed with flex-wrap", ts: Date.now() },
    ];
    questStore.patchQuest("q-1", { feedback: entries });

    const result = questStore.transitionQuest("q-1", { status: "done", notes: "shipped" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("done");
    const fb = (result as { feedback?: { author: string; text: string }[] }).feedback;
    expect(fb).toHaveLength(2);
    expect(fb![0].author).toBe("human");
    expect(fb![1].author).toBe("agent");
  });

  it("accumulates multiple feedback entries", () => {
    setupVerificationQuest();
    // First entry
    questStore.patchQuest("q-1", {
      feedback: [{ author: "human" as const, text: "Issue 1", ts: Date.now() }],
    });
    // Append second entry (caller manages the array)
    const current = questStore.getQuest("q-1");
    const existing = (current as { feedback?: { author: "human" | "agent"; text: string; ts: number }[] }).feedback ?? [];
    questStore.patchQuest("q-1", {
      feedback: [...existing, { author: "agent" as const, text: "Fixed issue 1", ts: Date.now() }],
    });

    const result = questStore.getQuest("q-1");
    const fb = (result as { feedback?: { text: string }[] }).feedback;
    expect(fb).toHaveLength(2);
    expect(fb![0].text).toBe("Issue 1");
    expect(fb![1].text).toBe("Fixed issue 1");
  });

  it("carries forward feedback through cancelQuest", () => {
    setupVerificationQuest();
    questStore.patchQuest("q-1", {
      feedback: [{ author: "human" as const, text: "Nevermind", ts: Date.now() }],
    });
    const result = questStore.cancelQuest("q-1", "Not needed");
    expect(result).not.toBeNull();
    const fb = (result as { feedback?: { text: string }[] }).feedback;
    expect(fb).toHaveLength(1);
    expect(fb![0].text).toBe("Nevermind");
  });
});
