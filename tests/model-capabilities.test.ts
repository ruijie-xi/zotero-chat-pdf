import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.unmock("../src/modules/model-capabilities");
import { resolveModelCapabilities, clearModelCapabilityCache } from "../src/modules/model-capabilities";
const settings = { apiBase: "https://api.deepseek.com/v1", apiKey: "test-only", model: "deepseek-flash", thinkingMode: "default" as const, thinkEffort: "default" as const };
beforeEach(() => clearModelCapabilityCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(Zotero.getMainWindow).mockImplementation(() => window as any);
});
describe("model capability resolution", () => {
  it("uses Go catalogue limits when its model listing only supplies IDs, then prefers endpoint metadata and manual limits", async () => {
    const go = { ...settings, provider: "opencode-go" as const, apiBase: "https://stale.example/v1", model: "deepseek-v4.1-flash", tokenizerMode: "deepseek-v4-estimate", sessionId: "conversation-1" };
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(_url).toBe("https://opencode.ai/zen/go/v1/models");
      expect(options.headers).toMatchObject({ "x-opencode-session": go.sessionId, "User-Agent": expect.stringMatching(/^ChatPDF\//) });
      return { ok: true, json: async () => ({ data: [{ id: go.model }] }) };
    });
    vi.stubGlobal("fetch", fetch);
    expect(await resolveModelCapabilities(go)).toMatchObject({ contextWindow: 1000000, maxOutput: 384000, source: "provider-preset", requestedOutput: 8192 });
    expect(await resolveModelCapabilities({ ...go, contextWindowTokens: 50000, maxOutputTokens: 10000, requestedOutputTokens: 5000 })).toMatchObject({ contextWindow: 50000, maxOutput: 10000, source: "manual", requestedOutput: 5000 });
    await expect(resolveModelCapabilities({ ...go, model: "unknown" })).rejects.toThrow("token limits");
    fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ data: [{ id: go.model, context_window: 800000, max_output_tokens: 200000 }] }) }));
    expect(await resolveModelCapabilities(go, undefined, true)).toMatchObject({ contextWindow: 800000, maxOutput: 200000, source: "endpoint" });
    await expect(resolveModelCapabilities({ ...go, tokenizerMode: "auto" })).rejects.toThrow("verified local tokenizer");
  });
  it("discovers metadata in Zotero without a global AbortController", async () => {
    const Controller = AbortController;
    const Signal = new Controller().signal.constructor;
    vi.stubGlobal("AbortController", undefined);
    vi.mocked(Zotero.getMainWindow).mockReturnValue({ AbortController: Controller } as any);
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(Signal);
      expect(options.signal?.aborted).toBe(false);
      return { ok: true, json: async () => ({ data: [{ id: "deepseek-flash", context_window: 1048576, max_output_tokens: 393216 }] }) };
    });
    vi.stubGlobal("fetch", fetch);
    expect(await resolveModelCapabilities(settings)).toMatchObject({ contextWindow: 1048576, source: "endpoint" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("forwards cancellation and clears its timeout with the window constructor", async () => {
    vi.useFakeTimers();
    const Controller = AbortController;
    const parent = new Controller();
    vi.stubGlobal("AbortController", undefined);
    vi.mocked(Zotero.getMainWindow).mockReturnValue({ AbortController: Controller } as any);
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    })));
    const pending = resolveModelCapabilities(settings, parent.signal);
    parent.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
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
