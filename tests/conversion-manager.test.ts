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
  getMineruTaskState: vi.fn(),
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
  recoverConversion,
  releaseConversion,
  startConversion,
  waitForConversion,
} from "../src/modules/conversion-manager";
import { convertPdf, getMineruTaskState } from "../src/modules/mineru-client";
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
    vi.mocked(Zotero.Prefs.get).mockImplementation((key: any) => String(key).endsWith("pdfConversionEngine") ? "mineru" : undefined);
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

  async function timedOutUpload(key: string, batchId: string, force = false) {
    vi.mocked(MDCache.has).mockResolvedValue(false);
    vi.mocked(convertPdf).mockImplementationOnce(async (_path, _progress, _signal, options) => {
      await options?.onRemoteTask?.({ taskKey: "full", batchId, state: "uploaded" });
      throw new Error("MinerU result polling timed out after 15 minutes");
    });
    const started = await startConversion({ key, libraryID: 1, force }, "ui:old");
    expect(await waitForConversion(started.jobId)).toMatchObject({ state: "error" });
    return started;
  }

  function successfulRecovery() {
    vi.mocked(convertPdf).mockResolvedValueOnce({
      markdown: "Recovered paper", pageCount: 1, chunkSize: 1,
      chunks: [{ index: 1, startPage: 1, endPage: 1, markdown: "Recovered paper" }], assetCount: 0,
    });
  }

  it("rearms an uploaded timeout with the same job and commits its recovered result", async () => {
    const old = await timedOutUpload("RESUME", "saved-batch");
    vi.mocked(getMineruTaskState).mockResolvedValue("done");
    successfulRecovery();
    const recovered = await recoverConversion({ key: "RESUME", libraryID: 1 }, "ui:new");
    expect(recovered?.jobId).toBe(old.jobId);
    expect(await waitForConversion(old.jobId)).toMatchObject({ state: "ready" });
    expect(vi.mocked(convertPdf).mock.calls.at(-1)?.[3]).toMatchObject({
      resumeOnly: true, remoteTasks: new Map([["full", { taskKey: "full", batchId: "saved-batch", state: "uploaded" }]]),
    });
    expect(MDCache.commitStagedDocument).toHaveBeenCalledWith(old.jobId, "1-RESUME");
  });

  it("prefers an older completed upload over a newer pending duplicate", async () => {
    const old = await timedOutUpload("OLDERDONE", "completed-batch");
    const newer = await timedOutUpload("OLDERDONE", "queued-batch", true);
    vi.mocked(getMineruTaskState).mockImplementation(async task => task.batchId === "completed-batch" ? "done" : "pending");
    successfulRecovery();
    const recovered = await recoverConversion({ key: "OLDERDONE", libraryID: 1 }, "ui:new");
    expect(recovered?.jobId).toBe(old.jobId);
    expect(recovered?.jobId).not.toBe(newer.jobId);
    await waitForConversion(old.jobId);
  });

  it("adding a never-converted document does not upload it", async () => {
    vi.mocked(MDCache.has).mockResolvedValue(false);
    expect(await recoverConversion({ key: "NOUPLOAD", libraryID: 1 }, "ui:new")).toBeNull();
    expect(convertPdf).not.toHaveBeenCalled();
    expect(getMineruTaskState).not.toHaveBeenCalled();
  });

  it("a recovery status failure cannot silently submit a replacement task", async () => {
    await timedOutUpload("PROBEFAIL", "unavailable-batch");
    vi.mocked(convertPdf).mockClear();
    vi.mocked(getMineruTaskState).mockRejectedValue(new Error("MinerU recovery status failed (503)"));
    await expect(startConversion({ key: "PROBEFAIL", libraryID: 1 })).rejects.toThrow("503");
    expect(convertPdf).not.toHaveBeenCalled();
  });

  it("recovery matches conversion options and explicit force starts fresh", async () => {
    await timedOutUpload("OPTIONS", "old-pipeline");
    vi.mocked(convertPdf).mockClear();
    expect(await recoverConversion({ key: "OPTIONS", libraryID: 1, options: { modelVersion: "vlm" } }, "ui:new")).toBeNull();
    expect(getMineruTaskState).not.toHaveBeenCalled();
    successfulRecovery();
    const forced = await startConversion({ key: "OPTIONS", libraryID: 1, force: true });
    await waitForConversion(forced.jobId);
    expect(vi.mocked(convertPdf).mock.calls[0][3]?.remoteTasks?.size).toBe(0);
  });

  it("simultaneous recovery owners share one resumed job", async () => {
    const old = await timedOutUpload("RESUMEOWNERS", "shared-batch");
    vi.mocked(convertPdf).mockClear();
    vi.mocked(getMineruTaskState).mockResolvedValue("pending");
    let finish!: () => void;
    let signal!: AbortSignal;
    vi.mocked(convertPdf).mockImplementationOnce(async (_path, _progress, observed) => {
      signal = observed!;
      await new Promise<void>(resolve => { finish = resolve; });
      return { markdown: "Recovered", pageCount: 1, chunkSize: 1, chunks: [], assetCount: 0 };
    });
    const [a, b] = await Promise.all([
      recoverConversion({ key: "RESUMEOWNERS", libraryID: 1 }, "ui:one"),
      recoverConversion({ key: "RESUMEOWNERS", libraryID: 1 }, "ui:two"),
    ]);
    expect(a?.jobId).toBe(old.jobId);
    expect(b?.jobId).toBe(old.jobId);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(convertPdf).toHaveBeenCalledOnce();
    releaseConversion(old.jobId, "ui:one");
    expect(signal.aborted).toBe(false);
    finish();
    await waitForConversion(old.jobId);
  });
});
