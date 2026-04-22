import { describe, expect, it, vi } from "vitest";
import { handlePermissionResponse, type PermissionResponseSessionLike } from "./permission-response-controller.js";
import type { PermissionRequest } from "../session-types.js";

function makeSession(): PermissionResponseSessionLike {
  return {
    id: "s1",
    pendingPermissions: new Map<string, PermissionRequest>(),
    messageHistory: [],
    state: { askPermission: true },
  };
}

function makeDeps() {
  return {
    onSessionActivityStateChanged: vi.fn(),
    abortAutoApproval: vi.fn(),
    cancelPermissionNotification: vi.fn(),
    clearActionAttentionIfNoPermissions: vi.fn(),
    sendToCLI: vi.fn(),
    handleSetPermissionMode: vi.fn(),
    getApprovalSummary: vi.fn(() => "approved"),
    getDenialSummary: vi.fn(() => "denied"),
    broadcastToBrowsers: vi.fn(),
    emitTakodePermissionResolved: vi.fn(),
    setGeneratingRunningAfterExitPlanMode: vi.fn(),
    handleInterrupt: vi.fn(),
    persistSession: vi.fn(),
  };
}

describe("permission-response-controller", () => {
  // ExitPlanMode approval is special: besides recording the approval message,
  // it must transition the session back into an execution mode and resume running state.
  it("records a notable approval and triggers ExitPlanMode follow-up", () => {
    const session = makeSession();
    session.pendingPermissions.set("req-1", {
      request_id: "req-1",
      tool_name: "ExitPlanMode",
      input: {},
      tool_use_id: "tool-1",
      timestamp: 1,
    });
    const deps = makeDeps();

    handlePermissionResponse(
      session,
      {
        type: "permission_response",
        request_id: "req-1",
        behavior: "allow",
      },
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_approved" }));
    expect(deps.handleSetPermissionMode).toHaveBeenCalledWith(session, "acceptEdits");
    expect(deps.setGeneratingRunningAfterExitPlanMode).toHaveBeenCalledWith(session);
  });

  // ExitPlanMode denial should leave an explicit denial record and interrupt the turn,
  // rather than silently swallowing the rejection.
  it("records a denial and interrupts ExitPlanMode turns", () => {
    const session = makeSession();
    session.pendingPermissions.set("req-2", {
      request_id: "req-2",
      tool_name: "ExitPlanMode",
      input: {},
      tool_use_id: "tool-2",
      timestamp: 1,
    });
    const deps = makeDeps();

    handlePermissionResponse(
      session,
      {
        type: "permission_response",
        request_id: "req-2",
        behavior: "deny",
      },
      deps,
      "actor-1",
    );

    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));
    expect(deps.handleInterrupt).toHaveBeenCalledWith(session, "actor-1");
    expect(deps.emitTakodePermissionResolved).toHaveBeenCalledWith("s1", "ExitPlanMode", "denied", "actor-1");
  });
});
