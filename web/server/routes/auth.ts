import type { Context } from "hono";
import type { CliLauncher } from "../cli-launcher.js";

export const COMPANION_SESSION_ID_HEADER = "x-companion-session-id";
export const COMPANION_AUTH_TOKEN_HEADER = "x-companion-auth-token";
export const COMPANION_CLIENT_IP_HEADER = "x-companion-client-ip";

export type AuthCaller = {
  callerId: string;
  caller: NonNullable<ReturnType<CliLauncher["getSession"]>>;
};

export type AuthResult = AuthCaller | { response: Response };

/**
 * Shared auth-header contract validator used by Takode and Companion routes.
 * When `required` is false, returns null if neither header is present.
 */
export function validateCompanionAuth(
  c: Context,
  launcher: CliLauncher,
  resolveId: (raw: string) => string | null,
  options?: {
    required?: boolean;
    requireOrchestrator?: boolean;
    headerLabel?: "Takode" | "Companion";
  },
): AuthResult | null {
  const required = options?.required ?? false;
  const headerLabel = options?.headerLabel ?? "Companion";

  const rawCallerId = c.req.header(COMPANION_SESSION_ID_HEADER)?.trim();
  const authToken = c.req.header(COMPANION_AUTH_TOKEN_HEADER)?.trim();

  if (!rawCallerId && !authToken && !required) return null;

  if (!rawCallerId || !authToken) {
    return { response: c.json({ error: `Missing ${headerLabel} auth headers` }, 403) };
  }

  const callerId = resolveId(rawCallerId);
  if (!callerId) {
    return { response: c.json({ error: "Caller session not found" }, 403) };
  }

  const caller = launcher.getSession(callerId);
  if (!caller) {
    return { response: c.json({ error: "Caller session not found" }, 403) };
  }

  if (!launcher.verifySessionAuthToken(callerId, authToken)) {
    return { response: c.json({ error: `Invalid ${headerLabel} auth token` }, 403) };
  }

  if (options?.requireOrchestrator && !caller.isOrchestrator) {
    return { response: c.json({ error: "Caller is not an orchestrator session" }, 403) };
  }

  return { callerId, caller };
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "localhost"
  );
}
