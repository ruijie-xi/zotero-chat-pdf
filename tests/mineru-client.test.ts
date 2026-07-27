import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/prefs", () => ({
  getPref: vi.fn((key: string) => key === "mineruToken" ? "test-token" : undefined),
}));

vi.mock("pdf-lib", () => ({
  PDFDocument: {
    load: vi.fn(async () => ({ getPageCount: () => 1 })),
  },
}));

import { convertPdf } from "../src/modules/mineru-client";

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
});
