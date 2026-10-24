import { afterEach, describe, expect, it, vi } from "vitest";
import { applyModelProfile, loadModelProfiles, modelProfilePreferences, parseModelProfiles, updateActiveProfileApiKey } from "../src/modules/model-profile";

const legacy = { name: "Legacy custom", apiBase: "https://custom.example/v1", apiKey: "fixture-only", model: "custom-model" };

afterEach(() => {
  vi.mocked(Zotero.Prefs.get).mockReset();
  vi.mocked(Zotero.Prefs.set).mockReset();
});

describe("shared model profiles", () => {
  it("ignores damaged entries while retaining valid profiles and legacy fields", () => {
    const profile = { ...legacy, historicalSetting: "retain" };
    expect(parseModelProfiles(JSON.stringify([null, false, [], {}, { ...legacy, apiKey: null }, profile]))).toEqual([profile]);
    for (const value of [undefined, "", "{broken", "null", "{}", "123"]) expect(parseModelProfiles(value)).toEqual([]);
  });

  it("does not rewrite stored profiles when reading or applying a legacy endpoint", () => {
    const stored = JSON.stringify([{ ...legacy, historicalSetting: "retain" }]);
    vi.mocked(Zotero.Prefs.get).mockReturnValue(stored);
    const [profile] = loadModelProfiles();
    expect(Zotero.Prefs.set).not.toHaveBeenCalled();
    const values = applyModelProfile(profile);
    expect(values).toMatchObject({ llmProvider: "custom", llmApiBase: legacy.apiBase, llmApiKey: legacy.apiKey, llmModel: legacy.model, activeProfile: legacy.name });
    expect(vi.mocked(Zotero.Prefs.set).mock.calls.some(([key]) => String(key).endsWith(".modelProfiles"))).toBe(false);
    expect(JSON.stringify([profile])).toBe(stored);
  });

  it("applies every model limit and restores defaults without leaking the previous profile", () => {
    const settings = { ...legacy, provider: "opencode-go" as const, contextWindowTokens: 200000, inputTokenLimit: 160000, maxOutputTokens: 10000, requestedOutputTokens: 6000, imageTokenReserve: 2000, tokenizerMode: "deepseek-v4-estimate", thinkingMode: "enabled", thinkEffort: "high" };
    const values = modelProfilePreferences(settings);
    expect(values).toMatchObject({ llmApiBase: "https://opencode.ai/zen/go/v1", contextWindowTokens: 200000, inputTokenLimit: 160000, maxOutputTokens: 10000, requestedOutputTokens: 6000, imageTokenReserve: 2000, tokenizerMode: "deepseek-v4-estimate", llmThinkingMode: "enabled", llmThinkEffort: "high" });
    applyModelProfile(settings);
    for (const [key, value] of Object.entries(values)) expect(Zotero.Prefs.set).toHaveBeenCalledWith(`extensions.zotero.chatpdf.${key}`, value, true);
    expect(modelProfilePreferences(legacy)).toMatchObject({ contextWindowTokens: 0, inputTokenLimit: 0, maxOutputTokens: 0, requestedOutputTokens: 0, imageTokenReserve: 0, tokenizerMode: "auto", llmThinkingMode: "default", llmThinkEffort: "default" });
  });

  it("rotates or clears only the loaded account's key while preserving other fields and accounts", () => {
    const selected = { ...legacy, historicalSetting: "retain", maxOutputTokens: 12345 };
    const other = { ...legacy, name: "Another account", apiKey: "other-account-key" };
    const prefs: Record<string, unknown> = { activeProfile: selected.name, modelProfiles: JSON.stringify([selected, other]) };
    vi.mocked(Zotero.Prefs.get).mockImplementation(key => prefs[String(key).split(".").at(-1)!] as never);
    vi.mocked(Zotero.Prefs.set).mockImplementation((key, value) => { prefs[String(key).split(".").at(-1)!] = value; });
    for (const apiKey of ["replacement-key", "second-replacement", ""]) {
      expect(updateActiveProfileApiKey({ ...legacy, apiKey, maxOutputTokens: 99 })).toBe(true);
      expect(loadModelProfiles()).toEqual([{ ...selected, apiKey }, other]);
      expect(prefs.activeProfile).toBe(selected.name);
    }
  });

  it("does not attach an unsaved credential to an absent or different model profile", () => {
    const prefs: Record<string, unknown> = { activeProfile: legacy.name, modelProfiles: JSON.stringify([legacy]) };
    vi.mocked(Zotero.Prefs.get).mockImplementation(key => prefs[String(key).split(".").at(-1)!] as never);
    for (const change of [{ model: "different" }, { apiBase: "https://another.example/v1" }, { provider: "deepseek" as const }]) {
      expect(updateActiveProfileApiKey({ ...legacy, apiKey: "replacement", ...change })).toBe(false);
    }
    for (const name of ["", "deleted"]) {
      prefs.activeProfile = name;
      expect(updateActiveProfileApiKey({ ...legacy, apiKey: "replacement" })).toBe(false);
    }
    expect(Zotero.Prefs.set).not.toHaveBeenCalled();
  });
});
