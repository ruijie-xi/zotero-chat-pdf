import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import { getCacheDir } from "../utils/cache-dir";
import { throwIfAborted } from "../utils/abort";
import { makeSourceId, sourceCacheKey } from "./source-identity";
import { getPdfFileRevision, readPdfInfo, readPdfPage, validatePageOptions, type PdfPageOptions } from "./pdf-text";
import { createAbortController } from "./panel-state";
import { logPdfReading } from "./debug-log";
import { getPdfTranscriptionSettings, PDF_TRANSCRIPTION_DPI, PDF_TRANSCRIPTION_VERSION, PDF_BLANK_PAGE,
  transcribePdfPage, type PdfConversionUsage } from "./pdf-transcription";
import type { LLMSettings, TokenUsage } from "./llm-client";

export interface PdfMarkdownOptions extends Pick<PdfPageOptions, "page" | "pages" | "start_page" | "count"> { refresh?: boolean; }
interface ConversionMetadata {
  model: string; convertedAt: string; dpi: number; effectiveDpi: number; attempts: number;
  usage?: TokenUsage; queueMs: number; renderMs: number; modelMs: number; writeMs: number;
}
interface CachedMarkdown {
  version: number; sourceId: string; stamp: string; page: number; pageCount: number;
  markdown: string; digest: string; blank: boolean; uncertain: boolean; conversion: ConversionMetadata;
}
export interface PdfMarkdownPage {
  pdf_page: number; status: "transcribed" | "error";
  markdown?: string; blank?: boolean; uncertain?: boolean;
  cache: "hit" | "saved" | "not-saved" | "none";
  delivery: "cache" | "converted" | "shared";
  conversion?: ConversionMetadata; error?: string; cache_warning?: string; duration_ms: number;
}
export interface PdfMarkdownContext {
  signal?: AbortSignal; settings?: LLMSettings;
  assertCurrent?: () => void;
  onUsage?: (event: PdfConversionUsage) => void;
}
interface Waiter { onUsage?: PdfMarkdownContext["onUsage"]; }
interface Job {
  controller: { abort: () => void }; signal: AbortSignal; waiters: Set<Waiter>;
  promise: Promise<PdfMarkdownPage>;
}
const jobs = new Map<string, Job>();
const CONCURRENCY = 2;
let running = 0;
const queue: { signal: AbortSignal; start: () => void }[] = [];

/** Two actual conversions globally, including across windows and MCP clients. */
function acquire(signal: AbortSignal): Promise<() => void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const entry = { signal, start: () => {
      signal.removeEventListener("abort", abort);
      running++;
      let released = false;
      resolve(() => { if (!released) { released = true; running--; drain(); } });
    } };
    const abort = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      signal.removeEventListener("abort", abort);
      reject(Object.assign(new Error("The request was cancelled."), { name: "AbortError" }));
    };
    signal.addEventListener("abort", abort, { once: true });
    queue.push(entry);
    drain();
  });
}
function drain(): void {
  while (running < CONCURRENCY && queue.length) {
    const entry = queue.shift()!;
    if (!entry.signal.aborted) entry.start();
  }
}

async function digest(markdown: string): Promise<string> {
  const bytes = new TextEncoder().encode(markdown);
  return Array.from(new Uint8Array(await Zotero.getMainWindow().crypto.subtle.digest("SHA-256", bytes)))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function cachePath(item: Zotero.Item, page: number): string {
  return PathUtils.join(getCacheDir(), "pdf-markdown", sourceCacheKey(item), `page-${page}.json`);
}
async function readCached(path: string, sourceId: string, stamp: string, page: number, pageCount: number): Promise<CachedMarkdown | undefined> {
  try {
    const record = JSON.parse(new TextDecoder().decode(await IOUtils.read(path))) as CachedMarkdown;
    if (record.version !== PDF_TRANSCRIPTION_VERSION || record.sourceId !== sourceId || record.stamp !== stamp ||
      record.page !== page || record.pageCount !== pageCount || typeof record.markdown !== "string" || !record.markdown.trim() ||
      typeof record.conversion?.model !== "string" || record.digest !== await digest(record.markdown)) return;
    return record;
  } catch { return; }
}

function complete(record: CachedMarkdown, cache: PdfMarkdownPage["cache"]): PdfMarkdownPage {
  return { pdf_page: record.page, status: "transcribed", markdown: record.markdown, blank: record.blank,
    uncertain: record.uncertain, cache, delivery: "converted", conversion: record.conversion, duration_ms: 0 };
}

async function convert(item: Zotero.Item, page: number, info: { stamp: string; pageCount: number },
  settings: () => LLMSettings, job: Job, refresh = false): Promise<PdfMarkdownPage> {
  const sourceId = makeSourceId(item.key, item.libraryID), started = Date.now();
  let release: (() => void) | undefined;
  let config: LLMSettings | undefined;
  const current = async () => {
    throwIfAborted(job.signal);
    if ((await getPdfFileRevision(item)).stamp !== info.stamp) throw new Error("PDF changed during transcription. Read the updated page again.");
    throwIfAborted(job.signal);
  };
  try {
    release = await acquire(job.signal);
    const queueMs = Date.now() - started;
    await current();
    if (!refresh) {
      const cached = await readCached(cachePath(item, page), sourceId, info.stamp, page, info.pageCount);
      await current();
      if (cached) return { ...complete(cached, "hit"), delivery: "cache" };
    }
    config = settings();
    const renderStart = Date.now();
    const image = await readPdfPage(item, page, job.signal, PDF_TRANSCRIPTION_DPI);
    await current();
    const renderMs = Date.now() - renderStart, modelStart = Date.now();
    const response = await transcribePdfPage(image, config, sourceId, job.signal, event => {
      // Each physical model response is charged once, never again on a cache hit
      // or to every subscriber of a shared conversion.
      const owner = [...job.waiters].find(waiter => waiter.onUsage);
      owner?.onUsage?.(event);
    });
    const modelMs = Date.now() - modelStart;
    await current();
    const record: CachedMarkdown = {
      version: PDF_TRANSCRIPTION_VERSION, sourceId, stamp: info.stamp, page, pageCount: info.pageCount,
      markdown: response.markdown, digest: await digest(response.markdown),
      blank: response.markdown === PDF_BLANK_PAGE, uncertain: response.markdown.includes("[UNCERTAIN:"),
      conversion: { model: config.model, convertedAt: new Date().toISOString(), dpi: PDF_TRANSCRIPTION_DPI,
        effectiveDpi: image.effectiveDpi, usage: response.usage, attempts: response.attempts,
        queueMs, renderMs, modelMs, writeMs: 0 },
    };
    const path = cachePath(item, page), writeStart = Date.now();
    let cache: PdfMarkdownPage["cache"] = "saved", cacheWarning: string | undefined;
    try {
      await withStorageLock(path, async () => { await current(); await atomicWriteJson(path, record); });
    } catch (error) {
      await current();
      cache = "not-saved";
      cacheWarning = `This transcription is available for this call, but its cache could not be saved: ${safeError(error, config)}`;
    }
    record.conversion.writeMs = Date.now() - writeStart;
    await current();
    return { ...complete(record, cache), ...(cacheWarning ? { cache_warning: cacheWarning } : {}), duration_ms: Date.now() - started };
  } catch (error) {
    throwIfAborted(job.signal);
    // Page failures are explicit and independent; never discard successful siblings.
    return { pdf_page: page, status: "error", error: safeError(error, config), cache: "none", delivery: "converted", duration_ms: Date.now() - started };
  } finally { release?.(); }
}

function safeError(error: unknown, settings?: LLMSettings): string {
  let message = error instanceof Error ? error.message : String(error);
  if (settings?.apiKey) message = message.split(settings.apiKey).join("[redacted]");
  return message;
}

/** Caller cancellation detaches one subscriber; the last departure cancels work. */
function join(key: string, start: (job: Job) => Promise<PdfMarkdownPage>, context: PdfMarkdownContext): Promise<PdfMarkdownPage> {
  throwIfAborted(context.signal);
  let job = jobs.get(key);
  const shared = !!job;
  if (!job) {
    const { controller, signal } = createAbortController();
    job = { controller, signal, waiters: new Set(), promise: undefined! };
    const created = job;
    jobs.set(key, created);
    created.promise = Promise.resolve().then(() => start(created)).finally(() => { if (jobs.get(key) === created) jobs.delete(key); });
  }
  const active = job;
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { onUsage: context.onUsage };
    active.waiters.add(waiter);
    let settled = false;
    const detach = () => { context.signal?.removeEventListener("abort", abort); active.waiters.delete(waiter); };
    const abort = () => {
      if (settled) return;
      settled = true; detach();
      if (!active.waiters.size) {
        if (jobs.get(key) === active) jobs.delete(key);
        active.controller.abort();
      }
      reject(Object.assign(new Error("The request was cancelled."), { name: "AbortError" }));
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    active.promise.then(result => {
      if (settled) return;
      settled = true; detach();
      resolve({ ...result, delivery: result.cache === "hit" ? "cache" : shared ? "shared" : "converted" });
    }, error => { if (!settled) { settled = true; detach(); reject(error); } });
    if (context.signal?.aborted) abort();
  });
}

export async function readPdfMarkdown(item: Zotero.Item, options: PdfMarkdownOptions = {}, context: PdfMarkdownContext = {}): Promise<{
  page_count: number; next_page: number | null; pages: PdfMarkdownPage[];
}> {
  validatePageOptions(options);
  const check = () => { throwIfAborted(context.signal); context.assertCurrent?.(); };
  check();
  const info = await readPdfInfo(item, context.signal);
  check();
  const first = options.page ?? options.pages?.[0] ?? options.start_page ?? 1;
  if (first > info.pageCount) throw new Error("Page exceeds PDF page count.");
  const numbers = options.page !== undefined ? [options.page] : options.pages ??
    Array.from({ length: Math.min(options.count ?? 4, info.pageCount - first + 1) }, (_, index) => first + index);
  if (numbers.some(page => page > info.pageCount)) throw new Error("Page exceeds PDF page count.");
  const sourceId = makeSourceId(item.key, item.libraryID);
  let settings: LLMSettings | undefined;
  const config = () => settings ??= getPdfTranscriptionSettings(context.settings);
  const pages = await Promise.all(numbers.map(async page => {
    check();
    const started = Date.now(), path = cachePath(item, page);
    const cached = options.refresh ? undefined : await readCached(path, sourceId, info.stamp, page, info.pageCount);
    check();
    const result: PdfMarkdownPage = cached ? { ...complete(cached, "hit"), delivery: "cache" }
      : await join(JSON.stringify([path, info.stamp, PDF_TRANSCRIPTION_VERSION]), job => convert(item, page, info, config, job, options.refresh), context);
    check();
    result.duration_ms = Date.now() - started;
    void logPdfReading({ kind: "pdf-read", sourceId, page, model: result.conversion?.model, delivery: result.delivery,
      status: result.status, durationMs: result.duration_ms,
      ...(result.delivery !== "cache" ? { queueMs: result.conversion?.queueMs, renderMs: result.conversion?.renderMs,
        modelMs: result.conversion?.modelMs, writeMs: result.conversion?.writeMs } : {}) });
    return result;
  }));
  check();
  if ((await getPdfFileRevision(item)).stamp !== info.stamp) throw new Error("PDF changed during reading. Retry against the updated file.");
  check();
  const last = Math.max(...numbers);
  return { page_count: info.pageCount, next_page: last < info.pageCount ? last + 1 : null, pages };
}

export function cancelPdfConversions(): void {
  for (const job of jobs.values()) job.controller.abort();
  jobs.clear();
}
