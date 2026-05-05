import { describe, expect, it, vi } from "vitest";
import { NAMER_TRIGGER_SOURCES } from "./session-namer-arbitration.js";
import { getAutoNamerSkipReason, type AutoNamerGuardChecks } from "./session-namer-guard.js";

function checks(overrides: Partial<AutoNamerGuardChecks> = {}): AutoNamerGuardChecks {
  return {
    isAutoNamerEnabled: vi.fn(() => true),
    isNoAutoNameSession: vi.fn(() => false),
    isUserNamed: vi.fn(() => false),
    isQuestOwningName: vi.fn(async () => false),
    ...overrides,
  } satisfies AutoNamerGuardChecks;
}

describe("getAutoNamerSkipReason", () => {
  it("uses user-named protection for every automatic namer trigger", async () => {
    for (const _source of NAMER_TRIGGER_SOURCES) {
      const guardChecks = checks({ isUserNamed: vi.fn(() => true) });

      await expect(getAutoNamerSkipReason(guardChecks)).resolves.toBe("user_named");
      expect(guardChecks.isQuestOwningName).not.toHaveBeenCalled();
    }
  });

  it("re-checks current manual-name state when called again for result application", async () => {
    let userNamed = false;
    const guardChecks = checks({ isUserNamed: vi.fn(() => userNamed) });

    await expect(getAutoNamerSkipReason(guardChecks)).resolves.toBeNull();

    userNamed = true;

    await expect(getAutoNamerSkipReason(guardChecks)).resolves.toBe("user_named");
  });

  it("skips before manual-name checks when auto-namer is disabled", async () => {
    const guardChecks = checks({ isAutoNamerEnabled: vi.fn(() => false) });

    await expect(getAutoNamerSkipReason(guardChecks)).resolves.toBe("disabled");
    expect(guardChecks.isNoAutoNameSession).not.toHaveBeenCalled();
    expect(guardChecks.isUserNamed).not.toHaveBeenCalled();
    expect(guardChecks.isQuestOwningName).not.toHaveBeenCalled();
  });

  it("skips before manual-name checks for noAutoName sessions", async () => {
    const guardChecks = checks({ isNoAutoNameSession: vi.fn(() => true) });

    await expect(getAutoNamerSkipReason(guardChecks)).resolves.toBe("no_auto_name");
    expect(guardChecks.isUserNamed).not.toHaveBeenCalled();
    expect(guardChecks.isQuestOwningName).not.toHaveBeenCalled();
  });

  it("falls back to quest-owned protection when no earlier guard applies", async () => {
    const guardChecks = checks({ isQuestOwningName: vi.fn(async () => true) });

    await expect(getAutoNamerSkipReason(guardChecks)).resolves.toBe("quest_owned");
  });
});
