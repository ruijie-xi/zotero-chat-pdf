import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/cache-dir", () => ({
  getCacheDir: () => "/cache",
  ensureDir: vi.fn(async () => undefined),
}));
vi.mock("../src/utils/atomic-storage", () => ({
  atomicWriteJson: vi.fn(async () => undefined),
  atomicWriteText: vi.fn(async () => undefined),
  withStorageLock: vi.fn(async (_key: string, work: () => Promise<void>) => work()),
}));

import { commitStagedDocument, prepareConversionStaging } from "../src/modules/md-cache";

describe("Markdown cache transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(PathUtils, {
      join: (...parts: string[]) => parts.join("/"),
      parent: (path: string) => path.slice(0, path.lastIndexOf("/")),
      filename: (path: string) => path.split("/").pop() || path,
    });
  });

  it("copies a partial canonical directory and all assets into private staging", async () => {
    const existing = new Set(["/cache/documents/1-ATT"]);
    const copy = vi.fn(async () => undefined);
    Object.assign(IOUtils, { exists: vi.fn(async (path: string) => existing.has(path)), copy });

    const staging = await prepareConversionStaging("job", "1-ATT", "ATT");

    expect(staging).toBe("/cache/conversions/staging/job");
    expect(copy).toHaveBeenCalledWith(
      "/cache/documents/1-ATT",
      "/cache/conversions/staging/job",
      { recursive: true },
    );
  });

  it("rolls back and retries a transient Windows directory move failure", async () => {
    const staging = "/cache/conversions/staging/job";
    const canonical = "/cache/documents/1-ATT";
    const backup = `${canonical}.backup-job`;
    const existing = new Set([staging, canonical]);
    let stagingMoves = 0;
    Object.assign(IOUtils, {
      exists: vi.fn(async (path: string) => existing.has(path)),
      remove: vi.fn(async (path: string) => { existing.delete(path); }),
      move: vi.fn(async (source: string, target: string) => {
        if (source === staging && ++stagingMoves === 1) throw new Error("NS_ERROR_FAILURE");
        if (!existing.has(source)) throw new Error(`missing ${source}`);
        existing.delete(source);
        existing.add(target);
      }),
    });

    await commitStagedDocument("job", "1-ATT");

    expect(stagingMoves).toBe(2);
    expect(existing).toContain(canonical);
    expect(existing).not.toContain(backup);
  });
});
