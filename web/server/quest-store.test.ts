import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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

function latestSnapshotPath(): string {
  return join(questDir(), "_latest_snapshot.json");
}

function liveStoreDir(): string {
  return join(tempDir, ".companion", "questmaster-live");
}

function liveStorePath(): string {
  return join(liveStoreDir(), "store.json");
}

function legacyCoLocatedLiveStorePath(): string {
  return join(questDir(), "store.json");
}

function writeLiveStoreFixture(store: unknown): void {
  mkdirSync(liveStoreDir(), { recursive: true });
  writeFileSync(liveStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

function writeLegacyCoLocatedLiveStoreFixture(store: unknown): void {
  mkdirSync(questDir(), { recursive: true });
  writeFileSync(legacyCoLocatedLiveStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

function questFileReads(reads: string[]): string[] {
  return reads
    .filter((path) => path.endsWith(".json"))
    .map((path) => basename(path))
    .filter((name) => name.startsWith("q-"));
}

async function importQuestStoreWithReadSpy(reads: string[]): Promise<typeof import("./quest-store.js")> {
  vi.resetModules();
  mockHomedir.set(tempDir);
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
      ...actual,
      readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
        reads.push(String(args[0]));
        return actual.readFile(...args);
      }),
    };
  });
  const module = await import("./quest-store.js");
  vi.doUnmock("node:fs/promises");
  return module;
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
    await expect(questStore.createQuest({ title: "" })).rejects.toThrow("Quest title is required");
    await expect(questStore.createQuest({ title: "   " })).rejects.toThrow("Quest title is required");
  });

  it("throws when creating with in_progress status directly", async () => {
    await expect(questStore.createQuest({ title: "Bad", status: "in_progress" })).rejects.toThrow(
      'Cannot create a quest directly in "in_progress" status',
    );
  });

  it("throws when refined status is missing description", async () => {
    await expect(questStore.createQuest({ title: "No desc", status: "refined" })).rejects.toThrow(
      "Description is required for refined status",
    );
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

  it("serializes parallel creates and persists distinct quests", async () => {
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        questStore.createQuest({
          title: `Parallel quest ${index + 1}`,
        }),
      ),
    );

    const numericIds = created.map((quest) => Number(quest.questId.slice(2))).sort((a, b) => a - b);
    expect(new Set(created.map((quest) => quest.questId)).size).toBe(6);
    expect(numericIds).toEqual([1, 2, 3, 4, 5, 6]);

    const files = readdirSync(questDir())
      .filter((name) => /^q-\d+-v1\.json$/.test(name))
      .sort((a, b) => Number(a.match(/^q-(\d+)-/)?.[1]) - Number(b.match(/^q-(\d+)-/)?.[1]));
    expect(files).toEqual(["q-1-v1.json", "q-2-v1.json", "q-3-v1.json", "q-4-v1.json", "q-5-v1.json", "q-6-v1.json"]);

    const counter = JSON.parse(readFileSync(join(questDir(), "_quest_counter.json"), "utf-8"));
    expect(counter.next).toBe(7);
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

  it("reads the derived latest snapshot instead of individual quest version files on repeated list calls", async () => {
    const reads: string[] = [];
    const instrumentedStore = await importQuestStoreWithReadSpy(reads);

    await instrumentedStore.createQuest({ title: "Primary" });
    await instrumentedStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });
    await instrumentedStore.createQuest({ title: "Unrelated" });

    reads.length = 0;
    const quests = await instrumentedStore.listQuests();
    expect(quests.map((quest) => quest.id)).toEqual(["q-2-v1", "q-1-v2"]);
    expect(questFileReads(reads)).toEqual([]);
    expect(reads.map((path) => basename(path))).toContain(basename(latestSnapshotPath()));
  });

  it("rebuilds the latest snapshot from only the latest quest version files when the snapshot is missing", async () => {
    const initialReads: string[] = [];
    const instrumentedStore = await importQuestStoreWithReadSpy(initialReads);

    await instrumentedStore.createQuest({ title: "Primary" });
    await instrumentedStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });
    await instrumentedStore.createQuest({ title: "Secondary" });
    await writeFile(latestSnapshotPath(), "", "utf-8");

    const rebuildReads: string[] = [];
    const rebuiltStore = await importQuestStoreWithReadSpy(rebuildReads);
    const quests = await rebuiltStore.listQuests();
    expect(quests.map((quest) => quest.id)).toEqual(["q-2-v1", "q-1-v2"]);
    expect(questFileReads(rebuildReads).sort()).toEqual(["q-1-v2.json", "q-2-v1.json"]);
  });

  it("falls back to the latest readable version during snapshot rebuild when the newest file is unreadable", async () => {
    const reads: string[] = [];
    const instrumentedStore = await importQuestStoreWithReadSpy(reads);

    await instrumentedStore.createQuest({ title: "Stable" });
    await writeFile(join(questDir(), "q-1-v2.json"), "{not json", "utf-8");
    await writeFile(latestSnapshotPath(), "", "utf-8");

    reads.length = 0;
    const quests = await instrumentedStore.listQuests();
    expect(quests).toHaveLength(1);
    expect(quests[0]?.id).toBe("q-1-v1");
    expect(quests[0]?.title).toBe("Stable");
    expect(questFileReads(reads).sort()).toEqual(["q-1-v1.json", "q-1-v2.json"]);
  });
});

describe("live quest store", () => {
  it("reads and writes mutable current quest records when store.json is present", async () => {
    writeLiveStoreFixture({
      format: "mutable_current_record",
      version: 1,
      nextQuestNumber: 2,
      updatedAt: 0,
      quests: [
        {
          id: "q-1",
          questId: "q-1",
          version: 2,
          title: "Existing",
          status: "refined",
          description: "Current live record",
          createdAt: 100,
          statusChangedAt: 200,
        },
      ],
    });

    const initial = await questStore.listQuests();
    expect(initial).toHaveLength(1);
    expect(initial[0]?.id).toBe("q-1");

    const transitioned = await questStore.transitionQuest("q-1", {
      status: "in_progress",
      sessionId: "session-1",
    });
    expect(transitioned).toMatchObject({
      id: "q-1",
      questId: "q-1",
      version: 3,
      status: "in_progress",
      createdAt: 100,
      statusChangedAt: expect.any(Number),
    });

    const created = await questStore.createQuest({ title: "New live quest" });
    expect(created).toMatchObject({
      id: "q-2",
      questId: "q-2",
      version: 1,
      status: "idea",
    });

    const persisted = JSON.parse(readFileSync(liveStorePath(), "utf-8"));
    expect(persisted.quests).toHaveLength(2);
    expect(persisted.quests.map((quest: { id: string }) => quest.id).sort()).toEqual(["q-1", "q-2"]);
  });

  it("bootstrap prefers the separate live store when it already exists", async () => {
    writeLiveStoreFixture({
      format: "mutable_current_record",
      version: 1,
      nextQuestNumber: 2,
      updatedAt: 0,
      legacyBackupDir: questDir(),
      quests: [
        {
          id: "q-1",
          questId: "q-1",
          version: 2,
          title: "Preferred live quest",
          status: "refined",
          description: "Use me",
          createdAt: 100,
          statusChangedAt: 200,
        },
      ],
    });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 50,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const bootstrap = await questStore.bootstrapQuestStore();

    expect(bootstrap).toMatchObject({
      mode: "preferred_live",
      liveStoreFile: liveStorePath(),
      legacyBackupDir: questDir(),
    });
    expect((await questStore.listQuests()).map((quest) => quest.title)).toEqual(["Preferred live quest"]);
  });

  it("bootstrap migrates the old co-located live store into the preferred live location", async () => {
    writeLegacyCoLocatedLiveStoreFixture({
      format: "mutable_current_record",
      version: 1,
      nextQuestNumber: 2,
      updatedAt: 0,
      legacyBackupDir: join(tempDir, ".companion", "questmaster-legacy-cutover-old"),
      quests: [
        {
          id: "q-1",
          questId: "q-1",
          version: 3,
          title: "Co-located live quest",
          status: "refined",
          description: "Move me forward",
          createdAt: 100,
          statusChangedAt: 200,
        },
      ],
    });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 50,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const bootstrap = await questStore.bootstrapQuestStore();
    const migrated = JSON.parse(readFileSync(liveStorePath(), "utf-8"));
    const original = JSON.parse(readFileSync(legacyCoLocatedLiveStorePath(), "utf-8"));

    expect(bootstrap).toMatchObject({
      mode: "migrated_existing_live",
      liveStoreFile: liveStorePath(),
      legacyBackupDir: questDir(),
    });
    expect(migrated.legacyBackupDir).toBe(questDir());
    expect(migrated.quests.map((quest: { title: string }) => quest.title)).toEqual(["Co-located live quest"]);
    expect(original.legacyBackupDir).toBe(join(tempDir, ".companion", "questmaster-legacy-cutover-old"));
  });

  it("bootstrap best-effort migrates readable legacy quests into the preferred live location", async () => {
    mkdirSync(questDir(), { recursive: true });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Readable legacy quest",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(questDir(), "q-2-v1.json"), "{broken json", "utf-8");
    writeFileSync(
      latestSnapshotPath(),
      JSON.stringify(
        {
          version: 3,
          quests: [{ questId: "q-1" }],
          latestVersionByQuestId: { "q-1": 1 },
          latestFileStateByQuestId: {},
          updatedAt: 0,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const bootstrap = await questStore.bootstrapQuestStore();
    const migrated = JSON.parse(readFileSync(liveStorePath(), "utf-8"));

    expect(bootstrap).toMatchObject({
      mode: "migrated_legacy",
      liveStoreFile: liveStorePath(),
      legacyBackupDir: questDir(),
      report: {
        legacyQuestCount: 2,
        migratedQuestCount: 1,
        blockedQuests: [expect.objectContaining({ questId: "q-2" })],
      },
    });
    expect(migrated.legacyBackupDir).toBe(questDir());
    expect(migrated.quests.map((quest: { questId: string }) => quest.questId)).toEqual(["q-1"]);
    expect(readFileSync(join(questDir(), "q-1-v1.json"), "utf-8")).toContain("Readable legacy quest");
    expect(readFileSync(join(questDir(), "q-2-v1.json"), "utf-8")).toBe("{broken json");
  });

  it("bootstrap fails loudly when the preferred live store is unreadable", async () => {
    mkdirSync(liveStoreDir(), { recursive: true });
    writeFileSync(liveStorePath(), "{broken json", "utf-8");
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );

    await expect(questStore.bootstrapQuestStore()).rejects.toThrow();
  });

  it("prepares live-store migration from legacy version files and reports unreadable quests explicitly", async () => {
    mkdirSync(questDir(), { recursive: true });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(questDir(), "q-1-v2.json"),
      JSON.stringify(
        {
          id: "q-1-v2",
          questId: "q-1",
          version: 2,
          prevId: "q-1-v1",
          title: "Legacy quest",
          status: "refined",
          description: "Ready to build",
          createdAt: 250,
          updatedAt: 300,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(questDir(), "q-2-v1.json"), "{broken json", "utf-8");
    writeFileSync(
      latestSnapshotPath(),
      JSON.stringify(
        {
          version: 3,
          quests: [{ questId: "q-1" }],
          latestVersionByQuestId: { "q-1": 2 },
          latestFileStateByQuestId: {},
          updatedAt: 0,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const prepared = await questStore.prepareLiveQuestStoreMigration();

    expect(prepared.canActivate).toBe(false);
    expect(prepared.report).toMatchObject({
      legacyQuestCount: 2,
      migratedQuestCount: 1,
      snapshotQuestCount: 1,
      snapshotStatus: "readable",
      snapshotMismatchQuestIds: ["q-2"],
      blockedQuests: [
        expect.objectContaining({
          questId: "q-2",
          files: ["q-2-v1.json"],
        }),
      ],
      unreadableFiles: [
        expect.objectContaining({
          file: "q-2-v1.json",
          questId: "q-2",
        }),
      ],
    });
    expect(prepared.store.nextQuestNumber).toBe(3);
    expect(prepared.store.quests).toEqual([
      expect.objectContaining({
        id: "q-1",
        questId: "q-1",
        version: 2,
        createdAt: 100,
        updatedAt: 300,
        statusChangedAt: 250,
      }),
    ]);
    expect(prepared.backupDir).toContain("legacy-backup-");
  });

  it("reports a snapshot mismatch when an existing quest ID has a stale snapshot version", async () => {
    mkdirSync(questDir(), { recursive: true });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(questDir(), "q-1-v2.json"),
      JSON.stringify(
        {
          id: "q-1-v2",
          questId: "q-1",
          version: 2,
          prevId: "q-1-v1",
          title: "Legacy quest",
          status: "refined",
          description: "Ready to build",
          createdAt: 250,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      latestSnapshotPath(),
      JSON.stringify(
        {
          version: 3,
          quests: [
            {
              id: "q-1-v1",
              questId: "q-1",
              version: 1,
              title: "Legacy quest",
              status: "idea",
              createdAt: 100,
            },
          ],
          latestVersionByQuestId: { "q-1": 1 },
          latestFileStateByQuestId: {},
          updatedAt: 0,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const prepared = await questStore.prepareLiveQuestStoreMigration();

    expect(prepared.canActivate).toBe(true);
    expect(prepared.report.snapshotMismatchQuestIds).toEqual(["q-1"]);
    expect(prepared.report.blockedQuests).toEqual([]);
  });

  it("reads history and versions from the preserved legacy backup when the live store is active", async () => {
    const backupDir = join(questDir(), "legacy-backup-manual");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      join(backupDir, "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy v1",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(backupDir, "q-1-v2.json"),
      JSON.stringify(
        {
          id: "q-1-v2",
          questId: "q-1",
          version: 2,
          prevId: "q-1-v1",
          title: "Legacy v2",
          status: "refined",
          description: "Refined",
          createdAt: 200,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeLiveStoreFixture({
      format: "mutable_current_record",
      version: 1,
      nextQuestNumber: 2,
      updatedAt: 0,
      legacyBackupDir: backupDir,
      quests: [
        {
          id: "q-1",
          questId: "q-1",
          version: 3,
          title: "Live current",
          status: "refined",
          description: "Current live record",
          createdAt: 100,
          statusChangedAt: 250,
        },
      ],
    });

    const history = await questStore.getQuestHistoryView("q-1");
    expect(history).toMatchObject({
      mode: "legacy_backup",
      backupDir,
    });
    expect(history.entries.map((entry) => entry.id)).toEqual(["q-1-v1", "q-1-v2"]);

    const version = await questStore.getQuestVersion("q-1-v2");
    expect(version).toMatchObject({ id: "q-1-v2", title: "Legacy v2" });
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

  it("falls back to the latest readable version when a newer matching file is corrupt", async () => {
    await questStore.createQuest({ title: "Stable" });
    await writeFile(join(questDir(), "q-1-v2.json"), "{not json", "utf-8");

    const q = await questStore.getQuest("q-1");
    expect(q?.id).toBe("q-1-v1");
    expect(q?.title).toBe("Stable");
  });

  it("reads only the latest matching version file for single-quest lookups", async () => {
    const reads: string[] = [];
    const instrumentedStore = await importQuestStoreWithReadSpy(reads);

    await instrumentedStore.createQuest({ title: "Primary" });
    await instrumentedStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });
    await instrumentedStore.createQuest({ title: "Unrelated" });

    reads.length = 0;
    const q = await instrumentedStore.getQuest("q-1");
    expect(q?.id).toBe("q-1-v2");

    const questReads = reads
      .filter((path) => path.endsWith(".json"))
      .map((path) => basename(path))
      .filter((name) => name.startsWith("q-"));
    expect(questReads).toEqual(["q-1-v2.json"]);
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

  it("normalizes legacy needs_verification records to done review metadata", async () => {
    const legacy = {
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Legacy review",
      createdAt: 100,
      statusChangedAt: 300,
      status: "needs_verification",
      description: "Old review state",
      sessionId: "sess-review",
      claimedAt: 200,
      verificationItems: [{ text: "verify legacy", checked: false }],
      verificationInboxUnread: true,
    };
    await writeFile(join(questDir(), "q-1-v3.json"), JSON.stringify(legacy), "utf-8");

    const q = await questStore.getQuest("q-1");
    expect(q?.status).toBe("done");
    if (q?.status === "done") {
      expect(q.completedAt).toBe(300);
      expect(q.verificationItems).toEqual([{ text: "verify legacy", checked: false }]);
      expect(q.verificationInboxUnread).toBe(true);
      expect(q.sessionId).toBeUndefined();
      expect(q.previousOwnerSessionIds).toEqual(["sess-review"]);
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

  it("reads only matching version files when loading one quest history", async () => {
    const reads: string[] = [];
    const instrumentedStore = await importQuestStoreWithReadSpy(reads);

    await instrumentedStore.createQuest({ title: "Primary" });
    await instrumentedStore.transitionQuest("q-1", {
      status: "refined",
      description: "Step 1",
    });
    await instrumentedStore.claimQuest("q-1", "session-abc");
    await instrumentedStore.createQuest({ title: "Unrelated" });

    reads.length = 0;
    const history = await instrumentedStore.getQuestHistory("q-1");
    expect(history.map((quest) => quest.id)).toEqual(["q-1-v1", "q-1-v2", "q-1-v3"]);

    const questReads = reads
      .filter((path) => path.endsWith(".json"))
      .map((path) => basename(path))
      .filter((name) => name.startsWith("q-"))
      .sort();
    expect(questReads).toEqual(["q-1-v1.json", "q-1-v2.json", "q-1-v3.json"]);
  });
});

describe("getActiveQuestForSession", () => {
  it("uses the derived latest snapshot instead of scanning individual quest files", async () => {
    const reads: string[] = [];
    const instrumentedStore = await importQuestStoreWithReadSpy(reads);

    await instrumentedStore.createQuest({ title: "Primary" });
    await instrumentedStore.transitionQuest("q-1", {
      status: "refined",
      description: "Details",
    });
    await instrumentedStore.claimQuest("q-1", "session-abc");
    await instrumentedStore.createQuest({ title: "Unrelated" });

    reads.length = 0;
    const active = await instrumentedStore.getActiveQuestForSession("session-abc");
    expect(active?.questId).toBe("q-1");
    expect(questFileReads(reads)).toEqual([]);
    expect(reads.map((path) => basename(path))).toContain(basename(latestSnapshotPath()));
  });
});

// ===========================================================================
// Forward transitions
// ===========================================================================
describe("forward transitions", () => {
  it("idea → refined → in_progress → done review handoff → done closure", async () => {
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

    // → done review handoff
    const reviewHandoff = await questStore.transitionQuest("q-1", {
      status: "done",
      verificationItems: [
        { text: "Check mobile", checked: false },
        { text: "Run e2e", checked: false },
      ],
      verificationInboxUnread: true,
    });
    expect(reviewHandoff?.status).toBe("done");
    expect(reviewHandoff?.version).toBe(4);
    if (reviewHandoff?.status === "done") {
      expect(reviewHandoff.verificationItems).toHaveLength(2);
      expect(reviewHandoff.sessionId).toBeUndefined();
      expect(reviewHandoff.previousOwnerSessionIds).toContain("sess-1");
      expect(reviewHandoff.verificationInboxUnread).toBe(true);
    }

    // → done closure after review metadata is cleared
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
  it("done → in_progress creates a new version preserving history", async () => {
    // Build up to done
    await questStore.createQuest({ title: "Rework test" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Original plan",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [{ text: "Check UI", checked: false }]);

    // Now go backwards to in_progress (rework)
    const rework = await questStore.transitionQuest("q-1", {
      status: "in_progress",
      sessionId: "sess-2", // different agent picks it up
    });

    expect(rework?.status).toBe("in_progress");
    expect(rework?.version).toBe(5); // v1=idea, v2=refined, v3=in_progress, v4=done, v5=rework
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
      "done",
      "in_progress", // rework
    ]);
  });

  it("preserves previous verification commit SHAs when a quest re-enters in_progress", async () => {
    // Commit metadata is append-style review history and should remain visible during rework.
    await questStore.createQuest({ title: "Rework keeps SHAs" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Original plan",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [{ text: "Check UI", checked: false }], {
      commitShas: ["abc1234", "deadbeef"],
    });

    const rework = await questStore.transitionQuest("q-1", {
      status: "in_progress",
      sessionId: "sess-1",
    });

    expect(rework?.status).toBe("in_progress");
    expect(rework?.commitShas).toEqual(["abc1234", "deadbeef"]);
  });

  it("preserves previous verification commit SHAs when a quest returns to refined", async () => {
    // Resetting a verification quest to refined should not detach prior synced diffs from inspection.
    await questStore.createQuest({ title: "Refined rework keeps SHAs" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Original plan",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [{ text: "Check UI", checked: false }], {
      commitShas: ["abc1234", "deadbeef"],
    });

    const refined = await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Needs another pass",
    });

    expect(refined?.status).toBe("refined");
    expect(refined?.commitShas).toEqual(["abc1234", "deadbeef"]);
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

    await expect(questStore.claimQuest("q-1", "sess-2")).rejects.toThrow("already claimed by session sess-1");
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

  it("checks existing active ownership via the latest snapshot without scanning unrelated quest files", async () => {
    const reads: string[] = [];
    const instrumentedStore = await importQuestStoreWithReadSpy(reads);

    await instrumentedStore.createQuest({ title: "Already active" });
    await instrumentedStore.transitionQuest("q-1", {
      status: "refined",
      description: "Primary details",
    });
    await instrumentedStore.claimQuest("q-1", "sess-1");
    await instrumentedStore.createQuest({ title: "Second quest" });
    await instrumentedStore.transitionQuest("q-2", {
      status: "refined",
      description: "Secondary details",
    });

    reads.length = 0;
    await expect(instrumentedStore.claimQuest("q-2", "sess-1")).rejects.toThrow(
      'Session already has an active quest: q-1 "Already active".',
    );
    expect(questFileReads(reads)).toEqual(["q-2-v2.json"]);
    expect(reads.map((path) => basename(path))).toContain(basename(latestSnapshotPath()));
  });

  it("reconciles a parseable stale snapshot before enforcing active quest ownership", async () => {
    await questStore.createQuest({ title: "Already active" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Primary details",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.createQuest({ title: "Second quest" });
    await questStore.transitionQuest("q-2", {
      status: "refined",
      description: "Secondary details",
    });

    await writeFile(
      latestSnapshotPath(),
      JSON.stringify(
        {
          version: 3,
          quests: [],
          activeQuestBySessionId: {},
          latestFileStateByQuestId: {},
          latestVersionByQuestId: {},
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      "utf-8",
    );

    const active = await questStore.getActiveQuestForSession("sess-1");
    expect(active?.questId).toBe("q-1");

    const listed = await questStore.listQuests();
    expect(listed.map((quest) => quest.id).sort()).toEqual(["q-1-v3", "q-2-v2"]);

    await expect(questStore.claimQuest("q-2", "sess-1")).rejects.toThrow(
      'Session already has an active quest: q-1 "Already active".',
    );
  });

  it("reconciles a parseable stale snapshot after a same-version patchQuest rewrite", async () => {
    await questStore.createQuest({ title: "Before title" });
    const staleSnapshot = await readFile(latestSnapshotPath(), "utf-8");

    await new Promise((resolve) => setTimeout(resolve, 10));
    await questStore.patchQuest("q-1", { title: "After rewritten title" });

    await writeFile(latestSnapshotPath(), staleSnapshot, "utf-8");

    const listed = await questStore.listQuests();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("After rewritten title");

    const quest = await questStore.getQuest("q-1");
    expect(quest?.title).toBe("After rewritten title");
  });
});

describe("completeQuest", () => {
  it("transitions to done with items", async () => {
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

    expect(completed?.status).toBe("done");
    if (completed?.status === "done") {
      expect(completed.verificationItems).toHaveLength(2);
      expect(completed.verificationInboxUnread).toBe(true);
    }
  });

  it("stores ordered commit SHAs on the verification handoff", async () => {
    await questStore.createQuest({ title: "Attach sync commits" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");

    const completed = await questStore.completeQuest("q-1", [{ text: "Human verifies UI", checked: false }], {
      commitShas: ["BEEF1234", "beef1234", "deadbeefcafebabe"],
    });

    expect(completed?.status).toBe("done");
    expect(completed?.commitShas).toEqual(["beef1234", "deadbeefcafebabe"]);
  });

  it("uses an explicit worker session when a leader completes a refined quest", async () => {
    // Leader sessions can submit a worker-owned quest after removing it from the board.
    // The handoff must still persist the worker session so the quest is reviewable.
    await questStore.createQuest({ title: "Leader handoff" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });

    const completed = await questStore.completeQuest("q-1", [{ text: "Verify handoff", checked: false }], {
      sessionId: "worker-1",
    });

    expect(completed?.status).toBe("done");
    if (completed?.status === "done") {
      expect(completed.sessionId).toBeUndefined();
      expect(completed.previousOwnerSessionIds).toContain("worker-1");
      expect(completed.verificationItems).toEqual([{ text: "Verify handoff", checked: false }]);
      expect(completed.verificationInboxUnread).toBe(true);
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
    await questStore.completeQuest("q-1", [{ text: "Verify", checked: true }]);

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

  it("cancels a done quest, carrying forward verificationItems", async () => {
    // Build up to done
    await questStore.createQuest({ title: "Cancel needs verification" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Verify this",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [{ text: "Check UI", checked: false }]);

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
    const files = readdirSync(questDir()).filter((f) => f.startsWith("q-1") && f.endsWith(".json"));
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
    if (toggled?.status === "done") {
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

    await expect(questStore.checkVerificationItem("q-1", 5, true)).rejects.toThrow("out of range");
  });

  it("throws when quest has no verification items", async () => {
    await questStore.createQuest({ title: "No items" });

    await expect(questStore.checkVerificationItem("q-1", 0, true)).rejects.toThrow("does not have verification items");
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
    const filesBefore = readdirSync(questDir()).filter((f) => f.startsWith("q-1"));
    expect(filesBefore).toHaveLength(2);

    const result = await questStore.deleteQuest("q-1");
    expect(result).toBe(true);

    // All version files gone
    const filesAfter = readdirSync(questDir()).filter((f) => f.startsWith("q-1"));
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
    await expect(questStore.transitionQuest("q-1", { status: "refined" })).rejects.toThrow("Description is required");
  });

  it("requires sessionId for in_progress status", async () => {
    await questStore.createQuest({ title: "No session" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await expect(questStore.transitionQuest("q-1", { status: "in_progress" })).rejects.toThrow("sessionId is required");
  });

  it("allows done with empty verificationItems (auto-pass)", async () => {
    // When no --items are provided, the quest transitions to done
    // with an empty items array. quest done will auto-pass since there's nothing to verify.
    await questStore.createQuest({ title: "No items" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");
    const quest = await questStore.transitionQuest("q-1", { status: "done" });
    expect(quest).not.toBeNull();
    expect(quest?.status).toBe("done");
    if (quest?.status === "done") {
      expect(quest.verificationItems).toEqual([]);
    }
  });

  it("rejects setting commit SHAs before the verification handoff", async () => {
    await questStore.createQuest({ title: "No premature SHAs" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });

    await expect(
      questStore.transitionQuest("q-1", {
        status: "in_progress",
        sessionId: "sess-1",
        commitShas: ["abc1234"],
      }),
    ).rejects.toThrow("commitShas can only be set when completing a quest");
  });

  it("preserves and appends commit SHAs on a re-submitted verification handoff", async () => {
    // Re-submission should keep earlier handoff commits and add new ones without duplicating overlap.
    await questStore.createQuest({ title: "Append handoff SHAs" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [{ text: "Verify v1", checked: false }], {
      commitShas: ["abc1234", "deadbeef"],
    });
    await questStore.transitionQuest("q-1", {
      status: "in_progress",
      sessionId: "sess-1",
    });

    const resubmitted = await questStore.transitionQuest("q-1", {
      status: "done",
      sessionId: "sess-1",
      verificationItems: [{ text: "Verify v2", checked: false }],
      commitShas: ["DEADBEEF", "cafebabe"],
    });

    expect(resubmitted?.status).toBe("done");
    expect(resubmitted?.commitShas).toEqual(["abc1234", "deadbeef", "cafebabe"]);
  });

  it("allows done transition from in_progress when verificationItems are provided", async () => {
    await questStore.createQuest({ title: "Manual done flow" });
    await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Ready",
    });
    await questStore.claimQuest("q-1", "sess-1");

    const done = await questStore.transitionQuest("q-1", {
      status: "done",
      verificationItems: [{ text: "User verified: works as expected", checked: true }],
    });

    expect(done).not.toBeNull();
    expect(done?.status).toBe("done");
    if (done?.status === "done") {
      expect(done.verificationItems).toEqual([{ text: "User verified: works as expected", checked: true }]);
    }
  });

  it("allows done transition with empty verification items (auto-pass)", async () => {
    // When a quest reaches done with no items, quest done should
    // succeed immediately — there's nothing to verify.
    await questStore.createQuest({ title: "Auto-pass done" });
    await questStore.transitionQuest("q-1", { status: "refined", description: "Ready" });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.transitionQuest("q-1", { status: "done" });
    const done = await questStore.markDone("q-1", { notes: "No items to verify" });
    expect(done).not.toBeNull();
    expect(done?.status).toBe("done");
    if (done?.status === "done") {
      expect(done.verificationItems).toEqual([]);
      expect(done.notes).toBe("No items to verify");
    }
  });

  it("returns null when transitioning non-existent quest", async () => {
    expect(await questStore.transitionQuest("q-999", { status: "refined", description: "x" })).toBeNull();
  });
});

// ===========================================================================
// Feedback thread
// ===========================================================================
describe("feedback", () => {
  /** Helper: create a quest in done state */
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
    const entry = {
      author: "human" as const,
      text: "Layout off on mobile",
      ts: Date.now(),
    };
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

  it("carries forward feedback on done → in_progress transition", async () => {
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

  it("carries forward feedback on done → refined transition", async () => {
    await setupVerificationQuest();
    const entries = [
      { author: "human" as const, text: "Please reopen this for rework", ts: Date.now() },
      { author: "agent" as const, text: "Investigating the regression path", ts: Date.now() + 1 },
    ];
    await questStore.patchQuest("q-1", { feedback: entries });

    const result = await questStore.transitionQuest("q-1", {
      status: "refined",
      description: "Updated scope for another rework cycle",
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("refined");
    expect(result?.feedback).toEqual(entries);
  });

  it("carries forward feedback on in_progress → done transition", async () => {
    await setupVerificationQuest();
    const entry = { author: "human" as const, text: "Fix this", ts: Date.now() };
    await questStore.patchQuest("q-1", { feedback: [entry] });

    // Rework cycle: back to in_progress
    await questStore.transitionQuest("q-1", { status: "in_progress", sessionId: "sess-1" });
    // Agent submits again with new verification items — feedback thread persists
    const result = await questStore.transitionQuest("q-1", {
      status: "done",
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
    const existing =
      (current as { feedback?: { author: "human" | "agent"; text: string; ts: number }[] }).feedback ?? [];
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

  it("moves verification quests back to inbox when agent feedback is appended", async () => {
    // Regression: once a quest is marked read, a new agent update in verification
    // should push it back into the inbox so humans can notice fresh changes.
    await setupVerificationQuest();
    await questStore.markQuestVerificationRead("q-1");

    const current = await questStore.getQuest("q-1");
    const existing =
      (current as { feedback?: { author: "human" | "agent"; text: string; ts: number }[] }).feedback ?? [];
    await questStore.patchQuest("q-1", {
      feedback: [...existing, { author: "agent", text: "Addressed in latest patch", ts: Date.now() }],
    });

    const result = await questStore.getQuest("q-1");
    expect(result?.status).toBe("done");
    if (result?.status === "done") {
      expect(result.verificationInboxUnread).toBe(true);
    }
  });

  it("moves verification quests back to inbox when agent feedback is edited", async () => {
    // Agent edits are a fresh reviewer-facing update too, so they should re-open the inbox.
    await setupVerificationQuest();
    await questStore.patchQuest("q-1", {
      feedback: [{ author: "agent" as const, text: "Original reply", ts: 1000, authorSessionId: "session-1" }],
    });
    await questStore.markQuestVerificationRead("q-1");

    await questStore.patchQuest("q-1", {
      feedback: [{ author: "agent" as const, text: "Updated reply", ts: 1000, authorSessionId: "session-1" }],
    });

    const result = await questStore.getQuest("q-1");
    expect(result?.status).toBe("done");
    if (result?.status === "done") {
      expect(result.verificationInboxUnread).toBe(true);
    }
  });

  it("moves verification quests back to inbox when agent feedback is removed", async () => {
    // Removing an agent reply changes what the reviewer sees, so it should also surface as unread.
    await setupVerificationQuest();
    await questStore.patchQuest("q-1", {
      feedback: [{ author: "agent" as const, text: "Original reply", ts: 1000, authorSessionId: "session-1" }],
    });
    await questStore.markQuestVerificationRead("q-1");

    await questStore.patchQuest("q-1", { feedback: [] });

    const result = await questStore.getQuest("q-1");
    expect(result?.status).toBe("done");
    if (result?.status === "done") {
      expect(result.verificationInboxUnread).toBe(true);
    }
  });

  it("does not move to inbox for human-only feedback updates", async () => {
    // Human review comments should not re-inbox the quest; only agent updates do.
    await setupVerificationQuest();
    await questStore.markQuestVerificationRead("q-1");

    const current = await questStore.getQuest("q-1");
    const existing =
      (current as { feedback?: { author: "human" | "agent"; text: string; ts: number }[] }).feedback ?? [];
    await questStore.patchQuest("q-1", {
      feedback: [...existing, { author: "human", text: "Please tweak spacing", ts: Date.now() }],
    });

    const result = await questStore.getQuest("q-1");
    expect(result?.status).toBe("done");
    if (result?.status === "done") {
      expect(result.verificationInboxUnread).toBeFalsy();
    }
  });
});

describe("verification inbox", () => {
  it("marks a verification quest as read without creating a new version", async () => {
    // Read/unread is a view-state mutation on the latest version, not a lifecycle
    // transition, so this operation must remain in-place.
    await questStore.createQuest({ title: "Read me" });
    await questStore.transitionQuest("q-1", { status: "refined", description: "Ready" });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [{ text: "Verify", checked: false }]);

    const before = await questStore.getQuest("q-1");
    expect(before?.status).toBe("done");
    if (before?.status === "done") {
      expect(before.verificationInboxUnread).toBe(true);
      const readQuest = await questStore.markQuestVerificationRead("q-1");
      expect(readQuest?.status).toBe("done");
      if (readQuest?.status === "done") {
        expect(readQuest.version).toBe(before.version);
        expect(readQuest.verificationInboxUnread).toBe(false);
      }
    }
  });

  it("marks a verification quest as inbox-unread without creating a new version", async () => {
    // Returning a quest to inbox is also a view-state mutation and should
    // stay on the latest version.
    await questStore.createQuest({ title: "Re-inbox me" });
    await questStore.transitionQuest("q-1", { status: "refined", description: "Ready" });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [{ text: "Verify", checked: false }]);
    await questStore.markQuestVerificationRead("q-1");

    const before = await questStore.getQuest("q-1");
    expect(before?.status).toBe("done");
    if (before?.status === "done") {
      expect(before.verificationInboxUnread).toBe(false);
      const inboxQuest = await questStore.markQuestVerificationInboxUnread("q-1");
      expect(inboxQuest?.status).toBe("done");
      if (inboxQuest?.status === "done") {
        expect(inboxQuest.version).toBe(before.version);
        expect(inboxQuest.verificationInboxUnread).toBe(true);
      }
    }
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
        JSON.stringify({
          id: `q-${i}-v1`,
          questId: `q-${i}`,
          version: 1,
          title: `Old quest ${i}`,
          status: "idea",
          createdAt: Date.now(),
        }),
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
      JSON.stringify({
        id: "q-10-v1",
        questId: "q-10",
        version: 1,
        title: "Quest 10",
        status: "idea",
        createdAt: Date.now(),
      }),
    );

    // No _quest_counter.json exists — readCounter returns 1, but scan
    // should bump it past q-10
    const q = await questStore.createQuest({ title: "After gap" });
    expect(q.questId).toBe("q-11");
  });
});
