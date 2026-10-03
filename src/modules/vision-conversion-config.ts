import { getPref } from "../utils/prefs";
import { getLLMSettings, LLMSettings, normalizeThinkingMode, normalizeThinkEffort } from "./llm-client";
import { getProviderApiBase, normalizeProvider } from "./llm-provider";
import type { ModelProfile } from "./model-profile";

export interface VisionConversionConfig {
  profile: string;
  model: string;
  apiBase: string;
  chunkPages: number;
  concurrency: number;
  dpi: number;
  cachePageImages: boolean;
  timeoutSeconds: number;
  promptVersion: string;
  selfCheck?: boolean;
  stream?: boolean;
}

export const VISION_PROMPT_VERSION = "page-transcription-v3";

/** Allow only reproducible, credential-free settings in requests and checkpoints. */
export function validateVisionConversionConfig(value: VisionConversionConfig): VisionConversionConfig {
  if (!value || typeof value.profile !== "string" || typeof value.model !== "string" || !value.model.trim()
    || typeof value.apiBase !== "string" || typeof value.cachePageImages !== "boolean" || ![VISION_PROMPT_VERSION, "page-transcription-v2"].includes(value.promptVersion)
    || (value.stream !== undefined && typeof value.stream !== "boolean")
    || (value.selfCheck !== undefined && typeof value.selfCheck !== "boolean") || (value.selfCheck && value.promptVersion !== VISION_PROMPT_VERSION)) {
    throw new Error("Invalid PDF vision conversion configuration or prompt version");
  }
  const url = new URL(value.apiBase);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("PDF conversion API base must be an HTTP(S) URL without credentials, query or fragment");
  }
  return {
    profile: value.profile, model: value.model, apiBase: value.apiBase,
    chunkPages: integer(value.chunkPages, 4, 1, 10, "PDF pages per request"),
    concurrency: integer(value.concurrency, 2, 1, 4, "PDF conversion concurrency"),
    dpi: integer(value.dpi, 150, 72, 300, "PDF render DPI"),
    cachePageImages: value.cachePageImages,
    timeoutSeconds: integer(value.timeoutSeconds, 180, 30, 1800, "PDF request timeout"),
    promptVersion: value.promptVersion,
    selfCheck: value.selfCheck === true,
    stream: value.stream === true,
  };
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number between ${min} and ${max}`);
  return n;
}

export function getVisionSettings(profile = String(getPref("pdfVisionProfile") || "")): LLMSettings {
  let settings = getLLMSettings();
  if (profile) {
    let profiles: ModelProfile[];
    try { profiles = JSON.parse(String(getPref("modelProfiles") || "[]")); }
    catch { throw new Error("Saved model profiles are invalid"); }
    const value = Array.isArray(profiles) ? profiles.find(p => p.name === profile) : undefined;
    if (!value) throw new Error(`PDF conversion model profile was not found: ${profile}`);
    settings = { ...value, provider: normalizeProvider(value.provider),
      thinkingMode: normalizeThinkingMode(value.thinkingMode), thinkEffort: normalizeThinkEffort(value.thinkEffort) };
  }
  // Credentials are resolved at request time and never copied into the job registry.
  return { ...settings, apiBase: getProviderApiBase(settings), thinkingMode: "disabled", thinkEffort: "default" };
}

export function getVisionConversionConfig(): VisionConversionConfig {
  // Pin a named active profile for recovery even if the chat profile changes.
  const profile = String(getPref("pdfVisionProfile") || getPref("activeProfile") || "");
  const settings = getVisionSettings(profile);
  return validateVisionConversionConfig({
    profile, model: settings.model, apiBase: settings.apiBase,
    chunkPages: integer(getPref("pdfVisionChunkPages"), 4, 1, 10, "PDF pages per request"),
    concurrency: integer(getPref("pdfVisionConcurrency"), 2, 1, 4, "PDF conversion concurrency"),
    dpi: integer(getPref("pdfVisionDpi"), 150, 72, 300, "PDF render DPI"),
    cachePageImages: getPref("pdfVisionCachePageImages") !== false,
    timeoutSeconds: integer(getPref("pdfVisionTimeoutSeconds"), 180, 30, 1800, "PDF request timeout"),
    promptVersion: VISION_PROMPT_VERSION,
    selfCheck: getPref("pdfVisionSelfCheck") !== false,
    stream: getPref("pdfVisionStream") !== false,
  });
}

export function sameVisionConfig(a?: VisionConversionConfig, b?: VisionConversionConfig): boolean {
  return !!a && !!b && a.profile === b.profile && a.model === b.model && a.apiBase === b.apiBase
    && a.chunkPages === b.chunkPages && a.dpi === b.dpi && a.cachePageImages === b.cachePageImages
    && a.promptVersion === b.promptVersion && !!a.selfCheck === !!b.selfCheck;
}
