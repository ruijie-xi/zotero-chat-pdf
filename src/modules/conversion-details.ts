import type { TokenUsage } from "./llm-client";
import type { PdfChunkPlanItem } from "./pdf-conversion";

export type ChunkStage = "queued" | "rendering" | "requesting" | "receiving" | "validating" | "retrying" | "ready" | "error" | "cancelled";
export interface ChunkDetail extends PdfChunkPlanItem {
  stage: ChunkStage;
  startedAt?: number;
  endedAt?: number;
  reused?: boolean;
  editsApplied?: number;
  error?: string;
}
export interface RequestDetail {
  id: string;
  chunk: number;
  pages: number[];
  startedAt: number;
  endedAt?: number;
  state: "waiting" | "receiving" | "accepted" | "rejected" | "error" | "cancelled" | "interrupted";
  estimatedInputTokens: number;
  imageBytes: number;
  outputChars?: number;
  usage?: TokenUsage;
  finishReason?: string;
  error?: string;
}
export interface ConversionDetails {
  version: 1;
  pageCount: number;
  renderedPages: number[];
  chunks: ChunkDetail[];
  requests: RequestDetail[];
  events: { at: number; message: string; chunk?: number }[];
}
export type ConversionDetailEvent =
  | { type: "plan"; pageCount: number; chunks: PdfChunkPlanItem[] }
  | { type: "rendered"; page: number }
  | { type: "chunk"; chunk: number; stage: ChunkStage; reused?: boolean; editsApplied?: number; message?: string }
  | { type: "request"; request: RequestDetail }
  | { type: "request-update"; id: string; patch: Partial<Omit<RequestDetail, "id" | "pages" | "chunk">> }
  | { type: "message"; message: string; chunk?: number };

export const emptyConversionDetails = (): ConversionDetails => ({ version: 1, pageCount: 0, renderedPages: [], chunks: [], requests: [], events: [] });

/** A restored request has no live reader; do not invent its completion time or usage. */
export function interruptConversionRequests(details: ConversionDetails): void {
  for (const request of details.requests) {
    if (request.state !== "waiting" && request.state !== "receiving") continue;
    request.state = "interrupted";
    request.error = "Request interrupted; final response and duration were not recorded";
  }
}

export function safeConversionUsage(value: TokenUsage): TokenUsage {
  const usage: TokenUsage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"] as const) {
    if (Number.isSafeInteger(value[key]) && value[key]! >= 0) usage[key] = value[key];
  }
  const reasoning = value.completion_tokens_details?.reasoning_tokens;
  if (Number.isSafeInteger(reasoning) && reasoning! >= 0) usage.completion_tokens_details = { reasoning_tokens: reasoning };
  return usage;
}

/** Diagnostics contain metadata only. Paths and endpoint URLs stay out of the UI/history. */
export function safeConversionMessage(message: string): string {
  if (/https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|(?:^|\s)\/(?:Users|home|var|tmp|private|mnt|cache|data)\b|\\\\/.test(message)) {
    const code = /\bNS_ERROR_[A-Z_]+\b/.exec(message)?.[0];
    return code ? `Local storage operation failed (${code})` : "Local operation failed; location details hidden";
  }
  return message;
}

export function applyConversionEvent(details: ConversionDetails, event: ConversionDetailEvent, at = Date.now()): void {
  const log = (message: string, chunk?: number) => details.events.push({ at, message: safeConversionMessage(message), chunk });
  if (event.type === "plan") {
    details.pageCount = event.pageCount;
    details.renderedPages = [];
    details.chunks = event.chunks.map(chunk => ({ index: chunk.index, startPage: chunk.startPage, endPage: chunk.endPage, stage: "queued" }));
    log(`Planned ${event.pageCount} pages in ${event.chunks.length} chunks`);
  } else if (event.type === "rendered") {
    if (!details.renderedPages.includes(event.page)) details.renderedPages.push(event.page);
  } else if (event.type === "chunk") {
    const chunk = details.chunks.find(chunk => chunk.index === event.chunk);
    if (!chunk) return;
    chunk.stage = event.stage;
    chunk.startedAt ??= at;
    if (event.reused !== undefined) chunk.reused = event.reused;
    if (event.editsApplied !== undefined) chunk.editsApplied = event.editsApplied;
    if (["ready", "error", "cancelled"].includes(event.stage)) chunk.endedAt = at;
    if (event.stage === "error") chunk.error = safeConversionMessage(event.message || "Conversion failed");
    if (event.message) log(event.message, event.chunk);
  } else if (event.type === "request") {
    details.requests.push({ ...event.request, pages: [...event.request.pages] });
    log(`Sent pages ${event.request.pages.join(", ")} to the model`, event.request.chunk);
  } else if (event.type === "request-update") {
    const request = details.requests.find(request => request.id === event.id);
    if (!request) return;
    Object.assign(request, event.patch, event.patch.usage ? { usage: safeConversionUsage(event.patch.usage) } : {},
      event.patch.error ? { error: safeConversionMessage(event.patch.error) } : {});
    if (event.patch.endedAt) log(`Request ${request.state}${request.error ? `: ${request.error}` : ""}`, request.chunk);
  } else log(event.message, event.chunk);
}

export function conversionCounts(details: ConversionDetails): { completedPages: number; reusedPages: number; renderedPages: number } {
  const ready = details.chunks.filter(chunk => chunk.stage === "ready");
  const pages = (chunks: ChunkDetail[]) => chunks.reduce((sum, chunk) => sum + chunk.endPage - chunk.startPage + 1, 0);
  return { completedPages: pages(ready), reusedPages: pages(ready.filter(chunk => chunk.reused)), renderedPages: details.renderedPages.length };
}

/** Drafts are transient, unvalidated text. The model's audit footer is never displayed as document text. */
export function conversionDraftPage(markdown: string, page: number): string {
  const footer = markdown.indexOf("<!-- chatpdf-self-check");
  const text = footer < 0 ? markdown : markdown.slice(0, footer);
  const markers = [...text.matchAll(/^<!-- chatpdf-page:(\d+) -->[ \t]*$/gm)];
  const index = markers.findIndex(marker => Number(marker[1]) === page);
  if (index < 0) return "";
  // A streamed, unfinished control marker is not document content either.
  return text.slice(markers[index].index! + markers[index][0].length, markers[index + 1]?.index ?? text.length)
    .replace(/<!--[^>]*$/, "").trim();
}
