/** Cache contract shared by PDF conversion engines. */
export interface PdfChunkPlanItem {
  index: number;
  startPage: number;
  endPage: number;
}

export interface PdfChunkResult extends PdfChunkPlanItem {
  markdown: string;
  assetCount?: number;
  selfCheck?: import("./vision-self-check").VisionSelfCheck;
}

export interface ConvertedPdf {
  markdown: string;
  pageCount: number;
  chunkSize: number;
  chunks: PdfChunkResult[];
  assetCount: number;
}

export function buildChunkPlan(pageCount: number, chunkSize: number): PdfChunkPlanItem[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || !Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Invalid PDF page count or chunk size");
  }
  const chunks: PdfChunkPlanItem[] = [];
  for (let start = 1, index = 1; start <= pageCount; start += chunkSize, index++) {
    chunks.push({ index, startPage: start, endPage: Math.min(pageCount, start + chunkSize - 1) });
  }
  return chunks;
}

export function mergeChunks(fileName: string, pageCount: number, chunks: PdfChunkResult[]): string {
  const lines = [`# ${fileName}`, "", `> Converted from a ${pageCount}-page PDF in ${chunks.length} chunks.`, ""];
  for (const chunk of chunks) {
    lines.push(`<!-- chatpdf-chunk:${chunk.index} pages:${chunk.startPage}-${chunk.endPage} -->`,
      `## Pages ${chunk.startPage}-${chunk.endPage}`, "", chunk.markdown.trim(), "");
  }
  return lines.join("\n");
}

export function throwIfConversionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Conversion aborted by user"), { name: "AbortError" });
}

/** Commit guard: contiguous pages, exact chunk bodies and complete line metadata. */
export function validateConversionContract(result: ConvertedPdf, manifest: import("./md-cache").DocumentManifest): void {
  const plan = buildChunkPlan(result.pageCount, result.chunkSize);
  if (result.chunks.length !== plan.length || manifest.chunks.length !== plan.length) throw new Error("PDF cache chunk count is inconsistent");
  for (let i = 0; i < plan.length; i++) {
    const chunk = result.chunks[i], meta = manifest.chunks[i], expected = plan[i];
    if (chunk.index !== expected.index || chunk.startPage !== expected.startPage || chunk.endPage !== expected.endPage
      || meta.index !== expected.index || meta.startPage !== expected.startPage || meta.endPage !== expected.endPage
      || meta.status !== "ready" || meta.charCount !== chunk.markdown.length || !chunk.markdown.trim()
      || !meta.lineStart || !meta.lineEnd || meta.lineStart > meta.lineEnd) {
      throw new Error("PDF cache has incomplete or inconsistent chunk metadata");
    }
    const body = result.markdown.split("\n").slice(meta.lineStart - 1, meta.lineEnd).join("\n");
    const expectedBody = `<!-- chatpdf-chunk:${chunk.index} pages:${chunk.startPage}-${chunk.endPage} -->\n## Pages ${chunk.startPage}-${chunk.endPage}\n\n${chunk.markdown.trim()}`;
    if (body.trim() !== expectedBody) throw new Error("PDF merged Markdown does not match its chunks");
    if (manifest.converter === "vision" && manifest.conversionConfig?.selfCheck) {
      const check = chunk.selfCheck;
      if (!check || check.method !== "same-response" || check.version !== 1 || !/^[a-f0-9]{64}$/.test(check.markdownDigest)
        || check.pages.length !== expected.endPage - expected.startPage + 1
        || check.pages.some((page, offset) => page !== expected.startPage + offset)
        || check.editsApplied !== check.edits.length || JSON.stringify(meta.selfCheck) !== JSON.stringify(check)) {
        throw new Error("PDF cache is missing a complete model self-check record");
      }
    }
  }
}
