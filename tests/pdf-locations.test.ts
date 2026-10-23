import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
vi.mock("../src/modules/pdf-renderer", () => ({ openPdfRenderer: vi.fn() }));
vi.mock("../src/modules/pdf-text", () => ({ getPdfFileRevision: vi.fn(), readPdfText: vi.fn() }));
import { openPdfRenderer } from "../src/modules/pdf-renderer";
import { getPdfFileRevision, readPdfText } from "../src/modules/pdf-text";
import { locatePdfContent, resolvePdfCitationLocation } from "../src/modules/pdf-locations";

const files = new Map<string, Uint8Array>();
const item = { key: "PDF12345", libraryID: 1 } as any;
let stamp: string;
const layout = (page: number) => ({ page, pageLabel: String(page + 5), viewBox: [0, 0, 600, 800],
  viewport: { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }, styles: { f: { ascent: 0.8 } },
  items: page === 3 ? [] : [{ str: "Energy conservation", transform: [10, 0, 0, 10, 50, 700], width: 120, height: 10, fontName: "f", hasEOL: true }] });
const renderer = { pageCount: 3, layout: vi.fn(async page => layout(page)), close: vi.fn(async () => {}) };
beforeEach(() => {
  vi.clearAllMocks(); files.clear(); stamp = "file:1";
  vi.mocked(Zotero.getMainWindow).mockReturnValue({ crypto: webcrypto } as any);
  vi.mocked(Zotero.Prefs.get).mockReturnValue("/cache" as never);
  vi.mocked(getPdfFileRevision).mockImplementation(async () => ({ path: "/paper.pdf", stamp }));
  vi.mocked(readPdfText).mockResolvedValue({ version: 1, stamp, origin: "pdfjs", pageCount: 3, indexedPages: 3,
    pages: [{ page: 1, text: "Other text" }, { page: 2, text: "Energy\nconservation" }, { page: 3, text: "" }] });
  vi.mocked(openPdfRenderer).mockResolvedValue(renderer as any);
  Object.assign(IOUtils, { read: vi.fn(async path => files.get(path)), exists: vi.fn(async path => files.has(path)),
    makeDirectory: vi.fn(async () => {}), remove: vi.fn(async () => {}), write: vi.fn(async (path, value) => { files.set(path, value); }) });
});
describe("local PDF content locator", () => {
  it("extracts only candidate coordinates, shares the cache and invalidates it after revision changes", async () => {
    const result = await locatePdfContent(item, { query: "energy conservation" });
    expect(result).toMatchObject({ candidate_pages: [2], pages_without_text: [3], total_matches: 1 });
    expect(renderer.layout).toHaveBeenCalledExactlyOnceWith(2);
    expect(renderer.close).toHaveBeenCalledOnce();
    const warm = await locatePdfContent(item, { query: "energy conservation" });
    expect(warm).toEqual(result); expect(openPdfRenderer).toHaveBeenCalledOnce();
    stamp = "file:2"; await locatePdfContent(item, { query: "energy conservation" });
    expect(renderer.layout).toHaveBeenCalledTimes(2);
    await expect(resolvePdfCitationLocation(item, 2, { rects: result.matches[0].rects, revision: result.revision })).rejects.toThrow("changed");
  });
  it("bypasses whole-document search for a known page, including empty pages and missing text", async () => {
    expect((await locatePdfContent(item, { query: "energy", page: 2 })).total_matches).toBe(1);
    expect((await locatePdfContent(item, { query: "energy", page: 3 })).pages_without_text).toEqual([3]);
    expect(readPdfText).not.toHaveBeenCalled();
    await expect(locatePdfContent(item, { query: "energy", page: 4 })).rejects.toThrow("page count");
  });
  it("rejects empty queries before I/O and preserves cancellation during cache reads", async () => {
    await expect(locatePdfContent(item, { query: "\u00ad" })).rejects.toThrow("searchable");
    expect(openPdfRenderer).not.toHaveBeenCalled();
    await locatePdfContent(item, { query: "energy", page: 2 });
    const controller = new AbortController();
    vi.mocked(IOUtils.read).mockImplementationOnce(async path => { controller.abort(); return files.get(path)!; });
    await expect(locatePdfContent(item, { query: "energy", page: 2 }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("never caches cancelled extraction and cleans up its renderer", async () => {
    const controller = new AbortController();
    renderer.layout.mockImplementationOnce(async page => { controller.abort(); return layout(page); });
    await expect(locatePdfContent(item, { query: "energy", page: 2 }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(IOUtils.write).not.toHaveBeenCalled(); expect(renderer.close).toHaveBeenCalledOnce();
  });
  it("rejects changed files before delivery and repairs malformed cache entries", async () => {
    await locatePdfContent(item, { query: "energy", page: 2 });
    for (const key of files.keys()) files.set(key, new TextEncoder().encode('{"version":1}'));
    await locatePdfContent(item, { query: "energy", page: 2 });
    expect(renderer.layout).toHaveBeenCalledTimes(2);
    renderer.layout.mockImplementationOnce(async page => { stamp = "changed"; return layout(page); });
    await expect(locatePdfContent(item, { query: "energy", page: 1 })).rejects.toThrow("changed");
  });
  it("converts crop regions to reader coordinates and rejects rectangles outside the page", async () => {
    const result = await resolvePdfCitationLocation(item, 2, { region: { x: 0.1, y: 0.25, width: 0.5, height: 0.25 } });
    expect(result).toEqual({ position: { pageIndex: 1, rects: [[60, 400, 360, 600]] } });
    await expect(resolvePdfCitationLocation(item, 2, { rects: [[0, 0, 900, 900]] })).rejects.toThrow("outside");
  });
});
