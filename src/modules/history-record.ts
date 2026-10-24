import type { SavedSession } from "./chat-history";
import type { IterationRecord } from "./llm-client";
import { makeSourceId, parseSourceId } from "./source-identity";

export type HistoryRelationKind = "current_source" | "turn_source" | "read" | "accessed";
export interface HistoryRelation {
  item_id: string;
  parent_id?: string;
  kind: HistoryRelationKind;
  message_index?: number;
}
export interface HistoryMessage {
  message_index: number;
  message_id?: string;
  role: string;
  content: string;
  timestamp?: number;
  status?: string;
  error_message?: string;
  sources: NonNullable<SavedSession["messages"][number]["sources"]>;
}
export interface HistoryDocument {
  id: string;
  title: string;
  sourceTitles: string[];
  createdAt: number;
  updatedAt: number;
  messages: HistoryMessage[];
  relations: HistoryRelation[];
}

export function historyCalls(saved: SavedSession) {
  return saved.messages.flatMap((message, index) => {
    const iterations: IterationRecord[] = message.iterations || (message.toolHistory ? [{ toolCalls: message.toolHistory }] : []);
    return iterations.flatMap((iteration, i) => (iteration.toolCalls || []).map((call, j) => ({
      ...call, message_index: index, result_id: call.resultId || `legacy-${index}-${i}-${j}`,
      result: call.resultId ? saved.agentContext?.results.find(result => result.id === call.resultId)?.content || call.result || "" : call.result || "",
    })));
  });
}

const readTools = new Set(["read_pdf_page", "read_pdf_text", "inspect_pdf_page", "read_image", "read_zotero_notes"]);
const accessTools = new Set(["get_zotero_item", "locate_pdf_content", "get_document_status", "list_images"]);

/** Project only visible conversation text. Never index reasoning or copied tool bodies. */
export function projectHistory(saved: SavedSession): HistoryDocument {
  const relations: HistoryRelation[] = [];
  const source = (s: { id?: string; key: string; libraryID?: number; parentKey?: string }, kind: HistoryRelationKind, message_index?: number) => {
    const parsed = parseSourceId(s.id || s.key, s.libraryID);
    relations.push({ item_id: makeSourceId(parsed.key, parsed.libraryID),
      parent_id: s.parentKey ? makeSourceId(s.parentKey, parsed.libraryID) : undefined, kind, message_index });
  };
  const sources = saved.sources ?? saved.sourceKeys.map((key, i) => ({ key, parentKey: saved.sourceParentKeys?.[i] }));
  sources.forEach(s => source(s, "current_source"));
  const narration = new Map<string, string>();
  let text = "";
  let narratedCalls: string[] = [];
  for (const event of saved.agentContext?.events || []) {
    if (event.role === "assistant") { text = typeof event.content === "string" ? event.content : ""; narratedCalls = event.tool_calls?.map(call => call.id) || []; }
    else if (event.role === "tool" && event.resultId && event.tool_call_id && narratedCalls.includes(event.tool_call_id) && text) narration.set(event.resultId, text);
  }
  const messages = saved.messages.flatMap((message, index): HistoryMessage[] => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    message.sources?.forEach(s => source(s, "turn_source", index));
    const segments: string[] = (message.iterations || []).map((iteration: IterationRecord) =>
      iteration.content ?? narration.get(iteration.toolCalls?.[0]?.resultId || "") ?? "").filter(Boolean);
    if (message.content && segments[segments.length - 1] !== message.content) segments.push(message.content);
    return [{ message_index: index, message_id: message.id, role: message.role, content: segments.join("\n\n"),
      timestamp: message.timestamp, status: message.status, error_message: message.errorMessage, sources: message.sources || [] }];
  });
  for (const call of historyCalls(saved)) {
    if (!call.result || /^Error(?: executing |:)/.test(call.result)) continue;
    if (!readTools.has(call.toolName) && !accessTools.has(call.toolName)) continue;
    // An all-failed page batch is not evidence of a successful read.
    if (call.toolName === "read_pdf_page") {
      try { const result = JSON.parse(call.result.split("\n\n[Tool result metadata:")[0]);
        if (Array.isArray(result.pages) && !result.pages.some((page: any) => !page.error && page.status !== "error")) continue;
      } catch { /* Legacy text receipts still document the call. */ }
    }
    const args = call.args || {};
    const key = String(args.key || args.item_key || args.source_key || "");
    if (!key) continue;
    const requested = parseSourceId(key, typeof args.library_id === "number" ? args.library_id : undefined);
    const known = [...sources, ...saved.messages.flatMap(m => m.sources || [])].filter(s => {
      const identity = parseSourceId("id" in s && typeof s.id === "string" ? s.id : s.key, "libraryID" in s ? s.libraryID : undefined);
      return identity.key === requested.key && (requested.libraryID === undefined || requested.libraryID === identity.libraryID);
    });
    const distinct = new Map(known.map(s => [makeSourceId(s.key, "libraryID" in s ? s.libraryID : undefined), s]));
    const match = distinct.size === 1 ? [...distinct.values()][0] : undefined;
    source(match || { key, libraryID: typeof args.library_id === "number" ? args.library_id : undefined },
      readTools.has(call.toolName) ? "read" : "accessed", call.message_index);
  }
  return { id: saved.id, title: saved.title, createdAt: saved.createdAt, updatedAt: saved.updatedAt,
    sourceTitles: [...new Set([...(saved.sourceTitles || []), ...saved.messages.flatMap(m => m.sources?.map(s => s.title) || [])])],
    messages, relations };
}

/** Resolve legacy keys only when unique. Keep ambiguous/deleted identities explicit. */
export function resolveHistoryIdentity(id: string): { id: string; resolved: boolean; parent?: string } {
  const parsed = parseSourceId(id);
  const libraries = parsed.libraryID === undefined ? Zotero.Libraries.getAll() : [{ libraryID: parsed.libraryID }];
  const matches = libraries.map(lib => {
    try { return Zotero.Items.getByLibraryAndKey(lib.libraryID, parsed.key); } catch { return false; }
  }).filter((item): item is Zotero.Item => !!item);
  if (parsed.libraryID === undefined && matches.length !== 1) return { id, resolved: false };
  const item = matches[0];
  return { id: makeSourceId(parsed.key, parsed.libraryID ?? item!.libraryID), resolved: true,
    parent: item?.parentItem ? makeSourceId(item.parentItem.key, item.libraryID) : undefined };
}
