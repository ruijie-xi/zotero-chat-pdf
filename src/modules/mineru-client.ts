import { getPref } from "../utils/prefs";
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
}

export interface ConvertedPdf {
  markdown: string;
  pageCount: number;
  chunkSize: number;
  chunks: PdfChunkResult[];
}

export interface ConvertPdfOptions {
  cachedChunks?: Map<number, string>;
  onPlan?: (pageCount: number, chunkSize: number, chunks: PdfChunkPlanItem[]) => void | Promise<void>;
  onChunkConverted?: (chunk: PdfChunkResult) => void | Promise<void>;
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
      const markdown = await convertPdfBytes(pdfBytes, PathUtils.filename(pdfPath), token, onProgress, signal);
      return {
        markdown,
        pageCount: 0,
        chunkSize: 0,
        chunks: [{ index: 1, startPage: 1, endPage: 0, markdown }],
      };
    }
  }
  const fileName = PathUtils.filename(pdfPath);
  const chunkSize = pageCount > MINERU_LONG_PDF_CHUNK_THRESHOLD ? MINERU_LONG_PDF_CHUNK_SIZE : pageCount;
  const plan = buildChunkPlan(pageCount, chunkSize);
  await options?.onPlan?.(pageCount, chunkSize, plan);

  if (plan.length === 1) {
    const markdown = await convertPdfBytes(pdfBytes, PathUtils.filename(pdfPath), token, onProgress, signal);
    const chunk = { ...plan[0], markdown };
    await options?.onChunkConverted?.(chunk);
    return {
      markdown,
      pageCount,
      chunkSize,
      chunks: [chunk],
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
    const markdown = await convertPdfBytes(
      pdfBytes,
      fileName,
      token,
      (status, message) => onProgress?.(status, `Chunk ${item.index}/${plan.length}: ${message}`),
      signal,
      pageRange,
    );
    const chunk = { ...item, markdown };
    convertedChunks.push(chunk);
    await options?.onChunkConverted?.(chunk);
  }

  convertedChunks.sort((a, b) => a.index - b.index);
  const markdown = mergeChunks(fileName, pageCount, convertedChunks);
  onProgress?.("done", `Conversion complete (${convertedChunks.length} chunks)`);
  return {
    markdown,
    pageCount,
    chunkSize,
    chunks: convertedChunks,
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
): Promise<string> {
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
  const applyRes = await fetch(`${MINERU_API_BASE}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

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
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    body: pdfBytes,
    signal,
  });

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

    const pollRes = await fetch(
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
      const zipRes = await fetch(zipUrl, { signal });
      if (!zipRes.ok) {
        log("ERROR: Failed to download ZIP:", zipRes.status);
        throw new Error(`Failed to download results (${zipRes.status})`);
      }

      const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
      log("Downloaded ZIP size:", zipBytes.length, "bytes");
      const markdown = await extractMarkdownFromZip(zipBytes);
      log("Extracted markdown length:", markdown.length);
      onProgress?.("done", "Conversion complete");
      return markdown;
    } else if (result.state === "failed") {
      log("ERROR: Conversion failed:", result.err_msg);
      throw new Error(
        `MinerU conversion failed: ${result.err_msg || "unknown error"}`,
      );
    }

    onProgress?.("processing", `Converting... (${result.state})`);
  }
}

/**
 * Extract the markdown content from a MinerU result ZIP.
 * The ZIP contains files like: {filename}.md, {filename}_model.json, etc.
 * We need to find and read the .md file.
 */
async function extractMarkdownFromZip(zipBytes: Uint8Array): Promise<string> {
  // Write ZIP to a temp file, extract, and read the .md file
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
      // Find the .md file in the ZIP
      const entries = zipReader.findEntries("*.md");
      let mdEntry: string | null = null;

      while (entries.hasMore()) {
        const entry = entries.getNext();
        // Pick the first .md file (skip _middle.md etc. if present)
        if (entry.endsWith(".md") && !entry.includes("_middle")) {
          mdEntry = entry;
          break;
        }
      }

      if (!mdEntry) {
        // Fallback: try any .md file
        const allEntries = zipReader.findEntries("*.md");
        if (allEntries.hasMore()) {
          mdEntry = allEntries.getNext();
        }
      }

      if (!mdEntry) {
        throw new Error("No markdown file found in conversion results");
      }

      // Read the markdown content from the ZIP
      const inputStream = zipReader.getInputStream(mdEntry);
      const scriptableStream = Components.classes[
        "@mozilla.org/scriptableinputstream;1"
      ].createInstance(Components.interfaces.nsIScriptableInputStream);
      scriptableStream.init(inputStream);

      const bytes = scriptableStream.readBytes(scriptableStream.available());
      scriptableStream.close();
      inputStream.close();

      // Decode UTF-8
      const decoder = new TextDecoder("utf-8");
      const uint8 = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        uint8[i] = bytes.charCodeAt(i);
      }
      return decoder.decode(uint8);
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
