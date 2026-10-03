import { vi } from "vitest";

Object.assign(globalThis, {
  Zotero: {
    Prefs: { get: vi.fn(() => undefined), set: vi.fn() },
    Utilities: { randomString: vi.fn(() => "test-random-id") },
    Libraries: { getAll: vi.fn(() => []) },
    Items: { getByLibraryAndKey: vi.fn(() => null) },
    getMainWindow: vi.fn(() => window),
    getMainWindows: vi.fn(() => [window]),
    debug: vi.fn(),
  },
  PathUtils: {
    join: (...parts: string[]) => parts.join("/"),
    parent: (path: string) => path.slice(0, path.lastIndexOf("/")) || null,
    profileDir: "/profile",
    tempDir: "/tmp",
  },
  IOUtils: {},
  Services: {},
  Components: {},
});

// Domain-loop tests use a deterministic token stream; tokenizer correctness has separate fixtures.
vi.mock("../src/modules/token-accounting", async original => ({
  ...await original<typeof import("../src/modules/token-accounting")>(),
  loadTokenizer: vi.fn(async () => ({ encode: (text: string) => ({ ids: { length: text.length } }) })),
}));
vi.mock("../src/modules/model-capabilities", async original => ({
  ...await original<typeof import("../src/modules/model-capabilities")>(),
  resolveModelCapabilities: vi.fn(async () => ({ inputLimit: 240000, maxOutput: 32768, generation: { outputTokens: 32768, retryCeiling: 32768, source: "model-maximum", thinkingMode: "default", thinkEffort: "default" }, tokenizer: "deepseek-v4", imageTokens: 1024, source: "manual", fetchedAt: 1 })),
}));
