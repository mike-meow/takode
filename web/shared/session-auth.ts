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

export function getSessionAuthFilePrefix(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
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
