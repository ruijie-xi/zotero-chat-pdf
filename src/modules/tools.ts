import { ChatSession } from "./chat-session";
import * as MDCache from "./md-cache";
import { getPref } from "../utils/prefs";
import { Tool } from "./llm-client";
import { convertSource, refreshSourceChips } from "./source-chips";
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

const DEFAULT_READ_LINE_LIMIT = 400;
const MAX_SEARCH_RESULTS = 20;

export interface ToolOptions {
  enableWebTools?: boolean;
}

function extractHeadings(markdown: string): { heading: string; line: number }[] {
  const lines = markdown.split("\n");
  const headings: { heading: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) {
      headings.push({ heading: lines[i].trim(), line: i + 1 });
    }
  }
  return headings.slice(0, 30);
}

export function getToolDefinitions(session: ChatSession, options?: ToolOptions): Tool[] {
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
          "For long documents, omit line ranges only for a preview; use list_document_chunks, read_document_chunk, or search_document to navigate.",
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
              description: "Maximum number of matches to return (default 10, max 20)",
            },
            context_lines: {
              type: "integer",
              description: "Number of surrounding lines to include around each match (default 2, max 5)",
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
            max_results: { type: "integer", description: "Maximum number of results (default 10, max 20)" },
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
            max_results: { type: "integer", description: "Maximum number of collections (default 10, max 30)" },
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
            max_results: { type: "integer", description: "Maximum number of items (default 10, max 20)" },
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
            max_results: { type: "integer", description: "Maximum number of results (default 5, max 10)" },
          },
          required: ["query"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch the text content of a web page. Returns cleaned text (HTML stripped), truncated to 50KB.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch (must be http:// or https://)" },
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
  session: ChatSession,
): Promise<string> {
  const startTime = Date.now();
  Zotero.debug(`[ChatPDF] executeTool: ${name} args=${JSON.stringify(args)}`);

  try {
    let result: string;

    switch (name) {
      case "list_sources":
        result = await executeListSources(session);
        break;
      case "read_document":
        result = await executeReadDocumentSafe(args, session);
        break;
      case "list_document_chunks":
        result = await executeListDocumentChunks(args, session);
        break;
      case "read_document_chunk":
        result = await executeReadDocumentChunk(args, session);
        break;
      case "search_document":
        result = await executeSearchDocument(args, session);
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
        result = await executeAddZoteroItemToSession(args, session);
        break;
      case "convert_session_source":
        result = await executeConvertSessionSource(args, session);
        break;
      case "add_and_convert_zotero_item":
        result = await executeAddAndConvertZoteroItem(args, session);
        break;
      case "web_search":
        result = await executeWebSearch(args);
        break;
      case "web_fetch":
        result = await executeWebFetch(args);
        break;
      default:
        result = `Unknown tool: ${name}`;
    }

    const durationMs = Date.now() - startTime;
    Zotero.debug(`[ChatPDF] executeTool: ${name} done in ${durationMs}ms, result=${result.length} chars`);
    return result;
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] executeTool: ${name} error: ${err.message}`);
    return `Error executing ${name}: ${err.message}`;
  }
}

function validateSourceKey(key: string, session: ChatSession, toolName: string): string | null {
  const validKeys = session.getSources().map(s => s.key);
  if (!validKeys.includes(key)) {
    Zotero.debug(`[ChatPDF] ${toolName}: security rejection - key "${key}" not in session sources [${validKeys.join(",")}]`);
    return `Error: document key "${key}" is not in the current session. Use list_sources to see available keys.`;
  }
  return null;
}

async function loadDocumentContent(
  key: string,
  session: ChatSession,
): Promise<{ markdown: string; manifest: MDCache.DocumentManifest | null; title: string } | string> {
  const source = session.getSource(key);
  if (!source) {
    return `Error: document "${key}" not found.`;
  }

  if (source.status !== "ready") {
    return `Error: document "${source.title}" is not ready (status: ${source.status}). It needs to be converted first.`;
  }

  let markdown = source.markdown;
  if (!markdown) {
    if (await MDCache.has(key)) {
      markdown = await MDCache.read(key);
      session.setSourceReady(key, markdown);
    } else {
      return `Error: document "${source.title}" content not available in cache.`;
    }
  }

  return {
    markdown,
    manifest: await MDCache.readManifest(key),
    title: source.title,
  };
}

async function executeListSources(session: ChatSession): Promise<string> {
  const sources = session.getSources();
  const readyCount = sources.filter(s => s.status === "ready").length;
  Zotero.debug(`[ChatPDF] list_sources: ${sources.length} sources, ${readyCount} ready`);

  if (sources.length === 0) {
    return "No documents in this session. The user has not added any PDF sources yet.";
  }

  const lines: string[] = [`Available documents (${sources.length} total):\n`];

  for (const source of sources) {
    lines.push(`## Document: "${source.title}"`);
    lines.push(`- key: ${source.key}`);
    lines.push(`- status: ${source.status}`);

    if (source.status === "ready" && source.markdown) {
      const charCount = source.markdown.length;
      const lineCount = source.markdown.split("\n").length;
      lines.push(`- size: ${charCount} chars, ${lineCount} lines`);
      const manifest = await MDCache.readManifest(source.key);
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

async function executeReadDocument(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = args.key as string;
  const startLine = args.start_line as number | undefined;
  const endLine = args.end_line as number | undefined;

  const validKeys = session.getSources().map(s => s.key);
  if (!validKeys.includes(key)) {
    Zotero.debug(`[ChatPDF] read_document: security rejection — key "${key}" not in session sources [${validKeys.join(",")}]`);
    return `Error: document key "${key}" is not in the current session. Use list_sources to see available keys.`;
  }

  const source = session.getSource(key);
  if (!source) {
    return `Error: document "${key}" not found.`;
  }

  if (source.status !== "ready") {
    return `Error: document "${source.title}" is not ready (status: ${source.status}). It needs to be converted first.`;
  }

  let markdown = source.markdown;
  if (!markdown) {
    if (await MDCache.has(key)) {
      markdown = await MDCache.read(key);
      session.setSourceReady(key, markdown);
    } else {
      return `Error: document "${source.title}" content not available in cache.`;
    }
  }

  const allLines = markdown.split("\n");
  const totalLines = allLines.length;

  const start = startLine !== undefined ? Math.max(1, startLine) : 1;
  const end = endLine !== undefined ? Math.min(totalLines, endLine) : totalLines;

  Zotero.debug(`[ChatPDF] read_document: key="${key}", lines ${start}-${end} of ${totalLines}, total chars=${markdown.length}`);

  const selectedLines = allLines.slice(start - 1, end);
  const content = selectedLines.join("\n");

  const header = `Document: "${source.title}" (lines ${start}-${end} of ${totalLines})\n${"=".repeat(60)}\n`;
  const result = header + content;

  Zotero.debug(`[ChatPDF] read_document: returning ${result.length} chars`);
  return result;
}

async function executeReadDocumentSafe(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = args.key as string;
  const startLine = args.start_line as number | undefined;
  const endLine = args.end_line as number | undefined;

  const validationError = validateSourceKey(key, session, "read_document");
  if (validationError) return validationError;

  const loaded = await loadDocumentContent(key, session);
  if (typeof loaded === "string") return loaded;
  const { markdown, manifest, title } = loaded;

  const allLines = markdown.split("\n");
  const totalLines = allLines.length;

  const start = startLine !== undefined ? Math.max(1, startLine) : 1;
  let end = endLine !== undefined ? Math.min(totalLines, endLine) : totalLines;
  let truncated = false;
  if (startLine === undefined && endLine === undefined && manifest && manifest.chunks.length > 1) {
    end = Math.min(totalLines, DEFAULT_READ_LINE_LIMIT);
    truncated = end < totalLines;
  }

  Zotero.debug(`[ChatPDF] read_document: key="${key}", lines ${start}-${end} of ${totalLines}, total chars=${markdown.length}`);

  const selectedLines = allLines.slice(start - 1, end);
  const content = selectedLines.join("\n");
  const header = `Document: "${title}" (lines ${start}-${end} of ${totalLines})\n${"=".repeat(60)}\n`;
  const guidance = truncated
    ? `\n\n[Preview only. This is a long document with ${manifest?.chunks.length} chunks. Use list_document_chunks, read_document_chunk, search_document, or read_document with start_line/end_line for targeted reading.]`
    : "";
  const result = header + content + guidance;

  Zotero.debug(`[ChatPDF] read_document: returning ${result.length} chars`);
  return result;
}

async function executeListDocumentChunks(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = args.key as string;
  const validationError = validateSourceKey(key, session, "list_document_chunks");
  if (validationError) return validationError;

  const loaded = await loadDocumentContent(key, session);
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

async function executeReadDocumentChunk(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = args.key as string;
  const chunkIndex = Number(args.chunk_index);
  const validationError = validateSourceKey(key, session, "read_document_chunk");
  if (validationError) return validationError;

  if (!Number.isFinite(chunkIndex) || chunkIndex < 1) {
    return "Error: chunk_index must be a positive integer.";
  }

  const loaded = await loadDocumentContent(key, session);
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
    content = await MDCache.readChunk(key, chunk.index);
  } catch {
    if (!chunk.lineStart || !chunk.lineEnd) {
      return `Error: chunk ${chunkIndex} content is not available in cache.`;
    }
    content = markdown.split("\n").slice(chunk.lineStart - 1, chunk.lineEnd).join("\n");
  }

  const header = `Document: "${title}" chunk ${chunk.index} (pages ${chunk.startPage}-${chunk.endPage})\n${"=".repeat(60)}\n`;
  return header + content;
}

async function executeSearchDocument(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = args.key as string;
  const query = String(args.query || "").trim();
  const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(args.max_results) || 10));
  const contextLines = Math.min(5, Math.max(0, Number(args.context_lines) || 2));
  const validationError = validateSourceKey(key, session, "search_document");
  if (validationError) return validationError;
  if (!query) return "Error: query is required.";

  const loaded = await loadDocumentContent(key, session);
  if (typeof loaded === "string") return loaded;
  const { markdown, manifest, title } = loaded;

  const lowerQuery = query.toLowerCase();
  const terms = lowerQuery.split(/\s+/).filter(Boolean);
  const lines = markdown.split("\n");
  const matches: string[] = [];

  for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
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
  }

  if (matches.length === 0) {
    return `No matches for "${query}" in "${title}".`;
  }

  return `Search results for "${query}" in "${title}" (${matches.length} shown):\n\n${matches.join("\n\n")}`;
}

function normalizeYear(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function formatCreators(creators: string[]): string {
  if (creators.length === 0) return "unknown";
  if (creators.length <= 3) return creators.join(", ");
  return `${creators.slice(0, 3).join(", ")} et al.`;
}

function sessionStatusForItem(item: ZoteroItemSummary, session: ChatSession): string {
  if (!item.pdfKey) return "not in session";
  const source = session.getSource(item.pdfKey);
  return source ? `in session (${source.status})` : "not in session";
}

function formatZoteroItemSummary(item: ZoteroItemSummary, session?: ChatSession, index?: number): string {
  const prefix = index !== undefined ? `${index}. ` : "";
  const lines = [`${prefix}${item.title}`];
  lines.push(`   key: ${item.key}`);
  if (item.pdfKey) lines.push(`   pdf_key: ${item.pdfKey}`);
  if (item.itemType) lines.push(`   type: ${item.itemType}`);
  if (item.year) lines.push(`   year: ${item.year}`);
  lines.push(`   creators: ${formatCreators(item.creators)}`);
  lines.push(`   has_pdf: ${item.hasPdf ? "yes" : "no"}`);
  if (session) lines.push(`   session_status: ${sessionStatusForItem(item, session)}`);
  if (item.collections.length) lines.push(`   collections: ${item.collections.join(", ")}`);
  if (item.tags.length) lines.push(`   tags: ${item.tags.slice(0, 8).join(", ")}`);
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

  const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(args.max_results) || 10));
  const yearFrom = normalizeYear(args.year_from);
  const yearTo = normalizeYear(args.year_to);
  const itemType = String(args.item_type || "").trim().toLowerCase();
  const hasPdf = typeof args.has_pdf === "boolean" ? args.has_pdf : undefined;

  const summaries = (await getAllLibraryItems())
    .map(summarizeZoteroItem)
    .filter((item) => matchesLibraryQuery(item, query))
    .filter((item) => yearFrom === undefined || Number(item.year) >= yearFrom)
    .filter((item) => yearTo === undefined || Number(item.year) <= yearTo)
    .filter((item) => !itemType || (item.itemType || "").toLowerCase() === itemType)
    .filter((item) => hasPdf === undefined || item.hasPdf === hasPdf)
    .sort((a, b) => libraryQueryScore(b, query) - libraryQueryScore(a, query))
    .slice(0, maxResults);

  if (summaries.length === 0) {
    return `No Zotero library items found for "${query}".`;
  }

  const lines = [`Zotero library results for "${query}" (${summaries.length} shown):`, ""];
  summaries.forEach((item, i) => lines.push(formatZoteroItemSummary(item, session, i + 1), ""));
  lines.push("These results are read-only. You may add or convert relevant PDFs if needed to answer; use judgment and warn the user about cost/time before extreme bulk conversions.");
  return lines.join("\n");
}

async function executeGetZoteroItem(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = String(args.key || "").trim();
  if (!key) return "Error: key is required.";
  const item = getItemByKey(key);
  if (!item) return `Error: Zotero item "${key}" was not found.`;
  return formatZoteroItemSummary(summarizeZoteroItem(item), session);
}

async function executeListZoteroCollections(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || "").trim().toLowerCase();
  const maxResults = Math.min(30, Math.max(1, Number(args.max_results) || 10));
  const collections = (await getAllCollections())
    .filter((collection) => !query || fuzzyTextScore(collection.name, query) > 0)
    .sort((a, b) => fuzzyTextScore(b.name, query) - fuzzyTextScore(a.name, query))
    .slice(0, maxResults);

  if (collections.length === 0) {
    return query ? `No Zotero collections found for "${query}".` : "No Zotero collections found.";
  }

  return [
    `Zotero collections (${collections.length} shown):`,
    "",
    ...collections.map((collection, i) => formatCollectionSummary(collection, i + 1)),
  ].join("\n\n");
}

function getCollectionByKey(key: string): any | null {
  for (const lib of Zotero.Libraries.getAll()) {
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
  const collection = getCollectionByKey(key);
  if (!collection) return `Error: Zotero collection "${key}" was not found.`;

  const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(args.max_results) || 10));
  const hasPdf = typeof args.has_pdf === "boolean" ? args.has_pdf : undefined;
  let rawItems: any[] = [];
  try {
    const maybeItems = collection.getChildItems?.() || [];
    rawItems = typeof maybeItems?.then === "function" ? await maybeItems : maybeItems;
  } catch (e: any) {
    return `Error reading collection "${collection.name || key}": ${e.message}`;
  }

  const items = rawItems
    .map((itemOrID) => typeof itemOrID === "number" ? Zotero.Items.get(itemOrID) : itemOrID)
    .filter((item): item is Zotero.Item => !!item && (item.isRegularItem?.() || (item.isPDFAttachment?.() && !item.parentItem)))
    .map(summarizeZoteroItem)
    .filter((item) => hasPdf === undefined || item.hasPdf === hasPdf)
    .slice(0, maxResults);

  if (items.length === 0) {
    return `No matching items found in Zotero collection "${collection.name || key}".`;
  }

  const lines = [`Items in Zotero collection "${collection.name || key}" (${items.length} shown):`, ""];
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

async function executeAddZoteroItemToSession(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = String(args.item_key || "").trim();
  if (!key) return "Error: item_key is required.";
  const item = getItemByKey(key);
  if (!item) return `Error: Zotero item "${key}" was not found.`;

  const added = await addZoteroItemToSession(item, session);
  refreshOpenSourceChips();
  return added.message;
}

async function executeConvertSessionSource(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = String(args.source_key || "").trim();
  if (!key) return "Error: source_key is required.";
  const validationError = validateSourceKey(key, session, "convert_session_source");
  if (validationError) return validationError;
  const source = session.getSource(key);
  if (!source) return `Error: source "${key}" not found.`;
  if (source.status === "ready") {
    return `Source "${source.title}" is already converted and ready.`;
  }
  if (source.status === "converting") {
    return `Source "${source.title}" is already converting.`;
  }
  await convertSource(source, refreshOpenSourceChips);
  refreshOpenSourceChips();
  const updated = session.getSource(key);
  if (updated?.status === "ready") {
    return `Converted source "${updated.title}" successfully.`;
  }
  return `Conversion finished for "${source.title}" with status: ${updated?.status || "unknown"}.`;
}

async function executeAddAndConvertZoteroItem(args: Record<string, unknown>, session: ChatSession): Promise<string> {
  const key = String(args.item_key || "").trim();
  if (!key) return "Error: item_key is required.";
  const item = getItemByKey(key);
  if (!item) return `Error: Zotero item "${key}" was not found.`;
  const summary = summarizeZoteroItem(item);
  if (!getPdfAttachment(item)) {
    return `Error: "${summary.title}" has no PDF attachment available.`;
  }

  const added = await addZoteroItemToSession(item, session);
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
  await convertSource(source, refreshOpenSourceChips);
  refreshOpenSourceChips();
  const updated = session.getSource(added.sourceKey);
  return `${added.message}\nConversion status: ${updated?.status || "unknown"}.`;
}

async function executeWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  const maxResults = Math.min(10, (args.max_results as number | undefined) ?? 5);

  const braveKey = (getPref("braveSearchApiKey") as string | undefined) || "";

  if (braveKey) {
    Zotero.debug(`[ChatPDF] web_search: using Brave Search, query="${query}"`);
    return await braveSearch(query, maxResults, braveKey);
  } else {
    Zotero.debug(`[ChatPDF] web_search: using DuckDuckGo fallback, query="${query}"`);
    return await duckDuckGoSearch(query, maxResults);
  }
}

async function braveSearch(query: string, maxResults: number, apiKey: string): Promise<string> {
  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`Brave Search API error (${res.status})`);
  }

  const data = await res.json();
  const results = (data.web?.results ?? []) as { title: string; description: string; url: string }[];
  Zotero.debug(`[ChatPDF] braveSearch: ${results.length} results for "${query}"`);

  if (results.length === 0) return `Web search results for: "${query}"\n\nNo results found.`;

  const lines = [`Web search results for: "${query}"\n`];
  for (let i = 0; i < Math.min(results.length, maxResults); i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.description}`);
    lines.push(`   URL: ${r.url}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function duckDuckGoSearch(query: string, maxResults: number): Promise<string> {
  const params = new URLSearchParams({ q: query });
  const url = `https://html.duckduckgo.com/html/?${params}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ChatPDF/1.0; Zotero)" },
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo search error (${res.status})`);
  }

  const html = await res.text();
  Zotero.debug(`[ChatPDF] duckDuckGoSearch: got ${html.length} chars HTML for "${query}"`);

  const results: { title: string; snippet: string; url: string }[] = [];
  const resultPattern = /<div class="result[^"]*"[^>]*>[\s\S]*?<a class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let m;
  while ((m = resultPattern.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = m[1].trim();
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    const snippet = m[3].replace(/<[^>]+>/g, "").trim();
    results.push({ url: rawUrl, title, snippet });
  }

  // Fallback: simpler extraction
  if (results.length === 0) {
    const titlePattern = /<a class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/g;
    while ((m = titlePattern.exec(html)) !== null && results.length < maxResults) {
      results.push({ url: m[1].trim(), title: m[2].trim(), snippet: "" });
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

async function executeWebFetch(args: Record<string, unknown>): Promise<string> {
  const url = args.url as string;

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    Zotero.debug(`[ChatPDF] web_fetch: blocked non-http URL: ${url}`);
    return `Error: only http:// and https:// URLs are allowed.`;
  }

  Zotero.debug(`[ChatPDF] web_fetch: fetching ${url}`);

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ChatPDF/1.0; Zotero)" },
  });

  Zotero.debug(`[ChatPDF] web_fetch: status=${res.status}, url=${url}`);

  if (!res.ok) {
    return `Error fetching ${url}: HTTP ${res.status}`;
  }

  const html = await res.text();
  Zotero.debug(`[ChatPDF] web_fetch: raw content ${html.length} chars from ${url}`);

  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const maxLen = 50 * 1024;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + "\n\n[... content truncated at 50KB ...]";
  }

  Zotero.debug(`[ChatPDF] web_fetch: cleaned content ${text.length} chars from ${url}`);
  return `Content from ${url}:\n\n${text}`;
}
