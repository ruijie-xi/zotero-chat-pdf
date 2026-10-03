import type { LLMSettings } from "./llm-client";

export interface GenerationPolicy {
  /** Total generation, including provider reasoning; not a visible-text target. */
  outputTokens: number;
  retryCeiling: number;
  source: "user" | "model-maximum";
  thinkingMode: string;
  thinkEffort: string;
}

export function isOfficialDeepSeek(settings: Pick<LLMSettings, "apiBase" | "model">): boolean {
  return new URL(settings.apiBase).hostname === "api.deepseek.com"
    && ["deepseek-flash", "deepseek-pro", "deepseek-v4-pro", "deepseek-v4-pro-0813",
      "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(settings.model);
}

/** Resolve generation independently of input space. Automatic mode reserves the
 * resolved model maximum, without imposing a lower plugin or provider default.
 * Explicit user ceilings remain authoritative for every request and retry.
 */
export function resolveGenerationPolicy(settings: LLMSettings, maxOutput: number): GenerationPolicy {
  const configured = Number(settings.requestedOutputTokens ?? 0);
  if (!Number.isSafeInteger(configured) || configured < 0 || configured > maxOutput) {
    throw new Error("The requested generation limit must be a whole number between 1 and the model maximum, or 0 for automatic.");
  }
  const thinkingMode = settings.thinkingMode || "default";
  const thinkEffort = settings.thinkEffort || "default";
  if (configured) return { outputTokens: configured, retryCeiling: configured, source: "user", thinkingMode, thinkEffort };
  return { outputTokens: maxOutput, retryCeiling: maxOutput,
    source: "model-maximum", thinkingMode, thinkEffort };
}
