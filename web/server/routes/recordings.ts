import { Hono } from "hono";
import type { RouteContext } from "./context.js";

export function createRecordingsRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, recorder, resolveId } = ctx;

  // ─── Recording Management ──────────────────────────────────

  api.post("/sessions/:id/recording/start", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.enableForSession(id);
    return c.json({ ok: true, recording: true });
  });

  api.post("/sessions/:id/recording/stop", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.disableForSession(id);
    return c.json({ ok: true, recording: false });
  });

  api.get("/sessions/:id/recording/status", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    // Primary artifact-discovery endpoint for debugging session behavior.
    // Use this instead of guessing tmpdir-derived paths:
    // - `filePath`: raw protocol recording JSONL
    // - `sdkDebugFile`: Claude SDK debug log, when available
    // - `recordingsDir`: the server's actual active tmpdir-backed recording root
    if (!recorder) {
      return c.json({
        recording: false,
        available: false,
        sdkDebugFile: session.sdkDebugLogPath,
      });
    }
    return c.json({
      recording: recorder.isRecording(id),
      available: true,
      recordingsDir: recorder.getRecordingsDir(),
      globalEnabled: recorder.isGloballyEnabled(),
      sdkDebugFile: session.sdkDebugLogPath,
      ...recorder.getRecordingStatus(id),
    });
  });

  api.get("/recordings", async (c) => {
    if (!recorder) return c.json({ recordings: [] });
    return c.json({ recordings: await recorder.listRecordings() });
  });

  return api;
}
