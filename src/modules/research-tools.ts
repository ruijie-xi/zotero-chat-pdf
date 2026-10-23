import type { ToolExecutionContext } from "./tools";
import { getItemByKey } from "./zotero-items";
import { readPdfText, readPdfPages, pdfTextStatus, searchPdfText, PdfSearchOptions, PdfPageOptions } from "./pdf-text";
import { checkImageSize } from "./image-input";
import { contextFingerprint } from "./agent-context";
import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import { getCacheDir } from "../utils/cache-dir";
import { applyLibraryChanges, listLibraryChanges, planLibraryChanges, summarizeLibraryChange, LibraryAction } from "./library-changes";
import { throwIfAborted } from "../utils/abort";
import { pdfCitation } from "./source-citation";
import { readPdfMarkdown, type PdfMarkdownOptions } from "./pdf-markdown";
import { locatePdfContent, type PdfLocateOptions } from "./pdf-locations";
import { getLLMSettings } from "./llm-client";
import { readZoteroNotes, searchZoteroNotes } from "./zotero-notes";

import { RESEARCH_TOOLS } from "./tool-registry";
export { RESEARCH_TOOLS } from "./tool-registry";

function source(context: ToolExecutionContext, key: unknown) {
  const source = context.session.getSource(String(key || ""));
  if (!source || !context.turnScope.has(source.id)) throw new Error("Document is outside this turn's source scope. Use list_sources or add a relevant source.");
  const attachment = getItemByKey(source.key, source.libraryID);
  if (!attachment?.isPDFAttachment()) throw new Error("Source has no local PDF attachment.");
  return { source, attachment };
}
const json = (value: unknown) => JSON.stringify(value);

export async function executeResearchTool(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<string | null> {
  if (!RESEARCH_TOOLS.some(tool => tool.function.name === name)) return null;
  throwIfAborted(context.signal);
  if (name === "search_pdf_text") return json(await searchPdfText(args as unknown as PdfSearchOptions, context.signal));
  if (name === "search_zotero_notes") return json(await searchZoteroNotes(args, context.signal));
  if (name === "change_zotero_library") return json(await changeLibrary(args, context));
  if (name === "read_zotero_notes") {
    return json(await readZoteroNotes(args, context.signal));
  }
  const { source: src, attachment } = source(context, args.key);
  const assertCurrent = () => {
    throwIfAborted(context.signal);
    if (context.session.getSource(src.id) !== src || !context.turnScope.has(src.id)) {
      throw Object.assign(new Error("The source was replaced while reading."), { name: "AbortError" });
    }
  };
  if (name === "locate_pdf_content") {
    const result = await locatePdfContent(attachment, args as unknown as PdfLocateOptions, context.signal);
    assertCurrent();
    return json({ source_id: src.id, ...result, matches: result.matches.map(match => ({ ...match,
      citation: pdfCitation(attachment, match.pdf_page, match.region ? { rects: match.rects, revision: result.revision } : {}),
    })) });
  }
  if (name === "get_document_status") {
    const text = await pdfTextStatus(attachment);
    assertCurrent();
    return json({ source_id: src.id, representation: "original-pdf", text,
      page_count: text.page_count || null, reading: "read_pdf_page", visual_review: "inspect_pdf_page",
      note: "Read pages as cached Markdown, transcribed on demand by the configured visual model. Inspect original images for careful review. Search coverage depends on extractable PDF text." });
  }
  if (name === "read_pdf_page") {
    const batch = await readPdfMarkdown(attachment, args as PdfMarkdownOptions, {
      signal: context.signal, assertCurrent,
      settings: context.llmSettings || { ...getLLMSettings(), sessionId: context.session.id },
      onUsage: context.onPdfConversionUsage || (event => context.session.addAuxiliaryUsage(event.usage)),
    });
    assertCurrent();
    return json({ source_id: src.id, representation: "page-markdown", ...batch,
      // Per-read timings belong in diagnostics, not semantic tool results: varying
      // timings would defeat the agent's identical-call loop detector.
      pages: batch.pages.map(({ duration_ms: _duration, ...page }) => ({ ...page, citation: pdfCitation(attachment, page.pdf_page) })),
      note: "Model transcription, not verified original text. Page images were sent only to the transcription model. Use inspect_pdf_page for careful review of uncertain notation, key formulas, table values and figures. A cached or prefetched page is not read by you until its content is delivered. Failed pages are explicitly listed; do not claim complete coverage when a page failed." });
  }
  if (name === "inspect_pdf_page") {
    if (!context.deliverImage) throw new Error("Image delivery is unavailable outside an active turn.");
    const batch = await readPdfPages(attachment, args as PdfPageOptions, context.signal, true);
    assertCurrent();
    // Validate the whole batch before delivering any image; a failed tool must
    // not leave an unlabelled partial image batch in either caller's context.
    const images = batch.pages.map(rendered => {
      const encoded = rendered.dataUrl.split(",")[1] || "";
      const byteLength = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      checkImageSize(byteLength);
      const region = rendered.region;
      const crop = region ? `-region-${region.x}-${region.y}-${region.width}-${region.height}` : "";
      return { sourceId: src.id, path: `pdf-page-${rendered.page}${crop}`, mime: "image/jpeg", dataUrl: rendered.dataUrl, byteLength,
        label: `${src.title}: PDF page ${rendered.page}${region ? `, cropped region ${JSON.stringify(region)}` : ", full page"}; ${rendered.width} x ${rendered.height} pixels, effective DPI ${rendered.effectiveDpi}.` };
    });
    for (const image of images) context.deliverImage(image);
    const pages = batch.pages.map(rendered => ({ pdf_page: rendered.page, citation: pdfCitation(attachment, rendered.page, { region: rendered.region }),
      width: rendered.width, height: rendered.height, effective_dpi: rendered.effectiveDpi, ...(rendered.region ? { region: rendered.region } : {}) }));
    return json({ source_id: src.id, representation: args.region ? "page-region-image" : pages.length === 1 ? "page-image" : "page-images",
      page_count: batch.pageCount, ...(pages.length === 1 ? pages[0] : {}), pages, next_page: batch.nextPage });
  }
  const record = await readPdfText(attachment, context.signal, true);
  assertCurrent();
  const from = args.start_page === undefined ? 1 : Number(args.start_page), to = args.end_page === undefined ? record.pageCount : Number(args.end_page);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > record.pageCount) throw new Error("Use an inclusive page range within the PDF page count.");
  return json({ source_id: src.id, representation: "pdf-text", digest: record.digest, page_count: record.pageCount,
    pages: record.pages.filter(page => page.page! >= from && page.page! <= to).map(page => ({ ...page, citation: pdfCitation(attachment, page.page!) })),
    note: "Extracted text for search and navigation. Prefer read_pdf_page Markdown for reading and summaries; use inspect_pdf_page for original-image review. Extraction may lose formulas and layout. Identify the evidence limitation when relying on extracted text." });
}

async function changeLibrary(args: Record<string, unknown>, context: ToolExecutionContext): Promise<Record<string, unknown>> {
  const mode = String(args.mode || "apply");
  if (!["preview", "apply", "list", "undo"].includes(mode)) throw new Error("Invalid change mode.");
  if (mode === "list") return { changes: (await listLibraryChanges()).map(summarizeLibraryChange) };
  const records = await listLibraryChanges();
  const actions = args.actions as (LibraryAction & { expected_revision?: string })[];
  if (args.change_id && args.actions) throw new Error("Use change_id to apply a saved preview, or actions to plan a new change; do not combine them.");
  const id = args.change_id ? String(args.change_id) : `change:${context.session.id}:${String(args.operation_id || `${context.requestId}:${contextFingerprint(actions)}`)}`;
  let plan = records.find(record => record.id === id);
  if (plan?.actionHash && args.actions && plan.actionHash !== contextFingerprint(actions)) throw new Error("operation_id is already used for different actions. Use a new operation_id.");
  if (!plan) {
    if (args.change_id || mode === "undo") throw new Error("Unknown change_id.");
    for (const action of actions || []) if (action.action === "update_note") {
      const note = getItemByKey(String(action.note_key || ""), action.library_id);
      if (!action.expected_revision || !note?.isNote() || contextFingerprint(note.getNote()) !== action.expected_revision) throw new Error("Note revision missing or changed. Read the note before updating it.");
    }
    plan = planLibraryChanges(actions); plan.id = id; plan.actionHash = contextFingerprint(actions);
    // Persist preview once so applying it cannot silently re-plan against changed user data.
    const path = PathUtils.join(getCacheDir(), "library-changes.json");
    const prepared = plan;
    await withStorageLock(path, async () => {
      const latest = await listLibraryChanges();
      if (!latest.some(record => record.id === id)) { latest.push(prepared); await atomicWriteJson(path, latest); }
    });
    plan = (await listLibraryChanges()).find(record => record.id === id)!;
  }
  if (mode !== "preview") {
    if (!context.libraryAccess) throw new Error("Library edit scope is unavailable outside an active panel turn.");
    plan = await applyLibraryChanges(plan, context.libraryAccess, context.approveLibraryChanges, context.signal, mode === "undo");
  }
  return summarizeLibraryChange(plan);
}
