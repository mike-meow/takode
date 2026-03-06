import { describe, it, expect } from "vitest";
import {
  toModelOptions,
  getModelsForBackend,
  getModesForBackend,
  getDefaultModel,
  getDefaultMode,
  resolveClaudeCliMode,
  resolvePostPlanMode,
  deriveUiMode,
  resolveCodexCliMode,
  deriveCodexUiMode,
  deriveCodexAskPermission,
  CLAUDE_MODELS,
  CODEX_MODELS,
  CLAUDE_MODES,
  CODEX_MODES,
} from "./backends.js";

describe("toModelOptions", () => {
  it("converts server model info to frontend ModelOption with icons", () => {
    const models = [
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", description: "Codex model" },
      { value: "gpt-5-mini", label: "GPT-5 Mini", description: "Fast" },
    ];

    const options = toModelOptions(models);

    expect(options).toHaveLength(2);
    expect(options[0].value).toBe("gpt-5.3-codex");
    expect(options[0].label).toBe("GPT-5.3 Codex");
    expect(options[0].icon).toBeTruthy();
    expect(options[1].value).toBe("gpt-5-mini");
  });

  it("assigns codex icon to codex-containing slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", description: "" },
    ]);
    expect(options[0].icon).toBe("\u2733"); // ✳
  });

  it("assigns max icon to max-containing slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.4-codex-max", label: "GPT-5.4 Max", description: "" },
    ]);
    // "codex" appears before "max" in the slug, so codex icon wins
    expect(options[0].icon).toBe("\u2733");
  });

  it("assigns mini icon to mini-only slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "" },
    ]);
    expect(options[0].icon).toBe("\u26A1"); // ⚡
  });

  it("uses fallback icon for generic model slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.4", label: "GPT-5.4", description: "" },
    ]);
    // Should use one of the fallback icons
    expect(options[0].icon).toBeTruthy();
    expect(options[0].icon.length).toBeGreaterThan(0);
  });

  it("uses value as label when label is empty", () => {
    const options = toModelOptions([
      { value: "some-model", label: "", description: "" },
    ]);
    expect(options[0].label).toBe("some-model");
  });

  it("handles empty array", () => {
    expect(toModelOptions([])).toEqual([]);
  });
});

describe("getModelsForBackend", () => {
  it("returns claude models for claude backend", () => {
    expect(getModelsForBackend("claude")).toBe(CLAUDE_MODELS);
  });

  it("returns codex models for codex backend", () => {
    expect(getModelsForBackend("codex")).toBe(CODEX_MODELS);
  });
});

describe("getModesForBackend", () => {
  it("returns claude modes for claude backend", () => {
    expect(getModesForBackend("claude")).toBe(CLAUDE_MODES);
  });

  it("returns codex modes for codex backend", () => {
    expect(getModesForBackend("codex")).toBe(CODEX_MODES);
  });
});

describe("getDefaultModel", () => {
  it("returns first claude model for claude backend", () => {
    expect(getDefaultModel("claude")).toBe(CLAUDE_MODELS[0].value);
  });

  it("returns first codex model for codex backend", () => {
    expect(getDefaultModel("codex")).toBe(CODEX_MODELS[0].value);
  });
});

describe("getDefaultMode", () => {
  it("returns first claude mode for claude backend", () => {
    expect(getDefaultMode("claude")).toBe(CLAUDE_MODES[0].value);
  });

  it("returns first codex mode for codex backend", () => {
    expect(getDefaultMode("codex")).toBe(CODEX_MODES[0].value);
  });
});

describe("static model/mode lists", () => {
  it("has codex models with GPT-5.x slugs", () => {
    for (const m of CODEX_MODELS) {
      expect(m.value).toMatch(/^gpt-5/);
    }
  });

  it("has claude models with claude- prefix (except Default which is empty)", () => {
    for (const m of CLAUDE_MODELS) {
      if (m.value === "") continue; // "Default" uses CLI's own setting
      expect(m.value).toMatch(/^claude-/);
    }
  });

  it("has at least 2 modes for each backend", () => {
    expect(CLAUDE_MODES.length).toBeGreaterThanOrEqual(2);
    expect(CODEX_MODES.length).toBeGreaterThanOrEqual(2);
  });

  it("codex plan mode label is explicit in UI", () => {
    const codexPlan = CODEX_MODES.find((m) => m.value === "plan");
    expect(codexPlan?.label).toBe("Plan");
  });

  it("codex modes contain plan and agent virtual modes", () => {
    const values = CODEX_MODES.map((m) => m.value);
    expect(values).toContain("plan");
    expect(values).toContain("agent");
  });

  it("claude modes contain plan and agent virtual modes", () => {
    const values = CLAUDE_MODES.map((m) => m.value);
    expect(values).toContain("plan");
    expect(values).toContain("agent");
  });

  it("default claude mode is agent", () => {
    expect(getDefaultMode("claude")).toBe("agent");
  });
});

describe("resolveCodexCliMode", () => {
  it("plan mode resolves to 'plan' regardless of askPermission", () => {
    expect(resolveCodexCliMode("plan", true)).toBe("plan");
    expect(resolveCodexCliMode("plan", false)).toBe("plan");
  });

  it("agent mode with askPermission=true resolves to 'suggest'", () => {
    expect(resolveCodexCliMode("agent", true)).toBe("suggest");
  });

  it("agent mode with askPermission=false resolves to 'bypassPermissions'", () => {
    expect(resolveCodexCliMode("agent", false)).toBe("bypassPermissions");
  });
});

describe("deriveCodexUiMode", () => {
  it("maps 'plan' to plan UI mode", () => {
    expect(deriveCodexUiMode("plan")).toBe("plan");
  });

  it("maps execution modes to agent UI mode", () => {
    expect(deriveCodexUiMode("suggest")).toBe("agent");
    expect(deriveCodexUiMode("bypassPermissions")).toBe("agent");
    expect(deriveCodexUiMode("default")).toBe("agent");
  });
});

describe("deriveCodexAskPermission", () => {
  it("returns false only for bypassPermissions", () => {
    expect(deriveCodexAskPermission("bypassPermissions")).toBe(false);
    expect(deriveCodexAskPermission("suggest")).toBe(true);
    expect(deriveCodexAskPermission("plan")).toBe(true);
  });
});

// ─── Mode mapping helpers ─────────────────────────────────────────────────────

describe("resolveClaudeCliMode", () => {
  // Tests the mapping from UI mode + askPermission to actual CLI permission mode.
  // This is the core logic that translates the simplified UI into Claude Code CLI modes.

  it("plan mode always resolves to 'plan' regardless of askPermission", () => {
    expect(resolveClaudeCliMode("plan", true)).toBe("plan");
    expect(resolveClaudeCliMode("plan", false)).toBe("plan");
  });

  it("agent mode with askPermission=true resolves to 'acceptEdits'", () => {
    // User wants agent mode but still wants to be asked before tool execution
    expect(resolveClaudeCliMode("agent", true)).toBe("acceptEdits");
  });

  it("agent mode with askPermission=false resolves to 'bypassPermissions'", () => {
    // User wants full autonomous agent mode with no permission prompts
    expect(resolveClaudeCliMode("agent", false)).toBe("bypassPermissions");
  });
});

describe("resolvePostPlanMode", () => {
  // Tests the mode that should be set after a plan (ExitPlanMode) is approved.
  // After plan approval, the session should transition to an execution mode.

  it("askPermission=true transitions to 'acceptEdits' after plan approval", () => {
    // User wants to review tool use, so prompt for each tool after plan approval
    expect(resolvePostPlanMode(true)).toBe("acceptEdits");
  });

  it("askPermission=false transitions to 'bypassPermissions' after plan approval", () => {
    // User opted out of asking, so execute freely without per-tool prompts
    expect(resolvePostPlanMode(false)).toBe("bypassPermissions");
  });
});

describe("deriveUiMode", () => {
  // Tests reverse mapping from CLI mode back to UI concept (plan vs agent).

  it("'plan' CLI mode maps to 'plan' UI mode", () => {
    expect(deriveUiMode("plan")).toBe("plan");
  });

  it("'acceptEdits' CLI mode maps to 'agent' UI mode", () => {
    expect(deriveUiMode("acceptEdits")).toBe("agent");
  });

  it("'bypassPermissions' CLI mode maps to 'agent' UI mode", () => {
    expect(deriveUiMode("bypassPermissions")).toBe("agent");
  });

  it("'default' CLI mode (legacy) maps to 'agent' UI mode", () => {
    // Legacy mode from before this change should map to agent
    expect(deriveUiMode("default")).toBe("agent");
  });
});
