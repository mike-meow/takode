import { mkdirSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResourceLease, ResourceLeaseFile, ResourceLeaseWaiter } from "./resource-lease-types.js";

const COMPANION_DIR = join(homedir(), ".companion");
const RESOURCE_LEASE_DIR = join(COMPANION_DIR, "resource-leases");

export function emptyResourceLeaseFile(): ResourceLeaseFile {
  return { version: 1, nextWaiterId: 1, leases: [], waiters: {} };
}

export class ResourceLeaseStore {
  private filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(namespace = "default", baseDir = RESOURCE_LEASE_DIR) {
    mkdirSync(baseDir, { recursive: true }); // sync-ok: cold path, once during store construction
    this.filePath = join(baseDir, `${sanitizeNamespace(namespace)}.json`);
  }

  async load(): Promise<ResourceLeaseFile> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return normalizeResourceLeaseFile(JSON.parse(raw));
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn("[resource-lease-store] Failed to load resource leases:", err);
      }
      return emptyResourceLeaseFile();
    }
  }

  async save(data: ResourceLeaseFile): Promise<void> {
    const normalized = normalizeResourceLeaseFile(data);
    const serialized = JSON.stringify(normalized, null, 2);
    this.pendingWrite = this.pendingWrite.then(() => writeFile(this.filePath, serialized, "utf-8"));
    await this.pendingWrite;
  }

  async delete(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  async flushForTest(): Promise<void> {
    await this.pendingWrite;
  }

  getPathForTest(): string {
    return this.filePath;
  }
}

function sanitizeNamespace(namespace: string): string {
  const normalized = namespace.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  return normalized || "default";
}

function normalizeResourceLeaseFile(raw: unknown): ResourceLeaseFile {
  if (!raw || typeof raw !== "object") return emptyResourceLeaseFile();
  const data = raw as Partial<ResourceLeaseFile>;
  const file = emptyResourceLeaseFile();
  file.nextWaiterId =
    typeof data.nextWaiterId === "number" && Number.isInteger(data.nextWaiterId) && data.nextWaiterId > 0
      ? data.nextWaiterId
      : 1;
  file.leases = Array.isArray(data.leases) ? data.leases.flatMap(normalizeLease) : [];
  file.waiters = normalizeWaiters(data.waiters);
  return file;
}

function normalizeLease(raw: unknown): ResourceLease[] {
  if (!raw || typeof raw !== "object") return [];
  const lease = raw as Partial<ResourceLease>;
  if (typeof lease.resourceKey !== "string" || !lease.resourceKey.trim()) return [];
  if (typeof lease.ownerSessionId !== "string" || !lease.ownerSessionId.trim()) return [];
  if (typeof lease.purpose !== "string" || !lease.purpose.trim()) return [];
  if (!isFinitePositive(lease.acquiredAt)) return [];
  if (!isFinitePositive(lease.heartbeatAt)) return [];
  if (!isFinitePositive(lease.ttlMs)) return [];
  if (!isFinitePositive(lease.expiresAt)) return [];

  return [
    {
      resourceKey: lease.resourceKey,
      ownerSessionId: lease.ownerSessionId,
      ...(typeof lease.questId === "string" && lease.questId ? { questId: lease.questId } : {}),
      purpose: lease.purpose,
      metadata: normalizeMetadata(lease.metadata),
      acquiredAt: lease.acquiredAt,
      heartbeatAt: lease.heartbeatAt,
      ttlMs: lease.ttlMs,
      expiresAt: lease.expiresAt,
    },
  ];
}

function normalizeWaiters(raw: unknown): Record<string, ResourceLeaseWaiter[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const normalized: Record<string, ResourceLeaseWaiter[]> = {};
  for (const [resourceKey, waiters] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(waiters)) continue;
    const entries = waiters.flatMap((waiter) => normalizeWaiter(resourceKey, waiter));
    if (entries.length > 0) normalized[resourceKey] = entries;
  }
  return normalized;
}

function normalizeWaiter(resourceKey: string, raw: unknown): ResourceLeaseWaiter[] {
  if (!raw || typeof raw !== "object") return [];
  const waiter = raw as Partial<ResourceLeaseWaiter>;
  if (typeof waiter.id !== "string" || !waiter.id.trim()) return [];
  if (typeof waiter.waiterSessionId !== "string" || !waiter.waiterSessionId.trim()) return [];
  if (typeof waiter.purpose !== "string" || !waiter.purpose.trim()) return [];
  if (!isFinitePositive(waiter.queuedAt)) return [];
  return [
    {
      id: waiter.id,
      resourceKey,
      waiterSessionId: waiter.waiterSessionId,
      ...(typeof waiter.questId === "string" && waiter.questId ? { questId: waiter.questId } : {}),
      purpose: waiter.purpose,
      metadata: normalizeMetadata(waiter.metadata),
      queuedAt: waiter.queuedAt,
      ttlMs: isFinitePositive(waiter.ttlMs) ? waiter.ttlMs : 30 * 60_000,
    },
  ];
}

function normalizeMetadata(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([key, value]) => [key.trim(), String(value ?? "").trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  return Object.fromEntries(entries);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
