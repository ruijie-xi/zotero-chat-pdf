import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import { getCacheDir } from "../utils/cache-dir";
import { throwIfAborted } from "../utils/abort";
import { sourceCacheKey } from "./source-identity";
import { getPdfFileRevision, readPdfText } from "./pdf-text";
import { openPdfRenderer, type PdfRenderer, type PdfTextLayout, type PdfRect, type PdfRegion } from "./pdf-renderer";
import { findPdfContentMatches, locateInPdfLayout, regionToPdfRect, validPdfRect } from "./pdf-location-geometry";

export interface PdfLocateOptions { query: string; page?: number; }
interface LayoutCache { version: number; stamp: string; pageCount: number; layout: PdfTextLayout; }

/** A revision token contains no local path and is not an authorization token. */
export async function pdfLocationRevision(stamp: string): Promise<string> {
  const bytes = await Zotero.getMainWindow().crypto.subtle.digest("SHA-256", new TextEncoder().encode(stamp));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}
function validLayout(layout: PdfTextLayout, page: number): boolean {
  return !!layout && layout.page === page && validPdfRect(layout.viewBox) &&
    layout.viewport?.width > 0 && layout.viewport.height > 0 && Number.isFinite(layout.viewport.width) && Number.isFinite(layout.viewport.height) &&
    Array.isArray(layout.viewport.transform) && layout.viewport.transform.length === 6 && layout.viewport.transform.every(Number.isFinite) &&
    Array.isArray(layout.items) && !!layout.styles && layout.items.every(item => typeof item.str === "string" &&
      Array.isArray(item.transform) && item.transform.length === 6 && item.transform.every(Number.isFinite));
}

async function withLayouts<T>(item: Zotero.Item, signal: AbortSignal | undefined,
  operation: (read: (page: number) => Promise<LayoutCache>, stamp: string) => Promise<T>): Promise<T> {
  throwIfAborted(signal);
  const file = await getPdfFileRevision(item);
  let renderer: PdfRenderer | undefined;
  const read = async (page: number): Promise<LayoutCache> => {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("page must be a positive integer.");
    const path = PathUtils.join(getCacheDir(), "pdf-locations", sourceCacheKey(item), `page-${page}.json`);
    return withStorageLock(path, async () => {
      throwIfAborted(signal);
      try {
        const cached = JSON.parse(new TextDecoder().decode(await IOUtils.read(path))) as LayoutCache;
        throwIfAborted(signal);
        if (cached.version === 1 && cached.stamp === file.stamp && Number.isSafeInteger(cached.pageCount) &&
          cached.pageCount >= page && validLayout(cached.layout, page)) return cached;
      } catch { throwIfAborted(signal); }
      renderer ||= await openPdfRenderer(file.path, signal);
      if (page > renderer.pageCount) throw new Error("page is outside the PDF page count.");
      const layout = await renderer.layout(page);
      throwIfAborted(signal);
      if (!validLayout(layout, page)) throw new Error("Invalid PDF text geometry.");
      if ((await getPdfFileRevision(item)).stamp !== file.stamp) throw new Error("PDF changed while locating content. Retry.");
      throwIfAborted(signal);
      const entry: LayoutCache = { version: 1, stamp: file.stamp, pageCount: renderer.pageCount, layout };
      try { await atomicWriteJson(path, entry); }
      catch { Zotero.debug("[ChatPDF] PDF location cache could not be saved."); }
      throwIfAborted(signal);
      return entry;
    });
  };
  try {
    const result = await operation(read, file.stamp);
    if ((await getPdfFileRevision(item)).stamp !== file.stamp) throw new Error("PDF changed while locating content. Retry.");
    throwIfAborted(signal);
    return result;
  } finally { await renderer?.close(); }
}

export async function locatePdfContent(item: Zotero.Item, options: PdfLocateOptions, signal?: AbortSignal) {
  if (typeof options.query !== "string" || !options.query.trim() || !findPdfContentMatches(options.query, options.query).length) {
    throw new Error("query must contain searchable text.");
  }
  if (options.page !== undefined && (!Number.isSafeInteger(options.page) || options.page < 1)) throw new Error("page must be a positive integer.");
  return withLayouts(item, signal, async (read, stamp) => {
    // Discovery reuses the existing page text cache. A known page bypasses full-document extraction.
    const text = options.page === undefined ? await readPdfText(item, signal, true) : undefined;
    const candidates = text ? text.pages.filter(page => findPdfContentMatches(page.text, options.query).length).map(page => page.page!) : [options.page!];
    const matches: (ReturnType<typeof locateInPdfLayout>[number] & { pdf_page: number; page_label: string | null })[] = [];
    let pageCount = text?.pageCount || 0;
    const pagesWithoutText = text?.pages.filter(page => !page.text.trim()).map(page => page.page!) || [];
    for (const page of candidates) {
      throwIfAborted(signal);
      const entry = await read(page);
      pageCount = entry.pageCount;
      if (!text && !entry.layout.items.some(item => item.str.trim())) pagesWithoutText.push(page);
      matches.push(...locateInPdfLayout(entry.layout, options.query).map(match => ({ ...match, pdf_page: page, page_label: entry.layout.pageLabel || null })));
    }
    return { query: options.query, page_count: pageCount, revision: await pdfLocationRevision(stamp),
      searched_pages: options.page === undefined ? { start: 1, end: pageCount } : { start: options.page, end: options.page },
      pages_without_text: pagesWithoutText, candidate_pages: candidates, total_matches: matches.length, matches,
      note: "Local text navigation, not semantic search or verified reading. All matches in the requested scope are returned. Context includes up to 100 characters on each side. Matching normalizes case, whitespace, compatibility ligatures, soft hyphens and line-end hyphenation. Rectangles cover whole PDF text items, not individual characters or complete equations/figures. Vertical or unusable geometry returns page-only matches. Pages without text may contain images; no OCR is performed. Use region with inspect_pdf_page to verify the target, and cite the returned link unchanged." };
  });
}

export async function resolvePdfCitationLocation(item: Zotero.Item, page: number,
  target: { rects?: PdfRect[]; region?: PdfRegion; revision?: string }) {
  return withLayouts(item, undefined, async (read, stamp) => {
    if (target.revision && target.revision !== await pdfLocationRevision(stamp)) {
      throw new Error("This PDF has changed. Locate the content again to obtain an updated link.");
    }
    const { layout } = await read(page);
    const rects = target.rects || [regionToPdfRect(target.region!, layout)];
    const [x0, y0, x1, y1] = layout.viewBox;
    if (!rects.length || !rects.every(r => validPdfRect(r) && r[0] >= x0 - 0.01 && r[1] >= y0 - 0.01 && r[2] <= x1 + 0.01 && r[3] <= y1 + 0.01)) {
      throw new Error("The citation region is outside this PDF page.");
    }
    return { position: { pageIndex: page - 1, rects } };
  });
}
