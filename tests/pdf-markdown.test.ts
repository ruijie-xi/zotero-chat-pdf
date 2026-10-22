import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
vi.mock("../src/modules/pdf-text", async original => ({ ...await original<typeof import("../src/modules/pdf-text")>(),
  readPdfInfo: vi.fn(), getPdfFileRevision: vi.fn(), readPdfPage: vi.fn(),
}));
vi.mock("../src/modules/pdf-transcription", async original => ({ ...await original<typeof import("../src/modules/pdf-transcription")>(), transcribePdfPage: vi.fn() }));
vi.mock("../src/modules/debug-log", () => ({ logPdfReading: vi.fn(), logLLMTransportFailure: vi.fn() }));
import { readPdfInfo, getPdfFileRevision, readPdfPage } from "../src/modules/pdf-text";
import { transcribePdfPage } from "../src/modules/pdf-transcription";
import { readPdfMarkdown, cancelPdfConversions } from "../src/modules/pdf-markdown";
import type { LLMSettings } from "../src/modules/llm-client";

const item = { key: "PDF12345", libraryID: 1 } as Zotero.Item;
const files = new Map<string, Uint8Array>();
const settings: LLMSettings = { apiBase: "https://example.test/v1", apiKey: "private-test-key", model: "chat-vision",
  thinkingMode: "enabled", thinkEffort: "max", sessionId: "shared-session-123" };
let revision: string, preferences: Record<string, unknown>;
const path = (page: number) => `/cache/pdf-markdown/1-PDF12345/page-${page}.json`;
const read = (pages: number[], context = {}) => readPdfMarkdown(item, { pages }, { settings, ...context });
beforeEach(() => {
  vi.clearAllMocks(); files.clear(); revision = "revision-1";
  preferences = { cacheDir: "/cache", debugLogMode: "off" };
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => preferences[String(key).split(".").at(-1)!] as never);
  vi.mocked(Zotero.getMainWindow).mockReturnValue({ crypto: webcrypto, AbortController } as any);
  Object.assign(IOUtils, { read: vi.fn(async (p: string) => { if (!files.has(p)) throw Error("Missing"); return files.get(p); }),
    exists: vi.fn(async (p: string) => files.has(p)), makeDirectory: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    write: vi.fn(async (p: string, data: Uint8Array) => { files.set(p, data); }) });
  vi.mocked(readPdfInfo).mockImplementation(async () => ({ path: "/paper.pdf", stamp: revision, pageCount: 5 }));
  vi.mocked(getPdfFileRevision).mockImplementation(async () => ({ path: "/paper.pdf", stamp: revision }));
  vi.mocked(readPdfPage).mockImplementation(async (_item, page) => ({ page, pageCount: 5, dataUrl: "data:image/jpeg;base64,AA==",
    text: "", width: 2550, height: 3300, effectiveDpi: 300 }));
  vi.mocked(transcribePdfPage).mockImplementation(async (image, config, sourceId, _signal, usage) => {
    usage({ sourceId, page: image.page, model: config.model, attempt: 1, durationMs: 1, usage: { prompt_tokens: 100, completion_tokens: 20 } });
    return { markdown: `Page ${image.page}: $a_b$`, attempts: 1, usage: { prompt_tokens: 100, completion_tokens: 20 } };
  });
});
afterEach(() => { cancelPdfConversions(); vi.mocked(Zotero.Prefs.get).mockReset(); });

describe("on-demand page Markdown cache", () => {
  it("transcribes only requested pages, preserves order, and never persists credentials or images", async () => {
    const onUsage = vi.fn(), result = await read([3, 1], { onUsage });
    expect(result.pages.map(page => page.pdf_page)).toEqual([3, 1]);
    expect(result.next_page).toBe(4);
    expect(result.pages.every(page => page.cache === "saved" && page.status === "transcribed")).toBe(true);
    expect(readPdfPage).toHaveBeenCalledTimes(2);
    expect(readPdfPage).toHaveBeenCalledWith(item, 3, expect.anything(), 300);
    expect(transcribePdfPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ thinkingMode: "disabled", thinkEffort: "default", model: "chat-vision" }), "1:PDF12345", expect.anything(), expect.any(Function));
    expect(onUsage).toHaveBeenCalledTimes(2);
    for (const bytes of files.values()) expect(new TextDecoder().decode(bytes)).not.toMatch(/private-test-key|base64|apiKey/);
    expect(IOUtils.write).toHaveBeenCalledWith(path(3), expect.anything(), expect.objectContaining({ tmpPath: expect.stringContaining(".tmp-"), flush: true }));
  });
  it("reuses valid caches after model/profile changes with zero rendering, model calls or new charges", async () => {
    await read([1, 2]);
    vi.mocked(readPdfPage).mockClear(); vi.mocked(transcribePdfPage).mockClear();
    preferences.pdfTranscriptionProfile = "Deleted profile";
    const onUsage = vi.fn();
    const result = await read([2, 1], { settings: { ...settings, model: "another", apiKey: "" }, onUsage });
    expect(result.pages.map(page => page.cache)).toEqual(["hit", "hit"]);
    expect(readPdfPage).not.toHaveBeenCalled(); expect(transcribePdfPage).not.toHaveBeenCalled(); expect(onUsage).not.toHaveBeenCalled();
  });
  it("keeps successful siblings and retries only the failed page on the next read", async () => {
    vi.mocked(transcribePdfPage).mockRejectedValueOnce(new Error("Service rejected page"));
    const first = await read([1, 2, 3]);
    expect(first.pages.map(page => page.status)).toEqual(["error", "transcribed", "transcribed"]);
    expect(files.has(path(1))).toBe(false);
    vi.mocked(transcribePdfPage).mockClear();
    const retry = await read([1, 2, 3]);
    expect(retry.pages.map(page => page.cache)).toEqual(["saved", "hit", "hit"]);
    expect(transcribePdfPage).toHaveBeenCalledTimes(1);
  });
  it("invalidates changed files and corrupted cache bodies, and refreshes only explicit pages", async () => {
    await read([1, 2]);
    const cached = JSON.parse(new TextDecoder().decode(files.get(path(1))));
    cached.markdown = "modified cache";
    files.set(path(1), new TextEncoder().encode(JSON.stringify(cached)));
    vi.mocked(transcribePdfPage).mockClear();
    expect((await read([1, 2])).pages.map(page => page.cache)).toEqual(["saved", "hit"]);
    expect(transcribePdfPage).toHaveBeenCalledTimes(1);
    await readPdfMarkdown(item, { page: 2, refresh: true }, { settings });
    expect(transcribePdfPage).toHaveBeenCalledTimes(2);
    revision = "revision-2";
    expect((await read([1, 2])).pages.every(page => page.cache === "saved")).toBe(true);
    expect(transcribePdfPage).toHaveBeenCalledTimes(4);
  });
  it("does not cache or deliver a transcription when the PDF changes during conversion", async () => {
    vi.mocked(transcribePdfPage).mockImplementationOnce(async () => { revision = "new-file"; return { markdown: "old page", attempts: 1 }; });
    await expect(read([1])).rejects.toThrow("PDF changed");
    expect(files.has(path(1))).toBe(false);
  });
  it("returns usable uncached text if atomic persistence fails, and leaves previous cache intact", async () => {
    await read([1]); const previous = files.get(path(1));
    vi.mocked(IOUtils.write).mockRejectedValueOnce(new Error("Disk full"));
    const result = await readPdfMarkdown(item, { page: 1, refresh: true }, { settings });
    expect(result.pages[0]).toMatchObject({ status: "transcribed", cache: "not-saved", markdown: "Page 1: $a_b$", cache_warning: expect.stringContaining("Disk full") });
    expect(files.get(path(1))).toBe(previous);
  });
  it("shares one conversion and charge while cancellation detaches only the cancelling reader", async () => {
    let finish!: () => void; let sharedSignal: AbortSignal | undefined;
    vi.mocked(transcribePdfPage).mockImplementationOnce(async (image, config, sourceId, signal, usage) => {
      sharedSignal = signal;
      await new Promise<void>(resolve => { finish = resolve; });
      usage({ sourceId, page: image.page, model: config.model, attempt: 1, durationMs: 1, usage: { prompt_tokens: 100 } });
      return { markdown: "shared result", attempts: 1 };
    });
    const controller = new AbortController(), firstUsage = vi.fn(), secondUsage = vi.fn();
    const first = read([1], { signal: controller.signal, onUsage: firstUsage });
    const rejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const second = read([1], { onUsage: secondUsage });
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort(); await rejection;
    expect(sharedSignal!.aborted).toBe(false);
    finish();
    expect((await second).pages[0]).toMatchObject({ delivery: "shared", markdown: "shared result" });
    expect(transcribePdfPage).toHaveBeenCalledTimes(1);
    expect(firstUsage).not.toHaveBeenCalled(); expect(secondUsage).toHaveBeenCalledTimes(1);
  });
  it("limits conversions to two and cancels queued and active work when their last reader leaves", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(transcribePdfPage).mockImplementation(async (_image, _config, _id, signal) => {
      signals.push(signal);
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("Stopped"), { name: "AbortError" })), { once: true }));
      return { markdown: "unreachable", attempts: 1 };
    });
    const controller = new AbortController();
    const pending = read([1, 2, 3, 4], { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    controller.abort(); await rejection;
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(transcribePdfPage).toHaveBeenCalledTimes(2);
    expect(files.size).toBe(0);
  });
  it("validates page selection before rendering or model access", async () => {
    await expect(read([1, 1])).rejects.toThrow("unique");
    await expect(read([6])).rejects.toThrow("page count");
    expect(readPdfPage).not.toHaveBeenCalled(); expect(transcribePdfPage).not.toHaveBeenCalled();
  });
});
