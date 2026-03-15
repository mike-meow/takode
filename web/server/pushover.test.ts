import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PushoverNotifier, type PushoverSettings, type PushoverNotifierOpts } from "./pushover.js";

/**
 * Tests for the Pushover notification scheduler.
 *
 * Validates: scheduling, batching, cancellation, rate limiting, message format,
 * deep link generation, unconfigured no-op, and API error handling.
 */

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

function makeSettings(overrides?: Partial<PushoverSettings>): PushoverSettings {
  return {
    pushoverUserKey: "test-user-key",
    pushoverApiToken: "test-api-token",
    pushoverDelaySeconds: 30,
    pushoverEnabled: true,
    ...overrides,
  };
}

function makeOpts(overrides?: Partial<PushoverNotifierOpts>): PushoverNotifierOpts {
  return {
    getSettings: () => makeSettings(),
    getBaseUrl: () => "http://localhost:3456",
    getServerName: () => "My Server",
    getSessionName: () => "Refactor auth",
    getSessionActivity: () => "Fixing authentication bug",
    getLastReadAt: () => 0,
    ...overrides,
  };
}

function lastFetchBody(): URLSearchParams {
  const call = vi.mocked(fetch).mock.calls.at(-1)!;
  return call[1]!.body as URLSearchParams;
}

describe("PushoverNotifier", () => {
  let notifier: PushoverNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  afterEach(() => {
    notifier?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Scheduling ──────────────────────────────────────────────────────

  it("sends notification after configured delay", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "permission", "Bash: npm test", "req-1");

    // Should not send immediately
    expect(fetch).not.toHaveBeenCalled();

    // Advance to just before the delay
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).not.toHaveBeenCalled();

    // Advance past the delay
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    const body = lastFetchBody();
    expect(body.get("token")).toBe("test-api-token");
    expect(body.get("user")).toBe("test-user-key");
    expect(body.get("title")).toBe("Permission needed");
    expect(body.get("priority")).toBe("1");
    expect(body.get("html")).toBe("1");
  });

  it("respects custom delay from settings", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getSettings: () => makeSettings({ pushoverDelaySeconds: 10 }),
      }),
    );
    notifier.scheduleNotification("sess-1", "completed");

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // ── Message format ──────────────────────────────────────────────────

  it("includes server name, session name, activity, and detail in message", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "permission", "Bash: npm test", "req-1");

    await vi.advanceTimersByTimeAsync(30_000);
    const body = lastFetchBody();
    const message = body.get("message")!;
    expect(message).toContain("My Server");
    expect(message).toContain("Refactor auth");
    expect(message).toContain("Fixing authentication bug");
    expect(message).toContain("Bash");
  });

  it("omits activity line when unavailable", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getSessionActivity: () => undefined,
      }),
    );
    notifier.scheduleNotification("sess-1", "completed");

    await vi.advanceTimersByTimeAsync(30_000);
    const body = lastFetchBody();
    const message = body.get("message")!;
    // Should have server + session, but no activity line
    expect(message).toContain("My Server");
    expect(message).not.toContain("Fixing");
  });

  it("falls back to truncated session ID when no name", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getSessionName: () => undefined,
      }),
    );
    notifier.scheduleNotification("abcdef12-3456-7890", "completed");

    await vi.advanceTimersByTimeAsync(30_000);
    const body = lastFetchBody();
    const message = body.get("message")!;
    expect(message).toContain("abcdef12");
  });

  it("uses 'Question from Claude' title for AskUserQuestion events", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "question", "AskUserQuestion", "req-1");

    await vi.advanceTimersByTimeAsync(30_000);
    const body = lastFetchBody();
    expect(body.get("title")).toBe("Question from Claude");
  });

  // ── Deep links ──────────────────────────────────────────────────────

  it("includes deep link URL in notification", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "permission", "Bash", "req-1");

    await vi.advanceTimersByTimeAsync(30_000);
    const body = lastFetchBody();
    expect(body.get("url")).toBe("http://localhost:3456/#/sess-1");
    expect(body.get("url_title")).toBe("Open in Companion");
  });

  it("uses custom base URL for deep links", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getBaseUrl: () => "https://companion.example.com",
      }),
    );
    notifier.scheduleNotification("sess-1", "completed");

    await vi.advanceTimersByTimeAsync(30_000);
    const body = lastFetchBody();
    expect(body.get("url")).toBe("https://companion.example.com/#/sess-1");
  });

  it("strips trailing slashes from base URL", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getBaseUrl: () => "https://example.com///",
      }),
    );
    notifier.scheduleNotification("sess-1", "completed");

    await vi.advanceTimersByTimeAsync(30_000);
    const body = lastFetchBody();
    expect(body.get("url")).toBe("https://example.com/#/sess-1");
  });

  // ── Batching ────────────────────────────────────────────────────────

  it("batches multiple permission requests into one notification", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "permission", "Bash: npm test", "req-1");
    notifier.scheduleNotification("sess-1", "permission", "Write: file.ts", "req-2");
    notifier.scheduleNotification("sess-1", "permission", "Edit: other.ts", "req-3");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    const body = lastFetchBody();
    expect(body.get("title")).toBe("3 permissions waiting");
    const message = body.get("message")!;
    expect(message).toContain("Bash");
    expect(message).toContain("Write");
    expect(message).toContain("Edit");
  });

  it("extends batch timer but caps at original delay", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getSettings: () => makeSettings({ pushoverDelaySeconds: 10 }),
      }),
    );

    notifier.scheduleNotification("sess-1", "permission", "Bash", "req-1");

    // Add another 8s later — batch window would want +3s = 11s from start,
    // but capped at 10s from original creation
    await vi.advanceTimersByTimeAsync(8_000);
    notifier.scheduleNotification("sess-1", "permission", "Write", "req-2");

    // At t=10s it should fire (capped)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // ── Cancellation ────────────────────────────────────────────────────

  it("cancels notification when permission is resolved before delay", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "permission", "Bash", "req-1");

    // Resolve before delay fires
    await vi.advanceTimersByTimeAsync(15_000);
    notifier.cancelPermission("sess-1", "req-1");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels individual request from batch, keeps batch if others remain", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "permission", "Bash", "req-1");
    notifier.scheduleNotification("sess-1", "permission", "Write", "req-2");

    // Cancel only req-1
    notifier.cancelPermission("sess-1", "req-1");

    await vi.advanceTimersByTimeAsync(30_000);
    // Should still fire for the remaining request
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = lastFetchBody();
    expect(body.get("title")).toBe("Permission needed");
  });

  it("cancelForSession clears all pending for that session", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "permission", "Bash", "req-1");
    notifier.scheduleNotification("sess-1", "completed");

    notifier.cancelForSession("sess-1");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancelForSession with eventType only cancels that type", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "permission", "Bash", "req-1");
    notifier.scheduleNotification("sess-1", "completed");

    notifier.cancelForSession("sess-1", "permission");

    await vi.advanceTimersByTimeAsync(30_000);
    // Only completed should fire
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = lastFetchBody();
    expect(body.get("title")).toBe("Session completed");
  });

  // ── Rate limiting ───────────────────────────────────────────────────

  it("enforces per-session cooldown", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getSettings: () => makeSettings({ pushoverDelaySeconds: 1 }),
      }),
    );

    // First notification
    notifier.scheduleNotification("sess-1", "completed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Second notification immediately after — should be rate-limited
    notifier.scheduleNotification("sess-1", "error", "Context limit");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1); // Still 1 — blocked by cooldown
  });

  it("allows notifications for different sessions concurrently", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getSettings: () => makeSettings({ pushoverDelaySeconds: 1 }),
      }),
    );

    notifier.scheduleNotification("sess-1", "completed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Different session — should bypass per-session cooldown (but global 5s applies)
    await vi.advanceTimersByTimeAsync(5_000);
    notifier.scheduleNotification("sess-2", "completed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // ── Unconfigured / disabled ─────────────────────────────────────────

  it("no-ops when pushover is not configured", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getSettings: () => makeSettings({ pushoverUserKey: "", pushoverApiToken: "" }),
      }),
    );

    notifier.scheduleNotification("sess-1", "permission", "Bash", "req-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("no-ops when pushover is disabled", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getSettings: () => makeSettings({ pushoverEnabled: false }),
      }),
    );

    notifier.scheduleNotification("sess-1", "permission", "Bash", "req-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  // ── Test notification ───────────────────────────────────────────────

  it("sendTest bypasses delay and cooldowns", async () => {
    notifier = new PushoverNotifier(makeOpts());
    const result = await notifier.sendTest();
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    const body = lastFetchBody();
    expect(body.get("title")).toBe("Companion");
    expect(body.get("message")).toContain("configured correctly");
    expect(body.get("message")).toContain("My Server");
    expect(body.get("priority")).toBe("-1");
  });

  it("sendTest returns error when credentials are missing", async () => {
    notifier = new PushoverNotifier(
      makeOpts({
        getSettings: () => makeSettings({ pushoverUserKey: "" }),
      }),
    );
    const result = await notifier.sendTest();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  // ── API error handling ──────────────────────────────────────────────

  it("handles Pushover API errors gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"errors":["invalid token"]}'),
      }),
    );

    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "completed");

    // Should not throw
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("handles network errors gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "completed");

    // Should not throw
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // ── Priorities ──────────────────────────────────────────────────────

  it("uses correct priorities for each event type", async () => {
    const priorities: Record<string, string> = {};

    notifier = new PushoverNotifier(
      makeOpts({
        getSettings: () => makeSettings({ pushoverDelaySeconds: 1 }),
      }),
    );

    // Permission
    notifier.scheduleNotification("s1", "permission", "Bash", "r1");
    await vi.advanceTimersByTimeAsync(1_000);
    priorities.permission = lastFetchBody().get("priority")!;

    // Question (different session to avoid cooldown)
    await vi.advanceTimersByTimeAsync(5_000);
    notifier.scheduleNotification("s2", "question", "AskUserQuestion", "r2");
    await vi.advanceTimersByTimeAsync(1_000);
    priorities.question = lastFetchBody().get("priority")!;

    // Error
    await vi.advanceTimersByTimeAsync(5_000);
    notifier.scheduleNotification("s3", "error", "Context limit");
    await vi.advanceTimersByTimeAsync(1_000);
    priorities.error = lastFetchBody().get("priority")!;

    // Completed
    await vi.advanceTimersByTimeAsync(5_000);
    notifier.scheduleNotification("s4", "completed");
    await vi.advanceTimersByTimeAsync(1_000);
    priorities.completed = lastFetchBody().get("priority")!;

    expect(priorities.permission).toBe("1");
    expect(priorities.question).toBe("1");
    expect(priorities.error).toBe("1");
    expect(priorities.completed).toBe("0");
  });

  // ── Destroy ─────────────────────────────────────────────────────────

  it("destroy clears all pending timers", async () => {
    notifier = new PushoverNotifier(makeOpts());
    notifier.scheduleNotification("sess-1", "permission", "Bash", "req-1");
    notifier.scheduleNotification("sess-2", "completed");

    notifier.destroy();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled();
  });
});
