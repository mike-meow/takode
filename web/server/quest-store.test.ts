import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
  it("creates an idea quest with sequential IDs", async () => {
    const q1 = await questStore.createQuest({ title: "First quest" });
    const q2 = await questStore.createQuest({ title: "Second quest" });

    expect(q1.questId).toBe("q-1");
    expect(q1.id).toBe("q-1-v1");
    expect(q1.version).toBe(1);
    expect(q1.status).toBe("idea");
    expect(q1.title).toBe("First quest");
    expect(q1.prevId).toBeUndefined();

    expect(q2.questId).toBe("q-2");
    expect(q2.id).toBe("q-2-v1");
  });

  it("creates a refined quest when status and description are provided", async () => {
    const q = await questStore.createQuest({
      title: "Refined quest",
      description: "Full details here",
      status: "refined",
    });

    expect(q.status).toBe("refined");
    if (q.status === "refined") {
      expect(q.description).toBe("Full details here");
    }
  });

  it("persists to disk as pretty-printed JSON", async () => {
    await questStore.createQuest({ title: "Disk test" });

    const raw = readFileSync(join(questDir(), "q-1-v1.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.title).toBe("Disk test");
    expect(parsed.questId).toBe("q-1");
    // Verify pretty-printed (has newlines)
    expect(raw).toContain("\n");
  });

  it("throws on empty title", async () => {
    await expect(questStore.createQuest({ title: "" })).rejects.toThrow(
      "Quest title is required",
    );
    await expect(questStore.createQuest({ title: "   " })).rejects.toThrow(
      "Quest title is required",
    );
  });

  it("throws when creating with in_progress status directly", async () => {
    await expect(
      questStore.createQuest({ title: "Bad", status: "in_progress" }),
    ).rejects.toThrow('Cannot create a quest directly in "in_progress" status');
  });

  it("throws when refined status is missing description", async () => {
    await expect(
      questStore.createQuest({ title: "No desc", status: "refined" }),
    ).rejects.toThrow("Description is required for refined status");
  });

  it("saves tags and parentId", async () => {
    const q = await questStore.createQuest({
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
  it("returns empty array when no quests exist", async () => {
    expect(await questStore.listQuests()).toEqual([]);
  });

  it("returns only the latest version of each quest", async () => {
    // Create two quests
    await questStore.createQuest({ title: "Quest A" });
    await questStore.createQuest({ title: "Quest B" });

    // Transition quest A to refined (creates v2)
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Detailed",
    });

    const quests = await questStore.listQuests();
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
    await questStore.createQuest({ title: "Older" });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await questStore.createQuest({ title: "Newer" });

    const quests = await questStore.listQuests();
    expect(quests[0].title).toBe("Newer");
    expect(quests[1].title).toBe("Older");
  });
});

// ===========================================================================
// getQuest / getQuestVersion / getQuestHistory
// ===========================================================================
describe("getQuest", () => {
  it("returns latest version by questId", async () => {
    await questStore.createQuest({ title: "Test" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });

    const q = await questStore.getQuest("q-1");
    expect(q?.version).toBe(2);
    expect(q?.status).toBe("refined");
  });

  it("returns null for non-existent questId", async () => {
    expect(await questStore.getQuest("q-999")).toBeNull();
  });

  it("normalizes legacy done ownership (sessionId -> previousOwnerSessionIds)", async () => {
    const legacy = {
      id: "q-1-v1",
      questId: "q-1",
      version: 1,
      title: "Legacy",
      createdAt: Date.now(),
      status: "done",
      description: "Legacy data",
      sessionId: "sess-legacy",
      verificationItems: [{ text: "verify", checked: true }],
      completedAt: Date.now(),
    };
    await writeFile(join(questDir(), "q-1-v1.json"), JSON.stringify(legacy), "utf-8");

    const q = await questStore.getQuest("q-1");
    expect(q?.status).toBe("done");
    if (q?.status === "done") {
      expect(q.sessionId).toBeUndefined();
      expect(q.previousOwnerSessionIds).toEqual(["sess-legacy"]);
    }
  });
});

describe("getQuestVersion", () => {
  it("returns a specific version", async () => {
    await questStore.createQuest({ title: "Test" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });

    const v1 = await questStore.getQuestVersion("q-1-v1");
    expect(v1?.version).toBe(1);
    expect(v1?.status).toBe("idea");

    const v2 = await questStore.getQuestVersion("q-1-v2");
    expect(v2?.version).toBe(2);
    expect(v2?.status).toBe("refined");
  });

  it("returns null for non-existent version", async () => {
    expect(await questStore.getQuestVersion("q-1-v99")).toBeNull();
  });
});

describe("getQuestHistory", () => {
  it("returns all versions ordered oldest → newest", async () => {
    await questStore.createQuest({ title: "Evolving" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Step 1",
    });
    await questStore.claimQuest("q-1", "session-abc");

    const history = await questStore.getQuestHistory("q-1");
    expect(history).toHaveLength(3);
    expect(history[0].version).toBe(1);
    expect(history[1].version).toBe(2);
    expect(history[2].version).toBe(3);

    // Verify linked list
    expect(history[0].prevId).toBeUndefined();
    expect(history[1].prevId).toBe("q-1-v1");
    expect(history[2].prevId).toBe("q-1-v2");
  });

  it("returns empty array for non-existent questId", async () => {
    expect(await questStore.getQuestHistory("q-999")).toEqual([]);
  });
});

// ===========================================================================
// Forward transitions
// ===========================================================================
describe("forward transitions", () => {
  it("idea → refined → in_progress → needs_verification → done", async () => {
    // Create idea
    const idea = await questStore.createQuest({ title: "Full lifecycle" });
    expect(idea.status).toBe("idea");

    // → refined
    const refined = await questStore.transitionQuest("q-1", {
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
    const inProgress = await questStore.transitionQuest("q-1", {
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
    const needsVerification = await questStore.transitionQuest("q-1", {
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
    const done = await questStore.transitionQuest("q-1", { status: "done" });
    expect(done?.status).toBe("done");
    expect(done?.version).toBe(5);
    if (done?.status === "done") {
      expect(done.completedAt).toBeGreaterThan(0);
      expect(done.verificationItems).toHaveLength(2); // carried forward
      expect(done.sessionId).toBeUndefined(); // active owner is cleared at done
      expect(done.previousOwnerSessionIds).toContain("sess-1");
    }
  });

  it("carries forward tags and parentId through transitions", async () => {
    await questStore.createQuest({
      title: "Tagged",
      tags: ["ui"],
      parentId: "q-0",
    });
    const refined = await questStore.transitionQuest("q-1", {
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
  it("needs_verification → in_progress creates a new version preserving history", async () => {
    // Build up to needs_verification
    await questStore.createQuest({ title: "Rework test" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Original plan",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [
      { text: "Check UI", checked: false },
    ]);

    // Now go backwards to in_progress (rework)
    const rework = await questStore.transitionQuest("q-1", {
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
    const history = await questStore.getQuestHistory("q-1");
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
  it("transitions to in_progress with sessionId", async () => {
    await questStore.createQuest({ title: "Claim me" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });

    const claimed = await questStore.claimQuest("q-1", "sess-abc");
    expect(claimed?.status).toBe("in_progress");
    if (claimed?.status === "in_progress") {
      expect(claimed.sessionId).toBe("sess-abc");
    }
  });

  it("fails when already claimed by a different session", async () => {
    await questStore.createQuest({ title: "Contested" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");

    await expect(questStore.claimQuest("q-1", "sess-2")).rejects.toThrow(
      "already claimed by session sess-1",
    );
  });

  it("allows transfer when current owner is archived", async () => {
    await questStore.createQuest({ title: "Takeover" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");

    const claimed = await questStore.claimQuest("q-1", "sess-2", {
      allowArchivedOwnerTakeover: true,
      isSessionArchived: (sid) => sid === "sess-1",
    });
    expect(claimed?.status).toBe("in_progress");
    if (claimed?.status === "in_progress") {
      expect(claimed.sessionId).toBe("sess-2");
      expect(claimed.previousOwnerSessionIds).toContain("sess-1");
      expect(claimed.previousOwnerSessionIds).not.toContain("sess-2");
    }
  });

  it("allows re-claiming by the same session", async () => {
    await questStore.createQuest({ title: "Re-claim" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");

    // Same session can re-claim (creates new version)
    const reClaimed = await questStore.claimQuest("q-1", "sess-1");
    expect(reClaimed?.status).toBe("in_progress");
  });

  it("returns null for non-existent quest", async () => {
    expect(await questStore.claimQuest("q-999", "sess-1")).toBeNull();
  });
});

describe("completeQuest", () => {
  it("transitions to needs_verification with items", async () => {
    await questStore.createQuest({ title: "Complete me" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");

    const completed = await questStore.completeQuest("q-1", [
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
  it("transitions to done with completedAt", async () => {
    await questStore.createQuest({ title: "Finish me" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [
      { text: "Verify", checked: true },
    ]);

    const done = await questStore.markDone("q-1");
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
  it("cancels an idea quest directly to done+cancelled", async () => {
    // cancelQuest should work from any status, including idea (no sessionId, no verificationItems)
    await questStore.createQuest({ title: "Cancel from idea" });

    const cancelled = await questStore.cancelQuest("q-1");
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("done");
    expect(cancelled!.version).toBe(2);
    expect(cancelled!.prevId).toBe("q-1-v1");
    if (cancelled!.status === "done") {
      expect(cancelled!.cancelled).toBe(true);
      expect(cancelled!.completedAt).toBeGreaterThan(0);
    }
  });

  it("cancels a refined quest with notes", async () => {
    await questStore.createQuest({ title: "Cancel refined" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Some details",
    });

    const cancelled = await questStore.cancelQuest("q-1", "No longer needed");
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

  it("cancels an in_progress quest, moving active owner to previous owners", async () => {
    // Build up to in_progress
    await questStore.createQuest({ title: "Cancel in progress" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Working on it",
    });
    await questStore.claimQuest("q-1", "sess-1");

    const cancelled = await questStore.cancelQuest("q-1");
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("done");
    if (cancelled!.status === "done") {
      expect(cancelled!.cancelled).toBe(true);
      expect(cancelled!.sessionId).toBeUndefined();
      expect(cancelled!.previousOwnerSessionIds).toContain("sess-1");
    }
  });

  it("cancels a needs_verification quest, carrying forward verificationItems", async () => {
    // Build up to needs_verification
    await questStore.createQuest({ title: "Cancel needs verification" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Verify this",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [
      { text: "Check UI", checked: false },
    ]);

    const cancelled = await questStore.cancelQuest("q-1");
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("done");
    if (cancelled!.status === "done") {
      expect(cancelled!.cancelled).toBe(true);
      expect(cancelled!.verificationItems).toHaveLength(1);
    }
  });

  it("carries forward tags and parentId", async () => {
    await questStore.createQuest({
      title: "Tagged cancel",
      tags: ["ui", "feature"],
      parentId: "q-0",
    });

    const cancelled = await questStore.cancelQuest("q-1");
    expect(cancelled!.tags).toEqual(["ui", "feature"]);
    expect(cancelled!.parentId).toBe("q-0");
  });

  it("returns null for non-existent quest", async () => {
    expect(await questStore.cancelQuest("q-999")).toBeNull();
  });
});

// ===========================================================================
// patchQuest (same-stage edit)
// ===========================================================================
describe("patchQuest", () => {
  it("edits title without creating a new version", async () => {
    await questStore.createQuest({ title: "Typo" });

    const patched = await questStore.patchQuest("q-1", { title: "Fixed" });
    expect(patched?.title).toBe("Fixed");
    expect(patched?.version).toBe(1); // no new version

    // Only one file on disk
    const files = readdirSync(questDir()).filter(
      (f) => f.startsWith("q-1") && f.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
  });

  it("returns null for non-existent quest", async () => {
    expect(await questStore.patchQuest("q-999", { title: "Nope" })).toBeNull();
  });
});

// ===========================================================================
// checkVerificationItem
// ===========================================================================
describe("checkVerificationItem", () => {
  it("toggles a verification checkbox", async () => {
    await questStore.createQuest({ title: "Verify me" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [
      { text: "Item A", checked: false },
      { text: "Item B", checked: false },
    ]);

    const toggled = await questStore.checkVerificationItem("q-1", 0, true);
    if (toggled?.status === "needs_verification") {
      expect(toggled.verificationItems[0].checked).toBe(true);
      expect(toggled.verificationItems[1].checked).toBe(false);
    }
  });

  it("throws on out-of-range index", async () => {
    await questStore.createQuest({ title: "OOB test" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [{ text: "Only one", checked: false }]);

    await expect(questStore.checkVerificationItem("q-1", 5, true)).rejects.toThrow(
      "out of range",
    );
  });

  it("throws when quest has no verification items", async () => {
    await questStore.createQuest({ title: "No items" });

    await expect(questStore.checkVerificationItem("q-1", 0, true)).rejects.toThrow(
      "does not have verification items",
    );
  });
});

// ===========================================================================
// deleteQuest
// ===========================================================================
describe("deleteQuest", () => {
  it("deletes all versions of a quest", async () => {
    await questStore.createQuest({ title: "Delete me" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });

    // Should have 2 version files
    const filesBefore = readdirSync(questDir()).filter(
      (f) => f.startsWith("q-1"),
    );
    expect(filesBefore).toHaveLength(2);

    const result = await questStore.deleteQuest("q-1");
    expect(result).toBe(true);

    // All version files gone
    const filesAfter = readdirSync(questDir()).filter(
      (f) => f.startsWith("q-1"),
    );
    expect(filesAfter).toHaveLength(0);

    // Quest no longer findable
    expect(await questStore.getQuest("q-1")).toBeNull();
  });

  it("returns false for non-existent quest", async () => {
    expect(await questStore.deleteQuest("q-999")).toBe(false);
  });
});

// ===========================================================================
// Transition validation
// ===========================================================================
describe("transition validation", () => {
  it("requires description for refined status", async () => {
    await questStore.createQuest({ title: "No desc" });
    await expect(
      questStore.transitionQuest("q-1", { status: "refined" }),
    ).rejects.toThrow("Description is required");
  });

  it("requires sessionId for in_progress status", async () => {
    await questStore.createQuest({ title: "No session" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await expect(
      questStore.transitionQuest("q-1", { status: "in_progress" }),
    ).rejects.toThrow("sessionId is required");
  });

  it("requires verificationItems for needs_verification status", async () => {
    await questStore.createQuest({ title: "No items" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await expect(
      questStore.transitionQuest("q-1", { status: "needs_verification" }),
    ).rejects.toThrow("verificationItems are required");
  });

  it("returns null when transitioning non-existent quest", async () => {
    expect(
      await questStore.transitionQuest("q-999", { status: "refined", description: "x" }),
    ).toBeNull();
  });
});

// ===========================================================================
// Feedback thread
// ===========================================================================
describe("feedback", () => {
  /** Helper: create a quest in needs_verification state */
  async function setupVerificationQuest() {
    await questStore.createQuest({ title: "Feedback test" });
    await questStore.transitionQuest("q-1", { status: "refined", description: "Ready" });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [
      { text: "Check A", checked: false },
      { text: "Check B", checked: false },
    ]);
  }

  it("sets feedback via patchQuest", async () => {
    await setupVerificationQuest();
    const entry = { author: "human" as const, text: "Layout off on mobile", ts: Date.now() };
    const result = await questStore.patchQuest("q-1", { feedback: [entry] });
    expect(result).not.toBeNull();
    const fb = (result as { feedback?: { author: string; text: string }[] }).feedback;
    expect(fb).toHaveLength(1);
    expect(fb![0].text).toBe("Layout off on mobile");
    expect(fb![0].author).toBe("human");
  });

  it("clears feedback when set to empty array", async () => {
    await setupVerificationQuest();
    const entry = { author: "human" as const, text: "Some feedback", ts: Date.now() };
    await questStore.patchQuest("q-1", { feedback: [entry] });
    const result = await questStore.patchQuest("q-1", { feedback: [] });
    // Empty array clears the field entirely
    expect((result as { feedback?: unknown[] }).feedback).toBeUndefined();
  });

  it("carries forward feedback on needs_verification → in_progress transition", async () => {
    await setupVerificationQuest();
    const entry = { author: "human" as const, text: "Fix this", ts: Date.now() };
    await questStore.patchQuest("q-1", { feedback: [entry] });

    // Transition back to in_progress (rework)
    const result = await questStore.transitionQuest("q-1", { status: "in_progress", sessionId: "sess-1" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("in_progress");
    const fb = (result as { feedback?: { text: string }[] }).feedback;
    expect(fb).toHaveLength(1);
    expect(fb![0].text).toBe("Fix this");
  });

  it("carries forward feedback on in_progress → needs_verification transition", async () => {
    await setupVerificationQuest();
    const entry = { author: "human" as const, text: "Fix this", ts: Date.now() };
    await questStore.patchQuest("q-1", { feedback: [entry] });

    // Rework cycle: back to in_progress
    await questStore.transitionQuest("q-1", { status: "in_progress", sessionId: "sess-1" });
    // Agent submits again with new verification items — feedback thread persists
    const result = await questStore.transitionQuest("q-1", {
      status: "needs_verification",
      verificationItems: [{ text: "New check", checked: false }],
    });
    expect(result).not.toBeNull();
    const fb = (result as { feedback?: { text: string }[] }).feedback;
    expect(fb).toHaveLength(1);
    expect(fb![0].text).toBe("Fix this");
  });

  it("carries forward feedback to done", async () => {
    await setupVerificationQuest();
    const entries = [
      { author: "human" as const, text: "Fix this", ts: Date.now() },
      { author: "agent" as const, text: "Fixed with flex-wrap", ts: Date.now() },
    ];
    await questStore.patchQuest("q-1", { feedback: entries });

    const result = await questStore.transitionQuest("q-1", { status: "done", notes: "shipped" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("done");
    const fb = (result as { feedback?: { author: string; text: string }[] }).feedback;
    expect(fb).toHaveLength(2);
    expect(fb![0].author).toBe("human");
    expect(fb![1].author).toBe("agent");
  });

  it("accumulates multiple feedback entries", async () => {
    await setupVerificationQuest();
    // First entry
    await questStore.patchQuest("q-1", {
      feedback: [{ author: "human" as const, text: "Issue 1", ts: Date.now() }],
    });
    // Append second entry (caller manages the array)
    const current = await questStore.getQuest("q-1");
    const existing = (current as { feedback?: { author: "human" | "agent"; text: string; ts: number }[] }).feedback ?? [];
    await questStore.patchQuest("q-1", {
      feedback: [...existing, { author: "agent" as const, text: "Fixed issue 1", ts: Date.now() }],
    });

    const result = await questStore.getQuest("q-1");
    const fb = (result as { feedback?: { text: string }[] }).feedback;
    expect(fb).toHaveLength(2);
    expect(fb![0].text).toBe("Issue 1");
    expect(fb![1].text).toBe("Fixed issue 1");
  });

  it("carries forward feedback through cancelQuest", async () => {
    await setupVerificationQuest();
    await questStore.patchQuest("q-1", {
      feedback: [{ author: "human" as const, text: "Nevermind", ts: Date.now() }],
    });
    const result = await questStore.cancelQuest("q-1", "Not needed");
    expect(result).not.toBeNull();
    const fb = (result as { feedback?: { text: string }[] }).feedback;
    expect(fb).toHaveLength(1);
    expect(fb![0].text).toBe("Nevermind");
  });
});

// ===========================================================================
// Counter reconciliation (prevents ID reuse)
// ===========================================================================
describe("counter reconciliation", () => {
  it("skips IDs that already have quest files on disk", async () => {
    // Simulate pre-existing quest files (e.g. from a previous session)
    // with a counter that has fallen behind
    const dir = questDir();
    mkdirSync(dir, { recursive: true });

    // Write fake quest files for q-1 through q-5
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(dir, `q-${i}-v1.json`),
        JSON.stringify({ id: `q-${i}-v1`, questId: `q-${i}`, version: 1, title: `Old quest ${i}`, status: "idea", createdAt: Date.now() }),
      );
    }

    // Set counter behind (next=2, but q-1 through q-5 exist)
    writeFileSync(join(dir, "_quest_counter.json"), JSON.stringify({ next: 2 }));

    // Creating a new quest should skip existing IDs and get q-6
    const q = await questStore.createQuest({ title: "New quest" });
    expect(q.questId).toBe("q-6");

    // Counter should now be at 7
    const counter = JSON.parse(readFileSync(join(dir, "_quest_counter.json"), "utf-8"));
    expect(counter.next).toBe(7);
  });

  it("handles missing counter file by scanning existing files", async () => {
    // Pre-existing quests but no counter file at all
    const dir = questDir();
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "q-10-v1.json"),
      JSON.stringify({ id: "q-10-v1", questId: "q-10", version: 1, title: "Quest 10", status: "idea", createdAt: Date.now() }),
    );

    // No _quest_counter.json exists — readCounter returns 1, but scan
    // should bump it past q-10
    const q = await questStore.createQuest({ title: "After gap" });
    expect(q.questId).toBe("q-11");
  });
});
