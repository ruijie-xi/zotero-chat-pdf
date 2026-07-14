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
