/** Model limits belong to an endpoint/model profile, never to a document. */
export interface ModelBudgetSettings {
  contextWindowTokens?: number;
  inputTokenLimit?: number;
  maxOutputTokens?: number;
  requestedOutputTokens?: number;
  tokenizerMode?: string;
  imageTokenReserve?: number;
}

export interface ModelProfile extends ModelBudgetSettings {
  name: string;
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingMode?: string;
  thinkEffort?: string;
}

export const MODEL_BUDGET_FIELDS = ["contextWindowTokens", "inputTokenLimit", "maxOutputTokens", "requestedOutputTokens", "imageTokenReserve"] as const;
