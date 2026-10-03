import { expect, it, vi } from "vitest";
import { emptyConversionDetails } from "../src/modules/conversion-details";
vi.mock("../src/utils/atomic-storage", () => ({ atomicWriteJson: vi.fn(async () => undefined) }));
vi.mock("../src/modules/md-cache", () => ({ getConversionRegistryPath: () => "/cache/conversions/jobs.json", repairDocumentSwaps: vi.fn(), removeConversionStaging: vi.fn() }));
vi.mock("../src/modules/vision-client", () => ({ convertPdfWithVision: vi.fn() }));
import { initializeConversions, getConversion, getConversionDetails } from "../src/modules/conversion-manager";
import { convertPdfWithVision } from "../src/modules/vision-client";

it("restores old cached page ranges and preserves newer request history without starting requests", async () => {
  const date = new Date().toISOString();
  const saved = (jobId: string, details?: any) => ({
    jobId, cacheKey: `1-${jobId}`, request: { key: jobId, libraryID: 1, options: { engine: "mineru" } },
    status: { jobId, state: "ready", stage: "ready", title: "Cached", documentId: `1:${jobId}`, progress: "Ready", error: "", createdAt: date, updatedAt: date, retryable: false, remoteMayContinue: false },
    manifest: { version: 3, key: jobId, title: "Cached", pageCount: 19, chunkSize: 4, updatedAt: Date.now(), chunks: Array.from({ length: 5 }, (_, i) => ({ index: i + 1, startPage: 4 * i + 1, endPage: Math.min(19, 4 * i + 4), status: "ready" })) },
    completedChunks: [1, 2, 3, 4, 5], remoteTasks: {}, details,
  });
  const details = { ...emptyConversionDetails(), requests: [{ id: "persisted", chunk: 1, pages: [1], startedAt: Date.now(), state: "receiving", imageBytes: 10, estimatedInputTokens: 20 }] };
  Object.assign(IOUtils, { exists: vi.fn(async () => true), read: vi.fn(async () => new TextEncoder().encode(JSON.stringify({ version: 1, jobs: [saved("LEGACY"), saved("NEWER", details)] }))) });
  await initializeConversions();
  expect(getConversion("LEGACY")).toMatchObject({ state: "ready", completedPages: 19, totalPages: 19, requestCount: 0 });
  expect(getConversionDetails("LEGACY")?.chunks).toHaveLength(5);
  expect(getConversion("NEWER")).toMatchObject({ requestCount: 1, activeRequests: 0 });
  expect(getConversionDetails("NEWER")?.requests[0]).toMatchObject({ id: "persisted", state: "interrupted" });
  expect(convertPdfWithVision).not.toHaveBeenCalled();
});
