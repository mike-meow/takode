import { spawn, type ChildProcess } from "node:child_process";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";

export interface CaffeinateStatus {
  active: boolean;
  engagedAt: number | null;
  expiresAt: number | null;
}

/**
 * Prevents macOS from sleeping while any session is actively generating.
 *
 * Polls every 60s. If any session has isGenerating === true, spawns
 * `caffeinate -t <seconds>` (killing any previous instance first to reset
 * the timer). If no sessions are generating, does nothing -- the existing
 * caffeinate process expires naturally, providing a grace period.
 *
 * No-op on non-macOS platforms.
 */
export class SleepInhibitor {
  private readonly wsBridge: WsBridge;
  private readonly launcher: CliLauncher;
  private readonly getSettings: () => {
    sleepInhibitorEnabled: boolean;
    sleepInhibitorDurationMinutes: number;
  };
  private readonly isMacOS: boolean;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private caffeinateProc: ChildProcess | null = null;
  private engagedAt: number | null = null;
  private engagedDurationSeconds: number | null = null;

  constructor(deps: {
    wsBridge: WsBridge;
    launcher: CliLauncher;
    getSettings: () => {
      sleepInhibitorEnabled: boolean;
      sleepInhibitorDurationMinutes: number;
    };
  }) {
    this.wsBridge = deps.wsBridge;
    this.launcher = deps.launcher;
    this.getSettings = deps.getSettings;
    this.isMacOS = process.platform === "darwin";
  }

  start(intervalMs = 60_000): void {
    if (!this.isMacOS) return;
    if (this.intervalHandle !== null) return;

    this.sweep();
    this.intervalHandle = setInterval(() => this.sweep(), intervalMs);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.killCaffeinate();
  }

  /** Current caffeinate process status with timing info. */
  getStatus(): CaffeinateStatus {
    if (!this.caffeinateProc || this.engagedAt === null || this.engagedDurationSeconds === null) {
      return { active: false, engagedAt: null, expiresAt: null };
    }
    return {
      active: true,
      engagedAt: this.engagedAt,
      expiresAt: this.engagedAt + this.engagedDurationSeconds * 1000,
    };
  }

  /** Visible for testing. */
  sweep(): void {
    const { sleepInhibitorEnabled } = this.getSettings();

    if (!sleepInhibitorEnabled) {
      this.killCaffeinate();
      return;
    }

    if (this.hasAnyGeneratingSession()) {
      const durationSeconds = this.getSettings().sleepInhibitorDurationMinutes * 60;
      this.engageCaffeinate(durationSeconds);
    }
    // If no sessions generating, let existing caffeinate expire naturally (grace period).
  }

  private hasAnyGeneratingSession(): boolean {
    for (const info of this.launcher.listSessions()) {
      if (info.state === "exited") continue;
      if (this.wsBridge.getSession(info.sessionId)?.isGenerating) return true;
    }
    return false;
  }

  private engageCaffeinate(durationSeconds: number): void {
    this.killCaffeinate();

    try {
      const proc = spawn("caffeinate", ["-t", String(durationSeconds)], {
        stdio: "ignore",
        detached: false,
      });

      proc.on("exit", () => {
        if (this.caffeinateProc === proc) {
          this.caffeinateProc = null;
          this.engagedAt = null;
          this.engagedDurationSeconds = null;
        }
      });

      proc.on("error", (err) => {
        console.warn(`[sleep-inhibitor] Failed to spawn caffeinate: ${err.message}`);
        if (this.caffeinateProc === proc) {
          this.caffeinateProc = null;
          this.engagedAt = null;
          this.engagedDurationSeconds = null;
        }
      });

      // Don't let the caffeinate process keep the event loop alive on shutdown.
      proc.unref();
      this.caffeinateProc = proc;
      this.engagedAt = Date.now();
      this.engagedDurationSeconds = durationSeconds;
    } catch (err) {
      console.warn(
        `[sleep-inhibitor] caffeinate spawn error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private killCaffeinate(): void {
    if (!this.caffeinateProc) return;
    const proc = this.caffeinateProc;
    this.caffeinateProc = null;
    this.engagedAt = null;
    this.engagedDurationSeconds = null;

    try {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
      }
    } catch {
      // Process already exited -- safe to ignore.
    }
  }
}
