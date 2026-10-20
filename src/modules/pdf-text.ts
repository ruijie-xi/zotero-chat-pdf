import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import { getCacheDir } from "../utils/cache-dir";
import { openPdfRenderer, RenderedPdfPage } from "./pdf-renderer";
import { throwIfAborted } from "../utils/abort";
import { sourceCacheKey } from "./source-identity";
import { getAllLibraryItems, getItemYear } from "./zotero-items";

export interface TextPage { page: number | null; pageLabel?: string; text: string; }
export interface PdfTextRecord {
  version: 1; stamp: string; digest?: string; origin: "pdfjs" | "zotero-index";
  pageCount: number; indexedPages: number; pages: TextPage[];
}
const cachePath = (item: Zotero.Item) => PathUtils.join(getCacheDir(), "pdf-text", `${sourceCacheKey(item)}.json`);

export async function readPdfPage(item: Zotero.Item, page: number, signal?: AbortSignal, dpi = 300): Promise<RenderedPdfPage & { pageCount: number }> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("page must be a positive integer.");
  if (!Number.isSafeInteger(dpi) || dpi < 72 || dpi > 300) throw new Error("dpi must be an integer between 72 and 300.");
  const path = PathUtils.join(getCacheDir(), "pdf-pages", sourceCacheKey(item), `page-${page}-${dpi}.json`);
  return withStorageLock(path, async () => {
    throwIfAborted(signal);
    const file = await localFile(item);
    if (await IOUtils.exists(path)) {
      try {
        const cached = JSON.parse(new TextDecoder().decode(await IOUtils.read(path)));
        throwIfAborted(signal);
        if (cached.version === 1 && cached.stamp === file.stamp && cached.page?.page === page &&
            cached.page.pageCount >= page && cached.page.width > 0 && cached.page.height > 0 &&
            /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(cached.page.dataUrl)) return cached.page;
      } catch { throwIfAborted(signal); /* Regenerate an incomplete page cache. */ }
    }
    const renderer = await openPdfRenderer(file.path, signal);
    try {
      if (page > renderer.pageCount) throw new Error("Page exceeds PDF page count.");
      const rendered = { ...await renderer.render(page, dpi), pageCount: renderer.pageCount };
      throwIfAborted(signal);
      if ((await localFile(item)).stamp !== file.stamp) throw new Error("PDF changed during page rendering. Retry.");
      await atomicWriteJson(path, { version: 1, stamp: file.stamp, page: rendered });
      throwIfAborted(signal);
      return rendered;
    } finally { await renderer.close(); }
  });
}

async function localFile(item: Zotero.Item): Promise<{ path: string; stamp: string }> {
  const path = await item.getFilePathAsync();
  if (!path || !await IOUtils.exists(path)) throw new Error("PDF is not available locally. Download it in Zotero first.");
  const stat = await IOUtils.stat(path);
  return { path, stamp: `${path}:${stat.size}:${stat.lastModified}` };
}
async function savedText(item: Zotero.Item, stamp: string): Promise<PdfTextRecord | null> {
  const path = cachePath(item);
  if (!await IOUtils.exists(path)) return null;
  try {
    const record = JSON.parse(new TextDecoder().decode(await IOUtils.read(path))) as PdfTextRecord;
    return record.version === 1 && record.stamp === stamp && Array.isArray(record.pages) ? record : null;
  } catch { return null; }
}
async function zoteroIndex(item: Zotero.Item, file: { path: string; stamp: string }): Promise<PdfTextRecord | null> {
  const fulltext = (Zotero as any).Fulltext;
  if (!fulltext?.isFullyIndexed || !await fulltext.isFullyIndexed(item)) return null;
  const path = fulltext.getItemCacheFile?.(item)?.path;
  if (!path || !await IOUtils.exists(path)) return null;
  // Never promote an index predating the current attachment to current evidence.
  const indexTime = (await IOUtils.stat(path)).lastModified, fileTime = (await IOUtils.stat(file.path)).lastModified;
  if (indexTime === undefined || fileTime === undefined || indexTime < fileTime) return null;
  const stats = await fulltext.getPages?.(item.id);
  if (!stats?.total || stats.indexedPages !== stats.total) return null;
  return { version: 1, stamp: file.stamp, origin: "zotero-index", pageCount: stats.total,
    indexedPages: stats.indexedPages, pages: [{ page: null, text: new TextDecoder().decode(await IOUtils.read(path)) }] };
}

/** Local-only extraction. Page reads require page-mapped text; discovery may reuse Zotero's flat index. */
export async function readPdfText(item: Zotero.Item, signal?: AbortSignal, requirePages = false): Promise<PdfTextRecord> {
  return withStorageLock(cachePath(item), async () => {
    throwIfAborted(signal);
    const file = await localFile(item);
    const existing = await savedText(item, file.stamp);
    throwIfAborted(signal);
    if (existing && (!requirePages || existing.origin === "pdfjs")) return existing;
    if (!requirePages) {
      const index = await zoteroIndex(item, file).catch(() => null);
      throwIfAborted(signal);
      if (index) {
        await atomicWriteJson(cachePath(item), index);
        throwIfAborted(signal);
        return index;
      }
    }
    const bytes = await IOUtils.read(file.path);
    throwIfAborted(signal);
    const digest = Array.from(new Uint8Array(await Zotero.getMainWindow().crypto.subtle.digest("SHA-256", bytes)))
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const renderer = await openPdfRenderer(file.path, signal, bytes);
    try {
      const pages: TextPage[] = [];
      for (let page = 1; page <= renderer.pageCount; page++) {
        throwIfAborted(signal);
        pages.push(await renderer.text(page));
      }
      if ((await localFile(item)).stamp !== file.stamp) throw new Error("PDF changed during text extraction. Retry against the updated file.");
      const record: PdfTextRecord = { version: 1, stamp: file.stamp, digest, origin: "pdfjs",
        pageCount: renderer.pageCount, indexedPages: pages.length, pages };
      throwIfAborted(signal);
      await atomicWriteJson(cachePath(item), record);
      throwIfAborted(signal);
      return record;
    } finally { await renderer.close(); }
  });
}

function textCoverage(record: PdfTextRecord) {
  const empty = record.pages.filter(page => !page.text.trim());
  return {
    state: empty.length === record.pages.length ? "no-extractable-text" : empty.length ? "partial-text" : "complete",
    origin: record.origin, page_count: record.pageCount, indexed_pages: record.indexedPages,
    page_locations: record.origin === "pdfjs",
    pages_without_text: record.origin === "pdfjs" ? empty.map(page => page.page) : null,
  };
}

export async function pdfTextStatus(item: Zotero.Item): Promise<Record<string, unknown>> {
  try {
    const file = await localFile(item);
    const record = await savedText(item, file.stamp);
    if (record) {
      const coverage = textCoverage(record);
      return { ...coverage, state: coverage.state === "complete" ? "indexed" : coverage.state, digest: record.digest };
    }
    const stats = await (Zotero as any).Fulltext?.getPages?.(item.id);
    return { state: stats?.indexedPages ? "zotero-index-available" : "not-indexed",
      indexed_pages: stats?.indexedPages || 0, page_count: stats?.total || null, page_locations: false };
  } catch (error: any) { return { state: "unavailable", error: error.message }; }
}

export interface PdfSearchOptions {
  query: string; library_id?: number; collection_key?: string; recursive?: boolean;
  tag?: string; year_from?: number; year_to?: number;
  cursor?: string; page_size?: number; documents_per_call?: number; snippet_chars?: number;
}

export function textMatches(text: string, query: string, snippetChars: number): { offset: number; text: string }[] {
  if (!query) return [];
  const lower = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const matches: { offset: number; text: string }[] = [];
  let at = 0;
  while ((at = lower.indexOf(needle, at)) !== -1) {
    const start = Math.max(0, at - Math.floor(Math.max(0, snippetChars - needle.length) / 2));
    const end = Math.min(text.length, Math.max(at + needle.length, start + snippetChars));
    const previous = matches[matches.length - 1];
    if (!previous || start > previous.offset + previous.text.length) matches.push({ offset: start, text: text.slice(start, end) });
    else previous.text = text.slice(previous.offset, Math.max(previous.offset + previous.text.length, end));
    at += needle.length;
  }
  return matches;
}

export async function searchPdfText(options: PdfSearchOptions, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!options.query?.trim()) throw new Error("query must be nonempty (literal text, case insensitive).");
  const pageSize = options.page_size ?? 20, perCall = options.documents_per_call ?? 25, snippet = options.snippet_chars ?? 240;
  for (const value of [pageSize, perCall, snippet]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Search limits must be positive integers.");
  const items = await getAllLibraryItems();
  const collectionIDs = new Set<number>();
  if (options.collection_key) {
    if (!options.library_id) throw new Error("library_id is required with collection_key.");
    const collection = (Zotero.Collections as any).getByLibraryAndKey(options.library_id, options.collection_key);
    if (!collection) throw new Error("Collection not found.");
    collectionIDs.add(collection.id);
    if (options.recursive) for (const child of collection.getDescendents(false, "collection")) collectionIDs.add(child.id);
  }
  const candidates = items.filter(item => (!options.library_id || item.libraryID === options.library_id)
    && (!collectionIDs.size || item.getCollections().some(id => collectionIDs.has(id)))
    && (!options.tag || item.getTags().some(tag => tag.tag === options.tag))
    && (options.year_from === undefined || Number(getItemYear(item)) >= options.year_from)
    && (options.year_to === undefined || Number(getItemYear(item)) <= options.year_to))
    .flatMap(item => item.isPDFAttachment?.() ? [item] : item.getAttachments().map(id => Zotero.Items.get(id)).filter(att => att?.isPDFAttachment?.() && !att.deleted))
    .sort((a, b) => `${a.libraryID}:${a.key}`.localeCompare(`${b.libraryID}:${b.key}`));
  // Bind scope and metadata revisions, plus the local file revision when resuming
  // matches within one document. External PDF edits need not change Zotero metadata.
  const revision = JSON.stringify([options.query, options.library_id, options.collection_key, options.recursive, options.tag,
    options.year_from, options.year_to, snippet, candidates.map(item => [item.libraryID, item.key, item.dateModified])]);
  const { contextFingerprint } = await import("./agent-context");
  const fingerprint = contextFingerprint(revision);
  const cursor = options.cursor ? JSON.parse(options.cursor) : { fingerprint, document: 0, match: 0 };
  if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.document) || cursor.document < 0 || cursor.document > candidates.length
    || !Number.isSafeInteger(cursor.match) || cursor.match < 0) throw new Error("Search cursor expired or invalid. Restart without cursor.");
  const hits: Record<string, unknown>[] = [], coverage: Record<string, unknown>[] = [];
  let doc = cursor.document, match = cursor.match;
  let resumeStamp: string | undefined;
  while (doc < candidates.length && coverage.length < perCall && hits.length < pageSize) {
    throwIfAborted(signal);
    const item = candidates[doc];
    const id = `${item.libraryID}:${item.key}`;
    if (match > 0 && cursor.stamp !== contextFingerprint((await localFile(item)).stamp)) throw new Error("Search cursor expired after a PDF change. Restart without cursor.");
    try {
      const record = await readPdfText(item, signal);
      resumeStamp = contextFingerprint(record.stamp);
      const all = record.pages.flatMap(page => textMatches(page.text, options.query, snippet).map(hit => ({
        source_id: id, item_key: item.parentItem?.key || item.key, library_id: item.libraryID,
        title: String((item.parentItem || item).getField("title") || "Untitled"), pdf_page: page.page,
        page_label: page.pageLabel || null, origin: record.origin, revision: resumeStamp, digest: record.digest, ...hit,
      })));
      coverage.push({ source_id: id, ...textCoverage(record), matches: all.length });
      while (match < all.length && hits.length < pageSize) hits.push(all[match++]);
      if (match < all.length) break;
    } catch (error: any) {
      if (error.name === "AbortError") throw error;
      throwIfAborted(signal);
      coverage.push({ source_id: id, state: "unavailable", error: error.message });
    }
    doc++; match = 0;
  }
  throwIfAborted(signal);
  return { representation: "pdf-text-search", query: options.query, total_documents: candidates.length,
    page_size: pageSize, documents_per_call: perCall, snippet_chars: snippet, hits, coverage,
    next_cursor: doc < candidates.length ? JSON.stringify({ fingerprint, document: doc, match, stamp: match > 0 ? resumeStamp : undefined }) : null,
    note: "Only the reported documents were inspected. Null PDF pages mean Zotero's flat index has no page mapping or per-page text coverage; use read_pdf_text to locate pages. pages_without_text lists pages with no extractable text, not necessarily blank pages. Text extraction may lose formulas and layout. Inspect original pages with read_pdf_page for substantive reading. Scanned pages without text require visual reading or an externally supplied OCR text layer." };
}
