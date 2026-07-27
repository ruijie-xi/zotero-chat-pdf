import { describe, expect, it, vi } from "vitest";

const jobs = [
  {
    jobId: "recovery-good",
    cacheKey: "1-RECOVERYGOOD",
    request: { key: "RECOVERYGOOD", libraryID: 1, force: true, options: { modelVersion: "vlm", language: "en" } },
    status: {
      jobId: "recovery-good", state: "recovering", documentId: "1:RECOVERYGOOD", title: "Recovery good",
      progress: "Paused", error: "", stage: "suspended", createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:01:00.000Z", retryable: true, remoteMayContinue: true,
    },
    remoteTasks: { full: { taskKey: "full", batchId: "batch-existing", state: "uploaded" } },
    completedChunks: [],
  },
  { jobId: "../invalid", request: {}, status: {} },
];

vi.mock("../src/utils/atomic-storage", () => ({ atomicWriteJson: vi.fn(async () => undefined) }));
vi.mock("../src/modules/md-cache", () => ({
  has: vi.fn(async () => false),
  readManifest: vi.fn(async () => null),
  readChunk: vi.fn(),
  getConversionRegistryPath: () => "/cache/conversions/jobs.json",
  getConversionStagingDir: (jobId: string) => `/cache/conversions/staging/${jobId}`,
  prepareConversionStaging: vi.fn(async () => "/cache/conversions/staging/recovery-good"),
  readStagedChunks: vi.fn(async () => new Map()),
  writeStagedChunk: vi.fn(async () => undefined),
  finalizeStagedDocument: vi.fn(async () => undefined),
  commitStagedDocument: vi.fn(async () => undefined),
  repairDocumentSwaps: vi.fn(async () => undefined),
  removeConversionStaging: vi.fn(async () => undefined),
}));
vi.mock("../src/modules/panel-state", () => ({
  createAbortController: () => {
    const controller = new AbortController();
    return { controller, signal: controller.signal };
  },
}));
vi.mock("../src/modules/mineru-client", () => ({
  MINERU_LONG_PDF_CHUNK_SIZE: 25,
  convertPdf: vi.fn(async (_path: string, _progress: unknown, _signal: unknown, options: any) => {
    await options.onPlan(1, 1, [{ index: 1, startPage: 1, endPage: 1 }]);
    const chunk = { index: 1, startPage: 1, endPage: 1, markdown: "restored", assetCount: 0 };
    await options.onChunkConverted(chunk);
    return { markdown: "# Restored\n\nrestored", pageCount: 1, chunkSize: 1, chunks: [chunk], assetCount: 0 };
  }),
}));

import { initializeConversions, listConversions, waitForConversion } from "../src/modules/conversion-manager";
import { convertPdf } from "../src/modules/mineru-client";
import * as MDCache from "../src/modules/md-cache";

describe("conversion manager recovery", () => {
  it("isolates invalid entries and resumes a valid MinerU checkpoint", async () => {
    Object.assign(IOUtils, {
      exists: vi.fn(async (path: string) => path === "/cache/conversions/jobs.json"),
      read: vi.fn(async () => new TextEncoder().encode(JSON.stringify({ version: 1, jobs }))),
    });
    Object.assign(Zotero, { Users: { getCurrentUserID: () => 99 } });
    Object.assign(Zotero.Libraries, { get: vi.fn(() => ({ libraryID: 1, libraryType: "user" })) });
    Object.assign(Zotero.Items, { getByLibraryAndKey: vi.fn((_id: number, key: string) => ({
      key, libraryID: 1, isAttachment: () => true, getFilePathAsync: async () => `/pdf/${key}.pdf`,
      getField: () => key, parentItem: { getField: () => `Paper ${key}` },
    })) });

    await initializeConversions();
    const completed = await waitForConversion("recovery-good");

    expect(completed.state).toBe("ready");
    expect(listConversions()).toHaveLength(1);
    expect(vi.mocked(convertPdf).mock.calls[0][3]?.remoteTasks?.get("full")).toEqual({
      taskKey: "full", batchId: "batch-existing", state: "uploaded",
    });
    expect(MDCache.commitStagedDocument).toHaveBeenCalledWith("recovery-good", "1-RECOVERYGOOD");
  });
});
