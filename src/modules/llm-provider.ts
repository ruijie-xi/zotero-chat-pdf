import { version } from "../../package.json";

export type LLMProvider = "custom" | "deepseek" | "opencode-go";

export function normalizeProvider(value: unknown): LLMProvider {
  return value === "deepseek" || value === "opencode-go" ? value : "custom";
}

export const PROVIDER_PRESETS = {
  deepseek: { apiBase: "https://api.deepseek.com/v1", model: "deepseek-flash", tokenizerMode: "auto" },
  "opencode-go": { apiBase: "https://opencode.ai/zen/go/v1", model: "deepseek-v4.1-flash", tokenizerMode: "deepseek-v4-estimate" },
} as const;

export const PROVIDER_MODELS: Record<LLMProvider, readonly string[]> = {
  custom: [],
  deepseek: ["deepseek-flash", "deepseek-pro"],
  "opencode-go": ["deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
};

/** OpenCode's models.dev catalogue, checked 2026-10-03. Go /models currently
 * lists IDs without limits. Provider metadata and explicit user limits win.
 * https://github.com/anomalyco/models.dev/tree/dev/providers/opencode-go/models
 * Inherited limits: models/deepseek/deepseek-v4.1-flash.toml,
 * deepseek-v4-flash-0731.toml and deepseek-v4-flash-vision-exp.toml.
 */
export function getProviderModelLimits(settings: Pick<ProviderSettings, "provider"> & { model: string }): { contextWindow: number; maxOutput: number } | undefined {
  if (normalizeProvider(settings.provider) !== "opencode-go" || !PROVIDER_MODELS["opencode-go"].includes(settings.model)) return undefined;
  return { contextWindow: 1_000_000, maxOutput: 384_000 };
}

export interface ProviderSettings {
  provider?: LLMProvider;
  apiBase: string;
  apiKey: string;
  /** Transport only: the conversation ID is never saved in a model profile. */
  sessionId?: string;
}

/** Built-in providers always use their own endpoint, including after profile load. */
export function getProviderApiBase(settings: Pick<ProviderSettings, "provider" | "apiBase">): string {
  const provider = normalizeProvider(settings.provider);
  return provider === "custom" ? settings.apiBase : PROVIDER_PRESETS[provider].apiBase;
}

export function createProviderSessionId(): string {
  return Zotero.Utilities.randomString(32);
}

/** Shared by chat, auxiliary requests, metadata discovery and the API test. */
export function buildLLMHeaders(settings: ProviderSettings): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`,
  };
  if (normalizeProvider(settings.provider) === "opencode-go") {
    if (!settings.sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(settings.sessionId)) {
      throw new Error("OpenCode Go requires a stable conversation ID.");
    }
    headers["User-Agent"] = `ChatPDF/${version}`;
    headers["x-opencode-session"] = settings.sessionId;
  }
  return headers;
}
