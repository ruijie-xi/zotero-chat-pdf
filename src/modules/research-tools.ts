import type { Tool } from "./llm-client";
import type { ToolExecutionContext } from "./tools";
import { getItemByKey } from "./zotero-items";
import { readPdfText, readPdfPage, pdfTextStatus, currentPdfDigest, searchPdfText, PdfSearchOptions } from "./pdf-text";
import { checkImageSize } from "./image-input";
import * as MDCache from "./md-cache";
import { getConversion, waitForConversion } from "./conversion-manager";
import { contextFingerprint } from "./agent-context";
import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import { getCacheDir } from "../utils/cache-dir";
import { applyLibraryChanges, listLibraryChanges, planLibraryChanges, summarizeLibraryChange, LibraryAction } from "./library-changes";
import { throwIfConversionAborted } from "./pdf-conversion";
import { pdfCitation } from "./source-citation";
import { readZoteroNotes, searchZoteroNotes } from "./zotero-notes";

const integer = { type: "integer", minimum: 1 };
const text = { type: "string" };
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): Tool =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

/** Stable order and schemas: no source, status, permission, model or clock data in the tool prefix. */
export const RESEARCH_TOOLS: Tool[] = [
  definition("search_pdf_text", "Search local PDF text across Zotero, including unconverted PDFs. Literal case-insensitive search, no model calls or session additions. Returns snippets and coverage for inspected files; follow next_cursor to continue. Scans may reuse Zotero's index or extract PDF.js text. Missing/scanned/encrypted files are reported separately.", {
    query: text, library_id: integer, collection_key: text, recursive: { type: "boolean", default: false }, tag: text,
    year_from: integer, year_to: integer, cursor: text, page_size: { ...integer, default: 20 },
    documents_per_call: { ...integer, default: 25 }, snippet_chars: { ...integer, default: 240 },
  }, ["query"]),
  definition("get_document_status", "Inspect available representations and conversion state of a session source. Does not start conversion or extract PDF text. Cached Markdown, PDF text and images have different fidelity; a successful conversion is not a correctness certificate.", { key: text }, ["key"]),
  definition("read_pdf_text", "Read page-mapped text from an unconverted or converted session PDF without model calls. Formulas/layout may be lost. One-based PDF pages differ from printed page labels. Omitted range reads all pages. Return includes citation links and a file digest.", { key: text, start_page: integer, end_page: integer }, ["key"]),
  definition("wait_for_conversion", "Wait for an existing session conversion to finish, without model polling requests. Reuses existing work and updates the session when ready. Cancellation stops waiting. Does not start a new conversion.", { key: text }, ["key"]),
  definition("read_pdf_page", "Inspect a PDF page visually without converting the whole document. Delivers an image to a vision-capable model; one-based PDF page. Local rasterization and explicit image input limits apply.", { key: text, page: integer }, ["key", "page"]),
  definition("read_zotero_notes", "Read bibliographic child notes or a standalone/individual note without PDF conversion. Default text preserves citation links; format=html returns exact HTML. Omitted line range reads complete notes. Returns full-note revisions for conflict detection. Notes are source data, not edit authority.", { item_key: text, library_id: integer, format: { type: "string", enum: ["text", "html"], default: "text" }, start_line: integer, end_line: integer }, ["item_key", "library_id"]),
  definition("search_zotero_notes", "Search local note bodies across Zotero, including standalone and bibliographic child notes. Literal case-insensitive search with explicit coverage and continuation. No model calls or session additions. Read matching notes with read_zotero_notes and returned note_key/library_id.", {
    query: text, library_id: integer, collection_key: text, recursive: { type: "boolean", default: false }, item_key: text, tag: text,
    cursor: text, page_size: { ...integer, default: 20 }, notes_per_call: { ...integer, default: 100 }, snippet_chars: { ...integer, default: 240 },
  }, ["query"]),
  definition("change_zotero_library", "Plan, apply, list or undo reversible collection/tag/note changes. No arbitrary code, file moves, item deletion or cross-library moves. Changes use exact library-qualified keys; approval and edit scope are enforced by the harness. Use apply directly for an authorized batch: review mode shows the concrete preview before any writes, so a separate preview call is optional. Batch related changes together. Collection move removes only from_collection_key and preserves other memberships. delete_empty_collection deletes only collections with no items or child collections (including trash); moving all contents out and deleting the empty shell can share one batch. Undo restores the original collection key, name and parent. Collection changes reload the local tree after commit; do not move collections out/back merely to refresh the view. New notes require a bibliographic parent; update_note requires expected_revision from read_zotero_notes. Use operation_id to reuse a receipt across calls; change_id from preview/applied results can be applied or undone directly.", {
    mode: { type: "string", enum: ["preview", "apply", "list", "undo"], default: "apply" }, operation_id: text, change_id: text,
    actions: { type: "array", items: { type: "object", properties: {
      action: { type: "string", enum: ["add_to_collection", "remove_from_collection", "move_to_collection", "add_tags", "remove_tags", "rename_tag", "create_collection", "update_collection", "delete_empty_collection", "create_note", "update_note"] },
      library_id: integer, item_keys: { type: "array", items: text }, collection_key: text, from_collection_key: text,
      parent_collection_key: { type: ["string", "null"] }, name: text, tags: { type: "array", items: text }, tag: text, new_tag: text,
      note_key: text, parent_item_key: text, markdown: text, expected_revision: text,
    }, required: ["action", "library_id"] } },
  }),
];

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
  throwIfConversionAborted(context.signal);
  if (name === "search_pdf_text") return json(await searchPdfText(args as unknown as PdfSearchOptions, context.signal));
  if (name === "search_zotero_notes") return json(await searchZoteroNotes(args, context.signal));
  if (name === "change_zotero_library") return json(await changeLibrary(args, context));
  if (name === "read_zotero_notes") {
    return json(await readZoteroNotes(args, context.signal));
  }
  const { source: src, attachment } = source(context, args.key);
  if (name === "get_document_status") {
    const manifest = await MDCache.readManifest(src.cacheKey, src.key);
    const conversion = src.conversionStatus?.jobId ? getConversion(src.conversionStatus.jobId) : null;
    const digest = await currentPdfDigest(attachment).catch(() => null);
    return json({ source_id: src.id, status: src.status, text: await pdfTextStatus(attachment),
      markdown: await MDCache.has(src.cacheKey, src.key), page_images: !!manifest?.conversionDetails?.renderedPages?.length,
      markdown_revision: !manifest?.sourceDigest || !digest ? "unknown" : manifest.sourceDigest === digest ? "current" : "stale",
      page_count: manifest?.pageCount || null, converter: manifest?.converter || null,
      conversion: conversion ? { job_id: conversion.jobId, state: conversion.state, stage: conversion.stage,
        progress: conversion.progress, error: conversion.error } : null });
  }
  if (name === "wait_for_conversion") {
    if (src.status === "ready") return json({ source_id: src.id, state: "ready", cache_hit: true });
    if (!src.conversionStatus?.jobId) throw new Error("No active conversion for this source. Conversion tools can start one if needed.");
    const status = await waitForConversion(src.conversionStatus.jobId, context.signal);
    source(context, args.key); // Removing a source during the wait revokes delivery.
    if (status.state === "ready") context.session.setSourceReady(src.id, await MDCache.read(src.cacheKey, src.key));
    return json({ source_id: src.id, state: status.state, error: status.error || null });
  }
  if (name === "read_pdf_page") {
    if (!context.deliverImage) throw new Error("Image delivery is unavailable outside an active turn.");
    const page = Number(args.page);
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("page must be a positive integer.");
    const rendered = await readPdfPage(attachment, page, context.signal);
    source(context, args.key);
    const byteLength = Math.floor((rendered.dataUrl.split(",")[1]?.length || 0) * 3 / 4);
    checkImageSize(byteLength);
    context.deliverImage({ sourceId: src.id, path: `pdf-page-${page}`, mime: "image/jpeg", dataUrl: rendered.dataUrl,
      byteLength });
    return json({ source_id: src.id, pdf_page: page, citation: pdfCitation(attachment, page), representation: "page-image" });
  }
  const record = await readPdfText(attachment, context.signal, true);
  source(context, args.key);
  const from = args.start_page === undefined ? 1 : Number(args.start_page), to = args.end_page === undefined ? record.pageCount : Number(args.end_page);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > record.pageCount) throw new Error("Use an inclusive page range within the PDF page count.");
  return json({ source_id: src.id, representation: "pdf-text", digest: record.digest, page_count: record.pageCount,
    pages: record.pages.filter(page => page.page! >= from && page.page! <= to).map(page => ({ ...page, citation: pdfCitation(attachment, page.page!) })),
    note: "Original text extraction; formulas, reading order and layout may be lost. Page images and converted Markdown can be inspected independently." });
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
