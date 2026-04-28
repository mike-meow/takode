import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTakodeRoutes } from "./routes/takode.js";
import { ensureBuiltInQuestJourneyPhaseData } from "./quest-journey-phases.js";

const tmpHomes: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(tmpHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTestHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "takode-phase-catalog-home-"));
  tmpHomes.push(home);
  await ensureBuiltInQuestJourneyPhaseData({ companionHome: join(home, ".companion") });
  process.env.HOME = home;
  return home;
}

function createTestApp() {
  const app = new Hono();
  app.route(
    "/api",
    createTakodeRoutes({
      launcher: {
        getSessionNum: vi.fn(() => 1),
      },
      wsBridge: {},
      authenticateTakodeCaller: vi.fn(() => ({
        callerId: "session-1",
        caller: { sessionId: "session-1", isOrchestrator: false },
      })),
      resolveId: (id: string) => id,
    } as any),
  );
  return app;
}

describe("takode phase catalog route", () => {
  it("serves read-only phase metadata to non-orchestrator sessions", async () => {
    await createTestHome();
    const app = createTestApp();

    const res = await app.request("/api/takode/quest-journey-phases");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { phases: Array<Record<string, unknown>> };
    expect(body.phases[0]).toEqual(
      expect.objectContaining({
        id: "alignment",
        label: "Alignment",
        sourceType: "built-in",
        assigneeBriefDisplayPath: "~/.companion/quest-journey-phases/alignment/assignee.md",
      }),
    );
    expect(body.phases.map((phase) => phase.id)).toContain("port");
  });
});
