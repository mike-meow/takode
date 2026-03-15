import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _flushForTest, _resetForTest, getAllOrder, setAllOrder } from "./session-order.js";

let tempDir: string;
let filePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "session-order-test-"));
  filePath = join(tempDir, "session-order.json");
  _resetForTest(filePath);
});

afterEach(async () => {
  await _flushForTest();
  _resetForTest();
  await rm(tempDir, { recursive: true, force: true });
});

describe("session-order store", () => {
  it("returns an empty map when no persisted file exists", async () => {
    const order = await getAllOrder();
    expect(order).toEqual({});
  });

  it("persists and reloads session order snapshots", async () => {
    await setAllOrder({
      "/repo-a": ["s2", "s1"],
      "/repo-b": ["s3"],
    });
    await _flushForTest();

    // Reload module state from disk to verify persistence, not just memory.
    _resetForTest(filePath);
    const order = await getAllOrder();
    expect(order).toEqual({
      "/repo-a": ["s2", "s1"],
      "/repo-b": ["s3"],
    });
  });

  it("sanitizes invalid payloads and deduplicates IDs", async () => {
    await setAllOrder({
      "/repo-a": ["s1", "s1", "", " s2 "],
      "/repo-b": [123 as unknown as string, "  ", "s3"],
      "   ": ["ignored"],
    });

    expect(await getAllOrder()).toEqual({
      "/repo-a": ["s1", "s2"],
      "/repo-b": ["s3"],
    });
  });
});
