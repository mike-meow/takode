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
    this.timer = setInterval(() => this.sweep(), intervalMs);
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
  sweep(): number {
    const { maxKeepAlive } = this.getSettings();
    if (maxKeepAlive <= 0) return 0;

    const alive = this.launcher
      .listSessions()
      .filter((s) => s.state !== "exited" && !s.archived);

    if (alive.length <= maxKeepAlive) return 0;

    // Sort non-busy sessions by lastActivityAt ascending (oldest first)
    const killable = alive
      .filter((s) => !this.wsBridge.isSessionBusy(s.sessionId))
      .sort(
        (a, b) =>
          (a.lastActivityAt ?? a.createdAt) -
          (b.lastActivityAt ?? b.createdAt),
      );

    const toKill = alive.length - maxKeepAlive;
    let killed = 0;

    for (let i = 0; i < Math.min(toKill, killable.length); i++) {
      this.launcher.kill(killable[i].sessionId);
      killed++;
    }

    if (killed > 0) {
      console.log(
        `[idle-manager] Killed ${killed} idle session(s) to enforce maxKeepAlive=${maxKeepAlive}`,
      );
    }

    return killed;
  }
}
