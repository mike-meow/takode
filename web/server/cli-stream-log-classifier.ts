export type CliStreamLogLevel = "info" | "warn" | "error";

export interface CodexTokenRefreshNoiseState {
  lastEmittedAt: number;
  suppressed: number;
}

export const CODEX_TOKEN_REFRESH_SUPPRESSION_MS = 60_000;

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const CODEX_REFRESH_TOKEN_REUSE_PATTERNS = [
  "refresh_token_reused",
  "refresh token was already used",
  "refresh token has already been used",
] as const;

const CODEX_ACTIONABLE_AUTH_FAILURE_PATTERNS = [
  "token_expired",
  "rmcp::transport::worker",
  "codex_apps",
  "mcp server",
] as const;

export function classifyCliStreamLogLevel(label: "stdout" | "stderr", text: string): CliStreamLogLevel {
  if (label === "stdout") return "info";
  if (isMaiCodexWrapperDiagnostic(text)) return "info";
  if (isCodexRefreshTokenReusedNoise(text)) return "warn";
  if (isCodexApplyPatchVerificationFailure(text)) return "warn";
  return "error";
}

export function isCodexRefreshTokenReusedNoise(text: string): boolean {
  const lines = normalizedLines(text);
  if (lines.length === 0) return false;
  if (lines.some(isCodexActionableAuthFailureLine)) return false;

  let hasActiveRecord = false;
  let activeRecordHasRefreshReuse = false;

  for (const line of lines) {
    if (isCodexRefreshTokenFailureHeaderLine(line)) {
      if (hasActiveRecord && !activeRecordHasRefreshReuse) return false;
      hasActiveRecord = true;
      activeRecordHasRefreshReuse = hasCodexRefreshTokenReusePattern(line);
      continue;
    }

    if (!hasActiveRecord || !isCodexAuthRefreshJsonLine(line)) return false;
    if (hasCodexRefreshTokenReusePattern(line)) activeRecordHasRefreshReuse = true;
  }

  return hasActiveRecord && activeRecordHasRefreshReuse;
}

function isCodexRefreshTokenFailureHeaderLine(normalized: string): boolean {
  if (!normalized.includes("codex_login::auth::manager")) return false;
  if (!normalized.includes("failed to refresh token")) return false;
  return true;
}

function hasCodexRefreshTokenReusePattern(normalized: string): boolean {
  return CODEX_REFRESH_TOKEN_REUSE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isCodexActionableAuthFailureLine(normalized: string): boolean {
  return CODEX_ACTIONABLE_AUTH_FAILURE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isCodexAuthRefreshJsonLine(normalized: string): boolean {
  if (/^[{},]+$/.test(normalized)) return true;
  return /^"(error|message|type|param|code|status)"\s*:/.test(normalized);
}

function isCodexApplyPatchVerificationFailure(text: string): boolean {
  const lines = normalizedLines(text);
  if (lines.length === 0) return false;
  if (lines.some(isCodexActionableAuthFailureLine)) return false;

  let hasApplyPatchVerificationFailure = false;

  for (const line of lines) {
    if (!line.includes("codex_core::tools::router")) {
      if (!hasApplyPatchVerificationFailure || isLikelyStandaloneStderrRecord(line)) return false;
      continue;
    }
    if (line.includes("error=apply_patch verification failed")) {
      hasApplyPatchVerificationFailure = true;
      continue;
    }
    return false;
  }

  return hasApplyPatchVerificationFailure;
}

function isLikelyStandaloneStderrRecord(normalized: string): boolean {
  return /^(?:\d{4}-\d{2}-\d{2}t\S+\s+)?(?:error|warn|warning|fatal)\b/.test(normalized);
}

export function maybeFormatCodexTokenRefreshLogLine(
  stateBySession: Map<string, CodexTokenRefreshNoiseState>,
  sessionId: string,
  line: string,
  now = Date.now(),
  suppressMs = CODEX_TOKEN_REFRESH_SUPPRESSION_MS,
): string | null {
  const current = stateBySession.get(sessionId);
  if (!current || now - current.lastEmittedAt >= suppressMs) {
    const prefix =
      current && current.suppressed > 0
        ? `[suppressed ${current.suppressed} repeated Codex token refresh stderr line(s)] `
        : "";
    stateBySession.set(sessionId, { lastEmittedAt: now, suppressed: 0 });
    return `${prefix}${line}`;
  }

  current.suppressed++;
  return null;
}

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, "");
}

function normalizedLines(text: string): string[] {
  return stripAnsi(text)
    .toLowerCase()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isMaiCodexWrapperDiagnostic(text: string): boolean {
  const lines = normalizedLines(text);
  return lines.length > 0 && lines.every((line) => line.startsWith("[mai-codex-wrapper]"));
}
