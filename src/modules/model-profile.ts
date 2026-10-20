import type { LLMProvider } from "./llm-provider";

/** Model limits belong to an endpoint/model profile, never to a document. */
export interface ModelBudgetSettings {
  contextWindowTokens?: number;
  inputTokenLimit?: number;
  maxOutputTokens?: number;
  requestedOutputTokens?: number;
  tokenizerMode?: string;
  imageTokenReserve?: number;
  /** auto reads endpoint metadata; enabled is an explicit user confirmation. */
  visionSupport?: string;
}

export interface ModelProfile extends ModelBudgetSettings {
  name: string;
  /** Missing in legacy profiles; those keep the custom endpoint behavior. */
  provider?: LLMProvider;
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingMode?: string;
  thinkEffort?: string;
}

export const MODEL_BUDGET_FIELDS = ["contextWindowTokens", "inputTokenLimit", "maxOutputTokens", "requestedOutputTokens", "imageTokenReserve"] as const;
