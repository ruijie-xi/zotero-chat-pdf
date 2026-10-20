import type { ToolExecutionContext } from "./tools";
import { getItemByKey } from "./zotero-items";
import { readPdfText, readPdfPage, pdfTextStatus, searchPdfText, PdfSearchOptions } from "./pdf-text";
import { checkImageSize } from "./image-input";
import { contextFingerprint } from "./agent-context";
import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import { getCacheDir } from "../utils/cache-dir";
import { applyLibraryChanges, listLibraryChanges, planLibraryChanges, summarizeLibraryChange, LibraryAction } from "./library-changes";
import { throwIfAborted } from "../utils/abort";
import { pdfCitation } from "./source-citation";
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
    if (source(context, args.key).source !== src) {
      throw Object.assign(new Error("The source was replaced while reading."), { name: "AbortError" });
    }
  };
  if (name === "get_document_status") {
    const text = await pdfTextStatus(attachment);
    assertCurrent();
    return json({ source_id: src.id, representation: "original-pdf", text,
      page_count: text.page_count || null, visual_reading: "read_pdf_page",
      note: "Pages are rendered locally on demand. Search requires extractable text; scanned pages remain visually readable." });
  }
  if (name === "read_pdf_page") {
    if (!context.deliverImage) throw new Error("Image delivery is unavailable outside an active turn.");
    const page = Number(args.page);
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("page must be a positive integer.");
    const rendered = await readPdfPage(attachment, page, context.signal, args.dpi === undefined ? 300 : Number(args.dpi));
    assertCurrent();
    const encoded = rendered.dataUrl.split(",")[1] || "";
    const byteLength = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    checkImageSize(byteLength);
    context.deliverImage({ sourceId: src.id, path: `pdf-page-${page}`, mime: "image/jpeg", dataUrl: rendered.dataUrl,
      byteLength });
    return json({ source_id: src.id, pdf_page: page, citation: pdfCitation(attachment, page), representation: "page-image",
      page_count: rendered.pageCount, width: rendered.width, height: rendered.height, effective_dpi: rendered.effectiveDpi });
  }
  const record = await readPdfText(attachment, context.signal, true);
  assertCurrent();
  const from = args.start_page === undefined ? 1 : Number(args.start_page), to = args.end_page === undefined ? record.pageCount : Number(args.end_page);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > record.pageCount) throw new Error("Use an inclusive page range within the PDF page count.");
  return json({ source_id: src.id, representation: "pdf-text", digest: record.digest, page_count: record.pageCount,
    pages: record.pages.filter(page => page.page! >= from && page.page! <= to).map(page => ({ ...page, citation: pdfCitation(attachment, page.page!) })),
    note: "Original text extraction; formulas, reading order and layout may be lost. Inspect original page images with read_pdf_page for substantive reading." });
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
