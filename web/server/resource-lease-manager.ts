import { DEFAULT_RESOURCE_LEASE_TTL_MS, RESOURCE_LEASE_SWEEP_INTERVAL_MS } from "./resource-lease-types.js";
import type {
  ResourceLease,
  ResourceLeaseAcquireInput,
  ResourceLeaseAcquireResult,
  ResourceLeaseFile,
  ResourceLeaseReleaseResult,
  ResourceLeaseRenewInput,
  ResourceLeaseStatus,
  ResourceLeaseWaiter,
  ResourceLeaseWaitInput,
} from "./resource-lease-types.js";
import { emptyResourceLeaseFile, ResourceLeaseStore } from "./resource-lease-store.js";

const MAX_PURPOSE_LENGTH = 300;
const MAX_RESOURCE_KEY_LENGTH = 120;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const LOG_TAG = "[resource-lease-manager]";

export class ResourceLeaseError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}

interface ResourceLeaseBridge {
  injectUserMessage: (
    sessionId: string,
    content: string,
    agentSource?: { sessionId: string; sessionLabel?: string },
  ) => "sent" | "queued" | "dropped" | "no_session";
}

export class ResourceLeaseManager {
  private data: ResourceLeaseFile = emptyResourceLeaseFile();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private bridge: ResourceLeaseBridge,
    private store = new ResourceLeaseStore(),
  ) {}

  async startAll(): Promise<void> {
    await this.ensureLoaded();
    await this.sweepExpiredNow();
    this.startSweep();
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async acquire(input: ResourceLeaseAcquireInput): Promise<ResourceLeaseAcquireResult> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const normalized = normalizeAcquireInput(input);
      const changed = this.expireDueLeases(Date.now());
      const result = this.acquireLoaded(normalized);
      await this.persistIfNeeded(changed || result.status === "acquired" || result.status === "queued");
      return result;
    });
  }

  async wait(input: ResourceLeaseWaitInput): Promise<ResourceLeaseAcquireResult> {
    return this.acquire({ ...input, waitIfUnavailable: true });
  }

  async renew(input: ResourceLeaseRenewInput): Promise<ResourceLease> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const resourceKey = normalizeResourceKey(input.resourceKey);
      const callerSessionId = normalizeSessionId(input.callerSessionId);
      const ttlMs = normalizeTtlMs(input.ttlMs);
      const expiredChanged = this.expireDueLeases(Date.now());
      const lease = this.findLease(resourceKey);
      if (!lease) {
        await this.persistIfNeeded(expiredChanged);
        throw new ResourceLeaseError("not_found", `No active lease for ${resourceKey}`);
      }
      if (lease.ownerSessionId !== callerSessionId) {
        await this.persistIfNeeded(expiredChanged);
        throw new ResourceLeaseError("forbidden", `Only ${lease.ownerSessionId} can renew ${resourceKey}`);
      }
      const now = Date.now();
      lease.heartbeatAt = now;
      lease.ttlMs = ttlMs ?? lease.ttlMs;
      lease.expiresAt = now + lease.ttlMs;
      await this.persistIfNeeded(true);
      return lease;
    });
  }

  async release(resourceKeyInput: string, callerSessionIdInput: string): Promise<ResourceLeaseReleaseResult> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const resourceKey = normalizeResourceKey(resourceKeyInput);
      const callerSessionId = normalizeSessionId(callerSessionIdInput);
      const expiredChanged = this.expireDueLeases(Date.now());
      const leaseIndex = this.data.leases.findIndex((lease) => lease.resourceKey === resourceKey);
      if (leaseIndex === -1) {
        await this.persistIfNeeded(expiredChanged);
        throw new ResourceLeaseError("not_found", `No active lease for ${resourceKey}`);
      }
      const lease = this.data.leases[leaseIndex];
      if (lease.ownerSessionId !== callerSessionId) {
        await this.persistIfNeeded(expiredChanged);
        throw new ResourceLeaseError("forbidden", `Only ${lease.ownerSessionId} can release ${resourceKey}`);
      }

      this.data.leases.splice(leaseIndex, 1);
      const promoted = this.promoteNextWaiter(resourceKey, Date.now());
      await this.persistIfNeeded(true);
      return {
        released: lease,
        promoted,
        waiters: this.getWaiters(resourceKey),
      };
    });
  }

  async getStatus(resourceKeyInput: string): Promise<ResourceLeaseStatus> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const resourceKey = normalizeResourceKey(resourceKeyInput);
      const changed = this.expireDueLeases(Date.now());
      await this.persistIfNeeded(changed);
      return this.buildStatus(resourceKey);
    });
  }

  async listStatuses(): Promise<ResourceLeaseStatus[]> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const changed = this.expireDueLeases(Date.now());
      await this.persistIfNeeded(changed);
      const keys = new Set<string>([
        ...this.data.leases.map((lease) => lease.resourceKey),
        ...Object.keys(this.data.waiters).filter((key) => this.data.waiters[key]?.length),
      ]);
      return [...keys].sort().map((key) => this.buildStatus(key));
    });
  }

  async sweepExpiredNow(now = Date.now()): Promise<void> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const expired = this.expireDueLeases(now);
      await this.persistIfNeeded(expired);
    });
  }

  private acquireLoaded(input: Required<Omit<ResourceLeaseAcquireInput, "questId">> & { questId?: string }) {
    const now = Date.now();
    const existing = this.findLease(input.resourceKey);
    if (existing?.ownerSessionId === input.callerSessionId) {
      return {
        status: "already_owned" as const,
        lease: existing,
        waiters: this.getWaiters(input.resourceKey),
      };
    }

    if (existing) {
      if (!input.waitIfUnavailable) {
        return { status: "unavailable" as const, lease: existing, waiters: this.getWaiters(input.resourceKey) };
      }
      const waiter = this.addWaiter(input, now);
      return {
        status: "queued" as const,
        waiter,
        lease: existing,
        position: this.getWaiters(input.resourceKey).findIndex((entry) => entry.id === waiter.id) + 1,
      };
    }

    const waiters = this.getWaiters(input.resourceKey);
    if (waiters.length > 0) {
      if (waiters[0]?.waiterSessionId === input.callerSessionId) {
        const lease = this.promoteNextWaiter(input.resourceKey, now);
        if (!lease) throw new ResourceLeaseError("invalid", `Failed to promote waiter for ${input.resourceKey}`);
        return { status: "acquired" as const, lease, waiters: this.getWaiters(input.resourceKey) };
      }
      if (!input.waitIfUnavailable) {
        const placeholderLease = this.waiterPlaceholderLease(waiters[0]);
        return { status: "unavailable" as const, lease: placeholderLease, waiters };
      }
      const waiter = this.addWaiter(input, now);
      return {
        status: "queued" as const,
        waiter,
        lease: this.waiterPlaceholderLease(waiters[0]),
        position: this.getWaiters(input.resourceKey).findIndex((entry) => entry.id === waiter.id) + 1,
      };
    }

    const lease = this.createLease(input, now);
    this.data.leases.push(lease);
    return { status: "acquired" as const, lease, waiters: [] };
  }

  private expireDueLeases(now: number): boolean {
    let changed = false;
    const expired = this.data.leases.filter((lease) => lease.expiresAt <= now);
    if (expired.length === 0) return false;

    for (const lease of expired) {
      this.data.leases = this.data.leases.filter((entry) => entry.resourceKey !== lease.resourceKey);
      this.promoteNextWaiter(lease.resourceKey, now);
      changed = true;
      console.log(`${LOG_TAG} Expired lease for ${lease.resourceKey} owned by ${lease.ownerSessionId.slice(0, 8)}`);
    }
    return changed;
  }

  private promoteNextWaiter(resourceKey: string, now: number): ResourceLease | null {
    const waiters = this.getWaiters(resourceKey);
    const waiter = waiters.shift();
    if (!waiter) {
      this.setWaiters(resourceKey, waiters);
      return null;
    }

    this.setWaiters(resourceKey, waiters);
    const lease: ResourceLease = {
      resourceKey,
      ownerSessionId: waiter.waiterSessionId,
      ...(waiter.questId ? { questId: waiter.questId } : {}),
      purpose: waiter.purpose,
      metadata: waiter.metadata,
      acquiredAt: now,
      heartbeatAt: now,
      ttlMs: waiter.ttlMs,
      expiresAt: now + waiter.ttlMs,
    };
    this.data.leases.push(lease);
    this.notifyPromotedWaiter(lease);
    return lease;
  }

  private notifyPromotedWaiter(lease: ResourceLease): void {
    const lines = [
      `[Resource lease acquired] You now hold \`${lease.resourceKey}\`.`,
      "",
      `Purpose: ${lease.purpose}`,
      `Expires: ${new Date(lease.expiresAt).toISOString()}`,
      "",
      `Heartbeat with \`takode lease renew ${lease.resourceKey}\`; release with \`takode lease release ${lease.resourceKey}\` when done.`,
    ];
    const delivery = this.bridge.injectUserMessage(lease.ownerSessionId, lines.join("\n"), {
      sessionId: `resource-lease:${lease.resourceKey}`,
      sessionLabel: "Resource Lease",
    });
    console.log(`${LOG_TAG} Promoted waiter for ${lease.resourceKey}: ${delivery}`);
  }

  private createLease(
    input: Required<Omit<ResourceLeaseAcquireInput, "questId">> & { questId?: string },
    now: number,
  ): ResourceLease {
    return {
      resourceKey: input.resourceKey,
      ownerSessionId: input.callerSessionId,
      ...(input.questId ? { questId: input.questId } : {}),
      purpose: input.purpose,
      metadata: input.metadata,
      acquiredAt: now,
      heartbeatAt: now,
      ttlMs: input.ttlMs,
      expiresAt: now + input.ttlMs,
    };
  }

  private addWaiter(
    input: Required<Omit<ResourceLeaseAcquireInput, "questId">> & { questId?: string },
    now: number,
  ): ResourceLeaseWaiter {
    const existing = this.getWaiters(input.resourceKey).find(
      (waiter) => waiter.waiterSessionId === input.callerSessionId,
    );
    if (existing) return existing;

    const waiter: ResourceLeaseWaiter = {
      id: `w${this.data.nextWaiterId++}`,
      resourceKey: input.resourceKey,
      waiterSessionId: input.callerSessionId,
      ...(input.questId ? { questId: input.questId } : {}),
      purpose: input.purpose,
      metadata: input.metadata,
      queuedAt: now,
      ttlMs: input.ttlMs,
    };
    this.setWaiters(input.resourceKey, [...this.getWaiters(input.resourceKey), waiter]);
    return waiter;
  }

  private waiterPlaceholderLease(waiter: ResourceLeaseWaiter): ResourceLease {
    return {
      resourceKey: waiter.resourceKey,
      ownerSessionId: waiter.waiterSessionId,
      ...(waiter.questId ? { questId: waiter.questId } : {}),
      purpose: waiter.purpose,
      metadata: waiter.metadata,
      acquiredAt: waiter.queuedAt,
      heartbeatAt: waiter.queuedAt,
      ttlMs: waiter.ttlMs,
      expiresAt: waiter.queuedAt + waiter.ttlMs,
    };
  }

  private buildStatus(resourceKey: string): ResourceLeaseStatus {
    const lease = this.findLease(resourceKey) ?? null;
    const waiters = this.getWaiters(resourceKey);
    return {
      resourceKey,
      lease,
      waiters,
      available: !lease && waiters.length === 0,
    };
  }

  private findLease(resourceKey: string): ResourceLease | undefined {
    return this.data.leases.find((lease) => lease.resourceKey === resourceKey);
  }

  private getWaiters(resourceKey: string): ResourceLeaseWaiter[] {
    return [...(this.data.waiters[resourceKey] ?? [])];
  }

  private setWaiters(resourceKey: string, waiters: ResourceLeaseWaiter[]): void {
    if (waiters.length === 0) delete this.data.waiters[resourceKey];
    else this.data.waiters[resourceKey] = waiters;
  }

  private startSweep(): void {
    this.destroy();
    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredNow();
    }, RESOURCE_LEASE_SWEEP_INTERVAL_MS);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = this.store.load().then((data) => {
        this.data = data;
        this.loaded = true;
      });
    }
    await this.loading;
  }

  private async persistIfNeeded(changed: boolean): Promise<void> {
    if (changed) await this.store.save(this.data);
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(fn, fn);
    this.operationQueue = run.catch(() => undefined);
    return run;
  }
}

function normalizeAcquireInput(
  input: ResourceLeaseAcquireInput,
): Required<Omit<ResourceLeaseAcquireInput, "questId">> & { questId?: string } {
  const purpose = input.purpose.trim();
  if (!purpose) throw new ResourceLeaseError("invalid", "purpose is required");
  if (purpose.length > MAX_PURPOSE_LENGTH) {
    throw new ResourceLeaseError("invalid", `purpose must be ${MAX_PURPOSE_LENGTH} characters or less`);
  }
  const questId = normalizeQuestId(input.questId);
  return {
    resourceKey: normalizeResourceKey(input.resourceKey),
    callerSessionId: normalizeSessionId(input.callerSessionId),
    ...(questId ? { questId } : {}),
    purpose,
    metadata: normalizeMetadata(input.metadata),
    ttlMs: normalizeTtlMs(input.ttlMs) ?? DEFAULT_RESOURCE_LEASE_TTL_MS,
    waitIfUnavailable: input.waitIfUnavailable === true,
  };
}

function normalizeResourceKey(resourceKey: string): string {
  const key = resourceKey.trim().toLowerCase();
  if (!key) throw new ResourceLeaseError("invalid", "resource key is required");
  if (key.length > MAX_RESOURCE_KEY_LENGTH) {
    throw new ResourceLeaseError("invalid", `resource key must be ${MAX_RESOURCE_KEY_LENGTH} characters or less`);
  }
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(key)) {
    throw new ResourceLeaseError(
      "invalid",
      "resource key must use letters, numbers, dot, underscore, colon, or hyphen",
    );
  }
  return key;
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new ResourceLeaseError("invalid", "session id is required");
  return normalized;
}

function normalizeQuestId(questId: string | undefined): string | undefined {
  const normalized = questId?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^q-\d+$/.test(normalized)) throw new ResourceLeaseError("invalid", "questId must match q-N");
  return normalized;
}

function normalizeTtlMs(ttlMs: number | undefined): number | undefined {
  if (ttlMs === undefined) return undefined;
  if (!Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new ResourceLeaseError("invalid", `ttlMs must be between ${MIN_TTL_MS} and ${MAX_TTL_MS} milliseconds`);
  }
  return Math.floor(ttlMs);
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  if (!metadata) return {};
  const entries = Object.entries(metadata)
    .map(([key, value]) => [key.trim(), String(value ?? "").trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .slice(0, 20);
  return Object.fromEntries(entries);
}
