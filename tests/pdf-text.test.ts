import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
vi.mock("../src/modules/pdf-renderer", () => ({ openPdfRenderer: vi.fn() }));
vi.mock("../src/modules/zotero-items", () => ({ getAllLibraryItems: vi.fn(), getItemYear: vi.fn(() => "2024") }));
import { openPdfRenderer } from "../src/modules/pdf-renderer";
import { getAllLibraryItems } from "../src/modules/zotero-items";
import { readPdfText, readPdfPage, searchPdfText, textMatches } from "../src/modules/pdf-text";
const files = new Map<string, Uint8Array>();
const item = { id: 7, key: "PDF12345", libraryID: 1, dateModified: "1", deleted: false,
  isPDFAttachment: () => true, getFilePathAsync: async () => "/paper.pdf", getField: () => "Paper", getCollections: () => [], getTags: () => [] } as any;
let modified: number;
const renderer = { pageCount: 3, text: vi.fn(async (page: number) => ({ page, text: page === 3 ? "" : "Hamiltonian energy theorem", pageLabel: String(page + 10) })),
  render: vi.fn(async () => ({ page: 1, dataUrl: "data:image/jpeg;base64,AA==", text: "", width: 100, height: 100, effectiveDpi: 150 })), close: vi.fn(async () => {}) };
beforeEach(() => {
  vi.clearAllMocks(); files.clear(); modified = 1;
  files.set("/paper.pdf", new Uint8Array([1, 2]));
  vi.mocked(Zotero.Prefs.get).mockReturnValue("/cache" as never);
  vi.mocked(Zotero.getMainWindow).mockReturnValue({ crypto: webcrypto } as any);
  Object.assign(IOUtils, { exists: vi.fn(async (path: string) => files.has(path)), stat: vi.fn(async (path: string) => ({ size: files.get(path)?.length || 1, lastModified: path === "/paper.pdf" ? modified : 10 })),
    read: vi.fn(async (path: string) => files.get(path)), makeDirectory: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    write: vi.fn(async (path: string, bytes: Uint8Array) => files.set(path, bytes)) });
  Object.assign(Zotero, { Fulltext: undefined });
  vi.mocked(openPdfRenderer).mockResolvedValue(renderer);
  vi.mocked(getAllLibraryItems).mockResolvedValue([item]);
});
describe("local PDF text and page evidence", () => {
  it("extracts page text without rasterizing, reuses cache, and invalidates it after PDF changes", async () => {
    expect((await readPdfText(item)).pages).toHaveLength(3);
    await readPdfText(item);
    expect(openPdfRenderer).toHaveBeenCalledTimes(1); expect(renderer.render).not.toHaveBeenCalled();
    modified = 2; await readPdfText(item);
    expect(openPdfRenderer).toHaveBeenCalledTimes(2); expect(renderer.close).toHaveBeenCalledTimes(2);
  });
  it("uses a fresh complete Zotero index for search but extracts page mappings for a page read", async () => {
    files.set("/index", new TextEncoder().encode("Indexed energy"));
    Object.assign(Zotero, { Fulltext: { isFullyIndexed: async () => true, getItemCacheFile: () => ({ path: "/index" }), getPages: async () => ({ indexedPages: 3, total: 3 }) } });
    expect((await readPdfText(item)).origin).toBe("zotero-index");
    expect(openPdfRenderer).not.toHaveBeenCalled();
    expect((await readPdfText(item, undefined, true)).origin).toBe("pdfjs");
    expect(openPdfRenderer).toHaveBeenCalledOnce();
  });
  it("does not treat a partial or stale Zotero index as complete", async () => {
    Object.assign(Zotero, { Fulltext: { isFullyIndexed: async () => false } });
    expect((await readPdfText(item)).origin).toBe("pdfjs");
  });
  it("pages matches without skipping remaining matches in the same document", async () => {
    const first = await searchPdfText({ query: "energy", page_size: 1 });
    expect(first.hits).toHaveLength(1); expect(first.next_cursor).not.toBeNull();
    const second = await searchPdfText({ query: "energy", page_size: 1, cursor: first.next_cursor as string });
    expect(second.hits).toMatchObject([{ pdf_page: 2 }]); expect(second.next_cursor).toBeNull();
    expect(openPdfRenderer).toHaveBeenCalledOnce();
  });
  it("reports no extractable text and missing files independently from no matches", async () => {
    renderer.text.mockResolvedValueOnce({ page: 1, text: "", pageLabel: "11" }).mockResolvedValueOnce({ page: 2, text: "", pageLabel: "12" });
    const empty = await searchPdfText({ query: "energy" });
    expect(empty.coverage).toMatchObject([{ state: "no-extractable-text" }]);
    files.delete("/paper.pdf");
    expect((await searchPdfText({ query: "energy" })).coverage).toMatchObject([{ state: "unavailable" }]);
  });
  it("closes the renderer and never commits incomplete extraction on cancellation", async () => {
    const controller = new AbortController();
    renderer.text.mockImplementationOnce(async () => { controller.abort(); return { page: 1, text: "partial", pageLabel: "11" }; });
    await expect(readPdfText(item, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(renderer.close).toHaveBeenCalledOnce(); expect(IOUtils.write).not.toHaveBeenCalled();
  });
  it("reuses a rendered page and invalidates it on file change", async () => {
    await readPdfPage(item, 1); await readPdfPage(item, 1);
    expect(renderer.render).toHaveBeenCalledOnce(); modified = 8;
    await readPdfPage(item, 1); expect(renderer.render).toHaveBeenCalledTimes(2);
  });
  it("merges overlapping snippets and rejects invalid limits/cursors", async () => {
    expect(textMatches("energy", "", 100)).toEqual([]);
    expect(textMatches("energy and energy", "energy", 100)).toHaveLength(1);
    await expect(searchPdfText({ query: "energy", page_size: 0 })).rejects.toThrow("positive");
    await expect(searchPdfText({ query: "energy", cursor: '{"document":0}' })).rejects.toThrow("cursor");
  });
  it("expires a partial-document cursor when the PDF changes without a metadata update", async () => {
    const first = await searchPdfText({ query: "energy", page_size: 1 });
    modified = 5;
    await expect(searchPdfText({ query: "energy", page_size: 1, cursor: first.next_cursor as string })).rejects.toThrow("PDF change");
    expect((await searchPdfText({ query: "energy", page_size: 1 })).hits).toMatchObject([{ pdf_page: 1 }]);
  });
});
