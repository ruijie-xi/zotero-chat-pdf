import { h } from "../utils/dom";
import { formatChars } from "../utils/format";
import { SourceItem } from "./chat-session";
import {
  convertPdf,
  MINERU_LONG_PDF_CHUNK_SIZE,
  PdfChunkPlanItem,
  PdfChunkResult,
} from "./mineru-client";
import * as MDCache from "./md-cache";
import * as ChatHistory from "./chat-history";
import {
  session, conversionAbortControllers, createAbortController,
} from "./panel-state";

async function loadCachedChunks(key: string): Promise<Map<number, string>> {
  const chunks = new Map<number, string>();
  const manifest = await MDCache.readManifest(key);
  if (!manifest) return chunks;
  if (manifest.chunks.length > 1 && manifest.chunkSize !== MINERU_LONG_PDF_CHUNK_SIZE) {
    Zotero.debug(`[ChatPDF] Ignoring stale chunk cache for ${key}: chunkSize=${manifest.chunkSize}`);
    return chunks;
  }

  for (const chunk of manifest.chunks) {
    if (chunk.status !== "ready") continue;
    try {
      chunks.set(chunk.index, await MDCache.readChunk(key, chunk.index));
    } catch (err: any) {
      Zotero.debug(`[ChatPDF] Failed to read cached chunk ${chunk.index} for ${key}: ${err.message}`);
    }
  }
  return chunks;
}

function makeManifest(
  key: string,
  title: string,
  pageCount: number,
  chunkSize: number,
  plan: PdfChunkPlanItem[],
  cachedChunks: Map<number, string>,
): MDCache.DocumentManifest {
  return {
    version: 1,
    key,
    title,
    pageCount,
    chunkSize,
    updatedAt: Date.now(),
    chunks: plan.map((chunk) => {
      const cached = cachedChunks.get(chunk.index);
      return {
        ...chunk,
        status: cached ? "ready" : "pending",
        charCount: cached?.length,
      };
    }),
  };
}

function markChunkReady(
  manifest: MDCache.DocumentManifest,
  chunk: PdfChunkResult,
): MDCache.DocumentManifest {
  return {
    ...manifest,
    updatedAt: Date.now(),
    chunks: manifest.chunks.map((item) => item.index === chunk.index
      ? {
        ...item,
        status: "ready",
        charCount: chunk.markdown.length,
        errorMessage: undefined,
      }
      : item),
  };
}

function withLineRanges(
  manifest: MDCache.DocumentManifest,
  markdown: string,
): MDCache.DocumentManifest {
  const markerPattern = /^<!-- chatpdf-chunk:(\d+) pages:\d+-\d+ -->$/;
  const lines = markdown.split("\n");
  const ranges: { index: number; lineStart: number; lineEnd: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = markerPattern.exec(lines[i]);
    if (!match) continue;
    const previous = ranges[ranges.length - 1];
    if (previous) previous.lineEnd = i;
    ranges.push({
      index: Number(match[1]),
      lineStart: i + 1,
      lineEnd: lines.length,
    });
  }

  return {
    ...manifest,
    updatedAt: Date.now(),
    chunks: manifest.chunks.map((chunk) => {
      const range = ranges.find((r) => r.index === chunk.index);
      if (!range) return chunk;
      return {
        ...chunk,
        lineStart: range.lineStart,
        lineEnd: range.lineEnd,
      };
    }),
  };
}

/** Convert a pending source to markdown via MinerU. */
export async function convertSource(source: SourceItem, onProgress?: (msg: string) => void): Promise<void> {
  session.setSourceStatus(source.key, "converting");
  const { controller: convController, signal: convSignal } = createAbortController();
  conversionAbortControllers.set(source.key, convController);
  onProgress?.("Starting conversion...");
  try {
    let attItem: Zotero.Item | null = null;
    for (const lib of Zotero.Libraries.getAll()) {
      try {
        const found = Zotero.Items.getByLibraryAndKey(lib.libraryID, source.key);
        if (found) { attItem = found; break; }
      } catch {
        Zotero.debug(`[ChatPDF] convertSource: lookup failed for lib ${lib.libraryID}`);
        continue;
      }
    }
    if (!attItem) throw new Error(`Cannot find attachment with key ${source.key}`);
    const pdfPath = await attItem.getFilePathAsync();
    if (!pdfPath) throw new Error("PDF file not found on disk");

    const cachedChunks = await loadCachedChunks(source.key);
    let manifest: MDCache.DocumentManifest | null = null;
    const result = await convertPdf(
      pdfPath,
      (_status, msg) => onProgress?.(msg),
      convSignal,
      {
        cachedChunks,
        onPlan: async (pageCount, chunkSize, plan) => {
          manifest = makeManifest(source.key, source.title, pageCount, chunkSize, plan, cachedChunks);
          await MDCache.writeManifest(source.key, manifest);
        },
        onChunkConverted: async (chunk) => {
          await MDCache.writeChunk(source.key, chunk.index, chunk.markdown);
          if (manifest) {
            manifest = markChunkReady(manifest, chunk);
            await MDCache.writeManifest(source.key, manifest);
          }
        },
      },
    );
    await MDCache.write(source.key, result.markdown);
    if (manifest) {
      await MDCache.writeManifest(source.key, withLineRanges(manifest, result.markdown));
    }
    session.setSourceReady(source.key, result.markdown);
    onProgress?.("Ready");
  } catch (err: any) {
    if (err.name === "AbortError") {
      Zotero.debug(`[ChatPDF] convertSource aborted for ${source.key}`);
      session.setSourceStatus(source.key, "pending");
      onProgress?.("Conversion stopped");
    } else {
      Zotero.debug(`[ChatPDF] convertSource error: ${err.message}\n${err.stack}`);
      session.setSourceStatus(source.key, "error", err.message);
      onProgress?.(err.message);
      throw err;
    }
  } finally {
    conversionAbortControllers.delete(source.key);
  }
}

function saveCurrentSession(): void {
  if (!session.hasMessages()) return;
  ChatHistory.saveSession(session.toSavedSession()).catch((err: any) => {
    Zotero.debug(`[ChatPDF] save after source removal failed: ${err.message}`);
  });
}

/** Refresh the source chips UI in the panel. */
export function refreshSourceChips(root: HTMLElement): void {
  const container = root.querySelector("#chatpdf-source-chips");
  if (!container) return;
  const doc = root.ownerDocument!;
  container.innerHTML = "";

  const sources = session.getSources();
  if (sources.length === 0) return;

  for (const source of sources) {
    const chip = h(doc, "div", { className: `chatpdf-source-chip chatpdf-source-chip-${source.status}`, title: source.errorMessage || "" });

    // Status indicator
    const statusIndicator = h(doc, "span", { className: `chatpdf-chip-indicator chatpdf-chip-indicator-${source.status}` });
    chip.appendChild(statusIndicator);

    // Title
    const titleEl = h(doc, "span", { className: "chatpdf-chip-title" }, source.title);
    chip.appendChild(titleEl);

    // Size badge for ready sources
    if (source.status === "ready" && source.markdown) {
      const charLen = source.markdown.length;
      const sizeText = formatChars(charLen);
      const isTruncated = source.contextRatio !== undefined && source.contextRatio < 1.0;
      const badgeClass = isTruncated ? "chatpdf-chip-badge-truncated" : "chatpdf-chip-badge-ready";
      const label = isTruncated
        ? `${sizeText} (${Math.round(source.contextRatio! * 100)}%)`
        : sizeText;
      const badge = h(doc, "span", { className: `chatpdf-chip-badge ${badgeClass}` }, label);
      chip.appendChild(badge);
    } else if (source.status !== "pending" && source.status !== "ready") {
      const statusLabels: Record<string, string> = {
        converting: "Converting...",
        error: "Error",
      };
      const badge = h(doc, "span", { className: `chatpdf-chip-badge chatpdf-chip-badge-${source.status}` }, statusLabels[source.status] || "");
      chip.appendChild(badge);
    }

    // Actions
    const actions = h(doc, "span", { className: "chatpdf-chip-actions" });

    if (source.status === "pending") {
      const convertBtn = h(doc, "button", { className: "chatpdf-chip-text-btn", title: "Convert" }, "Convert");
      convertBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        convertSource(source, () => refreshSourceChips(root)).catch(() => refreshSourceChips(root));
        refreshSourceChips(root);
      });
      actions.appendChild(convertBtn);
    }

    if (source.status === "converting") {
      const stopBtn = h(doc, "button", { className: "chatpdf-chip-text-btn chatpdf-chip-stop-btn", title: "Stop conversion" }, "Stop");
      stopBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        const controller = conversionAbortControllers.get(source.key);
        if (controller) {
          Zotero.debug(`[ChatPDF] User stopped conversion for ${source.key}`);
          controller.abort();
        }
        refreshSourceChips(root);
      });
      actions.appendChild(stopBtn);
    }

    const removeBtn = h(doc, "button", { className: "chatpdf-chip-text-btn chatpdf-chip-remove-btn", title: "Remove source" }, "Remove");
    removeBtn.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      const controller = conversionAbortControllers.get(source.key);
      if (controller) {
        Zotero.debug(`[ChatPDF] Removing source ${source.key}; aborting active conversion`);
        controller.abort();
        conversionAbortControllers.delete(source.key);
      }
      session.removeSource(source.key);
      saveCurrentSession();
      refreshSourceChips(root);
    });
    actions.appendChild(removeBtn);

    chip.appendChild(actions);
    container.appendChild(chip);
  }

  // Total source size summary
  const readySources = sources.filter((s) => s.status === "ready" && s.markdown);
  if (readySources.length > 0) {
    const totalChars = readySources.reduce((sum, s) => sum + (s.markdown?.length ?? 0), 0);
    const summary = h(doc, "div", { className: "chatpdf-source-summary" },
      `${formatChars(totalChars)} chars`);
    container.appendChild(summary);
  }
}
