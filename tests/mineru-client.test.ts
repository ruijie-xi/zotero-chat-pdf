import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/prefs", () => ({
  getPref: vi.fn((key: string) => key === "mineruToken" ? "test-token" : undefined),
}));

vi.mock("pdf-lib", () => ({
  PDFDocument: {
    load: vi.fn(async () => ({ getPageCount: () => 1 })),
  },
}));

import { convertPdf, getMineruTaskState } from "../src/modules/mineru-client";

describe("MinerU client cancellation", () => {
  beforeEach(() => {
    Object.assign(PathUtils, { filename: (path: string) => path.split("/").pop() || path });
    Object.assign(IOUtils, { read: vi.fn(async () => new Uint8Array([1, 2, 3])) });
  });

  it("preserves AbortError while a MinerU network request is in flight", async () => {
    const controller = new AbortController();
    const requestStarted = Promise.withResolvers<void>();
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestStarted.resolve();
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), { once: true });
    })) as typeof fetch;

    const conversion = convertPdf("/pdf/paper.pdf", undefined, controller.signal);
    await requestStarted.promise;
    controller.abort();

    await expect(conversion).rejects.toMatchObject({ name: "AbortError" });
  });

  it("automatic recovery refuses to upload a PDF without a saved upload", async () => {
    globalThis.fetch = vi.fn();
    await expect(convertPdf("/pdf/paper.pdf", undefined, undefined, { resumeOnly: true }))
      .rejects.toThrow("No uploaded MinerU task");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks a saved task using only a GET and reports its remote state", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      code: 0, data: { extract_result: [{ state: "done" }] },
    }))) as typeof fetch;
    expect(await getMineruTaskState({ taskKey: "full", batchId: "saved-batch", state: "uploaded" })).toBe("done");
    expect(fetch).toHaveBeenCalledWith("https://mineru.net/api/v4/extract-results/batch/saved-batch", expect.objectContaining({
      headers: { Authorization: "Bearer test-token" },
    }));
  });

  it("recovery status HTTP errors stay visible", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Unavailable", { status: 503 })) as typeof fetch;
    await expect(getMineruTaskState({ taskKey: "full", batchId: "saved-batch", state: "uploaded" }))
      .rejects.toThrow("503");
  });
});
