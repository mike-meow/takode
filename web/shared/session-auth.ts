import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SessionAuthFileData = {
  sessionId: string;
  authToken: string;
  port?: number;
  serverId?: string;
};

export function getSessionAuthDir(homeDir = homedir()): string {
  return join(homeDir, ".companion", "session-auth");
}

function hashCwdForSessionAuth(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function normalizeSessionAuthCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  if (process.platform !== "darwin") return resolvedCwd;

  // Bun on macOS can surface temp/worktree paths with or without a /private
  // prefix. Normalize those aliases so session-auth filenames stay stable
  // across the server and child CLI processes.
  if (resolvedCwd === "/private/tmp" || resolvedCwd.startsWith("/private/tmp/")) {
    return resolvedCwd.slice("/private".length);
  }
  if (resolvedCwd === "/private/var" || resolvedCwd.startsWith("/private/var/")) {
    return resolvedCwd.slice("/private".length);
  }
  return resolvedCwd;
}

function getSessionAuthAliasCwd(cwd: string): string | null {
  if (process.platform !== "darwin") return null;
  if (cwd === "/tmp" || cwd.startsWith("/tmp/")) return `/private${cwd}`;
  if (cwd === "/var" || cwd.startsWith("/var/")) return `/private${cwd}`;
  return null;
}

export function getSessionAuthFilePrefixes(cwd: string): string[] {
  const canonicalCwd = normalizeSessionAuthCwd(cwd);
  const variants = [canonicalCwd];
  const aliasCwd = getSessionAuthAliasCwd(canonicalCwd);
  if (aliasCwd) variants.push(aliasCwd);

  const seen = new Set<string>();
  const prefixes: string[] = [];
  for (const variant of variants) {
    const prefix = hashCwdForSessionAuth(variant);
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    prefixes.push(prefix);
  }
  return prefixes;
}

export function getSessionAuthFilePrefix(cwd: string): string {
  return getSessionAuthFilePrefixes(cwd)[0];
}

export function getSessionAuthPath(
  cwd: string,
  serverId: string,
  homeDir = homedir(),
): string {
  return join(getSessionAuthDir(homeDir), `${getSessionAuthFilePrefix(cwd)}-${serverId}.json`);
}

export function getLegacySessionAuthPath(cwd: string, homeDir = homedir()): string {
  return join(getSessionAuthDir(homeDir), `${getSessionAuthFilePrefix(cwd)}.json`);
}

export function parseSessionAuthFileData(raw: unknown): SessionAuthFileData | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.sessionId !== "string" || !data.sessionId.trim()) return null;
  if (typeof data.authToken !== "string" || !data.authToken.trim()) return null;

  const parsedPort = typeof data.port === "number" ? data.port : Number(data.port);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined;
  const serverId = typeof data.serverId === "string" && data.serverId.trim()
    ? data.serverId
    : undefined;

  return {
    sessionId: data.sessionId,
    authToken: data.authToken,
    ...(port ? { port } : {}),
    ...(serverId ? { serverId } : {}),
  };
}
