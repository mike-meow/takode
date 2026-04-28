import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  tempDir = mkdtempSync(join(tmpdir(), "quest-tldr-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  questStore = await import("./quest-store.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function setupVerificationQuest(): Promise<void> {
  await questStore.createQuest({ title: "Feedback test" });
  await questStore.transitionQuest("q-1", { status: "refined", description: "Ready" });
  await questStore.claimQuest("q-1", "sess-1");
  await questStore.completeQuest("q-1", [
    { text: "Check A", checked: false },
    { text: "Check B", checked: false },
  ]);
}

describe("quest-store TLDR metadata", () => {
  it("stores, patches, and clears quest TLDR metadata separately from the description", async () => {
    const created = await questStore.createQuest({
      title: "TLDR patch",
      description: "Full details here",
      tldr: "Initial summary",
      status: "refined",
    });
    expect(created).toMatchObject({
      status: "refined",
      description: "Full details here",
      tldr: "Initial summary",
    });

    const updated = await questStore.patchQuest("q-1", { tldr: "Updated summary" });
    expect(updated?.tldr).toBe("Updated summary");
    expect("description" in updated! ? updated.description : undefined).toBe("Full details here");

    const cleared = await questStore.patchQuest("q-1", { tldr: "" });
    expect(cleared?.tldr).toBeUndefined();
  });

  it("preserves quest TLDR metadata across status transitions unless explicitly updated", async () => {
    await questStore.createQuest({
      title: "TLDR lifecycle",
      description: "Long implementation details",
      tldr: "Short lifecycle summary",
      status: "refined",
    });

    const claimed = await questStore.claimQuest("q-1", "session-a");
    expect(claimed?.tldr).toBe("Short lifecycle summary");

    const submitted = await questStore.transitionQuest("q-1", {
      status: "done",
      verificationItems: [{ text: "Review TLDR handoff", checked: false }],
      tldr: "Updated handoff summary",
    });
    expect(submitted?.tldr).toBe("Updated handoff summary");
    expect("description" in submitted! ? submitted.description : undefined).toBe("Long implementation details");
  });

  it("applies TLDR-only same-status transitions instead of ignoring them", async () => {
    await questStore.createQuest({
      title: "Same status TLDR",
      description: "Full details",
      tldr: "Original summary",
      status: "refined",
    });

    const updated = await questStore.transitionQuest("q-1", {
      status: "refined",
      tldr: "Updated summary",
    });
    expect(updated).toMatchObject({
      questId: "q-1",
      status: "refined",
      version: 2,
      description: "Full details",
      tldr: "Updated summary",
    });

    const cleared = await questStore.transitionQuest("q-1", {
      status: "refined",
      tldr: "",
    });
    expect(cleared).toMatchObject({
      questId: "q-1",
      status: "refined",
      version: 3,
      description: "Full details",
    });
    expect(cleared?.tldr).toBeUndefined();
  });

  it("stores feedback TLDR metadata through feedback patching", async () => {
    await setupVerificationQuest();
    const entry = {
      author: "human" as const,
      text: "Layout off on mobile",
      tldr: "Mobile layout issue",
      ts: Date.now(),
    };
    const result = await questStore.patchQuest("q-1", { feedback: [entry] });
    expect(result).not.toBeNull();
    const fb = (result as { feedback?: { author: string; text: string; tldr?: string }[] }).feedback;
    expect(fb).toHaveLength(1);
    expect(fb![0]).toMatchObject({
      author: "human",
      text: "Layout off on mobile",
      tldr: "Mobile layout issue",
    });
  });
});
