import { beforeEach, describe, expect, it, vi } from "vitest";
import { startConversion, waitForConversion } from "../src/modules/conversion-manager";
import { convertPdfWithVision } from "../src/modules/vision-client";
import { convertPdf } from "../src/modules/mineru-client";
import * as MDCache from "../src/modules/md-cache";
import { mergeChunks } from "../src/modules/pdf-conversion";
import { webcrypto } from "node:crypto";
import { getConversionDetails, getConversion } from "../src/modules/conversion-manager";

vi.mock("../src/utils/atomic-storage", () => ({ atomicWriteJson: vi.fn(async () => undefined) }));
vi.mock("../src/modules/vision-client", () => ({ convertPdfWithVision: vi.fn() }));
vi.mock("../src/modules/mineru-client", () => ({ convertPdf: vi.fn(), getMineruTaskState: vi.fn(), MINERU_LONG_PDF_CHUNK_SIZE: 25 }));
vi.mock("../src/modules/md-cache", () => ({
  has: vi.fn(), readManifest: vi.fn(), writeManifestForExistingDocument: vi.fn(), readChunk: vi.fn(),
  getConversionRegistryPath: () => "/cache/conversions/jobs.json", getConversionStagingDir: (id: string) => `/staging/${id}`,
  prepareConversionStaging: vi.fn(), readStagedChunks: vi.fn(), writeStagedChunk: vi.fn(),
  finalizeStagedDocument: vi.fn(), commitStagedDocument: vi.fn(), repairDocumentSwaps: vi.fn(), removeConversionStaging: vi.fn(),
  readFinalizedStaging: vi.fn(),
}));
vi.mock("../src/modules/panel-state", () => ({ createAbortController: () => { const controller = new AbortController(); return { controller, signal: controller.signal }; } }));
const vision = { profile: "", model: "vision", apiBase: "https://api.test/v1", chunkPages: 1, concurrency: 2, dpi: 150, cachePageImages: true, timeoutSeconds: 180, promptVersion: "page-transcription-v2" };
const options = { engine: "vision" as const, vision };
const chunks = [{ index: 1, startPage: 1, endPage: 1, markdown: "<!-- chatpdf-page:1 -->\ncover", assetCount: 1 },
  { index: 2, startPage: 2, endPage: 2, markdown: "<!-- chatpdf-page:2 -->\nbody", assetCount: 1 }];
const oldManifest = { version: 3, key: "ATT", converter: "mineru" as const, pageCount: 2, chunkSize: 2, chunks: [], updatedAt: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(IOUtils, { exists: vi.fn(async () => false), read: vi.fn(async () => new Uint8Array([1, 2, 3])) });
  vi.mocked(Zotero.getMainWindow).mockReturnValue({ crypto: { subtle: { digest: async () => new Uint8Array(32).buffer } } } as any);
  Object.assign(Zotero.Libraries, { get: vi.fn(() => ({ libraryType: "user" })) });
  vi.mocked(Zotero.Items.getByLibraryAndKey).mockImplementation((_id, key) => ({ key, isAttachment: () => true, getFilePathAsync: async () => "/paper.pdf", getField: () => "Paper" }) as any);
  vi.mocked(MDCache.has).mockResolvedValue(false); vi.mocked(MDCache.readManifest).mockResolvedValue(oldManifest);
  vi.mocked(MDCache.readStagedChunks).mockResolvedValue(new Map());
});
async function success(_path: string, _progress: any, _signal: any, opts: any) {
  await opts.onPlan(2, 1, chunks); for (const chunk of chunks) await opts.onChunkConverted(chunk);
  return { markdown: mergeChunks("paper.pdf", 2, chunks), pageCount: 2, chunkSize: 1, chunks, assetCount: 2 };
}
describe("conversion manager vision integration", () => {
  it.each([false, true])("retries only a trusted finalized cache write; tamper=%s", async tamper => {
    vi.mocked(Zotero.getMainWindow).mockReturnValue({ crypto: webcrypto } as any);
    const digest = async (text: string) => Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");
    const checked = await Promise.all(chunks.map(async chunk => ({ ...chunk, selfCheck: { method: "same-response" as const, version: 1 as const,
      pages: [chunk.startPage], editsApplied: 0, edits: [], markdownDigest: await digest(chunk.markdown) } })));
    const checkedOptions = { ...options, vision: { ...vision, promptVersion: "page-transcription-v3", selfCheck: true, stream: true } };
    vi.mocked(convertPdfWithVision).mockImplementation(async (_path, _progress, _signal, opts) => {
      await opts.onPlan!(2, 1, checked);
      opts.onDetail!({ type: "request", request: { id: "initial", chunk: 1, pages: [1, 2], startedAt: Date.now(), state: "waiting", estimatedInputTokens: 200, imageBytes: 10 } });
      opts.onUsage!({ prompt_tokens: 100, completion_tokens: 50 });
      for (const chunk of checked) {
        await opts.onChunkConverted!(chunk);
        opts.onDetail!({ type: "chunk", chunk: chunk.index, stage: "ready" });
      }
      return { markdown: mergeChunks("paper.pdf", 2, checked), pageCount: 2, chunkSize: 1, chunks: checked, assetCount: 2 };
    });
    vi.mocked(MDCache.commitStagedDocument).mockRejectedValueOnce(new Error("Cache swap blocked (NS_ERROR_FILE_ACCESS_DENIED)"));
    const first = await startConversion({ key: `COMMITONLY${tamper}`, libraryID: 1, force: true, options: checkedOptions });
    const failed = await waitForConversion(first.jobId);
    expect(failed).toMatchObject({ state: "error", stage: "commit", progressPercent: 99, completedPages: 2, requestCount: 1 });
    const finalized = vi.mocked(MDCache.finalizeStagedDocument).mock.lastCall!;
    vi.mocked(MDCache.readFinalizedStaging).mockResolvedValue({ markdown: finalized[1], manifest: finalized[2] });
    vi.mocked(MDCache.readStagedChunks).mockResolvedValue(new Map(checked.map(chunk => [chunk.index, chunk.markdown + (tamper && chunk.index === 1 ? " changed" : "")])));
    const retry = await startConversion({ key: `COMMITONLY${tamper}`, libraryID: 1, options: { ...checkedOptions, vision: { ...checkedOptions.vision, stream: false } } });
    const finished = await waitForConversion(retry.jobId);
    expect(retry.jobId).toBe(first.jobId);
    expect(convertPdfWithVision).toHaveBeenCalledTimes(1);
    expect(finished.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 50 });
    if (tamper) {
      expect(finished.state).toBe("interrupted"); expect(finished.error).toContain("changed after validation");
      expect(MDCache.commitStagedDocument).toHaveBeenCalledTimes(1);
    } else {
      expect(getConversion(retry.jobId)).toMatchObject({ state: "ready", progressPercent: 100, reusedPages: 2, requestCount: 1 });
      expect(getConversionDetails(retry.jobId)?.events.some(e => e.message.includes("without rendering or model requests"))).toBe(true);
      expect(MDCache.commitStagedDocument).toHaveBeenCalledTimes(2);
    }
  });
  it("switches engines with a fresh staging directory and a complete cache contract", async () => {
    vi.mocked(convertPdfWithVision).mockImplementation(success);
    const status = await startConversion({ key: "VISIONNEW", libraryID: 1, force: true, options });
    expect((await waitForConversion(status.jobId)).state).toBe("ready");
    expect(convertPdf).not.toHaveBeenCalled();
    expect(vi.mocked(convertPdfWithVision).mock.lastCall![3].pdfData).toEqual(new Uint8Array([1, 2, 3]));
    expect(MDCache.prepareConversionStaging).toHaveBeenCalledWith(status.jobId, undefined, undefined);
    expect(MDCache.finalizeStagedDocument).toHaveBeenCalledWith(status.jobId, expect.any(String), expect.objectContaining({
      converter: "vision", sourceDigest: "0".repeat(64), qualityGate: "page-markers-text-symbols-katex-v2",
      chunks: [expect.objectContaining({ index: 1, status: "ready", lineStart: 5, charCount: chunks[0].markdown.length }), expect.objectContaining({ index: 2, status: "ready" })],
    }));
    expect(MDCache.commitStagedDocument).toHaveBeenCalledTimes(1);
  });
  it("keeps the old cache on failure and Retry resumes the saved forced conversion", async () => {
    vi.mocked(convertPdfWithVision).mockImplementation(async (_p, _cb, _s, opts) => {
      await opts.onPlan!(2, 1, chunks); await opts.onChunkConverted!(chunks[0]); throw new Error("Second page failed validation");
    });
    const failed = await startConversion({ key: "VISIONRETRY", libraryID: 1, force: true, options });
    expect((await waitForConversion(failed.jobId)).state).toBe("error"); expect(MDCache.commitStagedDocument).not.toHaveBeenCalled();
    vi.mocked(MDCache.has).mockResolvedValue(true);
    vi.mocked(MDCache.readStagedChunks).mockResolvedValue(new Map([[1, chunks[0].markdown]]));
    vi.mocked(convertPdfWithVision).mockImplementation(success);
    const retry = await startConversion({ key: "VISIONRETRY", libraryID: 1, options });
    expect(retry.jobId).toBe(failed.jobId); expect((await waitForConversion(retry.jobId)).state).toBe("ready");
    expect(vi.mocked(convertPdfWithVision).mock.lastCall![3].cachedChunks?.get(1)).toBe(chunks[0].markdown);
  });
  it("refuses a mismatched merged document before replacing the old cache", async () => {
    vi.mocked(convertPdfWithVision).mockImplementation(async (...args) => ({ ...await success(...args), markdown: "wrong document" }));
    const status = await startConversion({ key: "VISIONBAD", libraryID: 1, force: true, options });
    expect((await waitForConversion(status.jobId)).state).toBe("error"); expect(MDCache.commitStagedDocument).not.toHaveBeenCalled();
  });
  it("reads a completed cache without reopening or retranscribing the PDF", async () => {
    vi.mocked(convertPdfWithVision).mockImplementation(success);
    const first = await startConversion({ key: "VISIONCACHED", libraryID: 1, options });
    expect((await waitForConversion(first.jobId)).state).toBe("ready");
    vi.mocked(MDCache.has).mockResolvedValue(true);
    const cached = await startConversion({ key: "VISIONCACHED", libraryID: 1, options });
    expect(cached.state).toBe("ready");
    expect(convertPdfWithVision).toHaveBeenCalledTimes(1);
  });
  it("records the self-check gate and requires complete check metadata before committing", async () => {
    const checkedOptions = { ...options, vision: { ...vision, promptVersion: "page-transcription-v3", selfCheck: true } };
    vi.mocked(convertPdfWithVision).mockImplementation(success);
    const missing = await startConversion({ key: "VISIONUNCHECKED", libraryID: 1, force: true, options: checkedOptions });
    expect((await waitForConversion(missing.jobId)).state).toBe("error");
    expect(MDCache.commitStagedDocument).not.toHaveBeenCalled();
    vi.mocked(convertPdfWithVision).mockImplementation(async (...args) => {
      const result = await success(...args);
      result.chunks = result.chunks.map(chunk => ({ ...chunk, selfCheck: { method: "same-response" as const, version: 1 as const,
        pages: [chunk.startPage], editsApplied: 0, edits: [], markdownDigest: "0".repeat(64) } }));
      return result;
    });
    const checked = await startConversion({ key: "VISIONCHECKED", libraryID: 1, force: true, options: checkedOptions });
    expect((await waitForConversion(checked.jobId)).state).toBe("ready");
    expect(MDCache.finalizeStagedDocument).toHaveBeenCalledWith(checked.jobId, expect.any(String), expect.objectContaining({
      qualityGate: "page-markers-text-symbols-katex-self-check-v3", chunks: expect.arrayContaining([expect.objectContaining({ selfCheck: expect.objectContaining({ pages: [1] }) })]),
    }));
  });
  it("rejects changed PDF bytes before reusing saved chunks or making another request", async () => {
    vi.mocked(convertPdfWithVision).mockImplementation(async (_p, _cb, _s, opts) => {
      await opts.onPlan!(2, 1, chunks); await opts.onChunkConverted!(chunks[0]); throw new Error("Second page failed");
    });
    const first = await startConversion({ key: "VISIONCHANGED", libraryID: 1, force: true, options });
    expect((await waitForConversion(first.jobId)).state).toBe("error");
    vi.mocked(Zotero.getMainWindow).mockReturnValue({ crypto: { subtle: { digest: async () => new Uint8Array(32).fill(1).buffer } } } as any);
    const retry = await startConversion({ key: "VISIONCHANGED", libraryID: 1, options });
    const stopped = await waitForConversion(retry.jobId);
    expect(stopped.state).toBe("interrupted"); expect(stopped.error).toContain("PDF changed");
    expect(convertPdfWithVision).toHaveBeenCalledTimes(1); expect(MDCache.commitStagedDocument).not.toHaveBeenCalled();
  });
});
