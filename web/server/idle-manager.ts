import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";

export class IdleManager {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private launcher: CliLauncher,
    private wsBridge: WsBridge,
    private getSettings: () => { maxKeepAlive: number },
  ) {}

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => {
      // Fire-and-forget — sweep is async but the interval doesn't need to wait.
      void this.sweep();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Enforce maxKeepAlive: if alive session count exceeds the limit,
   * kill the oldest idle sessions. Never kills busy or archived sessions.
   * Returns the number of sessions killed.
   */
  async sweep(): Promise<number> {
    const { maxKeepAlive } = this.getSettings();
    if (maxKeepAlive <= 0) return 0;

    const alive = this.launcher.listSessions().filter((s) => s.state !== "exited" && !s.archived);

    if (alive.length <= maxKeepAlive) return 0;

    // Sort non-busy sessions by lastActivityAt ascending (oldest first)
    const killable = alive
      .filter((s) => !this.wsBridge.isSessionBusy(s.sessionId))
      .sort((a, b) => (a.lastActivityAt ?? a.createdAt) - (b.lastActivityAt ?? b.createdAt));

    const toKill = alive.length - maxKeepAlive;
    let killed = 0;

    for (let i = 0; i < Math.min(toKill, killable.length); i++) {
      const s = killable[i];
      const age = s.lastActivityAt ? `${Math.round((Date.now() - s.lastActivityAt) / 1000)}s ago` : "no activity";
      console.log(
        `[idle-manager] Killing session ${s.sessionId.slice(0, 8)} (lastActivity: ${age}, name: ${s.name ?? "unnamed"})`,
      );
      // Mark session so the UI can show a less alarming indicator for idle kills
      s.killedByIdleManager = true;
      // Use bridge.killSession which handles both subprocess kills and SDK
      // adapter disconnects. Await to verify the kill succeeded.
      const success = await this.wsBridge.killSession(s.sessionId);
      if (success) {
        killed++;
      } else {
        console.warn(`[idle-manager] Failed to kill session ${s.sessionId.slice(0, 8)} — session may not exist`);
      }
    }

    if (killed > 0) {
      console.log(
        `[idle-manager] Killed ${killed} idle session(s) to enforce maxKeepAlive=${maxKeepAlive} (${alive.length} alive, ${killable.length} killable)`,
      );
    }

    return killed;
  }
}
