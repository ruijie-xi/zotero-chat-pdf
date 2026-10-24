import { describe, expect, it } from "vitest";
import { resolveGenerationPolicy } from "../src/modules/generation-policy";
import type { LLMSettings } from "../src/modules/llm-client";

const settings: LLMSettings = { apiBase: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-flash", thinkingMode: "default", thinkEffort: "default" };

describe("provider generation policy", () => {
  it("rejects invalid generation limits instead of silently clamping them", () => {
    for (const value of [-1, 1.5, Infinity, 393217]) {
      expect(() => resolveGenerationPolicy({ ...settings, requestedOutputTokens: value }, 393216)).toThrow("generation limit");
    }
  });
});
