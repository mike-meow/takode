import { parseDuration } from "../server/timer-parse.js";

type ApiGet = (path: string) => Promise<unknown>;
type ApiPost = (path: string, body?: unknown) => Promise<unknown>;

export interface TakodeLeaseDeps {
  apiGet: ApiGet;
  apiPost: ApiPost;
  err: (message: string) => never;
  formatInlineText: (value: unknown) => string;
  formatTimestampCompact: (epoch: number) => string;
}

interface LeaseDetail {
  resourceKey: string;
  ownerSessionId: string;
  questId?: string;
  purpose: string;
  metadata: Record<string, string>;
  acquiredAt: number;
  heartbeatAt: number;
  ttlMs: number;
  expiresAt: number;
}

interface WaiterDetail {
  id: string;
  resourceKey: string;
  waiterSessionId: string;
  questId?: string;
  purpose: string;
  metadata: Record<string, string>;
  queuedAt: number;
  ttlMs: number;
}

interface LeaseStatusDetail {
  resourceKey: string;
  lease: LeaseDetail | null;
  waiters: WaiterDetail[];
  available: boolean;
}

type AcquireResult =
  | { status: "acquired" | "already_owned"; lease: LeaseDetail; waiters: WaiterDetail[] }
  | { status: "queued"; waiter: WaiterDetail; lease: LeaseDetail; position: number }
  | { status: "unavailable"; lease: LeaseDetail; waiters: WaiterDetail[] };

export const LEASE_HELP = `Usage: takode lease <acquire|status|list|renew|heartbeat|release|wait> ...

Coordinate named global resources such as dev-server:companion or agent-browser.

Subcommands:
  acquire <resource> --purpose <text> [--ttl <duration>] [--quest q-N] [--metadata k=v] [--wait] [--json]
  wait <resource> --purpose <text> [--ttl <duration>] [--quest q-N] [--metadata k=v] [--json]
  status [resource] [--json]
  list [--json]
  renew <resource> [--ttl <duration>] [--json]
  heartbeat <resource> [--ttl <duration>] [--json]
  release <resource> [--json]

Use scoped keys by convention when useful, for example dev-server:companion.
Default TTL is 30m. Heartbeat while working and release promptly when done.
`;

export const LEASE_ACQUIRE_HELP = `Usage: takode lease acquire <resource> --purpose <text> [--ttl <duration>] [--quest q-N] [--metadata k=v] [--wait] [--json]

Acquire a named resource lease. If --wait is provided and another session owns the lease,
you are queued and the server will send your session a message when the lease is promoted.
`;

export const LEASE_WAIT_HELP = `Usage: takode lease wait <resource> --purpose <text> [--ttl <duration>] [--quest q-N] [--metadata k=v] [--json]

Acquire immediately if the resource is free; otherwise join the FIFO waiter queue.
`;

export const LEASE_STATUS_HELP = `Usage: takode lease status [resource] [--json]
       takode lease list [--json]

Inspect active leases and waiter queues.
`;

export const LEASE_RENEW_HELP = `Usage: takode lease renew <resource> [--ttl <duration>] [--json]
       takode lease heartbeat <resource> [--ttl <duration>] [--json]

Heartbeat an owned lease and extend its expiry. Without --ttl, the existing TTL is reused.
`;

export const LEASE_RELEASE_HELP = `Usage: takode lease release <resource> [--json]

Release an owned lease. If waiters exist, the first waiter is promoted and notified.
`;

export async function handleLease(args: string[], deps: TakodeLeaseDeps): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "acquire":
      await handleAcquire(args.slice(1), deps, false);
      return;
    case "wait":
      await handleAcquire(args.slice(1), deps, true);
      return;
    case "status":
    case "list":
      await handleStatus(args.slice(1), deps);
      return;
    case "renew":
    case "heartbeat":
      await handleRenew(args.slice(1), deps);
      return;
    case "release":
      await handleRelease(args.slice(1), deps);
      return;
    default:
      deps.err(LEASE_HELP);
  }
}

async function handleAcquire(args: string[], deps: TakodeLeaseDeps, waitByDefault: boolean): Promise<void> {
  const resource = firstPositional(args);
  if (!resource) deps.err(waitByDefault ? LEASE_WAIT_HELP : LEASE_ACQUIRE_HELP);
  const flags = parseFlags(args.slice(1));
  assertKnownFlags(
    flags,
    new Set(["purpose", "ttl", "quest", "metadata", "wait", "json"]),
    waitByDefault ? LEASE_WAIT_HELP : LEASE_ACQUIRE_HELP,
    deps,
  );
  const purpose = stringFlag(flags, "purpose");
  if (!purpose) deps.err(`--purpose is required\n${waitByDefault ? LEASE_WAIT_HELP : LEASE_ACQUIRE_HELP}`);
  const payload: Record<string, unknown> = {
    purpose,
    metadata: parseMetadata(args, deps),
  };
  const ttl = stringFlag(flags, "ttl");
  if (ttl) payload.ttlMs = parseDuration(ttl);
  const quest = stringFlag(flags, "quest");
  if (quest) payload.questId = quest;
  if (waitByDefault || flags.wait === true) payload.wait = true;

  const path = `/resource-leases/${encodeURIComponent(resource)}/${waitByDefault ? "wait" : "acquire"}`;
  const response = (await deps.apiPost(path, payload)) as { result: AcquireResult };
  const jsonMode = flags.json === true;
  if (jsonMode) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  printAcquireResult(response.result, deps);
}

async function handleStatus(args: string[], deps: TakodeLeaseDeps): Promise<void> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, new Set(["json"]), LEASE_STATUS_HELP, deps);
  const resource = firstPositional(args);
  const response = resource
    ? ((await deps.apiGet(`/resource-leases/${encodeURIComponent(resource)}`)) as { resource: LeaseStatusDetail })
    : ((await deps.apiGet("/resource-leases")) as { resources: LeaseStatusDetail[] });
  if (flags.json === true) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  const statuses = "resource" in response ? [response.resource] : response.resources;
  if (statuses.length === 0) {
    console.log("No active resource leases or waiters.");
    return;
  }
  printStatuses(statuses, deps);
}

async function handleRenew(args: string[], deps: TakodeLeaseDeps): Promise<void> {
  const resource = firstPositional(args);
  if (!resource) deps.err(LEASE_RENEW_HELP);
  const flags = parseFlags(args.slice(1));
  assertKnownFlags(flags, new Set(["ttl", "json"]), LEASE_RENEW_HELP, deps);
  const payload: Record<string, unknown> = {};
  const ttl = stringFlag(flags, "ttl");
  if (ttl) payload.ttlMs = parseDuration(ttl);
  const response = (await deps.apiPost(`/resource-leases/${encodeURIComponent(resource)}/renew`, payload)) as {
    lease: LeaseDetail;
  };
  if (flags.json === true) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  console.log(
    `Renewed ${response.lease.resourceKey}; expires ${deps.formatTimestampCompact(response.lease.expiresAt)}.`,
  );
}

async function handleRelease(args: string[], deps: TakodeLeaseDeps): Promise<void> {
  const resource = firstPositional(args);
  if (!resource) deps.err(LEASE_RELEASE_HELP);
  const flags = parseFlags(args.slice(1));
  assertKnownFlags(flags, new Set(["json"]), LEASE_RELEASE_HELP, deps);
  const response = (await deps.apiPost(`/resource-leases/${encodeURIComponent(resource)}/release`, {})) as {
    result: { released: LeaseDetail; promoted: LeaseDetail | null; waiters: WaiterDetail[] };
  };
  if (flags.json === true) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  const promoted = response.result.promoted ? ` Promoted ${response.result.promoted.ownerSessionId}.` : "";
  console.log(`Released ${response.result.released.resourceKey}.${promoted}`);
}

function printAcquireResult(result: AcquireResult, deps: TakodeLeaseDeps): void {
  if (result.status === "queued") {
    console.log(
      `Queued for ${result.waiter.resourceKey} at position ${result.position}; current owner ${result.lease.ownerSessionId}.`,
    );
    return;
  }
  if (result.status === "unavailable") {
    console.log(`Unavailable: ${result.lease.resourceKey} is held by ${result.lease.ownerSessionId}.`);
    if (result.waiters.length) console.log(`Waiters: ${result.waiters.length}`);
    return;
  }
  const label = result.status === "already_owned" ? "Already holding" : "Acquired";
  console.log(`${label} ${result.lease.resourceKey}; expires ${deps.formatTimestampCompact(result.lease.expiresAt)}.`);
}

function printStatuses(statuses: LeaseStatusDetail[], deps: TakodeLeaseDeps): void {
  for (const status of statuses) {
    if (!status.lease) {
      console.log(`${status.resourceKey}: available`);
    } else {
      console.log(
        `${status.resourceKey}: held by ${status.lease.ownerSessionId} until ${deps.formatTimestampCompact(
          status.lease.expiresAt,
        )}`,
      );
      console.log(`  purpose: ${deps.formatInlineText(status.lease.purpose)}`);
      if (status.lease.questId) console.log(`  quest: ${status.lease.questId}`);
      const metadata = formatMetadata(status.lease.metadata);
      if (metadata) console.log(`  metadata: ${metadata}`);
    }
    if (status.waiters.length > 0) {
      console.log(`  waiters: ${status.waiters.length}`);
      for (const waiter of status.waiters) {
        console.log(`    ${waiter.id}: ${waiter.waiterSessionId} -- ${deps.formatInlineText(waiter.purpose)}`);
      }
    }
  }
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function assertKnownFlags(
  flags: Record<string, string | boolean>,
  allowed: Set<string>,
  usage: string,
  deps: TakodeLeaseDeps,
): void {
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length > 0) deps.err(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}\n${usage}`);
}

function firstPositional(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("--"));
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseMetadata(args: string[], deps: TakodeLeaseDeps): Record<string, string> {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--metadata") continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) deps.err("--metadata requires k=v");
    values.push(value);
    i++;
  }
  const metadata: Record<string, string> = {};
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const index = part.indexOf("=");
      if (index <= 0) deps.err(`Invalid --metadata value "${part}". Use k=v.`);
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key && value) metadata[key] = value;
    }
  }
  return metadata;
}

function formatMetadata(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}
