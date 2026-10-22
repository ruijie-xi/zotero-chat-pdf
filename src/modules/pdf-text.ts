import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import { getCacheDir } from "../utils/cache-dir";
import { openPdfRenderer, PdfRegion, PdfRenderer, RenderedPdfPage } from "./pdf-renderer";
import { throwIfAborted } from "../utils/abort";
import { sourceCacheKey } from "./source-identity";
import { getAllLibraryItems, getItemYear } from "./zotero-items";
import { collectPdfSearchPassages } from "./pdf-search-results";
export { textMatches } from "./pdf-search-results";

export interface TextPage { page: number | null; pageLabel?: string; text: string; }
export interface PdfTextRecord {
  version: 1; stamp: string; digest?: string; origin: "pdfjs" | "zotero-index";
  pageCount: number; indexedPages: number; pages: TextPage[];
}
const cachePath = (item: Zotero.Item) => PathUtils.join(getCacheDir(), "pdf-text", `${sourceCacheKey(item)}.json`);

export interface PdfPageOptions {
  page?: number;
  pages?: number[];
  start_page?: number;
  count?: number;
  dpi?: number;
  region?: PdfRegion;
}
type CachedPdfPage = RenderedPdfPage & { pageCount: number };
const pendingPageReads = new Map<string, number>();
const pageDpi = (options: PdfPageOptions) => options.dpi ?? (options.region ? 600 : 200);

export function validatePageOptions(options: PdfPageOptions): void {
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  const selections = [options.page, options.pages, options.start_page].filter(value => value !== undefined);
  if (selections.length > 1) throw new Error("Choose page, pages, or start_page; do not combine them.");
  for (const value of [options.page, options.start_page, options.count]) {
    if (value !== undefined && !positive(value)) throw new Error("page, start_page and count must be positive integers.");
  }
  if (options.pages !== undefined && (!Array.isArray(options.pages) || !options.pages.length ||
      !options.pages.every(positive) || new Set(options.pages).size !== options.pages.length)) {
    throw new Error("pages must be a non-empty list of unique positive integers.");
  }
  if (options.count !== undefined && (options.page !== undefined || options.pages !== undefined)) {
    throw new Error("count is only used with start_page (default 1).");
  }
  const dpi = pageDpi(options);
  if (!Number.isSafeInteger(dpi) || dpi < 72 || dpi > 600) throw new Error("dpi must be an integer between 72 and 600.");
  if (options.region !== undefined) {
    const region = options.region;
    if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
        region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 ||
        region.x + region.width > 1 || region.y + region.height > 1) {
      throw new Error("region must fit within the page: normalized x/y >= 0, width/height > 0, x+width and y+height <= 1.");
    }
    if (options.page === undefined) throw new Error("Use page for a single-page region crop.");
  }
}

/** One renderer per batch; document locking also deduplicates overlapping callers. */
export async function readPdfPages(item: Zotero.Item, options: PdfPageOptions = {}, signal?: AbortSignal, prefetch = false): Promise<{
  pages: CachedPdfPage[]; pageCount: number; nextPage: number | null;
}> {
  validatePageOptions(options);
  const dpi = pageDpi(options);
  const region = options.region ? { x: options.region.x, y: options.region.y, width: options.region.width, height: options.region.height } : undefined;
  const root = PathUtils.join(getCacheDir(), "pdf-pages", sourceCacheKey(item));
  pendingPageReads.set(root, (pendingPageReads.get(root) || 0) + 1);
  const suffix = region ? `-region-${region.x}-${region.y}-${region.width}-${region.height}` : "";
  // Resolve requested evidence before speculative work; keep the document lock
  // until adjacent-page prefetch and renderer cleanup finish. Prefetch never uploads.
  return new Promise((resolve, reject) => {
    void withStorageLock(root, async () => {
      const pending = (pendingPageReads.get(root) || 1) - 1;
      if (pending) pendingPageReads.set(root, pending); else pendingPageReads.delete(root);
      throwIfAborted(signal);
      const file = await localFile(item);
      let renderer: PdfRenderer | undefined;
      const read = async (page: number): Promise<CachedPdfPage> => {
        throwIfAborted(signal);
        const path = PathUtils.join(root, `page-${page}-${dpi}${suffix}.json`);
        if (await IOUtils.exists(path)) {
          try {
            const cached = JSON.parse(new TextDecoder().decode(await IOUtils.read(path)));
            throwIfAborted(signal);
            if (cached.version === 2 && cached.stamp === file.stamp && cached.page?.page === page &&
                cached.page.pageCount >= page && cached.page.width > 0 && cached.page.height > 0 &&
                JSON.stringify(cached.page.region) === JSON.stringify(region) &&
                /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(cached.page.dataUrl)) return cached.page;
          } catch { throwIfAborted(signal); /* Regenerate an incomplete page cache. */ }
        }
        throwIfAborted(signal);
        renderer ??= await openPdfRenderer(file.path, signal);
        if (page > renderer.pageCount) throw new Error("Page exceeds PDF page count.");
        const rendered = { ...await renderer.render(page, dpi, region), pageCount: renderer.pageCount };
        throwIfAborted(signal);
        if ((await localFile(item)).stamp !== file.stamp) throw new Error("PDF changed during page rendering. Retry.");
        await atomicWriteJson(path, { version: 2, stamp: file.stamp, page: rendered });
        throwIfAborted(signal);
        return rendered;
      };
      try {
        const firstNumber = options.page ?? options.pages?.[0] ?? options.start_page ?? 1;
        const first = await read(firstNumber), pageCount = first.pageCount;
        const numbers = options.page !== undefined ? [options.page] : options.pages ??
          Array.from({ length: Math.min(options.count ?? 4, pageCount - firstNumber + 1) }, (_, index) => firstNumber + index);
        if (numbers.some(page => page > pageCount)) throw new Error("Page exceeds PDF page count.");
        const pages = [first];
        for (const page of numbers.slice(1)) pages.push(await read(page));
        throwIfAborted(signal);
        if ((await localFile(item)).stamp !== file.stamp) throw new Error("PDF changed during page reading. Retry.");
        const last = numbers.reduce((max, page) => Math.max(max, page), 0);
        resolve({ pages, pageCount, nextPage: last < pageCount ? last + 1 : null });
        if (prefetch && renderer && !region) {
          try {
            for (let page = last + 1; page <= Math.min(last + 2, pageCount) && !pendingPageReads.has(root); page++) await read(page);
          } catch { /* Optional local prefetch must not invalidate delivered evidence. */ }
        }
      } finally { await renderer?.close(); }
    }).catch(reject);
  });
}

export async function readPdfPage(item: Zotero.Item, page: number, signal?: AbortSignal, dpi = 200): Promise<CachedPdfPage> {
  return (await readPdfPages(item, { page, dpi }, signal)).pages[0];
}

async function localFile(item: Zotero.Item): Promise<{ path: string; stamp: string }> {
  const path = await item.getFilePathAsync();
  if (!path || !await IOUtils.exists(path)) throw new Error("PDF is not available locally. Download it in Zotero first.");
  const stat = await IOUtils.stat(path);
  return { path, stamp: `${path}:${stat.size}:${stat.lastModified}` };
}
export { localFile as getPdfFileRevision };

/** Page-count metadata only: a warm Markdown read never renders a page image. */
export async function readPdfInfo(item: Zotero.Item, signal?: AbortSignal): Promise<{ path: string; stamp: string; pageCount: number }> {
  const path = PathUtils.join(getCacheDir(), "pdf-pages", sourceCacheKey(item), "info.json");
  return withStorageLock(path, async () => {
    throwIfAborted(signal);
    const file = await localFile(item);
    try {
      const cached = JSON.parse(new TextDecoder().decode(await IOUtils.read(path)));
      throwIfAborted(signal);
      if (cached.stamp === file.stamp && Number.isSafeInteger(cached.pageCount) && cached.pageCount > 0) {
        return { ...file, pageCount: cached.pageCount };
      }
    } catch { throwIfAborted(signal); }
    const renderer = await openPdfRenderer(file.path, signal);
    try {
      const info = { ...file, pageCount: renderer.pageCount };
      throwIfAborted(signal);
      if ((await localFile(item)).stamp !== file.stamp) throw new Error("PDF changed while reading its page count. Retry.");
      try { await atomicWriteJson(path, { stamp: file.stamp, pageCount: info.pageCount }); }
      catch { Zotero.debug("[ChatPDF] PDF page-count cache could not be saved."); }
      throwIfAborted(signal);
      return info;
    } finally { await renderer.close(); }
  });
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
  query: string; mode?: "documents" | "passages"; source_id?: string;
  library_id?: number; collection_key?: string; recursive?: boolean;
  tag?: string; year_from?: number; year_to?: number;
  cursor?: string; page_size?: number; documents_per_call?: number; snippet_chars?: number; snippets_per_document?: number;
}

interface SearchCounts { matching: number; complete: number; partial: number; empty: number; unavailable: number; }
const scannedCount = (counts: SearchCounts) => counts.complete + counts.partial + counts.empty + counts.unavailable;

export async function searchPdfText(options: PdfSearchOptions, signal?: AbortSignal): Promise<Record<string, unknown>> {
  throwIfAborted(signal);
  if (!options.query?.trim()) throw new Error("query must be nonempty (literal text, case insensitive).");
  const mode = options.mode ?? "documents";
  if (mode !== "documents" && mode !== "passages") throw new Error("mode must be documents or passages.");
  if (options.source_id !== undefined && !/^[1-9]\d*:[^:\s]+$/.test(options.source_id)) {
    throw new Error("source_id must be a library-qualified PDF attachment ID, for example 1:PDF12345.");
  }
  const pageSize = options.page_size ?? 20, perCall = options.documents_per_call ?? 25;
  const snippet = options.snippet_chars ?? 240, examples = options.snippets_per_document ?? 2;
  for (const value of [pageSize, perCall, snippet, examples]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Search limits must be positive integers.");
  const collectionIDs = new Set<number>();
  if (options.collection_key) {
    if (!options.library_id) throw new Error("library_id is required with collection_key. Use the matching libraryID from list_zotero_collections.");
    const collection = (Zotero.Collections as any).getByLibraryAndKey(options.library_id, options.collection_key);
    if (!collection) throw new Error("Collection not found.");
    collectionIDs.add(collection.id);
    if (options.recursive) for (const child of collection.getDescendents(false, "collection")) collectionIDs.add(child.id);
  }
  const items = await getAllLibraryItems();
  const attachments = items.filter(item => (!options.library_id || item.libraryID === options.library_id)
    && (!collectionIDs.size || item.getCollections().some(id => collectionIDs.has(id)))
    && (!options.tag || item.getTags().some(tag => tag.tag === options.tag))
    && (options.year_from === undefined || Number(getItemYear(item)) >= options.year_from)
    && (options.year_to === undefined || Number(getItemYear(item)) <= options.year_to))
    .flatMap(item => item.isPDFAttachment?.() ? [item] : item.getAttachments().map(id => Zotero.Items.get(id)).filter(att => att?.isPDFAttachment?.() && !att.deleted));
  const candidates = [...new Map(attachments.map(item => [`${item.libraryID}:${item.key}`, item])).values()]
    .filter(item => !options.source_id || `${item.libraryID}:${item.key}` === options.source_id)
    .sort((a, b) => `${a.libraryID}:${a.key}`.localeCompare(`${b.libraryID}:${b.key}`));
  // File metadata is checked for cursor validity, not counted as searched text.
  // This also detects edits/downloads of already-visited PDFs between calls.
  const revisions: unknown[] = [];
  for (const item of candidates) {
    throwIfAborted(signal);
    let stamp: string | null = null;
    try { stamp = (await localFile(item)).stamp; } catch { throwIfAborted(signal); }
    revisions.push([item.libraryID, item.key, item.dateModified, stamp]);
  }
  const { contextFingerprint } = await import("./agent-context");
  const fingerprint = contextFingerprint([mode, options.query, options.source_id, options.library_id, options.collection_key,
    options.recursive, options.tag, options.year_from, options.year_to, snippet, examples, revisions]);
  const cursor = options.cursor ? JSON.parse(options.cursor) : { version: 2, fingerprint, document: 0, match: 0,
    counts: { matching: 0, complete: 0, partial: 0, empty: 0, unavailable: 0 } };
  const counts: SearchCounts = cursor?.counts;
  if (!cursor || cursor.version !== 2 || cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.document)
    || cursor.document < 0 || cursor.document > candidates.length || !Number.isSafeInteger(cursor.match) || cursor.match < 0
    || (mode === "documents" && cursor.match !== 0) || !counts
    || [counts.matching, counts.complete, counts.partial, counts.empty, counts.unavailable].some(n => !Number.isSafeInteger(n) || n < 0)
    || scannedCount(counts) !== cursor.document + (cursor.match > 0 ? 1 : 0) || scannedCount(counts) > candidates.length
    || counts.matching > counts.complete + counts.partial
    || (cursor.match > 0 && (typeof cursor.record_revision !== "string" || counts.matching < 1))) {
    throw new Error("Search cursor expired or invalid (scope, mode, query or PDF change). Restart without cursor and keep search arguments consistent.");
  }
  const hits: Record<string, unknown>[] = [], documents: Record<string, unknown>[] = [], coverage: Record<string, unknown>[] = [];
  const before = scannedCount(counts);
  let doc = cursor.document, match = cursor.match, recordRevision: string | undefined;
  while (doc < candidates.length && coverage.length < perCall && (mode === "documents" ? documents.length : hits.length) < pageSize) {
    throwIfAborted(signal);
    const item = candidates[doc], id = `${item.libraryID}:${item.key}`;
    let record: PdfTextRecord;
    try { record = await readPdfText(item, signal); }
    catch (error: any) {
      if (error.name === "AbortError") throw error;
      throwIfAborted(signal);
      if (match > 0) throw new Error("Search cursor cannot resume this PDF. Restart without cursor.", { cause: error });
      coverage.push({ source_id: id, state: "unavailable", error: error.message });
      counts.unavailable++; doc++; continue;
    }
    recordRevision = contextFingerprint([record.stamp, record.origin, record.digest, record.pages]);
    if (match > 0 && cursor.record_revision !== recordRevision) throw new Error("Search cursor expired after a PDF text change. Restart without cursor.");
    const all = collectPdfSearchPassages(record, options.query, snippet);
    if (match > 0 && match >= all.length) throw new Error("Search cursor passage offset is invalid. Restart without cursor.");
    const matches = all.reduce((sum, passage) => sum + passage.match_count, 0), state = textCoverage(record);
    coverage.push({ source_id: id, ...state, matches, passages: all.length });
    if (match === 0) {
      if (state.state === "complete") counts.complete++;
      else if (state.state === "partial-text") counts.partial++;
      else counts.empty++;
      if (matches) counts.matching++;
    }
    const identity = { source_id: id, item_key: item.parentItem?.key || item.key, library_id: item.libraryID,
      title: String((item.parentItem || item).getField("title") || "Untitled"), origin: record.origin,
      revision: contextFingerprint(record.stamp), digest: record.digest };
    if (mode === "documents") {
      if (all.length) {
        const snippets = [...all].sort((a, b) => Number(a.likely_repeated_margin === true) - Number(b.likely_repeated_margin === true)).slice(0, examples);
        documents.push({ ...identity, total_matches: matches, total_passages: all.length,
          page_locations: state.page_locations, matched_pages: state.page_locations ? [...new Set(all.map(hit => hit.pdf_page))] : null,
          snippets, snippets_returned: snippets.length, passages_not_shown: all.length - snippets.length,
          snippet_ranking: state.page_locations ? "likely-repeated-margins-last" : "unavailable-flat-index" });
      }
    } else {
      while (match < all.length && hits.length < pageSize) hits.push({ ...identity, ...all[match++] });
      if (match < all.length) break;
    }
    doc++; match = 0;
  }
  throwIfAborted(signal);
  const scanned = scannedCount(counts), complete = doc === candidates.length;
  return { representation: "pdf-text-search", mode, query: options.query, total_documents: candidates.length,
    page_size: pageSize, page_size_unit: mode === "documents" ? "matching-documents" : "merged-passages",
    documents_per_call: perCall, snippet_chars: snippet, snippets_per_document: examples,
    ...(mode === "documents" ? { documents } : { hits }), coverage,
    progress: { inspected_this_call: coverage.length, newly_scanned_this_call: scanned - before,
      scanned_documents: scanned, total_documents: candidates.length, matching_documents: counts.matching,
      searchable_documents: counts.complete + counts.partial, complete_text_documents: counts.complete,
      partial_text_documents: counts.partial, no_extractable_text_documents: counts.empty, unavailable_documents: counts.unavailable,
      scan_complete: scanned === candidates.length, traversal_complete: complete,
      text_coverage_complete: scanned === candidates.length && counts.complete === candidates.length },
    next_cursor: complete ? null : JSON.stringify({ version: 2, fingerprint, document: doc, match, counts,
      record_revision: match > 0 ? recordRevision : undefined }),
    note: "Discovery returns one entry per matching PDF; snippets_per_document explicitly limits representative passages, never matching documents or available full results. Use mode=passages with source_id and the same query for complete chronological passages; overlapping snippet windows are merged, so a passage may exceed snippet_chars. Repeated-margin ranking is heuristic and never removes matches. Follow next_cursor with the same search arguments for exhaustive results; partial coverage is not proof of no matches. Progress is cumulative for this cursor chain; inspected_this_call can include a resumed PDF. Traversal completion is separate from reported text availability. File metadata checks do not inspect PDF contents. Null page locations mean a flat Zotero index; no header/layout inference is made. Pages without text are not necessarily blank. Text may lose formulas/layout; use read_pdf_page Markdown for reading and inspect_pdf_page for careful original-image review." };
}
