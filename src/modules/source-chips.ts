import { h } from "../utils/dom";
import { formatChars } from "../utils/format";
import { getPref } from "../utils/prefs";
import { SourceItem } from "./chat-session";
import { convertPdf } from "./mineru-client";
import * as MDCache from "./md-cache";
import {
  session, conversionAbortControllers, createAbortController,
} from "./panel-state";

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

    const markdown = await convertPdf(pdfPath, (_status, msg) => onProgress?.(msg), convSignal);
    await MDCache.write(source.key, markdown);
    session.setSourceReady(source.key, markdown);
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

    chip.appendChild(actions);
    container.appendChild(chip);
  }

  // Total usage summary bar
  const readySources = sources.filter((s) => s.status === "ready" && s.markdown);
  if (readySources.length > 0) {
    const totalChars = readySources.reduce((sum, s) => sum + (s.markdown?.length ?? 0), 0);
    const maxDocChars = (getPref("maxDocumentChars") as number) || 300000;
    const exceeds = totalChars > maxDocChars;
    const summaryClass = exceeds ? "chatpdf-source-summary chatpdf-source-summary-over" : "chatpdf-source-summary";
    const summary = h(doc, "div", { className: summaryClass },
      `${formatChars(totalChars)} / ${formatChars(maxDocChars)} chars`);
    container.appendChild(summary);
  }
}
