import type { SessionMeta } from "./chat-history";

export interface HistoryFilter {
  query: string;
  includeEmpty: boolean;
  pinnedOnly: boolean;
  parentKey?: string | null;
}

/** Search only compact history metadata, including associated paper titles. */
export function filterHistory(sessions: SessionMeta[], filter: HistoryFilter): SessionMeta[] {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
  const terms = normalize(filter.query).trim().split(/\s+/).filter(Boolean);
  return sessions.filter(meta => {
    if (filter.parentKey && !meta.referencedParentKeys?.includes(filter.parentKey)) return false;
    // Unknown older counts stay visible until metadata can be recovered.
    if (!filter.includeEmpty && meta.messageCount === 0) return false;
    if (filter.pinnedOnly && !meta.pinned) return false;
    const text = normalize([meta.title, ...meta.sourceTitles].join(" "));
    return terms.every(term => text.includes(term));
  }).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
