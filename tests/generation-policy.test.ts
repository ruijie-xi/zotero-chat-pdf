import { describe, expect, it } from "vitest";
import { resolveGenerationPolicy } from "../src/modules/generation-policy";
import { buildChatCompletionBody, LLMSettings } from "../src/modules/llm-client";

const settings: LLMSettings = { apiBase: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-flash", thinkingMode: "default", thinkEffort: "default" };

describe("provider generation policy", () => {
  it.each([
    ["default", "default", 393216], ["enabled", "high", 393216],
    ["default", "max", 393216], ["enabled", "max", 393216],
    ["disabled", "default", 393216], ["disabled", "max", 393216],
  ] as const)("resolves DeepSeek %s/%s before reserving input space", (thinkingMode, thinkEffort, expected) => {
    const configured = { ...settings, thinkingMode, thinkEffort };
    expect(resolveGenerationPolicy(configured, 393216)).toMatchObject({ outputTokens: expected, retryCeiling: 393216, source: "model-maximum" });
    const body = buildChatCompletionBody(configured, [], { stream: true });
    if (thinkingMode === "disabled") expect(body.reasoning_effort).toBeUndefined();
  });

  it("honors manual ceilings across modes and never silently clamps an invalid override", () => {
    expect(resolveGenerationPolicy({ ...settings, thinkEffort: "max", requestedOutputTokens: 20000 }, 393216))
      .toMatchObject({ outputTokens: 20000, retryCeiling: 20000, source: "user" });
    for (const value of [-1, 1.5, Infinity, 393217]) {
      expect(() => resolveGenerationPolicy({ ...settings, requestedOutputTokens: value }, 393216)).toThrow("generation limit");
    }
    expect(resolveGenerationPolicy(settings, 32768).outputTokens).toBe(32768);
  });

  it("uses the resolved maximum for custom models without imposing a provider default", () => {
    for (const custom of [{ ...settings, apiBase: "https://proxy.example/v1" }, { ...settings, model: "unknown-model" }]) {
      expect(resolveGenerationPolicy(custom, 393216)).toMatchObject({ outputTokens: 393216, retryCeiling: 393216, source: "model-maximum" });
      expect(resolveGenerationPolicy({ ...custom, requestedOutputTokens: 20000 }, 393216).source).toBe("user");
    }
    expect(resolveGenerationPolicy({ ...settings, model: "deepseek-v4-pro", thinkEffort: "max" }, 393216).outputTokens).toBe(393216);
  });
});
