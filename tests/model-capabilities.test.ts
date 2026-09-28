import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.unmock("../src/modules/model-capabilities");
import { resolveModelCapabilities, clearModelCapabilityCache } from "../src/modules/model-capabilities";
const settings = { apiBase: "https://api.deepseek.com/v1", apiKey: "test-only", model: "deepseek-flash", thinkingMode: "default" as const, thinkEffort: "default" as const };
beforeEach(() => clearModelCapabilityCache());
afterEach(() => vi.unstubAllGlobals());
describe("model capability resolution", () => {
  it("uses exact endpoint model metadata, caches it, and keeps accounts separate", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "other", context_window: 1 }, { id: "deepseek-flash", context_window: 1048576, max_output_tokens: 393216 }] }) }));
    vi.stubGlobal("fetch", fetch);
    expect(await resolveModelCapabilities(settings)).toMatchObject({ contextWindow: 1048576, maxOutput: 393216, imageTokens: 1024, source: "endpoint" });
    await resolveModelCapabilities(settings);
    expect(fetch).toHaveBeenCalledTimes(1);
    await resolveModelCapabilities({ ...settings, apiKey: "another-account" });
    expect(fetch).toHaveBeenCalledTimes(2);
    await resolveModelCapabilities(settings, undefined, true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("uses manual token limits and never silently substitutes a character limit", async () => {
    const fetch = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetch);
    await expect(resolveModelCapabilities(settings)).rejects.toThrow("token limits");
    const manual = await resolveModelCapabilities({ ...settings, contextWindowTokens: 32768, maxOutputTokens: 4096 });
    expect(manual).toMatchObject({ contextWindow: 32768, maxOutput: 4096, requestedOutput: 4096, source: "manual" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("requires an explicit approximate tokenizer for unknown models", async () => {
    const custom = { ...settings, apiBase: "https://example.com/v1", model: "custom", inputTokenLimit: 4096, maxOutputTokens: 1024 };
    await expect(resolveModelCapabilities(custom)).rejects.toThrow("verified local tokenizer");
    expect(await resolveModelCapabilities({ ...custom, tokenizerMode: "deepseek-v4-estimate" })).toMatchObject({ inputLimit: 4096, imageTokens: undefined });
  });
  it("invalidates the shared metadata cache after a preferences refresh", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "deepseek-flash", context_window: 4096, max_output_tokens: 4096 }] }) }));
    vi.stubGlobal("fetch", fetch);
    let revision = 0;
    vi.mocked(Zotero.Prefs.get).mockImplementation(() => revision);
    const small = await resolveModelCapabilities(settings);
    expect(small.requestedOutput).toBe(1024);
    revision++;
    await resolveModelCapabilities(settings);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(Zotero.Prefs.get).mockReset();
  });
});
