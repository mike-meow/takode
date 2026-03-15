import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _flushForTest, _resetForTest, getAllOrder, setAllOrder } from "./group-order.js";

let tempDir: string;
let filePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "group-order-test-"));
  filePath = join(tempDir, "group-order.json");
  _resetForTest(filePath);
});

afterEach(async () => {
  await _flushForTest();
  _resetForTest();
  await rm(tempDir, { recursive: true, force: true });
});

describe("group-order store", () => {
  it("returns an empty list when no persisted file exists", async () => {
    expect(await getAllOrder()).toEqual([]);
  });

  it("persists and reloads group order", async () => {
    await setAllOrder(["/repo-b", "/repo-a"]);
    await _flushForTest();

    // Reset and re-read from disk to verify persistence behavior.
    _resetForTest(filePath);
    expect(await getAllOrder()).toEqual(["/repo-b", "/repo-a"]);
  });

  it("sanitizes invalid payloads and deduplicates keys", async () => {
    await setAllOrder(["/repo-a", "/repo-a", "", " /repo-b ", 1 as unknown as string]);
    expect(await getAllOrder()).toEqual(["/repo-a", "/repo-b"]);
  });
});
