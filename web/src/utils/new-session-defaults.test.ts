// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { scopedSetItem } from "./scoped-storage.js";
import {
  getGlobalNewSessionDefaults,
  getGroupNewSessionDefaults,
  saveGroupNewSessionDefaults,
} from "./new-session-defaults.js";

describe("new-session-defaults", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cc-server-id", "test-server");
  });

  it("reads the existing global create-session defaults from scoped storage", () => {
    scopedSetItem("cc-backend", "codex");
    scopedSetItem("cc-model-codex", "gpt-5.4");
    scopedSetItem("cc-mode", "agent");
    scopedSetItem("cc-ask-permission", "false");
    scopedSetItem("cc-selected-env", "prod");
    scopedSetItem("cc-worktree", "false");
    scopedSetItem("cc-codex-internet-access", "1");
    scopedSetItem("cc-codex-reasoning-effort", "high");

    expect(getGlobalNewSessionDefaults()).toEqual({
      backend: "codex",
      model: "gpt-5.4",
      mode: "agent",
      askPermission: false,
      envSlug: "prod",
      useWorktree: false,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });
  });

  it("falls back to the global defaults when a group has no saved config", () => {
    scopedSetItem("cc-backend", "claude");
    scopedSetItem("cc-model-claude", "claude-opus-4-6");
    scopedSetItem("cc-worktree", "false");

    expect(getGroupNewSessionDefaults("/repo-a")).toEqual({
      backend: "claude",
      model: "claude-opus-4-6",
      mode: "agent",
      askPermission: true,
      envSlug: "",
      useWorktree: false,
      codexInternetAccess: false,
      codexReasoningEffort: "",
    });
  });

  it("returns the per-group defaults without disturbing the global defaults", () => {
    scopedSetItem("cc-backend", "claude");
    scopedSetItem("cc-model-claude", "claude-opus-4-6");

    saveGroupNewSessionDefaults("/repo-a", {
      backend: "codex",
      model: "gpt-5.4",
      mode: "agent",
      askPermission: false,
      envSlug: "sandbox",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "medium",
    });

    expect(getGroupNewSessionDefaults("/repo-a")).toEqual({
      backend: "codex",
      model: "gpt-5.4",
      mode: "agent",
      askPermission: false,
      envSlug: "sandbox",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "medium",
    });

    expect(getGlobalNewSessionDefaults()).toEqual({
      backend: "claude",
      model: "claude-opus-4-6",
      mode: "agent",
      askPermission: true,
      envSlug: "",
      useWorktree: true,
      codexInternetAccess: false,
      codexReasoningEffort: "",
    });
  });

  it("normalizes legacy codex permission modes when reading saved defaults", () => {
    scopedSetItem("cc-backend", "codex");
    scopedSetItem("cc-mode", "bypassPermissions");

    expect(getGlobalNewSessionDefaults()).toMatchObject({
      backend: "codex",
      mode: "agent",
      askPermission: false,
    });
  });
});
