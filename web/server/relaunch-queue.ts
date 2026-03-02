/**
 * Coalesces rapid relaunch requests per session into at-most one trailing
 * relaunch after a cooldown window. This prevents dropping mode changes while
 * still preserving the existing anti-thrash behavior.
 */
export class RelaunchQueue {
  private readonly inFlight = new Set<string>();
  private readonly coolingDown = new Set<string>();
  private readonly queued = new Set<string>();

  constructor(
    private readonly runRelaunch: (sessionId: string) => Promise<void>,
    private readonly cooldownMs: number = 5000,
  ) {}

  request(sessionId: string): void {
    if (this.inFlight.has(sessionId) || this.coolingDown.has(sessionId)) {
      this.queued.add(sessionId);
      return;
    }
    void this.run(sessionId);
  }

  private async run(sessionId: string): Promise<void> {
    this.inFlight.add(sessionId);
    try {
      await this.runRelaunch(sessionId);
    } finally {
      this.inFlight.delete(sessionId);
      this.coolingDown.add(sessionId);
      setTimeout(() => {
        this.coolingDown.delete(sessionId);
        if (!this.queued.delete(sessionId)) return;
        this.request(sessionId);
      }, this.cooldownMs);
    }
  }
}
