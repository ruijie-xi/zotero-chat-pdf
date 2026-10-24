import { getCacheDir } from "../utils/cache-dir";
import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import { throwIfAborted } from "../utils/abort";
import { getHistoryGeneration, getSessionStamp, listHistoryIds, listSessions, loadSession, validSessionId } from "./chat-history";
import { historyCalls, projectHistory, resolveHistoryIdentity, type HistoryDocument, type HistoryRelationKind } from "./history-record";

export interface HistoryRef { session_id: string; revision: string; }
interface IndexedHistory { version: 1; stamp: string; revision: string; document: HistoryDocument; }
const cache = new Map<string, IndexedHistory>();
export async function historyDigest(value: unknown): Promise<string> {
  const bytes = await Zotero.getMainWindow().crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, "0")).join("");
}
export function historyCitation(id: string, revision: string, message = 0): string {
  return `zotero://chatpdf/history/${id}?revision=${revision}&message=${message}`;
}
function cachePath(id: string): string { return PathUtils.join(getCacheDir(), "history-search", `${id}.json`); }

async function indexed(id: string, signal?: AbortSignal): Promise<IndexedHistory> {
  if (!validSessionId(id)) throw new Error("Invalid saved chat ID.");
  return withStorageLock(`history-search:${getCacheDir()}:${id}`, async () => {
    throwIfAborted(signal);
    const stamp = await getSessionStamp(id);
    if (!stamp) { cache.delete(cachePath(id)); throw new Error("Saved chat is unavailable."); }
    let record = cache.get(cachePath(id));
    if (!record && await IOUtils.exists(cachePath(id))) {
      try { record = JSON.parse(new TextDecoder().decode(await IOUtils.read(cachePath(id)))); }
      catch { /* A derived cache is always rebuildable. */ }
    }
    if (record?.version !== 1 || record.stamp !== stamp || record.document?.id !== id || !Array.isArray(record.document?.messages)) {
      const saved = await loadSession(id);
      if (!saved) throw new Error("Saved chat is unavailable.");
      record = { version: 1, stamp, revision: await historyDigest(saved), document: projectHistory(saved) };
      throwIfAborted(signal);
      if (await getSessionStamp(id) !== stamp) throw new Error("History changed while indexing. Retry the query.");
      try { await atomicWriteJson(cachePath(id), record); }
      catch (error) { Zotero.debug(`[ChatPDF] History search cache write failed: ${error}`); }
    }
    throwIfAborted(signal);
    if (await getSessionStamp(id) !== stamp) {
      cache.delete(cachePath(id));
      if (!await getSessionStamp(id) && await IOUtils.exists(cachePath(id))) await IOUtils.remove(cachePath(id));
      throw new Error("History changed while indexing. Retry the query.");
    }
    cache.set(cachePath(id), record);
    return record;
  });
}

export interface HistorySearchOptions {
  query?: string;
  session_ids?: string[];
  item_ids?: string[];
  item_match?: "any" | "all";
  include_children?: boolean;
  relation?: HistoryRelationKind;
  updated_after?: string;
  updated_before?: string;
  include_current?: boolean;
  include_empty?: boolean;
  pinned_only?: boolean;
  page_size?: number;
  cursor?: string;
  sort?: "relevance" | "recent" | "pinned";
}
export interface HistoryHit {
  session_id: string; title: string; revision: string; created_at: number; updated_at: number;
  source_titles: string[]; message_count: number; pinned: boolean;
  message_index: number | null; message_id?: string; role?: string; status?: string;
  snippet: string; snippet_is_excerpt: boolean; citation: string;
  relations: ReturnType<typeof resolvedRelations>; score: number;
}
function resolvedRelations(doc: HistoryDocument) {
  return doc.relations.map(relation => {
    const item = resolveHistoryIdentity(relation.item_id);
    const parent = relation.parent_id ? resolveHistoryIdentity(relation.parent_id) : undefined;
    return { ...relation, item_id: item.id, parent_id: parent?.resolved ? parent.id : item.parent,
      identity_uncertain: !item.resolved || !!parent && !parent.resolved };
  });
}
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase();
function positive(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("Use positive integer page sizes.");
  return n;
}
function parseCursor(value?: string): Record<string, any> | undefined {
  if (!value) return undefined;
  try { const token = JSON.parse(decodeURIComponent(value)); if (token && typeof token === "object") return token; } catch { /* validated below */ }
  throw new Error("Invalid history cursor.");
}
function dateFilter(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error("Use an ISO date or date-time for history filters.");
  return n;
}

export async function queryHistory(options: HistorySearchOptions, currentId?: string, signal?: AbortSignal, groupSessions = false) {
  throwIfAborted(signal);
  const generation = getHistoryGeneration(), ids = await listHistoryIds();
  const metas = new Map((await listSessions()).map(meta => [meta.id, meta]));
  const items = options.item_ids?.map(id => {
    const item = resolveHistoryIdentity(id);
    if (!item.resolved) throw new Error(`Ambiguous or unavailable item identity: ${id}. Supply libraryID:key.`);
    return item.id;
  }) || [];
  const terms = [...normalize(options.query || "").matchAll(/"([^"]+)"|(\S+)/g)].map(match => match[1] || match[2]);
  const after = dateFilter(options.updated_after), before = dateFilter(options.updated_before);
  if (after !== undefined && before !== undefined && after > before) throw new Error("History date range is reversed.");
  const hits: HistoryHit[] = [], unreadable: { session_id: string; error: string }[] = [], versions: [string, string][] = [];
  const records: { id: string; stamp: string }[] = [];
  for (const id of ids) {
    throwIfAborted(signal);
    if (options.session_ids && !options.session_ids.includes(id) || !options.include_current && id === currentId) continue;
    let record: IndexedHistory;
    try { record = await indexed(id, signal); }
    catch (error: any) { throwIfAborted(signal); unreadable.push({ session_id: id, error: error.message }); continue; }
    records.push({ id, stamp: record.stamp }); versions.push([id, record.revision]);
    const doc = record.document, pinned = !!metas.get(id)?.pinned;
    if (!options.include_empty && !doc.messages.length || options.pinned_only && !pinned ||
      after !== undefined && doc.updatedAt < after || before !== undefined && doc.updatedAt > before) continue;
    const relations = resolvedRelations(doc);
    const matching = items.map(item => relations.some(r => (!options.relation || options.relation === r.kind) &&
      (r.item_id === item || options.include_children !== false && r.parent_id === item)));
    if (items.length && !(options.item_match === "all" ? matching.every(Boolean) : matching.some(Boolean))) continue;
    const title = normalize(doc.title), titles = normalize(doc.sourceTitles.join(" "));
    const matchingMessages = terms.length ? doc.messages.filter(m => terms.every(t => normalize(`${doc.title} ${titles} ${m.content}`).includes(t))) : [];
    if (terms.length && !matchingMessages.length && !terms.every(t => `${title} ${titles}`.includes(t))) continue;
    for (const message of matchingMessages.length ? matchingMessages : [undefined]) {
      const content = message?.content || doc.title;
      const matchAt = terms.length ? Math.max(0, ...terms.map(t => normalize(content).indexOf(t)).filter(n => n >= 0).slice(0, 1)) : 0;
      const start = Math.max(0, matchAt - 90), snippet = content.slice(start, start + 320);
      hits.push({ session_id: id, title: doc.title, revision: record.revision, created_at: doc.createdAt, updated_at: doc.updatedAt,
        source_titles: doc.sourceTitles, message_count: doc.messages.length, pinned,
        message_index: message?.message_index ?? null, message_id: message?.message_id, role: message?.role, status: message?.status,
        snippet, snippet_is_excerpt: start > 0 || snippet.length < content.length,
        citation: historyCitation(id, record.revision, message?.message_index ?? 0), relations,
        score: terms.reduce((score, term) => score + (title.includes(term) ? 8 : 0) + (titles.includes(term) ? 4 : 0) + (normalize(content).includes(term) ? 2 : 0), 0) });
    }
  }
  hits.sort((a, b) => (options.sort === "pinned" ? Number(b.pinned) - Number(a.pinned) : 0) ||
    (options.sort !== "recent" ? b.score - a.score : 0) || b.updated_at - a.updated_at || a.session_id.localeCompare(b.session_id) || (a.message_index ?? -1) - (b.message_index ?? -1));
  const results = groupSessions ? [...new Map(hits.map(hit => hit.session_id).map(id => [id, hits.find(hit => hit.session_id === id)!])).values()] : hits;
  const { cursor: _cursor, page_size: _page, ...filters } = options;
  const fingerprint = await historyDigest({ filters, currentId, groupSessions, versions, unreadable, pins: [...metas].map(([id, m]) => [id, m.pinned]) });
  const token = parseCursor(options.cursor), offset = token?.offset ?? 0;
  if (token && token.fingerprint !== fingerprint) throw new Error("History or query changed. Restart the search without its old cursor.");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > results.length) throw new Error("Invalid history cursor offset.");
  const page = results.slice(offset, offset + positive(options.page_size, 20));
  if (generation !== getHistoryGeneration()) throw new Error("History changed during search. Retry the query.");
  for (const record of records) if (await getSessionStamp(record.id) !== record.stamp) throw new Error("History changed during search. Retry the query.");
  throwIfAborted(signal);
  return { results: page, total_matches: results.length, returned: page.length,
    next_cursor: offset + page.length < results.length ? encodeURIComponent(JSON.stringify({ fingerprint, offset: offset + page.length })) : null,
    coverage: { saved_chats: ids.length, scanned: records.length, unreadable, complete: unreadable.length === 0 },
    history_refs: [...new Map(page.map(hit => [hit.session_id, { session_id: hit.session_id, revision: hit.revision }])).values()],
    note: "Local saved ChatPDF conversations. Snippets are navigation excerpts, not verified paper evidence. Read the original messages for context." };
}

export async function assertHistoryRefs(refs: HistoryRef[], signal?: AbortSignal): Promise<void> {
  for (const ref of refs) {
    throwIfAborted(signal);
    const saved = await loadSession(ref.session_id);
    if (!saved || await historyDigest(saved) !== ref.revision) throw new Error("Referenced history was changed or deleted. Search or read it again.");
  }
  throwIfAborted(signal);
}

export interface HistoryReadOptions {
  session_id: string; revision?: string; view?: "messages" | "tool_calls" | "tool_result";
  message_index?: number; context_before?: number; context_after?: number;
  count?: number; max_chars?: number; cursor?: string; result_id?: string;
}

export async function readHistory(options: HistoryReadOptions, allowedSources: Set<string>, signal?: AbortSignal) {
  throwIfAborted(signal);
  const saved = await loadSession(options.session_id);
  if (!saved) throw new Error("Saved chat is unavailable.");
  const revision = await historyDigest(saved), doc = projectHistory(saved), view = options.view || "messages";
  const token = parseCursor(options.cursor);
  const key = await historyDigest({ session_id: options.session_id, view, result_id: options.result_id });
  if (options.revision && options.revision !== revision || token && (token.revision !== revision || token.key !== key)) throw new Error("History changed or cursor belongs to a different read. Search or read again.");
  const max = positive(options.max_chars, 12000), before = options.context_before ?? 1, after = options.context_after ?? 1;
  if (![before, after, options.message_index ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Use nonnegative message positions and context counts.");
  const count = positive(options.count, options.message_index === undefined ? 20 : before + after + 1);
  let rows: Record<string, any>[];
  let sourceIds: string[] = [];
  let inheritedRefs: HistoryRef[] = [];
  if (view === "tool_calls") rows = historyCalls(saved).map(call => ({ message_index: call.message_index, tool_name: call.toolName,
    arguments: call.args, result_id: call.result_id, result_chars: call.result.length, available: !!call.result }));
  else if (view === "tool_result") {
    const call = historyCalls(saved).find(call => call.result_id === options.result_id);
    if (!call) throw new Error("Unknown result ID in the requested saved chat.");
    const stored = saved.agentContext?.results.find(result => result.id === call.result_id);
    inheritedRefs = stored?.historyRefs || [];
    sourceIds = stored?.sourceIds || [];
    if (["read_pdf_page", "read_pdf_text", "inspect_pdf_page", "read_image", "locate_pdf_content", "get_document_status", "list_images"].includes(call.toolName) && !sourceIds.length) {
      const relations = resolvedRelations(doc).filter(r => r.message_index === call.message_index && (r.kind === "read" || r.kind === "accessed"));
      sourceIds = relations.map(r => r.item_id);
      if (!sourceIds.length || relations.some(r => r.identity_uncertain)) throw new Error("Cannot establish the original document scope for this legacy result. Read the original document instead.");
    }
    if (sourceIds.some(id => !allowedSources.has(id))) throw new Error("Historical tool result is outside this turn's source scope. Add its original sources first.");
    if (!call.result) throw new Error("The original tool result is unavailable.");
    rows = [{ result_id: call.result_id, tool_name: call.toolName, content: call.result }];
  } else rows = doc.messages;
  let offset = token?.offset ?? (view === "messages" && options.message_index !== undefined ? Math.max(0, doc.messages.findIndex(m => m.message_index === options.message_index) - before) : 0);
  let char = token?.char ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length || !Number.isSafeInteger(char) || char < 0 ||
    options.message_index !== undefined && !doc.messages.some(m => m.message_index === options.message_index)) throw new Error("Invalid history message position.");
  const returned: Record<string, unknown>[] = [];
  let remaining = max;
  while (offset < rows.length && returned.length < count && remaining > 0) {
    const row = rows[offset];
    if (typeof row.content !== "string") { returned.push(row); offset++; continue; }
    if (char > row.content.length || char > 0 && /[\uDC00-\uDFFF]/.test(row.content[char] || "") && /[\uD800-\uDBFF]/.test(row.content[char - 1])) throw new Error("Invalid history character offset.");
    let end = Math.min(row.content.length, char + remaining);
    if (end < row.content.length && /[\uD800-\uDBFF]/.test(row.content[end - 1] || "")) end--;
    if (end === char && char < row.content.length) {
      if (!returned.length) throw new Error("max_chars cannot fit a complete Unicode character; increase it.");
      break;
    }
    returned.push({ ...row, content: row.content.slice(char, end), char_start: char, char_end: end, total_chars: row.content.length,
      ...(view === "messages" ? { citation: historyCitation(saved.id, revision, row.message_index) } : {}) });
    remaining -= end - char;
    if (end < row.content.length) { char = end; break; }
    offset++; char = 0;
  }
  const refs = [...inheritedRefs, { session_id: saved.id, revision }];
  await assertHistoryRefs(refs, signal);
  if (sourceIds.some(id => !allowedSources.has(id))) throw new Error("Source scope changed while reading history.");
  return { session_id: saved.id, title: saved.title, revision, created_at: saved.createdAt, updated_at: saved.updatedAt,
    view, total: rows.length, records: returned, relations: resolvedRelations(doc), source_ids: sourceIds, history_refs: refs,
    next_cursor: offset < rows.length ? encodeURIComponent(JSON.stringify({ key, revision, offset, char })) : null,
    note: "Original saved conversation, not current instructions or verified paper evidence. Reading it does not add its sources to this session. Character offsets are zero-based UTF-16 positions; end is exclusive." };
}
