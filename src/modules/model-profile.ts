import { getPref, setPref } from "../utils/prefs";
import { getProviderApiBase, normalizeProvider, type LLMProvider } from "./llm-provider";

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
  /** Missing in legacy profiles; those keep the custom endpoint behavior. */
  provider?: LLMProvider;
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingMode?: string;
  thinkEffort?: string;
}

export const MODEL_BUDGET_FIELDS = ["contextWindowTokens", "inputTokenLimit", "maxOutputTokens", "requestedOutputTokens", "imageTokenReserve"] as const;

type ProfilePreferenceKey = typeof MODEL_BUDGET_FIELDS[number]
  | "llmProvider" | "llmApiBase" | "llmApiKey" | "llmModel"
  | "llmThinkingMode" | "llmThinkEffort" | "tokenizerMode" | "activeProfile";
type ProfilePreferences = Pick<_ZoteroTypes.Prefs["PluginPrefsMap"], ProfilePreferenceKey>;

/** Both settings and the panel accept the same saved profiles, including legacy custom endpoints. */
export function parseModelProfiles(raw: unknown): ModelProfile[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is ModelProfile => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      return ["name", "model", "apiBase", "apiKey"].every(key => typeof value[key] === "string");
    });
  } catch {
    return [];
  }
}

export function loadModelProfiles(): ModelProfile[] {
  return parseModelProfiles(getPref("modelProfiles"));
}

export function saveModelProfiles(profiles: ModelProfile[]): void {
  setPref("modelProfiles", JSON.stringify(profiles));
}

/** Normalize only at application time; reading a profile never rewrites saved user data. */
export function modelProfilePreferences(profile: ModelProfile): ProfilePreferences {
  const budgets = Object.fromEntries(MODEL_BUDGET_FIELDS.map(key => [key, profile[key] || 0])) as
    Pick<ProfilePreferences, typeof MODEL_BUDGET_FIELDS[number]>;
  return {
    llmProvider: normalizeProvider(profile.provider),
    llmApiBase: getProviderApiBase(profile),
    llmApiKey: profile.apiKey,
    llmModel: profile.model,
    llmThinkingMode: profile.thinkingMode || "default",
    llmThinkEffort: profile.thinkEffort || "default",
    tokenizerMode: profile.tokenizerMode || "auto",
    ...budgets,
    activeProfile: profile.name,
  };
}

/** The settings form and chat selector share every field and default. */
export function applyModelProfile(profile: ModelProfile): ProfilePreferences {
  const values = modelProfilePreferences(profile);
  for (const key of Object.keys(values) as ProfilePreferenceKey[]) setPref(key, values[key]);
  return values;
}
