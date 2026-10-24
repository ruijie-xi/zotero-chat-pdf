import { queryHistory, readHistory, type HistoryReadOptions, type HistorySearchOptions } from "./history-query";
import type { ToolExecutionContext } from "./tools";

export async function executeHistoryTool(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<string | null> {
  if (!["search_chat_history", "list_item_chats", "read_chat_session"].includes(name)) return null;
  const allowed = new Set(context.session.getSources().filter(source => context.turnScope.has(source.id)).map(source => source.id));
  const result = name === "read_chat_session"
    ? await readHistory(args as unknown as HistoryReadOptions, allowed, context.signal)
    : await queryHistory(args as HistorySearchOptions, context.session.id, context.signal, name === "list_item_chats");
  if ("source_ids" in result && result.source_ids.some(id => !context.turnScope.has(id) || !context.session.getSource(id))) {
    throw new Error("Source scope changed while reading historical evidence.");
  }
  context.recordHistoryAccess?.(result.history_refs, "source_ids" in result ? result.source_ids : []);
  return JSON.stringify(result);
}
