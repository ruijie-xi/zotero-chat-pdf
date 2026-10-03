import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertPdfWithVision, buildVisionRequest } from "../src/modules/vision-client";
import { openPdfRenderer } from "../src/modules/pdf-renderer";
import { getVisionSettings, VisionConversionConfig } from "../src/modules/vision-conversion-config";
import { atomicWrite } from "../src/utils/atomic-storage";
import type { LLMSettings } from "../src/modules/llm-client";
import { webcrypto } from "node:crypto";
import { SELF_CHECK_MARKER } from "../src/modules/vision-self-check";

vi.mock("../src/modules/pdf-renderer", () => ({ openPdfRenderer: vi.fn() }));
vi.mock("../src/modules/vision-conversion-config", () => ({ getVisionSettings: vi.fn() }));
vi.mock("../src/utils/atomic-storage", () => ({ atomicWrite: vi.fn(async () => undefined) }));

const config: VisionConversionConfig = { profile: "Vision", model: "test-vision", apiBase: "https://api.test/v1", chunkPages: 2,
  concurrency: 2, dpi: 150, cachePageImages: true, timeoutSeconds: 30, promptVersion: "page-transcription-v2" };
const settings: LLMSettings = { provider: "custom", model: config.model, apiBase: config.apiBase, apiKey: "test-key", thinkingMode: "enabled", thinkEffort: "max", imageTokenReserve: 4096 };
const close = vi.fn(async () => undefined);
const render = vi.fn(async (page: number) => ({ page, dataUrl: "data:image/jpeg;base64,/9j/2Q==", text: "", width: 100, height: 150, effectiveDpi: 150 }));
const requestedPages = (body: string) => JSON.parse(body).messages[1].content.filter((p: any) => p.type === "text")
  .map((p: any) => /PDF page (\d+):/.exec(p.text)?.[1]).filter(Boolean).map(Number);
const output = (pages: number[], finish = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason: finish,
  message: { content: pages.map(p => `<!-- chatpdf-page:${p} -->\nPage ${p}: $E=mc^2$`).join("\n\n") } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVisionSettings).mockReturnValue(settings);
  vi.mocked(openPdfRenderer).mockResolvedValue({ pageCount: 3, render, close });
  render.mockImplementation(async page => ({ page, dataUrl: "data:image/jpeg;base64,/9j/2Q==", text: "", width: 100, height: 150, effectiveDpi: 150 }));
  Object.assign(PathUtils, { filename: () => "paper.pdf" });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => output(requestedPages(String(init.body)))));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("vision conversion lifecycle", () => {
  it("streams drafts from the original request and validates before saving the chunk", async () => {
    vi.mocked(openPdfRenderer).mockResolvedValue({ pageCount: 1, render, close });
    const onPreview = vi.fn(), onDetail = vi.fn(), onChunkConverted = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); expect(body.stream).toBe(true); expect(body.stream_options).toEqual({ include_usage: true });
      const parts = ["<!-- chatpdf-page:1 -->\n", "# Page\n$E=mc^2$"];
      return new Response(new ReadableStream({ start(controller) {
        for (const content of parts) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":31,"completion_tokens":17}}\n\n')); controller.close();
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }));
    await convertPdfWithVision("paper.pdf", undefined, undefined, { config: { ...config, stream: true }, outputDir: "/staging", onPreview, onDetail, onChunkConverted });
    expect(fetch).toHaveBeenCalledTimes(1); expect(onPreview).toHaveBeenCalled(); expect(onChunkConverted).toHaveBeenCalledTimes(1);
    expect(onDetail.mock.calls.flatMap(([event]) => event.type === "chunk" ? [event.stage] : [])).toContain("receiving");
    expect(onDetail).toHaveBeenCalledWith(expect.objectContaining({ type: "request-update", patch: expect.objectContaining({ state: "accepted", usage: { prompt_tokens: 31, completion_tokens: 17 } }) }));
  });
  it("accepts JSON when a provider ignores stream without issuing a fallback call", async () => {
    vi.mocked(openPdfRenderer).mockResolvedValue({ pageCount: 1, render, close });
    const onPreview = vi.fn();
    await convertPdfWithVision("paper.pdf", undefined, undefined, { config: { ...config, stream: true }, onPreview });
    expect(fetch).toHaveBeenCalledTimes(1); expect(onPreview).toHaveBeenCalled();
  });
  it("splits an omitted cover page, preserves order, caches page assets and reports usage", async () => {
    const requests: number[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const pages = requestedPages(String(init.body)); requests.push(pages);
      return output(pages.length > 1 ? pages.slice(1) : pages);
    }));
    const onChunkConverted = vi.fn(), onUsage = vi.fn();
    const pdfData = new Uint8Array([1, 2, 3]);
    const result = await convertPdfWithVision("paper.pdf", undefined, undefined, { config, outputDir: "/staging", onChunkConverted, onUsage, pdfData });
    expect(openPdfRenderer).toHaveBeenCalledWith("paper.pdf", expect.any(AbortSignal), pdfData);
    expect(result.chunks.map(c => c.index)).toEqual([1, 2]);
    expect(requests).toContainEqual([1]); expect(requests).toContainEqual([2]);
    expect(result.markdown).toContain("<!-- chatpdf-page:1 -->");
    expect(atomicWrite).toHaveBeenCalledTimes(3);
    expect(vi.mocked(atomicWrite).mock.calls[0][0]).toContain("attachments/pages/page-0001.jpg");
    expect(result.assetCount).toBe(3); expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ prompt_tokens: 400 }));
    expect(onChunkConverted).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalled();
  });
  it("does not accept single-page truncation even when the visible content is nonempty", async () => {
    vi.mocked(openPdfRenderer).mockResolvedValue({ pageCount: 1, render, close });
    vi.stubGlobal("fetch", vi.fn(async () => output([1], "length")));
    const onChunkConverted = vi.fn();
    await expect(convertPdfWithVision("paper.pdf", undefined, undefined, { config, outputDir: "/staging", onChunkConverted })).rejects.toThrow("truncated");
    expect(fetch).toHaveBeenCalledTimes(2); expect(onChunkConverted).not.toHaveBeenCalled(); expect(close).toHaveBeenCalled();
  });
  it("reuses validated chunks and resume-only never sends page images to the provider", async () => {
    const cachedChunks = new Map([[1, "<!-- chatpdf-page:1 -->\nSaved 1\n<!-- chatpdf-page:2 -->\nSaved 2"], [2, "<!-- chatpdf-page:3 -->\nSaved 3"]]);
    const result = await convertPdfWithVision("paper.pdf", undefined, undefined, { config, outputDir: "/staging", cachedChunks, resumeOnly: true });
    expect(result.markdown).toContain("Saved 3"); expect(fetch).not.toHaveBeenCalled();
    await expect(convertPdfWithVision("paper.pdf", undefined, undefined, { config, outputDir: "/staging", resumeOnly: true })).rejects.toThrow("Retry");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels in-flight API work without late chunk writes", async () => {
    const controller = new AbortController(), started = Promise.withResolvers<void>();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      started.resolve(); init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
    })));
    const onChunkConverted = vi.fn();
    const pending = convertPdfWithVision("paper.pdf", undefined, controller.signal, { config, outputDir: "/staging", onChunkConverted });
    await started.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(onChunkConverted).not.toHaveBeenCalled(); expect(close).toHaveBeenCalled();
  });
  it("retries 429 using Retry-After and never retries a permanent authentication failure", async () => {
    vi.useFakeTimers();
    vi.mocked(openPdfRenderer).mockResolvedValue({ pageCount: 1, render, close });
    let first = true;
    vi.stubGlobal("fetch", vi.fn(async () => { if (first) { first = false; return new Response("", { status: 429, headers: { "Retry-After": "1" } }); } return output([1]); }));
    const pending = convertPdfWithVision("paper.pdf", undefined, undefined, { config, outputDir: "/staging" });
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret echoed by API", { status: 401 })));
    await expect(convertPdfWithVision("paper.pdf", undefined, undefined, { config, outputDir: "/staging" })).rejects.toThrow("HTTP 401");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps provider-specific thinking fields out of unrelated endpoints", () => {
    expect(buildVisionRequest(settings, [], 8000)).not.toHaveProperty("thinking");
    expect(buildVisionRequest({ ...settings, apiBase: "https://api.deepseek.com/v1" }, [], 8000)).toMatchObject({ thinking: { type: "disabled" } });
    expect(buildVisionRequest({ ...settings, apiBase: "https://api.openai.com/v1", model: "gpt-5" }, [], 8000)).toMatchObject({ max_completion_tokens: 8000 });
  });
  it("retries a valid but misread Greek symbol with explicit validation feedback", async () => {
    vi.mocked(openPdfRenderer).mockResolvedValue({ pageCount: 1, render, close });
    render.mockImplementation(async page => ({ page, dataUrl: "data:image/jpeg;base64,/9j/2Q==", text: "ν ν ν", width: 100, height: 150, effectiveDpi: 150 }));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const corrected = body.messages[1].content[0].text.includes("Greek symbol ν");
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: `<!-- chatpdf-page:1 -->\n$${corrected ? "\\nu+\\nu+\\nu" : "v+v+v"}$` } }] }));
    }));
    const onChunkConverted = vi.fn();
    const result = await convertPdfWithVision("paper.pdf", undefined, undefined, { config, outputDir: "/staging", onChunkConverted });
    expect(fetch).toHaveBeenCalledTimes(2); expect(onChunkConverted).toHaveBeenCalledTimes(1);
    expect(result.markdown).toContain("\\nu+\\nu+\\nu");
  });
  it("receives local edits in the original response without another request and reuses the checked chunk", async () => {
    vi.mocked(openPdfRenderer).mockResolvedValue({ pageCount: 1, render, close });
    vi.mocked(Zotero.getMainWindow).mockReturnValue({ atob: window.atob.bind(window), crypto: webcrypto } as any);
    const checkedConfig = { ...config, promptVersion: "page-transcription-v3", selfCheck: true };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.messages).toHaveLength(2);
      expect(body.messages[1].content[0].text).toContain(SELF_CHECK_MARKER);
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
        content: `<!-- chatpdf-page:1 -->\n$X=\\Omega^\\flat(DH)$\n${SELF_CHECK_MARKER}\n${JSON.stringify({ edits: [{ page: 1, old: "\\flat", new: "\\sharp" }] })}`,
      } }] }));
    }));
    const result = await convertPdfWithVision("paper.pdf", undefined, undefined, { config: checkedConfig, outputDir: "/staging" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.markdown).toContain("\\Omega^\\sharp");
    expect(result.markdown).not.toContain(SELF_CHECK_MARKER);
    expect(result.chunks[0].selfCheck).toMatchObject({ pages: [1], editsApplied: 1 });
    const reuse = { config: checkedConfig, outputDir: "/staging", resumeOnly: true,
      cachedChunks: new Map([[1, result.chunks[0].markdown]]), cachedSelfChecks: new Map([[1, result.chunks[0].selfCheck!]]) };
    await convertPdfWithVision("paper.pdf", undefined, undefined, reuse);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(convertPdfWithVision("paper.pdf", undefined, undefined, { ...reuse, cachedChunks: new Map([[1, result.chunks[0].markdown + " edited"]]) })).rejects.toThrow("Retry");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("revalidates corrected formula syntax and never commits an unsafe self-check edit", async () => {
    vi.mocked(openPdfRenderer).mockResolvedValue({ pageCount: 1, render, close });
    const checkedConfig = { ...config, promptVersion: "page-transcription-v3", selfCheck: true };
    const onChunkConverted = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
      content: `<!-- chatpdf-page:1 -->\n$E=mc^2$\n${SELF_CHECK_MARKER}\n${JSON.stringify({ edits: [{ page: 1, old: "mc^2", new: "\\unknowncommand" }] })}`,
    } }] }))));
    await expect(convertPdfWithVision("paper.pdf", undefined, undefined, { config: checkedConfig, outputDir: "/staging", onChunkConverted })).rejects.toThrow("KaTeX");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onChunkConverted).not.toHaveBeenCalled();
  });
});
