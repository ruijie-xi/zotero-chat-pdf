import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVisionConversionConfig, getVisionSettings, sameVisionConfig, validateVisionConversionConfig } from "../src/modules/vision-conversion-config";
import { getPref } from "../src/utils/prefs";

vi.mock("../src/utils/prefs", () => ({ getPref: vi.fn() }));
let prefs: Record<string, any>;
beforeEach(() => {
  prefs = { llmApiBase: "https://chat.example/v1", llmApiKey: "chat-secret", llmModel: "text-only", activeProfile: "Chat",
    pdfVisionProfile: "Vision", modelProfiles: JSON.stringify([{ name: "Vision", provider: "opencode-go", apiBase: "https://old.example", apiKey: "vision-secret", model: "deepseek-v4.1-flash", imageTokenReserve: 1024 },
      { name: "Chat", apiBase: "https://chat.example/v1", apiKey: "chat-secret", model: "text-only" }]) };
  vi.mocked(getPref).mockImplementation(key => prefs[key]);
});
describe("conversion profile configuration", () => {
  it("defaults to stream preview without invalidating checked chunks when toggled", () => {
    const config = getVisionConversionConfig();
    expect(config.stream).toBe(true);
    prefs.pdfVisionStream = false;
    expect(getVisionConversionConfig().stream).toBe(false);
    expect(sameVisionConfig(config, getVisionConversionConfig())).toBe(true);
    expect(validateVisionConversionConfig({ ...config, stream: undefined }).stream).toBe(false);
  });
  it("uses a separate vision profile, normalizes its endpoint and never persists credentials", () => {
    const config = getVisionConversionConfig();
    expect(config).toMatchObject({ profile: "Vision", model: "deepseek-v4.1-flash", apiBase: "https://opencode.ai/zen/go/v1", chunkPages: 4, dpi: 150 });
    expect(JSON.stringify(config)).not.toContain("secret");
    expect(getVisionSettings(config.profile)).toMatchObject({ apiKey: "vision-secret", thinkingMode: "disabled", thinkEffort: "default" });
  });
  it("pins the active named profile when no conversion override is set", () => {
    prefs.pdfVisionProfile = "";
    expect(getVisionConversionConfig().profile).toBe("Chat");
  });
  it("rejects missing profiles, invalid parameter ranges and credential-bearing API URLs", () => {
    prefs.pdfVisionProfile = "Missing"; expect(() => getVisionConversionConfig()).toThrow("not found");
    prefs.pdfVisionProfile = "Vision"; prefs.pdfVisionChunkPages = 0; expect(() => getVisionConversionConfig()).toThrow("between 1 and 10");
    prefs.pdfVisionChunkPages = 4; prefs.pdfVisionProfile = ""; prefs.activeProfile = ""; prefs.llmApiBase = "https://user:secret@example.com/v1";
    expect(() => getVisionConversionConfig()).toThrow("without credentials");
  });
  it("invalidates chunk reuse when the model, rendering or asset policy changes", () => {
    const config = getVisionConversionConfig();
    expect(sameVisionConfig(config, { ...config, concurrency: 4 })).toBe(true);
    for (const change of [{ dpi: 100 }, { model: "other" }, { chunkPages: 3 }, { cachePageImages: false }, { selfCheck: false }]) {
      expect(sameVisionConfig(config, { ...config, ...change })).toBe(false);
    }
  });
  it("strips accidental credential fields and rejects unsupported checkpoint prompt versions", () => {
    const config = getVisionConversionConfig();
    expect(validateVisionConversionConfig({ ...config, apiKey: "must-not-persist" } as any)).not.toHaveProperty("apiKey");
    expect(() => validateVisionConversionConfig({ ...config, promptVersion: "unknown" })).toThrow("prompt version");
    const legacy = validateVisionConversionConfig({ ...config, promptVersion: "page-transcription-v2", selfCheck: undefined });
    expect(legacy.selfCheck).toBe(false);
    expect(sameVisionConfig(config, legacy)).toBe(false);
    expect(() => validateVisionConversionConfig({ ...legacy, selfCheck: true })).toThrow("prompt version");
  });
});
