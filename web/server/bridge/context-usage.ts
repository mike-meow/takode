import type { CLIResultMessage, SessionState } from "../session-types.js";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function inferContextWindowFromModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const normalized = model.toLowerCase();
  if (normalized.includes("[1m]") || normalized.includes("context-1m")) {
    return 1_000_000;
  }
  if (normalized.startsWith("claude-")) {
    return 200_000;
  }
  return undefined;
}

export function resolveResultContextWindow(
  model: string | undefined,
  modelUsage: CLIResultMessage["modelUsage"] | undefined,
): number | undefined {
  let fromUsage = 0;
  if (modelUsage) {
    for (const usage of Object.values(modelUsage)) {
      if (usage.contextWindow > 0) {
        fromUsage = Math.max(fromUsage, usage.contextWindow);
      }
    }
  }
  const fromModel = inferContextWindowFromModel(model) ?? 0;
  const resolved = Math.max(fromUsage, fromModel);
  return resolved > 0 ? resolved : undefined;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function computeContextUsedPercent(usage: TokenUsage, contextWindow: number): number | undefined {
  const inputTokens = Number(usage.input_tokens || 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const totalCache = cacheCreation + cacheRead;

  let usedInContext: number;
  if (totalCache > 0 && totalCache <= inputTokens) {
    usedInContext = inputTokens;
  } else {
    usedInContext = inputTokens + totalCache;
  }
  if (usedInContext <= 0) return undefined;

  const pct = Math.round((usedInContext / contextWindow) * 100);
  return clampPercent(pct);
}

export function computeResultContextUsedPercent(
  model: string | undefined,
  msg: CLIResultMessage,
  lastAssistantUsage: TokenUsage | undefined,
): number | undefined {
  const contextWindow = resolveResultContextWindow(model, msg.modelUsage);
  if (!contextWindow) return undefined;

  if (lastAssistantUsage) {
    const pct = computeContextUsedPercent(lastAssistantUsage, contextWindow);
    if (pct != null) return pct;
  }

  if (!msg.usage) return undefined;
  const fallbackInput = Number(msg.usage.input_tokens || 0);
  if (fallbackInput > contextWindow) return undefined;
  return computeContextUsedPercent(msg.usage, contextWindow);
}

export function extractClaudeTokenDetails(
  modelUsage: CLIResultMessage["modelUsage"],
): SessionState["claude_token_details"] | undefined {
  if (!modelUsage) return undefined;
  const usage = Object.values(modelUsage).find((entry) => entry && typeof entry === "object");
  if (!usage) return undefined;

  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const cachedInputTokens = Number(usage.cacheReadInputTokens || 0) + Number(usage.cacheCreationInputTokens || 0);
  const modelContextWindow = Number(usage.contextWindow || 0);

  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0 && modelContextWindow <= 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    modelContextWindow,
  };
}
