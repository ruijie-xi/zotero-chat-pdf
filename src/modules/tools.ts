import { ChatSession } from "./chat-session";
import * as MDCache from "./md-cache";
import { getPref } from "../utils/prefs";
import { Tool } from "./llm-client";
import { convertSource, refreshSourceChips } from "./source-chips";
import {
  DEFAULT_WEB_MAX_BYTES,
  HARD_WEB_MAX_BYTES,
  safeFetchText,
} from "./safe-web-client";
import {
  addZoteroItemToSession,
  getAllCollections,
  getAllLibraryItems,
  getItemByKey,
  getPdfAttachment,
  summarizeZoteroItem,
  ZoteroCollectionSummary,
  ZoteroItemSummary,
} from "./zotero-items";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function nonNegativeIntegerOrDefault(value: unknown, defaultValue: number): number {
  if (value === undefined || value === null || value === "") return defaultValue;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return defaultValue;
  return Math.floor(numeric);
}

function limitResults<T>(items: T[], maxResults?: number): T[] {
  return maxResults === undefined ? items : items.slice(0, maxResults);
}

function countLabel(returned: number, total: number): string {
  return returned === total ? `${total} total` : `${returned} of ${total} returned`;
}

export interface ToolOptions {
  enableWebTools?: boolean;
}

export interface ToolExecutionContext {
  session: ChatSession;
  signal?: AbortSignal;
  requestId: string;
  windowId: string;
  /** Mutable IDs allowed for this turn. Newly-added sources are appended here. */
  turnScope: Set<string>;
}

export interface ToolMetadata {
  readOnly: boolean;
  mutatesSession: boolean;
  network: boolean;
  costly: boolean;
}

const TOOL_METADATA: Record<string, ToolMetadata> = {
  list_sources: { readOnly: true, mutatesSession: false, network: false, costly: false },
  read_document: { readOnly: true, mutatesSession: false, network: false, costly: false },
  list_document_chunks: { readOnly: true, mutatesSession: false, network: false, costly: false },
  read_document_chunk: { readOnly: true, mutatesSession: false, network: false, costly: false },
  search_document: { readOnly: true, mutatesSession: false, network: false, costly: false },
  search_zotero_library: { readOnly: true, mutatesSession: false, network: false, costly: false },
  get_zotero_item: { readOnly: true, mutatesSession: false, network: false, costly: false },
  list_zotero_collections: { readOnly: true, mutatesSession: false, network: false, costly: false },
  list_collection_items: { readOnly: true, mutatesSession: false, network: false, costly: false },
  get_current_zotero_selection: { readOnly: true, mutatesSession: false, network: false, costly: false },
  add_zotero_item_to_session: { readOnly: false, mutatesSession: true, network: false, costly: false },
  convert_session_source: { readOnly: false, mutatesSession: true, network: true, costly: true },
  add_and_convert_zotero_item: { readOnly: false, mutatesSession: true, network: true, costly: true },
  web_search: { readOnly: true, mutatesSession: false, network: true, costly: false },
  web_fetch: { readOnly: true, mutatesSession: false, network: true, costly: false },
};

export function getToolMetadata(name: string): ToolMetadata {
  return TOOL_METADATA[name] || { readOnly: false, mutatesSession: true, network: true, costly: true };
}

function extractHeadings(markdown: string): { heading: string; line: number }[] {
  const lines = markdown.split("\n");
  const headings: { heading: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) {
      headings.push({ heading: lines[i].trim(), line: i + 1 });
    }
  }
  return headings;
}

export function getToolDefinitions(options?: ToolOptions): Tool[] {
  const tools: Tool[] = [
    {
      type: "function",
      function: {
        name: "list_sources",
        description:
          "List all available document sources in this session with metadata including section headings and line counts. " +
          "Call this first to understand what documents are available before reading them.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_document",
        description:
          "Read the content of a specific document by its key. " +
          "Use start_line and end_line to read specific sections (1-based line numbers). " +
          "Omit line ranges to read the whole document.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The document key (from list_sources)",
            },
            start_line: {
              type: "integer",
              description: "First line to read (1-based, inclusive). Omit to start from beginning.",
            },
            end_line: {
              type: "integer",
              description: "Last line to read (1-based, inclusive). Omit to read to end.",
            },
          },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_document_chunks",
        description:
          "List page-based chunks for a converted long document, including page ranges and line ranges. " +
          "Use this before reading books or very long PDFs.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The document key (from list_sources)",
            },
          },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_document_chunk",
        description:
          "Read one converted page-based chunk from a long document. Chunk indexes come from list_document_chunks.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The document key (from list_sources)",
            },
            chunk_index: {
              type: "integer",
              description: "Chunk index to read (1-based)",
            },
          },
          required: ["key", "chunk_index"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_document",
        description:
          "Search a converted document for exact text or keywords and return matching line snippets. " +
          "Useful for books and long PDFs before reading specific chunks or line ranges.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The document key (from list_sources)",
            },
            query: {
              type: "string",
              description: "Text or keywords to search for",
            },
            max_results: {
              type: "integer",
              description: "Optional cap on the number of matches to return. Omit to return all matches.",
            },
            context_lines: {
              type: "integer",
              description: "Number of surrounding lines to include around each match (default 2)",
            },
          },
          required: ["key", "query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_zotero_library",
        description:
          "Search the user's Zotero library metadata for relevant papers/items. " +
          "This is read-only and returns compact metadata plus PDF/session status. " +
          "Use this when the user asks to find papers or when no session sources are available.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Title, author, keyword, tag, or abstract text to search for" },
            max_results: { type: "integer", description: "Optional cap on the number of matching items. Omit to return all matches." },
            year_from: { type: "integer", description: "Earliest publication year to include" },
            year_to: { type: "integer", description: "Latest publication year to include" },
            item_type: { type: "string", description: "Zotero item type filter, e.g. journalArticle, preprint, book" },
            has_pdf: { type: "boolean", description: "If true, only return items with PDF attachments; if false, only without PDFs" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_zotero_item",
        description:
          "Inspect one Zotero item by key. This is read-only and returns metadata, PDF availability, collections, tags, and session status.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Zotero item key or PDF attachment key" },
            library_id: { type: "integer", description: "Zotero library ID from search results; required when keys may be ambiguous across libraries" },
          },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_zotero_collections",
        description: "List Zotero collections, optionally filtered by name. This is read-only.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional collection name filter" },
            max_results: { type: "integer", description: "Optional cap on the number of collections. Omit to return all collections." },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_collection_items",
        description:
          "List Zotero items in a collection by collection key. This is read-only and returns compact item metadata.",
        parameters: {
          type: "object",
          properties: {
            collection_key: { type: "string", description: "Zotero collection key" },
            library_id: { type: "integer", description: "Zotero library ID from list_zotero_collections" },
            max_results: { type: "integer", description: "Optional cap on the number of items. Omit to return all matching items." },
            has_pdf: { type: "boolean", description: "If true, only return items with PDFs; if false, only without PDFs" },
          },
          required: ["collection_key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_current_zotero_selection",
        description:
          "List the currently selected Zotero item(s) or open reader item when available. This is read-only.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_zotero_item_to_session",
        description:
          "Add a Zotero item's PDF attachment to the current ChatPDF session. " +
          "This is a lightweight reversible action; use it when a Zotero item is relevant to the user's task.",
        parameters: {
          type: "object",
          properties: {
            item_key: { type: "string", description: "Zotero parent item key or PDF attachment key" },
            library_id: { type: "integer", description: "Zotero library ID from search results" },
          },
          required: ["item_key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "convert_session_source",
        description:
          "Convert a source already in the current ChatPDF session with MinerU. " +
          "Use when the source is needed to answer. Be careful with extreme bulk conversions and explain the cost/risk when relevant.",
        parameters: {
          type: "object",
          properties: {
            source_key: { type: "string", description: "Current session source key from list_sources" },
          },
          required: ["source_key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_and_convert_zotero_item",
        description:
          "Add a Zotero item's PDF attachment to this session, then convert it with MinerU if needed. " +
          "Use when the item is relevant and needed to answer. Be careful with extreme bulk conversions and explain the cost/risk when relevant.",
        parameters: {
          type: "object",
          properties: {
            item_key: { type: "string", description: "Zotero parent item key or PDF attachment key" },
            library_id: { type: "integer", description: "Zotero library ID from search results" },
          },
          required: ["item_key"],
        },
      },
    },
  ];

  const enableWeb = options?.enableWebTools ?? ((getPref("enableWebTools") as boolean | undefined) ?? false);
  if (enableWeb) {
    tools.push({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for information. Returns a list of results with titles, snippets, and URLs.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            max_results: { type: "integer", description: "Optional cap on the number of results. Omit to use the search provider's returned set." },
          },
          required: ["query"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch the full text content of a web page. Returns cleaned text with HTML stripped.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch (must be http:// or https://)" },
            max_bytes: {
              type: "integer",
              description: `Visible response safety budget in bytes (default ${DEFAULT_WEB_MAX_BYTES}, hard maximum ${HARD_WEB_MAX_BYTES}). Oversized responses fail instead of being truncated.`,
            },
          },
          required: ["url"],
        },
      },
    });
  }

  return tools;
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
    let result: string;

    switch (name) {
      case "list_sources":
        result = await executeListSources(context);
        break;
      case "read_document":
        result = await executeReadDocumentSafe(args, context);
        break;
      case "list_document_chunks":
        result = await executeListDocumentChunks(args, context);
        break;
      case "read_document_chunk":
        result = await executeReadDocumentChunk(args, context);
        break;
      case "search_document":
        result = await executeSearchDocument(args, context);
        break;
      case "search_zotero_library":
        result = await executeSearchZoteroLibrary(args, session);
        break;
      case "get_zotero_item":
        result = await executeGetZoteroItem(args, session);
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
      case "convert_session_source":
        result = await executeConvertSessionSource(args, context);
        break;
      case "add_and_convert_zotero_item":
        result = await executeAddAndConvertZoteroItem(args, context);
        break;
      case "web_search":
        result = await executeWebSearch(args, context.signal);
        break;
      case "web_fetch":
        result = await executeWebFetch(args, context.signal);
        break;
      default:
        result = `Unknown tool: ${name}`;
    }

    const durationMs = Date.now() - startTime;
    Zotero.debug(`[ChatPDF] executeTool: ${name} done in ${durationMs}ms, result=${result.length} chars`);
    const estimatedTokens = Math.ceil(result.length / 4);
    return `${result}\n\n[Tool result metadata: ${result.length} characters; approximately ${estimatedTokens} tokens; no hidden truncation applied.]`;
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

async function loadDocumentContent(
  key: string,
  context: ToolExecutionContext,
): Promise<{ markdown: string; manifest: MDCache.DocumentManifest | null; title: string } | string> {
  const { session } = context;
  const source = session.getSource(key);
  if (!source) {
    return `Error: document "${key}" not found.`;
  }

  if (source.status !== "ready") {
    return `Error: document "${source.title}" is not ready (status: ${source.status}). It needs to be converted first.`;
  }

  let markdown = source.markdown;
  if (!markdown) {
    if (await MDCache.has(source.cacheKey, source.key)) {
      markdown = await MDCache.read(source.cacheKey, source.key);
      session.setSourceReady(source.id, markdown);
    } else {
      return `Error: document "${source.title}" content not available in cache.`;
    }
  }

  return {
    markdown,
    manifest: await MDCache.readManifest(source.cacheKey, source.key),
    title: source.title,
  };
}

async function executeListSources(context: ToolExecutionContext): Promise<string> {
  const sources = context.session.getSources().filter((source) => context.turnScope.has(source.id));
  const readyCount = sources.filter(s => s.status === "ready").length;
  Zotero.debug(`[ChatPDF] list_sources: ${sources.length} sources, ${readyCount} ready`);

  if (sources.length === 0) {
    return "No documents in this session. The user has not added any PDF sources yet.";
  }

  const lines: string[] = [`Available documents (${sources.length} total):\n`];

  for (const source of sources) {
    if (source.status === "ready" && !source.markdown && await MDCache.has(source.cacheKey, source.key)) {
      source.markdown = await MDCache.read(source.cacheKey, source.key);
    }
    lines.push(`## Document: "${source.title}"`);
    lines.push(`- key: ${source.id}`);
    lines.push(`- Zotero attachment key: ${source.key}`);
    lines.push(`- status: ${source.status}`);

    if (source.status === "ready" && source.markdown) {
      const charCount = source.markdown.length;
      const lineCount = source.markdown.split("\n").length;
      lines.push(`- size: ${charCount} chars, ${lineCount} lines`);
      const manifest = await MDCache.readManifest(source.cacheKey, source.key);
      if (manifest && manifest.chunks.length > 1) {
        const readyChunks = manifest.chunks.filter((chunk) => chunk.status === "ready").length;
        lines.push(`- pages: ${manifest.pageCount}`);
        lines.push(`- chunks: ${readyChunks}/${manifest.chunks.length} ready`);
        lines.push(`- note: long document; use list_document_chunks, search_document, and read_document_chunk to navigate it`);
      }
      const headings = extractHeadings(source.markdown);
      if (headings.length > 0) {
        lines.push(`- section headings:`);
        for (const h of headings) {
          lines.push(`  - line ${h.line}: ${h.heading}`);
        }
      } else {
        lines.push(`- section headings: none found`);
      }
    } else if (source.status === "error") {
      lines.push(`- error: ${source.errorMessage || "unknown error"}`);
    } else {
      lines.push(`- note: document is not yet converted, cannot be read`);
    }
    lines.push("");
  }

  const result = lines.join("\n");
  Zotero.debug(`[ChatPDF] list_sources: result=${result.length} chars, ${sources.length} sources, ${readyCount} ready`);
  return result;
}

async function executeReadDocumentSafe(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
  const key = args.key as string;
  const startLine = args.start_line as number | undefined;
  const endLine = args.end_line as number | undefined;

  const validationError = validateSourceKey(key, context, "read_document");
  if (validationError) return validationError;

  const loaded = await loadDocumentContent(key, context);
  if (typeof loaded === "string") return loaded;
  const { markdown, title } = loaded;

  const allLines = markdown.split("\n");
  const totalLines = allLines.length;

  const start = startLine !== undefined ? Math.max(1, startLine) : 1;
  const end = endLine !== undefined ? Math.min(totalLines, endLine) : totalLines;

  Zotero.debug(`[ChatPDF] read_document: key="${key}", lines ${start}-${end} of ${totalLines}, total chars=${markdown.length}`);

  const selectedLines = allLines.slice(start - 1, end);
  const content = selectedLines.join("\n");
  const header = `Document: "${title}" (lines ${start}-${end} of ${totalLines})\n${"=".repeat(60)}\n`;
  const result = header + content;

  Zotero.debug(`[ChatPDF] read_document: returning ${result.length} chars`);
  return result;
}

async function executeListDocumentChunks(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
  const key = args.key as string;
  const validationError = validateSourceKey(key, context, "list_document_chunks");
  if (validationError) return validationError;

  const loaded = await loadDocumentContent(key, context);
  if (typeof loaded === "string") return loaded;
  const { markdown, manifest, title } = loaded;

  if (!manifest || manifest.chunks.length <= 1) {
    const totalLines = markdown.split("\n").length;
    return `Document: "${title}"\nThis document is not chunked. It has ${totalLines} lines; use read_document with start_line/end_line if needed.`;
  }

  const lines = [
    `Document: "${title}"`,
    `Pages: ${manifest.pageCount}`,
    `Chunks: ${manifest.chunks.length}`,
    "",
  ];

  for (const chunk of manifest.chunks) {
    const lineRange = chunk.lineStart && chunk.lineEnd
      ? `, lines ${chunk.lineStart}-${chunk.lineEnd}`
      : "";
    const size = chunk.charCount ? `, ${chunk.charCount} chars` : "";
    lines.push(`- chunk ${chunk.index}: pages ${chunk.startPage}-${chunk.endPage}${lineRange}, status ${chunk.status}${size}`);
  }

  return lines.join("\n");
}

async function executeReadDocumentChunk(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
  const key = args.key as string;
  const chunkIndex = Number(args.chunk_index);
  const validationError = validateSourceKey(key, context, "read_document_chunk");
  if (validationError) return validationError;

  if (!Number.isFinite(chunkIndex) || chunkIndex < 1) {
    return "Error: chunk_index must be a positive integer.";
  }

  const loaded = await loadDocumentContent(key, context);
  if (typeof loaded === "string") return loaded;
  const { markdown, manifest, title } = loaded;

  if (!manifest || manifest.chunks.length <= 1) {
    return `Document "${title}" is not chunked. Use read_document instead.`;
  }

  const chunk = manifest.chunks.find((item) => item.index === chunkIndex);
  if (!chunk) {
    return `Error: chunk ${chunkIndex} not found. Use list_document_chunks to see available chunks.`;
  }
  if (chunk.status !== "ready") {
    return `Error: chunk ${chunkIndex} is not ready (status: ${chunk.status}).`;
  }

  let content: string;
  try {
    const source = context.session.getSource(key)!;
    content = await MDCache.readChunk(source.cacheKey, chunk.index, source.key);
  } catch {
    if (!chunk.lineStart || !chunk.lineEnd) {
      return `Error: chunk ${chunkIndex} content is not available in cache.`;
    }
    content = markdown.split("\n").slice(chunk.lineStart - 1, chunk.lineEnd).join("\n");
  }

  const header = `Document: "${title}" chunk ${chunk.index} (pages ${chunk.startPage}-${chunk.endPage})\n${"=".repeat(60)}\n`;
  return header + content;
}

async function executeSearchDocument(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
  const key = args.key as string;
  const query = String(args.query || "").trim();
  const maxResults = positiveIntegerOrUndefined(args.max_results);
  const contextLines = nonNegativeIntegerOrDefault(args.context_lines, 2);
  const validationError = validateSourceKey(key, context, "search_document");
  if (validationError) return validationError;
  if (!query) return "Error: query is required.";

  const loaded = await loadDocumentContent(key, context);
  if (typeof loaded === "string") return loaded;
  const { markdown, manifest, title } = loaded;

  const lowerQuery = query.toLowerCase();
  const terms = lowerQuery.split(/\s+/).filter(Boolean);
  const lines = markdown.split("\n");
  const matches: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    const isMatch = lineLower.includes(lowerQuery) || terms.every((term) => lineLower.includes(term));
    if (!isMatch) continue;

    const lineNumber = i + 1;
    const chunk = manifest?.chunks.find((item) => (
      item.lineStart !== undefined
      && item.lineEnd !== undefined
      && lineNumber >= item.lineStart
      && lineNumber <= item.lineEnd
    ));
    const from = Math.max(1, lineNumber - contextLines);
    const to = Math.min(lines.length, lineNumber + contextLines);
    const snippet = lines.slice(from - 1, to).join("\n");
    const location = chunk
      ? `line ${lineNumber}, chunk ${chunk.index}, pages ${chunk.startPage}-${chunk.endPage}`
      : `line ${lineNumber}`;
    matches.push(`## Match ${matches.length + 1} (${location})\n${snippet}`);
    if (maxResults !== undefined && matches.length >= maxResults) break;
  }

  if (matches.length === 0) {
    return `No matches for "${query}" in "${title}".`;
  }

  return `Search results for "${query}" in "${title}" (${matches.length} returned):\n\n${matches.join("\n\n")}`;
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

function formatZoteroItemSummary(item: ZoteroItemSummary, session?: ChatSession, index?: number): string {
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
  if (item.abstractNote) lines.push(`   abstract: ${item.abstractNote}`);
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
  lines.push("These results are read-only. You may add or convert relevant PDFs if needed to answer; use judgment and warn the user about cost/time before extreme bulk conversions.");
  return lines.join("\n");
}

async function executeGetZoteroItem(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = String(args.key || "").trim();
  if (!key) return "Error: key is required.";
  const libraryID = positiveIntegerOrUndefined(args.library_id);
  const item = getItemByKey(key, libraryID);
  if (!item) return `Error: Zotero item "${key}" was not found.`;
  return formatZoteroItemSummary(summarizeZoteroItem(item), session);
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

  const lines = [`Items in Zotero collection "${collection.name || key}" (${countLabel(items.length, allItems.length)}):`, ""];
  items.forEach((item, i) => lines.push(formatZoteroItemSummary(item, session, i + 1), ""));
  return lines.join("\n");
}

function selectedItemsFromWindow(win: any): Zotero.Item[] {
  const items: Zotero.Item[] = [];
  try {
    const paneItems = win.ZoteroPane?.getSelectedItems?.();
    if (Array.isArray(paneItems)) items.push(...paneItems);
  } catch {}

  try {
    const activePaneItems = (Zotero as any).getActiveZoteroPane?.()?.getSelectedItems?.();
    if (Array.isArray(activePaneItems)) items.push(...activePaneItems);
  } catch {}

  try {
    const selectedTabID = win.Zotero_Tabs?.selectedID;
    if (selectedTabID && selectedTabID !== "zotero-pane") {
      const reader = (Zotero as any).Reader?.getByTabID?.(selectedTabID);
      if (reader?.itemID) {
        const item = Zotero.Items.get(reader.itemID);
        if (item) items.push(item);
      }
      const tab = win.Zotero_Tabs?._tabs?.find((t: any) => t.id === selectedTabID);
      if (tab?.data?.itemID) {
        const item = Zotero.Items.get(tab.data.itemID);
        if (item) items.push(item);
      }
    }
  } catch {}

  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${(item as any).libraryID || ""}:${item.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function executeGetCurrentZoteroSelection(session: ChatSession): Promise<string> {
  const selectedItems: Zotero.Item[] = [];
  for (const win of Zotero.getMainWindows()) {
    selectedItems.push(...selectedItemsFromWindow(win as any));
  }

  const seen = new Set<string>();
  const items = selectedItems.filter((item) => {
    const key = `${(item as any).libraryID || ""}:${item.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

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

async function executeConvertSessionSource(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
  const { session } = context;
  const key = String(args.source_key || "").trim();
  if (!key) return "Error: source_key is required.";
  const validationError = validateSourceKey(key, context, "convert_session_source");
  if (validationError) return validationError;
  const source = session.getSource(key);
  if (!source) return `Error: source "${key}" not found.`;
  if (source.status === "ready") {
    return `Source "${source.title}" is already converted and ready.`;
  }
  if (source.status === "converting") {
    return `Source "${source.title}" is already converting.`;
  }
  await convertSource(source, refreshOpenSourceChips, context.signal, undefined, session);
  refreshOpenSourceChips();
  const updated = session.getSource(key);
  if (updated?.status === "ready") {
    return `Converted source "${updated.title}" successfully.`;
  }
  return `Conversion finished for "${source.title}" with status: ${updated?.status || "unknown"}.`;
}

async function executeAddAndConvertZoteroItem(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
  const { session } = context;
  const key = String(args.item_key || "").trim();
  if (!key) return "Error: item_key is required.";
  const item = getItemByKey(key, positiveIntegerOrUndefined(args.library_id));
  if (!item) return `Error: Zotero item "${key}" was not found.`;
  const summary = summarizeZoteroItem(item);
  if (!getPdfAttachment(item)) {
    return `Error: "${summary.title}" has no PDF attachment available.`;
  }

  const added = await addZoteroItemToSession(item, session);
  if (added.sourceKey) context.turnScope.add(added.sourceKey);
  refreshOpenSourceChips();
  if (!added.sourceKey) return added.message;
  const source = session.getSource(added.sourceKey);
  if (!source) return `${added.message}\nError: added source could not be found in the current session.`;
  if (source.status === "ready") {
    return `${added.message}\nSource is already converted and ready.`;
  }
  if (source.status === "converting") {
    return `${added.message}\nSource is already converting.`;
  }
  await convertSource(source, refreshOpenSourceChips, context.signal, undefined, session);
  refreshOpenSourceChips();
  const updated = session.getSource(added.sourceKey);
  return `${added.message}\nConversion status: ${updated?.status || "unknown"}.`;
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
