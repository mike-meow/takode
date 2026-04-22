import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

function extractMethods(tsSource: string): Set<string> {
  return new Set([...tsSource.matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]));
}

function extractCaseMethods(source: string, start: string, end: string): Set<string> {
  const afterStart = source.split(start)[1];
  if (!afterStart) return new Set();
  const block = afterStart.split(end)[0] || "";
  return new Set([...block.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
}

describe("Codex adapter method drift vs upstream protocol snapshot", () => {
  it("keeps handled methods aligned with the upstream protocol (or explicit legacy allowlist)", () => {
    const adapter = readFile("server/codex-adapter.ts");

    const handledNotifications = extractCaseMethods(
      adapter,
      "private handleNotification(method: string, params: Record<string, unknown>): void {",
      "private handleRequest(method: string, id: number, params: Record<string, unknown>): void {",
    );

    const handledRequests = extractCaseMethods(
      adapter,
      "private handleRequest(method: string, id: number, params: Record<string, unknown>): void {",
      "private handleCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {",
    );

    const calledClientMethods = new Set(
      [...adapter.matchAll(/this\.transport\.(?:call|notify)\("([^"]+)"/g)].map((m) => m[1]),
    );

    const upstreamServerNotifications = extractMethods(
      readFile("server/protocol/codex-upstream/ServerNotification.ts.txt"),
    );
    const upstreamServerRequests = extractMethods(readFile("server/protocol/codex-upstream/ServerRequest.ts.txt"));
    const upstreamClientRequests = extractMethods(readFile("server/protocol/codex-upstream/ClientRequest.ts.txt"));
    const upstreamClientNotifications = extractMethods(
      readFile("server/protocol/codex-upstream/ClientNotification.ts.txt"),
    );

    const legacyNotifications = new Set([
      "item/updated",
      "codex/event/stream_error",
      "codex/event/error",
      // Observed in live Codex sessions for apply_patch diff metadata but absent
      // from the pinned upstream snapshot in this repo.
      "codex/event/patch_apply_begin",
      "codex/event/patch_apply_end",
      // Observed in live Codex multi-agent sessions; used to synthesize the
      // final tool_result for spawned Agent cards.
      "codex/event/task_complete",
      // Observed in live Codex sessions for thread idle/active transitions.
      // Used to clear stale currentTurnId after CLI restart.
      "thread/status/changed",
      // Observed in newer live Codex app-server sessions when local skill files
      // change; the pinned snapshot in this repo predates that notification.
      "skills/changed",
      // Observed in live Codex app-server startup for optional MCP/app connector
      // status. Used to surface connector degradation without treating it as
      // Codex process failure.
      "mcpServer/startupStatus/updated",
    ]);

    const legacyServerRequests = new Set([
      "item/mcpToolCall/requestApproval",
      // Observed in live Codex sessions for the explicit server-side approval
      // downgrade path; the pinned upstream snapshot in this repo predates it.
      "bypassPermissions",
      // Observed in live Codex sessions for the standard interactive approval
      // path; the pinned upstream snapshot in this repo predates it too.
      "suggest",
      // The pinned snapshot predates the adapter's current approval-mode
      // compatibility mapping switch, which still needs to recognize these
      // legacy bridge-side mode strings.
      "plan",
      "acceptEdits",
      "default",
    ]);

    for (const method of handledNotifications) {
      expect(
        upstreamServerNotifications.has(method) || legacyNotifications.has(method),
        `Unhandled by upstream snapshot (notification): ${method}`,
      ).toBe(true);
    }

    for (const method of handledRequests) {
      expect(
        upstreamServerRequests.has(method) || legacyServerRequests.has(method),
        `Unhandled by upstream snapshot (server request): ${method}`,
      ).toBe(true);
    }

    for (const method of calledClientMethods) {
      expect(
        upstreamClientRequests.has(method) || upstreamClientNotifications.has(method),
        `Unhandled by upstream snapshot (client method): ${method}`,
      ).toBe(true);
    }
  });
});
