import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLLMHeaders, getProviderApiBase, getProviderModelLimits, normalizeProvider } from "../src/modules/llm-provider";
import { chatWithTools, getLLMSettings } from "../src/modules/llm-client";

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(Zotero.Prefs.get).mockReset(); });

describe("provider transport and compatibility", () => {
  it("keeps legacy and unknown provider values custom and preserves their endpoint", () => {
    for (const provider of [undefined, "", "unknown"]) expect(normalizeProvider(provider)).toBe("custom");
    const prefs: Record<string, string> = { llmApiBase: "https://example.com/v1", llmApiKey: "legacy", llmModel: "custom-model" };
    vi.mocked(Zotero.Prefs.get).mockImplementation(key => prefs[String(key).split(".").at(-1)!] as never);
    expect(getLLMSettings()).toMatchObject({ provider: "custom", apiBase: prefs.llmApiBase, apiKey: "legacy", model: "custom-model" });
    prefs.llmProvider = "opencode-go";
    expect(getLLMSettings()).toMatchObject({ provider: "opencode-go", apiBase: "https://opencode.ai/zen/go/v1" });
    expect(getProviderApiBase({ provider: "deepseek", apiBase: prefs.llmApiBase })).toBe("https://api.deepseek.com/v1");
  });

  it("sends Go headers on the actual request path without sending them to custom providers", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }) }));
    vi.stubGlobal("fetch", fetch);
    const settings = { provider: "opencode-go" as const, apiBase: "https://stale.example/v1", apiKey: "go-test-key", model: "deepseek-v4.1-flash", sessionId: "conversation-1", thinkingMode: "enabled" as const, thinkEffort: "high" as const };
    await chatWithTools([{ role: "user", content: "Test" }], [], undefined, undefined, undefined, true, { settings, maxTokens: 1000 });
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(request.headers).toMatchObject({ Authorization: "Bearer go-test-key", "x-opencode-session": "conversation-1", "User-Agent": expect.stringMatching(/^ChatPDF\//) });
    expect(JSON.parse(request.body as string)).toMatchObject({ model: settings.model, max_tokens: 1000, thinking: { type: "enabled" }, reasoning_effort: "high" });
    await chatWithTools([{ role: "user", content: "Test" }], [], undefined, undefined, undefined, true, { settings: { ...settings, provider: "custom" } });
    expect((fetch.mock.calls[1] as unknown as [string, RequestInit])[0]).toBe(settings.apiBase + "/chat/completions");
    expect((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("x-opencode-session");
    expect((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("User-Agent");
  });

  it("requires a valid conversation ID rather than silently creating a new one per Go request", () => {
    const settings = { provider: "opencode-go" as const, apiBase: "", apiKey: "test" };
    for (const sessionId of [undefined, "", "bad\r\nheader", "a".repeat(129)]) expect(() => buildLLMHeaders({ ...settings, sessionId })).toThrow("stable conversation ID");
    expect(getProviderModelLimits({ provider: "custom", model: "deepseek-v4.1-flash" })).toBeUndefined();
    expect(getProviderModelLimits({ provider: "opencode-go", model: "unknown" })).toBeUndefined();
  });
});
