import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
vi.mock("../src/modules/pdf-renderer", () => ({ openPdfRenderer: vi.fn() }));
vi.mock("../src/modules/zotero-items", () => ({ getAllLibraryItems: vi.fn(), getItemYear: vi.fn(() => "2024") }));
import { openPdfRenderer } from "../src/modules/pdf-renderer";
import { getAllLibraryItems } from "../src/modules/zotero-items";
import { readPdfText, readPdfPage, readPdfPages, searchPdfText, textMatches } from "../src/modules/pdf-text";
import type { PdfRegion } from "../src/modules/pdf-renderer";
const files = new Map<string, Uint8Array>();
const item = { id: 7, key: "PDF12345", libraryID: 1, dateModified: "1", deleted: false,
  isPDFAttachment: () => true, getFilePathAsync: async () => "/paper.pdf", getField: () => "Paper", getCollections: () => [], getTags: () => [] } as any;
let modified: number;
const renderer = { pageCount: 3, text: vi.fn(async (page: number) => ({ page, text: page === 3 ? "" : "Hamiltonian energy theorem", pageLabel: String(page + 10) })),
  render: vi.fn(async (page: number, dpi: number, region?: PdfRegion) => ({ page, dataUrl: "data:image/jpeg;base64,AA==", text: "", width: 100, height: 100, effectiveDpi: dpi, ...(region ? { region } : {}) })), close: vi.fn(async () => {}) };
beforeEach(() => {
  vi.clearAllMocks(); files.clear(); modified = 1; renderer.pageCount = 3;
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

function searchLibrary(pages: string[][]) {
  const library = pages.map((_, i) => ({ ...item, id: i + 1, key: `DOC${String(i + 1).padStart(5, "0")}`,
    getField: () => `Paper ${i + 1}`, getFilePathAsync: async () => `/document-${i}.pdf` }));
  pages.forEach((_, i) => files.set(`/document-${i}.pdf`, new Uint8Array([i + 1])));
  vi.mocked(getAllLibraryItems).mockResolvedValue(library);
  vi.mocked(openPdfRenderer).mockImplementation(async path => {
    const index = Number(path.match(/document-(\d+)/)![1]);
    return { pageCount: pages[index].length, text: async page => ({ page, text: pages[index][page - 1] }),
      render: renderer.render, close: vi.fn(async () => {}) };
  });
  return library;
}

describe("local PDF text and page evidence", () => {
  it("rejects an unqualified collection before library enumeration and explains how to repair it", async () => {
    await expect(searchPdfText({ query: "energy", collection_key: "COL00001" })).rejects.toThrow("library_id is required with collection_key. Use the matching libraryID from list_zotero_collections.");
    expect(getAllLibraryItems).not.toHaveBeenCalled();
    expect(openPdfRenderer).not.toHaveBeenCalled();
  });
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
    const first = await searchPdfText({ query: "energy", mode: "passages", page_size: 1 });
    expect(first.hits).toHaveLength(1); expect(first.next_cursor).not.toBeNull();
    const second = await searchPdfText({ query: "energy", mode: "passages", page_size: 1, cursor: first.next_cursor as string });
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
  it("reports missing text per page and keeps flat-index coverage explicitly unknown", async () => {
    expect((await searchPdfText({ query: "energy" })).coverage).toMatchObject([
      { state: "partial-text", pages_without_text: [3], page_locations: true },
    ]);
    modified = 2;
    files.set("/index", new TextEncoder().encode("Indexed energy"));
    Object.assign(Zotero, { Fulltext: { isFullyIndexed: async () => true, getItemCacheFile: () => ({ path: "/index" }), getPages: async () => ({ indexedPages: 3, total: 3 }) } });
    expect((await searchPdfText({ query: "energy" })).coverage).toMatchObject([
      { origin: "zotero-index", pages_without_text: null, page_locations: false },
    ]);
  });
  it("does not deliver a cached text record after cancellation during cache I/O", async () => {
    await readPdfText(item);
    const controller = new AbortController();
    vi.mocked(IOUtils.read).mockImplementationOnce(async (path: string) => {
      controller.abort();
      return files.get(path)!;
    });
    await expect(readPdfText(item, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(openPdfRenderer).toHaveBeenCalledOnce();
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
  it("preserves merged/distant snippet text and offsets and rejects invalid limits/cursors", async () => {
    expect(textMatches("energy", "", 100)).toEqual([]);
    const text = "before alpha match shared context another match after";
    expect(textMatches(text, "match", 50)).toEqual([{ offset: 0, text }]);
    expect(textMatches("match" + ".".repeat(100) + "MATCH", "match", 5)).toEqual([
      { offset: 0, text: "match" }, { offset: 105, text: "MATCH" },
    ]);
    await expect(searchPdfText({ query: "energy", page_size: 0 })).rejects.toThrow("positive");
    await expect(searchPdfText({ query: "energy", cursor: '{"document":0}' })).rejects.toThrow("cursor");
  });
  it("keys cached pages by resolution and validates ranges before rendering", async () => {
    await readPdfPage(item, 1, undefined, 150);
    const high = await readPdfPage(item, 1, undefined, 300);
    expect(high.pageCount).toBe(3);
    expect(renderer.render.mock.calls).toEqual([[1, 150, undefined], [1, 300, undefined]]);
    await expect(readPdfPage(item, 0)).rejects.toThrow("positive integer");
    await expect(readPdfPage(item, 1, undefined, 601)).rejects.toThrow("72 and 600");
    await expect(readPdfPage(item, 4)).rejects.toThrow("page count");
  });
  it("never saves or delivers a page when rendering was cancelled", async () => {
    const controller = new AbortController();
    renderer.render.mockImplementationOnce(async () => {
      controller.abort();
      return { page: 1, dataUrl: "data:image/jpeg;base64,AA==", text: "", width: 1, height: 1, effectiveDpi: 300 };
    });
    await expect(readPdfPage(item, 1, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(IOUtils.write).not.toHaveBeenCalled();
    expect(renderer.close).toHaveBeenCalledOnce();
  });
  it("browses four 200 DPI pages with one renderer and reuses the batch cache", async () => {
    renderer.pageCount = 6;
    const result = await readPdfPages(item);
    expect(result.pages.map(page => page.page)).toEqual([1, 2, 3, 4]);
    expect(result.nextPage).toBe(5);
    expect(result.pages.every(page => page.effectiveDpi === 200)).toBe(true);
    expect(openPdfRenderer).toHaveBeenCalledOnce();
    await readPdfPages(item, { pages: [4, 2, 1] });
    expect(renderer.render).toHaveBeenCalledTimes(4);
    const all = await readPdfPages(item, { count: 6 });
    expect(all.pages).toHaveLength(6); expect(all.nextPage).toBeNull();
    expect(openPdfRenderer).toHaveBeenCalledTimes(2);
  });
  it("deduplicates overlapping batches without sharing one caller's cancellation", async () => {
    await Promise.all([readPdfPages(item, { pages: [1, 2] }), readPdfPages(item, { pages: [2, 3] })]);
    expect(renderer.render.mock.calls.map(call => call[0])).toEqual([1, 2, 3]);
    const controller = new AbortController(); controller.abort();
    await expect(readPdfPages(item, {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect((await readPdfPages(item)).pages).toHaveLength(3);
  });
  it("separates full pages, crop regions and DPI in the cache and rejects ambiguous selections", async () => {
    const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.25 };
    await readPdfPages(item, { page: 1, dpi: 600, region });
    await readPdfPages(item, { page: 1, dpi: 600, region });
    await readPdfPages(item, { page: 1, dpi: 600, region: { ...region, x: 0.2 } });
    await readPdfPages(item, { page: 1, dpi: 600 });
    expect(renderer.render).toHaveBeenCalledTimes(3);
    expect(renderer.render.mock.calls[0]).toEqual([1, 600, region]);
    for (const options of [{ page: 1, pages: [1] }, { pages: [] }, { pages: [1, 1] }, { page: 1, count: 4 },
      { region }, { page: 1, region: { ...region, x: 0.9 } }, { page: 1, region: { ...region, width: 0 } }]) {
      await expect(readPdfPages(item, options)).rejects.toThrow();
    }
    expect(renderer.render).toHaveBeenCalledTimes(3);
    modified++;
    await readPdfPages(item, { page: 1, dpi: 600, region });
    expect(renderer.render).toHaveBeenCalledTimes(4);
  });
  it("renders default crops at 600 DPI from the PDF and honors explicit resolution overrides", async () => {
    const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.25 };
    await readPdfPages(item, { page: 1 });
    await readPdfPages(item, { page: 1, region });
    await readPdfPages(item, { page: 1, region, dpi: 400 });
    await readPdfPages(item, { page: 1, dpi: 300 });
    expect(renderer.render.mock.calls).toEqual([[1, 200, undefined], [1, 600, region], [1, 400, region], [1, 300, undefined]]);
    await readPdfPages(item, { page: 1, region });
    expect(renderer.render).toHaveBeenCalledTimes(4);
  });
  it("delivers requested pages before local prefetch and cancels speculative work", async () => {
    let finish!: () => void;
    renderer.render.mockImplementationOnce(async page => ({ page, dataUrl: "data:image/jpeg;base64,AA==", text: "", width: 100, height: 100, effectiveDpi: 300 }));
    renderer.render.mockImplementationOnce(async page => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { page, dataUrl: "data:image/jpeg;base64,AA==", text: "", width: 100, height: 100, effectiveDpi: 300 };
    });
    const controller = new AbortController();
    expect((await readPdfPages(item, { page: 1 }, controller.signal, true)).pages).toHaveLength(1);
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(renderer.close).not.toHaveBeenCalled();
    controller.abort(); finish();
    await vi.waitFor(() => expect(renderer.close).toHaveBeenCalledOnce());
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(IOUtils.write).toHaveBeenCalledOnce();
  });
  it("expires a partial-document cursor when the PDF changes without a metadata update", async () => {
    const first = await searchPdfText({ query: "energy", mode: "passages", page_size: 1 });
    modified = 5;
    await expect(searchPdfText({ query: "energy", mode: "passages", page_size: 1, cursor: first.next_cursor as string })).rejects.toThrow("PDF change");
    expect((await searchPdfText({ query: "energy", mode: "passages", page_size: 1 })).hits).toMatchObject([{ pdf_page: 1 }]);
  });
});


describe("PDF document discovery and complete passage navigation", () => {
  it("advances across 44 PDFs despite many first-document headers and recovers all passages on demand", async () => {
    const repeated = Array.from({ length: 70 }, (_, i) => `ISOGEOMETRIC REPORT\nPage ${i + 1}\n${"neutral context ".repeat(45)}\n${i === 33 ? "The isogeometric method preserves structure." : "Other results."}\n${"tail context ".repeat(45)}\nEnd of report\nFooter`);
    const pages = Array.from({ length: 44 }, (_, i) => i === 0 ? repeated : [i === 21 || i === 43 ? "A later isogeometric paper" : "Unrelated material"]);
    const library = searchLibrary(pages);
    const first = await searchPdfText({ query: "isogeometric" }) as any;
    expect(first.mode).toBe("documents"); expect(first).not.toHaveProperty("hits");
    expect(first.documents.map((d: any) => d.source_id)).toEqual([`1:${library[0].key}`, `1:${library[21].key}`]);
    expect(first.documents[0]).toMatchObject({ total_matches: 71, total_passages: 71, snippets_returned: 2, passages_not_shown: 69 });
    expect(first.documents[0].matched_pages).toHaveLength(70);
    expect(first.documents[0].snippets[0]).toMatchObject({ pdf_page: 34, likely_repeated_margin: false });
    expect(first.progress).toMatchObject({ inspected_this_call: 25, scanned_documents: 25, matching_documents: 2, traversal_complete: false });
    const second = await searchPdfText({ query: "isogeometric", cursor: first.next_cursor }) as any;
    expect(second.documents.map((d: any) => d.source_id)).toEqual([`1:${library[43].key}`]);
    expect(second.progress).toMatchObject({ inspected_this_call: 19, scanned_documents: 44, matching_documents: 3, traversal_complete: true, text_coverage_complete: true });
    expect(second.next_cursor).toBeNull();
    const hits: any[] = []; let cursor: string | undefined;
    do {
      const result = await searchPdfText({ query: "isogeometric", mode: "passages", source_id: `1:${library[0].key}`, page_size: 12, cursor }) as any;
      hits.push(...result.hits); cursor = result.next_cursor || undefined;
      expect(result.progress).toMatchObject({ scanned_documents: 1, matching_documents: 1, scan_complete: true, traversal_complete: !cursor });
    } while (cursor);
    expect(hits).toHaveLength(71);
    expect(hits.reduce((sum, hit) => sum + hit.match_count, 0)).toBe(71);
    expect(hits.filter(hit => hit.likely_repeated_margin)).toHaveLength(70);
    expect(hits.map(hit => hit.pdf_page)).toEqual([...hits.map(hit => hit.pdf_page)].sort((a, b) => a - b));
    expect(openPdfRenderer).toHaveBeenCalledTimes(44);
  });

  it("never suppresses a document whose only matches are repeated margins", async () => {
    searchLibrary([["ENERGY HEADER\nNo match here\nOther body\nFooter", "ENERGY HEADER\nAnother page\nOther body\nFooter"]]);
    const result = await searchPdfText({ query: "energy", snippets_per_document: 1 }) as any;
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({ total_matches: 2, snippets_returned: 1, passages_not_shown: 1 });
    expect(result.documents[0].snippets[0].likely_repeated_margin).toBe(true);
  });

  it("distinguishes finished traversal from unavailable and partial text across cursor pages", async () => {
    searchLibrary([["energy", ""], [""], ["missing"], ["unrelated"]]);
    files.delete("/document-2.pdf");
    const first = await searchPdfText({ query: "energy", documents_per_call: 2 }) as any;
    const last = await searchPdfText({ query: "energy", documents_per_call: 2, cursor: first.next_cursor }) as any;
    expect(last.documents).toEqual([]); expect(last.next_cursor).toBeNull();
    expect(last.progress).toMatchObject({ scanned_documents: 4, newly_scanned_this_call: 2, matching_documents: 1,
      searchable_documents: 2, complete_text_documents: 1, partial_text_documents: 1, no_extractable_text_documents: 1,
      unavailable_documents: 1, scan_complete: true, traversal_complete: true, text_coverage_complete: false });
    expect(last.coverage[0]).toMatchObject({ state: "unavailable" });
  });

  it("counts literal occurrences separately from merged context windows", async () => {
    searchLibrary([["energy and energy and ENERGY"]]);
    const result = await searchPdfText({ query: "energy" }) as any;
    expect(result.documents[0]).toMatchObject({ total_matches: 3, total_passages: 1 });
    expect(result.documents[0].snippets[0].match_count).toBe(3);
  });

  it("binds continuation to mode, scope, examples, counts and all local PDF revisions", async () => {
    const library = searchLibrary([["energy"], ["energy"]]);
    const first = await searchPdfText({ query: "energy", documents_per_call: 1 }) as any;
    for (const changed of [{ mode: "passages" as const }, { query: "other" }, { source_id: `1:${library[1].key}` }, { snippets_per_document: 3 }]) {
      await expect(searchPdfText({ query: "energy", cursor: first.next_cursor, ...changed })).rejects.toThrow("cursor");
    }
    const tampered = JSON.parse(first.next_cursor); tampered.counts.matching = 9;
    await expect(searchPdfText({ query: "energy", cursor: JSON.stringify(tampered) })).rejects.toThrow("cursor");
    files.set("/document-0.pdf", new Uint8Array([1, 2, 3]));
    await expect(searchPdfText({ query: "energy", cursor: first.next_cursor })).rejects.toThrow("PDF change");
  });

  it("reports unknown page locations and header ranking for flat indexes and rejects remapped passage cursors", async () => {
    files.set("/index", new TextEncoder().encode("energy" + ".".repeat(400) + "energy"));
    Object.assign(Zotero, { Fulltext: { isFullyIndexed: async () => true, getItemCacheFile: () => ({ path: "/index" }), getPages: async () => ({ indexedPages: 3, total: 3 }) } });
    const discovery = await searchPdfText({ query: "energy", snippet_chars: 20 }) as any;
    expect(discovery.documents[0]).toMatchObject({ matched_pages: null, snippet_ranking: "unavailable-flat-index" });
    expect(discovery.documents[0].snippets.every((s: any) => s.pdf_page === null && s.likely_repeated_margin === null)).toBe(true);
    const first = await searchPdfText({ query: "energy", mode: "passages", page_size: 1, snippet_chars: 20 }) as any;
    await readPdfText(item, undefined, true);
    await expect(searchPdfText({ query: "energy", mode: "passages", page_size: 1, snippet_chars: 20, cursor: first.next_cursor })).rejects.toThrow("PDF text change");
  });

  it("propagates cancellation during revision checks and rejects unqualified PDF IDs before library access", async () => {
    await expect(searchPdfText({ query: "energy", source_id: "PDF12345" })).rejects.toThrow("library-qualified");
    expect(getAllLibraryItems).not.toHaveBeenCalled();
    const controller = new AbortController();
    vi.mocked(IOUtils.stat).mockImplementationOnce(async () => { controller.abort(); return { size: 2, lastModified: 1 } as any; });
    await expect(searchPdfText({ query: "energy" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(openPdfRenderer).not.toHaveBeenCalled();
  });
});
