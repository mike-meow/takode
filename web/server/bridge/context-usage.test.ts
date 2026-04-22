import { describe, expect, it } from "vitest";
import { computeContextUsedPercent, computeResultContextUsedPercent, extractClaudeTokenDetails } from "./context-usage.js";

describe("context-usage helpers", () => {
  it("treats cache tokens as already included when they fit within input tokens", () => {
    // Copilot/OpenAI style accounting reports total prompt tokens in input_tokens,
    // so cache fields should not be added again.
    expect(
      computeContextUsedPercent(
        { input_tokens: 800, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
        1000,
      ),
    ).toBe(80);
  });

  it("falls back to result usage when assistant usage is zeroed out", () => {
    // Claude SDK can report zero usage on the assistant message while the result
    // carries the real per-turn numbers for the same request.
    expect(
      computeResultContextUsedPercent(
        undefined,
        {
          type: "result",
          subtype: "success",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "",
          session_id: "s",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          uuid: "u1",
          usage: {
            input_tokens: 1000,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          modelUsage: {
            claude: {
              inputTokens: 1000,
              outputTokens: 10,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              contextWindow: 2000,
              maxOutputTokens: 4096,
              costUSD: 0,
            },
          },
        },
        { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ),
    ).toBe(50);
  });

  it("extracts non-zero Claude token details", () => {
    // The bridge only forwards token details when at least one field carries
    // useful information, avoiding empty noise in session state.
    expect(
      extractClaudeTokenDetails({
        claude: {
          inputTokens: 12,
          outputTokens: 7,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          contextWindow: 200_000,
          maxOutputTokens: 4096,
          costUSD: 0,
        },
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cachedInputTokens: 5,
      modelContextWindow: 200_000,
    });
  });
});
