/**
 * Server-side Pushover push notification scheduler.
 *
 * Sends delayed notifications when attention-requiring events (permission requests,
 * questions, completions, errors) remain unresolved. Supports batching, cancellation,
 * and per-session rate limiting.
 */

export type PushoverEventType = "permission" | "question" | "completed" | "error";

export interface PushoverSettings {
  pushoverUserKey: string;
  pushoverApiToken: string;
  pushoverDelaySeconds: number;
  pushoverEnabled: boolean;
}

export interface PushoverNotifierOpts {
  getSettings: () => PushoverSettings;
  getBaseUrl: () => string;
  getServerName: () => string;
  getSessionName: (sessionId: string) => string | undefined;
  getSessionActivity: (sessionId: string) => string | undefined;
  /** Returns the epoch ms when the user last read this session (0 = never). */
  getLastReadAt: (sessionId: string) => number;
}

interface PendingNotification {
  sessionId: string;
  eventType: PushoverEventType;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
  detail?: string;
  /** Permission/question request IDs included in this batch */
  requestIds: string[];
  /** Tool names for batched permissions (for display) */
  toolNames: string[];
}

interface SessionCooldown {
  lastNotifiedAt: number;
  windowStart: number;
  windowCount: number;
}

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

/** Minimum seconds between any two Pushover API calls */
const GLOBAL_MIN_INTERVAL_MS = 5_000;
/** Minimum ms between notifications for the same session */
const SESSION_COOLDOWN_MS = 60_000;
/** Rate limit window duration */
const SESSION_WINDOW_MS = 300_000;
/** Max notifications per session per window */
const SESSION_WINDOW_MAX = 5;
/** Batching window for rapid-fire permissions on the same session */
const PERMISSION_BATCH_WINDOW_MS = 3_000;

const EVENT_PRIORITY: Record<PushoverEventType, number> = {
  permission: 1,
  question: 1,
  error: 1,
  completed: 0,
};

const EVENT_TITLE: Record<PushoverEventType, string> = {
  permission: "Permission needed",
  question: "Question from Claude",
  completed: "Session completed",
  error: "Session error",
};

export class PushoverNotifier {
  private opts: PushoverNotifierOpts;
  /** Pending notifications keyed by `${sessionId}:${eventType}` */
  private pending = new Map<string, PendingNotification>();
  private cooldowns = new Map<string, SessionCooldown>();
  private globalLastSent = 0;

  constructor(opts: PushoverNotifierOpts) {
    this.opts = opts;
  }

  private isConfigured(): boolean {
    const s = this.opts.getSettings();
    return !!(s.pushoverEnabled && s.pushoverUserKey.trim() && s.pushoverApiToken.trim());
  }

  /**
   * Schedule a notification for a session event.
   * For permissions/questions, multiple rapid-fire events are batched.
   */
  scheduleNotification(sessionId: string, eventType: PushoverEventType, detail?: string, requestId?: string): void {
    if (!this.isConfigured()) return;

    const isBatchable = eventType === "permission" || eventType === "question";
    const key = `${sessionId}:${eventType}`;
    const existing = this.pending.get(key);

    if (isBatchable && existing && requestId) {
      // Merge into existing batch — extend timer but cap at original delay
      existing.requestIds.push(requestId);
      if (detail) {
        const toolName = detail.split(":")[0]?.trim();
        if (toolName && !existing.toolNames.includes(toolName)) {
          existing.toolNames.push(toolName);
        }
      }
      // Extend the batch window, but don't exceed the configured delay from original creation
      const settings = this.opts.getSettings();
      const maxFireAt = existing.createdAt + settings.pushoverDelaySeconds * 1000;
      const batchFireAt = Math.min(Date.now() + PERMISSION_BATCH_WINDOW_MS, maxFireAt);
      const newDelay = Math.max(0, batchFireAt - Date.now());
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.fire(key), newDelay);
      return;
    }

    // Cancel any existing notification of the same type for this session
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(key);
    }

    const settings = this.opts.getSettings();
    const delayMs = settings.pushoverDelaySeconds * 1000;
    const now = Date.now();

    const pending: PendingNotification = {
      sessionId,
      eventType,
      createdAt: now,
      timer: setTimeout(() => this.fire(key), delayMs),
      detail,
      requestIds: requestId ? [requestId] : [],
      toolNames: detail ? ([detail.split(":")[0]?.trim()].filter(Boolean) as string[]) : [],
    };
    this.pending.set(key, pending);
  }

  /** Cancel a specific permission/question request from a pending batch. */
  cancelPermission(sessionId: string, requestId: string): void {
    for (const eventType of ["permission", "question"] as const) {
      const key = `${sessionId}:${eventType}`;
      const pending = this.pending.get(key);
      if (!pending) continue;

      const idx = pending.requestIds.indexOf(requestId);
      if (idx !== -1) {
        pending.requestIds.splice(idx, 1);
        if (pending.requestIds.length === 0) {
          clearTimeout(pending.timer);
          this.pending.delete(key);
        }
        return;
      }
    }
  }

  /** Cancel all pending notifications for a session, optionally filtered by event type. */
  cancelForSession(sessionId: string, eventType?: PushoverEventType): void {
    for (const [key, pending] of this.pending) {
      if (pending.sessionId === sessionId && (!eventType || pending.eventType === eventType)) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
      }
    }
  }

  /** Send a test notification (bypasses delay and cooldowns). */
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    const settings = this.opts.getSettings();
    if (!settings.pushoverUserKey.trim() || !settings.pushoverApiToken.trim()) {
      return { ok: false, error: "Pushover credentials not configured" };
    }
    const serverName = this.opts.getServerName();
    return this.sendToApi(settings, "Companion", `${serverName}\nPushover is configured correctly.`, -1);
  }

  /** Clean up all timers for graceful shutdown. */
  destroy(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
    this.cooldowns.clear();
  }

  private async fire(key: string): Promise<void> {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);

    if (!this.isConfigured()) return;

    // Skip notification if the user has read the session since the event was created
    const lastRead = this.opts.getLastReadAt(pending.sessionId);
    if (lastRead >= pending.createdAt) return;

    if (!this.checkRateLimit(pending.sessionId)) return;

    const settings = this.opts.getSettings();
    const { sessionId, eventType } = pending;

    // Build title
    let title: string;
    if ((eventType === "permission" || eventType === "question") && pending.requestIds.length > 1) {
      title = `${pending.requestIds.length} ${eventType === "question" ? "questions" : "permissions"} waiting`;
    } else {
      title = EVENT_TITLE[eventType];
    }

    // Build message body
    const lines: string[] = [];

    // Line 1: server name + session name
    const serverName = this.opts.getServerName();
    const sessionName = this.opts.getSessionName(sessionId);
    if (sessionName) {
      lines.push(`${serverName} — ${sessionName}`);
    } else {
      lines.push(`${serverName} — ${sessionId.slice(0, 8)}`);
    }

    // Line 2: activity preview (if available)
    const activity = this.opts.getSessionActivity(sessionId);
    if (activity) {
      lines.push(activity);
    }

    // Line 3: event-specific detail
    if ((eventType === "permission" || eventType === "question") && pending.toolNames.length > 1) {
      lines.push(pending.toolNames.join(", "));
    } else if (pending.detail) {
      lines.push(pending.detail);
    }

    const message = lines.join("\n");
    const url = this.buildDeepLink(sessionId);

    await this.sendToApi(settings, title, message, EVENT_PRIORITY[eventType], url);
  }

  private async sendToApi(
    settings: PushoverSettings,
    title: string,
    message: string,
    priority: number,
    url?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const body = new URLSearchParams({
        token: settings.pushoverApiToken,
        user: settings.pushoverUserKey,
        title,
        message,
        priority: String(priority),
        html: "1",
      });
      if (url) {
        body.set("url", url);
        body.set("url_title", "Open in Companion");
      }

      const res = await fetch(PUSHOVER_API_URL, {
        method: "POST",
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const error = `Pushover API error ${res.status}: ${text}`.slice(0, 200);
        console.warn(`[pushover] ${error}`);
        return { ok: false, error };
      }

      this.globalLastSent = Date.now();
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[pushover] Send failed: ${error}`);
      return { ok: false, error };
    }
  }

  private checkRateLimit(sessionId: string): boolean {
    const now = Date.now();

    // Global rate limit
    if (now - this.globalLastSent < GLOBAL_MIN_INTERVAL_MS) {
      return false;
    }

    // Per-session rate limit
    let cooldown = this.cooldowns.get(sessionId);
    if (!cooldown) {
      cooldown = { lastNotifiedAt: 0, windowStart: now, windowCount: 0 };
      this.cooldowns.set(sessionId, cooldown);
    }

    // Session cooldown
    if (now - cooldown.lastNotifiedAt < SESSION_COOLDOWN_MS) {
      return false;
    }

    // Windowed rate limit
    if (now - cooldown.windowStart > SESSION_WINDOW_MS) {
      cooldown.windowStart = now;
      cooldown.windowCount = 0;
    }
    if (cooldown.windowCount >= SESSION_WINDOW_MAX) {
      return false;
    }

    cooldown.lastNotifiedAt = now;
    cooldown.windowCount++;
    return true;
  }

  private buildDeepLink(sessionId: string): string {
    const base = this.opts.getBaseUrl().replace(/\/+$/, "");
    return `${base}/#/${sessionId}`;
  }
}
