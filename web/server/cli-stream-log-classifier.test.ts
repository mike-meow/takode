import { describe, expect, it } from "vitest";
import {
  classifyCliStreamLogLevel,
  isCodexRefreshTokenReusedNoise,
  maybeFormatCodexTokenRefreshLogLine,
  type CodexTokenRefreshNoiseState,
} from "./cli-stream-log-classifier.js";

describe("CLI stream log classification", () => {
  it("classifies known Codex wrapper diagnostics as info", () => {
    // Wrapper launch diagnostics are expected stderr chatter, not session failures.
    expect(classifyCliStreamLogLevel("stderr", "[mai-codex-wrapper] execing codex_bin=/opt/homebrew/bin/codex\n")).toBe(
      "info",
    );
  });

  it("classifies known Codex refresh-token reuse noise as warn", () => {
    // Token reuse is still worth surfacing, but it should not flood ERROR logs when
    // sessions continue running with fresh shared auth.
    const line =
      "\u001b[31mERROR\u001b[0m codex_login::auth::manager: Failed to refresh token: " +
      "Your access token could not be refreshed because your refresh token was already used.";

    expect(isCodexRefreshTokenReusedNoise(line)).toBe(true);
    expect(classifyCliStreamLogLevel("stderr", line)).toBe("warn");
  });

  it("classifies multiline Codex refresh-token reuse JSON blocks as warn", () => {
    // Live Codex stderr can split the actionable-looking auth-manager prefix
    // from the refresh_token_reused code across JSON continuation lines.
    const chunk = [
      "\u001b[2m2026-04-29T00:01:30.944029Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_login::auth::manager\u001b[0m\u001b[2m:\u001b[0m Failed to refresh token: 401 Unauthorized: {",
      '  "error": {',
      '    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",',
      '    "type": "invalid_request_error",',
      '    "param": null,',
      '    "code": "refresh_token_reused"',
      "  }",
      "}",
    ].join("\n");

    expect(isCodexRefreshTokenReusedNoise(chunk)).toBe(true);
    expect(classifyCliStreamLogLevel("stderr", chunk)).toBe("warn");
  });

  it("classifies chunks containing multiple refresh-token reuse records as warn", () => {
    // Bun stream chunks can contain more than one complete Codex stderr record.
    const chunk = [
      "2026-04-29T00:02:11.754143Z ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: {",
      '  "error": {',
      '    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",',
      '    "type": "invalid_request_error",',
      '    "param": null,',
      '    "code": "refresh_token_reused"',
      "  }",
      "}",
      "2026-04-29T00:02:11.754166Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      "2026-04-29T00:02:11.754210Z ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: {",
      '  "error": {',
      '    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",',
      '    "type": "invalid_request_error",',
      '    "param": null,',
      '    "code": "refresh_token_reused"',
      "  }",
      "}",
    ].join("\n");

    expect(isCodexRefreshTokenReusedNoise(chunk)).toBe(true);
    expect(classifyCliStreamLogLevel("stderr", chunk)).toBe("warn");
  });

  it("keeps auth-degraded feature failures as errors", () => {
    // Feature failures from expired auth remain actionable and should stay ERROR.
    const line =
      "ERROR rmcp::transport::worker: worker quit with fatal: Provided authentication token is expired. Please try signing in again.";

    expect(classifyCliStreamLogLevel("stderr", line)).toBe("error");
  });

  it("does not demote mixed stderr chunks that include an actionable failure", () => {
    // Stream chunks can contain more than one line, so a real failure must win
    // over adjacent known refresh-token noise in the same decoded chunk.
    const chunk = [
      "codex_login::auth::manager: Failed to refresh token: refresh token was already used",
      "ERROR rmcp::transport::worker: worker quit with fatal: Provided authentication token is expired.",
    ].join("\n");

    expect(classifyCliStreamLogLevel("stderr", chunk)).toBe("error");
  });

  it("does not demote multiline refresh-token reuse chunks that include token_expired", () => {
    // The refresh-token reuse is noisy, but nearby MCP/app auth failures are real
    // degraded feature state and must remain visible as ERROR.
    const chunk = [
      "2026-04-29T00:02:12.177672Z ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: {",
      '  "error": {',
      '    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",',
      '    "type": "invalid_request_error",',
      '    "param": null,',
      '    "code": "refresh_token_reused"',
      "  }",
      "}",
      '2026-04-29T00:02:12.393367Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("text/plain; body: {\\n  \\"error\\": {\\n    \\"message\\": \\"Provided authentication token is expired. Please try signing in again.\\",\\n    \\"type\\": null,\\n    \\"code\\": \\"token_expired\\",\\n    \\"param\\": null\\n  },\\n  \\"status\\": 401\\n}"))',
    ].join("\n");

    expect(isCodexRefreshTokenReusedNoise(chunk)).toBe(false);
    expect(classifyCliStreamLogLevel("stderr", chunk)).toBe("error");
  });

  it("keeps codex_apps startup failures as errors", () => {
    const line =
      'WARN codex-adapter MCP server "codex_apps" startup failed for session c910f457: Provided authentication token is expired.';

    expect(classifyCliStreamLogLevel("stderr", line)).toBe("error");
  });

  it("rate-limits repeated Codex refresh-token reuse lines per session", () => {
    // Repeated refresh noise is summarized per session so one noisy process cannot
    // dominate the server log tail.
    const state = new Map<string, CodexTokenRefreshNoiseState>();

    expect(maybeFormatCodexTokenRefreshLogLine(state, "s1", "first", 1_000, 60_000)).toBe("first");
    expect(maybeFormatCodexTokenRefreshLogLine(state, "s1", "second", 2_000, 60_000)).toBeNull();
    expect(maybeFormatCodexTokenRefreshLogLine(state, "s1", "third", 3_000, 60_000)).toBeNull();
    expect(maybeFormatCodexTokenRefreshLogLine(state, "s1", "later", 62_000, 60_000)).toBe(
      "[suppressed 2 repeated Codex token refresh stderr line(s)] later",
    );
  });
});
