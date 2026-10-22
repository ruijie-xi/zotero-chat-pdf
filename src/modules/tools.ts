import { ChatSession } from "./chat-session";
import { ImageInput, IMAGE_INPUT_HELP, listSourceImages, readSourceImage } from "./image-input";
import { getPref } from "../utils/prefs";
import { getToolDefinitions, getToolMetadata } from "./tool-registry";
import { validateToolArguments } from "./tool-validation";
export { getToolDefinitions, getToolMetadata } from "./tool-registry";
import { executeResearchTool } from "./research-tools";
import { executePluginSourceTool } from "./plugin-source";
import type { LibraryAccess, LibraryChangeSet } from "./library-changes";
import { inspectZoteroItem } from "./zotero-item-details";
import { refreshSourceChips } from "./source-chips";
import {
  DEFAULT_WEB_MAX_BYTES,
  HARD_WEB_MAX_BYTES,
  safeFetchText,
} from "./safe-web-client";
import {
  addZoteroItemToSession,
  getAllAnnotations,
  getAllCollections,
  getAllLibraryItems,
  getItemByKey,
  getSelectedZoteroItems,
  summarizeZoteroItem,
  summarizeZoteroAnnotation,
  ZoteroAnnotationSummary,
  ZoteroCollectionSummary,
  ZoteroItemSummary,
} from "./zotero-items";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function limitResults<T>(items: T[], maxResults?: number): T[] {
  return maxResults === undefined ? items : items.slice(0, maxResults);
}

function countLabel(returned: number, total: number): string {
  return returned === total ? `${total} total` : `${returned} of ${total} returned`;
}

export interface ToolExecutionContext {
  llmSettings?: import("./llm-client").LLMSettings;
  onPdfConversionUsage?: (event: import("./pdf-transcription").PdfConversionUsage) => void;
  imageInputRejected?: boolean;
  readStoredResult?: (id: string, start: number, length: number, allowed: Set<string>) => string;
  deliverImage?: (image: ImageInput) => void;
  session: ChatSession;
  signal?: AbortSignal;
  requestId: string;
  windowId: string;
  /** Mutable IDs allowed for this turn. Newly-added sources are appended here. */
  turnScope: Set<string>;
  libraryAccess?: LibraryAccess;
  approveLibraryChanges?: (plan: LibraryChangeSet, undo?: boolean) => Promise<boolean>;
}

export function toolResultSourceIds(name: string, args: Record<string, unknown>, context: ToolExecutionContext): string[] {
  const documentTools = new Set(["list_images", "read_image", "read_pdf_text", "read_pdf_page", "inspect_pdf_page", "get_document_status"]);
  if (name === "list_sources") return [...context.turnScope];
  if (!documentTools.has(name)) return [];
  const source = context.session.getSource(String(args.key || args.source_key || ""));
  return source ? [source.id] : [];
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const { session } = context;
  const startTime = Date.now();
  Zotero.debug(`[ChatPDF] executeTool: ${name} args=${JSON.stringify(args)}`);

  try {
    const definition = getToolDefinitions().find(tool => tool.function.name === name);
    if (!definition) throw new Error(`Tool "${name}" is disabled or unavailable.`);
    if (context.imageInputRejected && getToolMetadata(name).requiresImageInput) {
      throw new Error("The model endpoint rejected image inputs in this session. Use read_pdf_page Markdown with the configured visual helper, or read_pdf_text, metadata, notes and annotations instead.");
    }
    validateToolArguments(args, definition.function.parameters);
    let result: string;

    switch (name) {
      case "read_tool_result": {
        const memory = session.getAgentContext();
        if (!memory) throw new Error("No stored results are available in this session.");
        const start = args.start === undefined ? 0 : Number(args.start);
        const requested = args.max_chars === undefined ? Number.MAX_SAFE_INTEGER : Number(args.max_chars);
        if (!Number.isSafeInteger(requested) || requested <= 0) throw new Error("max_chars must be a positive integer.");
        return (context.readStoredResult || memory.readResult.bind(memory))(String(args.result_id || ""), start, requested,
          new Set(session.getSources().filter(source => context.turnScope.has(source.id)).map(source => source.id)));
      }
      case "list_images":
      case "read_image": {
        const key = String(args.key || "");
        const invalid = validateSourceKey(key, context, name);
        if (invalid) { result = invalid; break; }
        const source = session.getSource(key)!;
        if (name === "list_images") {
          const paths = await listSourceImages(source, context.signal);
          result = `Images for "${source.title}" [${source.id}]:\n${paths.length ? paths.join("\n") : "Use inspect_pdf_page for original PDF images, read_pdf_page for Markdown."}\n${IMAGE_INPUT_HELP}`;
        } else {
          if (!context.deliverImage) throw new Error("Image delivery is unavailable outside an active agent turn.");
          const image = await readSourceImage(source, typeof args.path === "string" ? args.path : undefined, context.signal);
          if (!session.getSource(source.id) || !context.turnScope.has(source.id)) throw new Error("Image source was removed during reading.");
          context.deliverImage(image);
          result = `Image attached for visual inspection: "${source.title}" [${source.id}], path=${image.path}, MIME=${image.mime}, ${image.byteLength} bytes. Image token usage is reported by the provider, not estimated from base64 length.`;
        }
        break;
      }
      case "list_sources":
        result = await executeListSources(context);
        break;
      case "search_zotero_library":
        result = await executeSearchZoteroLibrary(args, session);
        break;
      case "search_zotero_annotations":
        result = await executeSearchZoteroAnnotations(args);
        break;
      case "get_zotero_item":
        result = await executeGetZoteroItem(args, session, context.signal);
        break;
      case "list_zotero_collections":
        result = await executeListZoteroCollections(args);
        break;
      case "list_collection_items":
        result = await executeListCollectionItems(args, session);
        break;
      case "get_current_zotero_selection":
        result = await executeGetCurrentZoteroSelection(session);
        break;
      case "add_zotero_item_to_session":
        result = await executeAddZoteroItemToSession(args, context);
        break;
      case "web_search":
        result = await executeWebSearch(args, context.signal);
        break;
      case "web_fetch":
        result = await executeWebFetch(args, context.signal);
        break;
      default:
        result = await executePluginSourceTool(name, args, context.signal)
          ?? await executeResearchTool(name, args, context) ?? `Unknown tool: ${name}`;
    }

    const durationMs = Date.now() - startTime;
    Zotero.debug(`[ChatPDF] executeTool: ${name} done in ${durationMs}ms, result=${result.length} chars`);
    return `${result}\n\n[Tool result metadata: ${result.length} characters; no hidden truncation applied.]`;
  } catch (err: any) {
    if (context.signal?.aborted || err?.name === "AbortError") throw err;
    Zotero.debug(`[ChatPDF] executeTool: ${name} error: ${err.message}`);
    return `Error executing ${name}: ${err.message}`;
  }
}

function validateSourceKey(identifier: string, context: ToolExecutionContext, toolName: string): string | null {
  const source = context.session.getSource(identifier);
  if (!source || !context.turnScope.has(source.id)) {
    const validIds = context.session.getSources().filter((item) => context.turnScope.has(item.id)).map((item) => item.id);
    Zotero.debug(`[ChatPDF] ${toolName}: scope rejection - source "${identifier}" not in turn scope [${validIds.join(",")}]`);
    return `Error: document source "${identifier}" is outside this turn's source scope. Use list_sources to see available sources.`;
  }
  return null;
}

async function executeListSources(context: ToolExecutionContext): Promise<string> {
  const sources = context.session.getSources().filter(source => context.turnScope.has(source.id));
  if (!sources.length) return "No sources in this turn. Add relevant PDFs or images with add_zotero_item_to_session.";
  return JSON.stringify({ sources: sources.map(source => ({
    source_id: source.id, title: source.title, kind: source.kind || "pdf",
    status: source.status, read_with: source.kind === "image" ? "read_image" : "read_pdf_page",
  })), note: "PDF text supports search and text-based reading. Inspect original page images for visual details when available." });
}

function normalizeYear(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function formatCreators(creators: string[]): string {
  if (creators.length === 0) return "unknown";
  return creators.join(", ");
}

function sessionStatusForItem(item: ZoteroItemSummary, session: ChatSession): string {
  if (!item.pdfKey) return "not in session";
  const source = session.getSource(item.pdfKey, item.libraryID);
  return source ? `in session (${source.status})` : "not in session";
}

function formatZoteroItemSummary(item: ZoteroItemSummary, session?: ChatSession, index?: number, includeAbstract = true): string {
  const prefix = index !== undefined ? `${index}. ` : "";
  const lines = [`${prefix}${item.title}`];
  lines.push(`   key: ${item.key}`);
  if (item.libraryID !== undefined) lines.push(`   libraryID: ${item.libraryID}`);
  if (item.pdfKey) lines.push(`   pdf_key: ${item.pdfKey}`);
  if (item.itemType) lines.push(`   type: ${item.itemType}`);
  if (item.year) lines.push(`   year: ${item.year}`);
  lines.push(`   creators: ${formatCreators(item.creators)}`);
  lines.push(`   has_pdf: ${item.hasPdf ? "yes" : "no"}`);
  if (session) lines.push(`   session_status: ${sessionStatusForItem(item, session)}`);
  if (item.collections.length) lines.push(`   collections: ${item.collections.join(", ")}`);
  if (item.tags.length) lines.push(`   tags: ${item.tags.join(", ")}`);
  if (!includeAbstract) lines.push(`   abstract_available: ${item.abstractNote ? "yes" : "no"}`);
  else if (item.abstractNote) lines.push(`   abstract: ${item.abstractNote}`);
  return lines.join("\n");
}

function formatZoteroAnnotationSummary(annotation: ZoteroAnnotationSummary, index: number): string {
  const lines = [`${index}. ${annotation.title}`];
  lines.push(`   annotation_key: ${annotation.key}`);
  lines.push(`   libraryID: ${annotation.libraryID}`);
  lines.push(`   type: ${annotation.type}`);
  if (annotation.itemKey) lines.push(`   item_key: ${annotation.itemKey}`);
  if (annotation.attachmentKey) lines.push(`   attachment_key: ${annotation.attachmentKey}`);
  if (annotation.pageLabel) lines.push(`   page: ${annotation.pageLabel}`);
  if (annotation.color) lines.push(`   color: ${annotation.color}`);
  if (annotation.year) lines.push(`   year: ${annotation.year}`);
  lines.push(`   creators: ${formatCreators(annotation.creators)}`);
  if (annotation.tags.length) lines.push(`   tags: ${annotation.tags.join(", ")}`);
  if (annotation.text) lines.push(`   highlighted_text: ${annotation.text}`);
  if (annotation.comment) lines.push(`   comment: ${annotation.comment}`);
  if (annotation.dateModified) lines.push(`   date_modified: ${annotation.dateModified}`);
  return lines.join("\n");
}

function formatCollectionSummary(collection: ZoteroCollectionSummary, index: number): string {
  const lines = [`${index}. ${collection.name}`];
  lines.push(`   key: ${collection.key}`);
  if (collection.libraryID !== undefined) lines.push(`   libraryID: ${collection.libraryID}`);
  if (collection.parentKey) lines.push(`   parent_key: ${collection.parentKey}`);
  if (collection.itemCount !== undefined) lines.push(`   item_count: ${collection.itemCount}`);
  return lines.join("\n");
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTerms(query: string): string[] {
  return normalizeSearchText(query).split(" ").filter((term) => term.length >= 2);
}

function fuzzyTextScore(text: string, query: string): number {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 1;
  if (normalizedText.includes(normalizedQuery)) return 100 + normalizedQuery.length;

  let score = 0;
  for (const term of searchTerms(query)) {
    if (normalizedText.includes(term)) {
      score += 10 + term.length;
      continue;
    }
    const partial = normalizedText.split(" ").some((word) => word.includes(term) || term.includes(word));
    if (partial) score += 3;
  }
  return score;
}

function matchesLibraryQuery(item: ZoteroItemSummary, query: string): boolean {
  const haystack = [
    item.title,
    item.creators.join(" "),
    item.year || "",
    item.itemType || "",
    item.abstractNote || "",
    item.tags.join(" "),
    item.collections.join(" "),
  ].join(" ");
  return fuzzyTextScore(haystack, query) > 0;
}

function libraryQueryScore(item: ZoteroItemSummary, query: string): number {
  return fuzzyTextScore([
    item.title,
    item.creators.join(" "),
    item.abstractNote || "",
    item.tags.join(" "),
    item.collections.join(" "),
  ].join(" "), query);
}

function annotationQueryScore(annotation: ZoteroAnnotationSummary, query: string): number {
  const annotationContent = [
    annotation.text || "",
    annotation.comment || "",
    annotation.tags.join(" "),
  ].join(" ");
  const paperMetadata = [
    annotation.title,
    annotation.creators.join(" "),
    annotation.year || "",
  ].join(" ");
  return fuzzyTextScore(annotationContent, query) * 3 + fuzzyTextScore(paperMetadata, query);
}

async function executeSearchZoteroLibrary(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const query = String(args.query || "").trim();
  if (!query) return "Error: query is required.";

  const maxResults = positiveIntegerOrUndefined(args.max_results);
  const yearFrom = normalizeYear(args.year_from);
  const yearTo = normalizeYear(args.year_to);
  const itemType = String(args.item_type || "").trim().toLowerCase();
  const hasPdf = typeof args.has_pdf === "boolean" ? args.has_pdf : undefined;

  const allSummaries = (await getAllLibraryItems())
    .map(summarizeZoteroItem)
    .filter((item) => matchesLibraryQuery(item, query))
    .filter((item) => yearFrom === undefined || Number(item.year) >= yearFrom)
    .filter((item) => yearTo === undefined || Number(item.year) <= yearTo)
    .filter((item) => !itemType || (item.itemType || "").toLowerCase() === itemType)
    .filter((item) => hasPdf === undefined || item.hasPdf === hasPdf)
    .sort((a, b) => libraryQueryScore(b, query) - libraryQueryScore(a, query));
  const summaries = limitResults(allSummaries, maxResults);

  if (allSummaries.length === 0) {
    return `No Zotero library items found for "${query}".`;
  }

  const lines = [`Zotero library results for "${query}" (${countLabel(summaries.length, allSummaries.length)}):`, ""];
  summaries.forEach((item, i) => lines.push(formatZoteroItemSummary(item, session, i + 1), ""));
  lines.push("Add relevant PDFs with add_zotero_item_to_session, then read_pdf_page for Markdown or inspect_pdf_page for careful visual review.");
  return lines.join("\n");
}

async function executeSearchZoteroAnnotations(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || "").trim();
  const itemKey = String(args.item_key || "").trim() || undefined;
  const libraryID = positiveIntegerOrUndefined(args.library_id);
  const annotationType = String(args.annotation_type || "").trim().toLowerCase();
  const maxResults = positiveIntegerOrUndefined(args.max_results);

  if (itemKey && !(getItemByKey(itemKey, libraryID))) {
    return `Error: Zotero item "${itemKey}" was not found.`;
  }

  const allAnnotations = (await getAllAnnotations(itemKey, libraryID))
    .map(summarizeZoteroAnnotation)
    .filter((annotation) => !annotationType || annotation.type.toLowerCase() === annotationType)
    .filter((annotation) => !query || annotationQueryScore(annotation, query) > 0)
    .sort((a, b) => {
      if (query) {
        const scoreDifference = annotationQueryScore(b, query) - annotationQueryScore(a, query);
        if (scoreDifference !== 0) return scoreDifference;
      }
      return String(b.dateModified || "").localeCompare(String(a.dateModified || ""));
    });
  const annotations = limitResults(allAnnotations, maxResults);

  if (allAnnotations.length === 0) {
    const scope = itemKey ? ` for Zotero item "${itemKey}"` : "";
    return query
      ? `No Zotero annotations found for "${query}"${scope}.`
      : `No Zotero annotations found${scope}.`;
  }

  const heading = query
    ? `Zotero annotation results for "${query}"`
    : "Zotero annotations";
  return [
    `${heading} (${countLabel(annotations.length, allAnnotations.length)}):`,
    "",
    ...annotations.map((annotation, index) => formatZoteroAnnotationSummary(annotation, index + 1)),
  ].join("\n\n");
}

async function executeGetZoteroItem(args: Record<string, unknown>, session: ChatSession, signal?: AbortSignal): Promise<string> {
  const key = String(args.key || "").trim();
  if (!key) return "Error: key is required.";
  const libraryID = positiveIntegerOrUndefined(args.library_id);
  const item = getItemByKey(key, libraryID);
  if (!item) return `Error: Zotero item "${key}" was not found.`;
  if (args.detail === "summary") return formatZoteroItemSummary(summarizeZoteroItem(item), session);
  if (args.detail !== undefined && args.detail !== "full") return "Error: detail must be full or summary.";
  if (item.deleted || (item as any).isInTrash?.()) return "Error: Zotero item is in trash.";
  return JSON.stringify({ ...await inspectZoteroItem(item, signal), session_status: sessionStatusForItem(summarizeZoteroItem(item), session) });
}

async function executeListZoteroCollections(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || "").trim().toLowerCase();
  const maxResults = positiveIntegerOrUndefined(args.max_results);
  const allCollections = (await getAllCollections())
    .filter((collection) => !query || fuzzyTextScore(collection.name, query) > 0)
    .sort((a, b) => fuzzyTextScore(b.name, query) - fuzzyTextScore(a.name, query));
  const collections = limitResults(allCollections, maxResults);

  if (allCollections.length === 0) {
    return query ? `No Zotero collections found for "${query}".` : "No Zotero collections found.";
  }

  return [
    `Zotero collections (${countLabel(collections.length, allCollections.length)}):`,
    "",
    ...collections.map((collection, i) => formatCollectionSummary(collection, i + 1)),
  ].join("\n\n");
}

function getCollectionByKey(key: string, libraryID?: number): any | null {
  for (const lib of Zotero.Libraries.getAll()) {
    if (libraryID !== undefined && lib.libraryID !== libraryID) continue;
    try {
      const collection = (Zotero.Collections as any).getByLibraryAndKey?.(lib.libraryID, key);
      if (collection) return collection;
    } catch {
      continue;
    }
  }
  return null;
}

async function executeListCollectionItems(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = String(args.collection_key || "").trim();
  if (!key) return "Error: collection_key is required.";
  const collection = getCollectionByKey(key, positiveIntegerOrUndefined(args.library_id));
  if (!collection) return `Error: Zotero collection "${key}" was not found.`;

  const maxResults = positiveIntegerOrUndefined(args.max_results);
  const hasPdf = typeof args.has_pdf === "boolean" ? args.has_pdf : undefined;
  let rawItems: any[];
  try {
    const maybeItems = collection.getChildItems?.() || [];
    rawItems = typeof maybeItems?.then === "function" ? await maybeItems : maybeItems;
  } catch (e: any) {
    return `Error reading collection "${collection.name || key}": ${e.message}`;
  }

  const allItems = rawItems
    .map((itemOrID) => typeof itemOrID === "number" ? Zotero.Items.get(itemOrID) : itemOrID)
    .filter((item): item is Zotero.Item => !!item && (item.isRegularItem?.() || (item.isPDFAttachment?.() && !item.parentItem)))
    .map(summarizeZoteroItem)
    .filter((item) => hasPdf === undefined || item.hasPdf === hasPdf);
  const items = limitResults(allItems, maxResults);

  if (allItems.length === 0) {
    return `No matching items found in Zotero collection "${collection.name || key}".`;
  }

  const includeAbstract = args.detail === "full";
  const lines = [`Items in Zotero collection "${collection.name || key}" (${countLabel(items.length, allItems.length)}):`,
    includeAbstract ? "Metadata detail: full (complete abstracts included)."
      : "Metadata detail: brief (abstract bodies omitted). Use detail=full for complete abstracts, or get_zotero_item for selected items.", ""];
  items.forEach((item, i) => lines.push(formatZoteroItemSummary(item, session, i + 1, includeAbstract), ""));
  return lines.join("\n");
}

async function executeGetCurrentZoteroSelection(session: ChatSession): Promise<string> {
  const items = getSelectedZoteroItems();

  if (items.length === 0) {
    return "No current Zotero selection or open reader item was found.";
  }

  const lines = [`Current Zotero selection (${items.length} item${items.length === 1 ? "" : "s"}):`, ""];
  items.map(summarizeZoteroItem).forEach((item, i) => lines.push(formatZoteroItemSummary(item, session, i + 1), ""));
  return lines.join("\n");
}

function refreshOpenSourceChips(): void {
  for (const win of Zotero.getMainWindows()) {
    try {
      const root = (win as any).document?.querySelector("#chatpdf-root") as HTMLElement | null;
      if (root) refreshSourceChips(root);
    } catch {}
  }
}

async function executeAddZoteroItemToSession(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
  const { session } = context;
  const key = String(args.item_key || "").trim();
  if (!key) return "Error: item_key is required.";
  const item = getItemByKey(key, positiveIntegerOrUndefined(args.library_id));
  if (!item) return `Error: Zotero item "${key}" was not found.`;

  const added = await addZoteroItemToSession(item, session);
  if (added.sourceKey) context.turnScope.add(added.sourceKey);
  refreshOpenSourceChips();
  return added.message;
}

async function executeWebSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const query = String(args.query || "").trim();
  if (!query) return "Error: query is required.";
  const maxResults = positiveIntegerOrUndefined(args.max_results);

  const braveKey = (getPref("braveSearchApiKey") as string | undefined) || "";

  if (braveKey) {
    Zotero.debug(`[ChatPDF] web_search: using Brave Search, query="${query}"`);
    return await braveSearch(query, maxResults, braveKey, signal);
  } else {
    Zotero.debug(`[ChatPDF] web_search: using DuckDuckGo fallback, query="${query}"`);
    return await duckDuckGoSearch(query, maxResults, signal);
  }
}

async function braveSearch(query: string, maxResults: number | undefined, apiKey: string, signal?: AbortSignal): Promise<string> {
  const params = new URLSearchParams({ q: query });
  if (maxResults !== undefined) params.set("count", String(maxResults));
  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;

  const res = await safeFetchText(url, {
    signal,
    maxBytes: DEFAULT_WEB_MAX_BYTES,
    allowedMimeTypes: /^application\/json$/i,
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Brave Search API error (${res.status})`);
  }

  const data = JSON.parse(res.text);
  const results = (data.web?.results ?? []) as { title: string; description: string; url: string }[];
  Zotero.debug(`[ChatPDF] braveSearch: ${results.length} results for "${query}"`);

  if (results.length === 0) return `Web search results for: "${query}"\n\nNo results found.`;

  const lines = [`Web search results for: "${query}"\n`];
  const returnedResults = limitResults(results, maxResults);
  for (let i = 0; i < returnedResults.length; i++) {
    const r = returnedResults[i];
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.description}`);
    lines.push(`   URL: ${r.url}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function duckDuckGoSearch(query: string, maxResults: number | undefined, signal?: AbortSignal): Promise<string> {
  const params = new URLSearchParams({ q: query });
  const url = `https://html.duckduckgo.com/html/?${params}`;

  const res = await safeFetchText(url, {
    signal,
    maxBytes: DEFAULT_WEB_MAX_BYTES,
    allowedMimeTypes: /^text\/html$/i,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ChatPDF/1.0; Zotero)" },
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`DuckDuckGo search error (${res.status})`);
  }

  const html = res.text;
  Zotero.debug(`[ChatPDF] duckDuckGoSearch: got ${html.length} chars HTML for "${query}"`);

  const results: { title: string; snippet: string; url: string }[] = [];
  const resultPattern = /<div class="result[^"]*"[^>]*>[\s\S]*?<a class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let m;
  while ((m = resultPattern.exec(html)) !== null) {
    const rawUrl = m[1].trim();
    const title = htmlToText(m[2]);
    const snippet = htmlToText(m[3]);
    results.push({ url: rawUrl, title, snippet });
    if (maxResults !== undefined && results.length >= maxResults) break;
  }

  // Fallback: simpler extraction
  if (results.length === 0) {
    const titlePattern = /<a class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/g;
    while ((m = titlePattern.exec(html)) !== null) {
      results.push({ url: m[1].trim(), title: m[2].trim(), snippet: "" });
      if (maxResults !== undefined && results.length >= maxResults) break;
    }
  }

  Zotero.debug(`[ChatPDF] duckDuckGoSearch: parsed ${results.length} results`);

  if (results.length === 0) {
    return `Web search results for: "${query}"\n\nNo results found or parsing failed.`;
  }

  const lines = [`Web search results for: "${query}"\n`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.title}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push(`   URL: ${r.url}`);
    lines.push("");
  }
  return lines.join("\n");
}

function htmlToText(html: string): string {
  const Parser = (globalThis as any).DOMParser || (globalThis as any).Zotero?.getMainWindow?.()?.DOMParser;
  if (!Parser) return html;
  const doc = new Parser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,template,svg,math,iframe,object,embed").forEach((node: Element) => node.remove());
  return (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
}

async function executeWebFetch(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const url = String(args.url || "").trim();
  if (!url) return "Error: url is required.";
  const requestedMax = positiveIntegerOrUndefined(args.max_bytes) ?? DEFAULT_WEB_MAX_BYTES;
  const maxBytes = Math.min(HARD_WEB_MAX_BYTES, requestedMax);

  Zotero.debug(`[ChatPDF] web_fetch: fetching ${url}`);

  const res = await safeFetchText(url, {
    signal,
    maxBytes,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ChatPDF/1.0; Zotero)" },
  });

  Zotero.debug(`[ChatPDF] web_fetch: status=${res.status}, url=${url}`);

  if (res.status < 200 || res.status >= 300) {
    return `Error fetching ${url}: HTTP ${res.status}`;
  }

  const text = /html|xhtml/i.test(res.contentType) ? htmlToText(res.text) : res.text;

  Zotero.debug(`[ChatPDF] web_fetch: cleaned content ${text.length} chars from ${url}`);
  return `Content from ${res.finalUrl} (${res.bytesRead} bytes, ${text.length} text characters):\n\n${text}`;
}
