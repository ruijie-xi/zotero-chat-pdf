import { getPref } from "../utils/prefs";
import { ensureDir } from "../utils/cache-dir";
import { PDFDocument } from "pdf-lib";

const MINERU_API_BASE = "https://mineru.net";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 900000; // 15 minutes
export const MINERU_LONG_PDF_CHUNK_THRESHOLD = 120;
export const MINERU_LONG_PDF_CHUNK_SIZE = 25;

function log(...args: any[]) {
  Zotero.debug(`[ChatPDF/MinerU] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`);
}

export type ProgressCallback = (
  status: "uploading" | "processing" | "downloading" | "done" | "error",
  message: string,
) => void;

interface BatchApplyResponse {
  batch_id: string;
  file_urls: string[];
}

interface ExtractResult {
  state: string;
  err_msg?: string;
  full_zip_url?: string;
}

interface BatchResultResponse {
  extract_result: ExtractResult[];
}

export interface PdfChunkPlanItem {
  index: number;
  startPage: number;
  endPage: number;
}

export interface PdfChunkResult extends PdfChunkPlanItem {
  markdown: string;
  assetCount?: number;
}

export interface ConvertedPdf {
  markdown: string;
  pageCount: number;
  chunkSize: number;
  chunks: PdfChunkResult[];
  assetCount: number;
}

export interface ConvertPdfOptions {
  outputDir?: string;
  cachedChunks?: Map<number, string>;
  onPlan?: (pageCount: number, chunkSize: number, chunks: PdfChunkPlanItem[]) => void | Promise<void>;
  onChunkConverted?: (chunk: PdfChunkResult) => void | Promise<void>;
}

interface MineruJobResult {
  markdown: string;
  assetCount: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Conversion aborted by user");
    err.name = "AbortError";
    throw err;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeRequestTarget(input: string | URL | Request): string {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw;
  }
}

async function mineruFetch(
  stage: string,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err: any) {
    const target = describeRequestTarget(input);
    const message = err?.message || String(err);
    const cdnHint = target.startsWith("https://cdn-mineru.openxlab.org.cn/")
      ? " MinerU returns conversion ZIP files from this CDN; if only this step fails, configure Zotero/system proxy or VPN so Zotero can reach cdn-mineru.openxlab.org.cn."
      : "";
    log(`${stage} network error:`, message, "target:", target);
    throw new Error(
      `${stage} failed before receiving a response from ${target}: ${message}. ` +
      `Check network/proxy settings and extension host permissions.${cdnHint}`,
    );
  }
}

async function downloadResultZip(zipUrl: string, signal?: AbortSignal): Promise<Uint8Array> {
  try {
    const zipRes = await mineruFetch("MinerU result download", zipUrl, { signal });
    if (!zipRes.ok) {
      log("ERROR: Failed to download ZIP:", zipRes.status);
      throw new Error(`Failed to download results (${zipRes.status})`);
    }
    return new Uint8Array(await zipRes.arrayBuffer());
  } catch (fetchErr: any) {
    throwIfAborted(signal);
    log("MinerU result fetch download failed; trying Zotero.HTTP fallback:", fetchErr?.message || String(fetchErr));
  }

  let cancelRequest: (() => void) | undefined;
  const abortFallback = () => cancelRequest?.();
  signal?.addEventListener("abort", abortFallback, { once: true });

  try {
    const xhr = await Zotero.HTTP.request("GET", zipUrl, {
      responseType: "arraybuffer",
      noCache: true,
      timeout: 120000,
      cancellerReceiver: (cancel: () => void) => {
        cancelRequest = cancel;
        if (signal?.aborted) cancelRequest();
      },
    });
    throwIfAborted(signal);
    const response = xhr.response;
    if (response instanceof ArrayBuffer) {
      return new Uint8Array(response);
    }
    if (ArrayBuffer.isView(response)) {
      return new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
    }
    if (response instanceof Blob) {
      return new Uint8Array(await response.arrayBuffer());
    }
    throw new Error(`Unexpected Zotero.HTTP response type: ${typeof response}`);
  } catch (httpErr: any) {
    throwIfAborted(signal);
    const message = httpErr?.message || String(httpErr);
    log("MinerU result Zotero.HTTP fallback failed:", message);
    throw new Error(
      `MinerU result download failed with fetch and Zotero.HTTP fallback from ${describeRequestTarget(zipUrl)}: ${message}`,
    );
  } finally {
    signal?.removeEventListener("abort", abortFallback);
  }
}

export async function convertPdf(
  pdfPath: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  options?: ConvertPdfOptions,
): Promise<ConvertedPdf> {
  const token = String(getPref("mineruToken") || "");
  if (!token) {
    throw new Error("MinerU API token not configured. Set it in ChatPDF preferences.");
  }

  onProgress?.("uploading", "Reading PDF file...");
  const pdfBytes = await IOUtils.read(pdfPath);
  log("Read PDF:", pdfPath, "size:", pdfBytes.length, "bytes");

  throwIfAborted(signal);
  let pageCount: number;
  try {
    const sourcePdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    pageCount = sourcePdf.getPageCount();
  } catch (err: any) {
    const estimatedPageCount = estimatePageCount(pdfBytes);
    if (estimatedPageCount) {
      pageCount = estimatedPageCount;
      log("PDF page count estimated from raw PDF tokens:", pageCount, "pdf-lib error:", err.message);
      onProgress?.("uploading", `Estimated ${pageCount} pages; using page-range chunked conversion...`);
    } else {
      log("Could not inspect PDF page count; falling back to single upload:", err.message);
      onProgress?.("uploading", "Could not inspect PDF page count; converting as a single MinerU job...");
      const result = await convertPdfBytes(
        pdfBytes,
        PathUtils.filename(pdfPath),
        token,
        onProgress,
        signal,
        undefined,
        options?.outputDir,
        "attachments/full",
      );
      return {
        markdown: result.markdown,
        pageCount: 0,
        chunkSize: 0,
        chunks: [{ index: 1, startPage: 1, endPage: 0, markdown: result.markdown, assetCount: result.assetCount }],
        assetCount: result.assetCount,
      };
    }
  }
  const fileName = PathUtils.filename(pdfPath);
  const chunkSize = pageCount > MINERU_LONG_PDF_CHUNK_THRESHOLD ? MINERU_LONG_PDF_CHUNK_SIZE : pageCount;
  const plan = buildChunkPlan(pageCount, chunkSize);
  await options?.onPlan?.(pageCount, chunkSize, plan);

  if (plan.length === 1) {
    const result = await convertPdfBytes(
      pdfBytes,
      PathUtils.filename(pdfPath),
      token,
      onProgress,
      signal,
      undefined,
      options?.outputDir,
      "attachments/full",
    );
    const chunk = { ...plan[0], markdown: result.markdown, assetCount: result.assetCount };
    await options?.onChunkConverted?.(chunk);
    return {
      markdown: result.markdown,
      pageCount,
      chunkSize,
      chunks: [chunk],
      assetCount: result.assetCount,
    };
  }

  onProgress?.("processing", `Long PDF detected (${pageCount} pages). Converting ${plan.length} chunks...`);
  const convertedChunks: PdfChunkResult[] = [];
  for (const item of plan) {
    throwIfAborted(signal);
    const cached = options?.cachedChunks?.get(item.index);
    if (cached) {
      onProgress?.("processing", `Using cached chunk ${item.index}/${plan.length} (pages ${item.startPage}-${item.endPage})`);
      convertedChunks.push({ ...item, markdown: cached });
      continue;
    }

    onProgress?.("uploading", `Requesting chunk ${item.index}/${plan.length} (pages ${item.startPage}-${item.endPage})...`);
    const pageRange = `${item.startPage}-${item.endPage}`;
    const result = await convertPdfBytes(
      pdfBytes,
      fileName,
      token,
      (status, message) => onProgress?.(status, `Chunk ${item.index}/${plan.length}: ${message}`),
      signal,
      pageRange,
      options?.outputDir,
      `attachments/chunk-${String(item.index).padStart(4, "0")}`,
    );
    const chunk = { ...item, markdown: result.markdown, assetCount: result.assetCount };
    convertedChunks.push(chunk);
    await options?.onChunkConverted?.(chunk);
  }

  convertedChunks.sort((a, b) => a.index - b.index);
  const markdown = mergeChunks(fileName, pageCount, convertedChunks);
  const assetCount = convertedChunks.reduce((sum, chunk) => sum + (chunk.assetCount || 0), 0);
  onProgress?.("done", `Conversion complete (${convertedChunks.length} chunks)`);
  return {
    markdown,
    pageCount,
    chunkSize,
    chunks: convertedChunks,
    assetCount,
  };
}

function buildChunkPlan(pageCount: number, chunkSize: number): PdfChunkPlanItem[] {
  const chunks: PdfChunkPlanItem[] = [];
  for (let start = 1, index = 1; start <= pageCount; start += chunkSize, index++) {
    chunks.push({
      index,
      startPage: start,
      endPage: Math.min(pageCount, start + chunkSize - 1),
    });
  }
  return chunks;
}

function estimatePageCount(pdfBytes: Uint8Array): number | null {
  try {
    const text = new TextDecoder("windows-1252").decode(pdfBytes);
    const matches = text.match(/\/Type\s*\/Page\b/g);
    return matches?.length || null;
  } catch {
    return null;
  }
}

function mergeChunks(fileName: string, pageCount: number, chunks: PdfChunkResult[]): string {
  const lines = [
    `# ${fileName}`,
    "",
    `> Converted from a ${pageCount}-page PDF in ${chunks.length} chunks.`,
    "",
  ];

  for (const chunk of chunks) {
    lines.push(`<!-- chatpdf-chunk:${chunk.index} pages:${chunk.startPage}-${chunk.endPage} -->`);
    lines.push(`## Pages ${chunk.startPage}-${chunk.endPage}`);
    lines.push("");
    lines.push(chunk.markdown.trim());
    lines.push("");
  }

  return lines.join("\n");
}

async function convertPdfBytes(
  pdfBytes: Uint8Array,
  fileName: string,
  token: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  pageRange?: string,
  outputDir?: string,
  assetPrefix?: string,
): Promise<MineruJobResult> {
  // Step 2: Get upload URL via batch apply
  onProgress?.("uploading", "Requesting upload URL...");
  const fileRequest: { name: string; is_ocr: boolean; page_ranges?: string } = {
    name: fileName,
    is_ocr: false,
  };
  if (pageRange) {
    fileRequest.page_ranges = pageRange;
  }

  const requestBody = {
    enable_formula: true,
    enable_table: true,
    language: "en",
    model_version: "pipeline",
    files: [fileRequest],
  };
  log("Batch apply request:", requestBody);

  throwIfAborted(signal);
  const applyRes = await mineruFetch(
    "MinerU upload URL request",
    `${MINERU_API_BASE}/api/v4/file-urls/batch`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    },
  );

  const applyText = await applyRes.text();
  log("Batch apply response status:", applyRes.status, "body:", applyText);

  if (!applyRes.ok) {
    throw new Error(`MinerU batch apply failed (${applyRes.status}): ${applyText}`);
  }

  const applyData = JSON.parse(applyText) as {
    code: number;
    msg: string;
    data: BatchApplyResponse;
  };

  if (applyData.code !== 0) {
    throw new Error(`MinerU batch apply error (code ${applyData.code}): ${applyData.msg}`);
  }

  const { batch_id, file_urls } = applyData.data;
  const uploadUrl = file_urls[0];
  log("Got batch_id:", batch_id, "upload url:", uploadUrl?.substring(0, 80) + "...");

  // Step 3: Upload PDF bytes via PUT (as per MinerU docs)
  throwIfAborted(signal);
  onProgress?.("uploading", "Uploading PDF...");
  const uploadRes = await mineruFetch(
    "MinerU PDF upload",
    uploadUrl,
    {
      method: "PUT",
      body: pdfBytes,
      signal,
    },
  );

  log("Upload response status:", uploadRes.status);
  if (!uploadRes.ok) {
    const uploadErrText = await uploadRes.text();
    log("Upload error body:", uploadErrText);
    throw new Error(`PDF upload failed (${uploadRes.status}): ${uploadErrText}`);
  }

  // Step 4: Poll for results
  onProgress?.("processing", "Converting PDF to Markdown...");
  const startTime = Date.now();

  while (true) {
    throwIfAborted(signal);

    if (Date.now() - startTime > POLL_TIMEOUT_MS) {
      throw new Error("MinerU conversion timed out after 6 minutes");
    }

    await delay(POLL_INTERVAL_MS);
    throwIfAborted(signal);

    const pollRes = await mineruFetch(
      "MinerU result polling",
      `${MINERU_API_BASE}/api/v4/extract-results/batch/${batch_id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal,
      },
    );

    if (!pollRes.ok) {
      const pollErrText = await pollRes.text();
      log("Poll HTTP error:", pollRes.status, pollErrText);
      continue;
    }

    const pollText = await pollRes.text();
    log("Poll response body:", pollText);

    const pollData = JSON.parse(pollText) as {
      code: number;
      msg: string;
      data: BatchResultResponse;
    };

    if (pollData.code !== 0) {
      log("Poll non-zero code:", pollData.code, pollData.msg);
      continue;
    }

    const result = pollData.data.extract_result[0];
    log("Extract result state:", result.state, "err_msg:", result.err_msg, "full_zip_url:", result.full_zip_url?.substring(0, 60));

    if (result.state === "done") {
      const zipUrl = result.full_zip_url;
      if (!zipUrl) {
        log("ERROR: No download URL in done result");
        throw new Error("Conversion completed but no download URL returned");
      }

      // Step 5: Download ZIP and extract markdown
      throwIfAborted(signal);
      onProgress?.("downloading", "Downloading results...");
      const zipBytes = await downloadResultZip(zipUrl, signal);
      log("Downloaded ZIP size:", zipBytes.length, "bytes");
      const extracted = await extractMarkdownFromZip(zipBytes, outputDir, assetPrefix);
      log("Extracted markdown length:", extracted.markdown.length, "asset count:", extracted.assetCount);
      onProgress?.("done", "Conversion complete");
      return extracted;
    } else if (result.state === "failed") {
      log("ERROR: Conversion failed:", result.err_msg);
      throw new Error(
        `MinerU conversion failed: ${result.err_msg || "unknown error"}`,
      );
    }

    onProgress?.("processing", `Converting... (${result.state})`);
  }
}

function isSafeZipEntry(entry: string): boolean {
  if (!entry || entry.startsWith("/") || entry.startsWith("\\") || /^[a-zA-Z]:/.test(entry)) {
    return false;
  }
  return entry.split(/[\\/]+/).every(part => part !== "" && part !== "." && part !== "..");
}

function normalizeZipEntry(entry: string): string {
  return entry.replace(/\\/g, "/").replace(/^\/+/, "");
}

function getSafeRelativeParts(relativePath: string): string[] {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (!parts.length || parts.some(part => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe ZIP asset path: ${relativePath}`);
  }
  return parts;
}

function joinSafeRelativePath(base: string, relativePath: string): string {
  return PathUtils.join(base, ...getSafeRelativeParts(relativePath));
}

function readZipEntryBytes(zipReader: any, entry: string): Uint8Array {
  const inputStream = zipReader.getInputStream(entry);
  const scriptableStream = Components.classes[
    "@mozilla.org/scriptableinputstream;1"
  ].createInstance(Components.interfaces.nsIScriptableInputStream);
  scriptableStream.init(inputStream);

  try {
    const chunks: string[] = [];
    let available = scriptableStream.available();
    while (available > 0) {
      chunks.push(scriptableStream.readBytes(available));
      available = scriptableStream.available();
    }
    const bytes = chunks.join("");
    const uint8 = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      uint8[i] = bytes.charCodeAt(i);
    }
    return uint8;
  } finally {
    scriptableStream.close();
    inputStream.close();
  }
}

function isPrimaryMarkdownEntry(entry: string): boolean {
  return entry.endsWith(".md") && !entry.includes("_middle");
}

function rewriteMarkdownAssetLinks(markdown: string, assetPrefix?: string): string {
  if (!assetPrefix) return markdown;
  const cleanPrefix = assetPrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!cleanPrefix) return markdown;
  const externalPattern = /^(?:[a-z][a-z0-9+.-]*:|#|\/|\\)/i;

  const rewrite = (rawPath: string): string => {
    const cleanPath = rawPath.trim();
    const normalized = cleanPath.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (
      !cleanPath ||
      externalPattern.test(cleanPath) ||
      normalized.split("/").some(part => part === "." || part === "..") ||
      normalized.startsWith(cleanPrefix + "/")
    ) {
      return rawPath;
    }
    return `${cleanPrefix}/${normalized}`;
  };

  return markdown
    .replace(/(!\[[^\]]*\]\()([^)\r\n]+)(\))/g, (_match, before, url, after) => {
      return `${before}${rewrite(url)}${after}`;
    })
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (_match, before, url, after) => {
      return `${before}${rewrite(url)}${after}`;
    });
}

function getZipEntryDir(entry: string): string {
  const slash = entry.lastIndexOf("/");
  return slash === -1 ? "" : entry.slice(0, slash);
}

function getAssetOutputEntry(assetEntry: string, mdEntry: string): string {
  const mdDir = getZipEntryDir(mdEntry);
  if (mdDir && assetEntry.startsWith(mdDir + "/")) {
    return assetEntry.slice(mdDir.length + 1);
  }
  return assetEntry;
}

/**
 * Extract the Markdown content and optional asset files from a MinerU result ZIP.
 */
async function extractMarkdownFromZip(
  zipBytes: Uint8Array,
  outputDir?: string,
  assetPrefix?: string,
): Promise<MineruJobResult> {
  const tempDir = PathUtils.join(PathUtils.tempDir, `chatpdf-${Date.now()}`);
  const tempZip = tempDir + ".zip";

  try {
    await IOUtils.write(tempZip, zipBytes);

    // Use Zotero's built-in ZIP extraction
    const zipReader = Components.classes[
      "@mozilla.org/libjar/zip-reader;1"
    ].createInstance(Components.interfaces.nsIZipReader);

    const zipFile = Components.classes[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile);
    zipFile.initWithPath(tempZip);

    zipReader.open(zipFile);

    try {
      const entries = zipReader.findEntries("*");
      let mdEntry: string | null = null;
      const assetEntries: string[] = [];

      while (entries.hasMore()) {
        const rawEntry = String(entries.getNext());
        const entry = normalizeZipEntry(rawEntry);
        if (!isSafeZipEntry(entry) || entry.endsWith("/")) {
          log("Skipping unsafe or directory ZIP entry:", rawEntry);
          continue;
        }
        if (isPrimaryMarkdownEntry(entry) && !mdEntry) {
          mdEntry = entry;
          continue;
        }
        if (!entry.endsWith(".md")) {
          assetEntries.push(entry);
        }
      }

      if (!mdEntry) {
        // Fallback: try any safe .md file
        const allEntries = zipReader.findEntries("*.md");
        while (allEntries.hasMore()) {
          const entry = normalizeZipEntry(String(allEntries.getNext()));
          if (!isSafeZipEntry(entry)) continue;
          mdEntry = entry;
          break;
        }
      }

      if (!mdEntry) {
        throw new Error("No markdown file found in conversion results");
      }

      const decoder = new TextDecoder("utf-8");
      let markdown = decoder.decode(readZipEntryBytes(zipReader, mdEntry));
      let assetCount = 0;

      if (outputDir && assetPrefix) {
        const cleanPrefix = assetPrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        const assetRoot = joinSafeRelativePath(outputDir, cleanPrefix);
        await ensureDir(assetRoot);

        for (const entry of assetEntries) {
          throwIfAborted();
          const outputEntry = getAssetOutputEntry(entry, mdEntry);
          const outputPath = joinSafeRelativePath(assetRoot, outputEntry);
          const parent = PathUtils.parent(outputPath);
          if (parent) await ensureDir(parent);
          await IOUtils.write(outputPath, readZipEntryBytes(zipReader, entry));
          assetCount++;
        }
        markdown = rewriteMarkdownAssetLinks(markdown, cleanPrefix);
      }

      return { markdown, assetCount };
    } finally {
      zipReader.close();
    }
  } finally {
    // Clean up temp file
    try {
      await IOUtils.remove(tempZip);
    } catch {
      // ignore cleanup errors
    }
  }
}
