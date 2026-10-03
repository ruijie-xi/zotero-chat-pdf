import type { LLMSettings } from "./llm-client";
import { getPref } from "../utils/prefs";
import { buildLLMHeaders, createProviderSessionId, getProviderApiBase, getProviderModelLimits, normalizeProvider } from "./llm-provider";
import { GenerationPolicy, isOfficialDeepSeek, resolveGenerationPolicy } from "./generation-policy";

export interface ModelCapabilities {
  contextWindow?: number;
  inputLimit?: number;
  maxOutput: number;
  generation: GenerationPolicy;
  tokenizer: "deepseek-v4";
  imageTokens?: number;
  source: "endpoint" | "manual" | "provider-preset";
  fetchedAt: number;
}

// Account-scoped, memory-only: neither credentials nor metadata enter prompts.
const cache = new Map<string, { at: number; model: Record<string, any> }>();
const positive = (n: unknown): number | undefined => Number.isSafeInteger(Number(n)) && Number(n) > 0 ? Number(n) : undefined;

export async function resolveModelCapabilities(settings: LLMSettings, signal?: AbortSignal, refresh = false, requireTokenizer = true): Promise<ModelCapabilities> {
  const base = getProviderApiBase(settings).replace(/\/+$/, "");
  const key = JSON.stringify([normalizeProvider(settings.provider), base, settings.apiKey, settings.model, getPref("modelCapabilitiesRevision")]);
  let entry = cache.get(key);
  const manual = positive(settings.contextWindowTokens) || positive(settings.inputTokenLimit);
  if ((!entry || Date.now() - entry.at > 86_400_000 || refresh) && (!manual || !positive(settings.maxOutputTokens) || refresh)) {
    // Zotero's privileged module scope does not expose every window constructor.
    const Controller = typeof AbortController !== "undefined"
      ? AbortController : (Zotero.getMainWindow() as unknown as { AbortController: new () => AbortController }).AbortController;
    const controller = new Controller();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15_000);
    try {
      if (signal?.aborted) controller.abort();
      const response = await fetch(`${base}/models`, { headers: buildLLMHeaders({ ...settings, sessionId: settings.sessionId || createProviderSessionId() }), signal: controller.signal, redirect: "error" });
      if (response.ok) {
        const payload = await response.json() as { data?: Record<string, any>[] };
        const model = payload.data?.find((m: any) => m.id === settings.model);
        if (model) { entry = { at: Date.now(), model }; cache.set(key, entry); }
      }
    } catch (error) { if (signal?.aborted) throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  const metadata = entry && Date.now() - entry.at <= 86_400_000 ? entry.model : undefined;
  const preset = getProviderModelLimits(settings);
  const endpointContext = positive(metadata?.context_window) || positive(metadata?.context_length);
  const endpointOutput = positive(metadata?.max_output_tokens) || positive(metadata?.top_provider?.max_completion_tokens);
  const contextWindow = positive(settings.contextWindowTokens) || endpointContext || preset?.contextWindow;
  const inputLimit = positive(settings.inputTokenLimit) || positive(metadata?.input_token_limit);
  const maxOutput = positive(settings.maxOutputTokens) || endpointOutput || preset?.maxOutput;
  if ((!contextWindow && !inputLimit) || !maxOutput) throw new Error("Model token limits are unavailable. Set the context/input and maximum output token limits for this model in Preferences, then save its profile. Old character limits are not used.");
  const officialV4 = isOfficialDeepSeek({ ...settings, apiBase: base });
  if (requireTokenizer && !officialV4 && settings.tokenizerMode !== "deepseek-v4-estimate") throw new Error("This model has no verified local tokenizer. Select the explicit DeepSeek V4 tokenizer estimate in its profile, or use a supported model. Counts are estimates; provider usage remains authoritative.");
  const generation = resolveGenerationPolicy(settings, maxOutput);
  return { contextWindow, inputLimit, maxOutput, generation, tokenizer: "deepseek-v4",
    imageTokens: positive(settings.imageTokenReserve) || (officialV4 || (preset && /deepseek/i.test(settings.model)) ? 1024 : undefined),
    source: manual || positive(settings.maxOutputTokens) ? "manual" : preset && (!endpointContext || !endpointOutput) ? "provider-preset" : "endpoint", fetchedAt: entry?.at || Date.now() };
}

export function clearModelCapabilityCache(): void { cache.clear(); }
