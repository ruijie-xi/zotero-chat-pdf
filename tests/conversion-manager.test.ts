import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/atomic-storage", () => ({ atomicWriteJson: vi.fn(async () => undefined) }));
vi.mock("../src/modules/md-cache", () => ({
  has: vi.fn(),
  readManifest: vi.fn(),
  writeManifestForExistingDocument: vi.fn(),
  readChunk: vi.fn(),
  getConversionRegistryPath: () => "/cache/conversions/jobs.json",
  getConversionStagingDir: (jobId: string) => `/cache/conversions/staging/${jobId}`,
  prepareConversionStaging: vi.fn(async (jobId: string) => `/cache/conversions/staging/${jobId}`),
  readStagedChunks: vi.fn(async () => new Map()),
  writeStagedChunk: vi.fn(async () => undefined),
  finalizeStagedDocument: vi.fn(async () => undefined),
  commitStagedDocument: vi.fn(async () => undefined),
  repairDocumentSwaps: vi.fn(async () => undefined),
  removeConversionStaging: vi.fn(async () => undefined),
}));
vi.mock("../src/modules/mineru-client", () => ({
  MINERU_LONG_PDF_CHUNK_SIZE: 25,
  convertPdf: vi.fn(),
}));
vi.mock("../src/modules/panel-state", () => ({
  createAbortController: () => {
    const controller = new AbortController();
    return { controller, signal: controller.signal };
  },
}));

import { atomicWriteJson } from "../src/utils/atomic-storage";
import {
  cancelConversion,
  releaseConversion,
  startConversion,
  waitForConversion,
} from "../src/modules/conversion-manager";
import { convertPdf } from "../src/modules/mineru-client";
import * as MDCache from "../src/modules/md-cache";

function attachment(key: string) {
  return {
    key,
    libraryID: 1,
    isAttachment: () => true,
    getFilePathAsync: vi.fn(async () => `/pdf/${key}.pdf`),
    getField: vi.fn(() => key),
    parentItem: { key: `PARENT-${key}`, getField: () => `Paper ${key}` },
  };
}

describe("conversion manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(IOUtils, { exists: vi.fn(async () => false) });
    Object.assign(Zotero, { Users: { getCurrentUserID: () => 99 } });
    Object.assign(Zotero.Libraries, { get: vi.fn(() => ({ libraryID: 1, libraryType: "user" })) });
    Object.assign(Zotero.Items, {
      getByLibraryAndKey: vi.fn((_libraryID: number, key: string) => attachment(key)),
    });
  });

  it("reuses a ready cache without contacting MinerU and enriches its manifest", async () => {
    vi.mocked(MDCache.has).mockResolvedValue(true);
    vi.mocked(MDCache.readManifest).mockResolvedValue({
      version: 2, key: "CACHED", title: "Cached", pageCount: 1, chunkSize: 25, chunks: [], updatedAt: 1,
    });

    const status = await startConversion({ key: "CACHED", libraryID: 1, parentItemKey: "PARENT" });

    expect(status).toMatchObject({ state: "ready", documentId: "1:CACHED" });
    expect(convertPdf).not.toHaveBeenCalled();
    expect(MDCache.writeManifestForExistingDocument).toHaveBeenCalledWith(
      "1-CACHED",
      "CACHED",
      expect.objectContaining({ version: 3, documentId: "1:CACHED", parentItemKey: "PARENT" }),
    );
  });

  it("deduplicates owners, forwards options, and commits one v3 document", async () => {
    vi.mocked(MDCache.has).mockResolvedValue(false);
    let finish!: () => void;
    vi.mocked(convertPdf).mockImplementation(async (_path, _progress, _signal, options) => {
      await options?.onPlan?.(2, 25, [{ index: 1, startPage: 1, endPage: 2 }]);
      await new Promise<void>((resolve) => { finish = resolve; });
      const chunk = { index: 1, startPage: 1, endPage: 2, markdown: "chunk", assetCount: 0 };
      await options?.onChunkConverted?.(chunk);
      return { markdown: "# Paper\n\nchunk", pageCount: 2, chunkSize: 25, chunks: [chunk], assetCount: 0 };
    });
    const request = {
      key: "DEDUPE", libraryID: 1, parentItemKey: "PARENT", force: true,
      options: { modelVersion: "vlm" as const, language: "en", enableTable: false },
    };

    const first = await startConversion(request, "ui:one");
    const second = await startConversion(request, "bridge");
    expect(second.jobId).toBe(first.jobId);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(vi.mocked(convertPdf).mock.calls[0][3]?.mineru).toMatchObject({
      modelVersion: "vlm", language: "en", enableTable: false,
    });
    finish();
    expect(await waitForConversion(first.jobId)).toMatchObject({ state: "ready" });
    expect(MDCache.finalizeStagedDocument).toHaveBeenCalledWith(
      first.jobId,
      "# Paper\n\nchunk",
      expect.objectContaining({ version: 3, documentId: "1:DEDUPE", converter: "mineru" }),
    );
    expect(MDCache.commitStagedDocument).toHaveBeenCalledWith(first.jobId, "1-DEDUPE");
  });

  it("releasing one owner cannot cancel another owner", async () => {
    vi.mocked(MDCache.has).mockResolvedValue(false);
    let observedSignal!: AbortSignal;
    vi.mocked(convertPdf).mockImplementation(async (_path, _progress, signal) => {
      observedSignal = signal!;
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("stopped"), { name: "AbortError" }));
      }, { once: true }));
      throw new Error("unreachable");
    });

    const first = await startConversion({ key: "OWNERS", libraryID: 1 }, "ui:one");
    await startConversion({ key: "OWNERS", libraryID: 1 }, "bridge");
    await vi.waitFor(() => expect(convertPdf).toHaveBeenCalledOnce());
    releaseConversion(first.jobId, "ui:one");
    expect(observedSignal.aborted).toBe(false);
    releaseConversion(first.jobId, "bridge");
    expect(await waitForConversion(first.jobId)).toMatchObject({ state: "cancelled" });
  });

  it("explicit cancellation aborts the shared job", async () => {
    vi.mocked(MDCache.has).mockResolvedValue(false);
    vi.mocked(convertPdf).mockImplementation(async (_path, _progress, signal) => {
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("stopped"), { name: "AbortError" }));
      }, { once: true }));
      throw new Error("unreachable");
    });
    const started = await startConversion({ key: "CANCEL", libraryID: 1 }, "bridge");
    await vi.waitFor(() => expect(convertPdf).toHaveBeenCalledOnce());
    expect(await cancelConversion(started.jobId)).toMatchObject({ state: "cancelled" });
  });

  it("redacts local paths and remote targets before publishing or persisting", async () => {
    vi.mocked(MDCache.has).mockResolvedValue(false);
    vi.mocked(convertPdf).mockRejectedValue(
      new Error("Could not move D:\\private\\paper.pdf to https://signed.example.invalid/private-token"),
    );
    const started = await startConversion({ key: "SENSITIVE", libraryID: 1 });
    const completed = await waitForConversion(started.jobId);
    expect(completed).toMatchObject({ state: "error" });
    expect(JSON.stringify(completed)).not.toMatch(/D:\\private|https:\/\//);
    const persisted = vi.mocked(atomicWriteJson).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(persisted)).not.toMatch(/D:\\private|https:\/\//);
  });
});
